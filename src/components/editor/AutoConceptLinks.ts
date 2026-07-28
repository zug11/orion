import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { decorateAutoLinks } from "../../lib/wiki";
import type { Concept } from "../../types";

interface AutoConceptLinksOptions {
  getConcepts: () => readonly Concept[];
  excludeNoteId: string;
}

const autoConceptLinksKey = new PluginKey("orionAutoConceptLinks");

export const AutoConceptLinks = Extension.create<AutoConceptLinksOptions>({
  name: "orionAutoConceptLinks",

  addOptions() {
    return {
      getConcepts: () => [],
      excludeNoteId: "",
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: autoConceptLinksKey,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const concepts = options.getConcepts();
            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) {
                return;
              }
              if (
                node.marks.some(
                  (mark) => mark.type.name === "link" || mark.type.name === "code",
                )
              ) {
                return;
              }
              const segments = decorateAutoLinks(node.text, concepts, {
                excludeNoteIdFromTargets: options.excludeNoteId,
              });
              for (const segment of segments) {
                if (
                  segment.type !== "concept" ||
                  segment.targetNoteIds.length === 0
                ) {
                  continue;
                }
                decorations.push(
                  Decoration.inline(
                    position + segment.start,
                    position + segment.end,
                    {
                      class: segment.ambiguous
                        ? "editor-auto-link ambiguous"
                        : "editor-auto-link",
                      "data-concept-id": segment.conceptId,
                    },
                  ),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
