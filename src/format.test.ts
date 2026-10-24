import { describe, expect, it } from "vitest";
import { applyEdits, formatEdits } from "./format";

const format = (text: string) => applyEdits(text, formatEdits(text));

describe("整形", () => {
  it("turns long runs of blank lines into a rule", () => {
    expect(format("a\n\n\n\nb")).toBe("a\n\n---\n\nb");
    expect(format("a\n\nb\n\n\n\nc")).toBe("a\n\nb\n\n---\n\nc");
    // Two blank lines are just a wider gap.
    expect(format("a\n\n\nb")).toBe("a\n\n\nb");
    // Not at the very start or end, and not inside code.
    expect(format("\n\n\na\n\n\n")).toBe("\n\n\na\n\n\n");
    expect(format("```\nx\n\n\n\ny\n```")).toBe("```\nx\n\n\n\ny\n```");
  });

  it("makes ・ lines a list, nested by their indent", () => {
    expect(format("・一つ目\n・二つ目\n　・下の階層")).toBe("- 一つ目\n- 二つ目\n  - 下の階層");
  });

  it("reads a ・ line followed by plain lines as a label", () => {
    const before = "・要件たち\n雨雲レーダー\nバックグラウンド通知\n（位置情報）\n\n\n\n・現実\nバックグラウンド処理は難しそう";
    expect(format(before)).toBe(
      "### 要件たち\n- 雨雲レーダー\n- バックグラウンド通知\n- （位置情報）\n\n---\n\n### 現実\n- バックグラウンド処理は難しそう",
    );
  });

  it("makes a short line ending in a colon a heading", () => {
    expect(format("機能：\n位置情報から通知する")).toBe("### 機能\n位置情報から通知する");
    expect(format("Memo:\nx")).toBe("### Memo\nx");
    // Not: a value after the colon, a long sentence, a URL, nothing after it.
    const kept = [
      "池田 緯度: 34.80812\nx",
      "これはとても長い一文で、説明のために書いたものです、つまり：\nx",
      "https:\nx",
      "最後：",
      "- 項目：\nx",
    ];
    for (const text of kept) expect(format(text)).toBe(text);
  });

  it("leaves a note with nothing to fix alone", () => {
    expect(formatEdits("# 見出し\n本文\n\n- 項目")).toEqual([]);
  });
});
