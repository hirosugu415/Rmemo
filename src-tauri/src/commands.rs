//! The IPC surface — thin wrappers over `notes::*` and `config`.

use crate::config::{self, Settings, Status};
use crate::notes::{search::Filter, store, Note, NoteSummary};
use crate::state::AppState;
use crate::watcher;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn list_notes(state: State<'_, AppState>, filter: Filter) -> Vec<NoteSummary> {
    let mut items = crate::notes::search::apply(&state.notes.read(), &filter);
    let settings = state.config.read().clone();
    crate::notes::scan::refresh_expiry(&mut items, settings.expiry_days);
    // Pinned notes first, in pin order; the rest keep newest-first.
    let pins = crate::notes::pins::load(&settings);
    let rank = |n: &NoteSummary| pins.iter().position(|p| p.eq_ignore_ascii_case(&n.filename));
    for n in &mut items {
        n.pinned = rank(n).is_some();
    }
    items.sort_by_key(|n| rank(n).unwrap_or(usize::MAX));
    items
}

#[tauri::command]
pub fn set_pinned(state: State<'_, AppState>, filename: String, pinned: bool) -> Result<(), String> {
    let settings = state.config.read().clone();
    crate::notes::pins::set(&settings, &filename, pinned).map_err(|e| e.to_string())
}

/// After a note's title changed from `from` to `to`, rewrites `[[from]]`
/// links in every other note. Skipped while another note still has the
/// title `from` — those links may be meant for that one. Returns how many
/// notes were changed.
#[tauri::command]
pub fn rename_links(app: AppHandle, from: String, to: String, filename: String) -> Result<usize, String> {
    let (from, to) = (from.trim().to_string(), to.trim().to_string());
    if from.is_empty() || to.is_empty() || from == to {
        return Ok(0);
    }
    let state = app.state::<AppState>();
    let settings = state.config.read().clone();
    let needle = format!("[[{}]]", from.to_lowercase());
    let targets: Vec<(String, Status)> = {
        let notes = state.notes.read();
        let lower = from.to_lowercase();
        if notes.iter().any(|n| n.filename != filename && n.title.to_lowercase() == lower) {
            return Ok(0);
        }
        notes
            .iter()
            .filter(|n| n.filename != filename && n.body.to_lowercase().contains(&needle))
            .map(|n| (n.filename.clone(), n.status))
            .collect()
    };
    let outcome = store::rename_links(&settings, &targets, &from, &to);
    for (previous, note) in &outcome.updated {
        upsert(&state, previous, note);
    }
    let changed = outcome.updated.len();
    if outcome.failed.is_empty() {
        Ok(changed)
    } else {
        Err(format!("リンク {changed}件を更新、{}件失敗: {}", outcome.failed.len(), outcome.failed.join(", ")))
    }
}

/// Saves a pasted/dropped image into `assets/` and returns its file name.
/// The bytes arrive as the raw request body (no JSON number array for a
/// few hundred KB of image); the extension in the `x-ext` header.
#[tauri::command]
pub fn save_image(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("png")
        .to_string();
    let settings = state.config.read().clone();
    crate::notes::images::save(&settings, bytes, &ext).map_err(|e| e.to_string())
}

/// Recycles images no note mentions any more (see `notes::images`). `extra`
/// is the compose box's current text, which may not be saved yet.
#[tauri::command]
pub fn cleanup_images(state: State<'_, AppState>, extra: String) -> usize {
    let settings = state.config.read().clone();
    let notes = state.notes.read().clone();
    crate::notes::images::cleanup(&settings, &notes, &extra, crate::notes::images::CLEANUP_GRACE)
}

