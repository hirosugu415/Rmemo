//! Text inside pasted images, so a search finds the note with that
//! screenshot of an error message.
//!
//! A background thread reads every image in `assets/` it hasn't read yet
//! through the OCR engine built into Windows (offline — nothing leaves the
//! PC), one at a time, and keeps the results in `%APPDATA%\Rmemo\ocr.json`
//! keyed by file name and size (images are never edited in place; a new
//! paste is a new file). The search then also looks in the text of the
//! images each note mentions.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Image file name (lowercase) → its text. What the search reads.
pub type OcrText = HashMap<String, String>;

/// Raster formats only — an SVG's text is in the file already.
const READABLE: &[&str] = &["webp", "png", "jpg", "jpeg", "gif"];
/// Without a wake-up (a paste, a synced change), look again this often —
/// images can arrive through Drive while nothing else happens.
const IDLE_POLL: Duration = Duration::from_secs(5 * 60);

/// Bumped when the reading gets better, so images read the old way are
/// read again (2: Rocr's two-engine merge, enlarging, inverting; 3: no
/// duplicated or garbled words from the merge).
const READER_VERSION: u32 = 3;

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Cache {
    version: u32,
    images: HashMap<String, Entry>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Entry {
    size: u64,
    text: String,
}

fn cache_path() -> PathBuf {
    crate::config::data_dir().join("ocr.json")
}

fn load_cache() -> Cache {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Cache>(&t).ok())
        .filter(|c| c.version == READER_VERSION)
        .unwrap_or(Cache { version: READER_VERSION, images: HashMap::new() })
}

fn save_cache(cache: &Cache) {
    let _ = std::fs::create_dir_all(crate::config::data_dir());
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(cache_path(), text);
    }
}

fn publish(app: &AppHandle, cache: &Cache) {
    let text: OcrText = cache
        .images
        .iter()
        .filter(|(_, e)| !e.text.is_empty())
        .map(|(k, e)| (k.clone(), e.text.clone()))
        .collect();
    *app.state::<AppState>().ocr_text.write() = text;
}

/// Starts the reader thread; `wake` asks it to look for new images now.
pub fn spawn(app: AppHandle, wake: Receiver<()>) {
    std::thread::spawn(move || {
        let mut cache = load_cache();
        publish(&app, &cache);
        loop {
            if read_new_images(&app, &mut cache) {
                save_cache(&cache);
                publish(&app, &cache);
            }
            match wake.recv_timeout(IDLE_POLL) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            // A burst of wake-ups (several pastes) is one pass.
            while wake.try_recv().is_ok() {}
        }
    });
}

/// OCRs every image in `assets/` not in `cache` yet (or changed size).
/// Returns whether the cache changed.
///
/// The engine is made here and dropped at the end, not kept: reading loads
/// Windows' recognition models, about 7.5 MB that would otherwise stay for
/// as long as the app runs (in the tray, that's days). Dropping it gives
/// back about 5.5 MB; the rest is Windows' OCR code, which stays loaded.
/// A pass with nothing new makes no engine at all.
fn read_new_images(app: &AppHandle, cache: &mut Cache) -> bool {
    let settings = app.state::<AppState>().config.read().clone();
    let Ok(entries) = std::fs::read_dir(super::images::assets_dir(&settings)) else {
        return false;
    };
    let new: Vec<(std::path::PathBuf, String, u64)> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_lowercase();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            let meta = entry.metadata().ok()?;
            let unread = meta.is_file()
                && READABLE.contains(&ext.as_str())
                && !cache.images.get(&name).is_some_and(|e| e.size == meta.len());
            unread.then_some((path, name, meta.len()))
        })
        .collect();
    if new.is_empty() {
        return false;
    }
    let Some(mut engine) = engine::Engine::new() else {
        eprintln!("[ocr] no OCR engine for this PC's languages — image text won't be searchable");
        return false;
    };
    for (path, name, size) in new {
        // A failure is remembered as "no text", so a broken file isn't
        // retried on every pass.
        let text = match engine.read(&path) {
            Ok(text) => text,
            Err(e) => {
                eprintln!("[ocr] {name}: {e}");
                String::new()
            }
        };
        cache.images.insert(name, Entry { size, text });
        // Publish as we go: a big first pass shouldn't hide everything
        // until the last image is done.
        publish(app, cache);
    }
    true
}

