// Obsidian-style "live preview" over plain Markdown source: the document is
// always the exact `.md` text, and everything here is decoration — headings
// drawn large, `**` / `[](url)` / `> ` markers hidden, bullets and
// checkboxes drawn, code shaded, links and #tags coloured. Nothing rewrites
// the file except the explicit editing commands at the bottom.

import { deleteMarkupBackward, insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { EditorSelection, EditorState, findClusterBreak, type Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { imageFiles, saveImage } from "../images";
import { platform } from "../platform";
import {
  codeMask,
  findTags,
  findWikiLinks,
  guessLanguage,
  type TagHit,
  type WikiLink,
} from "../markdown";

export interface LivePreviewHandlers {
  onTagClick: (tag: string) => void;
  onOpenUrl: (url: string) => void;
  /** Ctrl+click on `[[title]]`. */
  onOpenNote?: (title: string) => void;
  /** Whether a note with this title exists (missing links are drawn dashed). */
  noteExists?: (title: string) => boolean;
  /** The language label of the code block starting at `pos` was clicked. */
  onEditCodeLang?: (pos: number) => void;
  /** A plain click on a `[label](url)` (the caret is now inside it). */
  onLinkClick?: () => void;
}

/** Each view's handlers, for widgets (which are built without them). */
const viewHandlers = new WeakMap<EditorView, () => LivePreviewHandlers>();

// ---------- widgets ----------

class CopyButton extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(other: CopyButton) {
    return other.code === this.code;
  }
  toDOM() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-code-copy";
    btn.textContent = "コピー";
    btn.title = "コードをコピー";
    // Keep the caret where it is — clicking shouldn't move focus/selection.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      copyText(this.code).then((ok) => {
        btn.textContent = ok ? "コピーしました" : "失敗";
        btn.classList.toggle("cm-code-copy-done", ok);
        setTimeout(() => {
          btn.textContent = "コピー";
          btn.classList.remove("cm-code-copy-done");
        }, 1200);
      });
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}

