import { useEffect, useRef, useState } from "react";
import { formatWhen, listHistory, readHistory, type NoteVersion } from "../api";
import MarkdownView from "./MarkdownView";

interface Props {
  filename: string;
  title: string;
  /** The text in the editor now, to say how a version differs. */
  currentBody: string;
  onRestore: (body: string) => void;
  onClose: () => void;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The open note's earlier versions (kept by the backend while it's edited):
 * pick one on the left, read it on the right, and put it back. Restoring
 * keeps the current text as a version first, so it can be undone here too.
 */
export default function HistoryView({ filename, title, currentBody, onRestore, onClose }: Props) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [index, setIndex] = useState(0);
  const [body, setBody] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listHistory(filename)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [filename]);

  const selected = versions?.[index];
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setBody(null);
    readHistory(filename, selected.id)
      .then((b) => live && setBody(b))
      .catch(() => live && setBody(""));
    return () => {
      live = false;
    };
  }, [filename, selected]);

  useEffect(() => {
    listRef.current?.focus();
  }, [versions]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!versions?.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, Math.min(versions.length - 1, i + (e.key === "ArrowDown" ? 1 : -1))));
    }
  };

  const same = body !== null && body === currentBody;
  const delta = body === null ? 0 : [...body].length - [...currentBody].length;

  return (
    <div className="history-view">
      <div className="view-title view-title-row" data-drag-region>
        <span>履歴: {title}</span>
        <button type="button" className="compose-find-btn" onClick={onClose}>
          メモに戻る (Esc)
        </button>
      </div>
      {versions === null ? null : versions.length === 0 ? (
        <div className="empty">
          まだ前の版はありません。
          <br />
          編集すると、10 分ごとに直前の内容がこの PC に残ります。
        </div>
      ) : (
        <div className="history-body">
          <div className="history-list" ref={listRef} tabIndex={0} onKeyDown={onKeyDown} role="listbox">
            {versions.map((v, i) => (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={i === index}
                className={i === index ? "history-item history-item-active" : "history-item"}
                onClick={() => setIndex(i)}
              >
                <span className="history-when">
                  {when(v.savedAt)}
                  <small>{formatWhen(v.savedAt)}</small>
                </span>
                <span className="history-meta">
                  {v.title !== title && <span className="history-title">{v.title}</span>}
                  {v.charCount.toLocaleString()}字
                </span>
              </button>
            ))}
          </div>
          <div className="history-preview">
            {body !== null && <MarkdownView className="history-doc" body={body} />}
            <div className="history-actions">
              <span className="history-note">
                {same
                  ? "今の内容と同じです"
                  : body === null
                    ? ""
                    : `今の内容より ${Math.abs(delta).toLocaleString()} 字${delta >= 0 ? "多い" : "少ない"}`}
              </span>
              <button
                type="button"
                className="compose-save compose-save-primary"
                disabled={body === null || same}
                onClick={() => body !== null && onRestore(body)}
              >
                この版に戻す
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