fn is_japanese(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x30FF     // CJK punctuation, hiragana, katakana
        | 0x3400..=0x4DBF   // CJK ext A
        | 0x4E00..=0x9FFF   // CJK unified
        | 0xF900..=0xFAFF   // CJK compatibility
        | 0xFF00..=0xFFEF)  // full/half-width forms
}

/// The engines space every word apart, Japanese included (`11 月`, `# 旅行`,
/// `477 字`). Japanese doesn't space its words, and a search for `11月`
/// must find it, so a space next to Japanese on either side goes. Spaces
/// between Latin words (`if stack.len()`) stay.
fn tidy_spaces(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        if c == ' ' {
            let prev = out.chars().last();
            let next = chars[i + 1..].iter().copied().find(|&n| n != ' ');
            let joins_japanese = prev.is_some_and(is_japanese) || next.is_some_and(is_japanese);
            if joins_japanese || prev == Some(' ') || prev.is_none() || prev == Some('\n') {
                continue;
            }
        }
        out.push(c);
    }
    out
}

/// Text of the images `body` mentions, in order, one image per line.
pub fn text_for(body: &str, ocr: &OcrText) -> String {
    super::images::referenced(body)
        .iter()
        .filter_map(|name| ocr.get(&name.to_lowercase()))
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(windows)]
mod engine {
    use super::super::ocr_engine::Engines;
    use std::path::Path;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    /// Rocr's recognition (see `ocr_engine`): Japanese and English engines
    /// merged, small images enlarged, dark pages inverted.
    pub struct Engine(Engines);

    impl Engine {
        /// `None` when Windows has no OCR language installed.
        pub fn new() -> Option<Self> {
            // SAFETY: once, on this thread, before any WinRT call.
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            Engines::new().map(Self)
        }

        pub fn read(&mut self, path: &Path) -> Result<String, String> {
            let rgba = image::open(path).map_err(|e| e.to_string())?.to_rgba8();
            let (w, h) = rgba.dimensions();
            self.0.recognize_rgba(rgba.into_raw(), w, h).map(|r| super::tidy_spaces(&r.text))
        }
    }
}

#[cfg(not(windows))]
mod engine {
    pub struct Engine;
    impl Engine {
        pub fn new() -> Option<Self> {
            None
        }
        pub fn read(&mut self, _path: &std::path::Path) -> Result<String, String> {
            Err("OCR is Windows-only".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real Windows OCR engine, so opt-in: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn reads_the_text_in_a_real_screenshot() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../site/images/search.png");
        let mut engine = engine::Engine::new().expect("an OCR language installed");
        let text = engine.read(&path).unwrap();
        eprintln!("{text}");
        assert!(text.contains("検索"), "{text}");
    }

    /// Reads the images listed in `RMEMO_OCR_FILES` (`;`-separated) and
    /// prints the text — for comparing the engine on real screenshots.
    /// `RMEMO_OCR_FILES=a.webp;b.png cargo test -- --ignored --nocapture read_listed`
    #[test]
    #[ignore]
    fn read_listed_images() {
        let mut engine = engine::Engine::new().expect("an OCR language installed");
        for file in std::env::var("RMEMO_OCR_FILES").unwrap_or_default().split(';').filter(|f| !f.is_empty()) {
            eprintln!("===== {file}\n{}", engine.read(std::path::Path::new(file)).unwrap_or_else(|e| e));
        }
    }

    #[test]
    fn spaces_next_to_japanese_go_latin_ones_stay() {
        assert_eq!(tidy_spaces("11 月の 三連休 に 2 泊"), "11月の三連休に2泊");
        assert_eq!(tidy_spaces("# 旅行 3"), "#旅行3");
        assert_eq!(tidy_spaces("前回の if stack.len() く 2 { return Err"), "前回のif stack.len()く2 { return Err");
        assert_eq!(tidy_spaces("ピン留め Scratch\n 削除"), "ピン留めScratch\n削除");
    }

    #[test]
    fn a_notes_image_text_is_found_by_its_mentions() {
        let mut ocr = OcrText::new();
        ocr.insert("a.webp".into(), "画面の文字".into());
        ocr.insert("b.png".into(), "別の画像".into());
        assert_eq!(text_for("見て ![](../assets/A.webp)", &ocr), "画面の文字");
        assert_eq!(text_for("画像なし", &ocr), "");
    }
}
