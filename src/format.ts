// "整形": turns the habits of a plain-text note into Markdown, for notes
// imported from old `.txt` files. Proposed per note and shown side by side
// before anything is applied, so every rule only has to be right most of the
// time — the user sees each change.
//
// Rules (outside code fences only):
// 1. Three or more blank lines in a row → a `---` rule (the blank lines
//    around it stay, or the line above would become a setext heading).
// 2. `・項目` lines → `- 項目`, indented by leading spaces / full-width
//    spaces. An unindented `・ラベル` directly followed by unmarked lines is a
//    label, not an item: `### ラベル`, and those lines become `- ` items.
// 3. A short line ending in `：` / `:` that introduces the next line →
//    `### ラベル`.

/** Replace lines `[from, to)` (0-based) with `insert`. */
export interface FormatEdit {
  from: number;
  to: number;
  insert: string[];
}

const BULLET = /^([ 　]*)[・･]\s*(.*)$/;
/** Lines that already carry Markdown structure of their own. */
const MARKED = /^\s*([・･#>|]|[-*+] |\d+[.)] |```|~~~)/;
const LABEL_MAX = 20;
const FENCE = /^ {0,3}(```|~~~)/;

const isBlank = (line: string) => line.trim() === "";

/** Indent of a `・` line as list nesting: two spaces or one full-width
 *  space per level. */
function nesting(indent: string): string {
  let width = 0;
  for (const c of indent) width += c === "　" ? 2 : 1;
  return "  ".repeat(Math.floor(width / 2));
}

function labelOf(line: string): string | null {
  if (line !== line.trimStart() || MARKED.test(line) || /https?:/.test(line)) return null;
  const m = /^(.+?)\s*[：:]\s*$/.exec(line);
  if (!m || [...m[1]].length > LABEL_MAX || /[：:]/.test(m[1])) return null;
  return m[1];
}

export function formatEdits(text: string): FormatEdit[] {
  const lines = text.split("\n");
  const edits: FormatEdit[] = [];
  const inFence = new Array<boolean>(lines.length).fill(false);
  let fence = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      inFence[i] = true;
      fence = !fence;
    } else {
      inFence[i] = fence;
    }
  });

  let i = 0;
  while (i < lines.length) {
    if (inFence[i]) {
      i++;
      continue;
    }
    const line = lines[i];

    // 1. A run of blank lines between two lines of text.
    if (isBlank(line)) {
      let end = i;
      while (end < lines.length && isBlank(lines[end]) && !inFence[end]) end++;
      if (end - i >= 3 && i > 0 && end < lines.length) {
        edits.push({ from: i, to: end, insert: ["", "---", ""] });
      }
      i = end;
      continue;
    }

    // 2. `・` lines.
    const bullet = BULLET.exec(line);
    if (bullet) {
      const [, indent, rest] = bullet;
      let end = i + 1;
      while (end < lines.length && !inFence[end] && !isBlank(lines[end]) && !MARKED.test(lines[end])) {
        end++;
      }
      if (indent === "" && end > i + 1) {
        edits.push({
          from: i,
          to: end,
          insert: [`### ${rest}`, ...lines.slice(i + 1, end).map((l) => `- ${l.trim()}`)],
        });
        i = end;
      } else {
        edits.push({ from: i, to: i + 1, insert: [`${nesting(indent)}- ${rest}`] });
        i++;
      }
      continue;
    }

    // 3. `機能：` introducing what follows.
    const label = labelOf(line);
    if (label !== null && i + 1 < lines.length && !isBlank(lines[i + 1])) {
      edits.push({ from: i, to: i + 1, insert: [`### ${label}`] });
    }
    i++;
  }
  return edits;
}

export function applyEdits(text: string, edits: FormatEdit[]): string {
  const lines = text.split("\n");
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    lines.splice(e.from, e.to - e.from, ...e.insert);
  }
  return lines.join("\n");
}
