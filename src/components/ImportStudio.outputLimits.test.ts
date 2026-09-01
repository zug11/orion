import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { buildImportPayload, type OrganizedSource } from "./ImportStudio";

function organizedSource(count: number): OrganizedSource {
  return {
    item: {
      id: "input",
      status: "ready",
      fileName: "arguments.txt",
      mimeType: "text/plain",
      byteSize: 66,
      included: true,
      parsed: {
        title: "Synthetic arguments",
        text: "Independent synthetic arguments with a preserved qualification.",
        format: "text",
        fileName: "arguments.txt",
        mimeType: "text/plain",
        byteSize: 66,
        warnings: [],
      },
    },
    result: {
      notes: Array.from({ length: count }, (_, index) => ({
        title: `Independent argument ${index + 1}`,
        summary: "One distinct thesis.",
        body: `This is argument ${index + 1}. It may hold only under its stated conditions.`,
        aliases: [], tags: [], links: [],
      })),
      wikiArticles: [], concepts: [], suggestedConnections: [],
    },
  };
}

describe("import output count boundaries", () => {
  it("keeps more than twelve direct-path notes instead of silently slicing them", () => {
    const input = organizedSource(20);
    const payload = buildImportPayload([input], createEmptySnapshot("Test"));
    expect(payload.notes).toHaveLength(20);
    expect(payload.sources[0].text).toBe(input.item.parsed!.text);
    expect(payload.sources[0].noteIds).toHaveLength(20);
    expect(payload.notes[payload.notes.length - 1]?.body).toContain("argument 20");
  });

  it("fails explicitly at the shared atomic safety boundary without returning a partial payload", () => {
    const snapshot = createEmptySnapshot("Test");
    expect(() => buildImportPayload([organizedSource(31)], snapshot))
      .toThrow("more than 30 new notes");
    expect(snapshot.notes).toEqual([]);
    expect(snapshot.sources).toEqual([]);
  });
});
