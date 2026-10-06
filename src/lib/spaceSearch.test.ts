import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { runSpaceSearch } from "./spaceSearch";

function fixture() {
  const snapshot = createEmptySnapshot("Search room", "2026-10-01T00:00:00.000Z", "space-search");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "quartz", title: "Quartz", body: "The original observation describes a clear crystal.", summary: "A mineral", slug: "quartz", aliases: [], tags: [],
    sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }];
  return snapshot;
}
const readNote = { reply: "", readRequests: [{ kind: "note" as const, id: "quartz", query: "crystal", start: null }] };

describe("explicit AI Space search", () => {
  it("uses exact bounded passages with no Chat history or note-creation authority", async () => {
    const snapshot = fixture();
    snapshot.studio.messages = [{ id: "private-chat", role: "user", content: "Chat-only wording", cardIds: [], contextCardIds: [], createdAt: "2026-10-01T00:00:00.000Z" }];
    const before = structuredClone(snapshot);
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      expect(request.history).toEqual([]);
      expect(request.allowNoteActions).toBe(false);
      expect(JSON.stringify(request)).not.toContain("Chat-only wording");
      const packet = JSON.parse(request.readingContext!);
      return packet.evidence.length ? { reply: "The observation describes a clear crystal [[e1]].", noteActions: [{ title: "Not authorized", summary: "", body: "Injected", tags: [], aliases: [] }] } : readNote;
    });
    const result = await runSpaceSearch(snapshot, "Create a note about quartz", driver);
    expect(result.reply).toContain("[1](#orion-evidence-e1)");
    expect(result.evidence?.[0].text).toBe(snapshot.notes[0].body);
    expect(result.noteActions).toBeUndefined();
    expect(snapshot).toEqual(before);
  });

  it("does not return an unsupported model answer or invented local citation", async () => {
    const unsupported = await runSpaceSearch(fixture(), "quartz", async () => ({ reply: "This unsupported model claim is certain." }));
    expect(unsupported.reply).not.toContain("unsupported model claim");
    expect(unsupported.reply).toContain("could not establish");
    await expect(runSpaceSearch(fixture(), "quartz", async () => ({ reply: "Invented [[e999]]" }))).rejects.toThrow("outside");
  });

  it("rejects changed knowledge or provider settings before returning a late answer", async () => {
    const snapshot = fixture();
    const current = structuredClone(snapshot);
    let calls = 0;
    await expect(runSpaceSearch(snapshot, "quartz", async () => {
      if (!calls++) return readNote;
      current.notes[0].body = "Changed source claim";
      return { reply: "The crystal is clear [[e1]]." };
    }, { currentSnapshot: () => current })).rejects.toThrow("Space changed");
  });

  it("cancels late provider completions without producing a result", async () => {
    const controller = new AbortController();
    const driver = vi.fn(async () => { controller.abort(new Error("Stopped")); return { reply: "Late" }; });
    await expect(runSpaceSearch(fixture(), "quartz", driver, { signal: controller.signal })).rejects.toThrow("Stopped");
  });

  it("uses only the selected provider gate and does not call AI for an empty Space", async () => {
    const snapshot = fixture();
    snapshot.settings.model = "claude-sonnet-5";
    snapshot.settings.anthropicApiKeyConfigured = false;
    const driver = vi.fn();
    await expect(runSpaceSearch(snapshot, "quartz", driver)).rejects.toThrow("selected AI provider");
    snapshot.settings.anthropicApiKeyConfigured = true;
    snapshot.notes = [];
    expect((await runSpaceSearch(snapshot, "quartz", driver)).coverage?.availableNotes).toBe(0);
    expect(driver).not.toHaveBeenCalled();
  });
});
