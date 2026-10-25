import { EditorSelection, EditorState, type Extension, Prec, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { platform } from "../platform";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { NoteSummary, Status, TagCount } from "../api";
import { selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { copyLineDown, copyLineUp, moveLineDown, moveLineUp } from "@codemirror/commands";
import {
  applyLink,
  type CodeLangTarget,
  codeLangTarget,
  demoteHeadingOnBackspace,
  indentLines,
  type LinkTarget,
  listIndent,
  linkTarget,
  type LivePreviewHandlers,
  setCodeLang,
  setHeading,
  toggleInline,
} from "../editor/livePreview";
import { editorExtensions } from "../editor/setup";
import {
  charCount,
  codeMask,
  extractTags,
  headingLevelOfLine,
  isTagChar,
  outlineOf,
} from "../markdown";
import TableOfContents from "./TableOfContents";
import { type ActionId, actionFor, formatCombo, type Keymap, withKey } from "../keybindings";

/** What App can ask of the editor without reaching into its DOM. */
export interface ComposeHandle {
  selection(): { start: number; end: number } | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  status: Status;
  /** Called for both the button click and Ctrl+L — App decides whether that
   *  means "change what a new note will be saved as" or "move an already
   *  saved note right now", depending on whether one is open. */
  onStatusChange: (status: Status) => void;
  onSaveDraft: () => void;
  onSaveAndClose: () => void;
  /** Save, then hide the window — the note stays open for next time. */
  onSaveAndHide: () => void;
  /** Title of the note currently open for editing, or null for a fresh one. */
  openTitle: string | null;
  /** Bumped by App every time it loads a (possibly different) note in —
   *  including the initial mount — so the caret always lands somewhere
   *  sensible without the effect depending on the value itself. */
  loadToken: number;
  pendingSelection: { start: number; end: number } | null;
  /** Jumps to the search screen pre-filtered to this tag — same topic-pivot
   *  a tag pill in the search results list offers. */
  onTagClick: (tag: string) => void;
  /** Spaces per indent level for Ctrl+]/Ctrl+[. */
  indentWidth: number;
  /** Existing tags offered as completions after typing `#`, most used first. */
  allTags: TagCount[];
  /** Every note's title — `[[` completion and whether a `[[link]]` resolves. */
  noteTitles: string[];
  /** Ctrl+click on `[[title]]`: open that note (or start it if missing). */
  onOpenNote: (title: string) => void;
  /** Notes linking here with `[[this title]]`. */
  backlinks: NoteSummary[];
  onOpenBacklink: (note: NoteSummary) => void;
  onOpenTutorial: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  /** The open note's earlier versions (only offered while one is open). */
  onOpenHistory: () => void;
  /** The shortcuts as currently bound (settings → キー設定). */
  keymap: Keymap;
  /** Title of the note that was open before this blank one, if any. */
  previousTitle: string | null;
  onReopenPrevious: () => void;
  /** Closes the open note into a blank one (the same as Esc). */
  onNewNote: () => void;
  handleRef?: React.MutableRefObject<ComposeHandle | null>;
}

/** Every matching tag / note title is offered, but the popup draws them a
 *  page at a time: the next page as the list scrolls near its end. */
const SUGGEST_PAGE = 30;

/** One row of the completion popup — a tag or a note title. */
interface Suggestion {
  /** What gets inserted. */
  value: string;
  label: string;
  /** Notes using the tag (tags only). */
  count?: number;
}

/** The `[[title` being typed at `caret`, if any: `hash` is the position of
 *  the `[[`. Never inside code. */
function wikiTrigger(
  value: string,
  mask: Uint8Array,
  caret: number,
): { kind: "wiki"; hash: number; partial: string; closeAt: number | null; full: string } | null {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const m = /\[\[([^[\]]*)$/.exec(value.slice(lineStart, caret));
  if (!m) return null;
  const hash = caret - m[0].length;
  if (mask[hash]) return null;
  // The caret may be inside a link that's already complete (`[[買|い物]]`):
  // then the whole name up to `]]` is what a suggestion replaces.
  const after = /^[^[\]\n]*\]\]/.exec(value.slice(caret));
  const closeAt = after ? caret + after[0].length - 2 : null;
  const full = closeAt === null ? m[1] : value.slice(hash + 2, closeAt);
  return { kind: "wiki", hash, partial: m[1], closeAt, full };
}

/** The `#tag` being typed at `caret`, if any: the caret sits at the end of a
 *  run of tag characters directly preceded by a `#` that starts a word —
 *  the same rule `extractTags` uses to recognise a tag. `partial` may be
 *  empty (just typed `#`). Never inside code, where `#` isn't a tag. */
function tagTrigger(
  value: string,
  mask: Uint8Array,
  caret: number,
): { kind: "tag"; hash: number; partial: string } | null {
  let i = caret;
  while (i > 0 && isTagChar(value[i - 1])) i--;
  if (i === 0 || value[i - 1] !== "#") return null;
  const hash = i - 1;
  if (mask[hash]) return null;
  if (hash > 0 && isTagChar(value[hash - 1])) return null;
  if (caret < value.length && isTagChar(value[caret])) return null;
  return { kind: "tag", hash, partial: value.slice(i, caret) };
}

/** Case-insensitive occurrences of `query` in `value`, for the in-note find
 *  bar's match count. */
function countMatches(value: string, query: string): number {
  if (!query) return 0;
  const hay = value.toLowerCase();
  const needle = query.toLowerCase();
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = hay.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** First case-insensitive match of `query` in `hay` at or after `from`,
 *  wrapping to the start if none is found there. */
function findNext(hay: string, from: number, query: string): number | null {
  if (!query) return null;
  const h = hay.toLowerCase();
  const needle = query.toLowerCase();
  let idx = h.indexOf(needle, from);
  if (idx === -1) idx = h.indexOf(needle, 0);
  return idx === -1 ? null : idx;
}

/** Last case-insensitive match of `query` in `hay` at or before `before`,
 *  wrapping to the end if none is found there. */
function findPrev(hay: string, before: number, query: string): number | null {
  if (!query) return null;
  const h = hay.toLowerCase();
  const needle = query.toLowerCase();
  let idx = h.lastIndexOf(needle, before);
  if (idx === -1) idx = h.lastIndexOf(needle);
  return idx === -1 ? null : idx;
}

/** Replaces every case-insensitive occurrence of `query` with `replacement`. */
function replaceAllOccurrences(
  value: string,
  query: string,
  replacement: string,
): { newValue: string; count: number } {
  if (!query) return { newValue: value, count: 0 };
  const hay = value.toLowerCase();
  const needle = query.toLowerCase();
  let result = "";
  let cursor = 0;
  let count = 0;
  let idx = hay.indexOf(needle, cursor);
  while (idx !== -1) {
    result += value.slice(cursor, idx) + replacement;
    cursor = idx + query.length;
    count++;
    idx = hay.indexOf(needle, cursor);
  }
  result += value.slice(cursor);
  return { newValue: result, count };
}

/** Narrower than this, the table of contents folds into a hover rail. */
const TOC_PANEL_MIN = 700;

/** `2026-10-19`, or `2026-10-19 14:05` with the time. */
function formatNow(withTime: boolean): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}` : date;
}

/** Suggestions for a code block's language (any name the highlighter knows works). */
const CODE_LANGS = [
  "js", "ts", "tsx", "jsx", "json", "html", "css", "python", "rust", "go", "java", "c", "cpp",
  "csharp", "sql", "bash", "powershell", "yaml", "toml", "markdown", "diff",
];

const HEADING_BUTTONS = [
  { level: 0, label: "本文", title: "本文に戻す", action: "heading0" },
  { level: 1, label: "H1", title: "見出し1", action: "heading1" },
  { level: 2, label: "H2", title: "見出し2", action: "heading2" },
  { level: 3, label: "H3", title: "見出し3", action: "heading3" },
  { level: 4, label: "H4", title: "見出し4", action: "heading4" },
] as const;

/** The toolbar's shortcut cheat line, as currently bound. */
const HINT: [ActionId, string][] = [
  ["find", "ノート内検索"],
  ["replace", "置換"],
  ["toggleSearch", "検索"],
  ["reopenPrevious", "前回のメモ"],
  ["toggleStatus", "切替"],
  ["openSettings", "設定"],
  ["openTutorial", "使い方"],
  ["heading1", "見出し1"],
  ["insertDate", "日付"],
  ["bold", "太字"],
  ["italic", "斜体"],
  ["code", "コード"],
  ["link", "リンク"],
  ["selectNext", "複数カーソル"],
  ["indent", "インデント"],
  ["moveLineUp", "行を上へ"],
  ["copyLineUp", "行を上へ複製"],
];

function hint(keymap: Keymap): string {
  return HINT.filter(([id]) => keymap[id])
    .map(([id, label]) => `${formatCombo(keymap[id])} ${label}`)
    .concat(["Alt+クリック 複数カーソル", "Ctrl+クリック リンク/タグ"])
    .join(" ・ ");
}

/**
 * The whole point of this screen: writing. Enter is a plain newline — saving
 * is Ctrl+S (draft) or Ctrl+Enter (save and start a new note) only. The draft is never
 * cleared by anything other than App explicitly deciding to reset it; hiding
 * the window does not touch it (Tauri's `hide()` preserves DOM state).
 *
 * The editor is CodeMirror with a Markdown live preview (see
 * `editor/livePreview.ts`): `value` is always the exact file text, the
 * headings/emphasis/links are only drawn that way.
 */
export default function ComposeBox({
  value,
  onChange,
  status,
  onStatusChange,
  onSaveDraft,
  onSaveAndClose,
  onSaveAndHide,
  openTitle,
  loadToken,
  pendingSelection,
  onTagClick,
  indentWidth,
  allTags,
  noteTitles,
  onOpenNote,
  backlinks,
  onOpenBacklink,
  onOpenTutorial,
  onOpenSearch,
  onOpenSettings,
  onOpenHistory,
  keymap,
  previousTitle,
  onReopenPrevious,
  onNewNote,
  handleRef,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The last text this editor reported via onChange (or was loaded with) —
   *  lets the `value` sync below tell App echoing our own edit back apart
   *  from App replacing the text. */
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const handlersRef = useRef({
    onTagClick,
    onOpenUrl: (url: string) => platform().openUrl(url),
  });
  handlersRef.current.onTagClick = onTagClick;
  const titleSet = useMemo(() => new Set(noteTitles.map((t) => t.toLowerCase())), [noteTitles]);
  Object.assign(handlersRef.current as LivePreviewHandlers, {
    onEditCodeLang: (pos: number) => openLang(pos),
    onLinkClick: () => openLinkTip(),
    onOpenNote,
    noteExists: (title: string) => titleSet.has(title.toLowerCase()),
  });
  const keyHandlerRef = useRef<(e: KeyboardEvent, view: EditorView) => boolean>(() => false);

  const mask = useMemo(() => codeMask(value), [value]);
  // A live preview only — the file on disk is always re-tagged from its
  // actual saved body by the backend, this never has to stay in sync with it.
  const liveTags = useMemo(() => extractTags(value), [value]);
  const outline = useMemo(() => outlineOf(value, mask), [value, mask]);

  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  /** Bumped on editor scroll, so the popup/TOC re-read positions. */
  const [scrollTick, setScrollTick] = useState(0);

  // ---------- editor lifecycle ----------

  // Built once: every callback inside reads the latest props through refs.
  const extensionsRef = useRef<Extension | null>(null);
  const getExtensions = () =>
    (extensionsRef.current ??= editorExtensions(() => handlersRef.current, [
      Prec.highest(
        EditorView.domEventHandlers({ keydown: (e, view) => keyHandlerRef.current(e, view) }),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const next = u.state.doc.toString();
          lastEmitted.current = next;
          onChangeRef.current(next);
        }
        if (u.docChanged || u.selectionSet) {
          const m = u.state.selection.main;
          setSel({ start: m.from, end: m.to });
        }
        if (u.focusChanged) setFocused(u.view.hasFocus);
      }),
    ]));

  const makeState = (doc: string, selection: { start: number; end: number } | null) => {
    const clamp = (n: number) => Math.min(Math.max(0, n), doc.length);
    return EditorState.create({
      doc,
      selection: selection
        ? EditorSelection.single(clamp(selection.start), clamp(selection.end))
        : EditorSelection.single(0),
      extensions: getExtensions(),
    });
  };

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: makeState(value, null) });
    viewRef.current = view;
    const onScroll = () => setScrollTick((t) => t + 1);
    view.scrollDOM.addEventListener("scroll", onScroll);
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A (possibly different) note was loaded: fresh document, fresh undo
  // history, caret where App asked for it. Only `loadToken` should
  // re-trigger this — it changes exactly when App wants that, unlike
  // `value` which changes every keystroke.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setState(makeState(value, pendingSelection));
    lastEmitted.current = value;
    const m = view.state.selection.main;
    setSel({ start: m.from, end: m.to });
    view.focus();
    view.dispatch({ effects: EditorView.scrollIntoView(m.head, { y: "center" }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadToken]);

  // App changed the text without a reload (rare) — mirror it, outside undo.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmitted.current) return;
    lastEmitted.current = value;
    if (value === view.state.doc.toString()) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    });
  }, [value]);

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      selection: () => {
        const m = viewRef.current?.state.selection.main;
        return m ? { start: m.from, end: m.to } : null;
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // Programmatic edits (indent/outdent/move-line/replace/tag completion) are
  // one transaction each, so Ctrl+Z reverts them in one step. Only the span
  // that actually differs is replaced, keeping the undo step tight. Works
  // without focus too (replace clicked from the find bar).
  const applyEdit = (edit: { newValue: string; newStart: number; newEnd: number } | null) => {
    if (!edit) return;
    const view = viewRef.current;
    if (!view) {
      onChange(edit.newValue);
      return;
    }
    const old = view.state.doc.toString();
    const next = edit.newValue;
    let prefix = 0;
    const maxPrefix = Math.min(old.length, next.length);
    while (prefix < maxPrefix && old[prefix] === next[prefix]) prefix++;
    let suffix = 0;
    const maxSuffix = maxPrefix - prefix;
    while (suffix < maxSuffix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) {
      suffix++;
    }
    view.dispatch({
      changes:
        old === next
          ? undefined
          : { from: prefix, to: old.length - suffix, insert: next.slice(prefix, next.length - suffix) },
      selection: EditorSelection.single(edit.newStart, edit.newEnd),
      scrollIntoView: true,
      userEvent: "input",
    });
  };

  // ---------- in-note find & replace (Ctrl+F / Ctrl+H) ----------
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceText, setReplaceText] = useState("");
  const findAnchor = useRef(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  // Shared by both find and replace inputs — only one can be composing at a
  // time, so one ref is enough to guard both against IME's confirming Enter
  // being misread as "jump to match".
  const findComposing = useRef(false);
  const matchCount = useMemo(() => countMatches(value, findQuery), [value, findQuery]);

  // The editor draws its own selection even when unfocused, so the match is
  // revealed without moving focus off the find/replace input. (Bouncing
  // focus to the editor and back is unreliable in WebView2 — the two focus()
  // calls cross a native message-pump boundary and focus could get stuck in
  // the editor, swallowing every keystroke after the first live-search hit.)
  const jumpTo = (idx: number, length: number) => {
    viewRef.current?.dispatch({
      selection: EditorSelection.single(idx, idx + length),
      effects: EditorView.scrollIntoView(idx, { y: "center" }),
    });
  };

  const jumpForward = (from: number, query: string, hay: string = value) => {
    const idx = findNext(hay, from, query);
    if (idx !== null) jumpTo(idx, query.length);
  };

  const jumpBackward = (before: number, query: string, hay: string = value) => {
    const idx = findPrev(hay, before, query);
    if (idx !== null) jumpTo(idx, query.length);
  };

  // Live search: re-run from the caret position captured when the bar was
  // opened, not from the last match — otherwise every keystroke would chase
  // whatever the previous, shorter query happened to land on. Skipped
  // mid-IME composition so it doesn't act on a not-yet-committed query.
  useEffect(() => {
    if (!findOpen || !findQuery || findComposing.current) return;
    jumpForward(findAnchor.current, findQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, findOpen]);

  const openFind = (withReplace: boolean) => {
    if (!findOpen) {
      findAnchor.current = viewRef.current?.state.selection.main.from ?? 0;
      setFindQuery("");
      setFindOpen(true);
    }
    if (withReplace) setReplaceOpen(true);
    requestAnimationFrame(() => (withReplace ? replaceInputRef : findInputRef).current?.select());
  };

  const closeFind = () => {
    setFindOpen(false);
    viewRef.current?.focus();
  };

  type KeyLike = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code" | "preventDefault">;

  // Ctrl+F/Ctrl+H are handled identically from the editor and from inside
  // the find/replace inputs themselves — without this, a second Ctrl+F press
  // while focus was already in the find box fell through to the browser's
  // own find-in-page instead of being caught here.
  const handleFindHotkeys = (e: KeyLike): boolean => {
    const action = actionFor(e, keymap);
    if (action === "find") {
      e.preventDefault();
      if (findOpen) closeFind();
      else openFind(false);
      return true;
    }
    if (action === "replace") {
      e.preventDefault();
      openFind(true);
      return true;
    }
    return false;
  };

  // Replaces the current match and advances to the next one. If the caret
  // isn't already sitting on a match (nothing jumped to yet), the first
  // press just jumps there instead of blindly overwriting the selection —
  // same "reveal, then act" two-step VSCode's Replace button uses.
  const replaceCurrent = () => {
    const view = viewRef.current;
    if (!view || !findQuery) return;
    const { from: selStart, to: selEnd } = view.state.selection.main;
    const selected = value.slice(selStart, selEnd);
    if (selected.toLowerCase() !== findQuery.toLowerCase()) {
      jumpForward(findAnchor.current, findQuery);
      return;
    }
    const newValue = value.slice(0, selStart) + replaceText + value.slice(selEnd);
    const newPos = selStart + replaceText.length;
    applyEdit({ newValue, newStart: newPos, newEnd: newPos });
    jumpForward(newPos, findQuery, newValue);
  };

  const replaceAll = () => {
    if (!findQuery) return;
    const { newValue, count } = replaceAllOccurrences(value, findQuery, replaceText);
    if (count === 0) return;
    applyEdit({ newValue, newStart: 0, newEnd: 0 });
  };

  // ---------- `#` tag completion ----------
  // Typing `#` (optionally followed by the start of a name) offers the tags
  // already in use, so the same topic doesn't splinter into near-duplicate
  // tags you forgot you had. Prefix matches first, then substring matches,
  // each group most-used first (the order `allTags` arrives in).
  const containerRef = useRef<HTMLDivElement>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  /** `#` position whose popup was closed (Esc / accepted) — stays closed
   *  until the caret leaves that tag. */
  const [dismissedHash, setDismissedHash] = useState<number | null>(null);
  const [popupPos, setPopupPos] = useState<React.CSSProperties | null>(null);

  // `[[` offers note titles the same way (see "note links" below).
  const trigger =
    sel.start === sel.end
      ? (wikiTrigger(value, mask, sel.start) ?? tagTrigger(value, mask, sel.start))
      : null;

  const suggestions = useMemo((): Suggestion[] => {
    if (!trigger || !focused || trigger.hash === dismissedHash) return [];
    const p = trigger.partial.toLowerCase();
    const items: Suggestion[] =
      trigger.kind === "tag"
        ? allTags.map((t) => ({ value: t.tag, label: `#${t.tag}`, count: t.count }))
        : noteTitles
            .filter((t) => t !== openTitle)
            .map((t) => ({ value: t, label: t }));
    const prefix: Suggestion[] = [];
    const contains: Suggestion[] = [];
    for (const it of items) {
      const lower = it.value.toLowerCase();
      if (lower.startsWith(p)) prefix.push(it);
      else if (lower.includes(p)) contains.push(it);
    }
    const list = [...prefix, ...contains];
    // Already typed in full and nothing longer to offer: nothing to say.
    if (list.length === 1 && list[0].value === trigger.partial) return [];
    // Caret resting in a finished link that already names an existing
    // note: nothing to complete — don't pop up just because it's there.
    if (
      trigger.kind === "wiki" &&
      trigger.closeAt !== null &&
      items.some((it) => it.value.toLowerCase() === trigger.full.trim().toLowerCase())
    ) {
      return [];
    }
    return list;
  }, [trigger?.kind, trigger?.hash, trigger?.partial, trigger?.kind === "wiki" ? trigger.full : "", focused, dismissedHash, allTags, noteTitles, openTitle]);

  const open = suggestions.length > 0;

  // How many rows the popup draws so far (see SUGGEST_PAGE). Back to one
  // page whenever the typed name changes.
  const [suggestShown, setSuggestShown] = useState(SUGGEST_PAGE);
  // The arrow keys may move past the drawn rows (or wrap to the last one):
  // those rows are drawn too.
  const drawnSuggestions = suggestions.slice(0, Math.max(suggestShown, suggestIndex + 1));
  const onSuggestScroll = (e: React.UIEvent<HTMLUListElement>) => {
    const list = e.currentTarget;
    if (drawnSuggestions.length < suggestions.length && list.scrollTop + list.clientHeight >= list.scrollHeight - 48) {
      setSuggestShown(drawnSuggestions.length + SUGGEST_PAGE);
    }
  };

  // The popup scrolls; keep the highlighted row in view as the arrow keys
  // move it. Only the popup scrolls — not the editor behind it, as
  // scrollIntoView might.
  const suggestListRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = suggestListRef.current;
    const row = list?.children[suggestIndex] as HTMLElement | undefined;
    if (!list || !row) return;
    const pad = 4; // the list's own padding
    if (row.offsetTop < list.scrollTop + pad) {
      list.scrollTop = row.offsetTop - pad;
    } else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight - pad) {
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + pad;
    }
  }, [suggestIndex, suggestions, popupPos]);

  useEffect(() => {
    setSuggestIndex(0);
    setSuggestShown(SUGGEST_PAGE);
    if (dismissedHash !== null && trigger?.hash !== dismissedHash) setDismissedHash(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger?.hash, trigger?.partial]);

  // Anchor the popup just under the caret, flipping above it when there's
  // no room below, and kept inside the compose area horizontally.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const box = containerRef.current;
    const c = open && view && trigger ? view.coordsAtPos(trigger.hash) : null;
    if (!c || !box) {
      setPopupPos(null);
      return;
    }
    const b = box.getBoundingClientRect();
    const lineTop = c.top - b.top;
    const left = Math.max(8, Math.min(c.left - b.left, box.clientWidth - 200));
    const below = c.bottom - b.top + 2;
    setPopupPos(
      below + 240 <= box.clientHeight
        ? { left, top: below }
        : { left, bottom: box.clientHeight - lineTop + 2 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, trigger?.hash, value, scrollTick]);

  const acceptSuggestion = (picked: string) => {
    if (!trigger) return;
    let end = sel.start;
    let start: number;
    let insert: string;
    if (trigger.kind === "wiki") {
      start = trigger.hash + 2;
      // Inside a complete link: replace the whole name, keep its `]]`.
      if (trigger.closeAt !== null) end = trigger.closeAt;
      // Close the link unless `]]` is already right there.
      insert = value.startsWith("]]", end) ? picked : `${picked}]]`;
    } else {
      start = trigger.hash + 1;
      const next = value[end];
      // A trailing space ends the tag, so the next word isn't glued onto it.
      insert = next === undefined || !/\s/.test(next) ? `${picked} ` : picked;
    }
    let caret = start + insert.length;
    if (trigger.kind === "wiki" && value.startsWith("]]", end)) caret += 2;
    applyEdit({
      newValue: value.slice(0, start) + insert + value.slice(end),
      newStart: caret,
      newEnd: caret,
    });
    setDismissedHash(trigger.hash);
  };

  /** Keys the open popup claims; returns true when it handled the event. */
  const handleSuggestKeys = (e: KeyboardEvent): boolean => {
    if (!open || !trigger || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setSuggestIndex((i) => (i + step + suggestions.length) % suggestions.length);
      return true;
    }
    // While the popup is showing, Enter always picks the highlighted tag —
    // a newline there would read as the popup ignoring you. (Esc first if a
    // newline is really what you want.)
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      acceptSuggestion(suggestions[suggestIndex].value);
      return true;
    }
    if (e.key === "Escape") {
      // Closing the popup is this Escape's whole job — don't also let App
      // treat it as "leave this note".
      e.preventDefault();
      e.stopPropagation();
      setDismissedHash(trigger.hash);
      return true;
    }
    return false;
  };

  // ---------- character count ----------
  // Line breaks don't count. With a selection (or several) it's the selected
  // text; otherwise the whole note. Recounted only when the text or the
  // selection changes — a few microseconds even for a long note.
  const selectionChars = useMemo(() => {
    const view = viewRef.current;
    if (!view) return 0;
    return view.state.selection.ranges.reduce(
      (n, r) => n + (r.empty ? 0 : charCount(view.state.sliceDoc(r.from, r.to))),
      0,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, sel.start, sel.end]);
  const totalChars = useMemo(() => charCount(value), [value]);

  // ---------- headings: toolbar state and table of contents ----------

  /** Heading level of the caret's line (0 = body text), for the toolbar. */
  const currentLevel = useMemo(() => {
    const lineStart = value.lastIndexOf("\n", sel.start - 1) + 1;
    if (mask[lineStart]) return 0;
    const nl = value.indexOf("\n", lineStart);
    return headingLevelOfLine(value.slice(lineStart, nl === -1 ? value.length : nl));
  }, [value, mask, sel.start]);

  const applyHeading = (level: number) => {
    const view = viewRef.current;
    if (!view) return;
    setHeading(view, level);
    view.focus();
  };

  // The section in view: the last heading scrolled past the top. A note
  // too short to scroll uses the caret's section instead.
  const [activeHeading, setActiveHeading] = useState(-1);
  useEffect(() => {
    const view = viewRef.current;
    let idx = -1;
    if (view && outline.length > 0) {
      const sc = view.scrollDOM;
      if (sc.scrollHeight > sc.clientHeight + 4) {
        const top = sc.scrollTop + 24;
        for (let i = 0; i < outline.length; i++) {
          if (view.lineBlockAt(outline[i].from).top <= top) idx = i;
          else break;
        }
      } else {
        for (let i = 0; i < outline.length; i++) if (outline[i].from <= sel.start) idx = i;
      }
    }
    setActiveHeading(idx);
  }, [outline, scrollTick, sel.start]);

  // The TOC sits beside the text as a panel while there's room; below
  // TOC_PANEL_MIN px of editor width it folds into the slim hover rail.
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const [wideToc, setWideToc] = useState(true);
  useEffect(() => {
    const el = editorAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWideToc(entry.contentRect.width >= TOC_PANEL_MIN));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Narrow window: the heading buttons live in a dropdown (closed by any
  // click outside it).
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false);
  const headingMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!headingMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!headingMenuRef.current?.contains(e.target as Node)) setHeadingMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [headingMenuOpen]);
  useEffect(() => {
    if (wideToc) setHeadingMenuOpen(false);
  }, [wideToc]);

  const jumpToHeading = (from: number) => {
    const view = viewRef.current;
    if (!view) return;
    const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
    view.dispatch({
      selection: EditorSelection.cursor(line.to),
      effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 12 }),
    });
    view.focus();
  };

  // ---------- links (Ctrl+K) ----------
  // A small box under the selection asks for the URL — typing it straight
  // into `[...](...)` would mean typing into text the preview hides.
  const [linkEdit, setLinkEdit] = useState<
    | (LinkTarget & {
        urlInput: string;
        labelInput: string;
        pos: React.CSSProperties;
        /** Editor text and selection when the box opened. */
        openedWith: { doc: string; start: number; end: number };
      })
    | null
  >(null);
  const linkUrlRef = useRef<HTMLInputElement>(null);
  const linkComposing = useRef(false);

  /** Where a box under (or, near the bottom, over) the text at `at` goes. */
  const boxPosAt = (view: EditorView, box: HTMLElement, at: number): React.CSSProperties => {
    const c = view.coordsAtPos(at);
    const b = box.getBoundingClientRect();
    const left = c ? Math.max(8, Math.min(c.left - b.left, box.clientWidth - 490)) : 8;
    const below = c ? c.bottom - b.top + 4 : 40;
    return below + 90 <= box.clientHeight
      ? { left, top: below }
      : { left, bottom: box.clientHeight - (c ? c.top - b.top : 0) + 4 };
  };

  const openedWithNow = (view: EditorView) => {
    const m = view.state.selection.main;
    return { doc: view.state.doc.toString(), start: m.from, end: m.to };
  };

  const openLink = () => {
    const view = viewRef.current;
    const box = containerRef.current;
    if (!view || !box) return;
    setLinkTip(null);
    const target = linkTarget(view.state);
    const pos = boxPosAt(view, box, target.from);
    const openedWith = openedWithNow(view);
    setLinkEdit({ ...target, urlInput: target.url, labelInput: target.label, pos, openedWith });
    requestAnimationFrame(() => linkUrlRef.current?.select());
  };

  // Clicking a link shows a small "編集" bubble under it; 編集 opens the
  // Ctrl+K box on that link.
  const [linkTip, setLinkTip] = useState<{
    url: string;
    pos: React.CSSProperties;
    openedWith: { doc: string; start: number; end: number };
  } | null>(null);

  const openLinkTip = () => {
    const view = viewRef.current;
    const box = containerRef.current;
    if (!view || !box) return;
    const target = linkTarget(view.state);
    if (!target.existing) return;
    setLinkTip({ url: target.url, pos: boxPosAt(view, box, target.from), openedWith: openedWithNow(view) });
  };

  // The text or caret moved under the box (clicked back into the editor,
  // kept typing): its target range may no longer be right, so drop it
  // rather than apply it stale. The bubble goes the same way.
  useEffect(() => {
    for (const [open, close] of [
      [linkEdit, () => setLinkEdit(null)],
      [linkTip, () => setLinkTip(null)],
    ] as const) {
      if (!open) continue;
      const o = open.openedWith;
      if (value !== o.doc || sel.start !== o.start || sel.end !== o.end) close();
    }
  }, [value, sel.start, sel.end, linkEdit, linkTip]);

  // Clicking away from the editor closes the bubble.
  useEffect(() => {
    if (!focused) setLinkTip(null);
  }, [focused]);

  const closeLink = () => {
    setLinkEdit(null);
    viewRef.current?.focus();
  };

  const commitLink = (remove = false) => {
    const view = viewRef.current;
    if (view && linkEdit) applyLink(view, linkEdit, remove ? "" : linkEdit.urlInput, linkEdit.labelInput);
    closeLink();
  };

  const linkKeyDown = (e: React.KeyboardEvent) => {
    if (linkComposing.current || e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeLink();
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitLink();
    }
  };

  // ---------- code block language (click the label) ----------
  const [langEdit, setLangEdit] = useState<
    (CodeLangTarget & { input: string; pos: React.CSSProperties; openedDoc: string }) | null
  >(null);
  const langInputRef = useRef<HTMLInputElement>(null);

  const openLang = (at: number) => {
    const view = viewRef.current;
    const box = containerRef.current;
    if (!view || !box) return;
    const target = codeLangTarget(view.state, at);
    if (!target) return;
    const c = view.coordsAtPos(view.state.doc.lineAt(at).to);
    const b = box.getBoundingClientRect();
    const pos: React.CSSProperties = c
      ? { left: Math.max(8, Math.min(c.left - b.left, box.clientWidth - 250)), top: c.bottom - b.top + 4 }
      : { left: 8, top: 40 };
    setLangEdit({ ...target, input: target.lang, pos, openedDoc: view.state.doc.toString() });
    requestAnimationFrame(() => langInputRef.current?.select());
  };

  useEffect(() => {
    if (langEdit && value !== langEdit.openedDoc) setLangEdit(null);
  }, [value, langEdit]);

  const closeLang = () => {
    setLangEdit(null);
    viewRef.current?.focus();
  };

  const commitLang = () => {
    const view = viewRef.current;
    if (view && langEdit) setCodeLang(view, langEdit, langEdit.input);
    closeLang();
  };

  // ---------- keys ----------

  const insertStamp = (view: EditorView, withTime: boolean) =>
    view.dispatch(view.state.replaceSelection(formatNow(withTime)), { userEvent: "input", scrollIntoView: true });

  keyHandlerRef.current = (e, view) => {
    if (e.isComposing || view.composing) return false;
    if (handleSuggestKeys(e)) return true;
    if (handleFindHotkeys(e)) return true;
    if (e.key === "Escape" && view.state.selection.ranges.length > 1) {
      // Back to a single cursor — not "leave this note", which is what App
      // would do with this Escape.
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ selection: EditorSelection.create([view.state.selection.main]) });
      return true;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey) {
      if (listIndent(view, indentWidth, e.shiftKey ? -1 : 1)) {
        e.preventDefault();
        return true;
      }
      return false;
    }
    const action = actionFor(e, keymap);
    const run: (() => unknown) | undefined = action
      ? ({
          saveDraft: onSaveDraft,
          saveAndNew: onSaveAndClose,
          saveAndHide: onSaveAndHide,
          toggleStatus: () => onStatusChange(status === "keep" ? "scratch" : "keep"),
          bold: () => toggleInline(view, "bold"),
          italic: () => toggleInline(view, "italic"),
          code: () => toggleInline(view, "code"),
          link: openLink,
          selectNext: () => selectNextOccurrence(view),
          selectAllMatches: () => selectSelectionMatches(view),
          insertDate: () => insertStamp(view, false),
          insertDateTime: () => insertStamp(view, true),
          heading0: () => setHeading(view, 0),
          heading1: () => setHeading(view, 1),
          heading2: () => setHeading(view, 2),
          heading3: () => setHeading(view, 3),
          heading4: () => setHeading(view, 4),
          // Line operations act on every cursor / selection, VSCode-style.
          indent: () => indentLines(view, indentWidth, 1),
          outdent: () => indentLines(view, indentWidth, -1),
          moveLineUp: () => moveLineUp(view),
          moveLineDown: () => moveLineDown(view),
          copyLineUp: () => copyLineUp(view),
          copyLineDown: () => copyLineDown(view),
        } as Partial<Record<ActionId, () => unknown>>)[action]
      : undefined;
    if (run) {
      e.preventDefault();
      run();
      return true;
    }
    if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (demoteHeadingOnBackspace(view)) {
        e.preventDefault();
        return true;
      }
    }
    return false;
  };

  return (
    <div className="compose" ref={containerRef}>
      <div className="compose-open-title" data-drag-region>
        <span className="compose-open-title-text">
          {openTitle ? `編集中: ${openTitle}` : "新規メモ"}
        </span>
        {openTitle ? (
          <>
            <button
              type="button"
              className="compose-title-action"
              title="このメモを閉じて新しいメモを書く (Esc)"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onNewNote}
            >
              ＋ 新規
            </button>
            <button
              type="button"
              className="compose-title-action"
              title={withKey("このメモの前の版を見る・戻す", keymap.openHistory)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onOpenHistory}
            >
              履歴
            </button>
          </>
        ) : (
          previousTitle && (
            <button
              type="button"
              className="compose-title-action compose-title-previous"
              title={withKey("前回のメモに戻る", keymap.reopenPrevious)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onReopenPrevious}
            >
              ← 前回: {previousTitle}
            </button>
          )
        )}
        <span className="compose-title-spacer" />
        {wideToc ? (
          <div className="format-bar" role="toolbar" aria-label="見出し">
            {HEADING_BUTTONS.map((b) => (
              <button
                key={b.level}
                type="button"
                className={
                  b.level === currentLevel ? "format-btn format-btn-active" : "format-btn"
                }
                data-level={b.level}
                title={withKey(b.title, keymap[b.action])}
                // Keep the editor's focus and selection through the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyHeading(b.level)}
              >
                {b.label}
              </button>
            ))}
          </div>
        ) : (
          // Narrow window: the five buttons fold into one dropdown showing
          // the current level, so the title keeps the room.
          <div className="format-menu" ref={headingMenuRef}>
            <button
              type="button"
              className="format-btn format-menu-toggle"
              title="見出し"
              aria-haspopup="menu"
              aria-expanded={headingMenuOpen}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setHeadingMenuOpen((o) => !o)}
            >
              {HEADING_BUTTONS.find((b) => b.level === currentLevel)?.label ?? "本文"} ▾
            </button>
            {headingMenuOpen && (
              <ul className="format-menu-list" role="menu">
                {HEADING_BUTTONS.map((b) => (
                  <li key={b.level}>
                    <button
                      type="button"
                      role="menuitem"
                      className={b.level === currentLevel ? "format-menu-item format-menu-item-active" : "format-menu-item"}
                      data-level={b.level}
                      title={withKey(b.title, keymap[b.action])}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        applyHeading(b.level);
                        setHeadingMenuOpen(false);
                      }}
                    >
                      {b.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <button
          type="button"
          className="compose-search-btn"
          title={withKey("メモの一覧・検索", keymap.toggleSearch)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenSearch}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          一覧
        </button>
        <button
          type="button"
          className="format-help"
          title={withKey("エディタの使い方", keymap.openTutorial)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenTutorial}
        >
          ?
        </button>
        <button
          type="button"
          className="gear compose-gear"
          title={withKey("設定", keymap.openSettings)}
          aria-label="設定"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
      <div
        ref={editorAreaRef}
        className={
          outline.length === 0
            ? "compose-editor"
            : wideToc
              ? "compose-editor has-toc-panel"
              : "compose-editor has-toc"
        }
      >
        <div className="compose-editor-host" ref={hostRef} />
        {outline.length > 0 && (
          <TableOfContents
            items={outline}
            active={activeHeading}
            onJump={jumpToHeading}
            mode={wideToc ? "panel" : "rail"}
          />
        )}
      </div>
      {findOpen && (
        <div className="compose-find">
          <div className="compose-find-row">
            <input
              ref={findInputRef}
              type="text"
              className="compose-find-input"
              placeholder="ノート内を検索…"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onCompositionStart={() => {
                findComposing.current = true;
              }}
              onCompositionEnd={() => {
                findComposing.current = false;
              }}
              onKeyDown={(e) => {
                if (findComposing.current || e.nativeEvent.isComposing) return;
                if (handleFindHotkeys(e)) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeFind();
                  return;
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  const pos = viewRef.current?.state.selection.main.from ?? 0;
                  if (e.shiftKey) jumpBackward(pos - 1, findQuery);
                  else jumpForward(pos + 1, findQuery);
                }
              }}
            />
            <span className="compose-find-count">{findQuery ? `${matchCount}件` : ""}</span>
            <button
              type="button"
              className="compose-find-toggle"
              title="置換"
              aria-label="置換"
              onClick={() => setReplaceOpen((o) => !o)}
            >
              {replaceOpen ? "▾" : "▸"}
            </button>
            <button type="button" className="compose-find-close" onClick={closeFind}>
              ×
            </button>
          </div>
          {replaceOpen && (
            <div className="compose-find-row">
              <input
                ref={replaceInputRef}
                type="text"
                className="compose-find-input"
                placeholder="置換後の文字列…"
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onCompositionStart={() => {
                  findComposing.current = true;
                }}
                onCompositionEnd={() => {
                  findComposing.current = false;
                }}
                onKeyDown={(e) => {
                  if (findComposing.current || e.nativeEvent.isComposing) return;
                  if (handleFindHotkeys(e)) return;
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    closeFind();
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.ctrlKey) replaceAll();
                    else replaceCurrent();
                  }
                }}
              />
              <button
                type="button"
                className="compose-find-btn"
                disabled={!findQuery}
                onClick={replaceCurrent}
              >
                置換
              </button>
              <button
                type="button"
                className="compose-find-btn"
                disabled={!findQuery}
                onClick={replaceAll}
              >
                すべて置換
              </button>
            </div>
          )}
        </div>
      )}
      {linkTip && !linkEdit && (
        <div className="link-tip" style={linkTip.pos} onMouseDown={(e) => e.preventDefault()}>
          <span className="link-tip-url" title={linkTip.url}>
            {linkTip.url}
          </span>
          <button type="button" className="compose-find-btn" onClick={openLink}>
            編集
          </button>
        </div>
      )}
      {linkEdit && (
        <div className="link-prompt" style={linkEdit.pos}>
          {(linkEdit.existing || !linkEdit.label) && (
            <input
              type="text"
              className="link-prompt-input"
              placeholder="表示テキスト（空ならURL）"
              value={linkEdit.labelInput}
              onChange={(e) => setLinkEdit({ ...linkEdit, labelInput: e.target.value })}
              onCompositionStart={() => (linkComposing.current = true)}
              onCompositionEnd={() => (linkComposing.current = false)}
              onKeyDown={linkKeyDown}
            />
          )}
          <div className="link-prompt-row">
            <input
              ref={linkUrlRef}
              type="text"
              className="link-prompt-input"
              placeholder="URL を入力して Enter"
              value={linkEdit.urlInput}
              onChange={(e) => setLinkEdit({ ...linkEdit, urlInput: e.target.value })}
              onCompositionStart={() => (linkComposing.current = true)}
              onCompositionEnd={() => (linkComposing.current = false)}
              onKeyDown={linkKeyDown}
            />
            <button
              type="button"
              className="compose-find-btn"
              disabled={!linkEdit.urlInput.trim()}
              onClick={() => commitLink()}
            >
              {linkEdit.existing ? "更新" : "リンク"}
            </button>
            {linkEdit.existing && (
              <button type="button" className="compose-find-btn" onClick={() => commitLink(true)}>
                解除
              </button>
            )}
            <button type="button" className="compose-find-close" onClick={closeLink}>
              ×
            </button>
          </div>
        </div>
      )}
      {langEdit && (
        <div className="link-prompt lang-prompt" style={langEdit.pos}>
          <div className="link-prompt-row">
            <input
              ref={langInputRef}
              type="text"
              className="link-prompt-input"
              placeholder="言語（js, python, rust…）"
              list="rmemo-code-langs"
              value={langEdit.input}
              onChange={(e) => setLangEdit({ ...langEdit, input: e.target.value })}
              onCompositionStart={() => (linkComposing.current = true)}
              onCompositionEnd={() => (linkComposing.current = false)}
              onKeyDown={(e) => {
                if (linkComposing.current || e.nativeEvent.isComposing) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeLang();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  commitLang();
                }
              }}
            />
            <datalist id="rmemo-code-langs">
              {CODE_LANGS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            <button type="button" className="compose-find-btn" onClick={commitLang}>
              変更
            </button>
            <button type="button" className="compose-find-close" onClick={closeLang}>
              ×
            </button>
          </div>
        </div>
      )}
      {open && popupPos && (
        <ul ref={suggestListRef} className="tag-suggest" style={popupPos} role="listbox" onScroll={onSuggestScroll}>
          {drawnSuggestions.map((t, i) => (
            <li
              key={t.value}
              role="option"
              aria-selected={i === suggestIndex}
              className={i === suggestIndex ? "tag-suggest-item tag-suggest-item-active" : "tag-suggest-item"}
              // mousedown, not click, and preventDefault: the editor must
              // keep focus or the popup (and the insert target) would vanish.
              onMouseDown={(e) => {
                e.preventDefault();
                acceptSuggestion(t.value);
              }}
              onMouseEnter={() => setSuggestIndex(i)}
            >
              <span className="tag-suggest-name">{t.label}</span>
              {t.count !== undefined && <span className="tag-count">{t.count}</span>}
            </li>
          ))}
        </ul>
      )}
      {liveTags.length > 0 && (
        <div className="note-tags">
          {liveTags.map((t) => (
            <button key={t} type="button" className="tag-pill" onClick={() => onTagClick(t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
      {backlinks.length > 0 && (
        <div className="note-backlinks">
          <span className="note-backlinks-label">← 参照元</span>
          {backlinks.map((n) => (
            <button
              key={n.filename}
              type="button"
              className="backlink-pill"
              title={`「${n.title}」を開く`}
              onClick={() => onOpenBacklink(n)}
            >
              {n.title}
            </button>
          ))}
        </div>
      )}
      <div className="compose-toolbar">
        <div className="switch" role="group" aria-label="保管 / 一時">
          <button
            type="button"
            className={status === "keep" ? "switch-btn switch-btn-active" : "switch-btn"}
            onClick={() => onStatusChange("keep")}
          >
            保管
          </button>
          <button
            type="button"
            className={status === "scratch" ? "switch-btn switch-btn-active" : "switch-btn"}
            onClick={() => onStatusChange("scratch")}
          >
            一時
          </button>
        </div>
        <span className="compose-count" title="改行は数えません">
          {selectionChars > 0
            ? `選択 ${selectionChars.toLocaleString()} / ${totalChars.toLocaleString()}字`
            : `${totalChars.toLocaleString()}字`}
        </span>
        <span className="compose-hint">{hint(keymap)}</span>
        <div className="compose-actions">
          <button type="button" className="compose-save" onClick={onSaveDraft}>
            {withKey("途中保存", keymap.saveDraft)}
          </button>
          <button type="button" className="compose-save compose-save-primary" onClick={onSaveAndClose}>
            {withKey("保存して新規", keymap.saveAndNew)}
          </button>
        </div>
      </div>
    </div>
  );
}
