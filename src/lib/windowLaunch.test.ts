import { describe, expect, it } from "vitest";
import { createEmptyVault, createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { applyWindowLaunch, documentWindowUrl, parseWindowLaunch, windowLaunchNote } from "./windowLaunch";

function fixture() {
  const vault = createEmptyVault("First");
  const other = createEmptySnapshot("Second");
  const note: Note = {
    id: "note-target", title: "Draft", slug: "draft", body: "My draft", summary: "",
    aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt,
  };
  other.notes = [note];
  vault.spaces.push(other);
  return { vault, other, note };
}

describe("document window launch", () => {
  it("opens the exact note in its Space without copying or altering content", () => {
    const { vault, other, note } = fixture();
    const launch = parseWindowLaunch(`?view=writing&space=${other.workspace.id}&note=${note.id}`);
    const next = applyWindowLaunch(vault, launch);
    expect(next.activeSpaceId).toBe(other.workspace.id);
    expect(next.spaces[1].activeNoteId).toBe(note.id);
    expect(next.spaces[1].notes[0]).toBe(note);
    expect(vault.activeSpaceId).not.toBe(other.workspace.id);
  });

  it("never resolves an ID from a different Space or falls back to a selected note", () => {
    const { vault, note } = fixture();
    vault.spaces[1].activeNoteId = note.id;
    expect(windowLaunchNote(vault, { writing: true, spaceId: vault.activeSpaceId, noteId: note.id })).toBeNull();
    expect(windowLaunchNote(vault, { writing: true, spaceId: "deleted-space", noteId: note.id })).toBeNull();
    const launch = { writing: true, spaceId: vault.spaces[1].workspace.id, noteId: "deleted-note" };
    expect(windowLaunchNote(vault, launch)).toBeNull();
  });

  it("keeps a missing or invalid writing target in writing mode", () => {
    expect(parseWindowLaunch("?view=writing&space=s&note=%00oops")).toEqual({ writing: true, spaceId: "s", noteId: null });
    expect(parseWindowLaunch("?view=writing").writing).toBe(true);
    expect(parseWindowLaunch(`?space=${"x".repeat(513)}`).spaceId).toBeNull();
  });

  it("clears a previous writing route when opening a library and encodes exact IDs", () => {
    const url = documentWindowUrl("http://localhost/?view=writing&space=old&note=old#hash", "space & one", "note/two");
    expect(parseWindowLaunch(new URL(url).search)).toEqual({ writing: false, spaceId: "space & one", noteId: "note/two" });
    expect(new URL(url).hash).toBe("");
    expect(new URL(documentWindowUrl(url, "s")).searchParams.has("note")).toBe(false);
  });
});
