import { useState } from "react";
import {
  importTxt,
  openNotesFolder,
  pickImport,
  setSettings,
  type ImportOptions,
  type ImportPreview,
  type ImportReport,
  type Settings,
} from "../api";

interface Props {
  settings: Settings;
  onClose: () => void;
  onSaved: (next: Settings) => void;
  /** An import created notes: App moves on to reviewing their 整形. */
  onImported: (report: ImportReport, options: ImportOptions) => void;
}

export default function SettingsPanel({ settings, onClose, onSaved, onImported }: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
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
      <div className="settings">
        <label>
          <span>ホットキー</span>
          <input
            type="text"
            value={draft.hotkey}
            onChange={(e) => setDraft({ ...draft, hotkey: e.target.value })}
          />
          <small>
            例: <code>Ctrl+N</code>
          </small>
        </label>

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
          <span>Windows の起動時に自動で起動する</span>
          <input
            type="checkbox"
            checked={draft.autostart}
            onChange={(e) => setDraft({ ...draft, autostart: e.target.checked })}
          />
        </label>

        <label className="settings-inline">
          <span>フォーカスを外したら自動で隠す</span>
          <input
            type="checkbox"
            checked={draft.hideOnBlur}
            onChange={(e) => setDraft({ ...draft, hideOnBlur: e.target.checked })}
          />
        </label>

        <label className="settings-inline">
          <span>インデント幅（Ctrl+[ / Ctrl+]）</span>
          <input
            type="number"
            min={1}
            max={8}
            value={draft.indentWidth}
            onChange={(e) => setDraft({ ...draft, indentWidth: Number(e.target.value) || 1 })}
          />
        </label>

        <ImportSection onError={setError} onImported={onImported} />

        {error && <p className="settings-error">{error}</p>}

        <div className="settings-actions">
          <button type="button" onClick={save} disabled={saving}>
            保存
          </button>
          <button type="button" onClick={() => openNotesFolder().catch((e) => setError(String(e)))}>
            エクスプローラーで開く
          </button>
          <button type="button" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </>
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
          <button type="button" onClick={() => pick(false)}>
            フォルダを選ぶ…
          </button>
          <button type="button" onClick={() => pick(true)}>
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
