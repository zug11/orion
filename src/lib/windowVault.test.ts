import { describe, expect, it } from "vitest";
import { createEmptyVault } from "../data/defaults";
import type { Note, OrionVault } from "../types";
import { mergeWindowVault, persistWindowVault, preserveWindowNavigation, vaultValuesEqual, WindowVaultConflict } from "./windowVault";
import { applyChatResult } from "./chat";
import { createChatThread, deleteChatThread, LEGACY_CHAT_THREAD_ID } from "./chatThreads";

function fixture() {
  const vault = createEmptyVault("Windows", "2026-09-07T00:00:00.000Z");
  vault.spaces[0].notes = ["one", "two"].map((id): Note => ({
    id, title: id, slug: id, body: `Original ${id}`, summary: "", aliases: [], tags: [],
    kind: "article", status: "ready", sourceIds: [], conceptIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt,
  }));
  return vault;
}
const copy = (vault: OrionVault) => structuredClone(vault);

describe("shared vault, independent windows", () => {
  it("merges concurrent first thread creation from a legacy vault", () => {
    const base = fixture(); delete base.spaces[0].studio.threads;
    const local = copy(base), remote = copy(base);
    local.spaces[0] = createChatThread(local.spaces[0], "chat-local", base.updatedAt);
    remote.spaces[0] = createChatThread(remote.spaces[0], "chat-remote", base.updatedAt);
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[0].studio.threads?.map(thread => thread.id)).toEqual(["chat-remote", "chat-local"]);
  });

  it.each(["chat-one", LEGACY_CHAT_THREAD_ID])("requires a choice for %s deletion racing a reply, and resolves the complete thread", id => {
    const base = fixture();
    let sequence = 0;
    const append = (space: OrionVault["spaces"][number], target: string, prompt: string) =>
      applyChatResult(space, prompt, { reply: "Reply" }, base.updatedAt, () => `message-${++sequence}`, undefined, undefined,
        target === LEGACY_CHAT_THREAD_ID ? undefined : target);
    base.spaces[0] = append(base.spaces[0], id, "Original conversation");
    base.spaces[0] = createChatThread(base.spaces[0], "chat-other", base.updatedAt);
    const local = copy(base), remote = copy(base);
    local.spaces[0] = deleteChatThread(local.spaces[0], id, base.updatedAt);
    remote.spaces[0] = append(remote.spaces[0], id, "Concurrent follow-up");
    // Independent edits survive either resolution.
    local.spaces[0] = append(local.spaces[0], "chat-other", "An unrelated conversation");
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
    const ours = mergeWindowVault(base, local, remote, "local").spaces[0].studio;
    expect(ours.messages.map(message => message.threadId ?? LEGACY_CHAT_THREAD_ID)).toEqual(["chat-other", "chat-other"]);
    expect(ours.threads?.some(thread => thread.id === id)).toBe(false);
    const theirs = mergeWindowVault(base, local, remote, "remote").spaces[0].studio;
    expect(theirs.messages.filter(message => (message.threadId ?? LEGACY_CHAT_THREAD_ID) === id)).toHaveLength(4);
    expect(theirs.messages.filter(message => message.threadId === "chat-other")).toHaveLength(2);
  });

  it("merges independent thread replies without mixing their identities", () => {
    const base = fixture();
    base.spaces[0] = createChatThread(createChatThread(base.spaces[0], "chat-one", base.updatedAt), "chat-two", base.updatedAt);
    const local = copy(base), remote = copy(base);
    let sequence = 0;
    local.spaces[0] = applyChatResult(local.spaces[0], "One", { reply: "First" }, base.updatedAt, () => `local-${++sequence}`, undefined, undefined, "chat-one");
    remote.spaces[0] = applyChatResult(remote.spaces[0], "Two", { reply: "Second" }, base.updatedAt, () => `remote-${++sequence}`, undefined, undefined, "chat-two");
    const merged = mergeWindowVault(base, local, remote).spaces[0].studio;
    expect(merged.messages.map(message => message.threadId)).toEqual(["chat-two", "chat-two", "chat-one", "chat-one"]);
    expect(merged.threads?.map(thread => thread.title)).toEqual(["One", "Two"]);
  });

  it("merges concurrent first calendar dismissals as a union without changing either note's time anchor", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].dismissedCalendarMentions = ["v1:0123456789abcdef:0:1"];
    remote.spaces[0].notes[0].dismissedCalendarMentions = ["v1:0123456789abcdef:0:2"];
    const merged = mergeWindowVault(base, local, remote).spaces[0].notes[0];
    expect(merged).toEqual({ ...base.spaces[0].notes[0], dismissedCalendarMentions: ["v1:0123456789abcdef:0:2", "v1:0123456789abcdef:0:1"] });
  });

  it("merges dismissal Undo with later prose and another new dismissal", () => {
    const base = fixture(); base.spaces[0].notes[0].dismissedCalendarMentions = ["v1:0123456789abcdef:0:1"];
    const local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].dismissedCalendarMentions = [];
    remote.spaces[0].notes[0].body = "Later authored prose.";
    remote.spaces[0].notes[0].dismissedCalendarMentions!.push("v1:0123456789abcdef:0:2");
    expect(mergeWindowVault(base, local, remote).spaces[0].notes[0]).toMatchObject({ body: "Later authored prose.", dismissedCalendarMentions: ["v1:0123456789abcdef:0:2"] });
  });

  it("requires an explicit conflict choice if a concurrent dismissal union exceeds its bound", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].dismissedCalendarMentions = Array.from({ length: 3000 }, (_, i) => `v1:0123456789abcdef:0:${i}`);
    remote.spaces[0].notes[0].dismissedCalendarMentions = Array.from({ length: 3000 }, (_, i) => `v1:0123456789abcdef:1:${i}`);
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
    expect(mergeWindowVault(base, local, remote, "local").spaces[0].notes[0].dismissedCalendarMentions).toEqual(local.spaces[0].notes[0].dismissedCalendarMentions);
    expect(mergeWindowVault(base, local, remote, "remote").spaces[0].notes[0].dismissedCalendarMentions).toEqual(remote.spaces[0].notes[0].dismissedCalendarMentions);
  });

  it("merges a removed heading layout with another writer's body edit", () => {
    const base = fixture();
    base.spaces[0].notes[0].title = "";
    const local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].headingLayout = "none";
    remote.spaces[0].notes[0].body = "Writing from the other window.";
    expect(mergeWindowVault(base, local, remote).spaces[0].notes[0]).toMatchObject({
      title: "", summary: "", headingLayout: "none", body: "Writing from the other window.",
    });
  });
  it("treats native JSON key ordering as the same content and avoids redundant writes", async () => {
    const base = fixture();
    const reordered = JSON.parse(JSON.stringify(base), (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).reverse());
    }) as OrionVault;
    expect(vaultValuesEqual(base, reordered)).toBe(true);
    let saved = false;
    await persistWindowVault(base, copy(base), { load: async () => reordered, save: async () => { saved = true; } });
    expect(saved).toBe(false);
  });
  it("merges edits to separate notes without changing disk order or navigation", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "Local text";
    local.spaces[0].activeNoteId = "one";
    remote.spaces[0].notes[1].body = "Other window text";
    remote.spaces[0].activeNoteId = "two";
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[0].notes.map((n) => n.body)).toEqual(["Local text", "Other window text"]);
    expect(merged.spaces[0].activeNoteId).toBe("one");
    expect(base.spaces[0].notes[0].body).toBe("Original one");
  });

  it("keeps a note created in this window where it was created when another writer also saved", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    const extra = (id: string): Note => ({ ...base.spaces[0].notes[0], id, title: id, slug: id, body: `New ${id}` });
    // New notes go to the top of the list. Another writer edits an existing note.
    local.spaces[0].notes = [extra("mine"), ...local.spaces[0].notes];
    remote.spaces[0].notes[1].body = "Other window text";
    expect(mergeWindowVault(base, local, remote).spaces[0].notes.map((n) => n.id)).toEqual(["mine", "one", "two"]);

    // Both writers add at the top: both stay at the top, the saved one first.
    remote.spaces[0].notes = [extra("theirs"), ...remote.spaces[0].notes];
    expect(mergeWindowVault(base, local, remote).spaces[0].notes.map((n) => n.id)).toEqual(["theirs", "mine", "one", "two"]);

    // A record inserted between two existing ones stays between them.
    const between = copy(base);
    between.spaces[0].notes = [between.spaces[0].notes[0], extra("middle"), extra("middle-2"), between.spaces[0].notes[1]];
    expect(mergeWindowVault(base, between, remote).spaces[0].notes.map((n) => n.id)).toEqual(["theirs", "one", "middle", "middle-2", "two"]);
  });
  it("keeps appended records in the order they reached disk", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    const extra = (id: string): Note => ({ ...base.spaces[0].notes[0], id, title: id, slug: id });
    local.spaces[0].notes.push(extra("mine"));
    remote.spaces[0].notes.push(extra("theirs"), extra("theirs-2"));
    expect(mergeWindowVault(base, local, remote).spaces[0].notes.map((n) => n.id)).toEqual(["one", "two", "theirs", "theirs-2", "mine"]);
  });
  it("puts a record back in its place when its remote deletion loses a conflict", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "Edited here";
    remote.spaces[0].notes = remote.spaces[0].notes.slice(1);
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
    expect(mergeWindowVault(base, local, remote, "local").spaces[0].notes.map((n) => n.id)).toEqual(["one", "two"]);
    expect(mergeWindowVault(base, local, remote, "remote").spaces[0].notes.map((n) => n.id)).toEqual(["two"]);
  });

  it("merges different fields on one note and keeps independent tag changes", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "Edited prose";
    local.spaces[0].notes[0].tags = ["local"];
    remote.spaces[0].notes[0].title = "Renamed elsewhere";
    remote.spaces[0].notes[0].tags = ["remote"];
    expect(mergeWindowVault(base, local, remote).spaces[0].notes[0]).toMatchObject({
      title: "Renamed elsewhere", body: "Edited prose", tags: ["remote", "local"],
    });
  });

  it("requires an explicit choice for competing prose and preserves unrelated changes with either choice", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "My version";
    remote.spaces[0].notes[0].body = "Other version";
    local.spaces[0].notes[1].title = "My other edit";
    remote.spaces[0].notes[1].summary = "Their other edit";
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
    for (const choice of ["local", "remote"] as const) {
      const notes = mergeWindowVault(base, local, remote, choice).spaces[0].notes;
      expect(notes[0].body).toBe(choice === "local" ? "My version" : "Other version");
      expect(notes[1]).toMatchObject({ title: "My other edit", summary: "Their other edit" });
    }
  });

  it("does not resurrect deletions, and makes deletion versus editing a conflict", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    remote.spaces[0].notes.shift();
    local.spaces[0].activeNoteId = "one";
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[0].notes.map((n) => n.id)).toEqual(["two"]);
    expect(merged.spaces[0].activeNoteId).toBeNull();
    local.spaces[0].notes[0].body = "Unsaved edit";
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
  });

  it("keeps windows in separate Spaces when another window navigates", () => {
    const local = fixture(), other = createEmptyVault("Other").spaces[0];
    local.spaces.push(other);
    local.spaces[0].activeNoteId = "one";
    const remote = copy(local); remote.activeSpaceId = other.workspace.id;
    remote.spaces[0].activeNoteId = "two";
    expect(preserveWindowNavigation(remote, local)).toMatchObject({ activeSpaceId: local.activeSpaceId });
    expect(preserveWindowNavigation(remote, local).spaces[0].activeNoteId).toBe("one");
  });

  it("retries an atomic revision race against fresh disk data", async () => {
    const base = fixture(), local = copy(base); let disk = copy(base), attempts = 0;
    local.spaces[0].notes[0].body = "Mine";
    const saved = await persistWindowVault(base, local, {
      load: async () => copy(disk),
      save: async (next, revision) => {
        if (attempts++ === 0) {
          disk.spaces[0].notes[1].body = "Concurrent edit";
          disk.updatedAt = "2026-09-07T00:00:00.001Z";
          throw new Error("ORION_VAULT_CONFLICT");
        }
        expect(revision).toBe(disk.updatedAt); disk = next;
      },
    });
    expect(saved.spaces[0].notes.map((n) => n.body)).toEqual(["Mine", "Concurrent edit"]);
    expect(attempts).toBe(2);
  });

  it("does not apply a conflict choice to a newer unseen version", async () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "My text";
    remote.spaces[0].notes[0].body = "A newer edit";
    remote.updatedAt = "2026-09-07T00:00:01.000Z";
    await expect(persistWindowVault(base, local, {
      load: async () => remote, save: async () => { throw new Error("Must not save"); },
    }, { choice: "local", revision: base.updatedAt })).rejects.toThrow(WindowVaultConflict);
  });
});

it("merges passage-comment metadata with prose edited in another window", () => {
  const base = fixture(), local = copy(base), remote = copy(base);
  local.spaces[0].notes[0].discussionThreads = [{ id: "thread", anchor: { quote: "Original one", text: "Original one" }, state: "proposed", createdAt: base.updatedAt, updatedAt: base.updatedAt, messages: [{ id: "m", role: "assistant", content: "A comment", createdAt: base.updatedAt }] }];
  remote.spaces[0].notes[0].body += "\n\nNew paragraph.";
  const merged = mergeWindowVault(base, local, remote).spaces[0].notes[0];
  expect(merged.body).toBe(remote.spaces[0].notes[0].body);
  expect(merged.discussionThreads).toEqual(local.spaces[0].notes[0].discussionThreads);
});
