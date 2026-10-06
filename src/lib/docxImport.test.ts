// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { docxHtmlToMarkdown } from "./docxImport";

describe("structured Word import", () => {
  it("preserves semantic content and safely escapes literal Markdown", () => {
    const text = docxHtmlToMarkdown('<h1>Reading notes</h1><p>With <strong>bold</strong>, <em>emphasis</em> and literal *stars*.</p><ul><li>First<ul><li>Nested</li></ul></li><li>☑ Done</li></ul><p>☐ Pending</p><blockquote><p>Quoted words</p></blockquote><table><tr><th>Name</th><th>Value</th></tr><tr><td>A | B</td><td>42</td></tr></table><pre>line one\nline two</pre>');
    expect(text).toContain("# Reading notes");
    expect(text).toContain("**bold**, *emphasis* and literal \\*stars\\*");
    expect(text).toContain("- First\n    - Nested");
    expect(text).toContain("- [x] Done");
    expect(text).toContain("- [ ] Pending");
    expect(text).toContain("> Quoted words");
    expect(text).toContain("| A \\| B | 42 |");
    expect(text).toContain("```\nline one\nline two\n```");
  });

  it("keeps readable labels while discarding active HTML, local paths and unsafe links", () => {
    const text = docxHtmlToMarkdown('<p><a href="https://example.com/source">Public link</a> <a href="file:///Users/secret">Local label</a> <a href="javascript:alert(1)">Unsafe label</a><img src="file:///private/secret" alt="A chart" /></p><script>secretScript()</script><style>secretStyle</style><iframe>secretFrame</iframe>');
    expect(text).toContain("[Public link](https://example.com/source)");
    expect(text).toContain("Local label");
    expect(text).toContain("Unsafe label");
    expect(text).toContain("[Image: A chart]");
    for (const excluded of ["file:", "/Users/", "javascript:", "secretScript", "secretStyle", "secretFrame"]) expect(text).not.toContain(excluded);
  });

  it("does not turn literal paragraph punctuation into list syntax or duplicate task markers", () => {
    expect(docxHtmlToMarkdown('<p>1. A literal paragraph</p><p>- Also literal</p><ul><li><p>☑ Completed inside a list paragraph</p></li></ul>')).toBe("1\\. A literal paragraph\n\n\\- Also literal\n\n- [x] Completed inside a list paragraph");
  });
});
