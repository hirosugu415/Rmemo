import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownView from "../src/components/MarkdownView";
import { setPlatform } from "../src/platform";
import { forgetToken, signIn, signOut, storedToken } from "./auth";
import { AuthError, type DriveApi, type DriveFile, googleDrive, parseFolderId } from "./drive";
import {
  backlinksOf,
  clearData,
  imageUrl,
  type Library,
  loadLibrary,
  loadSnapshot,
  searchNotes,
  type Status,
  type WebNote,
} from "./library";
import { MOCK_FOLDER_ID, mockDrive } from "./mockDrive";

// ---------- settings (this device only) ----------

interface Config {
  clientId?: string;
  folderId?: string;
  folderName?: string;
}

const CONFIG_KEY = "rmemo.web.config";
const ENV_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
const MOCK = import.meta.env.DEV && new URLSearchParams(location.search).has("mock");

function readConfig(): Config {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeConfig(c: Config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  } catch {
    /* private mode: works for this session only */
  }
}

// ---------- routing (#/, #/note/<id>, #/settings) ----------

type Route = { name: "list" } | { name: "note"; id: string } | { name: "settings" };

function parseRoute(hash: string): Route {
  const note = /^#\/note\/(.+)$/.exec(hash);
  if (note) return { name: "note", id: decodeURIComponent(note[1]) };
  if (hash === "#/settings") return { name: "settings" };
  return { name: "list" };
}

