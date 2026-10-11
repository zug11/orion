import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { htmlToMarkdown } from "./htmlImport";

function rendered(html: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = marked.parse(htmlToMarkdown(html).text) as string;
  return template;
}

describe("bounded semantic HTML import", () => {
  it("retains loose prose, title, block wrappers, inline marks, breaks and nested lists", () => {
    const html = '<html><head><title>Document &amp; title</title></head><body>Before<main><h2>A heading</h2><p>A <strong> bold </strong><em>thought</em>, <del>old</del><br>next.</p><ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol></main>After</body></html>';
    const parsed = htmlToMarkdown(html);
    expect(parsed.title).toBe("Document & title");
    const result = rendered(html).content;
    expect(result.querySelector("h2")?.textContent).toBe("A heading");
    expect(result.querySelector("strong")?.textContent).toBe("bold");
    expect(result.querySelector("em")?.textContent).toBe("thought");
    expect(result.querySelector("del")?.textContent).toBe("old");
    expect(result.querySelector("br")).not.toBeNull();
    expect(result.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(result.querySelector("ol > li > ul > li")?.textContent).toBe("Nested");
    expect(result.textContent).toContain("Before");
    expect(result.textContent).toContain("After");
  });

  it("converts leading checkboxes to tasks without consuming later or nested checkboxes", () => {
    const parsed = htmlToMarkdown('<ul><li><label><input type="checkbox" checked>Done</label><ul><li><input type="checkbox">Later</li></ul></li><li>Discuss <input type="checkbox"> this control</li></ul>');
    expect(parsed.text).toContain("- [x] Done");
    expect(parsed.text).toContain("- [ ] Later");
    expect(parsed.text).toContain("- Discuss ☐  this control");
  });

  it("retains block boundaries through unfamiliar wrappers and coalesces repeated marks", () => {
    const result = rendered('<custom-document><p>First</p><p>Second</p></custom-document><p><strong>outer <strong>inner</strong></strong> <strong>a</strong><strong>b</strong> <em>outer <em>inner</em></em></p>').content;
    expect(Array.from(result.querySelectorAll("p")).map((p) => p.textContent)).toEqual(["First", "Second", "outer inner ab outer inner"]);
    expect(Array.from(result.querySelectorAll("strong")).map((p) => p.textContent)).toEqual(["outer inner", "ab"]);
    expect(result.querySelector("em")?.textContent).toBe("outer inner");
  });

  it("keeps irregular list prose and block links readable without stray inline delimiters", () => {
    const html = '<ul>Before<li>One</li><div>Middle</div><li>Two</li>After</ul><a href="https://example.com"><h2>Title</h2><p>Summary</p></a><strong><p>Plain one</p><p>Plain two</p></strong>';
    const parsed = htmlToMarkdown(html);
    const result = rendered(html).content;
    for (const word of ["Before", "One", "Middle", "Two", "After", "Title", "Summary", "Plain one", "Plain two"]) expect(result.textContent).toContain(word);
    expect(result.textContent).not.toMatch(/https:|\*\*|\]\(/);
    expect(result.querySelector("h2")?.textContent).toBe("Title");
    expect(parsed.warnings).toHaveLength(1);
  });

  it("preserves code whitespace and backticks, quotes, literal punctuation and entities", () => {
    const html = '<p>*literal* [label](orion-note://x) &amp;nbsp; &lt;!-- orion-block:v1 --&gt; 🪐</p><p><code>`x` &amp; y</code></p><pre><code>  first\n\n```\nlast\n</code></pre><blockquote><p>One</p><p>Two</p></blockquote>';
    const result = rendered(html).content;
    expect(result.querySelector("p")?.textContent).toBe("*literal* [label](orion-note://x) &nbsp; <!-- orion-block:v1 --> 🪐");
    expect(result.querySelector("p code")?.textContent).toBe("`x` & y");
    expect(result.querySelector("pre code")?.textContent).toBe("  first\n\n```\nlast\n");
    expect(result.querySelectorAll("blockquote p")).toHaveLength(2);
    expect(result.querySelector("a")).toBeNull();
  });

  it("preserves exact code spaces and dynamic delimiters without a formatting fallback", () => {
    for (const text of [" ", "  ", "   ", " leading", "trailing ", " paired ", "\ttabbed", "\u00a0nonbreaking\u00a0", "\ufeffbom", "`", "a``b`", " `edge` "]) {
      const parsed = htmlToMarkdown(`<p>Before<code>${text}</code>After</p>`);
      expect(parsed.warnings).toEqual([]);
      expect(rendered(`<p>Before<code>${text}</code>After</p>`).content.querySelector("code")?.textContent).toBe(text);
    }
  });

  it("keeps simple tables with literal backslash-pipes in ordinary and code text", () => {
    const html = '<table><tr><td>c\\|d</td><td><code>c\\|d</code></td><td><code>c\\\\|d</code></td></tr></table>';
    const result = rendered(html).content;
    expect(Array.from(result.querySelectorAll("tbody td")).map((cell) => cell.textContent)).toEqual(["c\\|d", "c\\|d", "c\\\\|d"]);
    const codeCells = Array.from(result.querySelectorAll("tbody td")).slice(1);
    expect(codeCells.map((cell) => Array.from(cell.querySelectorAll("code")).map((code) => code.textContent).join(""))).toEqual(["c\\|d", "c\\\\|d"]);
    expect(htmlToMarkdown(html).warnings).toEqual([]);
  });

  it("keeps overflowing ordered numbering within portable list syntax with a warning", () => {
    const html = '<ol start="999999999"><li>A</li><li>B</li></ol>';
    expect(htmlToMarkdown(html).warnings[0]).toContain("numbering");
    expect(rendered(html).content.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("keeps only explicit safe HTTP(S) destinations without resolving base URLs", () => {
    const links = ["https://example.com/a(b)?a=1&b=2", "http://example.com", "mailto:a@example.com", "/relative", "//example.com", "example.com", "javascript:alert(1)", "file:///private/a", "orion-note://secret", "https://user:pass@example.com", "https://example.com/\nprivate"];
    const html = '<base href="https://remote.invalid/">' + links.map((href, i) => `<a href="${href}">Label ${i}</a> `).join("");
    const parsed = htmlToMarkdown(html);
    const result = rendered(html).content;
    expect(Array.from(result.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(links.slice(0, 2).map((url) => new URL(url).href));
    links.forEach((_, i) => expect(result.textContent).toContain(`Label ${i}`));
    expect(parsed.warnings).toHaveLength(1);
  });

  it("discards active markup and metadata, keeps image descriptions and bounded warnings", () => {
    const before = document.body.innerHTML;
    const parsed = htmlToMarkdown('<script>globalThis.executed = true</script><style>body{display:none}</style><template><p>hidden template</p></template><!-- orion-table:v1 {"width":1} --><p onclick="bad()" style="color:red">Safe<img src="https://remote.invalid/img" alt="A [figure]"></p><iframe src="https://remote.invalid/frame"></iframe><object data="https://remote.invalid/object">Fallback</object>'.repeat(20));
    expect(document.body.innerHTML).toBe(before);
    expect(parsed.text).toContain("\\[Image: A \\[figure\\]\\]");
    expect(parsed.text).toContain("Fallback");
    expect(parsed.text).not.toMatch(/executed|display:none|hidden template|remote\.invalid|orion-table/);
    expect(parsed.warnings).toHaveLength(2);
  });

  it("preserves simple tables and explicitly records when the first row is data", () => {
    const header = htmlToMarkdown('<table><caption>Findings</caption><tr><th>Name</th><th>Value</th></tr><tr><td><strong>Bold</strong></td><td>a | b</td></tr></table>');
    expect(header.text).toContain("| Name | Value |");
    expect(header.text).toContain("| **Bold** | a \\| b |");
    expect(header.warnings).toEqual([]);
    const data = htmlToMarkdown('<table><tr><td></td><td></td></tr><tr><td>First data</td><td>🪐</td></tr></table>');
    expect(data.text).toContain('<!-- orion-table:v1 {"header":false} -->');
    expect(data.text.split("\n")).toHaveLength(5);
  });

  it("retains every readable cell of complex and nested tables with one warning", () => {
    const parsed = htmlToMarkdown('<table><tr><td rowspan="2">Merged</td><td>Top</td></tr><tr><td>Bottom<table><tr><td>Inner</td></tr></table></td></tr></table>');
    for (const text of ["Merged", "Top", "Bottom", "Inner"]) expect(parsed.text.split(text)).toHaveLength(2);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toContain("Complex tables");
  });

  it("warns on heading cells and mixed table-header geometry instead of fabricating simple cells", () => {
    for (const html of ['<table><tr><td><h2>Cell title</h2></td><td>X</td></tr></table>', '<table><tr><th>Row title</th><td>X</td></tr></table>']) {
      const parsed = htmlToMarkdown(html);
      expect(parsed.warnings[0]).toContain("Complex tables");
      expect(rendered(html).content.querySelector("table")).toBeNull();
      expect(parsed.text).toContain("X");
    }
  });

  it("rejects excessive input or nesting without returning a truncated source", () => {
    expect(() => htmlToMarkdown("x".repeat(16 * 1024 * 1024 + 1))).toThrow("too large");
    expect(() => htmlToMarkdown("<div>".repeat(130) + "Keep all or fail" + "</div>".repeat(130))).toThrow("too complex");
    expect(() => htmlToMarkdown("<!--x-->".repeat(100_001))).toThrow("too complex");
  });

  it("rejects output amplification before deeply nested lists can allocate unbounded indentation", () => {
    const html = '<ul><li><input type="checkbox">'.repeat(29) + '<pre>x\n' + '\n'.repeat(100_000) + 'y</pre>' + '</li></ul>'.repeat(29);
    expect(html.length).toBeLessThan(110_000);
    expect(() => htmlToMarkdown(html)).toThrow("too much formatted text");
  });
});
