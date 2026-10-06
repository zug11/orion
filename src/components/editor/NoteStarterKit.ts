import { getExtensionField, Mark, Node, type JSONContent, type MarkdownExtensionSpec } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import { JUSTIFY_MARKER } from "../../lib/noteTextAlignment";
import { parseNoteExcerptTitle } from "../../lib/noteExcerpts";
import { normalizeNoteMargin, paragraphMarginsMarker, parseParagraphMarginsMarker } from "../../lib/noteMargins";

/** List parsers construct paragraphs directly, so track their parsed inline content too. */
function withAlignmentParsing(extension: Node) {
  return extension.extend({
    parseMarkdown(token, helpers) {
      const formatting = new WeakMap<JSONContent[], Record<string, unknown>>();
      const parse = getExtensionField<NonNullable<MarkdownExtensionSpec["parseMarkdown"]>>(extension, "parseMarkdown", this);
      const parsed = parse(token, { ...helpers, parseInline(tokens) {
        const clean = tokens.map((part) => ({ ...part }));
        const attrs: Record<string, unknown> = {};
        while (clean.length) {
          const last = clean[clean.length - 1];
          if (last.type !== "html") break;
          const value = last.raw ?? last.text ?? "";
          const margins = parseParagraphMarginsMarker(value);
          if (value !== JUSTIFY_MARKER && !margins) break;
          if (value === JUSTIFY_MARKER) attrs.textAlign = "justify";
          if (margins && attrs.marginLeft === undefined) {
            attrs.marginLeft = margins.left;
            attrs.marginRight = margins.right;
          }
          clean.pop();
          const previous = clean[clean.length - 1];
          if (previous?.type === "text" && previous.text?.endsWith(" ")) {
            previous.text = previous.text.slice(0, -1);
            if (previous.raw?.endsWith(" ")) previous.raw = previous.raw.slice(0, -1);
            if (!previous.text) clean.pop();
          }
        }
        if (!Object.keys(attrs).length) return helpers.parseInline(tokens);
        const content = helpers.parseInline(clean);
        formatting.set(content, attrs);
        return content;
      } });
      const apply = (node: JSONContent) => {
        if (["paragraph", "heading"].includes(node.type ?? "") && node.content && formatting.has(node.content)) {
          node.attrs = { ...node.attrs, ...formatting.get(node.content) };
        }
        node.content?.forEach(apply);
      };
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(apply);
      return parsed;
    },
  });
}

export const NoteTaskItem = withAlignmentParsing(TaskItem);

function marginAttribute(side: "left" | "right") {
  const attribute = side === "left" ? "marginLeft" : "marginRight";
  return {
    default: 0,
    parseHTML: (element: HTMLElement) => {
      const raw = element.getAttribute(`data-orion-margin-${side}`) ?? element.style[attribute].replace(/%$/, "");
      return /^(?:0|[1-9]\d?)$/.test(raw) && Number(raw) <= 25 ? Number(raw) : 0;
    },
    renderHTML: (attrs: Record<string, unknown>) => {
      const value = normalizeNoteMargin(attrs[attribute]);
      return value ? { [`data-orion-margin-${side}`]: String(value), style: `margin-${side}: ${value}%` } : {};
    },
  };
}

/** Keep snapshot titles in Markdown, without exposing their payload as a tooltip. */
export const NoteStarterKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension instanceof Node && ["paragraph", "heading"].includes(extension.name)) {
        return withAlignmentParsing(extension.extend({
          addAttributes() {
            return { ...this.parent?.(), marginLeft: marginAttribute("left"), marginRight: marginAttribute("right"), textAlign: {
              default: "left",
              parseHTML: (element: HTMLElement) => element.style.textAlign === "justify" || element.dataset.orionJustify === "true" ? "justify" : "left",
              renderHTML: (attrs: Record<string, unknown>) => attrs.textAlign === "justify" ? { style: "text-align: justify", "data-orion-justify": "true" } : {},
            } };
          },
          renderMarkdown(node, helpers, context) {
            const render = getExtensionField<NonNullable<MarkdownExtensionSpec["renderMarkdown"]>>(extension, "renderMarkdown", this);
            const content = render(node, helpers, context);
            const markers = [node.attrs?.textAlign === "justify" ? JUSTIFY_MARKER : "", paragraphMarginsMarker({
              left: normalizeNoteMargin(node.attrs?.marginLeft), right: normalizeNoteMargin(node.attrs?.marginRight),
            })].filter(Boolean);
            return markers.length && content.trim() ? `${content.trimEnd()} ${markers.join(" ")}` : content;
          },
        }));
      }
      if (extension instanceof Node && extension.name === "listItem") return withAlignmentParsing(extension);
      if (!(extension instanceof Mark) || extension.name !== "link") return extension;
      return extension.extend({
        renderHTML({ HTMLAttributes, mark }) {
          const attributes = { ...HTMLAttributes };
          if (parseNoteExcerptTitle(mark.attrs.title, mark.attrs.href)) attributes["data-note-excerpt-source"] = "true";
          if (/^orion-(?:passage:v1|excerpt:v[12]):/.test(String(attributes.title ?? ""))) delete attributes.title;
          return this.parent!({ HTMLAttributes: attributes, mark });
        },
      });
    });
  },
});
