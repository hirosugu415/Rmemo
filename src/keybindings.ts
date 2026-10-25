/**
 * The in-app shortcuts the settings panel lets you rebind.
 *
 * A combo is a string like `Ctrl+Shift+F` — modifiers in the fixed order
 * Ctrl, Alt, Shift, then one key: a letter, a digit, or otherwise the
 * physical key's `KeyboardEvent.code` (`Quote`, `BracketRight`, `ArrowUp`,
 * `Enter`, `F1`…). Matching goes by physical key so it doesn't depend on
 * what the layout makes of a key with Ctrl/Shift held (on JIS, Shift turns
 * `:` into `*`). The same string is also a valid Tauri accelerator, so the
 * global hotkey uses this format too.
 */

export type ActionId =
  | "toggleSearch"
  | "openSettings"
  | "reopenPrevious"
  | "openTutorial"
  | "openHistory"
  | "saveDraft"
  | "saveAndNew"
  | "saveAndHide"
  | "toggleStatus"
  | "find"
  | "replace"
  | "bold"
  | "italic"
  | "code"
  | "link"
  | "heading0"
  | "heading1"
  | "heading2"
  | "heading3"
  | "heading4"
  | "insertDate"
  | "insertDateTime"
  | "indent"
  | "outdent"
  | "selectNext"
  | "selectAllMatches"
  | "moveLineUp"
  | "moveLineDown"
  | "copyLineUp"
  | "copyLineDown";

interface ActionDef {
  id: ActionId;
  label: string;
  group: string;
  default: string;
  /** For a punctuation default: the character it means. On a layout where
   *  that character sits on another key, the default follows it there (the
   *  `default` code is the JIS position, used when the layout is unknown). */
  char?: string;
}

export const ACTIONS: ActionDef[] = [
  { id: "toggleSearch", label: "メモの一覧・検索", group: "画面", default: "Ctrl+Shift+F" },
  { id: "openSettings", label: "設定", group: "画面", default: "Ctrl+Comma", char: "," },
  { id: "reopenPrevious", label: "前回のメモに戻る", group: "画面", default: "Ctrl+Shift+T" },
  { id: "openTutorial", label: "使い方", group: "画面", default: "F1" },
  { id: "openHistory", label: "このメモの履歴", group: "画面", default: "Ctrl+Shift+H" },
  { id: "saveDraft", label: "途中保存", group: "保存", default: "Ctrl+S" },
  { id: "saveAndNew", label: "保存して新規", group: "保存", default: "Ctrl+Enter" },
  { id: "saveAndHide", label: "保存してウィンドウを閉じる", group: "保存", default: "Ctrl+Shift+Enter" },
  { id: "toggleStatus", label: "保管 / 一時 切替", group: "保存", default: "Ctrl+L" },
  { id: "find", label: "ノート内検索", group: "編集", default: "Ctrl+F" },
  { id: "replace", label: "置換", group: "編集", default: "Ctrl+H" },
  { id: "insertDate", label: "今日の日付", group: "編集", default: "Ctrl+Quote", char: ":" },
  { id: "insertDateTime", label: "日付と時刻", group: "編集", default: "Ctrl+Shift+Quote", char: ":" },
  { id: "indent", label: "インデント", group: "編集", default: "Ctrl+Backslash", char: "]" },
  { id: "outdent", label: "インデント解除", group: "編集", default: "Ctrl+BracketRight", char: "[" },
  { id: "selectNext", label: "次の一致を選択（複数カーソル）", group: "編集", default: "Ctrl+D" },
  { id: "selectAllMatches", label: "一致をすべて選択", group: "編集", default: "Ctrl+Shift+L" },
  { id: "moveLineUp", label: "行を上へ移動", group: "編集", default: "Alt+ArrowUp" },
  { id: "moveLineDown", label: "行を下へ移動", group: "編集", default: "Alt+ArrowDown" },
  { id: "copyLineUp", label: "行を上へ複製", group: "編集", default: "Alt+Shift+ArrowUp" },
  { id: "copyLineDown", label: "行を下へ複製", group: "編集", default: "Alt+Shift+ArrowDown" },
  { id: "bold", label: "太字", group: "書式", default: "Ctrl+B" },
  { id: "italic", label: "斜体", group: "書式", default: "Ctrl+I" },
  { id: "code", label: "コード", group: "書式", default: "Ctrl+E" },
  { id: "link", label: "リンク", group: "書式", default: "Ctrl+K" },
  { id: "heading0", label: "本文に戻す", group: "書式", default: "Ctrl+Alt+0" },
  { id: "heading1", label: "見出し1", group: "書式", default: "Ctrl+Alt+1" },
  { id: "heading2", label: "見出し2", group: "書式", default: "Ctrl+Alt+2" },
  { id: "heading3", label: "見出し3", group: "書式", default: "Ctrl+Alt+3" },
  { id: "heading4", label: "見出し4", group: "書式", default: "Ctrl+Alt+4" },
];

/** Action → combo, or null when unbound. */
export type Keymap = Record<ActionId, string | null>;

/** Code → the character it types unshifted, once the browser has told us
 *  (`navigator.keyboard` — Chromium/WebView2 only). */
let layout: Map<string, string> | null = null;

export const layoutReady: Promise<void> = (async () => {
  try {
    const kb = (navigator as { keyboard?: { getLayoutMap(): Promise<Map<string, string>> } }).keyboard;
    if (kb) layout = new Map(await kb.getLayoutMap());
  } catch {
    /* unknown layout: defaults stay at their JIS positions */
  }
})();

