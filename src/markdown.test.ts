import { describe, expect, it } from "vitest";
import parity from "../fixtures/markdown-parity.json";
import {
  charCount,
  codeMask,
  extractTags,
  findTags,
  findWikiLinks,
  guessLanguage,
  headingLevelOfLine,
  outlineOf,
  snippetOf,
  stripInline,
  titleOf,
} from "./markdown";

// The same cases run against the Rust implementation
// (`notes::tags::tests::matches_the_shared_parity_fixture`).
describe("parity with the backend", () => {
  it.each(parity.tags)("tags of $body", ({ body, tags }) => {
    expect(extractTags(body)).toEqual(tags);
  });

  it.each(parity.charCount)("charCount of $body", ({ body, count }) => {
    expect(charCount(body)).toBe(count);
  });

  it.each(parity.titles)("title of $body", ({ body, title }) => {
    expect(titleOf(body)).toBe(title);
  });

  it.each(parity.snippets)("snippet of $body", ({ body, snippet }) => {
    expect(snippetOf(body)).toBe(snippet);
  });

  it("caps long snippets at 200 characters", () => {
    const s = snippetOf("t\n" + "あ".repeat(250));
    expect(Array.from(s)).toHaveLength(201);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("findTags", () => {
  it("reports UTF-16 offsets usable as editor positions", () => {
    const s = "🍣 #寿司 と #a";
    const hits = findTags(s);
    expect(hits.map((h) => s.slice(h.from, h.to))).toEqual(["#寿司", "#a"]);
  });
});

describe("codeMask", () => {
  it("masks fenced code, inline code, link targets and bare URLs", () => {
    const s = "a `b` [c](d) https://e.f g\n```\nh\n```\ni";
    const masked = [...s].filter((_, i) => codeMask(s)[i]).join("");
    // Line breaks themselves are never masked — only the text on each line.
    expect(masked).toBe("`b`(d)https://e.f```h```");
  });
});

describe("outlineOf / headingLevelOfLine", () => {
  it("lists headings outside code, with inline markup stripped", () => {
    const s = "# A\n```\n# not\n```\n## **B** ##\n#tag\n#### \n### C";
    expect(outlineOf(s).map((o) => [o.level, o.text])).toEqual([
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ]);
  });

  it("needs a space after the hashes", () => {
    expect(headingLevelOfLine("## 見出し")).toBe(2);
    expect(headingLevelOfLine("##見出し")).toBe(0);
    expect(headingLevelOfLine("#")).toBe(0);
  });
});

describe("stripInline", () => {
  it("keeps the text, drops the markup", () => {
    expect(stripInline("**太字** と [リンク](https://x) `c` ~~s~~ *i*")).toBe("太字 と リンク c s i");
    expect(stripInline("![図|300](../assets/a.webp)")).toBe("図");
  });
});

describe("findWikiLinks", () => {
  it("finds [[links]] outside code, trimmed", () => {
    const s = "[[買い物メモ]] `[[コード]]` [[ 余白 ]] [[]] [[改\n行]]";
    expect(findWikiLinks(s).map((w) => w.title)).toEqual(["買い物メモ", "余白"]);
  });
});

describe("guessLanguage", () => {
  it.each([
    ["def f(x):\n    return x", "python"],
    ["fn main() { let mut x = 1; }", "rust"],
    ["const a = () => 1;", "js"],
    ["interface A { x: number }", "ts"],
    ['{ "a": 1 }', "json"],
    ["SELECT id FROM t;", "sql"],
    ["npm install", "bash"],
    ["<div>x</div>", "html"],
    ["ただの文章", null],
  ])("%s → %s", (code, lang) => {
    expect(guessLanguage(code)).toBe(lang);
  });
});
