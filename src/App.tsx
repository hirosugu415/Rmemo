import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Update } from "@tauri-apps/plugin-updater";
import ComposeBox, { type ComposeHandle } from "./components/ComposeBox";
import SearchView from "./components/SearchView";
import SettingsPanel from "./components/SettingsPanel";
import FormatReview from "./components/FormatReview";
import TriageView from "./components/TriageView";
import Tutorial from "./components/Tutorial";
import { checkForUpdate, installUpdate, UPDATE_CHECK_INTERVAL_MS, UPDATES_ENABLED } from "./updater";
import { cleanupImages, setNotesDir } from "./images";
import { actionFor, layoutReady, resolveKeymap } from "./keybindings";
import {
  backlinks as fetchBacklinks,
  createNote,
  deleteNote,
  extractTags,
  getNote,
  getSettings,
  hideWindow,
  listNotes,
  listTags,
  renameLinks,
  renameTag,
  setPinned,
  setZoom,
  NOTE_GONE,
  setStatus,
  updateNote,
  type ImportReport,
  type Note,
  type NoteSummary,
  type Settings,
  type Status,
  type TagCount,
} from "./api";

type View = "compose" | "search" | "settings" | "triage" | "tutorial" | "review";

/** A full note as the list-row shape (the triage screen deals in those). */
const toSummary = (note: Note): NoteSummary => ({ ...note, snippet: "", pinned: false });

/** A courtesy debounce on top of an already-cheap in-memory backend search. */
const DEBOUNCE_MS = 120;

/** How long compose typing must pause before it's autosaved to disk — short
 *  enough to feel immediate, long enough to not write on every keystroke.
 *  Applies equally to a brand-new note: the file is created the first time
 *  this fires with non-empty content, same as an existing one being updated. */
const AUTOSAVE_DEBOUNCE_MS = 500;

const TOAST_MS = 2500;

/** One Ctrl +/- step of UI zoom. */
const ZOOM_STEP = 0.1;

/** Ctrl +/-/0 as a zoom action, or null. Matched by character *and* by
 *  physical key, because with Ctrl held WebView2 doesn't always report the
 *  shifted character: on JIS, Ctrl++ is Ctrl+Shift+; and may arrive as `;`.
 *  (`;` is free here — the date lives on the `:` key.) */
function zoomAction(e: KeyboardEvent): "in" | "out" | "reset" | null {
  if (!e.ctrlKey || e.altKey) return null;
  if (["+", "=", ";"].includes(e.key) || ["Semicolon", "Equal", "NumpadAdd"].includes(e.code)) return "in";
  if (["-", "_"].includes(e.key) || ["Minus", "NumpadSubtract"].includes(e.code)) return "out";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}

/** Anything you type into — the CodeMirror editor is a contenteditable. */
const TEXT_FIELD = 'textarea, input, [contenteditable="true"]';

/** WebView2's own browser shortcuts that mean nothing in a notes app and can
 *  do harm — F5/Ctrl+R reload the page (dropping any unsaved draft), Ctrl+P
 *  prints, Ctrl+F/G/F3 open the page find bar, F7 toggles caret browsing.
 *  Swallowed unless one of our own handlers already claimed the key. */
function isBrowserShortcut(e: KeyboardEvent): boolean {
  if (["F3", "F5", "F7", "BrowserBack", "BrowserForward", "BrowserRefresh"].includes(e.key)) {
    return true;
  }
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    // Alt+←/→ is history navigation — but only outside a text field.
    const t = e.target as HTMLElement | null;
    return !t?.closest(TEXT_FIELD);
  }
  if (!e.ctrlKey) return false;
  return ["r", "p", "f", "g", "h", "j", "u", "o", "s", "n"].includes(e.key.toLowerCase());
}

/**
 * One "thing being written" in the compose screen — from the moment a note
 * is opened (or a blank one started) until the next one replaces it.
 *
 * Saves are asynchronous and queued, so a save may finish after the user has
 * already moved on to another note. Keeping the file identity on this object
 * (instead of only in React state) lets a late save update the session it
 * belongs to without ever touching whichever session is current now.
 */
