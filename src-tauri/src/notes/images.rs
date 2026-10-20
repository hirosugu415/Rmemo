//! Pasted / dropped images: one shared `assets/` folder next to `keep/` and
//! `scratch/`, referenced from notes as plain Markdown
//! (`![](../assets/20261019-140501-a3f9.webp)`) — notes in both folders sit
//! one level down, so the same relative path works after a Keep/Scratch move,
//! in other Markdown apps, and on other PCs through Drive.
//!
//! Images no note mentions any more are moved to the Recycle Bin by
//! `cleanup` — never while a note is being edited (App calls it when a
//! session ends), never one younger than `CLEANUP_GRACE` (it may belong to a
//! note another PC hasn't finished syncing), and always recoverably.

use super::Note;
use crate::config::Settings;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

pub const ASSETS_DIR: &str = "assets";
/// Extensions accepted from the frontend (it converts screenshots to WebP).
const ALLOWED: &[&str] = &["webp", "png", "jpg", "jpeg", "gif", "svg"];
/// Orphans younger than this are left alone.
pub const CLEANUP_GRACE: Duration = Duration::from_secs(5 * 60);

pub fn assets_dir(settings: &Settings) -> PathBuf {
    settings.notes_dir.join(ASSETS_DIR)
}

/// Writes `bytes` as a new, uniquely named image; returns its file name.
pub fn save(settings: &Settings, bytes: &[u8], ext: &str) -> std::io::Result<String> {
    let ext = ext.to_ascii_lowercase();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsupported image type"));
    }
    let dir = assets_dir(settings);
    std::fs::create_dir_all(&dir)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let mut salt = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    loop {
        let name = format!("{stamp}-{:04x}.{ext}", salt & 0xffff);
        let path = dir.join(&name);
        if !path.exists() {
            std::fs::write(&path, bytes)?;
            return Ok(name);
        }
        salt = salt.wrapping_mul(2_654_435_761).wrapping_add(1);
    }
}

/// File names under `assets/` that `body` mentions anywhere — in image
/// syntax or not. Deliberately generous: a false "still used" only delays a
/// cleanup, a false "unused" would throw an image away.
pub fn referenced(body: &str) -> Vec<String> {
    let needle = format!("{ASSETS_DIR}/");
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(i) = rest.find(&needle) {
        rest = &rest[i + needle.len()..];
        let end = rest
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | '\'' | '>' | '<' | ']' | '['))
            .unwrap_or(rest.len());
        if end > 0 {
            out.push(rest[..end].to_string());
        }
    }
    out
}

/// Moves every image in `assets/` that no note (nor `extra`, the unsaved
/// compose text) mentions, and that is older than `grace`, to the Recycle
/// Bin. Returns how many were moved.
pub fn cleanup(settings: &Settings, notes: &[Note], extra: &str, grace: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(assets_dir(settings)) else {
        return 0;
    };
    let mut used = std::collections::HashSet::new();
    for body in notes.iter().map(|n| n.body.as_str()).chain(std::iter::once(extra)) {
        for name in referenced(body) {
            used.insert(name.to_lowercase());
        }
    }
    let now = SystemTime::now();
    let mut moved = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if !path.is_file() || used.contains(&name.to_lowercase()) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let newest = [meta.modified().ok(), meta.created().ok()].into_iter().flatten().max();
        let young = newest.is_some_and(|t| now.duration_since(t).unwrap_or_default() < grace);
        if young {
            continue;
        }
        match super::store::move_to_recycle_bin(&path) {
            Ok(()) => moved += 1,
            Err(e) => eprintln!("[images] could not recycle {name:?}: {e}"),
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_every_mention_of_an_asset() {
        let body = "![](../assets/a.webp) and ![x](assets/b%20c.png)\n<img src=\"../assets/d.gif\">\nassets/";
        assert_eq!(referenced(body), vec!["a.webp", "b%20c.png", "d.gif"]);
    }

    #[test]
    fn cleanup_never_touches_young_images() {
        let dir = std::env::temp_dir().join("rmemo-images-young-test");
        let _ = std::fs::remove_dir_all(&dir);
        let s = Settings { notes_dir: dir, ..Settings::default() };
        let orphan = save(&s, b"z", "gif").unwrap();
        assert_eq!(cleanup(&s, &[], "", CLEANUP_GRACE), 0);
        assert!(assets_dir(&s).join(orphan).exists());
    }

    /// Touches the real Recycle Bin, so opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn cleanup_spares_used_young_and_unsaved_images() {
        let dir = std::env::temp_dir().join("rmemo-images-test");
        let _ = std::fs::remove_dir_all(&dir);
        let s = Settings { notes_dir: dir, ..Settings::default() };
        let used = save(&s, b"x", "webp").unwrap();
        let in_draft = save(&s, b"y", "png").unwrap();
        let young_orphan = save(&s, b"z", "gif").unwrap();
        let note = Note {
            filename: "n.md".into(),
            status: crate::config::Status::Keep,
            title: "n".into(),
            body: format!("![](../assets/{used})"),
            tags: vec![],
            created_at: String::new(),
            modified_at: String::new(),
            is_expiring: false,
            char_count: 0,
        };
        let extra = format!("![](../assets/{in_draft})");
        // With a grace period nothing is old enough to go.
        assert_eq!(cleanup(&s, &[note.clone()], &extra, CLEANUP_GRACE), 0);
        // Without one, only the orphan is collected (moved to the Recycle Bin).
        assert_eq!(cleanup(&s, &[note], &extra, Duration::ZERO), 1);
        let dir = assets_dir(&s);
        assert!(dir.join(&used).exists() && dir.join(&in_draft).exists());
        assert!(!dir.join(&young_orphan).exists());
        assert!(save(&s, b"x", "exe").is_err());
    }
}