const go = (hash: string) => {
  if (location.hash !== hash) location.hash = hash;
};

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = (Date.now() - d.getTime()) / 86_400_000;
  if (days < 1 && d.getDate() === new Date().getDate()) {
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("ja-JP", days > 300 ? { year: "numeric", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

// ---------- app ----------

export default function WebApp() {
  const route = useRoute();
  const [config, setConfigState] = useState<Config>(() => (MOCK ? { folderId: MOCK_FOLDER_ID, folderName: "Rmemo（テスト用）" } : readConfig()));
  const clientId = ENV_CLIENT_ID || config.clientId || "";
  const [token, setToken] = useState<string | null>(() => (MOCK ? "mock" : storedToken()));
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const api: DriveApi = useMemo(() => (MOCK ? mockDrive : googleDrive(() => tokenRef.current)), []);

  const [library, setLibrary] = useState<Library | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setConfig = (next: Config) => {
    setConfigState(next);
    if (!MOCK) writeConfig(next);
  };

  // Images in notes come from the folder's assets/ on Drive.
  const libraryRef = useRef(library);
  libraryRef.current = library;
  useEffect(() => {
    setPlatform({
      resolveImage: (src) => {
        const s = src.trim().replace(/\\/g, "/");
        if (/^(https?:|data:)/i.test(s)) return s;
        const m = /^(?:\.\.\/|\.\/)?assets\/(.+)$/.exec(s);
        const file = m && libraryRef.current?.assets[decodeURIComponent(m[1])];
        return file ? imageUrl(api, file) : null;
      },
      openUrl: (url) => void window.open(url, "_blank", "noopener"),
    });
  }, [api]);

  const failed = useCallback((e: unknown) => {
    if (e instanceof AuthError) {
      forgetToken();
      setToken(null);
      setError(null);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!config.folderId || !tokenRef.current) return;
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      setLibrary(await loadLibrary(api, config.folderId, (done, total) => setProgress({ done, total })));
    } catch (e) {
      failed(e);
    } finally {
      setProgress(null);
    }
  }, [api, config.folderId, failed]);

  // Start: show the last snapshot at once, then fetch what changed.
  useEffect(() => {
    loadSnapshot().then((snap) => snap && setLibrary((cur) => cur ?? snap));
  }, []);
  useEffect(() => {
    if (token && config.folderId) refresh();
  }, [token, config.folderId, refresh]);

  const login = async () => {
    if (!clientId) {
      go("#/settings");
      return;
    }
    try {
      setToken(await signIn(clientId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const notes = library?.notes ?? [];
  const byTitle = useMemo(() => {
    const m = new Map<string, WebNote>();
    for (const n of notes) if (!m.has(n.title.toLowerCase())) m.set(n.title.toLowerCase(), n);
    return m;
  }, [notes]);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status | "all">("all");

  const openNote = (n: WebNote) => go(`#/note/${encodeURIComponent(n.id)}`);
  const searchTag = (tag: string) => {
    setQuery(`#${tag}`);
    go("#/");
  };

  const needsSetup = !MOCK && (!clientId || !config.folderId);

  return (
    <div className="app web-app" data-status={route.name === "note" ? notes.find((n) => n.id === route.id)?.status : undefined}>
      <header className="web-header">
        {route.name === "list" ? (
          <span className="web-brand">Rmemo</span>
        ) : (
          <button type="button" className="web-icon-btn" onClick={() => history.length > 1 ? history.back() : go("#/")} aria-label="戻る">
            ←
          </button>
        )}
        <span className="web-header-sub">
          {progress
            ? progress.total
              ? `読み込み中 ${progress.done}/${progress.total}`
              : "読み込み中…"
            : library
              ? `${notes.length}件・${formatDate(library.loadedAt)} 更新`
              : ""}
        </span>
        {token && config.folderId && route.name === "list" && (
          <button type="button" className="web-icon-btn" onClick={refresh} disabled={!!progress} aria-label="再読み込み" title="再読み込み">
            ⟳
          </button>
        )}
        {route.name !== "settings" && (
          <button type="button" className="web-icon-btn" onClick={() => go("#/settings")} aria-label="設定" title="設定">
            ⚙
          </button>
        )}
      </header>

      {error && <div className="web-banner web-banner-error">{error}</div>}
      {!token && !needsSetup && route.name !== "settings" && (
        <div className="web-banner">
          {library ? "前回読み込んだ内容を表示しています。" : "Google ドライブのメモを読むにはログインしてください。"}
          <button type="button" className="web-primary" onClick={login}>
            Google でログイン
          </button>
        </div>
      )}
      {needsSetup && route.name !== "settings" && (
        <div className="web-banner">
          はじめに設定が必要です。
          <button type="button" className="web-primary" onClick={() => go("#/settings")}>
            設定を開く
          </button>
        </div>
      )}

      {route.name === "list" && (
        <ListView
          notes={notes}
          query={query}
          onQuery={setQuery}
          status={status}
          onStatus={setStatus}
          onOpen={openNote}
          onTag={searchTag}
        />
      )}
      {route.name === "note" && (
        <NoteView
          note={notes.find((n) => n.id === route.id) ?? null}
          backlinks={(() => {
            const n = notes.find((x) => x.id === route.id);
            return n ? backlinksOf(notes, n) : [];
          })()}
          onTag={searchTag}
          onOpenTitle={(title) => {
            const target = byTitle.get(title.trim().toLowerCase());
            if (target) openNote(target);
          }}
          noteExists={(title) => byTitle.has(title.trim().toLowerCase())}
          onOpen={openNote}
        />
      )}
      {route.name === "settings" && (
        <SettingsView
          config={config}
          clientIdFromBuild={!!ENV_CLIENT_ID}
          signedIn={!!token}
          api={api}
          onSave={(c) => {
            setConfig(c);
            go("#/");
          }}
          onLogin={login}
          onLogout={async () => {
            await signOut();
            setToken(null);
          }}
          onClearCache={async () => {
            await clearData();
            setLibrary(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ---------- list ----------

function ListView(props: {
  notes: WebNote[];
  query: string;
  onQuery: (q: string) => void;
  status: Status | "all";
  onStatus: (s: Status | "all") => void;
  onOpen: (n: WebNote) => void;
  onTag: (tag: string) => void;
}) {
  const { notes, query, onQuery, status, onStatus, onOpen, onTag } = props;
  const hits = useMemo(() => searchNotes(notes, query, status), [notes, query, status]);
  const topTags = useMemo(() => {
    const count = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) count.set(t, (count.get(t) ?? 0) + 1);
    return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
  }, [notes]);

  return (
    <div className="web-list-view">
      <div className="web-search">
        <input
          type="search"
          className="web-search-input"
          placeholder="検索（#タグ も可）"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <div className="chips">
          {(["all", "keep", "scratch"] as const).map((s) => (
            <button key={s} type="button" className={status === s ? "chip chip-active" : "chip"} onClick={() => onStatus(s)}>
              {s === "all" ? "すべて" : s === "keep" ? "Keep" : "Scratch"}
            </button>
          ))}
        </div>
      </div>
      {!query && topTags.length > 0 && (
        <div className="tag-cloud">
          {topTags.map(([t, c]) => (
            <button key={t} type="button" className="tag-pill tag-cloud-pill" onClick={() => onTag(t)}>
              #{t} <span className="tag-count">{c}</span>
            </button>
          ))}
        </div>
      )}
      <div className="list">
        {hits.map((n) => (
          <div key={n.id} className="note-row" onClick={() => onOpen(n)}>
            <div className="note-row-header">
              {n.pinned && <span className="note-pin">📌</span>}
              <span className="note-title">{n.title}</span>
              <span className="note-chars">{n.charCount.toLocaleString()}字</span>
              <span className="note-when">{formatDate(n.modifiedAt)}</span>
            </div>
            <div className="note-snippet">{n.snippet || "(空)"}</div>
            {n.tags.length > 0 && (
              <div className="note-tags">
                {n.tags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="tag-pill"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTag(t);
                    }}
                  >
                    #{t}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {notes.length > 0 && hits.length === 0 && <div className="empty">見つかりませんでした</div>}
      </div>
    </div>
  );
}

// ---------- one note ----------

function NoteView(props: {
  note: WebNote | null;
  backlinks: WebNote[];
  onTag: (tag: string) => void;
  onOpenTitle: (title: string) => void;
  noteExists: (title: string) => boolean;
  onOpen: (n: WebNote) => void;
}) {
  const { note, backlinks, onTag, onOpenTitle, noteExists, onOpen } = props;
  if (!note) return <div className="empty">メモが見つかりません（再読み込みしてみてください）</div>;
  return (
    <div className="web-note">
      <div className="web-note-meta">
        <span className={`web-status web-status-${note.status}`}>{note.status === "keep" ? "Keep" : "Scratch"}</span>
        <span>{formatDate(note.modifiedAt)} 更新</span>
        <span>{note.charCount.toLocaleString()}字</span>
      </div>
      <MarkdownView
        key={note.id}
        className="web-note-body"
        body={note.body}
        onTagClick={onTag}
        onOpenNote={onOpenTitle}
        noteExists={noteExists}
      />
      {backlinks.length > 0 && (
        <div className="note-backlinks web-backlinks">
          <span className="note-backlinks-label">← 参照元</span>
          {backlinks.map((n) => (
            <button key={n.id} type="button" className="backlink-pill" onClick={() => onOpen(n)}>
              {n.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- settings ----------

function SettingsView(props: {
  config: Config;
  clientIdFromBuild: boolean;
  signedIn: boolean;
  api: DriveApi;
  onSave: (c: Config) => void;
  onLogin: () => void;
  onLogout: () => void;
  onClearCache: () => void;
}) {
  const { config, clientIdFromBuild, signedIn, api, onSave, onLogin, onLogout, onClearCache } = props;
  const [clientId, setClientId] = useState(config.clientId ?? "");
  const [folder, setFolder] = useState(config.folderId ?? "");
  const [folderName, setFolderName] = useState(config.folderName ?? "");
  const [found, setFound] = useState<DriveFile[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const search = async () => {
    setMsg(null);
    try {
      const list = await api.findFolders("Rmemo");
      setFound(list);
      if (list.length === 0) setMsg("「Rmemo」という名前のフォルダが見つかりません。URL を貼り付けてください。");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const save = () => {
    const id = parseFolderId(folder);
    if (!id) {
      setMsg("フォルダの URL か ID を入れてください");
      return;
    }
    onSave({ clientId: clientId.trim() || undefined, folderId: id, folderName: folderName || undefined });
  };

  return (
    <div className="settings web-settings">
      {!clientIdFromBuild && (
        <label>
          <span>Google OAuth クライアント ID</span>
          <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="xxxx.apps.googleusercontent.com" />
          <small>Google Cloud で作った「ウェブ アプリケーション」のクライアント ID。</small>
        </label>
      )}

      <label>
        <span>メモの保存フォルダ（Google ドライブ）</span>
        <input
          type="text"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setFolderName("");
          }}
          placeholder="https://drive.google.com/drive/folders/…"
        />
        <small>
          Rmemo の「メモの保存フォルダ」（keep と scratch が入っているフォルダ）を Google ドライブで開いたときの URL。
          {folderName && <> 選択中: {folderName}</>}
        </small>
      </label>
      <div className="settings-actions">
        <button type="button" onClick={signedIn ? search : onLogin}>
          {signedIn ? "「Rmemo」フォルダを探す" : "ログインしてフォルダを探す"}
        </button>
      </div>
      {found && found.length > 0 && (
        <div className="web-found">
          {found.map((f) => (
            <button
              key={f.id}
              type="button"
              className={parseFolderId(folder) === f.id ? "chip chip-active" : "chip"}
              onClick={() => {
                setFolder(f.id);
                setFolderName(`${f.name}（${formatDate(f.modifiedTime)} 更新）`);
              }}
            >
              {f.name}・{formatDate(f.createdTime)} 作成
            </button>
          ))}
        </div>
      )}
      {msg && <p className="settings-error">{msg}</p>}

      <div className="settings-actions">
        <button type="button" className="web-primary" onClick={save}>
          保存
        </button>
      </div>

      <hr className="web-sep" />
      <div className="settings-actions">
        {signedIn ? (
          <button type="button" onClick={onLogout}>
            ログアウト
          </button>
        ) : (
          <button type="button" onClick={onLogin}>
            Google でログイン
          </button>
        )}
        <button type="button" onClick={onClearCache}>
          端末のキャッシュを消す
        </button>
      </div>
      <p className="settings-note">
        閲覧専用です。メモは Google ドライブから読み込み、この端末にキャッシュします（オフラインでも前回の内容を表示）。
        ログイン情報・設定はこの端末にだけ保存されます。
      </p>
    </div>
  );
}
