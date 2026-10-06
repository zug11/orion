// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNarrationDocument, highlightNarration, clearNarrationHighlight,
  narrationCharacterAtPoint, narrationRanges, narrationWordAt } from "./noteNarration";

function fixture(html: string) {
  const root = document.createElement("article"); root.innerHTML = html;
  document.body.append(root); return root;
}
afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("displayed-note narration mapping", () => {
  it("maps exact displayed words across formatting, Unicode, block boundaries and citations", () => {
    const root = fixture(`<h1 data-narration-text>Études 🪐</h1><div data-narration-text><p>A <em>quiet</em> space.<button class="source-citation-marker">[1]</button></p><p>Two  worlds.</p><pre>doNotRead()</pre><aside class="chat-evidence">Hidden cited passage</aside></div>`);
    const script = buildNarrationDocument(root);
    expect(script.text).toBe("Études 🪐. A quiet space. Two worlds.");
    const index = script.text.indexOf("quiet");
    expect(narrationWordAt(script, index + 2)).toEqual({ from: index, to: index + 5 });
    expect(narrationRanges(script, index, index + 5).map((range) => range.toString()).join("")).toBe("quiet");
    const planet = script.text.indexOf("🪐");
    expect(narrationRanges(script, planet, planet + 2)[0].toString()).toBe("🪐");
    expect(root.querySelector("em")?.textContent).toBe("quiet");
  });

  it("separates explicit line breaks without splitting inline emphasis", () => {
    const root = fixture('<p data-narration-text>First line<br/>Second <em>con</em>text.</p>');
    expect(buildNarrationDocument(root).text).toBe("First line Second context.");
  });

  it("includes long notes using compact text spans rather than truncating their later passages", () => {
    const root = fixture(`<p data-narration-text>${"word ".repeat(6000)}final passage</p>`);
    const script = buildNarrationDocument(root);
    expect(script.text).toHaveLength(30013);
    expect(script.text.endsWith("final passage")).toBe(true);
    expect(script.positions.length).toBeLessThan(6100);
    expect(narrationRanges(script, 30000, 30013).map((range) => range.toString()).join("")).toBe("final passage");
  });

  it("only seeks actual text glyphs, not the nearest line from an empty area", () => {
    const root = fixture('<p data-narration-text>First target sentence.</p>');
    const script = buildNarrationDocument(root);
    let offset = 8;
    Object.defineProperty(document, "caretPositionFromPoint", { configurable: true, value: () => ({ offsetNode: root.querySelector("p")!.firstChild, offset }) });
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: function (this: Range) {
      return this.toString() === "target" ? [{ left: 10, top: 10, right: 50, bottom: 30 }] : [];
    } });
    expect(narrationCharacterAtPoint(script, 20, 20)).toBe(6);
    offset = 12;
    expect(narrationCharacterAtPoint(script, 48, 20)).toBe(6);
    expect(narrationCharacterAtPoint(script, 150, 20)).toBeNull();
    delete (document as unknown as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  });

  it("highlights only registered text and clears ranges without altering the prose", () => {
    const root = fixture('<p data-narration-text>First <strong>second</strong> third.</p>');
    const before = root.innerHTML;
    const highlights = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal("CSS", { highlights });
    // A spread-collecting implementation models the native Custom Highlight API.
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    const script = buildNarrationDocument(root);
    expect(highlightNarration(script, 6, 6)).toBe(true);
    expect(highlights.get("orion-narration-current")?.ranges.map((range) => range.toString()).join("")).toBe("second");
    expect(highlights.get("orion-narration-read")?.ranges.map((range) => range.toString()).join("")).toBe("First ");
    expect(highlights.get("orion-narration-unread")?.ranges.map((range) => range.toString()).join("")).toBe(" third.");
    expect(root.innerHTML).toBe(before);
    clearNarrationHighlight(); expect(highlights.size).toBe(0);
  });

  it("brightens all preceding text on forward seeks and dims it again on backward seeks", () => {
    const root = fixture('<p data-narration-text>First second third.</p>');
    const highlights = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal("CSS", { highlights });
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    const script = buildNarrationDocument(root);
    highlightNarration(script, 0, 5);
    highlightNarration(script, 13, 6);
    expect(highlights.get("orion-narration-read")?.ranges.map(range => range.toString()).join("")).toBe("First second ");
    expect(highlights.get("orion-narration-unread")?.ranges).toHaveLength(0);
    highlightNarration(script, 6, 6);
    expect(highlights.get("orion-narration-read")?.ranges.map(range => range.toString()).join("")).toBe("First ");
    expect(highlights.get("orion-narration-unread")?.ranges.map(range => range.toString()).join("")).toBe(" third.");
  });
});
