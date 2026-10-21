import { useEffect, useRef } from "react";
import MarkdownView from "./MarkdownView";

interface Item {
  name: string;
  /** What to type (shown as-is). Omitted for keyboard-only features. */
  input?: string;
  /** Render `input` with the real editor look. */
  preview?: boolean;
  keys?: string[];
  note: string;
}

interface Section {
  title: string;
  items: Item[];
}

const SECTIONS: Section[] = [
  {
    title: "見出し",
    items: [
      { name: "見出し1", input: "# 大見出し", preview: true, keys: ["Ctrl+Alt+1", "上の H1"], note: "行頭で # と空白を打った瞬間に大きくなります。" },
      { name: "見出し2", input: "## 中見出し", preview: true, keys: ["Ctrl+Alt+2", "上の H2"], note: "# の数で大きさが変わります（4つまで）。" },
      { name: "見出し3・4", input: "### 小見出し\n#### さらに小さい見出し", preview: true, keys: ["Ctrl+Alt+3", "Ctrl+Alt+4"], note: "" },
      { name: "本文に戻す", keys: ["見出しの先頭で Backspace", "Ctrl+Alt+0", "上の 本文"], note: "同じ見出しボタンをもう一度押しても本文に戻ります。" },
      { name: "全角でもOK", input: "＃＃　見出し", keys: [], note: "日本語入力のまま ＃＃ と全角スペースを打つと、自動で ## に直って見出しになります。" },
      { name: "見出しで折りたたむ", keys: ["見出しの左の ▾ をクリック", "Ctrl+Shift+[ / ]", "Ctrl+Alt+[ / ] で全部"], note: "その見出しの下（次の同じ大きさ以上の見出しまで）を隠します。たたんだ見出しには ▸ が残ります。" },
      { name: "見出しとタグの違い", input: "# 見出し（# のあとに空白）\n#タグ（空白なし）", preview: true, note: "# のすぐ後に文字が続くとタグ、空白をあけると見出しです。" },
    ],
  },
  {
    title: "文字の飾り",
    items: [
      { name: "太字", input: "**太字**", preview: true, keys: ["Ctrl+B"], note: "選んで Ctrl+B。もう一度押すと解除。何も選ばずに押すと、太字で打ち始められます。" },
      { name: "斜体", input: "*斜体*", preview: true, keys: ["Ctrl+I"], note: "" },
      { name: "取り消し線", input: "~~取り消し~~", preview: true, note: "" },
      { name: "インラインコード", input: "`npm install`", preview: true, keys: ["Ctrl+E"], note: "文中の短いコードやコマンドに。" },
    ],
  },
  {
    title: "リスト",
    items: [
      { name: "箇条書き", input: "- りんご\n- みかん\n    - 入れ子", preview: true, keys: ["Enter で次の項目", "空の項目で Enter → 終了", "Tab / Shift+Tab で字下げ"], note: "行頭で - と空白。" },
      { name: "番号付き", input: "1. 最初\n2. 次", preview: true, keys: ["Enter で次の番号"], note: "" },
      { name: "チェックボックス", input: "- [ ] やること\n- [x] 終わったこと", preview: true, keys: ["クリックで完了／未完了"], note: "完了すると取り消し線が付きます。" },
    ],
  },
  {
    title: "ブロック",
    items: [
      { name: "引用", input: "> 引用した文章", preview: true, keys: ["Enter で引用が続く", "空の行で Enter → 終了"], note: "" },
      { name: "区切り線", input: "---", preview: true, note: "行に - を3つ。" },
      {
        name: "コードブロック",
        input: "```js\nconst a = 1;\nconsole.log(a);\n```",
        preview: true,
        keys: ["右上の「コピー」", "言語名をクリックで変更"],
        note: "``` の後に言語名（js, python など）で色分け。言語を書かずに閉じると、中身から言語を推測して自動で付けます。",
      },
      {
        name: "画像",
        input: "![](../assets/20261019-140501-a3f9.webp)",
        keys: [
          "スクリーンショットを Ctrl+V",
          "画像ファイルをドラッグ＆ドロップ",
          "右下の□をドラッグで大きさ変更",
          "右上の 小・中・大・原寸",
          "ダブルクリックで原寸",
        ],
        note: "大きさは ![|300](…) のように幅(px)で記録されます（Obsidian と同じ書き方）。メモフォルダの assets に WebP で保存され、その場に表示されます。Backspace 1回で画像ごと消せます。メモから消した画像は、別のメモに切り替えたときなどに自動でごみ箱へ移ります（5分以上たったもの）。",
      },
    ],
  },
  {
    title: "リンク・タグ",
    items: [
      { name: "リンク", input: "[Rmemo の説明](https://example.com)", preview: true, keys: ["Ctrl+K", "上の リンク", "Ctrl+クリックで開く"], note: "文字を選んで Ctrl+K で URL を入力。リンクの上で Ctrl+K を押すと URL の変更・解除。" },
      { name: "URL を貼ってリンク化", keys: ["文字を選んで URL を Ctrl+V"], note: "選んだ文字がそのままリンクになります。" },
      { name: "URL そのまま", input: "https://example.com", preview: true, keys: ["Ctrl+クリックで開く"], note: "" },
      { name: "メモへのリンク", input: "[[買い物メモ]]", preview: true, keys: ["[[ で候補が出る", "クリックで開く", "文字を直すときは矢印キーで中へ"], note: "📄 付きの囲みで表示されます（青い文字の Web リンクとは別物）。まだないメモ名なら点線で、クリックすると新しく作れます。リンク先のタイトルにある #… はタグとして数えません。リンクされた側のメモには「← 参照元」が出ます。" },
      { name: "タグ", input: "#仕事 #アイデア", preview: true, keys: ["# で候補が出る", "Ctrl+クリックで検索"], note: "メモの分類に。検索画面でタグごとに絞り込めます。" },
    ],
  },
  {
    title: "編集の便利機能",
    items: [
      { name: "複数カーソル", keys: ["Alt+クリックで追加", "Ctrl+D 次の同じ語を追加", "Ctrl+Shift+L 同じ語をすべて", "Shift+Alt+ドラッグで縦に選択", "Esc で1つに戻す"], note: "複数の場所を同時に書き換えられます。" },
      { name: "行の操作", keys: ["Alt+↑/↓ 行を移動", "Shift+Alt+↑/↓ 行を複製", "Ctrl+] / Ctrl+[ インデント"], note: "複数カーソルのときは全部の行に効きます。" },
      { name: "日付", keys: ["Ctrl+: 今日の日付", "Ctrl+Shift+: 日付と時刻"], note: "例: 2026-10-19 / 2026-10-19 14:05" },
      { name: "メモ内の検索・置換", keys: ["Ctrl+F", "Ctrl+H"], note: "" },
      { name: "目次", note: "見出しを作ると右側に目次が出ます。クリックでその見出しへ。幅が狭いときは細い線になり、マウスを乗せると開きます。" },
      { name: "文字数", note: "下に文字数（改行は数えない）。文字を選ぶと選択中の文字数も出ます。" },
    ],
  },
  {
    title: "保存と整理",
    items: [
      { name: "保存", keys: ["Ctrl+S 一時保存", "Ctrl+Enter 保存して新規"], note: "書いている途中も自動で保存されます。Ctrl+Enter は保存して、すぐ新しいメモに切り替えます（窓は開いたまま）。" },
      { name: "Keep / Scratch", keys: ["Ctrl+L 切り替え"], note: "残すメモは Keep、使い捨ては Scratch。" },
      { name: "新しいメモ", keys: ["上の ＋ 新規", "Esc"], note: "開いているメモを閉じて、新しいメモを書き始めます。閉じたメモは保存されています。" },
      { name: "前回のメモに戻る", keys: ["上の ← 前回", "Ctrl+Shift+T"], note: "新しいメモの画面から、直前まで開いていたメモをすぐ開き直せます。アプリを再起動しても覚えています。" },
      { name: "ピン留め", keys: ["検索画面の「ピン留め」"], note: "よく使うメモを一覧の一番上に固定します。ピンはメモフォルダに保存されるので、Drive で他のPCにも同期されます。" },
      { name: "メモ名の変更とリンク", note: "メモのタイトルを変えると、他のメモの [[古い名前]] のリンクも、そのメモを閉じたときに新しい名前へ書き換わります。" },
      { name: "メモを探す", keys: ["上の 一覧", "Ctrl+Shift+F 検索画面", "Ctrl+, 設定", "F1 この画面"], note: "" },
    ],
  },
];