class LangLabel extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: LangLabel) {
    return other.lang === this.lang;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-code-lang";
    el.textContent = this.lang || "code";
    if (!view.state.readOnly) {
      el.classList.add("cm-code-lang-editable");
      el.title = "クリックで言語を変更";
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        viewHandlers.get(view)?.().onEditCodeLang?.(view.posAtDOM(el));
      });
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** `alt|300` → alt "alt", width 300 (Obsidian's way of sizing an image). */
export function parseImageAlt(raw: string): { alt: string; width: number | null } {
  const m = /^(.*?)\|(\d{1,5})$/.exec(raw);
  return m ? { alt: m[1], width: Number(m[2]) } : { alt: raw, width: null };
}

/** Preset widths offered on hover; "大" is the editor's full width. */
const SIZE_PRESETS: { label: string; title: string; width: (view: EditorView) => number | null }[] = [
  { label: "小", title: "幅 200px", width: () => 200 },
  { label: "中", title: "幅 400px", width: () => 400 },
  { label: "大", title: "エディタの幅いっぱい", width: (view) => Math.floor(view.contentDOM.clientWidth - 8) },
  { label: "原寸", title: "サイズ指定をなくす（ダブルクリックでも）", width: () => null },
];

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly width: number | null,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.width === this.width;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    const url = platform().resolveImage(this.src);
    const missing = () => {
      wrap.textContent = `画像が見つかりません: ${this.src}`;
      wrap.classList.add("cm-image-missing");
    };
    if (!url) {
      missing();
      return wrap;
    }
    const img = document.createElement("img");
    if (typeof url === "string") {
      img.src = url;
    } else {
      // Fetched on demand (web viewer): hold the space until it arrives.
      wrap.classList.add("cm-image-loading");
      url.then(
        (u) => {
          wrap.classList.remove("cm-image-loading");
          if (u) img.src = u;
          else missing();
        },
        () => missing(),
      );
    }
    img.alt = this.alt;
    img.title = this.alt || this.src;
    img.loading = "lazy";
    img.draggable = false;
    if (this.width) {
      img.style.width = `${this.width}px`;
      wrap.classList.add("cm-image-sized");
    }
    img.addEventListener("error", missing);
    wrap.appendChild(img);
    if (view.state.readOnly) return wrap;

    const setWidth = (w: number | null) => setImageWidth(view, view.posAtDOM(wrap), w);

    // Hover: size presets top-right, a drag handle bottom-right.
    const bar = document.createElement("span");
    bar.className = "cm-image-sizes";
    for (const p of SIZE_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = p.label;
      b.title = p.title;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => setWidth(p.width(view)));
      bar.appendChild(b);
    }
    wrap.appendChild(bar);

    const handle = document.createElement("span");
    handle.className = "cm-image-handle";
    handle.title = "ドラッグで大きさを変更";
    const badge = document.createElement("span");
    badge.className = "cm-image-badge";
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = img.getBoundingClientRect().width;
      const maxW = view.contentDOM.clientWidth - 8;
      let w = Math.round(startW);
      wrap.classList.add("cm-image-resizing");
      wrap.appendChild(badge);
      const move = (ev: MouseEvent) => {
        w = Math.round(Math.max(40, Math.min(maxW, startW + ev.clientX - startX)));
        img.style.width = `${w}px`;
        img.style.maxHeight = "none";
        badge.textContent = `${w}px`;
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        wrap.classList.remove("cm-image-resizing");
        badge.remove();
        if (w !== Math.round(startW) || !this.width) setWidth(w);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    wrap.appendChild(handle);

    img.addEventListener("dblclick", (e) => {
      e.preventDefault();
      setWidth(null);
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/** Rewrites the `|width` in the alt text of the image starting at `pos`
 *  (`null` removes it — back to the natural size). An ordinary text edit,
 *  so Ctrl+Z undoes it. */
export function setImageWidth(view: EditorView, pos: number, width: number | null) {
  const { state } = view;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== "Image") continue;
    const marks = n.getChildren("LinkMark");
    if (marks.length < 2) return;
    const from = marks[0].to;
    const to = marks[1].from;
    const { alt } = parseImageAlt(state.sliceDoc(from, to));
    const insert = width ? `${alt}|${width}` : alt;
    if (insert !== state.sliceDoc(from, to)) {
      view.dispatch({ changes: { from, to, insert }, userEvent: "input.resize" });
    }
    return;
  }
}

/** ▾ / ▸ in the margin left of a heading: folds the section under it. */
class FoldToggle extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(other: FoldToggle) {
    return other.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = this.folded ? "cm-fold-toggle cm-fold-toggle-folded" : "cm-fold-toggle";
    el.textContent = this.folded ? "▸" : "▾";
    el.title = this.folded ? "展開 (Ctrl+Shift+])" : "折りたたむ (Ctrl+Shift+[)";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      toggleSectionAt(view, view.posAtDOM(el));
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** The fold currently hiding the section of the heading line at `lineTo`. */
function sectionFold(state: EditorState, lineTo: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineTo, lineTo, (from, to) => {
    if (from === lineTo) found = { from, to };
  });
  return found;
}

/** Folds / unfolds the section under the heading on the line holding `pos`. */
export function toggleSectionAt(view: EditorView, pos: number) {
  const { state } = view;
  const line = state.doc.lineAt(pos);
  const open = sectionFold(state, line.to);
  if (open) {
    view.dispatch({ effects: unfoldEffect.of(open) });
    return;
  }
  const range = foldable(state, line.from, line.to);
  if (range) view.dispatch({ effects: foldEffect.of(range) });
}

/** A whole `[[title]]` drawn as one chip: 📄 + title in a single box, so
 *  the icon and the title can't drift apart (separate borders, a caret
 *  between them, a line break between them). Clicking it opens the note. */
class NoteChip extends WidgetType {
  constructor(
    readonly title: string,
    readonly missing: boolean,
  ) {
    super();
  }
  eq(other: NoteChip) {
    return other.title === this.title && other.missing === this.missing;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.missing ? "cm-wikilink cm-wikilink-missing" : "cm-wikilink";
    el.dataset.note = this.title;
    el.title = noteTooltip(this.title, this.missing);
    const icon = document.createElement("span");
    icon.className = "cm-wikilink-icon";
    icon.textContent = "📄";
    el.append(icon, this.title);
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-task-box";
    box.checked = this.checked;
    box.disabled = view.state.readOnly;
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      toggleTaskAt(view, view.posAtDOM(box));
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;

/** Flips the `[ ]` / `[x]` of the task item on the line holding `pos`. */
export function toggleTaskAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const m = TASK_LINE.exec(line.text);
  if (!m) return;
  const at = line.from + m[1].length;
  view.dispatch({
    changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " },
    userEvent: "input.task",
  });
}

// ---------- decoration building ----------

const hidden = Decoration.replace({});
const markMuted = Decoration.mark({ class: "cm-md-mark" });
/** The title of a `[[note]]` being edited (the caret is at the link). A
 *  click on it still opens the note, as on the chip. */
const wikiEditing = (title: string, missing: boolean) =>
  Decoration.mark({
    class: "cm-wikilink-editing",
    attributes: { "data-note": title, title: noteTooltip(title, missing) },
  });
const noteTooltip = (title: string, missing: boolean) =>
  missing ? `${title}（まだないメモ）\nクリックで作成` : `${title}\nクリックで開く`;
const lineDeco = (cls: string) => Decoration.line({ class: cls });
const INLINE_PARENTS = new Set(["Emphasis", "StrongEmphasis", "Strikethrough", "InlineCode"]);
const INLINE_STYLE: Record<string, string> = {
  Emphasis: "cm-em",
  StrongEmphasis: "cm-strong",
  Strikethrough: "cm-strike",
  InlineCode: "cm-inline-code",
};

function build(view: EditorView): { decorations: DecorationSet; atomic: DecorationSet } {
  const { state } = view;
  const ranges = state.selection.ranges;
  const deco: Range<Decoration>[] = [];
  /** Hidden markers: the caret steps over each as one unit and Backspace
   *  deletes it whole, so a half-deleted `**` can't linger invisibly. */
  const atomic: Range<Decoration>[] = [];
  const seenBlocks = new Set<number>();

  /** Any selection range touches the lines spanning [from, to]. A
   *  read-only view (no caret) never counts as being on a line. */
  const onLines = (from: number, to: number) => {
    if (state.readOnly) return false;
    const a = state.doc.lineAt(from).from;
    const b = state.doc.lineAt(to).to;
    return ranges.some((r) => r.from <= b && r.to >= a);
  };

  /** Hide a marker (plus one following space). */
  const hide = (from: number, to: number, eatSpace = false) => {
    let end = to;
    if (eatSpace && /[ \t]/.test(state.sliceDoc(end, end + 1))) end++;
    if (end > from) {
      deco.push(hidden.range(from, end));
      atomic.push(hidden.range(from, end));
    }
  };

  /** Heading markers only: shown (muted) while the caret is on the line,
   *  hidden otherwise. Every other marker is always hidden. */
  const headingMark = (from: number, to: number, active: boolean, eatSpace = false) => {
    if (!active) hide(from, to, eatSpace);
    else if (to > from) deco.push(markMuted.range(from, to));
  };

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;

        const heading = /^ATXHeading([1-6])$/.exec(name);
        if (heading) {
          if (seenBlocks.has(node.from)) return false;
          seenBlocks.add(node.from);
          const level = Math.min(4, Number(heading[1]));
          const line = state.doc.lineAt(node.from);
          // A bare `#` is the start of a #tag being typed, not a heading yet —
          // the line turns into one only once the space after `#` is typed.
          if (!/^ {0,3}#{1,6}[ \t]/.test(line.text)) return;
          deco.push(lineDeco(`cm-h cm-h${level}`).range(line.from));
          // Fold toggle in the left margin, for headings with something under them.
          if (!state.readOnly) {
            const folded = sectionFold(state, line.to) !== null;
            if (folded || foldable(state, line.from, line.to)) {
              deco.push(Decoration.widget({ widget: new FoldToggle(folded), side: -1 }).range(line.from));
            }
          }
          const active = onLines(node.from, node.to);
          const c = node.node.cursor();
          if (c.firstChild()) {
            do {
              if (c.name !== "HeaderMark") continue;
              if (c.from === line.from || state.sliceDoc(line.from, c.from).trim() === "") {
                headingMark(c.from, c.to, active, true);
              } else {
                // Closing `##` — hide it with the space before it.
                let start = c.from;
                while (start > line.from && /[ \t]/.test(state.sliceDoc(start - 1, start))) start--;
                headingMark(start, c.to, active);
              }
            } while (c.nextSibling());
          }
          return;
        }

        if (name === "FencedCode") {
          if (seenBlocks.has(node.from)) return false;
          seenBlocks.add(node.from);
          const first = state.doc.lineAt(node.from);
          const last = state.doc.lineAt(node.to);
          const marks = node.node.getChildren("CodeMark");
          // The closing fence, if the block has one yet (an unclosed fence
          // runs to the end of the note).
          const close = marks.length >= 2 && last.number !== first.number ? marks[marks.length - 1] : null;
          for (let n = first.number; n <= last.number; n++) {
            const line = state.doc.line(n);
            let cls = "cm-codeblock";
            if (n === first.number) cls += " cm-codeblock-first cm-codeblock-open";
            if (n === last.number) cls += " cm-codeblock-last";
            if (close && n === last.number) cls += " cm-codeblock-close";
            deco.push(lineDeco(cls).range(line.from));
          }
          // ```lang → a small language label; closing ``` → nothing.
          if (marks.length > 0) {
            const info = node.node.getChild("CodeInfo");
            const label = info ? state.sliceDoc(info.from, info.to) : "";
            const opener = Decoration.replace({ widget: new LangLabel(label) }).range(marks[0].from, first.to);
            deco.push(opener);
            atomic.push(opener);
          }
          if (close) hide(close.from, close.to);
          const text = node.node.getChild("CodeText");
          if (text) {
            deco.push(
              Decoration.widget({ widget: new CopyButton(state.sliceDoc(text.from, text.to)), side: 1 }).range(
                first.to,
              ),
            );
          }
          return false;
        }

        if (name === "Blockquote") {
          const first = state.doc.lineAt(node.from).number;
          const last = state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const { from: lineFrom, text } = state.doc.line(n);
            // Markdown lets an unmarked line right after a quote continue it
            // ("lazy" continuation); here only lines that start with `>` look
            // quoted, so pressing Enter after a quote visibly leaves it.
            if (!/^\s*>/.test(text)) continue;
            if (seenBlocks.has(-lineFrom - 1)) continue;
            seenBlocks.add(-lineFrom - 1);
            deco.push(lineDeco("cm-quote").range(lineFrom));
          }
          return;
        }

        if (name === "QuoteMark") {
          hide(node.from, node.to, true);
          return;
        }

        if (name === "ListMark") {
          const item = node.node.parent;
          const list = item?.parent;
          if (!item || item.name !== "ListItem" || !list) return;
          const task = item.getChild("Task");
          const marker = task?.getChild("TaskMarker");
          if (task && marker) {
            // `- [ ] ` → a real checkbox; done items are struck through.
            const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
            let end = marker.to;
            if (/[ \t]/.test(state.sliceDoc(end, end + 1))) end++;
            const box = Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, end);
            deco.push(box);
            atomic.push(box);
            // Only the item's own line — a following line folded into the
            // item by Markdown isn't part of what was ticked off.
            const lineEnd = Math.min(task.to, state.doc.lineAt(end).to);
            if (checked && lineEnd > end) {
              deco.push(Decoration.mark({ class: "cm-task-done" }).range(end, lineEnd));
            }
          } else if (list.name === "BulletList") {
            // Only `- ` / `* ` turn into a bullet. A lone marker is an empty
            // list item to Markdown, so typing `-` or `+` alone would flash a
            // dot; and `+` is ordinary text far more often than a list.
            const ch = state.sliceDoc(node.from, node.to);
            if (ch !== "+" && /[ \t]/.test(state.sliceDoc(node.to, node.to + 1))) {
              const bullet = Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to);
              deco.push(bullet);
              atomic.push(bullet);
            }
          } else {
            deco.push(Decoration.mark({ class: "cm-list-num" }).range(node.from, node.to));
          }
          return;
        }

        if (name === "HorizontalRule") {
          const rule = Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to);
          deco.push(rule);
          atomic.push(rule);
          return false;
        }

        if (INLINE_STYLE[name]) {
          const c = node.node.cursor();
          const marks: { from: number; to: number }[] = [];
          if (c.firstChild()) {
            do {
              if (/Mark$/.test(c.name)) marks.push({ from: c.from, to: c.to });
            } while (c.nextSibling());
          }
          const inner = marks.length >= 2 ? { from: marks[0].to, to: marks[marks.length - 1].from } : node;
          if (inner.to > inner.from) {
            deco.push(Decoration.mark({ class: INLINE_STYLE[name] }).range(inner.from, inner.to));
          }
          for (const m of marks) hide(m.from, m.to);
          // Code is opaque: nothing inside it is emphasis/links/tags.
          return name === "InlineCode" ? false : undefined;
        }

        if (/Mark$/.test(name) && node.node.parent && INLINE_PARENTS.has(node.node.parent.name)) {
          return; // handled with its parent above
        }

        if (name === "Link") {
          const n = node.node;
          const url = n.getChild("URL");
          const marks = n.getChildren("LinkMark");
          if (!url || marks.length < 2) return;
          const labelFrom = marks[0].to;
          const labelTo = marks[1].from;
          const href = state.sliceDoc(url.from, url.to);
          if (labelTo > labelFrom) deco.push(linkMark(href).range(labelFrom, labelTo));
          hide(marks[0].from, marks[0].to);
          hide(marks[1].from, node.to);
          return false;
        }

        if (name === "URL") {
          const parent = node.node.parent?.name;
          if (parent === "Link" || parent === "Image" || parent === "LinkReference") return;
          const href = state.sliceDoc(node.from, node.to);
          deco.push(linkMark(href).range(node.from, node.to));
          return;
        }

        if (name === "Image") {
          // `![alt](src)` → the picture itself; the source is always hidden
          // and the caret / Backspace treat the image as one character.
          const url = node.node.getChild("URL");
          const marks = node.node.getChildren("LinkMark");
          if (url && marks.length >= 2) {
            const { alt, width } = parseImageAlt(state.sliceDoc(marks[0].to, marks[1].from));
            const img = Decoration.replace({
              widget: new ImageWidget(state.sliceDoc(url.from, url.to), alt, width),
            }).range(node.from, node.to);
            deco.push(img);
            atomic.push(img);
          }
          return false;
        }
      },
    });
  }

  const exists = viewHandlers.get(view)?.().noteExists;
  for (const w of wikiHits(state)) {
    if (w.to < view.viewport.from || w.from > view.viewport.to) continue;
    // While the caret touches the link (arrowed up to it, or inside it), it
    // shows as `[[title]]` with muted brackets so the title can be edited.
    // Otherwise the whole link is one chip, stepped over as one unit.
    const editing = !state.readOnly && ranges.some((r) => r.from <= w.to && r.to >= w.from);
    const missing = exists ? !exists(w.title) : false;
    if (editing) {
      deco.push(markMuted.range(w.from, w.from + 2));
      if (w.to - 2 > w.from + 2) deco.push(wikiEditing(w.title, missing).range(w.from + 2, w.to - 2));
      deco.push(markMuted.range(w.to - 2, w.to));
      continue;
    }
    const chip = Decoration.replace({ widget: new NoteChip(w.title, missing) }).range(w.from, w.to);
    deco.push(chip);
    atomic.push(chip);
  }

  for (const t of tagHits(state)) {
    if (t.to < view.viewport.from || t.from > view.viewport.to) continue;
    deco.push(
      Decoration.mark({
        class: "cm-tag",
        attributes: { "data-tag": t.tag, title: `#${t.tag}\nCtrl+クリックで検索` },
      }).range(t.from, t.to),
    );
  }

  return { decorations: Decoration.set(deco, true), atomic: Decoration.set(atomic, true) };
}

