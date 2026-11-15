// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Concept } from "../../types";
import { AutoConceptLinks } from "./AutoConceptLinks";

const matcher = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../lib/wiki", async (original) => {
  const actual = await original<typeof import("../../lib/wiki")>();
  return {
    ...actual,
    decorateAutoLinks: (...args: Parameters<typeof actual.decorateAutoLinks>) => {
      matcher.calls.push(args[0]);
      return actual.decorateAutoLinks(...args);
    },
  };
});

const concept = (id: string, label: string): Concept => ({
  id, label, aliases: [], description: "", noteIds: [`note-${id}`], canonicalNoteId: `note-${id}`, color: "#000", autoLink: true,
});

const editors: Editor[] = [];
function create(content: string, vocabulary: { current: readonly Concept[] }) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, AutoConceptLinks.configure({ getConcepts: () => vocabulary.current, excludeNoteId: "self" })],
    content,
  });
  editors.push(editor);
  return editor;
}
const linked = (editor: Editor) => [...editor.view.dom.querySelectorAll(".editor-auto-link")].map((node) => `${node.textContent}:${node.getAttribute("data-concept-id")}`);

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  matcher.calls.length = 0;
  document.body.innerHTML = "";
});

describe("AutoConceptLinks", () => {
  it("decorates concept phrases but not existing links or code", () => {
    const vocabulary = { current: [concept("d", "dialectic"), concept("s", "spirit")] };
    const editor = create("<p>The dialectic of <code>spirit</code> and <a href=\"https://example.com\">dialectic</a> spirit.</p>", vocabulary);
    expect(linked(editor)).toEqual(["dialectic:d", "spirit:s"]);
  });

  it("does no matching when only the caret moves", () => {
    const vocabulary = { current: [concept("d", "dialectic")] };
    const editor = create("<p>The dialectic begins.</p><p>Another dialectic follows.</p>", vocabulary);
    expect(linked(editor)).toHaveLength(2);
    matcher.calls.length = 0;
    for (const position of [2, 5, 9, 30, 3]) editor.commands.setTextSelection(position);
    editor.commands.focus();
    expect(matcher.calls).toEqual([]);
    expect(linked(editor)).toHaveLength(2);
  });

  it("matches only the text that changed while typing", () => {
    const vocabulary = { current: [concept("d", "dialectic"), concept("s", "spirit")] };
    const paragraphs = Array.from({ length: 40 }, (_, index) => `<p>Paragraph ${index} about the dialectic.</p>`).join("");
    const editor = create(paragraphs, vocabulary);
    expect(linked(editor)).toHaveLength(40);
    matcher.calls.length = 0;

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " And spirit");
    expect(matcher.calls).toEqual(["Paragraph 39 about the dialectic. And spirit"]);
    expect(linked(editor)).toHaveLength(41);
    expect(linked(editor)[40]).toBe("spirit:s");
  });

  it("re-matches everything when the vocabulary changes without an edit", () => {
    const vocabulary = { current: [concept("d", "dialectic")] as readonly Concept[] };
    const editor = create("<p>The dialectic of spirit.</p>", vocabulary);
    expect(linked(editor)).toEqual(["dialectic:d"]);
    // Another note was renamed: a new vocabulary array, the same document.
    vocabulary.current = [concept("s", "spirit")];
    editor.view.dispatch(editor.state.tr.setMeta("vocabulary", true));
    expect(linked(editor)).toEqual(["spirit:s"]);
  });
});
