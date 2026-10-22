// Editing commands, run against a real EditorState with Rmemo's Markdown
// setup — only the view is faked (commands just read `state` and call
// `dispatch`), so no DOM is needed.

import { deleteCharBackward, deleteCharForward } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  applyLink,
  codeLangTarget,
  demoteHeadingOnBackspace,
  indentLines,
  linkAwareClipboard,
  linkTarget,
  linkTailEnter,
  listEnter,
  listIndent,
  pairedMarkDelete,
  parseImageAlt,
  setCodeLang,
  setHeading,
  setImageWidth,
  toggleInline,
  toggleTaskAt,
} from "./livePreview";
import { markdownSupport } from "./setup";

/** `|` marks the caret, `[` `]` a selection (one of either). */
function view(text: string): EditorView & { state: EditorState } {
  let doc = text;
  let selection = EditorSelection.single(0);
  const caret = doc.indexOf("|");
  if (caret >= 0) {
    doc = doc.slice(0, caret) + doc.slice(caret + 1);
    selection = EditorSelection.single(caret);
  } else if (doc.includes("[") && doc.includes("]") && !doc.includes("](") && !doc.includes("[[")) {
    const a = doc.indexOf("[");
    doc = doc.replace("[", "");
    const b = doc.indexOf("]");
    doc = doc.replace("]", "");
    selection = EditorSelection.single(a, b);
  }
  return fromState(doc, selection);
}

function fromState(doc: string, selection: EditorSelection) {
  const make = (s: EditorState) => {
    ensureSyntaxTree(s, s.doc.length, 5000);
    return s;
  };
  const v = {
    state: make(
      EditorState.create({
        doc,
        selection,
        extensions: [markdownSupport(), EditorState.allowMultipleSelections.of(true)],
      }),
    ),
    composing: false,
    dispatch(...specs: TransactionSpec[]) {
      v.state = make(v.state.update(...specs).state);
    },
  };
  return v as unknown as EditorView & { state: EditorState };
}

const text = (v: { state: EditorState }) => v.state.doc.toString();
const selected = (v: { state: EditorState }) => {
  const m = v.state.selection.main;
  return v.state.sliceDoc(m.from, m.to);
};

describe("toggleInline", () => {
  it("wraps a selection and unwraps it again", () => {
    const v = fromState("太字にする 斜体", EditorSelection.single(0, 5));
    toggleInline(v, "bold");
    expect(text(v)).toBe("**太字にする** 斜体");
    expect(selected(v)).toBe("太字にする");
    toggleInline(v, "bold");
    expect(text(v)).toBe("太字にする 斜体");
  });

  it("does nothing on blank lines, however often pressed", () => {
    const v = fromState("a\n\n\nb", EditorSelection.single(1, 4));
    toggleInline(v, "bold");
    toggleInline(v, "bold");
    expect(text(v)).toBe("a\n\n\nb");
  });

  it("dissolves inner bold and wraps the outermost extent", () => {
    const v = fromState("x **b** y z", EditorSelection.single(0, 11));
    toggleInline(v, "bold");
    expect(text(v)).toBe("**x b y z**");
  });

  it("merges with bold the selection overlaps", () => {
    const v = fromState("aa **bb cc** dd", EditorSelection.single(6, 15));
    toggleInline(v, "bold");
    expect(text(v)).toBe("aa **bb cc dd**");
  });

  it("works per line, skipping surrounding spaces", () => {
    const v = fromState("line1\n\n  line2  ", EditorSelection.single(0, 16));
    toggleInline(v, "bold");
    expect(text(v)).toBe("**line1**\n\n  **line2**  ");
  });

  it("leaves a blank line alone at a bare caret (no `****` rule)", () => {
    const v = view("a\n|\nb");
    toggleInline(v, "bold");
    expect(text(v)).toBe("a\n\nb");
  });

  it("inserts an empty pair at a bare caret", () => {
    const v = view("a |b");
    toggleInline(v, "italic");
    expect(text(v)).toBe("a **b");
    expect(v.state.selection.main.head).toBe(3);
  });

  it("does inline code too", () => {
    const v = fromState("run npm install now", EditorSelection.single(4, 15));
    toggleInline(v, "code");
    expect(text(v)).toBe("run `npm install` now");
  });
});

