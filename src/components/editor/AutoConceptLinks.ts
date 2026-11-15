import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { decorateAutoLinks } from "../../lib/wiki";
import type { AutoLinkSegment, Concept } from "../../types";

interface AutoConceptLinksOptions {
  getConcepts: () => readonly Concept[];
  excludeNoteId: string;
}

const autoConceptLinksKey = new PluginKey("orionAutoConceptLinks");
/** Distinct text nodes remembered between passes. Cleared when it fills. */
const MAX_REMEMBERED_TEXTS = 4_000;

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
    // The view asks for decorations on every state update, including caret
    // moves. Documents are immutable, so the same document and vocabulary
    // always decorate the same way: answer those from the last pass. When the
    // document does change, only text that is new needs matching.
    let last: { doc: Node; concepts: readonly Concept[]; set: DecorationSet } | undefined;
    let remembered = new Map<string, AutoLinkSegment[]>();
    let rememberedFor: readonly Concept[] | undefined;

    return [
      new Plugin({
        key: autoConceptLinksKey,
        props: {
          decorations(state) {
            const concepts = options.getConcepts();
            if (last && last.doc === state.doc && last.concepts === concepts) {
              return last.set;
            }
            if (rememberedFor !== concepts || remembered.size > MAX_REMEMBERED_TEXTS) {
              remembered = new Map();
              rememberedFor = concepts;
            }
            const decorations: Decoration[] = [];
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
              let segments = remembered.get(node.text);
              if (!segments) {
                segments = decorateAutoLinks(node.text, concepts, {
                  excludeNoteIdFromTargets: options.excludeNoteId,
                });
                remembered.set(node.text, segments);
              }
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
            const set = DecorationSet.create(state.doc, decorations);
            last = { doc: state.doc, concepts, set };
            return set;
          },
        },
      }),
    ];
  },
});
