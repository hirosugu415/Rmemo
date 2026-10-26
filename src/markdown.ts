// Plain-text Markdown helpers shared by the editor and the tag preview.
//
// The rules here are deliberately mirrored in the Rust backend
// (`notes::tags::code_mask` / `notes::strip_inline`), so a `#tag` the
// editor colours is exactly a tag the saved note will carry.

export function isTagChar(ch: string): boolean {
  return /[\p{L}\p{N}_-]/u.test(ch);
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const URL_START = /^https?:\/\//;

/**
 * One flag per UTF-16 unit of `s`: true where the text is code or a URL —
 * fenced code blocks (fence lines included), `inline code` spans, a link's
 * `(destination)`, and bare `http(s)://` URLs. Nothing in those spans is a
 * tag (`#include`, `https://x/#anchor`).
 */
export function codeMask(s: string): Uint8Array {
  const mask = new Uint8Array(s.length);
  let fence: { ch: string; len: number } | null = null;
  // Consecutive non-blank lines outside fences: inline code may span lines
  // within one, but never past a blank line or a fence.
  let chunkStart = -1;

  const flushChunk = (end: number) => {
    if (chunkStart >= 0) maskInline(s, chunkStart, end, mask);
    chunkStart = -1;
  };

  let lineStart = 0;
  while (lineStart <= s.length) {
    const nl = s.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? s.length : nl;
    // A CRLF note keeps its "\r" here; it must not stop a fence from closing.
    const line = s.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (fence) {
      mask.fill(1, lineStart, lineEnd);
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
    } else {
      const m = FENCE_OPEN.exec(line);
      if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
        flushChunk(lineStart);
        fence = { ch: m[1][0], len: m[1].length };
        mask.fill(1, lineStart, lineEnd);
      } else if (line.trim() === "") {
        flushChunk(lineStart);
      } else if (chunkStart < 0) {
        chunkStart = lineStart;
      }
    }

    if (nl === -1) break;
    lineStart = nl + 1;
  }
  flushChunk(s.length);
  return mask;
}

function maskInline(s: string, from: number, to: number, mask: Uint8Array) {
  let i = from;
  while (i < to) {
    const c = s[i];
    if (c === "`") {
      let n = 0;
      while (i + n < to && s[i + n] === "`") n++;
      // Look for a closing run of exactly the same length.
      let j = i + n;
      let close = -1;
      while (j < to) {
        if (s[j] === "`") {
          let k = 0;
          while (j + k < to && s[j + k] === "`") k++;
          if (k === n) {
            close = j;
            break;
          }
          j += k;
        } else j++;
      }
      if (close >= 0) {
        mask.fill(1, i, close + n);
        i = close + n;
      } else {
        i += n;
      }
      continue;
    }
    if (c === "]" && s[i + 1] === "(") {
      const lineEnd = s.indexOf("\n", i);
      const close = s.indexOf(")", i + 2);
      if (close >= 0 && (lineEnd === -1 || close < lineEnd)) {
        mask.fill(1, i + 1, close + 1);
        i = close + 1;
        continue;
      }
    }
    if ((c === "h" || c === "H") && (i === from || !isTagChar(s[i - 1])) && URL_START.test(s.slice(i, i + 8))) {
      let j = i;
      while (j < to && !/\s/.test(s[j])) j++;
      mask.fill(1, i, j);
      i = j;
      continue;
    }
    i++;
  }
}

export interface TagHit {
  /** UTF-16 offsets of the whole `#tag`, hash included. */
  from: number;
  to: number;
  tag: string;
}

