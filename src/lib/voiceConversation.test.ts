import { describe, expect, it, vi } from "vitest";
import { VoiceConversation, VoiceDeliveryQueue, type VoiceDelivery, type VoiceTurn } from "./voiceConversation";

describe("voice conversation assembly", () => {
  const speech = (delta: string, start_ms: number, end_ms: number, role = "input") => ({ type: "session." + role + "_transcript.delta", delta, start_ms, end_ms });
  it("claims an opening only once per fresh conversation, including an empty reconnect", () => {
    const history = new VoiceConversation();
    expect(history.reconnect()).toBe(true);
    expect(history.reconnect()).toBe(false);
    history.receive(speech("My thought", 0, 100));
    expect(history.reconnect()).toBe(false); expect(history.text()).toContain("My thought");
    history.clear(); expect(history.reconnect()).toBe(true);
    const alreadySpeaking = new VoiceConversation(); alreadySpeaking.receive(speech("Let's begin", 0, 100));
    expect(alreadySpeaking.reconnect()).toBe(false);
  });
  it("preserves separate requests when transcript delivery batches two silence-separated turns", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research alpha", 0, 200));
    history.receive(speech("Also compare beta", 1_200, 1_400));
    expect(history.takeTurns().map(turn => turn.prompt)).toEqual(["Research alpha", "Also compare beta"]);
  });
  it("keeps a full duplex utterance together and captures its original note", () => {
    const history = new VoiceConversation();
    history.receive(speech("Compare alpha", 0, 100), "first-note");
    history.receive(speech("Mm-hmm.", 100, 150, "output"));
    history.receive(speech(" and beta", 150, 400), "different-note");
    history.receive({ type: "session.delegation.created", delegation: { id: "d" }, offset_ms: 400 });
    expect(history.takeTurns()).toEqual([{ key: 1, prompt: "Compare alpha and beta", delegated: true, delegationId: "d", focusNoteId: "first-note" }]);
    expect(history.takeTurns()).toEqual([]);
  });
  it("keeps close finalized utterances on their own notes and matches delayed delegation by audio item", () => {
    const history = new VoiceConversation();
    history.receive({ ...speech("Research the first theme.", 0, 200), item_id: "first" }, "A", undefined, undefined, true);
    history.receive({ ...speech("Research the second theme.", 180, 320), item_id: "second" }, "B", undefined, undefined, true);
    history.receive({ type: "session.delegation.created", delegation: { id: "later" }, offset_ms: 300, item_id: "first" }, undefined, undefined, undefined, true);
    expect(history.takeTurns()).toMatchObject([
      { prompt: "Research the first theme.", focusNoteId: "A", delegationId: "later" },
      { prompt: "Research the second theme.", focusNoteId: "B", delegationId: null },
    ]);
  });
  it("binds a follow-up to its opening worker revision across fragments and delayed delegation", () => {
    const history = new VoiceConversation(), worker = { id: "motivation", revision: 2 };
    history.receive(speech("Follow that", 0, 100), "original-note", undefined, worker);
    worker.revision = 3;
    history.receive(speech(" distinction", 200, 400), "other-note", undefined, { id: "setting", revision: 1 });
    expect(history.takeTurns()[0]).toMatchObject({ prompt: "Follow that distinction", focusNoteId: "original-note", focusedWorker: { id: "motivation", revision: 2 } });
    history.receive({ type: "session.delegation.created", delegation: { id: "late" }, offset_ms: 400 });
    expect(history.takeTurns()[0]).toMatchObject({ delegationId: "late", focusedWorker: { id: "motivation", revision: 2 } });
  });
  it("maps out-of-order delegations to their own utterances, never the latest one", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research alpha", 0, 200));
    history.receive(speech("Research beta", 3_000, 3_200));
    history.receive({ type: "session.delegation.created", delegation: { id: "a" }, offset_ms: 200 });
    history.receive({ type: "session.delegation.created", delegation: { id: "b" }, offset_ms: 3_200 });
    expect(history.takeTurns().map(turn => [turn.prompt, turn.delegationId])).toEqual([["Research alpha", "a"], ["Research beta", "b"]]);
  });
  it("routes utterances in spoken order when their delegations arrive in reverse order", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research alpha", 0, 200));
    history.receive(speech("Actually use the 2024 alpha evidence", 3_000, 3_200));
    history.receive({ type: "session.delegation.created", delegation: { id: "correction" }, offset_ms: 3_200 });
    history.receive({ type: "session.delegation.created", delegation: { id: "original" }, offset_ms: 200 });
    expect(history.takeTurns().map(turn => turn.delegationId)).toEqual(["original", "correction"]);
    expect(history.takeTurns()).toEqual([]);
  });
  it("retains an undelegated cancellation before a later utterance in the same batch", () => {
    const history = new VoiceConversation();
    history.receive(speech("Cancel the alpha research", 0, 200));
    history.receive(speech("Research beta", 3_000, 3_200));
    history.receive({ type: "session.delegation.created", delegation: { id: "beta" }, offset_ms: 3_200 });
    expect(history.takeTurns().map(turn => [turn.prompt, turn.delegated])).toEqual([
      ["Cancel the alpha research", false], ["Research beta", true],
    ]);
    expect(history.takeTurns()).toEqual([]);
  });
  it("waits for a future request's transcript and deduplicates delegation retries", () => {
    const history = new VoiceConversation();
    history.receive(speech("Old question", 0, 200)); history.takeTurns();
    const delegation = { type: "session.delegation.created", delegation: { id: "new" }, offset_ms: 5_000 };
    history.receive(delegation); expect(history.takeTurns()).toEqual([]);
    history.receive(speech("New question", 4_900, 5_200));
    expect(history.takeTurns()[0]).toMatchObject({ prompt: "New question", delegationId: "new" });
    expect(history.receive(delegation)).toBe(false); expect(history.takeTurns()).toEqual([]);
  });
  it("holds an incomplete delegated utterance and preserves its target through a thinking pause", () => {
    const history = new VoiceConversation();
    history.receive(speech("Read", 0, 200), "first-note");
    history.receive({ type: "session.delegation.created", delegation: { id: "d" }, offset_ms: 200 });
    expect(history.takeTurns()).toEqual([]);
    history.receive(speech("the second note", 3_000, 3_500), "different-note");
    expect(history.takeTurns()[0]).toMatchObject({ key: 1, delegated: true, prompt: "Read the second note", focusNoteId: "first-note" });
  });
  it("exposes only retained exact user turns and their delegation state without replaying them", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research alpha", 0, 200));
    history.receive(speech("I'll look into alpha", 500, 700, "output"));
    history.takeTurns();
    expect(history.recentTurns()).toEqual([{ key: 1, prompt: "Research alpha", delegated: false }]);
    history.receive({ type: "session.delegation.created", delegation: { id: "alpha" }, offset_ms: 200 });
    history.takeTurns();
    expect(history.recentTurns()).toEqual([{ key: 1, prompt: "Research alpha", delegated: true }]);
    expect(history.takeTurns()).toEqual([]);
    history.reconnect();
    expect(history.recentTurns()).toEqual([]);
  });
  it("retains decisions and conversation across reconnect without replaying work", () => {
    const history = new VoiceConversation();
    history.receive(speech("Let's use the 2024 figures", 0, 300));
    history.remember("Let's use the 2024 figures");
    history.takeTurns(); history.reconnect();
    expect(history.text()).toContain("2024 figures"); expect(history.takeTurns()).toEqual([]);
    history.clear(); expect(history.text().trim()).toBe("");
  });
  it("records typed answers in order with fresh identities and their original captured references", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research related products", 0, 100), "original-note");
    history.receive({ type: "session.delegation.created", delegation: { id: "original-delegation" }, offset_ms: 100 });
    const captured: VoiceTurn = { ...history.takeTurns()[0], focusedWorker: { id: "worker-a", revision: 2 },
      selection: { id: "selected", spaceId: "space", noteId: "original-note", noteTitle: "Original", version: "v1",
        range: { from: 0, to: 8, unit: "dom-text-utf16" }, text: "Original", hiddenTaskRanges: [] } };
    history.receive(speech("Which comparison matters?", 200, 300, "output"));
    const answer = history.answer("  products with strongest match to Orion  ", captured);
    captured.selection!.text = "Changed selection"; captured.focusedWorker!.revision = 3;
    expect(answer).toMatchObject({ key: 3, prompt: "  products with strongest match to Orion  ", delegated: true,
      delegationId: null, focusNoteId: "original-note", selection: { text: "Original" }, focusedWorker: { id: "worker-a", revision: 2 } });
    expect(history.text()).toContain("user: Research related products\nassistant: Which comparison matters?\nuser:   products with strongest match to Orion  ");
    expect(history.takeTurns()).toEqual([]);
    const next = history.answer("Include tools for research", captured);
    expect(next.key).toBe(4); expect(next.delegationId).toBeNull();
    expect(history.recentTurns().map(turn => [turn.key, turn.delegated])).toEqual([[1, true], [3, true], [4, true]]);
    history.reconnect();
    expect(history.text()).toContain("products with strongest match to Orion");
    expect(history.takeTurns()).toEqual([]);
    expect(history.answer("Another answer", captured).key).toBe(5);
  });
  it("keeps subsequent microphone speech separate from a typed answer without synthesizing audio offsets", () => {
    const history = new VoiceConversation();
    history.receive(speech("Research alpha", 0, 100));
    const original = history.takeTurns()[0];
    const answer = history.answer("Focus on costs", original);
    history.receive(speech("Actually compare beta too", 200, 400));
    expect(history.takeTurns()).toEqual([{ key: answer.key + 1, prompt: "Actually compare beta too", delegated: false, delegationId: null, focusNoteId: undefined }]);
    expect(history.text()).toContain("user: Focus on costs\nuser: Actually compare beta too");
  });
  it("bounds retained typed answers and never reuses an identity after clearing conversation history", () => {
    const history = new VoiceConversation();
    const captured: VoiceTurn = { key: 0, prompt: "Original question", delegationId: "old-provider", delegated: false };
    for (let i = 0; i < 45; i++) history.answer(`Answer ${i}: ` + "x".repeat(200), captured);
    expect(history.recentTurns()).toHaveLength(40);
    expect(history.text().length).toBeLessThanOrEqual(8_000);
    expect(history.takeTurns()).toEqual([]);
    history.clear(); expect(history.text().trim()).toBe("");
    expect(history.answer("Fresh answer", captured)).toMatchObject({ key: 46, delegationId: null, delegated: true });
    expect(history.answer("Restored question", { ...captured, key: 70 })).toMatchObject({ key: 71, delegationId: null });
  });
  it("retains opening qualifications and flags an oversized utterance rather than authorizing its tail", () => {
    const history = new VoiceConversation();
    history.receive(speech("Do not execute this example. " + "context ".repeat(550), 0, 200));
    history.receive(speech("save this as a note", 200, 300));
    history.receive({ type: "session.delegation.created", delegation: { id: "d" }, offset_ms: 300 });
    const turn = history.takeTurns()[0];
    expect(turn.prompt.length).toBeGreaterThan(4_000);
    expect(turn.prompt.startsWith("Do not execute")).toBe(true);
    expect(turn.prompt.endsWith("save this as a note")).toBe(false);
  });
});

describe("voice result buffer", () => {
  it("replaces queued revisions and drops a cancelled sibling before sending", () => {
    const queue = new VoiceDeliveryQueue();
    queue.enqueue({ id: "a", revision: 1, text: "obsolete", delegationId: "a" });
    queue.enqueue({ id: "b", revision: 1, text: "cancelled", delegationId: "b" });
    queue.enqueue({ id: "a", revision: 2, text: "current complete answer", delegationId: "a" });
    const send = vi.fn((_item: VoiceDelivery) => true);
    queue.flush(item => item.id === "a" && item.revision === 2, send);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ text: "current complete answer" });
    expect(queue.length).toBe(0);
  });
  it("retains complete updates when disconnected and clears without replay", () => {
    const queue = new VoiceDeliveryQueue();
    queue.enqueue({ text: "whole message", delegationId: null });
    queue.flush(() => true, () => false);
    expect(queue.length).toBe(1);
    queue.clear(); expect(queue.length).toBe(0);
  });
});
