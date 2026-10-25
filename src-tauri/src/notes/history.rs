//! Earlier versions of each note, so an edit (or an emptied note, or a bulk
//! tag rename) can be undone after the editor's own undo is long gone.
//!
//! Kept on this PC only, in `%APPDATA%\Rmemo\history\<note name>\` — not
//! next to the notes, where Drive would sync every snapshot and two PCs
//! writing them at once would conflict. One folder per note, one file per
//! version named by when it was kept (`20261025-153000.md`).
//!
//! A version is the note's content *before* a save overwrote it, kept at
//! most once per `GAP` while typing — so each editing session leaves the
//! state it started from, not every autosave.

use chrono::{Local, NaiveDateTime, TimeZone};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Typing within this long of the last kept version doesn't keep another.
pub const GAP: Duration = Duration::from_secs(10 * 60);
/// Versions kept per note at most…
const KEEP_MAX: usize = 50;
/// …and none older than this, except the newest `KEEP_MIN`.
const KEEP_DAYS: i64 = 60;
const KEEP_MIN: usize = 5;

const STAMP: &str = "%Y%m%d-%H%M%S";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub saved_at: String,
    pub title: String,
    pub char_count: usize,
}

pub fn root() -> PathBuf {
    crate::config::data_dir().join("history")
}

fn dir_for(root: &Path, filename: &str) -> PathBuf {
    root.join(filename.strip_suffix(".md").unwrap_or(filename))
}

/// Version ids are our own stamps; anything else (`..\x`) is refused.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_digit() || c == '-')
}

fn time_of(id: &str) -> Option<chrono::DateTime<Local>> {
    let stamp = id.get(..15)?;
    let naive = NaiveDateTime::parse_from_str(stamp, STAMP).ok()?;
    Local.from_local_datetime(&naive).single()
}

/// Version ids of `filename`, oldest first.
fn ids(root: &Path, filename: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir_for(root, filename)) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.strip_suffix(".md").map(str::to_string))
        .filter(|id| valid_id(id))
        .collect();
    // Same-second ids carry a `-2`, `-3`… suffix; sort by (time, suffix).
    ids.sort_by_key(|id| {
        let n: u32 = id.get(16..).and_then(|s| s.parse().ok()).unwrap_or(1);
        (id.get(..15).unwrap_or(id).to_string(), n)
    });
    ids
}

/// Keeps `body` — the note's content just before a save replaces it — as a
/// version, unless it's empty, the same as the newest version, or (without
/// `force`) the newest one is younger than `gap`.
pub fn record(root: &Path, filename: &str, body: &str, gap: Duration, force: bool) -> std::io::Result<()> {
    if body.trim().is_empty() {
        return Ok(());
    }
    let dir = dir_for(root, filename);
    let existing = ids(root, filename);
    if let Some(newest) = existing.last() {
        // The time check first: it needs only the file name, and on almost
        // every autosave it ends things here without reading anything.
        let recent = time_of(newest).is_some_and(|t| {
            Local::now().signed_duration_since(t).to_std().unwrap_or_default() < gap
        });
        if recent && !force {
            return Ok(());
        }
        let same = std::fs::read_to_string(dir.join(format!("{newest}.md")))
            .is_ok_and(|b| b.replace("\r\n", "\n") == body.replace("\r\n", "\n"));
        if same {
            return Ok(());
        }
    }
    std::fs::create_dir_all(&dir)?;
    let stamp = Local::now().format(STAMP).to_string();
    // Within the same second, count up from the highest suffix used — not
    // into a gap pruning left, which would sort the new one as oldest.
    let highest = existing
        .iter()
        .filter(|id| id.starts_with(&stamp))
        .map(|id| id.get(16..).and_then(|s| s.parse::<u32>().ok()).unwrap_or(1))
        .max();
    let id = match highest {
        None => stamp,
        Some(n) => format!("{stamp}-{}", n + 1),
    };
    std::fs::write(dir.join(format!("{id}.md")), body)?;
    prune(root, filename);
    Ok(())
}

fn prune(root: &Path, filename: &str) {
    let dir = dir_for(root, filename);
    let all = ids(root, filename);
    let now = Local::now();
    let total = all.len();
    for (i, id) in all.iter().enumerate() {
        let from_newest = total - 1 - i;
        let too_many = from_newest >= KEEP_MAX;
        let too_old = from_newest >= KEEP_MIN
            && time_of(id).is_some_and(|t| now.signed_duration_since(t).num_days() > KEEP_DAYS);
        if too_many || too_old {
            let _ = std::fs::remove_file(dir.join(format!("{id}.md")));
        }
    }
}

/// What a `sweep` went through, for the log.
#[derive(Debug, Default, PartialEq)]
pub struct Swept {
    pub folders: usize,
    pub removed_folders: usize,
}

/// The startup tidy-up. `prune` only runs when a note is saved, so a note
/// never edited again would keep its old versions forever, and a note
/// deleted (or renamed outside Rmemo) would leave its folder behind. This
/// prunes every folder, and drops a folder whose note is gone once its
/// newest version is past `KEEP_DAYS` — until then a deleted note can still
/// be looked up. Reads file *names* only (a version's time is its name),
/// never contents. `notes` are the existing notes' filenames.
pub fn sweep(root: &Path, notes: &std::collections::HashSet<String>) -> Swept {
    let mut swept = Swept::default();
    let Ok(entries) = std::fs::read_dir(root) else {
        return swept;
    };
    let now = Local::now();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Some(stem) = entry.file_name().to_str().map(str::to_string) else { continue };
        let filename = format!("{stem}.md");
        swept.folders += 1;
        if notes.contains(&filename.to_lowercase()) {
            prune(root, &filename);
            continue;
        }
        let newest = ids(root, &filename).last().and_then(|id| time_of(id));
        let stale = newest.is_none_or(|t| now.signed_duration_since(t).num_days() > KEEP_DAYS);
        if stale {
            if std::fs::remove_dir_all(entry.path()).is_ok() {
                swept.removed_folders += 1;
            }
        } else {
            prune(root, &filename);
        }
    }
    swept
}

