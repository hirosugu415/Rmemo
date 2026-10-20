import { openUrl } from "@tauri-apps/plugin-opener";
import { resolveImageSrc } from "./images";
import type { Platform } from "./platform";

/** Local `assets/` through the asset protocol; links in the system browser. */
export const desktopPlatform: Platform = {
  resolveImage: resolveImageSrc,
  openUrl: (url) => void openUrl(url).catch(() => {}),
};
