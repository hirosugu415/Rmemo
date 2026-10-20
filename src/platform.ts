// What the shared editor/viewer code needs from the app around it — the
// desktop app (Tauri: local files, the system browser) and the web viewer
// (Google Drive, a new tab) each plug in their own.

export interface Platform {
  /** A loadable URL for an image reference in a note (`../assets/x.webp`,
   *  an https URL…), or null when it can't be shown. May take a moment
   *  (the web viewer fetches images from Drive). */
  resolveImage(src: string): string | null | Promise<string | null>;
  openUrl(url: string): void;
}

const webDefaults: Platform = {
  resolveImage: (src) => (/^(https?:|data:)/i.test(src.trim()) ? src.trim() : null),
  openUrl: (url) => void window.open(url, "_blank", "noopener"),
};

let current: Platform = webDefaults;

export const platform = (): Platform => current;

export function setPlatform(next: Platform) {
  current = next;
}
