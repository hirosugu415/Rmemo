import { describe, expect, it } from "vitest";
import { findMatches, foldText } from "./kana";

describe("foldText", () => {
  it("folds like notes::kana::fold, one unit per unit", () => {
    expect(foldText("リンゴ")).toBe("りんご");
    expect(foldText("ＡＢＣ　ｘｙ")).toBe("abc xy");
    expect(foldText("ｶﾀｶﾅ")).toBe("かたかな");
    expect(foldText("Rust")).toBe("rust");
    expect(foldText("📌リ").length).toBe("📌リ".length);
  });
});

describe("findMatches", () => {
  it("finds folded needles at their places in the original", () => {
    const text = "今日はリンゴとりんごを買う";
    expect(findMatches(text, ["りんご"]).map(([s, e]) => text.slice(s, e))).toEqual(["リンゴ", "りんご"]);
  });

  it("prefers the longer needle and never overlaps", () => {
    expect(findMatches("rust-lang", ["rust", "rust-lang"])).toEqual([[0, 9]]);
  });
});
