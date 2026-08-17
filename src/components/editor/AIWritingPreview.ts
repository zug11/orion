import { Extension } from "@tiptap/core";
import { DOMSerializer, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface AIWritingPreviewState {
  from: number;
  to: number;
  previewAt: number;
  proposal: ProseMirrorNode;
  revision: number;
  label?: string;
  ariaLabel?: string;
}

export const aiWritingPreviewPluginKey = new PluginKey<
  AIWritingPreviewState | null
>("orionAIWritingPreview");

export const AIWritingPreview = Extension.create({
  name: "orionAIWritingPreview",

  addProseMirrorPlugins() {
    return [
      new Plugin<AIWritingPreviewState | null>({
        key: aiWritingPreviewPluginKey,
        state: {
          init: () => null,
          apply(transaction, current) {
            const explicit = transaction.getMeta(aiWritingPreviewPluginKey) as
              | AIWritingPreviewState
              | null
              | undefined;
            if (explicit !== undefined) return explicit;
            if (!current || !transaction.docChanged) return current;
            return {
              ...current,
              from: transaction.mapping.map(current.from, -1),
              to: transaction.mapping.map(current.to, 1),
              previewAt: transaction.mapping.map(current.previewAt, 1),
            };
          },
        },
        props: {
          decorations(state) {
            const preview = aiWritingPreviewPluginKey.getState(state);
            if (!preview) return null;

            const decorations: Decoration[] = [];
            if (preview.from < preview.to) {
              decorations.push(
                Decoration.inline(preview.from, preview.to, {
                  class: "ai-writing-original-target",
                  "data-ai-writing-target": "true",
                }),
              );
              state.doc.nodesBetween(
                preview.from,
                preview.to,
                (node, position, parent) => {
                  if (
                    parent === state.doc &&
                    node.isBlock &&
                    position >= preview.from &&
                    position + node.nodeSize <= preview.to
                  ) {
                    decorations.push(
                      Decoration.node(position, position + node.nodeSize, {
                        class: "ai-writing-original-block",
                      }),
                    );
                  }
                  return true;
                },
              );
            }
            decorations.push(
              Decoration.widget(
                preview.previewAt,
                () => renderProposal(preview),
                {
                  side: 1,
                  key: `orion-ai-writing-preview:${preview.revision}`,
                },
              ),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

function renderProposal(preview: AIWritingPreviewState): HTMLElement {
  const region = document.createElement("section");
  region.className = "ai-writing-proposal note-prose";
  region.contentEditable = "false";
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", preview.ariaLabel ?? "AI writing preview");
  region.setAttribute("data-ai-writing-preview", "true");

  const label = document.createElement("span");
  label.className = "ai-writing-proposal__label";
  label.textContent = preview.label ?? "Proposed";
  region.append(label);
  region.append(
    DOMSerializer.fromSchema(preview.proposal.type.schema).serializeFragment(
      preview.proposal.content,
      { document },
    ),
  );
  return region;
}
