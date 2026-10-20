import type { OutlineItem } from "../markdown";

interface Props {
  items: OutlineItem[];
  /** Index of the section currently in view, or -1. */
  active: number;
  onJump: (from: number) => void;
  /** "panel": always-visible column beside the text (wrapping titles).
   *  "rail": note.com-style slim bars that open into the list on hover —
   *  used when the editor is too narrow to spare a column. */
  mode: "panel" | "rail";
}

export default function TableOfContents({ items, active, onJump, mode }: Props) {
  const minLevel = Math.min(...items.map((it) => it.level));
  const list = (
    <ul>
      {items.map((it, i) => (
        <li key={it.from}>
          <button
            type="button"
            className={i === active ? "toc-item toc-item-active" : "toc-item"}
            style={{ paddingLeft: `${8 + (it.level - minLevel) * 10}px` }}
            // The editor keeps focus; the click only moves its caret.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onJump(it.from)}
            title={it.text}
          >
            {it.text}
          </button>
        </li>
      ))}
    </ul>
  );

  if (mode === "panel") {
    return (
      <nav className="toc toc-mode-panel" aria-label="目次">
        <div className="toc-panel-title">目次</div>
        {list}
      </nav>
    );
  }

  return (
    <nav className="toc toc-mode-rail" aria-label="目次">
      <div className="toc-rail" aria-hidden="true">
        {items.map((it, i) => (
          <span
            key={it.from}
            className={i === active ? "toc-bar toc-bar-active" : "toc-bar"}
            style={{ width: `${Math.max(6, 16 - (it.level - minLevel) * 4)}px` }}
          />
        ))}
      </div>
      <div className="toc-panel">
        <div className="toc-panel-title">目次</div>
        {list}
      </div>
    </nav>
  );
}