interface ComposeSession {
  /** null until the first save creates the file. */
  filename: string | null;
  /** Body as last written to (or read from) disk — the dirty baseline. */
  lastSaved: string;
  /** Created by this session (autosave/Ctrl+S), not opened from search — only
   *  such a file is deleted again if the user empties it. */
  createdHere: boolean;
  status: Status;
  /** The title other notes' `[[links]]` currently use for this note — the
   *  title it had when opened. When the session ends with a different title,
   *  those links are rewritten (`followRename`). null for a note started
   *  here: nothing can link to a title that never existed. */
  linkTitle: string | null;
  /** Title as of the last save. */
  title: string | null;
}

const blankSession = (status: Status): ComposeSession => ({
  filename: null,
  lastSaved: "",
  createdHere: false,
  status,
  linkTitle: null,
  title: null,
});

/** Filename of the note "← 前回" reopens, kept across restarts. */
const LAST_NOTE_KEY = "rmemo.lastNote";

function readLastNote(): string | null {
  try {
    return localStorage.getItem(LAST_NOTE_KEY);
  } catch {
    return null;
  }
}

export default function App() {
  const [view, setView] = useState<View>("compose");
  /** The import whose notes the 整形 review is walking. */
  const [importReport, setImportReport] = useState<{ report: ImportReport; tagged: boolean } | null>(null);

  // Compose state — rendered copies of what `sessionRef` and
  // `composeBodyRef` hold authoritatively for the async save path.
  const [composeBody, setComposeBody] = useState("");
  const [composeStatus, setComposeStatus] = useState<Status>("keep");
  const [openFilename, setOpenFilename] = useState<string | null>(null);
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  const [loadToken, setLoadToken] = useState(0);
  const [pendingSelection, setPendingSelection] = useState<{ start: number; end: number } | null>(
    null,
  );
  const sessionRef = useRef<ComposeSession>(blankSession("keep"));
  /** The session that was open when the compose box last went blank. Kept as
   *  the session object, not its filename: the save still in flight can
   *  rename the file (title change), and `commitSave` updates this object. */
  const previousRef = useRef<Pick<ComposeSession, "filename">>({ filename: readLastNote() });
  const composeBodyRef = useRef("");
  const composeHandle = useRef<ComposeHandle | null>(null);
  /** Every disk operation on the compose session runs through this chain, one
   *  at a time. Without it, a Ctrl+S landing while the autosave's create is
   *  still in flight would see "no file yet" and create a second copy. */
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());

  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  /** All tags across all notes — the search screen's tag browser and the
   *  compose box's `#` completion both read this. */
  const [tags, setTags] = useState<TagCount[]>([]);
  /** Expiring scratch notes, for the search screen's "整理" button badge. */
  const [expiringCount, setExpiringCount] = useState(0);
  /** Every note (any status, no query) — titles for `[[` links. */
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  /** Bumped whenever notes change on disk, so derived lookups re-run. */
  const [notesTick, setNotesTick] = useState(0);
  const [noteBacklinks, setNoteBacklinks] = useState<NoteSummary[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [toast, setToast] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  /** Bumped once the keyboard layout is known: defaults like Ctrl+: follow
   *  their character to wherever this layout puts it. */
  const [layoutTick, setLayoutTick] = useState(0);
  useEffect(() => {
    void layoutReady.then(() => setLayoutTick((t) => t + 1));
  }, []);
  const keymap = useMemo(() => resolveKeymap(settings?.keybindings), [settings, layoutTick]);

  const nextReqId = useRef(0);
  const newestSeen = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef(query);
  const filterRef = useRef(statusFilter);

  const flash = useCallback((message: string) => {
    // A second toast restarts the clock instead of being cut short by the
    // first one's timer.
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  // The app lives in the tray for days, so look again now and then rather
  // than only at launch.
  useEffect(() => {
    if (!UPDATES_ENABLED) return;
    const look = () => void checkForUpdate().then((u) => u && setUpdate(u));
    look();
    const timer = setInterval(look, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const startUpdate = async () => {
    if (!update || installing) return;
    setInstalling(true);
    try {
      await installUpdate(update);
    } catch (e) {
      console.error("[updater] install failed", e);
      setInstalling(false);
      flash("更新できませんでした。しばらくしてからもう一度お試しください");
    }
  };

  // Replies are reordered by request id so a slow one cannot clobber a newer one.
  const refresh = useCallback(
    (q: string, filter: Status | "all") => {
      const id = ++nextReqId.current;
      listNotes({ status: filter === "all" ? undefined : filter, query: q || undefined })
        .then((items) => {
          if (id < newestSeen.current) return;
          newestSeen.current = id;
          setNotes(items);
        })
        .catch((e) => flash(String(e)));
    },
    [flash],
  );
  const refreshTags = useCallback(() => {
    listTags()
      .then(setTags)
      .catch(() => {});
    listNotes({ status: "scratch" })
      .then((items) => setExpiringCount(items.filter((n) => n.isExpiring).length))
      .catch(() => {});
    listNotes({})
      .then(setAllNotes)
      .catch(() => {});
    setNotesTick((t) => t + 1);
  }, []);
  const refreshCurrent = useCallback(
    () => refresh(queryRef.current.trim(), filterRef.current),
    [refresh],
  );

  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    filterRef.current = statusFilter;
  }, [statusFilter]);

  // ---------- compose: the save queue ----------

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = saveQueue.current.then(task);
    saveQueue.current = run.catch(() => {});
    return run;
  }, []);

  const setBody = useCallback((body: string) => {
    composeBodyRef.current = body;
    setComposeBody(body);
  }, []);

  const isCurrent = (s: ComposeSession) => s === sessionRef.current;

  /** Writes `body` as `s`'s file — creating it on the first save, or again if
   *  it was deleted out from under us (Explorer, another device). */
  const commitSave = useCallback(
    (s: ComposeSession, body: string): Promise<boolean> =>
      enqueue(async () => {
        if (s.filename && body === s.lastSaved) return true;
        try {
          let note: Note | null = null;
          if (s.filename) {
            try {
              note = await updateNote(s.filename, body);
            } catch (e) {
              if (!String(e).includes(NOTE_GONE)) throw e;
            }
          }
          if (!note) {
            note = await createNote(body, s.status);
            s.createdHere = true;
          }
          s.filename = note.filename;
          s.lastSaved = body;
          s.title = note.title;
          if (isCurrent(s)) {
            setOpenFilename(note.filename);
            setOpenTitle(note.title);
          }
          return true;
        } catch (e) {
          flash(String(e));
          return false;
        }
      }),
    [enqueue, flash],
  );

  /** A note this session created and the user then emptied is abandoned,
   *  not kept as an empty (or stale) file. Notes opened from search are
   *  never deleted this way — emptying one is left alone, not saved. */
  const discardIfCreatedHere = useCallback(
    (s: ComposeSession) =>
      enqueue(async () => {
        if (!s.filename || !s.createdHere) return;
        await deleteNote(s.filename).catch(() => {});
        s.filename = null;
        s.lastSaved = "";
        s.createdHere = false;
        if (isCurrent(s)) {
          setOpenFilename(null);
          setOpenTitle(null);
        }
      }),
    [enqueue],
  );

  /** Persists whatever `s` holds right now, if anything changed. */
  const flushSession = useCallback(
    (s: ComposeSession, body: string): Promise<unknown> => {
      if (body.trim() === "") return discardIfCreatedHere(s);
      if (body === s.lastSaved) return Promise.resolve();
      return commitSave(s, body);
    },
    [commitSave, discardIfCreatedHere],
  );

  const flushDraft = useCallback(
    () => flushSession(sessionRef.current, composeBodyRef.current),
    [flushSession],
  );

  /** The note's title changed during the session: point other notes'
   *  `[[old title]]` links at the new one. Done once, when the session ends
   *  (or the window hides) — not on every autosave, where a half-typed
   *  title could momentarily match some other note and steal its links. */
  const followRename = useCallback(
    (s: ComposeSession) => {
      enqueue(async () => {
        const from = s.linkTitle;
        const to = s.title;
        if (!s.filename || !from || !to || from === to) return;
        s.linkTitle = to;
        const n = await renameLinks(from, to, s.filename);
        if (n > 0) flash(`「${to}」へのリンクを ${n} 件のメモで更新しました`);
      }).catch((e) => flash(String(e)));
    },
    [enqueue, flash],
  );

  /** Images no note uses any more go to the Recycle Bin — run only between
   *  editing sessions (never mid-edit, so Ctrl+Z can still bring an image
   *  line back), queued after the pending saves. The compose box's current
   *  text counts as "using" too. */
  const collectImages = useCallback(() => {
    enqueue(() => cleanupImages(composeBodyRef.current)).catch(() => {});
  }, [enqueue]);

  /** Swaps in a new session. The outgoing one is flushed first unless the
   *  caller already did (or its file was just deleted on purpose). */
  const startSession = useCallback(
    (
      next: ComposeSession,
      body: string,
      title: string | null,
      selection: { start: number; end: number } | null,
      flushPrevious = true,
    ) => {
      if (flushPrevious) flushDraft();
      followRename(sessionRef.current);
      collectImages();
      sessionRef.current = next;
      setBody(body);
      setComposeStatus(next.status);
      setOpenFilename(next.filename);
      setOpenTitle(title);
      setPendingSelection(selection);
      setLoadToken((t) => t + 1);
    },
    [flushDraft, setBody, collectImages, followRename],
  );

  const resetToBlank = useCallback(() => {
    const s = sessionRef.current;
    if (s.filename !== null || composeBodyRef.current.trim() !== "") previousRef.current = s;
    startSession(blankSession(sessionRef.current.status), "", null, null);
  }, [startSession]);

  const saveDraft = useCallback(() => {
    const body = composeBodyRef.current;
    if (body.trim() === "") {
      resetToBlank();
      return;
    }
    commitSave(sessionRef.current, body).then((ok) => {
      if (ok) flash("一時保存しました");
    });
  }, [commitSave, resetToBlank, flash]);

  const saveAndClose = useCallback(() => {
    const body = composeBodyRef.current;
    if (body.trim() === "") {
      resetToBlank();
      return;
    }
    const s = sessionRef.current;
    commitSave(s, body).then((ok) => {
      if (!ok) return;
      flash("保存しました");
      if (isCurrent(s)) resetToBlank();
    });
  }, [commitSave, resetToBlank, flash]);

  /** Done for now: save and get out of the way. The note stays open, so the
   *  next summon carries on where this left off. */
  const saveAndHide = useCallback(() => {
    const body = composeBodyRef.current;
    const saved = body.trim() === "" ? Promise.resolve(true) : commitSave(sessionRef.current, body);
    saved.then((ok) => {
      if (ok) hideWindow();
    });
  }, [commitSave]);

  // Autosave: any pause in typing long enough to be "done for now" flushes
  // to disk, so forgetting to hit Ctrl+S can't lose anything.
  useEffect(() => {
    const timer = setTimeout(() => flushDraft(), AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [composeBody, flushDraft]);

  /** The open note changed on disk without us (Rflow appending to today's
   *  daily note via the API, a Drive sync from another PC, Notepad…). If
   *  there are no unsaved edits, just load the new text; otherwise keep the
   *  edits — they win on the next save — but first preserve the outside
   *  version as its own note, so nothing is silently overwritten. */
  const checkExternalChange = useCallback(() => {
    const s = sessionRef.current;
    if (!s.filename) return;
    enqueue(async () => {
      if (!isCurrent(s) || !s.filename) return;
      let note: Note;
      try {
        note = await getNote(s.filename);
      } catch {
        return; // deleted: the next save recreates it (see commitSave)
      }
      if (note.body === s.lastSaved) return;
      if (composeBodyRef.current === s.lastSaved) {
        s.lastSaved = note.body;
        const sel = composeHandle.current?.selection() ?? null;
        const len = note.body.length;
        setBody(note.body);
        setOpenTitle(note.title);
        setPendingSelection(
          sel ? { start: Math.min(sel.start, len), end: Math.min(sel.end, len) } : null,
        );
        setLoadToken((t) => t + 1);
        flash("外部での変更を読み込みました");
      } else {
        s.lastSaved = note.body;
        try {
          await createNote(note.body, "scratch");
          flash("外部の変更と競合したため、外部版を別メモ(Scratch)に退避しました");
        } catch (e) {
          flash(String(e));
        }
        commitSave(s, composeBodyRef.current); // queued: runs right after this
      }
    });
  }, [enqueue, commitSave, flash, setBody]);

  const handleComposeStatusChange = useCallback(
    (next: Status) => {
      const s = sessionRef.current;
      enqueue(async () => {
        if (s.filename) {
          try {
            // A move can rename the file (a same-titled note already sits in
            // the other folder), so take the filename back too.
            const moved = await setStatus(s.filename, next);
            s.status = moved.status;
            s.filename = moved.filename;
          } catch (e) {
            flash(String(e));
            return;
          }
          refreshCurrent();
        } else {
          s.status = next;
        }
        if (isCurrent(s)) {
          setComposeStatus(s.status);
          setOpenFilename(s.filename);
        }
      });
    },
    [enqueue, flash, refreshCurrent],
  );

  // A tag clicked while composing pivots straight to a topic-filtered search
  // — the same jump a tag pill in the results list offers.
  const searchForTag = useCallback((tag: string) => {
    setStatusFilter("all");
    setQuery(`#${tag}`);
    setView("search");
  }, []);

  const openNoteInCompose = useCallback(
    (summary: NoteSummary) => {
      // Flush first and read after, both through the queue — reopening the
      // note that's already open must see its latest edits, not the copy on
      // disk from before they were saved.
      flushDraft();
      enqueue(() => getNote(summary.filename))
        .then((note) => {
          // Highlight the first search term that occurs in the body.
          let selection: { start: number; end: number } | null = null;
          const lower = note.body.toLowerCase();
          for (const term of queryRef.current.trim().split(/\s+/).filter(Boolean)) {
            const idx = lower.indexOf(term.toLowerCase());
            if (idx >= 0) {
              selection = { start: idx, end: idx + term.length };
              break;
            }
          }
          startSession(
            {
              filename: note.filename,
              lastSaved: note.body,
              createdHere: false,
              status: note.status,
              linkTitle: note.title,
              title: note.title,
            },
            note.body,
            note.title,
            selection,
            false,
          );
          setView("compose");
        })
        .catch((e) => flash(String(e)));
    },
    [enqueue, flushDraft, startSession, flash],
  );

  const noteTitles = useMemo(() => allNotes.map((n) => n.title), [allNotes]);
  /** Characters across the notes the search list shows, for the status bar. */
  const totalChars = useMemo(() => notes.reduce((sum, n) => sum + n.charCount, 0), [notes]);

  /** `[[title]]` Ctrl+clicked: open that note, or start a new one titled so
   *  (saved like any new note once something is written). */
  const openNoteByTitle = useCallback(
    (title: string) => {
      const lower = title.trim().toLowerCase();
      const found = allNotes.find((n) => n.title.toLowerCase() === lower);
      if (found) {
        openNoteInCompose(found);
        return;
      }
      const body = `# ${title.trim()}\n`;
      startSession(blankSession(sessionRef.current.status), body, null, {
        start: body.length,
        end: body.length,
      });
      setView("compose");
    },
    [allNotes, openNoteInCompose, startSession],
  );

  /** What "← 前回" offers on a blank compose box, looked up in the live list
   *  so a renamed note is followed and a deleted one drops out. */
  const previousNote =
    openFilename === null
      ? (allNotes.find((n) => n.filename === previousRef.current.filename) ?? null)
      : null;
  const previousFilename = previousNote?.filename;
  useEffect(() => {
    if (!previousFilename) return;
    try {
      localStorage.setItem(LAST_NOTE_KEY, previousFilename);
    } catch {
      /* storage unavailable: just not remembered across restarts */
    }
  }, [previousFilename]);

  const reopenPrevious = useCallback(() => {
    if (previousNote) openNoteInCompose(previousNote);
  }, [previousNote, openNoteInCompose]);

  // "← 参照元" under the open note: who links here with [[this title]].
  useEffect(() => {
    if (!openTitle) {
      setNoteBacklinks([]);
      return;
    }
    let live = true;
    fetchBacklinks(openTitle, openFilename ?? undefined)
      .then((list) => live && setNoteBacklinks(list))
      .catch(() => live && setNoteBacklinks([]));
    return () => {
      live = false;
    };
  }, [openTitle, openFilename, notesTick]);

  /** `tags` for `#` completion, minus what the open note itself has saved:
   *  autosave writes a half-typed `#Ru` to disk, and offering that back as
   *  an "existing" tag would defeat the point. Tags used here *and*
   *  elsewhere stay, counted for the other notes only. */
  const completionTags = useMemo(() => {
    const own = new Set(extractTags(sessionRef.current.lastSaved));
    return tags
      .map((t) => (own.has(t.tag) ? { ...t, count: t.count - 1 } : t))
      .filter((t) => t.count > 0)
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [tags, openFilename, loadToken]);

  // `../assets/…` image paths resolve against the notes folder.
  useEffect(() => {
    if (settings) setNotesDir(settings.notesDir);
  }, [settings]);

  // ---------- lifecycle ----------

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettingsState(s);
        sessionRef.current.status = s.lastStatus;
        setComposeStatus(s.lastStatus);
        collectImages();
      })
      .catch((e) => flash(String(e)));
    refresh("", "all");
    refreshTags();
  }, [refresh, refreshTags, flash, collectImages]);

  useEffect(() => {
    if (view !== "search") return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => refresh(query.trim(), statusFilter), DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [query, statusFilter, view, refresh]);

  // Listeners are registered once; they reach the latest callbacks via refs.
  const flushDraftRef = useRef(flushDraft);
  const collectImagesRef = useRef(collectImages);
  collectImagesRef.current = collectImages;
  const followRenameRef = useRef(followRename);
  followRenameRef.current = followRename;
  const checkExternalRef = useRef(checkExternalChange);
  useEffect(() => {
    flushDraftRef.current = flushDraft;
    checkExternalRef.current = checkExternalChange;
  }, [flushDraft, checkExternalChange]);

  useEffect(() => {
    const unlisten = [
      listen("notes-changed", () => {
        refreshCurrent();
        refreshTags();
        checkExternalRef.current();
      }),
      // A hotkey/tray summon always lands back on the primary writing screen.
      listen("focus-compose", () => setView("compose")),
      listen("window-hiding", () => {
        flushDraftRef.current();
        followRenameRef.current(sessionRef.current);
        collectImagesRef.current();
      }),
    ];
    return () => {
      unlisten.forEach((p) => p.then((off) => off()));
    };
  }, [refreshCurrent, refreshTags]);

  // ---------- zoom (Ctrl +/-/0, Ctrl+wheel) ----------
  const zoomRef = useRef(1);
  useEffect(() => {
    if (settings) zoomRef.current = settings.zoom ?? 1;
  }, [settings]);

  const changeZoom = useCallback(
    (action: "in" | "out" | "reset") => {
      const target =
        action === "reset"
          ? 1
          : zoomRef.current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP);
      zoomRef.current = Math.round(target * 100) / 100;
      setZoom(zoomRef.current)
        .then((applied) => {
          zoomRef.current = applied;
          flash(`文字サイズ ${Math.round(applied * 100)}%`);
        })
        .catch((e) => flash(String(e)));
    },
    [flash],
  );

  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY !== 0) changeZoom(e.deltaY < 0 ? "in" : "out");
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [changeZoom]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const zoom = zoomAction(e);
      if (zoom && !e.defaultPrevented) {
        e.preventDefault();
        changeZoom(zoom);
        return;
      }
      if (!e.defaultPrevented && isBrowserShortcut(e)) e.preventDefault();
    };
    // The page-level menu (Back / Refresh / Print…) is all browser chrome;
    // text fields keep theirs for cut/copy/paste.
    const onContextMenu = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest(TEXT_FIELD)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [changeZoom]);

  // ---------- search-screen actions ----------

  const handleTogglePin = useCallback(
    (note: NoteSummary) => {
      setPinned(note.filename, !note.pinned)
        .then(() => {
          refreshCurrent();
          flash(note.pinned ? "ピン留めを外しました" : "ピン留めしました");
        })
        .catch((e) => flash(String(e)));
    },
    [refreshCurrent, flash],
  );

  /** Flips a note between Keep and Scratch; resolves to the moved note (its
   *  filename can change on the move), or null on failure. */
  const handleToggleStatus = useCallback(
    (note: NoteSummary): Promise<Note | null> => {
      const next: Status = note.status === "keep" ? "scratch" : "keep";
      return enqueue(() => setStatus(note.filename, next))
        .then((updated) => {
          const s = sessionRef.current;
          if (s.filename === note.filename) {
            s.status = updated.status;
            s.filename = updated.filename;
            setComposeStatus(updated.status);
            setOpenFilename(updated.filename);
          }
          refreshCurrent();
          refreshTags();
          return updated;
        })
        .catch((e) => {
          flash(String(e));
          return null;
        });
    },
    [enqueue, flash, refreshCurrent, refreshTags],
  );

  const handleDelete = useCallback(
    (filename: string): Promise<boolean> =>
      enqueue(() => deleteNote(filename))
        .then(() => {
          // Deleting the open note must not let a flush bring it back.
          if (sessionRef.current.filename === filename) {
            startSession(blankSession(sessionRef.current.status), "", null, null, false);
          }
          flash("ゴミ箱に移動しました");
          refreshCurrent();
          refreshTags();
          return true;
        })
        .catch((e) => {
          flash(String(e));
          return false;
        }),
    [enqueue, startSession, refreshCurrent, refreshTags, flash],
  );

  // Triage files notes in one direction each: scratch → keep, and back
  // again only to undo.
  const triageKeep = useCallback(
    (note: NoteSummary) =>
      (note.status === "scratch" ? handleToggleStatus(note) : Promise.resolve(null)).then(
        (moved) => (moved ? toSummary(moved) : null),
      ),
    [handleToggleStatus],
  );
  const triageUnkeep = useCallback(
    (note: NoteSummary) =>
      (note.status === "keep" ? handleToggleStatus(note) : Promise.resolve(null)).then(
        (moved) => (moved ? toSummary(moved) : null),
      ),
    [handleToggleStatus],
  );

  const handleRenameTag = useCallback(
    (from: string, to: string): Promise<string | null> => {
      // Save the open note first and rename through the same queue, so the
      // rewrite never races an autosave of the note being edited.
      flushDraft();
      return enqueue(() => renameTag(from, to))
        .then((count) => {
          const target = to.trim().replace(/^#+/, "");
          flash(`#${from} → #${target}（${count}件のメモを更新）`);
          if (queryRef.current.trim() === `#${from}`) setQuery(`#${target}`);
          refreshTags();
          refreshCurrent();
          checkExternalChange(); // pull the rewritten text into an open note
          return null;
        })
        .catch((e) => {
          console.error("rename_tag failed", e);
          return String(e);
        });
    },
    [flushDraft, enqueue, flash, refreshTags, refreshCurrent, checkExternalChange],
  );

  // ---------- window drag (no title bar) ----------

  // Only the strip along the top of each screen (`data-drag-region`) moves
  // the window, and it does so right away, like a real title bar. Anywhere
  // else — list rows, the scrollbar, the toolbar — a press is just a press;
  // an earlier "hold anywhere to drag" version turned ordinary clicks on
  // search results into window drags. Controls inside the strip (the search
  // box, filter chips, buttons) keep their own meaning.
  const onWindowMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (!target.closest("[data-drag-region]")) return;
    if (target.closest('textarea, input, select, a, button, [contenteditable="true"]')) return;
    e.preventDefault();
    getCurrentWindow().startDragging().catch(() => {});
  }, []);

  // ---------- keyboard ----------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    const action = actionFor(e.nativeEvent, keymap);
    if (action === "toggleSearch") {
      e.preventDefault();
      setView((v) => (v === "search" ? "compose" : "search"));
      return;
    }
    if (action === "openSettings") {
      e.preventDefault();
      setView((v) => (v === "settings" ? "compose" : "settings"));
      return;
    }
    if (action === "reopenPrevious") {
      e.preventDefault();
      if (view === "compose") reopenPrevious();
      return;
    }
    if (action === "openTutorial") {
      e.preventDefault();
      setView((v) => (v === "tutorial" ? "compose" : "tutorial"));
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (view === "tutorial") {
        setView("compose");
      } else if (view === "triage" || view === "review") {
        setView("search");
      } else if (view === "search" || view === "settings") {
        setView("compose");
      } else if (openFilename !== null) {
        // Back to a blank note; the open one's edits are flushed, not lost.
        resetToBlank();
      } else {
        hideWindow();
      }
    }
  };

  return (
    // The compose screen's chrome is tinted by which status is live, so
    // editing the wrong one is obvious at a glance rather than only
    // discoverable by reading the small switch. Search/settings stay neutral
    // — there's no single "current status" while browsing.
    <div
      className="app"
      data-status={view === "compose" ? composeStatus : view === "triage" ? "scratch" : view === "review" ? "keep" : undefined}
      onKeyDown={onKeyDown}
      onMouseDown={onWindowMouseDown}
    >
      {view === "compose" && (
        <ComposeBox
          value={composeBody}
          onChange={setBody}
          status={composeStatus}
          onStatusChange={handleComposeStatusChange}
          onSaveDraft={saveDraft}
          onSaveAndClose={saveAndClose}
          onSaveAndHide={saveAndHide}
          openTitle={openTitle}
          loadToken={loadToken}
          pendingSelection={pendingSelection}
          onTagClick={searchForTag}
          indentWidth={settings?.indentWidth ?? 4}
          allTags={completionTags}
          handleRef={composeHandle}
          noteTitles={noteTitles}
          onOpenNote={openNoteByTitle}
          backlinks={noteBacklinks}
          onOpenBacklink={openNoteInCompose}
          onOpenTutorial={() => setView("tutorial")}
          onOpenSearch={() => setView("search")}
          onOpenSettings={() => setView("settings")}
          keymap={keymap}
          previousTitle={previousNote?.title ?? null}
          onReopenPrevious={reopenPrevious}
          onNewNote={resetToBlank}
        />
      )}

      {view === "search" && (
        <SearchView
          notes={notes}
          tags={tags}
          query={query}
          onQueryChange={setQuery}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          onOpenSettings={() => setView("settings")}
          keymap={keymap}
          onClose={() => setView("compose")}
          expiringCount={expiringCount}
          onOpenTriage={() => setView("triage")}
          onOpenNote={openNoteInCompose}
          onToggleStatus={handleToggleStatus}
          onTogglePin={handleTogglePin}
          onDelete={handleDelete}
          onRenameTag={handleRenameTag}
        />
      )}

      {view === "tutorial" && <Tutorial onClose={() => setView("compose")} />}

      {view === "triage" && (
        <TriageView
          onKeep={triageKeep}
          onUnkeep={triageUnkeep}
          onTrash={handleDelete}
          onOpen={openNoteInCompose}
          onExit={() => setView("search")}
        />
      )}

      {view === "review" && importReport && (
        <FormatReview
          report={importReport.report}
          onOpen={(note) => openNoteInCompose(toSummary(note))}
          // Imported notes keep their old dates, so they sit far down the
          // list — open it on just them when they carry the import tag.
          onExit={() => (importReport.tagged ? searchForTag("取り込み") : setView("search"))}
        />
      )}

      {view === "settings" && settings && (
        <SettingsPanel
          settings={settings}
          onImported={(report, options) => {
            setImportReport({ report, tagged: options.importTag });
            setView("review");
          }}
          onClose={() => setView("compose")}
          onSaved={(next) => {
            setSettingsState(next);
            setView("compose");
          }}
        />
      )}

      <div className="status">
        <span title={view === "search" ? "一覧に出ているメモの合計（改行は数えません）" : undefined}>
          {view === "search"
            ? `${notes.length.toLocaleString()} 件 ・ ${totalChars.toLocaleString()} 字`
            : ""}
        </span>
        {update && (
          <button type="button" className="status-update" onClick={startUpdate} disabled={installing}>
            {installing ? "更新中…" : `v${update.version} に更新`}
          </button>
        )}
        <span className="status-right">{toast ?? ""}</span>
      </div>
    </div>
  );
}
