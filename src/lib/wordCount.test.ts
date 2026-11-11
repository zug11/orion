import { describe, expect, it, vi } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { countableText, countWords, createDocumentWordCounter, selectedCountableText } from "./wordCount";

describe("note word counts", () => {
  it("counts written words across punctuation, Unicode, apostrophes and line breaks", () => {
    expect(countWords("  ")).toBe(0);
    expect(countWords("... — 🪶")).toBe(0);
    expect(countWords("Café isn't empty.\nTwo more words! 42")).toBe(7);
  });

  it("recounts only the changed paragraph, including words split across formatting", () => {
    const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} }, marks: { bold: {} } });
    const first = schema.node("paragraph", null, [schema.text("some"), schema.text("thing", [schema.mark("bold")]), schema.text(" written")]);
    const unchanged = schema.node("paragraph", null, schema.text("An unchanged paragraph."));
    const count = vi.fn(countWords), words = createDocumentWordCounter(count);
    const original = schema.node("doc", null, [first, unchanged]);
    expect(words(original)).toBe(5);
    expect(words(original)).toBe(5);
    expect(count).toHaveBeenCalledTimes(2);
    const updated = schema.node("doc", null, [schema.node("paragraph", null, schema.text("A longer new opening.")), unchanged]);
    expect(words(updated)).toBe(7);
    expect(count).toHaveBeenCalledTimes(3);
  });

  it("counts visible prose and table boundaries without source markers or image metadata", () => {
    const root = document.createElement("div");
    root.innerHTML = '<p>some<strong>thing</strong> <a href="https://example.com/hidden-url">written here</a><sup class="source-citation-marker">12</sup></p><table><tbody><tr><td>First</td><td>Second</td></tr></tbody></table><span class="note-image-reading"><img alt="Not prose"><span class="note-image-caption-reading">Separate image caption</span></span><span hidden>Hidden metadata</span>';
    expect(countWords(countableText(root))).toBe(5);
    const range = document.createRange();
    range.selectNodeContents(root.querySelector(".note-image-caption-reading")!);
    expect(selectedCountableText(range, root)).toBe("");
    range.selectNodeContents(root.querySelector(".source-citation-marker")!);
    expect(selectedCountableText(range, root)).toBe("");
  });

  it("clips a reading selection to the note instead of counting surrounding controls", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button>Outside control</button><p>One <strong>two</strong> three.</p><button>Other control</button>';
    document.body.append(root);
    const range = document.createRange(); range.selectNodeContents(root);
    expect(countWords(selectedCountableText(range, root.querySelector("p")!))).toBe(3);
    range.setStart(root.querySelector("strong")!.firstChild!, 0);
    range.setEnd(root.querySelector("strong")!.firstChild!, 3);
    expect(selectedCountableText(range, root.querySelector("p")!)).toBe("two");
    root.remove();
  });
});