function linkMark(url: string) {
  const href = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
  return Decoration.mark({
    class: "cm-link",
    attributes: { "data-url": href, title: `${href}\nCtrl+クリックで開く` },
  });
}

// `findTags` / `findWikiLinks` walk the whole document; cache both per
// document version.
const scanCache = new WeakMap<object, { tags: TagHit[]; wiki: WikiLink[] }>();
function scan(state: EditorState) {
  let hits = scanCache.get(state.doc);
  if (!hits) {
    const text = state.doc.toString();
    const mask = codeMask(text);
    hits = { tags: findTags(text, mask), wiki: findWikiLinks(text, mask) };
    scanCache.set(state.doc, hits);
  }
  return hits;
}
const tagHits = (state: EditorState) => scan(state).tags;
const wikiHits = (state: EditorState) => scan(state).wiki;

export function livePreview(handlers: () => LivePreviewHandlers) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      ctrlHeld = false;
      constructor(readonly view: EditorView) {
        viewHandlers.set(view, handlers);
        ({ decorations: this.decorations, atomic: this.atomic } = build(view));
        window.addEventListener("keydown", this.onKey);
        window.addEventListener("keyup", this.onKey);
        window.addEventListener("blur", this.onBlur);
      }
      update(u: ViewUpdate) {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          foldedRanges(u.startState) !== foldedRanges(u.state)
        ) {
          ({ decorations: this.decorations, atomic: this.atomic } = build(u.view));
        }
      }
      // Ctrl held → links/tags look clickable (pointer + underline).
      onKey = (e: KeyboardEvent) => this.setCtrl(e.ctrlKey);
      onBlur = () => this.setCtrl(false);
      setCtrl(on: boolean) {
        if (on === this.ctrlHeld) return;
        this.ctrlHeld = on;
        this.view.dom.classList.toggle("cm-ctrl-held", on);
      }
      destroy() {
        window.removeEventListener("keydown", this.onKey);
        window.removeEventListener("keyup", this.onKey);
        window.removeEventListener("blur", this.onBlur);
      }
    },
    { decorations: (v) => v.decorations },
  );

  const clicks = EditorView.domEventHandlers({
    // A URL pasted over selected text turns that text into a link
    // (Notion-style); every other paste is a plain paste.
    paste(e, view) {
      if (!view.state.readOnly) {
        const files = imageFiles(e.clipboardData?.files);
        if (files.length) {
          e.preventDefault();
          insertImages(view, files, view.state.selection.main.head);
          return true;
        }
      }
      const text = e.clipboardData?.getData("text/plain").trim() ?? "";
      const { state } = view;
      if (state.readOnly || !/^https?:\/\/\S+$/i.test(text)) return false;
      const ranges = state.selection.ranges;
      if (ranges.some((r) => r.empty || inCode(state, r.from) || state.sliceDoc(r.from, r.to).includes("\n"))) {
        return false;
      }
      e.preventDefault();
      view.dispatch(
        state.changeByRange((r) => {
          const insert = `[${state.sliceDoc(r.from, r.to)}](${encodeUrl(text)})`;
          return {
            changes: { from: r.from, to: r.to, insert },
            range: EditorSelection.cursor(r.from + insert.length),
          };
        }),
        { userEvent: "input.paste", scrollIntoView: true },
      );
      return true;
    },
    // A plain click places the caret in a link, then offers to edit it.
    click(e, view) {
      if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || view.state.readOnly) return false;
      if ((e.target as HTMLElement | null)?.closest("[data-url]") && view.state.selection.main.empty) {
        handlers().onLinkClick?.();
      }
      return false;
    },
    // Copying / cutting link text takes the link along (see linkAwareClipboard).
    copy: (e, view) => linkClipboard(e, view, false),
    cut: (e, view) => linkClipboard(e, view, true),
    // Image files dropped from Explorer / a browser land where they're dropped.
    drop(e, view) {
      const files = imageFiles(e.dataTransfer?.files);
      if (!files.length || view.state.readOnly) return false;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      insertImages(view, files, pos);
      return true;
    },
    mousedown(e, view) {
      if (e.button !== 0 || e.shiftKey || e.altKey) return false;
      const target = e.target as HTMLElement | null;
      // A note link is a button to that note: a plain click opens it (like
      // a page mention in Notion). To edit the link text, arrow into it.
      const note = target?.closest<HTMLElement>("[data-note]");
      if (note?.dataset.note) {
        e.preventDefault();
        handlers().onOpenNote?.(note.dataset.note);
        return true;
      }
      // URLs and #tags sit in ordinary text, where a plain click places the
      // caret — so in the editor they follow on Ctrl+click. Read-only views
      // have no caret: a plain click (tap) follows.
      if (!e.ctrlKey && !view.state.readOnly) return false;
      const link = target?.closest<HTMLElement>("[data-url]");
      if (link?.dataset.url) {
        e.preventDefault();
        handlers().onOpenUrl(link.dataset.url);
        return true;
      }
      const tag = target?.closest<HTMLElement>("[data-tag]");
      if (tag?.dataset.tag) {
        e.preventDefault();
        handlers().onTagClick(tag.dataset.tag);
        return true;
      }
      return false;
    },
  });

  const atomic = EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none);

  return [plugin, clicks, atomic];
}

