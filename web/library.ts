// Reads the notes folder from Drive into memory: keep/ and scratch/ `.md`
// files, the shared `assets/` images and `.rmemo/pins.json` — the same
// layout the desktop app writes. Bodies are kept in Cache Storage keyed by
// (file id, modified time), so a refresh only downloads what changed and the
// last snapshot opens offline.

import { foldText } from "../src/kana";
import { charCount, extractTags, snippetOf, titleOf } from "../src/markdown";
import { type DriveApi, type DriveFile, FOLDER_MIME } from "./drive";

export type Status = "keep" | "scratch";

export interface WebNote {
  id: string;
  filename: string;
  status: Status;
  title: string;
  body: string;
  snippet: string;
  tags: string[];
  charCount: number;
  modifiedAt: string;
  createdAt: string;
  pinned: boolean;
}

export interface Library {
  notes: WebNote[];
  /** `assets/` file name → Drive file, for resolving `![](../assets/…)`. */
  assets: Record<string, DriveFile>;
  loadedAt: string;
}

const DATA_CACHE = "rmemo-data";
const SNAPSHOT_KEY = "https://rmemo.local/snapshot";
const noteKey = (f: DriveFile) => `https://rmemo.local/note/${f.id}?m=${encodeURIComponent(f.modifiedTime)}`;
const imageKey = (f: DriveFile) => `https://rmemo.local/img/${f.id}?m=${encodeURIComponent(f.modifiedTime)}`;

const openCache = () => (typeof caches === "undefined" ? Promise.resolve(null) : caches.open(DATA_CACHE).catch(() => null));

/** Runs `fn` over `items` with at most `limit` in flight. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function makeNote(file: DriveFile, status: Status, body: string, pinned: boolean): WebNote {
  return {
    id: file.id,
    filename: file.name,
    status,
    title: titleOf(body),
    body,
    snippet: snippetOf(body),
    tags: extractTags(body),
    charCount: charCount(body),
    modifiedAt: file.modifiedTime,
    createdAt: file.createdTime,
    pinned,
  };
}

/** Pinned first (in pin order), then most recently modified — like the app. */
export function sortNotes(notes: WebNote[], pins: string[]): WebNote[] {
  const rank = (n: WebNote) => {
    const i = pins.findIndex((p) => p.toLowerCase() === n.filename.toLowerCase());
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...notes].sort((a, b) => rank(a) - rank(b) || b.modifiedAt.localeCompare(a.modifiedAt));
}

export async function loadLibrary(
  api: DriveApi,
  rootId: string,
  onProgress: (done: number, total: number) => void,
): Promise<Library> {
  const top = await api.listChildren(rootId);
  const sub = (name: string) => top.find((f) => f.mimeType === FOLDER_MIME && f.name === name);
  const keep = sub("keep");
  const scratch = sub("scratch");
  if (!keep && !scratch) {
    throw new Error("このフォルダに keep / scratch がありません。Rmemo のメモの保存フォルダを選んでください。");
  }
  const [keepFiles, scratchFiles, assetFiles, dotFiles] = await Promise.all([
    keep ? api.listChildren(keep.id) : [],
    scratch ? api.listChildren(scratch.id) : [],
    sub("assets") ? api.listChildren(sub("assets")!.id) : [],
    sub(".rmemo") ? api.listChildren(sub(".rmemo")!.id) : [],
  ]);

  const pinsFile = dotFiles.find((f) => f.name === "pins.json");
  let pins: string[] = [];
  if (pinsFile) {
    try {
      pins = JSON.parse(await api.downloadText(pinsFile.id));
    } catch {
      pins = [];
    }
  }
  const pinned = (name: string) => pins.some((p) => p.toLowerCase() === name.toLowerCase());

  const md = (files: DriveFile[], status: Status) =>
    files.filter((f) => f.name.toLowerCase().endsWith(".md")).map((f) => ({ f, status }));
  const targets = [...md(keepFiles, "keep"), ...md(scratchFiles, "scratch")];
  const cache = await openCache();
  let done = 0;
  onProgress(0, targets.length);
  const notes = await pool(targets, 6, async ({ f, status }) => {
    let body: string | undefined;
    const hit = await cache?.match(noteKey(f));
    if (hit) body = await hit.text();
    else {
      body = await api.downloadText(f.id);
      await cache?.put(noteKey(f), new Response(body));
    }
    onProgress(++done, targets.length);
    return makeNote(f, status, body, pinned(f.name));
  });

  const assets: Record<string, DriveFile> = {};
  for (const a of assetFiles) assets[a.name] = a;

  const library: Library = { notes: sortNotes(notes, pins), assets, loadedAt: new Date().toISOString() };
  if (cache) {
    await cache.put(SNAPSHOT_KEY, new Response(JSON.stringify(library)));
    // Drop cached bodies of notes that changed or are gone.
    const live = new Set([...targets.map(({ f }) => noteKey(f)), ...assetFiles.map(imageKey), SNAPSHOT_KEY]);
    for (const req of await cache.keys()) if (!live.has(req.url)) await cache.delete(req);
  }
  return library;
}

/** The last library loaded on this device, for an instant (or offline) start. */
export async function loadSnapshot(): Promise<Library | null> {
  const cache = await openCache();
  const hit = await cache?.match(SNAPSHOT_KEY);
  if (!hit) return null;
  try {
    return (await hit.json()) as Library;
  } catch {
    return null;
  }
}

export async function clearData() {
  if (typeof caches !== "undefined") await caches.delete(DATA_CACHE);
}

const objectUrls = new Map<string, Promise<string | null>>();

/** A displayable URL for an `assets/` image: from the cache, else Drive. */
export function imageUrl(api: DriveApi, file: DriveFile): Promise<string | null> {
  let p = objectUrls.get(file.id);
  if (!p) {
    p = (async () => {
      const cache = await openCache();
      let blob: Blob | undefined;
      const hit = await cache?.match(imageKey(file));
      if (hit) blob = await hit.blob();
      else {
        blob = await api.downloadBlob(file.id);
        await cache?.put(imageKey(file), new Response(blob));
      }
      return URL.createObjectURL(blob);
    })().catch(() => null);
    objectUrls.set(file.id, p);
  }
  return p;
}

/** Every term must hit the title, the body, or a tag (`#仕事` also matches
 *  the tag `仕事`) — the desktop search's rule. */
/** Kana / width / case don't matter, as on the desktop (romaji reading is
 *  desktop-only). */
export function searchNotes(notes: WebNote[], query: string, status: Status | "all"): WebNote[] {
  const terms = foldText(query.trim()).split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (status !== "all" && n.status !== status) return false;
    const title = foldText(n.title);
    const body = foldText(n.body);
    return terms.every((q) => {
      const bare = q.replace(/^#+/, "") || q;
      return title.includes(q) || body.includes(q) || n.tags.some((t) => foldText(t).includes(bare));
    });
  });
}

/** Notes linking to `title` with `[[title]]` (case-insensitive). */
export function backlinksOf(notes: WebNote[], target: WebNote): WebNote[] {
  const needle = `[[${target.title.toLowerCase()}]]`;
  return notes.filter((n) => n.id !== target.id && n.body.toLowerCase().includes(needle));
}