/** Every `#tag` occurrence in `s` outside code/URLs, in document order. */
export function findTags(s: string, codeOnly: Uint8Array = codeMask(s)): TagHit[] {
  // Nor is anything inside a `[[note link]]`: linking to a note titled
  // "#仕事 メモ" doesn't tag this note #仕事.
  const mask = codeOnly.slice();
  for (const w of findWikiLinks(s, codeOnly)) mask.fill(1, w.from, w.to);
  const hits: TagHit[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "#" && !mask[i] && (i === 0 || !isTagChar(prevChar(s, i)))) {
      let end = i + 1;
      while (end < s.length) {
        const ch = charAt(s, end);
        if (!isTagChar(ch)) break;
        end += ch.length;
      }
      if (end > i + 1) {
        hits.push({ from: i, to: end, tag: s.slice(i + 1, end) });
        i = end;
        continue;
      }
    }
    i++;
  }
  return hits;
}

/** The (possibly surrogate-pair) character starting at `i`. */
function charAt(s: string, i: number): string {
  return String.fromCodePoint(s.codePointAt(i)!);
}

/** The (possibly surrogate-pair) character ending just before `i`. */
function prevChar(s: string, i: number): string {
  const lo = s.charCodeAt(i - 1);
  if (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff) return s.slice(i - 2, i);
  return s[i - 1];
}

/**
 * Client-side mirror of `notes::tags::extract` in the Rust backend — used
 * only for a live preview while composing (the saved file is always the
 * source of truth; the backend re-extracts from the actual written body).
 * Tags in first-appearance order, deduplicated, without the leading `#`.
 */
export function extractTags(body: string): string[] {
  const tags: string[] = [];
  for (const { tag } of findTags(body)) if (!tags.includes(tag)) tags.push(tag);
  return tags;
}

export interface WikiLink {
  /** Offsets of the whole `[[…]]`. */
  from: number;
  to: number;
  title: string;
}

/** Every `[[メモ名]]` outside code, on a single line. */
export function findWikiLinks(s: string, mask: Uint8Array = codeMask(s)): WikiLink[] {
  const out: WikiLink[] = [];
  const re = /\[\[([^[\]\n]+?)\]\]/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (mask[m.index]) continue;
    const title = m[1].trim();
    if (title) out.push({ from: m.index, to: m.index + m[0].length, title });
  }
  return out;
}

/** Characters in `text`, line breaks not counted and a surrogate pair
 *  (emoji etc.) counted once — the same rule as the backend's count. */
export function charCount(text: string): number {
  let n = 0;
  for (const ch of text) if (ch !== "\n" && ch !== "\r") n++;
  return n;
}

/** Best guess at the language of an unlabeled code block, from tell-tale
 *  syntax — or null when nothing is distinctive enough to bet on. */
