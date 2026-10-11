import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceDeliveryQueue } from "./voiceConversation";

afterEach(() => vi.useRealTimers());
describe("sequenced voice findings", () => {
  it("does not replay duplicate or older findings even after delivery, but accepts a newer revision", () => {
    const queue = new VoiceDeliveryQueue();
    const update = { id: "work", revision: 2, sequence: 3, text: "new finding", delegationId: null };
    const send = vi.fn(() => true);
    queue.enqueue(update); queue.flush(() => true, send);
    queue.enqueue(update);
    queue.enqueue({ ...update, sequence: 2 });
    queue.enqueue({ ...update, revision: 1, sequence: 9 });
    expect(queue.length).toBe(0);
    queue.enqueue({ ...update, revision: 3, sequence: 1 }); queue.flush(() => true, send);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("coalesces checkpoint bursts without extending the maximum wait or losing another worker", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const queue = new VoiceDeliveryQueue();
    queue.enqueue({ id: "a", revision: 1, sequence: 1, text: "first", delegationId: null });
    queue.enqueue({ id: "b", revision: 1, sequence: 1, text: "other worker", delegationId: null });
    vi.setSystemTime(11_000);
    queue.enqueue({ id: "a", revision: 1, sequence: 2, text: "latest", delegationId: null });
    const sent: string[] = [];
    queue.flush(() => true, item => { sent.push(item.text); return true; });
    expect(sent).toEqual(["other worker"]);
    expect(queue.next).toMatchObject({ text: "latest", queuedAt: 1_000, sequence: 2 });
  });
  it("starts a fresh wait for corrected work and does not retain delivery state across a cleared call", () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000);
    const queue = new VoiceDeliveryQueue();
    const update = { id: "a", revision: 1, sequence: 1, text: "first", delegationId: null };
    queue.enqueue(update); vi.setSystemTime(5_000);
    queue.enqueue({ ...update, revision: 2 });
    expect(queue.next?.queuedAt).toBe(5_000);
    queue.clear(); queue.enqueue(update); expect(queue.length).toBe(1);
  });
});
