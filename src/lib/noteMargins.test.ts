import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { noteMarginsStyle, parseParagraphMarginsMarker, remarkNoteMargins, splitDocumentMargins, withDocumentMargins } from "./noteMargins";
import { remarkNoteTextAlignment } from "./noteTextAlignment";

describe("portable margin metadata", () => {
  it("splits a document prefix after frontmatter and preserves ordinary Markdown exactly", () => {
    const markdown = "---\ntitle: Draft\n---\n\n<!-- orion-document-margins:v1 12 4 -->\n\n# Draft\n\nWriting.";
    const { body, margins } = splitDocumentMargins(markdown);
    expect(margins).toEqual({ left: 12, right: 4 });
    expect(body).toBe("---\ntitle: Draft\n---\n\n# Draft\n\nWriting.");
    expect(withDocumentMargins(body, margins)).toBe(markdown);
    expect(splitDocumentMargins(body).body).toBe(body);
  });

  it.each(["<!-- orion-document-margins:v1 26 4 -->", "<!-- orion-document-margins:v1 -1 4 -->", "<!-- orion-document-margins:v1 1.5 4 -->", "<!-- orion-document-margins:v1 04 4 -->", "<!-- orion-document-margins:v1 4 4;color:red -->"])("rejects malformed document metadata: %s", (marker) => {
    const markdown = `${marker}\n\nText.`;
    expect(splitDocumentMargins(markdown)).toEqual({ body: markdown, margins: { left: 0, right: 0 } });
  });

  it("does not treat markers inside code or later paragraphs as a document setting", () => {
    for (const markdown of ["```html\n<!-- orion-document-margins:v1 4 5 -->\n```", "    <!-- orion-document-margins:v1 4 5 -->", "Prose.\n\n<!-- orion-document-margins:v1 4 5 -->"]) {
      expect(splitDocumentMargins(markdown)).toEqual({ body: markdown, margins: { left: 0, right: 0 } });
    }
  });

  it("validates paragraph values and emits only controlled percentage CSS", () => {
    expect(parseParagraphMarginsMarker("<!-- orion-paragraph-margins:v1 25 0 -->")).toEqual({ left: 25, right: 0 });
    expect(parseParagraphMarginsMarker("<!-- orion-paragraph-margins:v1 99 0 -->")).toBeNull();
    expect(noteMarginsStyle({ left: Infinity, right: 300 })).toEqual({ marginLeft: "0%", marginRight: "25%" });
    expect(withDocumentMargins("Unchanged.", { left: 0, right: 0 })).toBe("Unchanged.");
  });

  it.each([
    "<!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 8 3 -->",
    "<!-- orion-paragraph-margins:v1 8 3 --> <!-- orion-text:v1 justify -->",
  ])("renders ordinary paragraphs with margins and justification in either order", (markers) => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkNoteMargins, remarkNoteTextAlignment], children: `Paragraph. ${markers}` }));
    expect(html).toContain('data-orion-margin-left="8"');
    expect(html).toContain('data-orion-margin-right="3"');
    expect(html).toContain('data-orion-justify="true"');
    expect(html).not.toContain("&lt;!--");
  });

  it("retains the paragraph wrapper for formatted tight list and task items", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkNoteMargins], children: "- List text. <!-- orion-paragraph-margins:v1 8 3 -->\n- [ ] Task text. <!-- orion-paragraph-margins:v1 4 7 -->" }));
    expect(html).toContain('<p data-orion-margin-left="8" data-orion-margin-right="3">List text.</p>');
    expect(html).toContain('<p data-orion-margin-left="4" data-orion-margin-right="7">');
    expect(html).toContain('type="checkbox"');
  });

  it("preserves code examples and ignores markers that are not paragraph suffixes", () => {
    const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkNoteMargins], children: "```html\n<!-- orion-paragraph-margins:v1 8 3 -->\n```\n\nBefore <!-- orion-paragraph-margins:v1 8 3 --> after." }));
    expect(html).toContain("&lt;!-- orion-paragraph-margins:v1 8 3 --&gt;");
    expect(html).not.toContain('data-orion-margin-left="8"');
  });
});