export function guessLanguage(code: string): string | null {
  const t = code.trim();
  if (!t) return null;
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(t);
      return "json";
    } catch {
      /* not JSON */
    }
  }
  const rules: [string, RegExp][] = [
    ["html", /^<(!doctype|html|head|body|div|span|p|a|ul|li|section|template)[\s>]/i],
    ["powershell", /\b(Get|Set|New|Remove|Write)-[A-Z]\w+|\$\w+\s*=\s*.+;?\s*$/m],
    ["rust", /\bfn\s+\w+\s*[(<]|\blet\s+mut\b|\bimpl\b|\bprintln!|::new\(/],
    ["go", /^package\s+\w+|\bfunc\s+(\(\w+\s+\*?\w+\)\s*)?\w+\(|:=/m],
    ["python", /^\s*(def\s+\w+\(|class\s+\w+.*:\s*$|from\s+[\w.]+\s+import\b|import\s+\w+\s*$|print\()/m],
    ["java", /\bpublic\s+(static\s+)?(class|void|int|String)\b|System\.out\.println/],
    ["cpp", /^#include\s*[<"]|\bstd::/m],
    ["sql", /^\s*(select\s.+\sfrom\s|insert\s+into\s|update\s+\w+\s+set\s|delete\s+from\s|create\s+(table|index|view)\s)/im],
    ["ts", /\b(interface|type)\s+\w+\s*[={<]|:\s*(string|number|boolean)\b/],
    ["js", /\b(const|let|var|function)\s+\w+|=>|console\.\w+\(|\brequire\(|^import\s.+\sfrom\s/m],
    ["css", /^[\w.#:\-\s,>*[\]="']+\{[^}]*:[^}]*;/m],
    ["bash", /^\s*(\$\s|#!\/bin\/|sudo\s|npm\s|npx\s|git\s|cd\s|echo\s|export\s|ls\b|cargo\s)/m],
  ];
  for (const [lang, re] of rules) if (re.test(t)) return lang;
  return null;
}

/** `# `…`###### ` at a line start (up to 3 spaces of indent, CommonMark). */
// Unlike CommonMark, a bare `#` with no space isn't a heading here: it's
// the start of a #tag being typed.
export const HEADING_PREFIX = /^ {0,3}(#{1,6})[ \t]+/;

export interface OutlineItem {
  level: number;
  text: string;
  /** Offset of the start of the heading's line. */
  from: number;
}

/** Every ATX heading outside fenced code, for the table of contents and the
 *  heading toolbar. Empty headings (`## ` with nothing after) are skipped. */
export function outlineOf(s: string, mask: Uint8Array = codeMask(s)): OutlineItem[] {
  const out: OutlineItem[] = [];
  let lineStart = 0;
  while (lineStart <= s.length) {
    const nl = s.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? s.length : nl;
    if (!mask[lineStart]) {
      const line = s.slice(lineStart, lineEnd).replace(/\r$/, "");
      const m = HEADING_PREFIX.exec(line);
      if (m) {
        const text = stripInline(line.slice(m[0].length).replace(/[ \t]+#+[ \t]*$/, "")).trim();
        if (text) out.push({ level: m[1].length, text, from: lineStart });
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return out;
}

/** Inline Markdown markers removed — `**太字**` → `太字`, `[名前](url)` →
 *  `名前`, `[[メモ]]` → `メモ` — for places that show text, not source.
 *  Mirrors `notes::strip_inline` (checked by the shared parity fixture). */
export function stripInline(text: string): string {
  return text
    .replace(/\[\[([^[\]\n]+?)\]\]/g, "$1")
    .replace(/!?\[([^\]]*?)(?:\|\d+)?\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\*/g, "");
}

/** A line with its heading marker removed (`# 買い物` → `買い物`); `#tag`
 *  is a tag, not a heading, and is kept. Mirrors `notes::strip_heading`. */
function stripHeading(line: string): string {
  const t = line.trim();
  const rest = t.replace(/^#+/, "");
  if (rest.length === t.length) return t;
  return rest === "" || /^\s/.test(rest) ? rest.trim() : t;
}

/** The note's display title: its first line that's non-empty once the
 *  heading marker is gone, inline markup removed. Mirrors `notes::title_text`. */
export function titleOf(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = stripHeading(line);
    if (t) return stripInline(t).trim() || "(無題)";
  }
  return "(無題)";
}

function titleLineIndex(body: string): number {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex((l) => stripHeading(l) !== "");
  return i;
}

function stripListMarker(line: string): string {
  const m = /^(?:[-*+]|\d+[.)])[ \t]+/.exec(line);
  if (!m) return line;
  return line.slice(m[0].length).replace(/^\[[ xX]\]\s*/, "");
}

const SNIPPET_LIMIT = 200;

/** The text after the title line as plain text — fences dropped, heading/
 *  quote/list markers and inline markup removed, whitespace collapsed,
 *  capped at 200 characters. Mirrors `notes::snippet_of`. */
export function snippetOf(body: string): string {
  const lines = body.split(/\r?\n/);
  const skip = titleLineIndex(body) + 1;
  const plain: string[] = [];
  for (const line of lines.slice(skip)) {
    const t = line.trimStart();
    if (t.startsWith("```") || t.startsWith("~~~")) continue;
    plain.push(stripInline(stripHeading(stripListMarker(t.replace(/^[> ]+/, "")))));
  }
  const collapsed = plain.join("\n").split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(collapsed);
  return chars.length <= SNIPPET_LIMIT ? collapsed : chars.slice(0, SNIPPET_LIMIT).join("") + "…";
}