// ---------- editing commands ----------

/** Saves `files` (converted to WebP) and inserts their `![](…)` at `pos`,
 *  each on its own line. Saving takes a moment; if the text changed in the
 *  meantime, `pos` may no longer mean the same place, so the images go to
 *  the caret instead. */
async function insertImages(view: EditorView, files: File[], pos: number) {
  const startDoc = view.state.doc;
  let md: string[];
  try {
    md = await Promise.all(files.map(saveImage));
  } catch (err) {
    console.error("[images] save failed", err);
    return;
  }
  const { state } = view;
  const at = state.doc === startDoc ? pos : state.selection.main.head;
  const line = state.doc.lineAt(at);
  const before = at > line.from ? "\n" : "";
  const after = at < line.to ? "\n" : "";
  const insert = before + md.join("\n") + after;
  view.dispatch({
    changes: { from: at, insert },
    selection: { anchor: at + insert.length },
    scrollIntoView: true,
    userEvent: "input.paste",
  });
}

const HEADING_MARK = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

/** Whether `pos` sits inside a fenced code block, where `#` is just code. */
function inCode(state: EditorState, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "InlineCode") return true;
  }
  return false;
}

/** Sets every line touched by the selection to heading `level` (0 = body
 *  text). If every touched line already has that level, they revert to body
 *  text instead — clicking the lit toolbar button again undoes it. */
