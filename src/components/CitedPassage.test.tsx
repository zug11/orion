// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatEvidence } from "../types";
import { CitedPassage } from "./CitedPassage";

afterEach(cleanup);
const evidence: ChatEvidence = { id: "e1", kind: "web", entityId: "web-1", title: "Research source", version: "v1",
  start: 0, end: 16, text: "A cited finding.", offsetUnit: "utf16",
  web: { url: "https://example.org/paper", retrievedAt: "2026-11-15T00:00:00Z", evidenceType: "cited_summary" } };

it("labels a cited summary before its text without presenting it as a source quotation", () => {
  const { container } = render(<CitedPassage evidence={evidence} notes={[]} sources={[]} panelId="test"
    savedWith="reply" onClose={vi.fn()} onOpenNote={vi.fn()}/>);
  expect(screen.getByText(/AI-cited summary/).textContent).toContain("not a quotation from the page");
  expect(container.querySelector("blockquote")).toBeNull();
  expect(container.querySelector(".chat-evidence__summary")?.textContent).toBe(evidence.text);
  expect(screen.getByRole("button", { name: "Open website" })).toBeDefined();
});

it("keeps legacy search excerpts labelled as excerpts", () => {
  const excerpt = { ...evidence, web: { ...evidence.web!, evidenceType: undefined } };
  const { container } = render(<CitedPassage evidence={excerpt} notes={[]} sources={[]} panelId="test"
    savedWith="note" onClose={vi.fn()} onOpenNote={vi.fn()}/>);
  expect(screen.getByText(/Web search excerpt/)).toBeDefined();
  expect(container.querySelector("blockquote")?.textContent).toBe(evidence.text);
});
