//! Pinned notes: a list of filenames in `<notes>/.rmemo/pins.json`. Kept in
//! the notes folder (not `%APPDATA%`) so pins travel with the notes through
//! Drive, and outside the notes themselves (no front matter, by design).
//! Read on every list request — it's tiny, and another PC may have changed it.

use crate::config::Settings;
use std::path::PathBuf;

fn path(settings: &Settings) -> PathBuf {
    settings.notes_dir.join(".rmemo").join("pins.json")
}

pub fn load(settings: &Settings) -> Vec<String> {
    std::fs::read_to_string(path(settings))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(settings: &Settings, pins: &[String]) -> std::io::Result<()> {
    let p = path(settings);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(pins).map_err(std::io::Error::other)?)
}

/// Pins or unpins `filename`. Newly pinned notes go first.
pub fn set(settings: &Settings, filename: &str, pinned: bool) -> std::io::Result<()> {
    let mut pins = load(settings);
    pins.retain(|p| !p.eq_ignore_ascii_case(filename));
    if pinned {
        pins.insert(0, filename.to_string());
    }
    save(settings, &pins)
}

/// Keeps a pin attached to a note whose file was renamed (title change,
/// Keep/Scratch move). No write when the note wasn't pinned.
pub fn rename(settings: &Settings, from: &str, to: &str) {
    let mut pins = load(settings);
    let mut changed = false;
    for p in pins.iter_mut().filter(|p| p.eq_ignore_ascii_case(from)) {
        *p = to.to_string();
        changed = true;
    }
    if changed {
        let _ = save(settings, &pins);
    }
}

pub fn remove(settings: &Settings, filename: &str) {
    let mut pins = load(settings);
    let before = pins.len();
    pins.retain(|p| !p.eq_ignore_ascii_case(filename));
    if pins.len() != before {
        let _ = save(settings, &pins);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_follow_renames_and_deletes() {
        let dir = std::env::temp_dir().join("rmemo-pins-test");
        let _ = std::fs::remove_dir_all(&dir);
        let s = Settings { notes_dir: dir, ..Settings::default() };
        assert!(load(&s).is_empty());
        set(&s, "a.md", true).unwrap();
        set(&s, "b.md", true).unwrap();
        assert_eq!(load(&s), vec!["b.md", "a.md"]);
        rename(&s, "a.md", "c.md");
        assert_eq!(load(&s), vec!["b.md", "c.md"]);
        remove(&s, "b.md");
        set(&s, "c.md", false).unwrap();
        assert!(load(&s).is_empty());
    }
}
