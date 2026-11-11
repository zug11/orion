import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import { countableText, countWords, createDocumentWordCounter, selectedCountableText } from "../lib/wordCount";

interface Props {
  root: RefObject<HTMLElement | null>;
  editor: Editor | null;
  editing: boolean;
  title: string;
  subtitle: string;
  body: string;
}

export function NoteWordCount({ root, editor, editing, title, subtitle, body }: Props) {
  const [counts, setCounts] = useState({ total: 0, selected: null as number | null });
  const [counter] = useState(() => createDocumentWordCounter());
  const current = useRef({ title, subtitle, body });
  current.current = { title, subtitle, body };
  const schedule = useRef<() => void>(() => undefined);

  useEffect(() => {
    let frame = 0;
    let reading: { body: string; words: number } | undefined;
    const refresh = () => {
      frame = 0;
      const surface = root.current;
      if (!surface) return;
      // Keep the reading count while the lazy editor mounts, and never count
      // a detached editor retained briefly during note navigation.
      if (editing && (!editor || editor.isDestroyed || !surface.contains(editor.view.dom))) return;
      let words = 0;
      let selected: number | null = null;
      const rich = editing && editor && !editor.isDestroyed ? editor : null;
      if (rich) words = counter(rich.state.doc);
      else {
        if (!reading || reading.body !== current.current.body) {
          const prose = surface.querySelector('[data-voice-note-body="reading"]');
          reading = { body: current.current.body, words: prose ? countWords(countableText(prose)) : 0 };
        }
        words = reading.words;
      }
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && surface.contains(active)
        && ["Note title", "Note summary"].includes(active.getAttribute("aria-label") ?? "")) {
        if (active.selectionStart !== active.selectionEnd) selected = countWords(active.value.slice(active.selectionStart, active.selectionEnd));
      } else if (rich && active && rich.view.dom.contains(active)) {
        const selection = rich.state.selection;
        if (!selection.empty) {
          const text = selection.ranges.map(({ $from, $to }) => rich.state.doc.textBetween($from.pos, $to.pos, "\n", " ")).join("\n");
          if (text) selected = countWords(text);
        }
      } else {
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed && selection.rangeCount) {
          const range = selection.getRangeAt(0);
          const scopes = surface.querySelectorAll('[data-narration-text="title"],[data-narration-text="summary"],[data-voice-note-body="reading"]');
          const text = Array.from(scopes, scope => selectedCountableText(range, scope)).join("\n").trim();
          if (text) selected = countWords(text);
        }
      }
      const total = words + countWords(current.current.title) + countWords(current.current.subtitle);
      setCounts(previous => previous.total === total && previous.selected === selected ? previous : { total, selected });
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    schedule.current = queue;
    refresh();
    editor?.on("transaction", queue);
    document.addEventListener("selectionchange", queue);
    root.current?.addEventListener("select", queue, true);
    root.current?.addEventListener("focusin", queue);
    const surface = root.current;
    return () => {
      cancelAnimationFrame(frame);
      schedule.current = () => undefined;
      editor?.off("transaction", queue);
      document.removeEventListener("selectionchange", queue);
      surface?.removeEventListener("select", queue, true);
      surface?.removeEventListener("focusin", queue);
    };
  }, [root, editor, editing, counter]);

  useEffect(() => { schedule.current(); }, [title, subtitle, body]);
  const total = counts.total.toLocaleString();
  return <div className="note-word-count">
    <output className="note-word-count__glass" aria-label="Word count" aria-live="off">
      {counts.selected === null ? total : `${counts.selected.toLocaleString()} of ${total}`} {counts.total === 1 ? "word" : "words"}
    </output>
  </div>;
}
