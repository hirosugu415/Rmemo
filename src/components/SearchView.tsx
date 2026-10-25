import { useEffect, useRef, useState } from "react";
import { searchTerms, type NoteSummary, type Status, type TagCount } from "../api";
import NoteList from "./NoteList";
import TagCloud from "./TagCloud";
import { type Keymap, withKey } from "../keybindings";

interface Props {
  notes: NoteSummary[];
  /** Every tag across every note, most used first. */
  tags: TagCount[];
  query: string;
  onQueryChange: (query: string) => void;
  statusFilter: Status | "all";
  onStatusFilterChange: (status: Status | "all") => void;
  onOpenSettings: () => void;
  keymap: Keymap;
  /** Back to the compose box (the same as Esc). */
  onClose: () => void;
  /** Expiring scratch notes — shown on the triage button. */
  expiringCount: number;
  onOpenTriage: () => void;
  onOpenNote: (note: NoteSummary) => void;
  onToggleStatus: (note: NoteSummary) => void;
  onTogglePin: (note: NoteSummary) => void;
  onDelete: (filename: string) => void;
  onRenameTag: (from: string, to: string) => Promise<string | null>;
}

export default function SearchView({
  notes,
  tags,
  query,
  onQueryChange,
  statusFilter,
  onStatusFilterChange,
  onOpenSettings,
  keymap,
  onClose,
  expiringCount,
  onOpenTriage,
  onOpenNote,
  onToggleStatus,
  onTogglePin,
  onDelete,
  onRenameTag,
}: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // While an IME is composing, the input's own value must not be clobbered
  // by a re-render — only the committed text (on compositionend) should
  // trigger a search.
  const composing = useRef(false);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, statusFilter]);

  // The list can shrink under the cursor (a delete, a watcher refresh).
  useEffect(() => {
    setSelectedIndex((i) => Math.max(0, Math.min(i, notes.length - 1)));
  }, [notes.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);


  const handleTagClick = (tag: string) => {
    onStatusFilterChange("all");
    onQueryChange(`#${tag}`);
    inputRef.current?.focus();
  };

  const last = notes.length - 1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.ctrlKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }

    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "KeyL") {
      e.preventDefault();
      const note = notes[selectedIndex];
      if (note) onToggleStatus(note);
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, last));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter": {
        const note = notes[selectedIndex];
        if (note) {
          e.preventDefault();
          onOpenNote(note);
        }
        break;
      }
    }
  };

  return (
    <div className="search-view" onKeyDown={onKeyDown}>
      <div className="view-title view-title-row" data-drag-region>
        <span>メモの一覧・検索</span>
        <button type="button" className="compose-find-btn" onClick={onClose}>
          メモに戻る (Esc)
        </button>
      </div>
      <div className="searchbar">
        <input
          ref={inputRef}
          className="search"
          value={query}
          spellCheck={false}
          placeholder="検索…"
          onChange={(e) => onQueryChange(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            onQueryChange(e.currentTarget.value);
          }}
        />
        <div className="chips">
          {(["all", "keep", "scratch"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={statusFilter === s ? "chip chip-active" : "chip"}
              onClick={() => onStatusFilterChange(s)}
            >
              {s === "all" ? "すべて" : s === "keep" ? "保管" : "一時"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="chip triage-open"
          title="一時のメモを1件ずつ 保管 / ゴミ箱 / あとで に振り分ける"
          onClick={onOpenTriage}
        >
          整理
          {expiringCount > 0 && <span className="triage-open-count">{expiringCount}</span>}
        </button>
        <button className="gear" title={withKey("設定", keymap.openSettings)} onClick={onOpenSettings}>
          ⚙
        </button>
      </div>

      {query.trim() === "" && tags.length > 0 && (
        <TagCloud tags={tags} onTagClick={handleTagClick} onRenameTag={onRenameTag} />
      )}

      <NoteList
        notes={notes}
        selectedIndex={selectedIndex}
        onOpen={(index) => {
          const note = notes[index];
          if (note) onOpenNote(note);
        }}
        onToggleStatus={onToggleStatus}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
        onTagClick={handleTagClick}
        highlight={searchTerms(query)}
      />
    </div>
  );
}
