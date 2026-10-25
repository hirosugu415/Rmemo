import { useEffect, useRef, useState } from "react";
import { formatWhen, type NoteSummary } from "../api";

const CONFIRM_MS = 3000;

interface Props {
  note: NoteSummary;
  /** Highlighted because the keyboard cursor (ArrowUp/Down) is on it. */
  selected: boolean;
  onOpen: () => void;
  onToggleStatus: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  onTagClick: (tag: string) => void;
  /** Search terms to mark in the title and snippet. */
  highlight: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with every case-insensitive occurrence of `terms` wrapped in
 *  <mark>, so a result shows at a glance why it matched. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0 || !text) return <>{text}</>;
  // Longest first, so `rust-lang` wins over `rust` where both match.
  const pattern = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "giu"));
  return (
    <>
      {parts.map((part, i) =>
        // split() with one capture group puts the matches at odd indexes.
        i % 2 === 1 ? <mark key={i}>{part}</mark> : part,
      )}
    </>
  );
}

export default function NoteListItem({
  note,
  selected,
  onOpen,
  onToggleStatus,
  onTogglePin,
  onDelete,
  onTagClick,
  highlight,
}: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setConfirmDelete(false);
      onDelete();
      return;
    }
    setConfirmDelete(true);
    confirmTimer.current = setTimeout(() => setConfirmDelete(false), CONFIRM_MS);
  };

  return (
    <div
      className={selected ? "note-row note-row-selected" : "note-row"}
      onClick={onOpen}
    >
      <div className="note-row-header">
        {note.pinned && (
          <span className="note-pin" title="ピン留め中" aria-label="ピン留め中">
            📌
          </span>
        )}
        <span className="note-title">
          <Highlight text={note.title} terms={highlight} />
        </span>
        {note.isExpiring && <span className="badge badge-expiring">まもなく期限切れ</span>}
        {/* Counted by the backend when the file is read/saved and cached —
            showing it costs nothing per list render. */}
        <span className="note-chars" title="文字数（改行は数えません）">
          {note.charCount.toLocaleString()}字
        </span>
        <span className="note-when">{formatWhen(note.modifiedAt)}</span>
      </div>

      <div className="note-snippet">
        {note.snippet ? <Highlight text={note.snippet} terms={highlight} /> : "(空)"}
      </div>

      {note.tags.length > 0 && (
        <div className="note-tags">
          {note.tags.map((t) => (
            <button
              key={t}
              type="button"
              className="tag-pill"
              onClick={(e) => {
                e.stopPropagation();
                onTagClick(t);
              }}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="note-row-actions">
        <button
          type="button"
          className={note.pinned ? "row-action row-action-pinned" : "row-action"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          {note.pinned ? "ピン解除" : "ピン留め"}
        </button>
        <button
          type="button"
          className="row-action"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStatus();
          }}
        >
          {note.status === "keep" ? "→ 一時" : "→ 保管"}
        </button>
        <button
          type="button"
          className={confirmDelete ? "row-action row-action-danger" : "row-action"}
          onClick={handleDeleteClick}
        >
          {confirmDelete ? "もう一度クリックでゴミ箱へ" : "削除"}
        </button>
      </div>
    </div>
  );
}
