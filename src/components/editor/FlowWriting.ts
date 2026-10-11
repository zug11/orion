import { Extension, type Editor } from "@tiptap/core";
import { closeHistory, isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  advanceFlow, beginFlowComposition, changeFlow, createFlowSession, endFlowComposition,
  flowOpacity, MAX_FLOW_CHARACTERS, stopFlow, type FlowSession,
} from "../../lib/writingSession";

interface InlineFlow {
  baseline: ProseMirrorNode;
  from: number;
  session: FlowSession;
  now: number;
}
export const flowWritingKey = new PluginKey<InlineFlow | null>("orionFlowWriting");
export const FLOW_INTERNAL = "orionFlowInternal";
export const FLOW_RESULT = "orionFlowResult";
export const getInlineFlow = (editor: Editor) => flowWritingKey.getState(editor.state) ?? null;

/** Session paragraphs live in the real editor, but never enter autosave or history until kept. */
export function startInlineFlow(editor: Editor, durationMs: number, idleSeconds: number): boolean {
  if (editor.isDestroyed || !editor.isEditable || getInlineFlow(editor) || flowWritingKey.getState(editor.state) === undefined) return false;
  const baseline = editor.state.doc;
  const from = baseline.content.size;
  const flow: InlineFlow = { baseline, from, session: createFlowSession(durationMs, idleSeconds), now: Date.now() };
  const tr = editor.state.tr.insert(from, editor.schema.nodes.paragraph.create())
    .setMeta(flowWritingKey, flow).setMeta(FLOW_INTERNAL, true).setMeta("addToHistory", false);
  tr.setSelection(TextSelection.atEnd(tr.doc));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Removing unsaved paragraphs is also excluded from history: expiry has no Undo path. */
export function finishInlineFlow(editor: Editor, keep: boolean, now = Date.now()): boolean {
  const flow = getInlineFlow(editor);
  if (!flow || editor.isDestroyed) return false;
  let session = flow.session;
  if (session.composingAt !== null) session = endFlowComposition(session, session.text, now);
  session = keep ? stopFlow(session, now) : advanceFlow(session, now);
  const retain = keep && session.phase !== "lost";
  if (retain && !editor.isEditable) {
    editor.view.dispatch(editor.state.tr.setMeta(flowWritingKey, { ...flow, session, now }));
    return false;
  }
  const passage = editor.state.doc.content.cut(flow.from);
  const rollback = editor.state.tr.delete(flow.from, editor.state.doc.content.size)
    .setMeta(flowWritingKey, null).setMeta(FLOW_INTERNAL, true).setMeta("addToHistory", false);
  rollback.setSelection(TextSelection.atEnd(rollback.doc));
  if (!retain || !session.text.trim()) rollback.setMeta(FLOW_RESULT, retain ? "kept" : "lost");
  editor.view.dispatch(rollback);
  if (retain && session.text.trim()) {
    const commit = closeHistory(editor.state.tr).insert(flow.from, passage).setMeta(FLOW_RESULT, "kept");
    commit.setSelection(TextSelection.atEnd(commit.doc));
    editor.view.dispatch(commit);
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
  }
  return true;
}

export const FlowWriting = Extension.create({
  name: "orionFlowWriting",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin<InlineFlow | null>({
      key: flowWritingKey,
      state: {
        init: () => null,
        apply(tr, current) {
          const explicit = tr.getMeta(flowWritingKey) as InlineFlow | null | undefined;
          if (explicit !== undefined) return explicit;
          if (!current || !tr.docChanged) return current;
          const now = Date.now();
          const text = tr.doc.textBetween(current.from, tr.doc.content.size, "\n");
          return { ...current, now, session: changeFlow(current.session, text, now) };
        },
      },
      filterTransaction(tr, state) {
        const flow = flowWritingKey.getState(state);
        if (!flow || tr.getMeta(FLOW_INTERNAL) || !tr.docChanged) return true;
        // Protect every pre-session node and its formatting, including selection replacements.
        if (isHistoryTransaction(tr) || tr.doc.content.size < flow.from ||
          !tr.doc.content.cut(0, flow.from).eq(flow.baseline.content) ||
          tr.doc.textBetween(flow.from, tr.doc.content.size, "\n").length > MAX_FLOW_CHARACTERS ||
          ["lost", "complete"].includes(advanceFlow(flow.session, Date.now()).phase)) return false;
        tr.setMeta("addToHistory", false);
        return true;
      },
      props: {
        handleKeyDown(view, event) {
          // Provisional input has no history entry; prevent the browser's native
          // contenteditable Undo fallback while the passage is still at risk.
          return Boolean(flowWritingKey.getState(view.state) && (event.metaKey || event.ctrlKey) &&
            (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y"));
        },
        decorations(state) {
          const flow = flowWritingKey.getState(state);
          if (!flow) return null;
          const decorations: Decoration[] = [];
          state.doc.forEach((node, position) => {
            if (position >= flow.from) decorations.push(Decoration.node(position, position + node.nodeSize, {
              class: "flow-writing-passage", style: `opacity: ${flowOpacity(flow.session, flow.now)}`,
            }));
          });
          return DecorationSet.create(state.doc, decorations);
        },
        handleDOMEvents: {
          beforeinput(_view, event) {
            const inputType = (event as InputEvent).inputType;
            if (inputType !== "historyUndo" && inputType !== "historyRedo") return false;
            event.preventDefault();
            if (!getInlineFlow(editor)) {
              if (inputType === "historyUndo") editor.commands.undo(); else editor.commands.redo();
            }
            return true;
          },
          compositionstart(view) {
            const flow = flowWritingKey.getState(view.state);
            if (flow) view.dispatch(view.state.tr.setMeta(flowWritingKey, {
              ...flow, session: beginFlowComposition(flow.session, Date.now()), now: Date.now(),
            }));
            return false;
          },
          compositionend() {
            queueMicrotask(() => {
              if (editor.isDestroyed) return;
              const flow = getInlineFlow(editor);
              if (flow) editor.view.dispatch(editor.state.tr.setMeta(flowWritingKey, {
                ...flow, session: endFlowComposition(flow.session, flow.session.text, Date.now()), now: Date.now(),
              }));
            });
            return false;
          },
        },
      },
      view() {
        let interval: ReturnType<typeof setInterval> | undefined;
        const tick = () => {
          const flow = getInlineFlow(editor);
          if (!flow) return;
          const now = Date.now();
          let session = flow.session;
          if (session.composingAt !== null && (document.hidden || !editor.view.hasFocus())) {
            session = endFlowComposition(session, session.text, now);
          }
          session = advanceFlow(session, now);
          editor.view.dispatch(editor.state.tr.setMeta(flowWritingKey, { ...flow, session, now }));
          if (session.phase === "complete" || session.phase === "lost") finishInlineFlow(editor, session.phase === "complete", now);
        };
        window.addEventListener("focus", tick);
        document.addEventListener("visibilitychange", tick);
        return {
          update(view) {
            if (flowWritingKey.getState(view.state) && interval === undefined) interval = setInterval(tick, 100);
            else if (!flowWritingKey.getState(view.state) && interval !== undefined) {
              clearInterval(interval); interval = undefined;
            }
          },
          destroy() {
            clearInterval(interval);
            window.removeEventListener("focus", tick);
            document.removeEventListener("visibilitychange", tick);
          },
        };
      },
    })];
  },
});
