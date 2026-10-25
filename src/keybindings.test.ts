import { describe, expect, it } from "vitest";
import { actionFor, comboFromEvent, formatCombo, isBindable, normalizeCombo, resolveKeymap } from "./keybindings";

const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
});

describe("comboFromEvent", () => {
  it("names letters, digits and other keys canonically", () => {
    expect(comboFromEvent(key("KeyF", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+F");
    expect(comboFromEvent(key("Numpad2", { ctrl: true, alt: true }))).toBe("Ctrl+Alt+2");
    expect(comboFromEvent(key("Quote", { ctrl: true }))).toBe("Ctrl+Quote");
    expect(comboFromEvent(key("NumpadEnter", { ctrl: true }))).toBe("Ctrl+Enter");
  });

  it("ignores a modifier on its own", () => {
    expect(comboFromEvent(key("ShiftLeft", { shift: true }))).toBeNull();
  });
});

describe("normalizeCombo", () => {
  it("accepts accelerator spellings", () => {
    expect(normalizeCombo("ctrl+n")).toBe("Ctrl+N");
    expect(normalizeCombo("Shift+Control+KeyN")).toBe("Ctrl+Shift+N");
    expect(normalizeCombo("Ctrl+,")).toBe("Ctrl+Comma");
    expect(normalizeCombo("Alt+Up")).toBe("Alt+ArrowUp");
    expect(normalizeCombo("f1")).toBe("F1");
    expect(normalizeCombo("Hyper+N")).toBeNull();
  });
});

describe("resolveKeymap", () => {
  it("puts overrides over the defaults, with \"\" meaning unbound", () => {
    const map = resolveKeymap({ bold: "Ctrl+Shift+B", link: "" });
    expect(map.bold).toBe("Ctrl+Shift+B");
    expect(map.link).toBeNull();
    expect(map.italic).toBe("Ctrl+I");
    expect(actionFor(key("KeyB", { ctrl: true, shift: true }), map)).toBe("bold");
    expect(actionFor(key("KeyB", { ctrl: true }), map)).toBeNull();
  });
});

it("formats and gates combos", () => {
  expect(formatCombo("Ctrl+Quote")).toBe("Ctrl+:");
  expect(formatCombo("Alt+Shift+ArrowUp")).toBe("Alt+Shift+↑");
  expect(formatCombo(null)).toBe("なし");
  expect(isBindable("Ctrl+K")).toBe(true);
  expect(isBindable("F2")).toBe(true);
  expect(isBindable("Shift+K")).toBe(false);
});
