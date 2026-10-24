import { describe, expect, it } from "vitest";
import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("shows an added heading, a changed line and added tags", () => {
    const before = ["牛乳", "##買う物", "卵"];
    const after = ["# 買い物", "", "牛乳", "## 買う物", "卵", "", "#取り込み"];
    expect(lineDiff(before, after)).toEqual([
      { before: [], after: ["# 買い物", ""], changed: true },
      { before: ["牛乳"], after: ["牛乳"], changed: false },
      { before: ["##買う物"], after: ["## 買う物"], changed: true },
      { before: ["卵"], after: ["卵"], changed: false },
      { before: [], after: ["", "#取り込み"], changed: true },
    ]);
  });

  it("finds nothing to show in identical text", () => {
    expect(lineDiff(["a", "b"], ["a", "b"])).toEqual([{ before: ["a", "b"], after: ["a", "b"], changed: false }]);
  });

  it("keeps lines that moved past an edit lined up", () => {
    const blocks = lineDiff(["x", "", "", "", "y"], ["x", "", "---", "", "y"]);
    expect(blocks.filter((b) => b.changed)).toEqual([{ before: [""], after: ["---"], changed: true }]);
  });
});
