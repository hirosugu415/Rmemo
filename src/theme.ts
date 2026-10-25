/** Light/dark and the Keep/Scratch colours, both settings. `styles.css`
 *  styles `:root[data-theme=…]` and `:root[data-palette=…]`. */

export const PALETTES = [
  {
    id: "orange-aqua",
    label: "オレンジ / アクア",
    lightLabel: "オレンジ / アクア",
    dark: ["#f4a77a", "#62d0d8"],
    light: ["#d0703a", "#1d98a3"],
  },
  {
    id: "orange-mint",
    label: "オレンジ / ミント",
    lightLabel: "オレンジ / ミント",
    dark: ["#f4a77a", "#5fd3a8"],
    light: ["#d0703a", "#1f9c72"],
  },
  // Light swaps the yellows for a deep rose (no yellow reads on white), and
  // names it so.
  {
    id: "lemon-sky",
    label: "レモン / スカイ",
    lightLabel: "ローズ / スカイ",
    dark: ["#f2d65c", "#7cc4f5"],
    light: ["#b4546a", "#2a8bd0"],
  },
  {
    id: "yellow-mint",
    label: "イエロー / ミント",
    lightLabel: "ローズ / ミント",
    dark: ["#ecc94b", "#5fd3a8"],
    light: ["#b4546a", "#1f9c72"],
  },
] as const;

/** Mirrors `config::Settings::default().palette`, and the base colours in
 *  styles.css. */
export const DEFAULT_PALETTE = "orange-aqua";

/** Anything unknown counts as the default. */
export function applyPalette(palette: string | undefined): void {
  const known = PALETTES.some((p) => p.id === palette);
  document.documentElement.dataset.palette = known ? palette : DEFAULT_PALETTE;
}

const osDark = () => window.matchMedia("(prefers-color-scheme: dark)");

/** "light" / "dark" as picked in settings; anything else (never picked)
 *  follows the OS. */
export function resolveTheme(theme: string | undefined): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  return osDark().matches ? "dark" : "light";
}

export function applyTheme(theme: string | undefined): void {
  document.documentElement.dataset.theme = resolveTheme(theme);
}

/** Applies `theme` and, while it follows the OS, keeps it in step;
 *  returns the unsubscribe. */
export function followTheme(theme: string | undefined): () => void {
  applyTheme(theme);
  const mq = osDark();
  const onChange = () => applyTheme(theme);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
