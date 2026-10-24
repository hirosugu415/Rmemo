import { Component, type ReactNode, useEffect, useRef, useState } from "react";
import { getNote, rewriteNote, type ImportReport, type Note } from "../api";
import { applyEdits, formatEdits } from "../format";
import { lineDiff, type DiffBlock } from "../lineDiff";

/** applied: the right side was kept; declined: put back to the `.txt` as
 *  it was; clean: identical to the `.txt`, passed over; missing: the note
 *  is gone. */
type Verdict = "applied" | "declined" | "clean" | "missing";

interface Props {
  /** The import that just ran; its `files` are walked one by one. */
  report: ImportReport;
  /** Leaves the review and opens the note for editing. */
  onOpen: (note: Note) => void;
  onExit: () => void;
}

interface Slot {
  verdict: Verdict;
  /** For a decision: the note's name after it and its text before, so
   *  stepping back can put it back. */
  filename?: string;
  before?: string;
}

/**
 * Right after an import: walks the new notes one at a time, the original
 * `.txt` beside what it becomes — every change shown, the import's own
 * (heading, tags…) as well as the 整形 (format.ts). Enter applies, S
 * declines — the note goes back to the `.txt` word for word — E opens it to
 * edit, ← steps back (undoing either).
 * Notes identical to their `.txt` are passed over without stopping.
 */
export default function FormatReview(props: Props) {
  return (
    <ReviewBoundary onExit={props.onExit}>
      <Review {...props} />
    </ReviewBoundary>
  );
}

/** A render error in the review shows itself instead of blanking the whole
 *  window (React unmounts everything on an uncaught one). */
class ReviewBoundary extends Component<{ onExit: () => void; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e) };
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="triage">
        <div className="view-title triage-title" data-drag-region>
          <span>取り込みの整形</span>
        </div>
        <div className="triage-done">
          <div className="triage-done-title">整形画面でエラーが起きました</div>
          <div className="triage-message review-error">{this.state.error}</div>
          <div className="triage-actions">
            <button type="button" className="triage-btn" onClick={this.props.onExit}>
              終了
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** What `note` becomes on 適用, beside its `.txt` — or null when the two
 *  are the same (trailing newlines aside: the import always ends with one). */
function prepare(note: Note, original: string) {
  const body = note.body.replace(/\r\n/g, "\n");
  const edits = formatEdits(body);
  const after = edits.length > 0 ? applyEdits(body, edits) : body;
  const trimmed = original.trimEnd();
  if (trimmed === after.trimEnd()) return null;
  return {
    after,
    edits: edits.length,
    blocks: lineDiff(trimmed.split("\n"), after.trimEnd().split("\n")),
  };
}

