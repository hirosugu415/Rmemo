// The handful of Google Drive v3 calls the viewer needs — all read-only.

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  createdTime: string;
}

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The access token was rejected (expired / revoked): sign in again. */
export class AuthError extends Error {}

export interface DriveApi {
  getFile(id: string): Promise<DriveFile>;
  listChildren(folderId: string): Promise<DriveFile[]>;
  /** Folders with this exact name anywhere in My Drive. */
  findFolders(name: string): Promise<DriveFile[]>;
  downloadText(id: string): Promise<string>;
  downloadBlob(id: string): Promise<Blob>;
}

const API = "https://www.googleapis.com/drive/v3";
const FIELDS = "id,name,mimeType,modifiedTime,createdTime";

export function googleDrive(token: () => string | null): DriveApi {
  const get = async (path: string, params: Record<string, string> = {}) => {
    const t = token();
    if (!t) throw new AuthError("ログインが必要です");
    const url = `${API}/${path}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    } catch {
      throw new Error("Google ドライブに接続できません（オフライン？）");
    }
    if (res.status === 401) throw new AuthError("ログインの有効期限が切れました");
    if (!res.ok) throw new Error(`Google ドライブ: ${res.status} ${await res.text().catch(() => "")}`.trim());
    return res;
  };

  const list = async (q: string) => {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string> = {
        q,
        fields: `nextPageToken,files(${FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      };
      if (pageToken) params.pageToken = pageToken;
      const page = (await (await get("files", params)).json()) as { files: DriveFile[]; nextPageToken?: string };
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  };

  const quote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

  return {
    getFile: async (id) => (await get(`files/${id}`, { fields: FIELDS })).json(),
    listChildren: (folderId) => list(`${quote(folderId)} in parents and trashed = false`),
    findFolders: (name) => list(`name = ${quote(name)} and mimeType = '${FOLDER_MIME}' and trashed = false`),
    downloadText: async (id) => (await get(`files/${id}`, { alt: "media" })).text(),
    downloadBlob: async (id) => (await get(`files/${id}`, { alt: "media" })).blob(),
  };
}

/** `https://drive.google.com/drive/folders/<id>` (or a bare id) → the id. */
export function parseFolderId(input: string): string | null {
  const s = input.trim();
  const m = /\/folders\/([\w-]+)/.exec(s) ?? /[?&]id=([\w-]+)/.exec(s);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}