function defaultCombo(a: ActionDef): string {
  if (!a.char || !layout) return a.default;
  let code: string | null = null;
  for (const [c, ch] of layout) if (ch === a.char) code = c;
  if (!code) return a.default;
  const mods = a.default.split("+").slice(0, -1);
  return [...mods, code].join("+");
}

export function defaultKeymap(): Keymap {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, defaultCombo(a)])) as Keymap;
}

/** The defaults with the user's overrides on top (`""` = unbound). */
export function resolveKeymap(overrides: Record<string, string> | undefined): Keymap {
  const map = defaultKeymap();
  for (const a of ACTIONS) {
    const o = overrides?.[a.id];
    if (o === undefined) continue;
    map[a.id] = o === "" ? null : (normalizeCombo(o) ?? map[a.id]);
  }
  return map;
}

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
  "MetaLeft", "MetaRight", "OSLeft", "OSRight", "CapsLock",
]);

/** `KeyF` → `F`, `Digit1`/`Numpad1` → `1`, `NumpadEnter` → `Enter`; anything
 *  else stays its code. */
function keyToken(code: string): string {
  const m = /^(?:Key([A-Z])|(?:Digit|Numpad)([0-9]))$/.exec(code);
  if (m) return m[1] ?? m[2];
  if (code === "NumpadEnter") return "Enter";
  return code;
}

/** The combo a key press makes, or null for a bare modifier. */
export function comboFromEvent(
  e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code">,
): string | null {
  if (!e.code || MODIFIER_CODES.has(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(keyToken(e.code));
  return parts.join("+");
}

/** A combo as typed by hand or stored by an older version (`ctrl+n`,
 *  `Control+KeyN`, `Shift+Ctrl+,`) in the canonical form, or null. */
export function normalizeCombo(raw: string): string | null {
  const parts = raw.split("+").map((p) => p.trim());
  // A trailing "+" is the key itself only as `Ctrl++`; Rmemo never binds it.
  const key = parts.pop();
  if (!key) return null;
  let ctrl = false, alt = false, shift = false;
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "ctrl" || l === "control" || l === "commandorcontrol" || l === "cmdorctrl") ctrl = true;
    else if (l === "alt" || l === "option") alt = true;
    else if (l === "shift") shift = true;
    else return null;
  }
  const PUNCT: Record<string, string> = {
    ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", "'": "Quote",
    "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "-": "Minus", "=": "Equal",
  };
  let token: string;
  if (/^[a-z0-9]$/i.test(key)) token = key.toUpperCase();
  else if (PUNCT[key]) token = PUNCT[key];
  else {
    const named: Record<string, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", esc: "Escape", return: "Enter" };
    const fixed = named[key.toLowerCase()] ?? key;
    token = keyToken(fixed.charAt(0).toUpperCase() + fixed.slice(1));
  }
  return [ctrl && "Ctrl", alt && "Alt", shift && "Shift", token].filter(Boolean).join("+");
}

export function matches(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code">, combo: string | null): boolean {
  return combo !== null && comboFromEvent(e) === combo;
}

/** Which action, if any, this key press is bound to. */
export function actionFor(
  e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "code">,
  keymap: Keymap,
): ActionId | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  for (const a of ACTIONS) if (keymap[a.id] === combo) return a.id;
  return null;
}

/** Labels for keys whose code says little; punctuation falls back to where
 *  it is on JIS when the layout is unknown. */
const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Escape: "Esc", Delete: "Del", Backspace: "BS", PageUp: "PgUp", PageDown: "PgDn",
  Quote: ":", Semicolon: ";", BracketRight: "[", Backslash: "]", BracketLeft: "@",
  Equal: "^", Minus: "-", Comma: ",", Period: ".", Slash: "/", IntlRo: "\\", IntlYen: "¥",
  Backquote: "半角/全角",
};

function keyLabel(token: string): string {
  const fromLayout = layout?.get(token);
  if (fromLayout && fromLayout.trim()) return fromLayout.toUpperCase();
  return KEY_LABELS[token] ?? token;
}

/** `Ctrl+Quote` → `Ctrl+:` for showing to people. */
export function formatCombo(combo: string | null): string {
  if (!combo) return "なし";
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  return [...parts, keyLabel(key)].join("+");
}

/** `label (Ctrl+K)` for a tooltip, or just the label when unbound. */
export function withKey(label: string, combo: string | null): string {
  return combo ? `${label} (${formatCombo(combo)})` : label;
}

/** Shortcuts the editor or the window already gives a fixed meaning. */
const RESERVED: Record<string, string> = {
  "Ctrl+C": "コピー", "Ctrl+X": "切り取り", "Ctrl+V": "貼り付け", "Ctrl+A": "すべて選択",
  "Ctrl+Z": "元に戻す", "Ctrl+Y": "やり直し", "Ctrl+Shift+Z": "やり直し",
  "Ctrl+Semicolon": "文字サイズ", "Ctrl+Minus": "文字サイズ", "Ctrl+0": "文字サイズ", "Ctrl+Equal": "文字サイズ",
  Escape: "閉じる", Enter: "改行", Tab: "インデント", "Shift+Tab": "インデント解除",
};

export function reservedFor(combo: string): string | null {
  return RESERVED[combo] ?? null;
}

/** Whether a combo can be bound in-app: needs Ctrl or Alt, unless it's an F-key
 *  — anything else would be swallowed while typing. */
export function isBindable(combo: string): boolean {
  return /^(Ctrl|Alt)\+/.test(combo) || /(^|\+)F([1-9]|1[0-9]|2[0-4])$/.test(combo);
}
