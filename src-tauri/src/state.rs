//! Shared application state: the settings and the in-memory note cache every
//! command reads and writes.

use crate::config::Settings;
use crate::notes::{ocr::OcrText, Note};
use parking_lot::{Mutex, RwLock};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::time::Instant;

pub struct AppState {
    pub config: Arc<RwLock<Settings>>,
    /// The whole note set, loaded once at startup and kept current by
    /// optimistic updates from every mutating command plus a filesystem
    /// watcher as a safety net. See `notes::search` for why re-scanning disk
    /// per query would be the wrong call at this scale.
    pub notes: Arc<RwLock<Vec<Note>>>,
    /// Bumped whenever the watched folders change (a `notesDir` setting
    /// update), so a stale watcher thread knows to let go of its watch and
    /// exit rather than race the replacement.
    pub watch_generation: Arc<AtomicUsize>,
    /// Tracked by polling the OS rather than from `WindowEvent::Focused`,
    /// because WebView2 keeps keyboard focus in a child HWND — see
    /// `spawn_focus_watch` in `lib.rs`.
    pub focused: Arc<AtomicBool>,
    /// Our own window, so the focus-watch thread can tell whether the
    /// foreground window is us.
    pub our_hwnd: Arc<AtomicIsize>,
    /// Set while a native dialog of ours is open: it takes the foreground,
    /// and hide-on-blur must not hide the window it belongs to.
    pub dialog_open: Arc<AtomicBool>,
    /// When the window was last hidden; `None` while it is showing. Read by
    /// `spawn_webview_reaper` to let go of the webview after a long absence.
    pub hidden_at: Arc<Mutex<Option<Instant>>>,
    /// Set once the reaper has destroyed the window, so the next summon knows
    /// to build it again.
    pub released: Arc<AtomicBool>,
    /// Text read out of pasted images (see `notes::ocr`), for the search.
    pub ocr_text: Arc<RwLock<OcrText>>,
    /// Tells the OCR thread to look for new images now.
    ocr_wake: Mutex<Sender<()>>,
}

impl AppState {
    pub fn new(config: Settings, notes: Vec<Note>, ocr_wake: Sender<()>) -> Self {
        Self {
            config: Arc::new(RwLock::new(config)),
            notes: Arc::new(RwLock::new(notes)),
            watch_generation: Arc::new(AtomicUsize::new(0)),
            focused: Arc::new(AtomicBool::new(true)),
            our_hwnd: Arc::new(AtomicIsize::new(0)),
            dialog_open: Arc::new(AtomicBool::new(false)),
            hidden_at: Arc::new(Mutex::new(None)),
            released: Arc::new(AtomicBool::new(false)),
            ocr_text: Arc::new(RwLock::new(OcrText::new())),
            ocr_wake: Mutex::new(ocr_wake),
        }
    }

    pub fn wake_ocr(&self) {
        let _ = self.ocr_wake.lock().send(());
    }
}
