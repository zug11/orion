import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findTextMatches } from "../../lib/noteFind";

interface FindInNoteOptions {
  getQuery: () => string;
}

export const findInNotePluginKey = new PluginKey("orionFindInNote");

export const FindInNote = Extension.create<FindInNoteOptions>({
  name: "orionFindInNote",

  addOptions() {
    return { getQuery: () => "" };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key: findInNotePluginKey,
        props: {
          decorations(state) {
            const query = options.getQuery();
            if (!query.trim()) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            state.doc.descendants((node, position) => {
              if (!node.isText || !node.text) return;
              for (const match of findTextMatches(node.text, query)) {
                decorations.push(
                  Decoration.inline(
                    position + match.from,
                    position + match.to,
                    {
                      class: "note-find-match editor-find-match",
                      "data-note-find-match": "true",
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
