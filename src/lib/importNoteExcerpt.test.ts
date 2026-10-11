import { describe, expect, it } from "vitest";
import { importNoteExcerpt, MAX_IMPORT_NOTE_CHARACTERS } from "./importNoteExcerpt";
import { NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN } from "./noteBlocks";

describe("importNoteExcerpt", () => {
  const preceding = `${"A".repeat(199_850)}\n\n`;
  const tail = "\n\nThe complete remainder stays in the source.";

  it("preserves an import below the limit exactly, including CRLF and emoji", () => {
    const source = `${NOTE_BLOCK_OPEN}\r\n\r\nHello 🪐\r\n\r\n${NOTE_BLOCK_CLOSE}`;
    expect(importNoteExcerpt(source)).toEqual({ text: source, truncated: false });
  });

  it.each([
    ["Orion frame", `${NOTE_BLOCK_OPEN}\n\n${"Inside.\n\n".repeat(80)}${NOTE_BLOCK_CLOSE}`],
    ["nested Orion frames", `${NOTE_BLOCK_OPEN}\n\n${NOTE_BLOCK_OPEN}\n\n${"Inside.\n\n".repeat(80)}${NOTE_BLOCK_CLOSE}\n\n${NOTE_BLOCK_CLOSE}`],
    ["backtick fence", `\`\`\`markdown\n${"sample\n".repeat(80)}\`\`\``],
    ["tilde fence", `~~~~\n${"sample\n".repeat(80)}~~~~`],
    ["table and metadata", `<!-- orion-table:v1 {"width":65} -->\n| Name | Value |\n| --- | --- |\n${"| one | two |\n".repeat(80)}`],
    ["inline Orion link", `Before [${"linked words ".repeat(80)}](orion-note://some-note) after.`],
    ["multiline external link", `[Read this](https://example.com\n"${"long title ".repeat(80)}")`],
    ["list", `- First item\n\n- ${"Second item ".repeat(80)}`],
    ["blockquote", `> ${"Quoted words ".repeat(80)}`],
  ])("backs up before a %s crossing the 200,000-unit limit", (_name, structure) => {
    const source = preceding + structure + tail;
    expect(source.length).toBeGreaterThan(MAX_IMPORT_NOTE_CHARACTERS);
    const result = importNoteExcerpt(source);
    expect(result).toEqual({ text: preceding.trimEnd(), truncated: true });
    expect(result.text.length).toBeLessThanOrEqual(MAX_IMPORT_NOTE_CHARACTERS);
  });

  it("keeps complete structures and ignores frame delimiters inside fenced examples", () => {
    const complete = `\`\`\`markdown\n${NOTE_BLOCK_OPEN}\n\`\`\`\n\n${NOTE_BLOCK_OPEN}\n\nReal frame.\n\n${NOTE_BLOCK_CLOSE}`;
    const result = importNoteExcerpt(`${complete}\n\n${"Tail ".repeat(50_000)}`);
    expect(result.text).toBe(complete);
  });

  it("does not mistake a quoted closing marker in a fence for the end of a frame", () => {
    const first = "# First\n\nComplete opening.";
    const frame = `${NOTE_BLOCK_OPEN}\n\n\`\`\`markdown\n${NOTE_BLOCK_CLOSE}\n\`\`\`\n\n${"Still inside.\n\n".repeat(20_000)}${NOTE_BLOCK_CLOSE}`;
    expect(importNoteExcerpt(`${first}\n\n${frame}`).text).toBe(first);
  });

  it("does not leave half a surrogate pair when the raw limit bisects an emoji", () => {
    const source = `${"A".repeat(199_999)}🪐 tail`;
    expect(source.charCodeAt(200_000)).toBeGreaterThanOrEqual(0xdc00);
    expect(importNoteExcerpt(source)).toEqual({ text: "", truncated: true });
    const short = `A 🪐 complete paragraph.\n\n${source}`;
    expect(importNoteExcerpt(short).text).toBe("A 🪐 complete paragraph.");
  });

  it("maps normalized lexer positions to exact CRLF source offsets", () => {
    const first = "A\r\nB 🪐\r\n\r\n";
    const result = importNoteExcerpt(first + "Another long paragraph without a break.", first.length + 5);
    expect(result.text).toBe("A\r\nB 🪐");
    expect(result.text.length).toBeLessThanOrEqual(first.length + 5);
  });

  it("does not retain an opening frontmatter delimiter without its closing delimiter", () => {
    const source = `---\nlong: ${"value ".repeat(40_000)}\n---\n\nBody`;
    expect(importNoteExcerpt(source)).toEqual({ text: "", truncated: true });
  });

  it("retains complete frontmatter and its following paragraph unchanged", () => {
    const first = "---\ntitle: Example\n---\n\nComplete first paragraph.";
    expect(importNoteExcerpt(first + "\n\n" + "tail ".repeat(50_000)).text).toBe(first);
  });
});