interface Props {
  onClose: () => void;
}

/** "Do this, get that" for every editor feature, each example rendered with
 *  the real editor look. Opened with F1 or the ? button. */
export default function Tutorial({ onClose }: Props) {
  // Focus lands here so Esc / F1 (handled by App) reach the app at all —
  // the screen it replaced, and whatever had focus there, is gone.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => rootRef.current?.focus(), []);
  return (
    <div className="tutorial" ref={rootRef} tabIndex={-1}>
      <div className="view-title view-title-row" data-drag-region>
        <span>エディタの使い方</span>
        <button type="button" className="compose-find-btn" onClick={onClose}>
          閉じる (Esc)
        </button>
      </div>
      <div className="tutorial-body">
        <p className="tutorial-lead">
          左の「入力」のように打つと、右の「見え方」になります。ファイルにはいつでも左の文字のまま（Markdown）保存されます。
        </p>
        {SECTIONS.map((sec) => (
          <section key={sec.title} className="tutorial-section">
            <h2>{sec.title}</h2>
            {sec.items.map((it) => (
              <div key={it.name} className="tutorial-item">
                <div className="tutorial-name">{it.name}</div>
                <div className="tutorial-cols">
                  {it.input !== undefined && (
                    <div className="tutorial-col">
                      <div className="tutorial-col-label">入力</div>
                      <pre className="tutorial-input">{it.input}</pre>
                    </div>
                  )}
                  {it.preview && it.input !== undefined && (
                    <div className="tutorial-col">
                      <div className="tutorial-col-label">見え方</div>
                      <MarkdownView className="tutorial-preview" body={it.input} />
                    </div>
                  )}
                  {(it.keys?.length || it.note) && (
                    <div className="tutorial-col tutorial-col-wide">
                      {it.keys && it.keys.length > 0 && (
                        <div className="tutorial-keys">
                          {it.keys.map((k) => (
                            <kbd key={k}>{k}</kbd>
                          ))}
                        </div>
                      )}
                      {it.note && <div className="tutorial-note">{it.note}</div>}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
