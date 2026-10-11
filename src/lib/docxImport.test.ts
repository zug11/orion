// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { docxHtmlToMarkdown, parseDocxHtml } from "./docxImport";
import { htmlToMarkdown } from "./htmlImport";

const rendered = (markdown: string) => new DOMParser().parseFromString(marked.parse(markdown, { async: false }), "text/html");

describe("structured Word import", () => {
  it("preserves semantic content and safely escapes literal Markdown", () => {
    const text = docxHtmlToMarkdown('<h1>Reading notes</h1><p>With <strong>bold</strong>, <em>emphasis</em> and literal *stars*.</p><ul><li>First<ul><li>Nested</li></ul></li><li>☑ Done</li></ul><p>☐ Pending</p><blockquote><p>Quoted words</p></blockquote><table><tr><th>Name</th><th>Value</th></tr><tr><td>A | B</td><td>42</td></tr></table><pre>line one\nline two</pre>');
    expect(text).toContain("# Reading notes");
    expect(text).toContain("**bold**, *emphasis* and literal \\*stars\\*");
    expect(rendered(text).querySelector("ul li ul li")?.textContent).toBe("Nested");
    expect(text).toContain("- [x] Done");
    expect(text).toContain("- [ ] Pending");
    expect(text).toContain("> Quoted words");
    expect(text).toContain("| A \\| B | 42 |");
    expect(text).toContain("```\nline one\nline two\n```");
  });

  it("keeps readable labels while discarding active HTML, local paths and unsafe links", () => {
    const text = docxHtmlToMarkdown('<p><a href="https://example.com/source">Public link</a> <a href="file:///Users/secret">Local label</a> <a href="javascript:alert(1)">Unsafe label</a><img src="file:///private/secret" alt="A chart" /></p><script>secretScript()</script><style>secretStyle</style><iframe>secretFrame</iframe>');
    expect(rendered(text).querySelector("a")?.getAttribute("href")).toBe("https://example.com/source");
    expect(text).toContain("Local label");
    expect(text).toContain("Unsafe label");
    expect(rendered(text).body.textContent).toContain("[Image: A chart]");
    for (const excluded of ["file:", "/Users/", "javascript:", "secretScript", "secretStyle", "secretFrame"]) expect(text).not.toContain(excluded);
  });

  it("does not turn literal paragraph punctuation into list syntax or duplicate task markers", () => {
    expect(docxHtmlToMarkdown('<p>1. A literal paragraph</p><p>- Also literal</p><ul><li><p>☑ Completed inside a list paragraph</p></li></ul>')).toBe("1\\. A literal paragraph\n\n\\- Also literal\n\n- [x] Completed inside a list paragraph");
  });

  it("does not consume a descendant task marker as the parent or turn later list prose into another task", () => {
    const parsed = rendered(docxHtmlToMarkdown('<ul><li><ul><li>☑ Child</li></ul></li><li><p>Parent text</p><p>☐ Later literal</p></li></ul>'));
    expect(parsed.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(parsed.querySelector('ul > li > ul input[type="checkbox"]')).not.toBeNull();
    expect(parsed.body.textContent).toContain("☐ Later literal");
    expect(parsed.querySelectorAll("ul > li")).toHaveLength(3);
  });

  it("keeps glyphs inside code and tables literal, and ordinary HTML does not use the Word profile", () => {
    const html = '<p><code>☑ code</code></p><pre>☐ code block</pre><table><tr><td><p>☑ cell</p></td></tr></table>';
    const text = docxHtmlToMarkdown(html);
    expect(text).not.toContain("- [x]");
    expect(text).not.toContain("- [ ]");
    const plain = htmlToMarkdown('<p>☑ Literal HTML</p><p><a href="mailto:writer@example.com">Email</a></p>');
    expect(plain.text).toBe("☑ Literal HTML\n\nEmail");
    expect(plain.warnings).toHaveLength(1);
  });

  it("does not promote a leading table or quoted checkbox into its parent list item", () => {
    for (const child of ['<table><tr><td><input type="checkbox" checked /> Cell</td></tr></table>', '<blockquote><p><input type="checkbox" checked /> Quoted</p></blockquote>']) {
      const text = docxHtmlToMarkdown(`<ul><li>${child}</li></ul>`);
      expect(text).not.toContain("- [x]");
      expect(text).toContain("☑");
    }
  });

  it("shares inert complexity bounds and reports Word-specific failure without a partial result", () => {
    expect(() => parseDocxHtml("<div>".repeat(130) + "Too deep" + "</div>".repeat(130))).toThrow(/Word document is too complex/);
  });
});
