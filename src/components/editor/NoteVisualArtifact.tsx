import { Node, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { SavedVisualArtifact } from "../SavedVisualArtifact";
import { isVisualArtifactMarker, readVisualArtifactMarker, unavailableVisualArtifact, visualArtifactMarker } from "../../lib/visualArtifactMarkdown";
import type { VisualArtifact } from "../../lib/visualArtifacts";
import { getSlashMatch, matchingSlashItems } from "./slashCommands";

function ArtifactNodeView({ node }: NodeViewProps) {
  return <NodeViewWrapper as="div" data-narration-ignore="true" contentEditable={false}>
    <SavedVisualArtifact marker={node.attrs.marker}/>
  </NodeViewWrapper>;
}

export const NoteVisualArtifact = Node.create({
  name: "noteVisualArtifact", group: "block", atom: true, selectable: true,
  addAttributes() {
    return { marker: { default: "", parseHTML: el => el.getAttribute("data-orion-artifact"),
      renderHTML: attrs => ({ "data-orion-artifact": attrs.marker }) } };
  },
  parseHTML() {
    return [{ tag: "aside[data-orion-artifact]", getAttrs: el => isVisualArtifactMarker(el.getAttribute("data-orion-artifact")) ? null : false }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["aside", HTMLAttributes, readVisualArtifactMarker(HTMLAttributes["data-orion-artifact"])?.title ?? unavailableVisualArtifact];
  },
  markdownTokenizer: {
    name: "noteVisualArtifact", level: "block",
    start(source) { const match = /^<!-- orion-artifact:v/m.exec(source); return match?.index ?? -1; },
    tokenize(source) {
      const match = /^(<!-- orion-artifact:v[^\r\n]* -->)(?:\r?\n|$)/.exec(source);
      if (match && isVisualArtifactMarker(match[1])) return { type: "noteVisualArtifact", raw: match[0], marker: match[1] };
    },
  },
  parseMarkdown(token) { return { type: "noteVisualArtifact", attrs: { marker: token.marker } }; },
  renderMarkdown(node) { return isVisualArtifactMarker(node.attrs?.marker) ? node.attrs.marker : ""; },
  addNodeView() {
    return ReactNodeViewRenderer(ArtifactNodeView, {
      stopEvent: ({ event }) => event.target instanceof Element && !!event.target.closest("button,input,select,textarea,label"),
    });
  },
});

interface Range { from: number; to: number }
export interface VisualArtifactCapture {
  editor: Editor;
  document: ProseMirrorNode;
  end: number;
  command?: Range;
  replaceCommandParagraph?: boolean;
}

export function captureVisualArtifactAfterBlock(editor: Editor, topLevelEnd: number): VisualArtifactCapture | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const doc = editor.state.doc;
  if (!Number.isInteger(topLevelEnd) || topLevelEnd <= 0 || topLevelEnd > doc.content.size || doc.resolve(topLevelEnd).depth !== 0) return null;
  return { editor, document: doc, end: topLevelEnd };
}

export function captureVisualArtifact(editor: Editor, command?: Range) {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { doc, selection } = editor.state;
  let source: string;
  let replaceCommandParagraph = false;
  let endpoint = selection.$to;
  if (command) {
    const match = getSlashMatch(editor.state);
    if (!match || match.from !== command.from || match.to !== command.to || !matchingSlashItems(match).some(item => item.id === "visualise")) return null;
    const parent = selection.$from.parent;
    const start = selection.$from.start();
    source = parent.textBetween(0, command.from - start, "\n") + parent.textBetween(command.to - start, parent.content.size, "\n");
    replaceCommandParagraph = selection.$from.depth === 1 && parent.type.name === "paragraph" && parent.content.size === command.to - command.from;
  } else {
    if (selection.empty) return null;
    source = doc.textBetween(selection.from, selection.to, "\n", " ");
    if (!source.trim()) return null;
    // A native paragraph selection can end at the start of the following block.
    // Anchor to the last selected text rather than skipping that following block.
    doc.nodesBetween(selection.from, selection.to, (node, position) => {
      if (!node.isText) return;
      const end = Math.min(position + node.nodeSize, selection.to);
      const start = Math.max(position, selection.from);
      if (node.text!.slice(start - position, end - position).trim()) endpoint = doc.resolve(end);
    });
  }
  const end = endpoint.depth ? endpoint.after(1) : endpoint.pos;
  const capture = captureVisualArtifactAfterBlock(editor, end);
  return capture ? { capture: { ...capture, command, replaceCommandParagraph }, source: source.trim() } : null;
}

/** Keep both the source block and the original slash command intact until generation succeeds. */
export function insertVisualArtifact(editor: Editor, capture: VisualArtifactCapture, artifact: VisualArtifact): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor !== capture.editor || editor.state.doc !== capture.document) return false;
  const type = editor.schema.nodes.noteVisualArtifact;
  if (!type) return false;
  let marker: string;
  try { marker = visualArtifactMarker(artifact); } catch { return false; }
  const tr = closeHistory(editor.state.tr);
  const node = type.create({ marker });
  if (capture.command && capture.replaceCommandParagraph) {
    tr.replaceWith(capture.command.from - 1, capture.end, node);
  } else {
    if (capture.command) tr.delete(capture.command.from, capture.command.to);
    tr.insert(tr.mapping.map(capture.end), node);
  }
  editor.view.dispatch(tr);
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
  return true;
}
