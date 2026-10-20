// In-app updates from GitHub Releases (tauri-plugin-updater). The Microsoft
// Store build is updated by the Store instead, so it's built with
// VITE_STORE_BUILD=1 and never checks.

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export const UPDATES_ENABLED = import.meta.env.VITE_STORE_BUILD !== "1" && !import.meta.env.DEV;

/** How often a long-running (tray-resident) instance looks again. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** The newer release, or null when up to date or the check failed (offline,
 *  GitHub down — never worth bothering the user about). */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    return await check();
  } catch (e) {
    console.warn("[updater] check failed", e);
    return null;
  }
}

/** Downloads and runs the installer, then restarts into the new version. */
export async function installUpdate(update: Update): Promise<void> {
  await update.downloadAndInstall();
  await relaunch();
}
