import { history, historyKeymap, standardKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldKeymap, HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import {
  autoCodeLanguage,
  dedentClosingFence,
  fullwidthHeadings,
  linkTailEnter,
  listBackspace,
  listEnter,
  livePreview,
  type LivePreviewHandlers,
  pairedMarkDelete,
} from "./livePreview";

/** Token colours for code inside fenced blocks only. Markdown's own tokens
 *  (headings, emphasis, links…) are styled by the live-preview decorations,
 *  so they are deliberately absent here. Colours live in styles.css. */
const codeHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: "tok-keyword" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.attributeValue], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: "tok-number" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName, t.standard(t.variableName)],
    class: "tok-function",
  },
  { tag: [t.special(t.variableName), t.labelName], class: "tok-def" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], class: "tok-type" },
  { tag: [t.propertyName, t.attributeName], class: "tok-property" },
  { tag: [t.definition(t.variableName), t.self], class: "tok-def" },
  { tag: [t.meta, t.annotation], class: "tok-meta" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    fontSize: "14px",
    lineHeight: "1.6",
    overflowX: "hidden",
  },
  ".cm-content": { padding: "4px 0 24px", caretColor: "var(--text)" },
  ".cm-line": { padding: "0 2px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--editor-selection) !important" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-foldPlaceholder": {
    margin: "0 6px",
    padding: "0 6px",
    fontSize: "0.7em",
    verticalAlign: "middle",
    color: "var(--muted)",
    backgroundColor: "var(--code-bg)",
    border: "1px solid var(--line)",
    borderRadius: "4px",
  },
});

/** Info strings that mean "no highlighting" — the fuzzy name match would
 *  otherwise turn `text` into LaTeX. */
const PLAIN_TEXT = new Set(["text", "txt", "plain", "plaintext", "none"]);
/** Common names CodeMirror's language list doesn't know as names. */
const EXTRA_ALIASES: Record<string, string> = {
  golang: "go",
  pwsh: "powershell",
  ps: "powershell",
  py3: "python",
  node: "javascript",
};

/** The language for a code block's info string: a name or alias (`python`,
 *  `js`), else a file extension (`py`, `rs`, `ps1`, `kt`, `md`). */
function findCodeLanguage(info: string): LanguageDescription | null {
  const raw = info.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!raw || PLAIN_TEXT.has(raw)) return null;
  const name = EXTRA_ALIASES[raw] ?? raw;
  return (
    LanguageDescription.matchLanguageName(languages, name, false) ??
    LanguageDescription.matchFilename(languages, `file.${name}`) ??
    LanguageDescription.matchLanguageName(languages, name, true)
  );
}

/** The Markdown parser exactly as Rmemo configures it (also used by tests). */
export function markdownSupport(): Extension {
  return markdown({
    base: markdownLanguage,
    // Enter is a plain newline except inside lists/quotes (see `listEnter`).
    addKeymap: false,
    codeLanguages: findCodeLanguage,
    // Setext headings (`text` over `---`) would turn a line into a heading
    // just because a rule was drawn under it; indented code would turn
    // Ctrl+] indentation into code. Neither matches how Rmemo is written.
    extensions: [{ remove: ["SetextHeading", "IndentedCode"] }],
  });
}

/** The Markdown look on its own — shared by the editor and the read-only
 *  note view (triage screen), so a note looks the same in both. */
export function markdownPreview(handlers: () => LivePreviewHandlers): Extension {
  return [
    EditorView.lineWrapping,
    markdownSupport(),
    syntaxHighlighting(codeHighlight),
    livePreview(handlers),
    theme,
  ];
}

export function readOnlyExtensions(handlers: () => LivePreviewHandlers): Extension {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false), markdownPreview(handlers)];
}

export function editorExtensions(handlers: () => LivePreviewHandlers, extraKeys: Extension): Extension {
  return [
    extraKeys,
    history(),
    drawSelection(),
    // VSCode-style multiple cursors: Alt+click adds a cursor (Ctrl+click is
    // taken by links/tags), Shift+Alt+drag selects a column, and other
    // occurrences of the selection are highlighted (for Ctrl+D).
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey && !e.shiftKey),
    rectangularSelection({ eventFilter: (e) => e.altKey && e.shiftKey }),
    highlightSelectionMatches(),
    placeholder("なにか書く…"),
    keymap.of([
      { key: "Enter", run: linkTailEnter },
      { key: "Enter", run: listEnter },
      { key: "Backspace", run: (v) => pairedMarkDelete(v, false) },
      { key: "Backspace", run: listBackspace },
      { key: "Delete", run: (v) => pairedMarkDelete(v, true) },
      ...foldKeymap,
      ...standardKeymap,
      ...historyKeymap,
    ]),
    markdownPreview(handlers),
    // Heading sections fold from the ▾ beside each heading (livePreview) or
    // Ctrl+Shift+[ / ]; Ctrl+Alt+[ / ] fold / unfold everything.
    codeFolding({ placeholderText: "…" }),
    fullwidthHeadings,
    autoCodeLanguage,
    dedentClosingFence,
  ];
}
