import { Mark } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

/** Keep snapshot titles in Markdown, without exposing their payload as a tooltip. */
export const NoteStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (!(extension instanceof Mark) || extension.name !== "link") return extension;
      return extension.extend({
        renderHTML({ HTMLAttributes, mark }) {
          const attributes = { ...HTMLAttributes };
          if (String(mark.attrs.title ?? "").startsWith("orion-excerpt:v1:")) attributes["data-note-excerpt-source"] = "true";
          if (/^orion-(?:passage|excerpt):v1:/.test(String(attributes.title ?? ""))) delete attributes.title;
          return this.parent!({ HTMLAttributes: attributes, mark });
        },
      });
    });
  },
});