describe("headings", () => {
  it("sets, changes and toggles off a heading", () => {
    const v = view("タイトル|");
    setHeading(v, 2);
    expect(text(v)).toBe("## タイトル");
    setHeading(v, 1);
    expect(text(v)).toBe("# タイトル");
    setHeading(v, 1);
    expect(text(v)).toBe("タイトル");
  });

  it("Backspace right after `## ` demotes instead of making a #tag", () => {
    const v = view("## |見出し");
    expect(demoteHeadingOnBackspace(v)).toBe(true);
    expect(text(v)).toBe("見出し");
    expect(demoteHeadingOnBackspace(view("## 見|出し"))).toBe(false);
  });
});

describe("lists and quotes", () => {
  it("continues a list and ends it on an empty item", () => {
    const v = view("- りんご|");
    listEnter(v);
    expect(text(v)).toBe("- りんご\n- ");
    listEnter(v);
    expect(text(v)).toBe("- りんご\n");
  });

  it("ends the list on an empty item right away, also after one item", () => {
    const v = view("- a\n- b\n- |");
    listEnter(v);
    expect(text(v)).toBe("- a\n- b\n");
    const nested = view("- a\n    - |");
    listEnter(nested);
    expect(text(nested)).toBe("- a\n- ");
  });

  it("continues numbering and task items", () => {
    const v = view("1. 一|");
    listEnter(v);
    expect(text(v)).toBe("1. 一\n2. ");
    const t = view("- [ ] 買う|");
    listEnter(t);
    expect(text(t)).toBe("- [ ] 買う\n- [ ] ");
  });

  it("continues a quote and leaves it on an empty `> ` line", () => {
    const v = view("> 引用|");
    listEnter(v);
    expect(text(v)).toBe("> 引用\n> ");
    listEnter(v);
    expect(text(v)).toBe("> 引用\n");
  });

  it("Enter at a link's hidden `](url)` moves past the link instead of splitting it", () => {
    const v = view("見出し [記事|](https://example.com) あと");
    expect(linkTailEnter(v)).toBe(false);
    expect(v.state.selection.main.head).toBe("見出し [記事](https://example.com)".length);
    const inList = view("- [記事|](https://example.com)");
    linkTailEnter(inList);
    listEnter(inList);
    expect(text(inList)).toBe("- [記事](https://example.com)\n- ");
    const mid = view("[記|事](https://example.com)");
    linkTailEnter(mid);
    expect(mid.state.selection.main.head).toBe(2);
  });

  it("copy / cut of link text carries the link along", () => {
    const doc = "前 [記事](https://e.com) 後";
    const lf = doc.indexOf("記");
    // Just the visible label (the markup is hidden).
    const label = fromState(doc, EditorSelection.single(lf, lf + 2));
    expect(linkAwareClipboard(label.state)).toEqual({
      text: "[記事](https://e.com)",
      cut: [{ from: 2, to: doc.indexOf(" 後") }],
    });
    // Part of the label plus text before it: Cut keeps a shorter link.
    const part = fromState(doc, EditorSelection.single(0, lf + 1));
    const p = linkAwareClipboard(part.state)!;
    expect(p.text).toBe("前 [記](https://e.com)");
    expect(p.cut).toEqual([{ from: 0, to: 2 }, { from: lf, to: lf + 1 }]);
    // Whole line: unchanged text.
    expect(linkAwareClipboard(fromState(doc, EditorSelection.single(0, doc.length)).state)!.text).toBe(doc);
    // No link involved → ordinary copy.
    expect(linkAwareClipboard(fromState(doc, EditorSelection.single(0, 1)).state)).toBeNull();
  });

  it("Backspace / Delete next to hidden markers act on what's visible", () => {
    const bs = (s: string) => {
      const v = view(s);
      if (!pairedMarkDelete(v, false)) deleteCharBackward(v);
      return text(v);
    };
    const del = (s: string) => {
      const v = view(s);
      if (!pairedMarkDelete(v, true)) deleteCharForward(v);
      return text(v);
    };
    // Start of a link label: the character before the link goes.
    expect(bs("前 [|記事](https://e.com)")).toBe("前[記事](https://e.com)");
    // Just after a link: its last character goes, then the whole link.
    expect(bs("[記事](https://e.com)| 後")).toBe("[記](https://e.com) 後");
    expect(bs("[記](https://e.com)| 後")).toBe(" 後");
    // Delete mirrors it.
    expect(del("前 |[記事](https://e.com)")).toBe("前 [事](https://e.com)");
    expect(del("[記事|](https://e.com) 後")).toBe("[記事](https://e.com)後");
    // Bold / italic / strike / code the same way.
    expect(bs("a **|太字**")).toBe("a**太字**");
    expect(bs("**太字**|")).toBe("**太**");
    expect(del("|*斜*")).toBe("");
    expect(del("前*|斜*")).toBe("前");
    expect(bs("x ~~消~~|")).toBe("x ");
    expect(bs("`code`|")).toBe("`cod`");
    // Nested: through the bold into the link.
    expect(bs("[**ab**](https://e.com)|")).toBe("[**a**](https://e.com)");
    expect(bs("x [**a**](https://e.com)|")).toBe("x ");
    // A note link's page icon: deleting it unlinks the note.
    expect(bs("[[|メモ]]")).toBe("メモ");
    expect(del("|[[メモ]]")).toBe("メモ");
    expect(bs("[[メモ]]|")).toBe("[[メ]]");
    // Plain text: not ours.
    expect(pairedMarkDelete(view("ab|c"), false)).toBe(false);
  });

  it("leaves Enter alone in plain text", () => {
    expect(listEnter(view("ただの文|"))).toBe(false);
  });

  it("Tab nests a list item, not plain text", () => {
    const v = view("- a\n- b|");
    expect(listIndent(v, 4, 1)).toBe(true);
    expect(text(v)).toBe("- a\n    - b");
    expect(listIndent(view("plain|"), 4, 1)).toBe(false);
  });

  it("ticks and unticks a checkbox", () => {
    const v = fromState("- [ ] やること", EditorSelection.single(0));
    toggleTaskAt(v, 0);
    expect(text(v)).toBe("- [x] やること");
    toggleTaskAt(v, 0);
    expect(text(v)).toBe("- [ ] やること");
  });
});

