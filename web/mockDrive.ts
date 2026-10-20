// Development only (`npm run dev:web`, then open with `?mock`): a fake
// Drive with a few notes, so the viewer can be tried without a Google
// account or OAuth setup. Never part of the published build's code path.

import { type DriveApi, type DriveFile, FOLDER_MIME } from "./drive";

const day = (d: number) => new Date(Date.UTC(2026, 9, d, 3)).toISOString();
const file = (id: string, name: string, d = 10, mimeType = "text/markdown"): DriveFile => ({
  id,
  name,
  mimeType,
  modifiedTime: day(d),
  createdTime: day(1),
});

const folders: Record<string, DriveFile[]> = {
  root: [
    file("keep", "keep", 1, FOLDER_MIME),
    file("scratch", "scratch", 1, FOLDER_MIME),
    file("assets", "assets", 1, FOLDER_MIME),
    file("dot", ".rmemo", 1, FOLDER_MIME),
  ],
  keep: [file("n1", "買い物メモ.md", 18), file("n2", "Rmemo の使い方.md", 15), file("n3", "仕事メモ.md", 19)],
  scratch: [file("n4", "思いつき.md", 12)],
  assets: [file("img1", "20261019-120000-abcd.png", 18, "image/png")],
  dot: [file("pins", "pins.json", 18, "application/json")],
};

const bodies: Record<string, string> = {
  n1: "# 買い物メモ\n- [ ] 牛乳\n- [x] パン\n- [ ] 卵\n\n#買い物 #生活\n\n![|240](../assets/20261019-120000-abcd.png)",
  n2:
    "# Rmemo の使い方\n\n## 見出し\n`# ` で見出し。**太字** と *斜体* と ~~取り消し~~。\n\n## コード\n```js\nconst a = 1; // コメント\nconsole.log(a);\n```\n\n## リンク\n[Rmemo のリポジトリ](https://github.com/hirosugu415/Rmemo) と [[買い物メモ]]、まだない [[存在しないメモ]]。\n\n> 引用もこのとおり。\n\n---\n#使い方",
  n3: "# 仕事メモ\n今日やること → [[買い物メモ]] も確認\n\n1. 資料\n2. 連絡\n\n#仕事",
  n4: "# 思いつき\nスマホからも読めると便利。#アイデア",
  pins: JSON.stringify(["仕事メモ.md"]),
};

function sampleImage(): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = 480;
  c.height = 240;
  const g = c.getContext("2d")!;
  g.fillStyle = "#3b82f6";
  g.fillRect(0, 0, 480, 240);
  g.fillStyle = "#fff";
  g.font = "32px sans-serif";
  g.fillText("assets/ の画像", 120, 130);
  return new Promise((r) => c.toBlob((b) => r(b!), "image/png"));
}

const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 120));

export const mockDrive: DriveApi = {
  getFile: async (id) => wait(file(id, id === "root" ? "Rmemo" : id, 1, FOLDER_MIME)),
  listChildren: async (id) => wait(folders[id] ?? []),
  findFolders: async (name) => wait(name === "Rmemo" ? [file("root", "Rmemo", 1, FOLDER_MIME)] : []),
  downloadText: async (id) => wait(bodies[id] ?? ""),
  downloadBlob: async () => sampleImage(),
};

export const MOCK_FOLDER_ID = "root";