export function setHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const lines = new Map<number, ReturnType<typeof state.doc.lineAt>>();
  for (const r of state.selection.ranges) {
    for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) {
      const line = state.doc.line(n);
      if (!inCode(state, line.from)) lines.set(n, line);
    }
  }
  if (lines.size === 0) return false;
  const levelOf = (text: string) => HEADING_MARK.exec(text)?.[2].length ?? 0;
  const target = level > 0 && [...lines.values()].every((l) => levelOf(l.text) === level) ? 0 : level;
  const prefix = target > 0 ? "#".repeat(target) + " " : "";

  const changes = state.changes(
    [...lines.values()].map((line) => {
      const m = HEADING_MARK.exec(line.text);
      return { from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix };
    }),
  );
  // Keep a bare caret after the new marker, not stranded in front of it.
  const doc = changes.apply(state.doc);
  let selection = state.selection.map(changes);
  const main = selection.main;
  if (main.empty) {
    const line = doc.lineAt(main.head);
    const head = Math.max(main.head, line.from + (HEADING_MARK.exec(line.text)?.[0].length ?? 0));
    if (head !== main.head) {
      selection = selection.replaceRange(EditorSelection.cursor(head), selection.mainIndex);
    }
  }
  view.dispatch({ changes, selection, scrollIntoView: true, userEvent: "input.heading" });
  return true;
}

/** The `node` (StrongEmphasis / Emphasis) enclosing [from, to], if any. */
function enclosing(state: EditorState, name: string, from: number, to: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, side); n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to) return n;
    }
  }
  return null;
}

export interface LinkTarget {
  /** Range the new `[label](url)` replaces. */
  from: number;
  to: number;
  label: string;
  url: string;
  /** Editing a link that's already there (vs. making a new one). */
  existing: boolean;
}

/** What Ctrl+L acts on: the link around the selection if there is one
 *  (to change or remove its URL — which is hidden in the editor), else the
 *  selection itself, else just the caret position. */
export function linkTarget(state: EditorState): LinkTarget {
  const { from, to } = state.selection.main;
  const link = enclosing(state, "Link", from, to);
  const url = link?.getChild("URL");
  const marks = link?.getChildren("LinkMark") ?? [];
  if (link && url && marks.length >= 2) {
    return {
      from: link.from,
      to: link.to,
      label: state.sliceDoc(marks[0].to, marks[1].from),
      url: state.sliceDoc(url.from, url.to),
      existing: true,
    };
  }
  const text = state.sliceDoc(from, to);
  const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
  return { from, to, label: isUrl ? "" : text, url: isUrl ? text.trim() : "", existing: false };
}

