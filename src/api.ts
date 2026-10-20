import { invoke } from "@tauri-apps/api/core";

export type Status = "keep" | "scratch";

export interface Note {
  filename: string;
  status: Status;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  modifiedAt: string;
  isExpiring: boolean;
  charCount: number;
}

/** What the list gets — everything but the full body. */
export interface NoteSummary {
  filename: string;
  status: Status;
  title: string;
  snippet: string;
  tags: string[];
  createdAt: string;
  modifiedAt: string;
  isExpiring: boolean;
  charCount: number;
  /** Pinned to the top of the list. */
  pinned: boolean;
}

export interface NoteFilter {
  status?: Status;
  query?: string;
}

export interface Settings {
  notesDir: string;
  hotkey: string;
  hideOnBlur: boolean;
  expiryDays: number;
  lastStatus: Status;
  indentWidth: number;
  autostart: boolean;
  zoom: number;
}

export interface TagCount {
  tag: string;
  /** Number of notes carrying the tag. */
  count: number;
}

/** Mirrors `commands::NOTE_GONE` — the error for a note no longer on disk. */
export const NOTE_GONE = "that note is gone";

export const listNotes = (filter: NoteFilter) =>
  invoke<NoteSummary[]>("list_notes", { filter });

/** Every tag across all notes, most used first. */
export const listTags = () => invoke<TagCount[]>("list_tags");

/** Rewrites `#from` to `#to` in every note (a merge if `to` exists);
 *  resolves to the number of notes changed. */
export const renameTag = (from: string, to: string) =>
  invoke<number>("rename_tag", { from, to });

export const setPinned = (filename: string, pinned: boolean) =>
  invoke<void>("set_pinned", { filename, pinned });

/** Rewrites `[[from]]` to `[[to]]` in the other notes after `filename`'s
 *  title changed; resolves to how many notes changed. */
export const renameLinks = (from: string, to: string, filename: string) =>
  invoke<number>("rename_links", { from, to, filename });

/** Notes linking to `title` with `[[title]]`, other than `exclude`. */
export const backlinks = (title: string, exclude?: string) =>
  invoke<NoteSummary[]>("backlinks", { title, exclude });

export const getNote =(filename: string) => invoke<Note>("get_note", { filename });

export const createNote = (body: string, status: Status) =>
  invoke<Note>("create_note", { body, status });

export const updateNote = (filename: string, body: string) =>
  invoke<Note>("update_note", { filename, body });

export const setStatus = (filename: string, status: Status) =>
  invoke<Note>("set_status", { filename, status });

export const deleteNote = (filename: string) => invoke<void>("delete_note", { filename });

export const openNotesFolder = () => invoke<void>("open_notes_folder");

export const getSettings = () => invoke<Settings>("get_settings");

export const setSettings = (next: Settings) => invoke<Settings>("set_settings", { next });

/** Sets and persists the UI zoom; resolves to the value actually applied. */
export const setZoom = (zoom: number) => invoke<number>("set_zoom", { zoom });

export const hideWindow = () => invoke<void>("hide_window");

export { extractTags, isTagChar } from "./markdown";

/** The search box's text as highlightable terms: whitespace-separated,
 *  with a leading `#` dropped (`#仕事` should light up `仕事` too). */
export function searchTerms(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^#+/, ""))
    .filter(Boolean);
}

/**
 * How long ago, at the resolution that matters for a note list — recent
 * things read as "how fresh", older things read as an actual date.
 */
export function formatWhen(iso: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, (Date.now() - then) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