/// `filename`'s versions, newest first.
pub fn list(root: &Path, filename: &str) -> Vec<Version> {
    let dir = dir_for(root, filename);
    ids(root, filename)
        .into_iter()
        .rev()
        .filter_map(|id| {
            let body = std::fs::read_to_string(dir.join(format!("{id}.md"))).ok()?;
            Some(Version {
                saved_at: time_of(&id).map(|t| t.to_rfc3339()).unwrap_or_default(),
                title: super::title_text(&body).unwrap_or_else(|| "(無題)".into()),
                char_count: super::char_count(&body),
                id,
            })
        })
        .collect()
}

pub fn read(root: &Path, filename: &str, id: &str) -> std::io::Result<String> {
    if !valid_id(id) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad version id"));
    }
    std::fs::read_to_string(dir_for(root, filename).join(format!("{id}.md")))
}

/// The note was renamed (title change, Keep/Scratch move): its versions
/// follow it. Into an existing folder, they're merged.
pub fn rename(root: &Path, from: &str, to: &str) {
    let (src, dst) = (dir_for(root, from), dir_for(root, to));
    if src == dst || !src.is_dir() {
        return;
    }
    if !dst.exists() && std::fs::rename(&src, &dst).is_ok() {
        return;
    }
    let _ = std::fs::create_dir_all(&dst);
    if let Ok(entries) = std::fs::read_dir(&src) {
        for e in entries.flatten() {
            let target = dst.join(e.file_name());
            if !target.exists() {
                let _ = std::fs::rename(e.path(), target);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&src);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rmemo-history-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn keeps_one_version_per_gap_unless_forced() {
        let r = root("gap");
        record(&r, "メモ.md", "v1", GAP, false).unwrap();
        record(&r, "メモ.md", "v2", GAP, false).unwrap(); // within the gap
        assert_eq!(list(&r, "メモ.md").len(), 1);
        record(&r, "メモ.md", "v2", GAP, true).unwrap();
        record(&r, "メモ.md", "v2", GAP, true).unwrap(); // same as newest
        let versions = list(&r, "メモ.md");
        assert_eq!(versions.len(), 2);
        assert_eq!(read(&r, "メモ.md", &versions[0].id).unwrap(), "v2");
        assert_eq!(read(&r, "メモ.md", &versions[1].id).unwrap(), "v1");
        record(&r, "メモ.md", "   ", Duration::ZERO, true).unwrap(); // empty: never
        assert_eq!(list(&r, "メモ.md").len(), 2);
    }

    #[test]
    fn versions_follow_a_rename_and_ids_are_checked() {
        let r = root("rename");
        record(&r, "old.md", "body", GAP, true).unwrap();
        rename(&r, "old.md", "new.md");
        assert!(list(&r, "old.md").is_empty());
        assert_eq!(list(&r, "new.md").len(), 1);
        assert!(read(&r, "new.md", "../../etc").is_err());
    }

    #[test]
    fn sweep_drops_long_gone_notes_and_keeps_recent_ones() {
        let r = root("sweep");
        let write = |note: &str, id: &str| {
            std::fs::create_dir_all(r.join(note)).unwrap();
            std::fs::write(r.join(note).join(format!("{id}.md")), "x").unwrap();
        };
        let today = Local::now().format(STAMP).to_string();
        write("ある", "20200101-120000");
        write("ある", &today);
        write("消えた・最近", &today);
        write("消えた・昔", "20200101-120000");
        let notes = ["ある.md".to_string()].into_iter().collect();
        let swept = sweep(&r, &notes);
        assert_eq!(swept, Swept { folders: 3, removed_folders: 1 });
        assert!(!r.join("消えた・昔").exists());
        assert_eq!(list(&r, "消えた・最近.md").len(), 1);
        // The existing note keeps its newest versions even past KEEP_DAYS.
        assert_eq!(list(&r, "ある.md").len(), 2);
    }

    /// How long a startup sweep takes at a size — opt-in, it writes many
    /// files: `cargo test -- --ignored --nocapture sweep_timing`.
    #[test]
    #[ignore]
    fn sweep_timing() {
        for (notes, versions) in [(116, 5), (116, 50), (1000, 50)] {
            let r = root(&format!("timing-{notes}-{versions}"));
            let mut names = std::collections::HashSet::new();
            for n in 0..notes {
                let dir = r.join(format!("メモ{n}"));
                std::fs::create_dir_all(&dir).unwrap();
                for v in 0..versions {
                    std::fs::write(dir.join(format!("20261001-{:06}.md", v)), "x".repeat(3000)).unwrap();
                }
                names.insert(format!("メモ{n}.md"));
            }
            let t = std::time::Instant::now();
            let swept = sweep(&r, &names);
            eprintln!("{notes} notes x {versions} versions: {:?} ({} folders)", t.elapsed(), swept.folders);
            let _ = std::fs::remove_dir_all(&r);
        }
    }

    #[test]
    fn prunes_to_the_newest_ones() {
        let r = root("prune");
        for i in 0..(KEEP_MAX + 3) {
            record(&r, "n.md", &format!("v{i}"), Duration::ZERO, true).unwrap();
        }
        let versions = list(&r, "n.md");
        assert_eq!(versions.len(), KEEP_MAX);
        assert_eq!(read(&r, "n.md", &versions[0].id).unwrap(), format!("v{}", KEEP_MAX + 2));
    }
}
