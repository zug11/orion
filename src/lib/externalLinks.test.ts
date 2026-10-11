import { describe, expect, it } from "vitest";
import { isPotentialExternalLink, normalizeExternalLink } from "./externalLinks";

describe("external link destinations", () => {
  it.each([
    ["https://example.com/articles?a=1&b=2#source", "https://example.com/articles?a=1&b=2#source"],
    [" HTTP://EXAMPLE.COM/source ", "http://example.com/source"],
    ["example.com", "https://example.com/"],
    ["www.example.com/writing", "https://www.example.com/writing"],
    ["example.com:8080/writing", "https://example.com:8080/writing"],
    ["https://例え.jp/文", "https://xn--r8jz45g.jp/%E6%96%87"],
    ["https://localhost:1423/note", "https://localhost:1423/note"],
  ])("normalizes %s without losing its path, query or fragment", (input, expected) => {
    expect(normalizeExternalLink(input)).toBe(expected);
    expect(isPotentialExternalLink(input)).toBe(true);
  });

  it.each([
    "", "Project notes", "localhost", "/relative/path", "//example.com/path",
    "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>",
    "file:///Users/me/note", "mailto:reader@example.com", "orion://note/private",
    "https://name:secret@example.com/", "https://example.com@evil.test/",
    "https://example.com/\nscript", "https://example.com/path with spaces",
    "https://example.com\\@evil.test/", "https://", "https:///", "https:example.com",
    `https://example.com/${"a".repeat(2_048)}`,
  ])("rejects unsafe or ambiguous destination %s", (input) => {
    expect(normalizeExternalLink(input)).toBeNull();
  });

  it("treats ordinary titles as searches and explicit unsupported schemes as invalid URLs", () => {
    expect(isPotentialExternalLink("Research in practice")).toBe(false);
    expect(isPotentialExternalLink("javascript:alert(1)")).toBe(true);
    expect(isPotentialExternalLink("file:///private/note")).toBe(true);
  });
});
