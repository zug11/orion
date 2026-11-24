import { useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Settings } from "../types";
import { resolveReadingArtifactEnd, type ReadingArtifactPassage } from "../lib/readingArtifactPassage";
import { captureVisualArtifactAfterBlock, insertVisualArtifact } from "./editor/NoteVisualArtifact";
import { VisualiseComposer } from "./VisualiseComposer";

/** Freeze the writing position once the editor for the captured note has mounted. */
export function ReadingVisualise({ passage, settings, editor, onClose, current }: {
  passage: ReadingArtifactPassage; settings: Settings; editor: Editor;
  onClose: (inserted: boolean) => void; current: () => boolean;
}) {
  const [capture] = useState(() => {
    const end = resolveReadingArtifactEnd(editor.state.doc, passage.block);
    return end === undefined ? null : captureVisualArtifactAfterBlock(editor, end);
  });
  const inserted = useRef(false);
  if (!capture) return <div className="visualise-location-error" role="alert">
    Select the passage again in the editor to place the artifact.
    <button className="text-button" onClick={() => onClose(true)}>Continue editing</button>
  </div>;
  return <VisualiseComposer source={passage.source} anchor={passage.anchor} settings={settings}
    onClose={() => onClose(inserted.current)}
    onInsert={artifact => {
      inserted.current = current() && insertVisualArtifact(editor, capture, artifact);
      return inserted.current;
    }} />;
}
