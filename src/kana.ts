/** Mirrors `notes::kana::fold` (Rust) for highlighting search hits: one
 *  UTF-16 unit in, one out, so indexes in folded text are indexes in the
 *  original. Katakana → hiragana, full-width ASCII → ASCII, half-width
 *  katakana → hiragana, lowercase. */

const HALFWIDTH =
  "。「」、・をぁぃぅぇぉゃゅょっーあいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわん゛゜";

function foldUnit(code: number): string {
  if (code >= 0x30a1 && code <= 0x30f6) return String.fromCharCode(code - 0x60);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0).toLowerCase();
  if (code >= 0xff61 && code <= 0xff9f) return HALFWIDTH[code - 0xff61];
  if (code === 0x3000) return " ";
  const c = String.fromCharCode(code);
  const lower = c.toLowerCase();
  // A lowercase that changes length would shift every index after it.
  return lower.length === 1 ? lower : c;
}

export function foldText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldUnit(text.charCodeAt(i));
  return out;
}

/** [start, end) ranges in `text` where any of the (already folded)
 *  `needles` occurs, longest needle first, without overlaps. */
export function findMatches(text: string, needles: string[]): [number, number][] {
  const folded = foldText(text);
  const sorted = [...new Set(needles.filter(Boolean))].sort((a, b) => b.length - a.length);
  const taken: [number, number][] = [];
  for (const n of sorted) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(n, from);
      if (at === -1) break;
      const end = at + n.length;
      if (!taken.some(([s, e]) => at < e && end > s)) taken.push([at, end]);
      from = at + 1;
    }
  }
  return taken.sort((a, b) => a[0] - b[0]);
}