/// Notes that link to `title` with `[[title]]`, other than `exclude` (the
/// note itself). A scan of the in-memory cache — no disk access.
#[tauri::command]
pub fn backlinks(
    state: State<'_, AppState>,
    title: String,
    exclude: Option<String>,
) -> Vec<crate::notes::NoteSummary> {
    crate::notes::backlinks(&state.notes.read(), &title, exclude.as_deref())
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Vec<crate::notes::tags::TagCount> {
    crate::notes::tags::counts(&state.notes.read())
}

/// Rewrites `#from` to `#to` in every note that has it — a rename, or a
/// merge when `to` is already in use. Reads each file fresh from disk (not
/// the cache) so it can't resurrect stale content. Returns how many notes
/// changed.
#[tauri::command]
pub fn rename_tag(app: AppHandle, from: String, to: String) -> Result<usize, String> {
    use crate::notes::tags;
    let to = to.trim().trim_start_matches('#').to_string();
    if !tags::is_valid_name(&to) {
        return Err(format!("\"{to}\" はタグ名に使えません（文字・数字・_・- のみ）"));
    }
    if from == to {
        return Ok(0);
    }

    let state = app.state::<AppState>();
    let settings = state.config.read().clone();
    let targets: Vec<(String, Status)> = state
        .notes
        .read()
        .iter()
        .filter(|n| n.tags.contains(&from))
        .map(|n| (n.filename.clone(), n.status))
        .collect();

    let outcome = store::rename_tag(&settings, &targets, &from, &to);
    for (previous, note) in &outcome.updated {
        upsert(&state, previous, note);
    }
    let changed = outcome.updated.len();
    if outcome.failed.is_empty() {
        Ok(changed)
    } else {
        Err(format!(
            "{changed}件を変更、{}件失敗: {}",
            outcome.failed.len(),
            outcome.failed.join(", ")
        ))
    }
}

/// Error text for a note that exists neither in the cache nor on disk. The
/// frontend matches on it to recreate an open note deleted out from under it.
pub const NOTE_GONE: &str = "that note is gone";

/// Which folder `filename` lives in: the cache first, then disk — the cache
/// can briefly lag a file the watcher hasn't rescanned yet (or one a racing
/// rescan dropped), and that alone shouldn't fail a save.
fn locate(state: &AppState, filename: &str) -> Result<Status, String> {
    if let Some(n) = state.notes.read().iter().find(|n| n.filename == filename) {
        return Ok(n.status);
    }
    let settings = state.config.read();
    [Status::Keep, Status::Scratch]
        .into_iter()
        .find(|s| crate::notes::scan::status_dir(&settings, *s).join(filename).is_file())
        .ok_or_else(|| NOTE_GONE.into())
}

/// Puts `note` into the cache in place of whatever was cached under
/// `previous` (its name before a save/move renamed it) or under its own
/// name, then re-sorts — a save changes `modified_at`, i.e. its position.
fn upsert(state: &AppState, previous: &str, note: &Note) {
    // A save can rename the file (title change, Keep/Scratch move) — a pin
    // follows the note to its new name.
    if previous != note.filename {
        crate::notes::pins::rename(&state.config.read(), previous, &note.filename);
    }
    let mut notes = state.notes.write();
    notes.retain(|n| n.filename != previous && n.filename != note.filename);
    notes.push(note.clone());
    crate::notes::sort_newest(&mut notes);
}

#[tauri::command]
pub fn get_note(state: State<'_, AppState>, filename: String) -> Result<Note, String> {
    // Read from disk, not the cache: the frontend compares this against what
    // it last saved to detect outside edits, and a watcher rescan racing one
    // of our own writes can leave the cache a version behind for a moment.
    let status = locate(&state, &filename)?;
    let settings = state.config.read().clone();
    let path = crate::notes::scan::status_dir(&settings, status).join(&filename);
    let note = crate::notes::scan::scan_one(&path, status, settings.expiry_days)
        .map_err(|_| NOTE_GONE.to_string())?;
    upsert(&state, &filename, &note);
    Ok(note)
}

#[tauri::command]
pub fn create_note(app: AppHandle, body: String, status: Status) -> Result<Note, String> {
    let state = app.state::<AppState>();
    let mut settings = state.config.read().clone();

    let note = store::create(&settings, &body, status).map_err(|e| e.to_string())?;

    {
        let mut notes = state.notes.write();
        notes.push(note.clone());
        crate::notes::sort_newest(&mut notes);
    }

    if settings.last_status != status {
        settings.last_status = status;
        config::save(&settings).map_err(|e| e.to_string())?;
        *state.config.write() = settings;
    }

    Ok(note)
}

#[tauri::command]
pub fn update_note(app: AppHandle, filename: String, body: String) -> Result<Note, String> {
    let state = app.state::<AppState>();
    let status = locate(&state, &filename)?;
    let settings = state.config.read().clone();
    let note = store::update(&settings, &filename, &body, status).map_err(|e| e.to_string())?;
    upsert(&state, &filename, &note);
    Ok(note)
}

/// `update_note` without bumping the modified time — the 整形 review's save,
/// so an imported note keeps its place in time.
#[tauri::command]
pub fn rewrite_note(app: AppHandle, filename: String, body: String) -> Result<Note, String> {
    let state = app.state::<AppState>();
    let status = locate(&state, &filename)?;
    let settings = state.config.read().clone();
    let note = store::update_keeping_dates(&settings, &filename, &body, status).map_err(|e| e.to_string())?;
    upsert(&state, &filename, &note);
    Ok(note)
}

#[tauri::command]
pub fn set_status(app: AppHandle, filename: String, status: Status) -> Result<Note, String> {
    let state = app.state::<AppState>();
    let from = locate(&state, &filename)?;
    let settings = state.config.read().clone();
    if from == status {
        let path = crate::notes::scan::status_dir(&settings, status).join(&filename);
        return crate::notes::scan::scan_one(&path, status, settings.expiry_days)
            .map_err(|e| e.to_string());
    }

    let note = store::set_status(&settings, &filename, from, status).map_err(|e| e.to_string())?;
    upsert(&state, &filename, &note);
    Ok(note)
}

#[tauri::command]
pub fn delete_note(app: AppHandle, filename: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let status = locate(&state, &filename)?;
    let settings = state.config.read().clone();
    store::delete(&settings, &filename, status).map_err(|e| e.to_string())?;
    state.notes.write().retain(|n| n.filename != filename);
    crate::notes::pins::remove(&settings, &filename);
    Ok(())
}

/// Opens Explorer at the notes root — the parent of both `keep/` and
/// `scratch/` — since the value here is browsing both at once.
#[tauri::command]
pub fn open_notes_folder(app: AppHandle) -> Result<(), String> {
    let notes_dir = app.state::<AppState>().config.read().notes_dir.clone();
    std::fs::create_dir_all(&notes_dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(notes_dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Asks for what to import — a folder (`files: false`, every `.txt` under
/// it) or `.txt` files themselves — and lists it, so the UI can confirm
/// before writing anything. `None` if cancelled. Async so the blocking
/// dialog runs off the main thread.
#[tauri::command]
pub async fn pick_import(app: AppHandle, files: bool) -> Result<Option<crate::notes::import::ImportPreview>, String> {
    use tauri_plugin_dialog::DialogExt;
    let state = app.state::<AppState>();
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    state.dialog_open.store(true, Ordering::SeqCst);
    let picked = if files {
        dialog
            .set_title("取り込むテキストファイルを選択")
            .add_filter("テキストファイル", &["txt"])
            .blocking_pick_files()
            .map(|paths| (None, paths))
    } else {
        dialog.set_title("取り込むフォルダを選択").blocking_pick_folder().map(|dir| (Some(dir), Vec::new()))
    };
    state.dialog_open.store(false, Ordering::SeqCst);
    let Some((dir, paths)) = picked else {
        return Ok(None);
    };
    let dir = dir.map(|d| d.into_path()).transpose().map_err(|e| e.to_string())?;
    let paths = paths.into_iter().map(|p| p.into_path()).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    let notes_dir = state.config.read().notes_dir.clone();
    Ok(Some(crate::notes::import::preview(dir.as_deref(), paths, &notes_dir)))
}

/// Imports `files` (from `pick_import`) as Keep notes (see `notes::import`).
#[tauri::command]
pub async fn import_txt(
    app: AppHandle,
    dir: Option<String>,
    files: Vec<String>,
    options: crate::notes::import::ImportOptions,
) -> Result<crate::notes::import::ImportReport, String> {
    let state = app.state::<AppState>();
    let settings = state.config.read().clone();
    let bodies: Vec<String> = state.notes.read().iter().map(|n| n.body.clone()).collect();
    let files: Vec<std::path::PathBuf> = files.into_iter().map(Into::into).collect();
    let report = crate::notes::import::import(
        &settings,
        dir.as_deref().map(std::path::Path::new),
        &files,
        options,
        bodies.iter().map(String::as_str),
    );
    // Rescan rather than patch: the copied dates change each note's place.
    *state.notes.write() = crate::notes::scan::scan_all(&settings);
    let _ = tauri::Emitter::emit(&app, watcher::NOTES_CHANGED, ());
    Ok(report)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.config.read().clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, mut next: Settings) -> Result<Settings, String> {
    let state = app.state::<AppState>();
    let previous = state.config.read().clone();
    // Not edited in the settings panel, and the panel's copy is whatever it
    // was when the app started — keep the live value instead of rolling back
    // every Keep/Scratch choice made since.
    next.last_status = previous.last_status;
    next.zoom = previous.zoom; // same story: changed by Ctrl +/-, not the panel

    if previous.hotkey != next.hotkey {
        // Validate before storing, so a typo cannot leave the app with no
        // way to be summoned. `register_hotkey` drops the old binding before
        // trying the new one, so a key another app already holds would
        // otherwise leave nothing registered at all — put the old one back.
        if let Err(e) = crate::register_hotkey(&app, &next.hotkey) {
            let _ = crate::register_hotkey(&app, &previous.hotkey);
            return Err(e);
        }
    }

    if previous.autostart != next.autostart {
        crate::sync_autostart(&app, next.autostart)?;
    }

    config::save(&next).map_err(|e| e.to_string())?;
    *state.config.write() = next.clone();

    if previous.notes_dir != next.notes_dir {
        // Deliberately does not migrate old notes from the previous
        // location — out of scope for v1, the UI surfaces this as a warning.
        std::fs::create_dir_all(next.notes_dir.join(Status::Keep.dirname()))
            .map_err(|e| e.to_string())?;
        std::fs::create_dir_all(next.notes_dir.join(Status::Scratch.dirname()))
            .map_err(|e| e.to_string())?;
        *state.notes.write() = crate::notes::scan::scan_all(&next);
        crate::allow_assets(&app, &next);
        state.watch_generation.fetch_add(1, Ordering::SeqCst);
        watcher::spawn(app.clone());
    } else if previous.expiry_days != next.expiry_days {
        *state.notes.write() = crate::notes::scan::scan_all(&next);
    }

    Ok(next)
}

/// Sets and remembers the UI zoom; returns the value actually applied
/// (clamped and rounded to whole percents).
#[tauri::command]
pub fn set_zoom(app: AppHandle, zoom: f64) -> Result<f64, String> {
    let applied = crate::apply_zoom(&app, zoom);
    let state = app.state::<AppState>();
    let mut settings = state.config.read().clone();
    if settings.zoom != applied {
        settings.zoom = applied;
        config::save(&settings).map_err(|e| e.to_string())?;
        *state.config.write() = settings;
    }
    Ok(applied)
}

#[tauri::command]
pub fn hide_window(app: AppHandle) {
    crate::hide_window(&app);
}
