// Pasted / dropped images: converted to WebP in the webview, written into the
// notes folder's `assets/` by the backend, and referenced from the note as
// plain Markdown — `![](../assets/<name>)`, relative to keep/ or scratch/.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

let notesDir = "";

/** Kept in sync with the settings, so `assets/` paths can be resolved. */
export function setNotesDir(dir: string) {
  notesDir = dir.replace(/[\\/]+$/, "");
}

/** A loadable URL for an image reference in a note: web URLs as they are,
 *  `../assets/x.webp` through the asset protocol. Null if it can't be shown. */
export function resolveImageSrc(src: string): string | null {
  const s = src.trim().replace(/\\/g, "/");
  if (/^(https?:|data:)/i.test(s)) return s;
  const m = /^(?:\.\.\/|\.\/)?assets\/(.+)$/.exec(s);
  if (!m || !notesDir) return null;
  try {
    return convertFileSrc(`${notesDir}\\assets\\${decodeURIComponent(m[1])}`);
  } catch {
    return null;
  }
}

/** WebP is a fraction of a screenshot PNG's size — kinder to Drive. GIF
 *  (may be animated) and SVG (vector) are kept as they are, and so is any
 *  image the conversion would make bigger. */
async function encode(file: Blob): Promise<{ bytes: Uint8Array; ext: string }> {
  const original = async () => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    ext: { "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" }[file.type] ?? "png",
  });
  if (file.type === "image/gif" || file.type === "image/svg+xml" || file.type === "image/webp") {
    return original();
  }
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const webp = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.85));
    if (!webp || webp.type !== "image/webp" || webp.size >= file.size) return original();
    return { bytes: new Uint8Array(await webp.arrayBuffer()), ext: "webp" };
  } catch {
    return original();
  }
}

/** Saves one image; resolves to the Markdown that shows it. */
export async function saveImage(file: Blob): Promise<string> {
  const { bytes, ext } = await encode(file);
  const name = await invoke<string>("save_image", bytes, { headers: { "x-ext": ext } });
  return `![](../assets/${name})`;
}

/** Recycles images no note uses any more (and older than a grace period).
 *  `extra` is the compose box's current, possibly unsaved, text. */
export const cleanupImages = (extra: string) => invoke<number>("cleanup_images", { extra });

export function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
}
