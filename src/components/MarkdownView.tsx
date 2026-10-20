import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { LivePreviewHandlers } from "../editor/livePreview";
import { readOnlyExtensions } from "../editor/setup";
import { platform } from "../platform";

interface Props {
  body: string;
  className?: string;
  onTagClick?: (tag: string) => void;
  /** A `[[title]]` link was followed. */
  onOpenNote?: (title: string) => void;
  /** Whether a `[[title]]` resolves (missing ones are drawn dashed). */
  noteExists?: (title: string) => boolean;
}

/**
 * A note shown read-only with exactly the editor's Markdown look (headings,
 * code blocks with copy buttons, checkboxes, links) — same extensions, just
 * not editable. Links, tags and `[[note links]]` open with a plain click
 * (or tap) here; there's no text cursor for a click to mean anything else.
 */
export default function MarkdownView({ body, className, onTagClick, onOpenNote, noteExists }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const handlersRef = useRef<LivePreviewHandlers>({
    onTagClick: () => {},
    onOpenUrl: (url: string) => platform().openUrl(url),
  });
  Object.assign(handlersRef.current, {
    onTagClick: (tag: string) => onTagClick?.(tag),
    onOpenNote,
    noteExists,
  });

  const makeState = (doc: string) =>
    EditorState.create({ doc, extensions: readOnlyExtensions(() => handlersRef.current) });

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current!, state: makeState(body) });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === body) return;
    view.setState(makeState(body));
    view.scrollDOM.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  return <div className={className} ref={hostRef} />;
}
