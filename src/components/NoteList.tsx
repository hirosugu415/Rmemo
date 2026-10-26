import { useEffect, useRef } from "react";
import type { NoteSummary } from "../api";
import NoteListItem from "./NoteListItem";

interface Props {
  notes: NoteSummary[];
  selectedIndex: number;
  onOpen: (index: number) => void;
  onToggleStatus: (note: NoteSummary) => void;
  onTogglePin: (note: NoteSummary) => void;
  onDelete: (filename: string) => void;
  onTagClick: (tag: string) => void;
  highlight: string[];
  /** Changes when the results are a different set (a new query or filter),
   *  which is the one time the list goes back to the top. */
  resetKey: string;
}

export default function NoteList({
  notes,
  selectedIndex,
  onOpen,
  onToggleStatus,
  onTogglePin,
  onDelete,
  onTagClick,
  highlight,
  resetKey,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [resetKey]);

  // Keep the keyboard cursor in view as ArrowUp/Down walks past the visible
  // edge: scroll just far enough that the selected row is fully shown.
  // Only on a cursor move — not when the notes change (a delete, a watcher
  // refresh), or a list scrolled by the wheel would jump back to the
  // cursor, which is still on the first row.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[selectedIndex] as HTMLElement | undefined;
    if (!list || !row) return;
    const listBox = list.getBoundingClientRect();
    const rowBox = row.getBoundingClientRect();
    if (rowBox.top < listBox.top) {
      list.scrollTop -= listBox.top - rowBox.top;
    } else if (rowBox.bottom > listBox.bottom) {
      list.scrollTop += rowBox.bottom - listBox.bottom;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  if (notes.length === 0) {
    return <div className="empty">見つかりませんでした。</div>;
  }

  return (
    <div className="list" ref={listRef}>
      {notes.map((note, index) => (
        <NoteListItem
          key={note.filename}
          note={note}
          selected={index === selectedIndex}
          onOpen={() => onOpen(index)}
          onToggleStatus={() => onToggleStatus(note)}
          onTogglePin={() => onTogglePin(note)}
          onDelete={() => onDelete(note.filename)}
          onTagClick={onTagClick}
          highlight={highlight}
        />
      ))}
    </div>
  );
}