describe("indentLines", () => {
  it("acts on every cursor's line once", () => {
    const v = fromState("a\nb\nc\nd", EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(4)]));
    indentLines(v, 4, 1);
    expect(text(v)).toBe("    a\nb\n    c\nd");
    indentLines(v, 4, -1);
    expect(text(v)).toBe("a\nb\nc\nd");
  });
});

describe("links", () => {
  it("links the selection, then edits and removes the URL", () => {
    const v = fromState("ここを リンク にする", EditorSelection.single(4, 7));
    const fresh = linkTarget(v.state);
    expect(fresh.label).toBe("リンク");
    applyLink(v, fresh, "https://example.com/a b", fresh.label);
    expect(text(v)).toBe("ここを [リンク](https://example.com/a%20b) にする");

    v.dispatch({ selection: { anchor: 6 } });
    const target = linkTarget(v.state);
    expect(target.existing).toBe(true);
    expect(target.url).toBe("https://example.com/a%20b");
    applyLink(v, target, "", target.label);
    expect(text(v)).toBe("ここを リンク にする");
  });
});

describe("images", () => {
  it("reads and writes the |width size", () => {
    expect(parseImageAlt("図|300")).toEqual({ alt: "図", width: 300 });
    expect(parseImageAlt("図")).toEqual({ alt: "図", width: null });
    const v = view("![図](../assets/a.webp)");
    setImageWidth(v, 0, 200);
    expect(text(v)).toBe("![図|200](../assets/a.webp)");
    setImageWidth(v, 0, null);
    expect(text(v)).toBe("![図](../assets/a.webp)");
  });
});

describe("code block language", () => {
  it("sets the language after the opening fence", () => {
    const v = view("```\nx = 1\n```");
    const target = codeLangTarget(v.state, 0)!;
    expect(target.lang).toBe("");
    setCodeLang(v, target, "python");
    expect(text(v)).toBe("```python\nx = 1\n```");
    setCodeLang(v, codeLangTarget(v.state, 0)!, "rust");
    expect(text(v)).toBe("```rust\nx = 1\n```");
  });
});
