// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatWithOrion, generateNoteImage, persistGeneratedNoteImage, planNoteImage } from "./storage";
import { buildAIWritingRequest } from "./aiWriting";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest } from "../types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const grant = { actionId: "external-action", sessionId: "window-session" };
const image = { fileName: "orion-generated-image.jpg", mimeType: "image/jpeg" as const, byteSize: 4, base64Data: "/9j/2Q==" };
const writing: ChatRequest = { prompt: "Clarify this passage", mode: "inline-writing", workspaceName: "Space", notes: [], sources: [], concepts: [], history: [] };
const planning = { stage: "compose" as const, model: "gpt-6-sol", effort: "medium" as const,
  context: JSON.stringify({ selectedPassage: "A passage", activeNoteTitle: "Draft", visualDirection: "", contextEnabled: false, evidence: [] }) };
beforeEach(() => { invoke.mockReset(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); })); });
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.unstubAllGlobals(); });

describe("external editor native transport authority", () => {
  it("passes the exact grant beside native requests without adding it to model context", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockImplementation(async (command: string) => {
      if (command === "chat") return { reply: "Revised prose" };
      if (command === "plan_note_image") return { visualBrief: "A visible scene", alt: "Scene", evidenceIds: [] };
      if (command === "generate_note_image") return image;
      if (command === "save_note_image") return { id: "image_123456789012345678", fileName: image.fileName, mimeType: image.mimeType, byteSize: 4, src: "orion-image://localhost/image_123456789012345678" };
      throw new Error(`Unexpected command ${command}`);
    });
    await chatWithOrion(writing, undefined, grant);
    await planNoteImage(planning, undefined, grant);
    await generateNoteImage("A scene", undefined, "fast", grant);
    await persistGeneratedNoteImage(image, "image_123456789012345678", grant);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["chat", "plan_note_image", "generate_note_image", "save_note_image"]);
    for (const [, args] of invoke.mock.calls) {
      expect(args.editorActionGrant).toEqual(grant);
      expect(JSON.stringify(args.request)).not.toContain("external-action");
      expect(JSON.stringify(args.request)).not.toContain("window-session");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never falls back to browser provider calls or asset creation with external authority", async () => {
    for (const operation of [() => chatWithOrion(writing, undefined, grant), () => planNoteImage(planning, undefined, grant),
      () => generateNoteImage("A scene", undefined, "fast", grant), () => persistGeneratedNoteImage(image, "image_123456789012345678", grant)]) {
      await expect(operation()).rejects.toThrow(/native Orion window/);
    }
    expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects malformed native authority before admission", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    await expect(chatWithOrion(writing, undefined, { ...grant, accept: true } as never)).rejects.toThrow(/invalid native authority/);
    await expect(generateNoteImage("A scene", undefined, "fast", { ...grant, actionId: "" })).rejects.toThrow(/invalid native authority/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("keeps authority out of a generated writing prompt", () => {
    const snapshot = createEmptySnapshot("Space", "now", "s");
    snapshot.notes.push({ id: "n", title: "Draft", body: "Original prose", summary: "", kind: "article", status: "ready", slug: "draft", aliases: [], tags: [], conceptIds: [], sourceIds: [], createdAt: "now", updatedAt: "now" });
    const packet = buildAIWritingRequest(snapshot, { originNoteId: "n", action: "rewrite", selectedText: "Original prose", editorActionGrant: grant });
    expect(JSON.stringify(packet)).not.toContain("external-action"); expect(JSON.stringify(packet)).not.toContain("window-session");
  });
});
