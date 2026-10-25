import { useEffect, useState } from "react";
import {
  importTxt,
  openNotesFolder,
  pauseHotkey,
  pickImport,
  setSettings,
  type ImportOptions,
  type ImportPreview,
  type ImportReport,
  type Settings,
} from "../api";
import {
  ACTIONS,
  type ActionId,
  comboFromEvent,
  defaultKeymap,
  formatCombo,
  isBindable,
  normalizeCombo,
  reservedFor,
  resolveKeymap,
} from "../keybindings";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (next: Settings) => void;
  /** An import created notes: App moves on to reviewing their 整形. */
  onImported: (report: ImportReport, options: ImportOptions) => void;
}

const TABS = [
  { id: "general", label: "一般" },
  { id: "window", label: "ウィンドウ" },
  { id: "keys", label: "キー設定" },
  { id: "import", label: "取り込み" },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** Mirrors `config::Settings::default().hotkey`. */
const DEFAULT_HOTKEY = "Ctrl+N";

export default function SettingsPanel({ settings, onClose, onSaved, onImported }: Props) {
  const [draft, setDraft] = useState<Settings>({ ...settings, keybindings: settings.keybindings ?? {} });
  const [tab, setTab] = useState<Tab>("general");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirChanged = draft.notesDir !== settings.notesDir;

  const save = () => {
    setError(null);
    setSaving(true);
    setSettings(draft)
      .then((next) => {
        onSaved(next);
        onClose();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <>
      <div className="view-title" data-drag-region>
        設定
      </div>
      <div className="settings-tabs" role="tablist" data-drag-region>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "settings-tab settings-tab-active" : "settings-tab"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="settings">
        {tab === "general" && (
          <>
            <label>
              <span>メモの保存フォルダ</span>
              <input
                type="text"
                value={draft.notesDir}
                onChange={(e) => setDraft({ ...draft, notesDir: e.target.value })}
              />
              {dirChanged && (
                <p className="settings-note">
                  既存のメモは自動移動されません。新しいフォルダに <code>keep</code>/<code>scratch</code>{" "}
                  が作られます。
                </p>
              )}
            </label>
            <div className="settings-actions">
              <button type="button" onClick={() => openNotesFolder().catch((e) => setError(String(e)))}>
                エクスプローラーで開く
              </button>
            </div>

            <label className="settings-inline">
              <span>期限切れの目安（日数）</span>
              <input
                type="number"
                min={1}
                value={draft.expiryDays}
                onChange={(e) => setDraft({ ...draft, expiryDays: Number(e.target.value) || 1 })}
              />
            </label>

            <label className="settings-inline">
              <span>インデント幅（空白の数）</span>
              <input
                type="number"
                min={1}
                max={8}
                value={draft.indentWidth}
                onChange={(e) => setDraft({ ...draft, indentWidth: Number(e.target.value) || 1 })}
              />
            </label>
          </>
        )}

        {tab === "window" && (
          <>
            <label className="settings-inline">
              <span>Windows の起動時に自動で起動する</span>
              <input
                type="checkbox"
                checked={draft.autostart}
                onChange={(e) => setDraft({ ...draft, autostart: e.target.checked })}
              />
            </label>

            <label className="settings-inline">
              <span>ほかの画面をクリックしても開いたままにする</span>
              <input
                type="checkbox"
                checked={!draft.hideOnBlur}
                onChange={(e) => setDraft({ ...draft, hideOnBlur: !e.target.checked })}
              />
            </label>
            <small>
              オフのときは、ほかの画面をクリックすると Rmemo は自動で隠れます。調べものをしながら書くときはオンが便利です。
            </small>
          </>
        )}

        {tab === "keys" && <KeysSection draft={draft} onChange={setDraft} />}

        {tab === "import" && <ImportSection onError={setError} onImported={onImported} />}

        {error && <p className="settings-error">{error}</p>}

        <div className="settings-actions settings-footer">
          {/* The import tab has its own buttons and nothing to save. */}
          {tab !== "import" && (
            <button type="button" className="settings-primary" onClick={save} disabled={saving}>
              保存
            </button>
          )}
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </>
  );
}

/** The global hotkey, then every in-app shortcut, each rebound by pressing it. */
function KeysSection({ draft, onChange }: { draft: Settings; onChange: (next: Settings) => void }) {
  const keymap = resolveKeymap(draft.keybindings);
  const defaults = defaultKeymap();
  const hotkey = normalizeCombo(draft.hotkey);

  const bind = (id: ActionId, combo: string | null) => {
    const next = { ...draft.keybindings };
    if (combo === defaults[id]) delete next[id];
    else next[id] = combo ?? "";
    onChange({ ...draft, keybindings: next });
  };

  /** What else `combo` already means, for the warning under a row. */
  const clash = (id: ActionId | "hotkey", combo: string | null): string | null => {
    if (!combo) return null;
    if (id !== "hotkey" && combo === hotkey) return "呼び出しのホットキーと同じです（こちらは効きません）";
    const other = ACTIONS.find((a) => a.id !== id && keymap[a.id] === combo);
    if (other) return `「${other.label}」と重なっています`;
    const reserved = reservedFor(combo);
    return reserved ? `標準の操作（${reserved}）と重なっています` : null;
  };

  const groups = [...new Set(ACTIONS.map((a) => a.group))];

  return (
    <>
      <div className="settings-keys">
        <span className="settings-keys-group">呼び出し</span>
        <KeyRow
          label="Rmemo を呼び出す（どのアプリからでも）"
          combo={hotkey}
          isDefault={hotkey === DEFAULT_HOTKEY}
          warning={clash("hotkey", hotkey)}
          onSet={(c) => c && onChange({ ...draft, hotkey: c })}
          onReset={() => onChange({ ...draft, hotkey: DEFAULT_HOTKEY })}
          pausesHotkey
        />
      </div>
      {groups.map((g) => (
        <div className="settings-keys" key={g}>
          <span className="settings-keys-group">{g}</span>
          {ACTIONS.filter((a) => a.group === g).map((a) => (
            <KeyRow
              key={a.id}
              label={a.label}
              combo={keymap[a.id]}
              isDefault={keymap[a.id] === defaults[a.id]}
              warning={clash(a.id, keymap[a.id])}
              onSet={(c) => bind(a.id, c)}
              onReset={() => bind(a.id, defaults[a.id])}
              canClear
            />
          ))}
        </div>
      ))}
      <small>
        キーの欄を押してから、割り当てたいキーを押します（Esc でやめる）。Ctrl か Alt との組み合わせか、F1〜F12 が使えます。
      </small>
      <div className="settings-actions">
        <button type="button" onClick={() => onChange({ ...draft, hotkey: DEFAULT_HOTKEY, keybindings: {} })}>
          すべて初期値に戻す
        </button>
      </div>
    </>
  );
}

function KeyRow({
  label,
  combo,
  isDefault,
  warning,
  onSet,
  onReset,
  canClear = false,
  pausesHotkey = false,
}: {
  label: string;
  combo: string | null;
  isDefault: boolean;
  warning: string | null;
  onSet: (combo: string | null) => void;
  onReset: () => void;
  canClear?: boolean;
  /** Release the global hotkey while recording, so pressing it reaches here
   *  instead of hiding the window. */
  pausesHotkey?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    if (!pausesHotkey || !recording) return;
    pauseHotkey(true).catch(() => {});
    return () => void pauseHotkey(false).catch(() => {});
  }, [pausesHotkey, recording]);

  const stop = () => {
    setRecording(false);
    setHint(null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording) return;
    // Every key goes to the recorder — none of them may act as a shortcut.
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stop();
      return;
    }
    const next = comboFromEvent(e);
    if (!next) return; // a modifier on its own: wait for the key
    if (!isBindable(next)) {
      setHint("Ctrl か Alt と組み合わせてください");
      return;
    }
    stop();
    onSet(next);
  };

  return (
    <div className="settings-key-row">
      <span className="settings-key-label">{label}</span>
      <button
        type="button"
        className={recording ? "settings-key settings-key-recording" : "settings-key"}
        onClick={() => setRecording((r) => !r)}
        onKeyDown={onKeyDown}
        onBlur={stop}
      >
        {recording ? "キーを押してください…" : formatCombo(combo)}
      </button>
      <span className="settings-key-tools">
        {canClear && combo && (
          <button type="button" title="割り当てをなしにする" onClick={() => onSet(null)}>
            ×
          </button>
        )}
        {!isDefault && (
          <button type="button" title="初期値に戻す" onClick={onReset}>
            ↺
          </button>
        )}
      </span>
      {(hint ?? warning) && <small className="settings-key-warning">{hint ?? warning}</small>}
    </div>
  );
}

/** Pick a folder → confirm the count → import every `.txt` under it. */
function ImportSection({
  onError,
  onImported,
}: {
  onError: (e: string | null) => void;
  onImported: (report: ImportReport, options: ImportOptions) => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<ImportOptions>({ folderTags: true, importTag: true });

  const pick = (files: boolean) => {
    onError(null);
    setReport(null);
    pickImport(files)
      .then(setPreview)
      .catch((e) => onError(String(e)));
  };

  const run = () => {
    if (!preview) return;
    setBusy(true);
    importTxt(preview, options)
      .then((r) => {
        setPreview(null);
        // Nothing new (all already imported, say): the report stays here.
        if (r.files.length > 0) onImported(r, options);
        else setReport(r);
      })
      .catch((e) => onError(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="settings-import">
      <span>テキストファイルの取り込み</span>
      <small>
        選んだフォルダの中の <code>.txt</code>（サブフォルダも含めてすべて）か、選んだ <code>.txt</code>{" "}
        ファイルを Keep のメモにします。ファイル名は見出しになります。取り込んだあと、1 件ずつ Markdown
        への整形を確認できます。
      </small>
      <label className="settings-inline">
        <span>フォルダ名をタグにする</span>
        <input
          type="checkbox"
          checked={options.folderTags}
          onChange={(e) => setOptions({ ...options, folderTags: e.target.checked })}
        />
      </label>
      <label className="settings-inline">
        <span>
          <code>#取り込み</code> タグを付ける
        </span>
        <input
          type="checkbox"
          checked={options.importTag}
          onChange={(e) => setOptions({ ...options, importTag: e.target.checked })}
        />
      </label>
      {preview ? (
        <>
          <p className="settings-note">
            {preview.dir ?? previewNames(preview.files)}
            <br />
            {preview.files.length === 0
              ? ".txt ファイルが見つかりませんでした。"
              : `${preview.files.length.toLocaleString()} 件（${formatBytes(preview.bytes)}）を取り込みます。`}
          </p>
          <div className="settings-actions">
            {preview.files.length > 0 && (
              <button type="button" onClick={run} disabled={busy}>
                {busy ? "取り込み中…" : "取り込む"}
              </button>
            )}
            <button type="button" onClick={() => setPreview(null)} disabled={busy}>
              やめる
            </button>
          </div>
        </>
      ) : (
        <div className="settings-actions">
          <button type="button" className="settings-outlined" onClick={() => pick(false)}>
            フォルダを選ぶ…
          </button>
          <button type="button" className="settings-outlined" onClick={() => pick(true)}>
            ファイルを選ぶ…
          </button>
        </div>
      )}
      {report && (
        <p className="settings-note">
          {report.imported.toLocaleString()} 件を取り込みました。
          {report.duplicates > 0 &&
            ` 取り込み済みの ${report.duplicates} 件は飛ばしました（Keep にあります。元のファイルの日付で並ぶので、一覧では下のほうです）。`}
          {report.empty > 0 && ` 空のファイル ${report.empty} 件は飛ばしました。`}
          {report.garbled.length > 0 && (
            <>
              <br />
              文字化けしている可能性があります: {report.garbled.join("、")}
            </>
          )}
          {report.failed.length > 0 && (
            <>
              <br />
              取り込めなかったファイル: {report.failed.join("、")}
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Picked files by name — the first few, then how many more. */
function previewNames(files: string[]): string {
  const names = files.map((f) => f.split(/[\\/]/).pop() ?? f);
  const shown = names.slice(0, 3).join("、");
  return names.length > 3 ? `${shown} ほか ${names.length - 3} 件` : shown;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