function Review({ report, onOpen, onExit }: Props) {
  const queue = report.files;
  const [index, setIndex] = useState(0);
  const [slots, setSlots] = useState<Slot[]>([]);
  /** Queue slots whose note now goes by another name (an undone apply can
   *  land on a different one than the import gave it). */
  const [renamed, setRenamed] = useState<Record<number, string>>({});
  const [current, setCurrent] = useState<{
    note: Note;
    /** The note as the right side shows it (the import plus the 整形). */
    after: string;
    edits: number;
    blocks: DiffBlock[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** The すべて適用 confirmation is showing in place of the buttons. */
  const [confirmAll, setConfirmAll] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => rootRef.current?.focus(), []);

  const record = (at: number, slot: Slot) => {
    setSlots((s) => {
      const next = [...s];
      next[at] = slot;
      return next;
    });
    setIndex(at + 1);
  };

  // Load the note at `index`; one identical to its `.txt` is recorded and
  // passed straight over.
  useEffect(() => {
    setCurrent(null);
    if (index >= queue.length) return;
    let live = true;
    const at = index;
    getNote(renamed[at] ?? queue[at].filename)
      .then((note) => {
        if (!live) return;
        const prepared = prepare(note, queue[at].original);
        if (prepared) setCurrent({ note, ...prepared });
        else record(at, { verdict: "clean" });
      })
      // Renamed or deleted since the import (edited in Explorer, say).
      .catch(() => live && record(at, { verdict: "missing" }));
    return () => {
      live = false;
    };
    // `renamed` changes only together with `index` (see `back`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, queue]);

  /** Saves the note as `text` (a no-op on disk when it already is). */
  const decide = (verdict: "applied" | "declined", text: string) => {
    if (!current || busy) return;
    const { note } = current;
    setBusy(true);
    setMessage(null);
    rewriteNote(note.filename, text)
      .then((saved) => record(index, { verdict, filename: saved.filename, before: note.body }))
      .catch((e) => setMessage(String(e)))
      .finally(() => setBusy(false));
  };
  const apply = () => current && decide("applied", current.after);

  const askApplyAll = () => {
    if (!current || busy) return;
    setConfirmAll(true);
    // The safe choice under the caret: a stray Enter cancels, not applies.
    requestAnimationFrame(() => confirmCancelRef.current?.focus());
  };

  const cancelApplyAll = () => {
    setConfirmAll(false);
    rootRef.current?.focus();
  };

  /** 適用 for this note and every one after it, without stopping. Each is
   *  recorded like a single 適用, so ← still takes them back one by one. */
  const applyAll = async () => {
    if (busy) return;
    setConfirmAll(false);
    setBusy(true);
    const failed: string[] = [];
    const next = [...slots];
    for (let at = index; at < queue.length; at++) {
      setMessage(`適用中… ${at - index + 1} / ${queue.length - index}`);
      try {
        const note = await getNote(renamed[at] ?? queue[at].filename);
        const prepared = prepare(note, queue[at].original);
        if (!prepared) {
          next[at] = { verdict: "clean" };
          continue;
        }
        const saved = await rewriteNote(note.filename, prepared.after);
        next[at] = { verdict: "applied", filename: saved.filename, before: note.body };
      } catch (e) {
        next[at] = { verdict: "missing" };
        failed.push(`${queue[at].filename}: ${e}`);
      }
    }
    setSlots(next);
    setIndex(queue.length);
    setMessage(failed.length > 0 ? `適用できなかったメモ: ${failed.join("、")}` : null);
    setBusy(false);
    rootRef.current?.focus();
  };
  const decline = () => decide("declined", queue[index].original);

  /** The last note that stopped for a decision (passed-over ones would just
   *  pass over again). */
  const previous = (() => {
    for (let i = Math.min(index, queue.length) - 1; i >= 0; i--) {
      const v = slots[i]?.verdict;
      if (v === "applied" || v === "declined") return i;
    }
    return -1;
  })();

  const back = () => {
    if (busy || previous < 0) return;
    setMessage(null);
    const slot = slots[previous];
    if (slot.filename && slot.before !== undefined) {
      // Stepping back undoes the decision, so the note can be re-decided.
      setBusy(true);
      rewriteNote(slot.filename, slot.before)
        .then((restored) => {
          setRenamed((r) => ({ ...r, [previous]: restored.filename }));
          setIndex(previous);
        })
        .catch((e) => setMessage(String(e)))
        .finally(() => setBusy(false));
      return;
    }
    setIndex(previous);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.nativeEvent.isComposing) return;
    if (confirmAll) {
      // Only the confirmation's own buttons act while it's up; Esc backs out
      // of it rather than leaving the review.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelApplyAll();
      }
      return;
    }
    if ((e.target as HTMLElement).tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.key === "Enter") apply();
    else if (key === "s" || e.key === "ArrowRight") decline();
    else if (e.key === "ArrowLeft") back();
    else if (key === "e" && current) onOpen(current.note);
    else if (key === "a") askApplyAll();
    else handled = false;
    if (handled) e.preventDefault();
  };

  const counts = { applied: 0, declined: 0, clean: 0, missing: 0 };
  for (const s of slots) if (s) counts[s.verdict]++;
  const done = index >= queue.length;

  return (
    <div className="triage" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="view-title triage-title" data-drag-region>
        <span>取り込みの整形</span>
        {!done && (
          <span className="triage-progress">
            {index + 1} / {queue.length}
          </span>
        )}
      </div>
      <div className="triage-toolbar">
        <span className="review-summary">{report.imported.toLocaleString()} 件を取り込みました</span>
        <button type="button" className="chip" onClick={onExit}>
          終了 (Esc)
        </button>
      </div>

      {!done ? (
        current ? (
          <>
            <div className="triage-card">
              <div className="triage-card-header">
                <span className="triage-card-title">{current.note.title}</span>
              </div>
              <div className="triage-meta">
                変更: {current.blocks.filter((b) => b.changed).length} か所 ・ 左が元の txt、右が取り込み後
                {current.edits > 0 ? `（うち整形 ${current.edits} か所）` : ""}
              </div>
              <SideBySide blocks={current.blocks} />
            </div>
            {message && <div className="triage-message">{message}</div>}
            {confirmAll ? (
              <div className="review-confirm" role="alertdialog" aria-label="すべて適用の確認">
                <div className="review-confirm-text">
                  このメモを含めた残り <strong>{queue.length - index} 件</strong>
                  に、右側の変更（見出し・タグ・整形）をまとめて適用します。1 件ずつの確認はしません。
                  <br />
                  適用したあとも、「戻る」で 1 件ずつ元に戻せます。
                </div>
                <div className="triage-actions">
                  <button type="button" className="triage-btn triage-keep" onClick={applyAll}>
                    {queue.length - index} 件すべてに適用する
                  </button>
                  <button type="button" className="triage-btn" ref={confirmCancelRef} onClick={cancelApplyAll}>
                    やめる (Esc)
                  </button>
                </div>
              </div>
            ) : (
              <div className="triage-actions">
                <button type="button" className="triage-btn triage-keep" disabled={busy} onClick={apply}>
                  <kbd>Enter</kbd> 適用
                </button>
                <button
                  type="button"
                  className="triage-btn"
                  title="右の変更をどれも入れず、元の txt のままにする（見出し・タグも付けない）"
                  disabled={busy}
                  onClick={decline}
                >
                  <kbd>S</kbd> 適用しない
                </button>
                <button type="button" className="triage-btn" disabled={busy} onClick={() => onOpen(current.note)}>
                  <kbd>E</kbd> 開いて編集
                </button>
                <button type="button" className="triage-btn" disabled={busy || previous < 0} onClick={back}>
                  <kbd>←</kbd> 戻る
                </button>
                <button
                  type="button"
                  className="triage-btn"
                  title="このメモと残りすべてに、確認なしで適用する"
                  disabled={busy}
                  onClick={askApplyAll}
                >
                  <kbd>A</kbd> すべて適用
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="empty">読み込み中…</div>
        )
      ) : (
        <div className="triage-done">
          <div className="triage-done-title">整形完了</div>
          <div className="triage-done-counts">
            取り込んだメモは Keep にあります。元のファイルの日付で並ぶので、一覧では下のほうに入ります。
          </div>
          <div className="triage-done-counts">
            適用 {counts.applied}件 ・ 適用しない {counts.declined}件 ・ 変更なし {counts.clean}件
            {counts.missing > 0 && ` ・ 見つからない ${counts.missing}件`}
          </div>
          {(report.duplicates > 0 || report.empty > 0) && (
            <div className="triage-done-counts">
              取り込み時に飛ばしたもの: 取り込み済み {report.duplicates}件 ・ 空のファイル {report.empty}件
            </div>
          )}
          {report.garbled.length > 0 && (
            <div className="triage-message">文字化けしている可能性があります: {report.garbled.join("、")}</div>
          )}
          {report.failed.length > 0 && (
            <div className="triage-message">取り込めなかったファイル: {report.failed.join("、")}</div>
          )}
          {message && <div className="triage-message">{message}</div>}
          <div className="triage-actions">
            <button type="button" className="triage-btn" onClick={back} disabled={previous < 0}>
              <kbd>←</kbd> 最後の1件に戻る
            </button>
            <button type="button" className="triage-btn" onClick={onExit}>
              終了
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The whole note before and after, block by block in one grid so the two
 *  sides stay level, changes tinted. Opens scrolled to the first change. */
function SideBySide({ blocks }: { blocks: DiffBlock[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const firstChange = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll this box only — `scrollIntoView` would also scroll every
    // ancestor, overflow: hidden ones included, shoving the whole app aside.
    const box = boxRef.current;
    const row = firstChange.current;
    if (box && row) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 3);
  }, [blocks]);
  let seenChange = false;
  return (
    <div className="review-diff" ref={boxRef}>
      {blocks.map((b, i) => {
        const ref = b.changed && !seenChange ? firstChange : undefined;
        if (b.changed) seenChange = true;
        return (
          <div key={i} className="review-row" ref={ref}>
            <Lines className={b.changed ? "review-side format-before" : "review-side"} lines={b.before} />
            <Lines className={b.changed ? "review-side format-after" : "review-side"} lines={b.after} />
          </div>
        );
      })}
    </div>
  );
}

function Lines({ className, lines }: { className: string; lines: string[] }) {
  return (
    <div className={className}>
      {lines.map((l, i) => (
        // A no-break space keeps a blank line one line tall.
        <div key={i}>{l === "" ? " " : l}</div>
      ))}
    </div>
  );
}