/** Spaces and parentheses would end a Markdown link destination early. */
function encodeUrl(url: string): string {
  return url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Writes `[label](url)` over `target` (label defaults to the URL), or with
 *  an empty URL turns an existing link back into its plain label. */
export function applyLink(view: EditorView, target: LinkTarget, url: string, label: string) {
  const href = encodeUrl(url.trim());
  if (!href && !target.existing) return;
  const insert = href ? `[${label || url.trim()}](${href})` : target.label;
  view.dispatch({
    changes: { from: target.from, to: target.to, insert },
    selection: { anchor: target.from + insert.length },
    scrollIntoView: true,
    userEvent: "input.link",
  });
}

const INLINE_KINDS = {
  bold: { node: "StrongEmphasis", mark: "**", markNode: "EmphasisMark" },
  italic: { node: "Emphasis", mark: "*", markNode: "EmphasisMark" },
  strike: { node: "Strikethrough", mark: "~~", markNode: "StrikethroughMark" },
  code: { node: "InlineCode", mark: "`", markNode: "CodeMark" },
} as const;
export type InlineKind = keyof typeof INLINE_KINDS;

/**
 * Ctrl+B / Ctrl+I: Word-like toggle of bold / italic.
 * - Caret only: inside bold → un-bold it; otherwise insert an empty `****`
 *   pair with the caret in the middle.
 * - Selection: handled per line (emphasis can't span a blank line), with
 *   surrounding whitespace and blank lines left out — so selecting empty
 *   lines does nothing instead of piling up `****`. If every line is already
 *   entirely bold, it's removed. Otherwise any bold inside or overlapping
 *   the selection is dissolved and one pair is put around the outermost
 *   extent, never `**` nested in `**`.
 */
export function toggleInline(view: EditorView, kind: InlineKind): boolean {
  const { state } = view;
  const { node: nodeName, mark, markNode } = INLINE_KINDS[kind];
  const outerMarks = (n: SyntaxNode) => {
    const m = n.getChildren(markNode);
    return m.length >= 2 ? [m[0], m[m.length - 1]] : [];
  };

  const tr = state.changeByRange((range) => {
    if (range.empty) {
      const n = enclosing(state, nodeName, range.from, range.to);
      const m = n ? outerMarks(n) : [];
      if (m.length) {
        const changes = state.changes(m.map((x) => ({ from: x.from, to: x.to })));
        return { changes, range: range.map(changes) };
      }
      // On a blank line there's nothing to style — and `****` alone on a
      // line is a horizontal rule in Markdown.
      if (state.doc.lineAt(range.from).text.trim() === "") return { range };
      const changes = state.changes({ from: range.from, insert: mark + mark });
      return { changes, range: EditorSelection.cursor(range.from + mark.length) };
    }

    // One trimmed segment per non-blank line of the selection.
    const segments: { from: number; to: number }[] = [];
    const lastLine = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= lastLine; n++) {
      const line = state.doc.line(n);
      let a = Math.max(range.from, line.from);
      let b = Math.min(range.to, line.to);
      const text = state.sliceDoc(a, b);
      a += text.length - text.trimStart().length;
      b -= text.length - text.trimEnd().length;
      if (b > a) segments.push({ from: a, to: b });
    }
    if (segments.length === 0) return { range };

    const specs = new Map<string, { from: number; to: number; insert: string }>();
    const add = (from: number, to: number, insert = "") =>
      specs.set(`${from}:${to}:${insert}`, { from, to, insert });

    const wholes = segments.map((s) => enclosing(state, nodeName, s.from, s.to));
    if (wholes.every((w) => w && outerMarks(w).length)) {
      for (const w of wholes) for (const m of outerMarks(w!)) add(m.from, m.to);
    } else {
      for (const seg of segments) {
        let from = seg.from;
        let to = seg.to;
        syntaxTree(state).iterate({
          from: seg.from,
          to: seg.to,
          enter: (c) => {
            if (c.name !== nodeName || c.to <= seg.from || c.from >= seg.to) return;
            const marks = outerMarks(c.node);
            if (!marks.length) return;
            from = Math.min(from, c.from);
            to = Math.max(to, c.to);
            for (const m of marks) add(m.from, m.to);
          },
        });
        add(from, from, mark);
        add(to, to, mark);
      }
    }

    const changes = state.changes([...specs.values()]);
    const forward = range.anchor <= range.head;
    return {
      changes,
      range: EditorSelection.range(
        changes.mapPos(range.anchor, forward ? 1 : -1),
        changes.mapPos(range.head, forward ? -1 : 1),
      ),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input.format" });
  return true;
}

/** Whether every cursor sits in a list item (outside code). */
function allInList(state: EditorState): boolean {
  return state.selection.ranges.every((r) => {
    if (!r.empty) return false;
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(r.head, -1); n; n = n.parent) {
      if (n.name === "FencedCode" || n.name === "InlineCode") return false;
      if (n.name === "ListItem") return true;
    }
    return false;
  });
}

const QUOTE_LINE = /^\s*>/;
const EMPTY_QUOTE_LINE = /^\s*>\s*$/;

/** Whether every cursor is on a line starting with `>` (outside code). */
function allInQuote(state: EditorState): boolean {
  return state.selection.ranges.every(
    (r) => r.empty && !inCode(state, r.head) && QUOTE_LINE.test(state.doc.lineAt(r.head).text),
  );
}

/** What Copy / Cut of the selection should put on the clipboard and (for
 *  Cut) delete, keeping links: a link's markup is hidden, so a selection
 *  of its visible text usually holds only the label. Each link the
 *  selection reaches into is written as `[selected label](url)`; Cut takes
 *  the whole link when its whole label is selected (no `[](url)` leftover).
 *  Null when no link is involved — the ordinary copy applies. */
export function linkAwareClipboard(state: EditorState): { text: string; cut: { from: number; to: number }[] } | null {
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  if (!ranges.length) return null;
  let touched = false;
  const parts: string[] = [];
  const cut: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const links: { from: number; to: number; labelFrom: number; labelTo: number; url: string }[] = [];
    syntaxTree(state).iterate({
      from: r.from,
      to: r.to,
      enter: (n) => {
        if (n.name !== "Link") return;
        const url = n.node.getChild("URL");
        const marks = n.node.getChildren("LinkMark");
        if (url && marks.length >= 2 && n.to > r.from && n.from < r.to) {
          links.push({
            from: n.from,
            to: n.to,
            labelFrom: marks[0].to,
            labelTo: marks[1].from,
            url: state.sliceDoc(url.from, url.to),
          });
        }
        return false;
      },
    });
    let out = "";
    let pos = r.from;
    for (const l of links) {
      const a = Math.max(r.from, l.labelFrom);
      const b = Math.min(r.to, l.labelTo);
      const segFrom = Math.max(r.from, l.from);
      out += state.sliceDoc(pos, segFrom);
      if (segFrom > pos) cut.push({ from: pos, to: segFrom });
      if (b > a) out += `[${state.sliceDoc(a, b)}](${l.url})`;
      // The whole label goes with its link; part of it leaves a shorter link.
      if (a <= l.labelFrom && b >= l.labelTo) cut.push({ from: l.from, to: l.to });
      else if (b > a) cut.push({ from: a, to: b });
      pos = Math.min(r.to, l.to);
      touched = true;
    }
    out += state.sliceDoc(pos, r.to);
    if (r.to > pos) cut.push({ from: pos, to: r.to });
    parts.push(out);
  }
  return touched ? { text: parts.join(state.lineBreak), cut } : null;
}

function linkClipboard(e: ClipboardEvent, view: EditorView, cut: boolean): boolean {
  const out = linkAwareClipboard(view.state);
  if (!out || !e.clipboardData) return false;
  e.preventDefault();
  e.clipboardData.clearData();
  e.clipboardData.setData("text/plain", out.text);
  if (cut && !view.state.readOnly) {
    const pieces = [...out.cut].sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [];
    for (const p of pieces) {
      const last = merged[merged.length - 1];
      if (last && p.from <= last.to) last.to = Math.max(last.to, p.to);
      else merged.push({ ...p });
    }
    view.dispatch({ changes: merged, userEvent: "delete.cut", scrollIntoView: true });
  }
  return true;
}

/** An inline construct shown as just its content, with hidden markers on
 *  both sides: `[label](url)`, `**b**`, `*i*`, `~~s~~`, `` `c` ``, `[[note]]`. */
interface Paired {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  /** `[[note]]`: its opener is visible (the chip's page icon, or a muted
   *  `[[` while the caret is at the link), not hidden. */
  wiki?: boolean;
}

const PAIRED_MARK: Record<string, string> = {
  Link: "LinkMark",
  Emphasis: "EmphasisMark",
  StrongEmphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

function pairedAt(state: EditorState, pos: number): Paired[] {
  const out: Paired[] = [];
  syntaxTree(state).iterate({
    from: pos,
    to: pos,
    enter: (n) => {
      const markName = PAIRED_MARK[n.name];
      if (!markName) return;
      const marks = n.node.getChildren(markName);
      if (marks.length < 2 || (n.name === "Link" && !n.node.getChild("URL"))) return;
      out.push({ from: n.from, to: n.to, contentFrom: marks[0].to, contentTo: marks[1].from });
      if (n.name === "Link") return; // `](url)`: one hidden run, as drawn
      out[out.length - 1].contentTo = marks[marks.length - 1].from;
    },
  });
  for (const w of wikiHits(state)) {
    if (w.from <= pos && w.to >= pos) out.push({ from: w.from, to: w.to, contentFrom: w.from + 2, contentTo: w.to - 2, wiki: true });
  }
  return out;
}

/** Length of the character (grapheme) before / after `pos`. */
function charLen(state: EditorState, pos: number, forward: boolean): number {
  const line = state.doc.lineAt(pos);
  const at = pos - line.from;
  if (forward ? at === line.length : at === 0) return 1; // the line break
  return Math.abs(findClusterBreak(line.text, at, forward) - at);
}

/** Backspace / Delete next to a hidden marker. The marker is atomic, so
 *  the plain commands would erase it whole and leave its partner behind
 *  (`[label` without `](url)`, a lone `**`). Instead the key acts on what
 *  the caret visibly touches:
 *  - Backspace at the start of the content (just after a hidden opener)
 *    deletes before the whole construct; Delete at the end of the content
 *    deletes after it.
 *  - Backspace just after the construct deletes its last character, Delete
 *    just before it its first; when that empties it, the construct goes.
 *  - The opener of a `[[note]]` is visible (as the page icon, or as a muted
 *    `[[` while the caret is there): deleting it unlinks the note, leaving
 *    its title as plain text.
 *  Where the caret only had to move, the other commands (list markers,
 *  plain delete) run from the new spot. */
export function pairedMarkDelete(view: EditorView, forward: boolean): boolean {
  const { state } = view;
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length > 1 || !sel.main.empty) return false;
  let pos = sel.main.head;
  for (let guard = 0; guard < 20; guard++) {
    const here = pairedAt(state, pos);
    // Deleting the last character left inside: the construct goes with it.
    const last = here.find((p) =>
      forward
        ? p.contentFrom === pos && pos + charLen(state, pos, true) >= p.contentTo
        : p.contentTo === pos && pos - charLen(state, pos, false) <= p.contentFrom,
    );
    if (last) return removeWhole(view, last, forward);
    // Caret at the content's edge facing out of the construct → step out.
    const out = here.find((p) => (forward ? p.contentTo === pos : p.contentFrom === pos) && !(p.wiki && !forward));
    if (out) {
      pos = forward ? out.to : out.from;
      continue;
    }
    // Caret just outside the construct, facing into it.
    const into = here.find((p) => (forward ? p.from === pos : p.to === pos));
    if (into) {
      if (into.wiki && forward) return unlinkNote(view, into);
      pos = forward ? into.contentFrom : into.contentTo;
      continue;
    }
    break;
  }
  // Backspace right after a note's page icon.
  const icon = !forward && pairedAt(state, pos).find((p) => p.wiki && p.contentFrom === pos);
  if (icon) return unlinkNote(view, icon);
  if (pos === sel.main.head) return false;
  view.dispatch({ selection: EditorSelection.cursor(pos) });
  return !forward && demoteHeadingOnBackspace(view);
}

function removeWhole(view: EditorView, p: Paired, forward: boolean): boolean {
  // `[**a**](url)`: emptying the bold empties the link too.
  for (let outer; (outer = pairedAt(view.state, p.from).find((o) => o.contentFrom === p.from && o.contentTo === p.to)); ) {
    p = outer;
  }
  view.dispatch({
    changes: { from: p.from, to: p.to },
    selection: EditorSelection.cursor(p.from),
    userEvent: forward ? "delete.forward" : "delete.backward",
  });
  return true;
}

function unlinkNote(view: EditorView, w: Paired): boolean {
  view.dispatch({
    changes: [
      { from: w.from, to: w.contentFrom },
      { from: w.contentTo, to: w.to },
    ],
    selection: EditorSelection.cursor(w.from),
    userEvent: "delete.unlink",
  });
  return true;
}

/** End of the `[label](url)` whose hidden `](url)` starts at `pos`, if any. */
function linkTailEnd(state: EditorState, pos: number): number | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== "Link") continue;
    const marks = n.getChildren("LinkMark");
    return n.getChild("URL") && marks.length >= 2 && marks[1].from === pos ? n.to : null;
  }
  return null;
}

