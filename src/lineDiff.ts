// Line diff for the 整形 review: the original `.txt` against the note it
// became. Longest common subsequence over lines, after peeling off the common
// head and tail — imports change a few lines (a heading on top, tags at the
// bottom), so what's left in the middle is usually tiny.

export interface DiffBlock {
  before: string[];
  after: string[];
  changed: boolean;
}

/** Above this many cells the middle is shown as one changed block rather
 *  than spending tens of MB on the LCS table. */
const LCS_LIMIT = 4_000_000;

export function lineDiff(a: string[], b: string[]): DiffBlock[] {
  const out: DiffBlock[] = [];
  const push = (before: string[], after: string[], changed: boolean) => {
    if (before.length === 0 && after.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.changed === changed) {
      last.before.push(...before);
      last.after.push(...after);
    } else {
      out.push({ before: [...before], after: [...after], changed });
    }
  };

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++;
  }
  const same = a.slice(0, head);
  push(same, same, false);

  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length * bm.length > LCS_LIMIT) {
    push(am, bm, true);
  } else {
    // lcs[i * w + j]: LCS length of am[i..] and bm[j..].
    const w = bm.length + 1;
    const lcs = new Int32Array((am.length + 1) * w);
    for (let i = am.length - 1; i >= 0; i--) {
      for (let j = bm.length - 1; j >= 0; j--) {
        lcs[i * w + j] =
          am[i] === bm[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < am.length || j < bm.length) {
      if (i < am.length && j < bm.length && am[i] === bm[j]) {
        push([am[i]], [bm[j]], false);
        i++;
        j++;
      } else if (j >= bm.length || (i < am.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
        push([am[i]], [], true);
        i++;
      } else {
        push([], [bm[j]], true);
        j++;
      }
    }
  }

  const end = a.slice(a.length - tail);
  push(end, end, false);
  return out;
}
