import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { NoteHeadingVisibility } from "../lib/noteMetadata";

interface NoteDocumentHeadingProps {
  title: string;
  subtitle: string;
  autoFocus?: boolean;
  visibility: NoteHeadingVisibility;
  titleRef: RefObject<HTMLTextAreaElement | null>;
  subtitleRef: RefObject<HTMLTextAreaElement | null>;
  onTitleChange: (title: string) => void;
  onSubtitleChange: (subtitle: string) => void;
  onFocusBody: () => void;
  onFocusSubtitle: () => void;
  onRemoveLine: (line: "title" | "subtitle") => void;
}

/** Optional first lines of the page, below the writing tools. Placeholders are
 * presentation only; Enter can pass through either line without naming a note. */
export function NoteDocumentHeading({
  title, subtitle, autoFocus = false, visibility, titleRef, subtitleRef,
  onTitleChange, onSubtitleChange, onFocusBody, onFocusSubtitle, onRemoveLine,
}: NoteDocumentHeadingProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const fields = [titleRef.current, subtitleRef.current];
    const resize = () => {
      for (const field of fields) {
        if (!field) continue;
        field.style.height = "auto";
        field.style.height = `${field.scrollHeight}px`;
      }
    };
    resize();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    // Observe width only: changing a field's height must not schedule itself.
    let width = container.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [title, subtitle, visibility.title, visibility.subtitle, titleRef, subtitleRef]);

  function moveBetweenLines(event: KeyboardEvent<HTMLTextAreaElement>, line: "title" | "subtitle") {
    if (event.nativeEvent.isComposing || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const field = event.currentTarget;
    const atStart = field.selectionStart === 0 && field.selectionEnd === 0;
    const atEnd = field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
    if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
      event.preventDefault();
      if (line === "title") onFocusSubtitle();
      else onFocusBody();
    } else if (event.key === "Backspace" && atStart && !field.value) {
      event.preventDefault();
      onRemoveLine(line);
    } else if (line === "subtitle" && atStart && event.key === "ArrowUp" && visibility.title) {
      event.preventDefault();
      titleRef.current?.focus();
      titleRef.current?.setSelectionRange(title.length, title.length);
    }
  }

  if (!visibility.title && !visibility.subtitle) return null;

  return (
    <div ref={containerRef} className="note-document-heading">
      {visibility.title ? <textarea
        ref={titleRef}
        className="note-title-input"
        value={title}
        placeholder="Title"
        aria-label="Note title"
        rows={1}
        autoFocus={autoFocus}
        onChange={(event) => onTitleChange(event.target.value)}
        onKeyDown={(event) => moveBetweenLines(event, "title")}
      /> : null}
      {visibility.subtitle ? <textarea
        ref={subtitleRef}
        className="note-summary-input"
        value={subtitle}
        placeholder="Subtitle"
        aria-label="Note summary"
        rows={1}
        autoFocus={autoFocus && !visibility.title}
        onChange={(event) => onSubtitleChange(event.target.value)}
        onKeyDown={(event) => moveBetweenLines(event, "subtitle")}
      /> : null}
    </div>
  );
}