/** A caret just before a link's hidden `](url)` looks like it's after the
 *  link — and it lands there by itself when the link ends the line (the
 *  browser can't place the caret behind the hidden part). Enter there would
 *  split `[label` from `](url)` and dissolve the link, so move the caret past
 *  the link first and let the other Enter commands run from there. */
export function linkTailEnter(view: EditorView): boolean {
  const { state } = view;
  let moved = false;
  const ranges = state.selection.ranges.map((r) => {
    const end = r.empty ? linkTailEnd(state, r.head) : null;
    if (end == null) return r;
    moved = true;
    return EditorSelection.cursor(end);
  });
  if (moved) view.dispatch({ selection: EditorSelection.create(ranges, state.selection.mainIndex) });
  return false;
}

/** Enter inside a list or a quote continues it (`- `, `2. `, `- [ ] `,
 *  `> `); on an empty item / empty `> ` line it ends the list or quote
 *  instead. Anywhere else Enter stays a plain newline. */
export function listEnter(view: EditorView): boolean {
  const { state } = view;
  if (allInQuote(state)) {
    if (state.selection.ranges.every((r) => EMPTY_QUOTE_LINE.test(state.doc.lineAt(r.head).text))) {
      // Empty `> ` line: leave the quote — the line becomes a plain empty one.
      view.dispatch(
        state.changeByRange((r) => {
          const line = state.doc.lineAt(r.head);
          return {
            changes: { from: line.from, to: line.to },
            range: EditorSelection.cursor(line.from),
          };
        }),
        { userEvent: "delete.quote" },
      );
      return true;
    }
    view.dispatch(
      state.changeByRange((r) => {
        const prefix = /^\s*(?:>\s?)+/.exec(state.doc.lineAt(r.head).text)?.[0] ?? "> ";
        const insert = "\n" + prefix;
        return {
          changes: { from: r.from, to: r.to, insert },
          range: EditorSelection.cursor(r.from + insert.length),
        };
      }),
      { userEvent: "input", scrollIntoView: true },
    );
    return true;
  }
  if (!allInList(state)) return false;
  // Enter on an empty item (just `- ` / `2. ` / `- [ ] `) ends the list
  // right away — or, nested, moves the item one level up. (CodeMirror's own
  // rule sometimes inserts a blank line first instead, which reads as
  // Enter "not working".)
  const empties = state.selection.ranges.map((r) => {
    const line = state.doc.lineAt(r.head);
    return EMPTY_ITEM.test(line.text) && r.head === line.to ? line : null;
  });
  if (empties.every((l) => l)) {
    view.dispatch(
      state.changeByRange((r) => {
        const line = state.doc.lineAt(r.head);
        const indent = /^[ \t]*/.exec(line.text)![0];
        if (indent.length > 0) {
          const cut = indent[0] === "\t" ? 1 : Math.min(indent.length, 4);
          return {
            changes: { from: line.from, to: line.from + cut },
            range: EditorSelection.cursor(r.head - cut),
          };
        }
        return { changes: { from: line.from, to: line.to }, range: EditorSelection.cursor(line.from) };
      }),
      { userEvent: "delete.list" },
    );
    return true;
  }
  return insertNewlineContinueMarkup(view);
}

const EMPTY_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/;

/** Tab / Shift+Tab on list items nests / un-nests them (by `width`
 *  spaces). Outside lists Tab keeps its usual meaning. */
export function listIndent(view: EditorView, width: number, direction: 1 | -1): boolean {
  const { state } = view;
  const inList = state.selection.ranges.every((r) =>
    ([-1, 1] as const).some((side) => {
      for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(r.from, side); n; n = n.parent) {
        if (n.name === "FencedCode") return false;
        if (n.name === "ListItem") return true;
      }
      return false;
    }),
  );
  return inList && indentLines(view, width, direction);
}

/** Backspace right after a list marker removes the marker. */
export function listBackspace(view: EditorView): boolean {
  return allInList(view.state) && deleteMarkupBackward(view);
}

export interface CodeLangTarget {
  /** Range of the info string after the opening fence (may be empty). */
  from: number;
  to: number;
  lang: string;
}

/** The language slot of the fenced code block starting at `pos`. */
export function codeLangTarget(state: EditorState, pos: number): CodeLangTarget | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name !== "FencedCode") continue;
    const open = n.getChild("CodeMark");
    if (!open) return null;
    const info = n.getChild("CodeInfo");
    return info
      ? { from: info.from, to: info.to, lang: state.sliceDoc(info.from, info.to) }
      : { from: open.to, to: open.to, lang: "" };
  }
  return null;
}

export function setCodeLang(view: EditorView, target: CodeLangTarget, lang: string) {
  view.dispatch({
    changes: { from: target.from, to: target.to, insert: lang.trim().replace(/\s+/g, "-") },
    userEvent: "input.lang",
  });
}

/** Ctrl+] / Ctrl+[: indents or outdents every line touched by any cursor or
 *  selection, once per line. Outdent strips a leading tab, else up to
 *  `width` leading spaces — never past what's there. */
export function indentLines(view: EditorView, width: number, direction: 1 | -1): boolean {
  const { state } = view;
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  const changes = [...lines].map((n) => {
    const line = state.doc.line(n);
    if (direction === 1) return { from: line.from, insert: " ".repeat(width) };
    let remove = 0;
    if (line.text[0] === "\t") remove = 1;
    else while (remove < width && line.text[remove] === " ") remove++;
    return { from: line.from, to: line.from + remove };
  });
  const set = state.changes(changes);
  view.dispatch({
    changes: set,
    // Carets move with their text (not left behind at the line start).
    selection: state.selection.map(set, 1),
    userEvent: direction === 1 ? "input.indent" : "delete.dedent",
  });
  return true;
}

/** Backspace right after a heading's `## ` turns the line back into body
 *  text (Notion-style) instead of deleting the space — which would leave
 *  `##見出し`, i.e. a #tag. */
export function demoteHeadingOnBackspace(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(sel.head);
  const m = HEADING_MARK.exec(line.text);
  if (!m || sel.head !== line.from + m[0].length || m[0].length === m[1].length + m[2].length) return false;
  if (inCode(state, line.from)) return false;
  view.dispatch({
    changes: { from: line.from + m[1].length, to: sel.head },
    selection: { anchor: line.from + m[1].length },
    userEvent: "delete.heading",
  });
  return true;
}

/** Inside a code block Enter keeps the previous line's indentation, so a
 *  closing ``` typed next would land indented — and with 4+ spaces Markdown
 *  doesn't count it as a fence, leaving the block open. Typing the third
 *  backtick on an otherwise blank, indented line moves the fence to the
 *  line start. */
export const dedentClosingFence = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== "`" && text !== "~") return false;
  const { state } = view;
  const line = state.doc.lineAt(from);
  const typed = state.sliceDoc(line.from, from) + text;
  const m = /^[ \t]+((`|~)\2{2,})$/.exec(typed);
  if (!m || state.sliceDoc(to, line.to).trim() !== "" || !inCode(state, line.from)) return false;
  view.dispatch({
    changes: { from: line.from, to, insert: m[1] },
    selection: { anchor: line.from + m[1].length },
    userEvent: "input.type",
  });
  return true;
});

/** When a closing ``` is typed under a code block that has no language,
 *  guess the language from the code and write it after the opening fence
 *  (``` → ```js), so the block gets highlighted. Only at that moment — a
 *  language removed later on purpose is never put back. The label can be
 *  clicked to correct a wrong guess. */
export const autoCodeLanguage = EditorView.updateListener.of((u) => {
  if (!u.docChanged || !u.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
  const touched: number[] = [];
  u.changes.iterChangedRanges((_fa, _ta, _fb, toB) => touched.push(toB));
  // Right after this update finishes (dispatching inside it isn't allowed),
  // before the next keystroke — an Enter typed straight after the fence
  // must not get there first.
  queueMicrotask(() => {
    const view = u.view;
    const { state } = view;
    if (state.doc !== u.state.doc) return;
    const changes: { from: number; insert: string }[] = [];
    for (const pos of touched) {
      for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
        if (n.name !== "FencedCode") continue;
        const marks = n.getChildren("CodeMark");
        const text = n.getChild("CodeText");
        const close = marks[marks.length - 1];
        // The edit must be on the closing fence line of an unlabeled block.
        if (marks.length < 2 || n.getChild("CodeInfo") || !text) break;
        if (state.doc.lineAt(close.from).number !== state.doc.lineAt(pos).number) break;
        const lang = guessLanguage(state.sliceDoc(text.from, text.to));
        if (lang) changes.push({ from: marks[0].to, insert: lang });
        break;
      }
    }
    if (changes.length) view.dispatch({ changes, userEvent: "input.lang" });
  });
});

const FULLWIDTH_HEADING =/^([#＃]{1,4})([ 　])$/;

/** The `[#＃]{1,4}[ 　]` line prefix ending at `head`, if it has a full-width
 *  character in it (a plain `## ` needs no fixing) and sits outside code. */
function fullwidthPrefix(state: EditorState, lineFrom: number, head: number) {
  const m = FULLWIDTH_HEADING.exec(state.sliceDoc(lineFrom, head));
  if (!m || !/[＃　]/.test(m[0]) || inCode(state, lineFrom)) return null;
  return "#".repeat(m[1].length) + " ";
}

/** `＃＃　` typed with the IME on becomes `## ` — only at the moment the space
 *  is typed at a line start, so existing text is never rewritten. */
export const fullwidthHeadings = [
  EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing || !/[ 　]$/.test(text)) return false;
    const { state } = view;
    const line = state.doc.lineAt(from);
    const typed = state.sliceDoc(line.from, from) + text;
    if (to > line.to || typed.length > 5) return false;
    const insert = fullwidthPrefix(state.update({ changes: { from, to, insert: text } }).state, line.from, line.from + typed.length);
    if (!insert) return false;
    view.dispatch({
      changes: { from: line.from, to, insert },
      selection: { anchor: line.from + insert.length },
      userEvent: "input.type",
    });
    return true;
  }),
  // A whole `＃＃　` committed by the IME in one go arrives as a composition,
  // which the input handler above doesn't see — check once it has landed.
  EditorView.domEventHandlers({
    compositionend(_e, view) {
      setTimeout(() => {
        const { state } = view;
        const sel = state.selection.main;
        if (view.composing || !sel.empty) return;
        const line = state.doc.lineAt(sel.head);
        const insert = fullwidthPrefix(state, line.from, sel.head);
        if (!insert) return;
        view.dispatch({
          changes: { from: line.from, to: sel.head, insert },
          selection: { anchor: line.from + insert.length },
          userEvent: "input.type",
        });
      });
      return false;
    },
  }),
];
