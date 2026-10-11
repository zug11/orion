import { describe, expect, it } from "vitest";
import type { VoiceTurn } from "./voiceConversation";
import { VoiceReservations } from "./voiceReservations";
import type { VoiceSelection } from "./voiceSelection";

function setup() {
  let id = 0;
  return new VoiceReservations(() => `worker-${++id}`);
}
const selection = (): VoiceSelection => ({ id: "selection-a", spaceId: "space-a", noteId: "note-a", noteTitle: "Original",
  version: "v1", range: { from: 14, to: 29, unit: "dom-text-utf16" }, text: "Original passage", hiddenTaskRanges: [] });
const turn = (key = 1, prompt = "Have three workers study this note"): VoiceTurn => ({
  key, prompt, delegated: true, delegationId: `delegation-${key}`, focusNoteId: "note-a", selection: selection(),
});

describe("voice reservation ownership", () => {
  it("leaves unassigned siblings waiting after one member is steered during the original route", () => {
    const state = setup(), source = turn(); state.reserve(source, 3, "routing");
    const ids = state.jobs().map(job => job.id);
    state.removeMember(ids[0], "correct");
    expect(state.jobs().map(job => job.id)).toEqual(ids.slice(1));
    expect(state.jobs().every(job => job.phase === "clarifying" && job.progress === "Waiting for details")).toBe(true);
    expect(state.clarification).toMatchObject({ workerCount: 2, turn: { focusNoteId: "note-a", selection: selection() } });
    expect(state.handoff(turn(2, "Plot and history"), ids.slice(1), state.clarification)).toMatchObject({ focusNoteId: "note-a" });
  });
  it("keeps IDs and the captured note/range when a fuller transcript or clarification arrives after navigation", () => {
    const state = setup(), source = turn();
    expect(state.reserve(source, 3, "routing")).toBe(true);
    const ids = state.jobs().map(job => job.id);
    source.selection!.text = "Later selected text"; source.selection!.range.from = 99;
    state.reserve({ ...source, prompt: source.prompt + " in detail", focusNoteId: "note-b" }, 3, "clarifying");
    const question = state.ask(source, "What should they investigate?", 3);
    expect(state.jobs().map(job => job.id)).toEqual(ids);
    expect(question.turn).toMatchObject({ focusNoteId: "note-a", prompt: "Have three workers study this note in detail", selection: selection() });
    const captured = state.handoff(turn(2, "Plot, people and history"), ids, question);
    expect(captured).toMatchObject({ focusNoteId: "note-a", selection: selection() });
    expect(state.jobs()).toEqual([]);
    expect(state.turn(1)?.ids).toEqual(ids); expect(state.turn(2)?.ids).toEqual(ids);
    expect(state.clarification).toBeUndefined();
  });

  it("invalidates an in-flight answer after a targeted cancellation even if the group returns to its old size", () => {
    const state = setup(), source = turn();
    state.reserve(source, 3, "clarifying");
    const old = state.ask(source, "Which questions?", 3), ids = state.jobs().map(job => job.id);
    state.removeMember(ids[1], "cancel");
    expect(state.jobs().map(job => job.id)).toEqual([ids[0], ids[2]]);
    expect(state.clarification).toMatchObject({ workerCount: 2, turn: { focusNoteId: "note-a", selection: selection() } });
    expect(old.workerCount).toBe(3); // No mutation of the router's captured question.
    state.reserve(source, 3, "clarifying");
    expect(state.isCurrent(old)).toBe(false);
    expect(state.handoff(turn(2), ids, old)).toBeUndefined();
    const current = state.clarification!, currentIds = state.jobs().map(job => job.id);
    expect(currentIds.slice(0, 2)).toEqual([ids[0], ids[2]]);
    expect(currentIds).not.toContain(ids[1]);
    expect(state.handoff(turn(3), currentIds, current)).toMatchObject({ key: source.key });
  });

  it("takes only a corrected member, retaining sibling identity and invalidating the old clarification", () => {
    const state = setup(), source = turn();
    state.reserve(source, 3, "clarifying");
    const old = state.ask(source, "Which topics?", 3), [first, second, third] = state.jobs();
    expect(state.removeMember(second.id, "correct")).toEqual({ key: source.key, job: second });
    expect(state.jobs().map(job => job.id)).toEqual([first.id, third.id]);
    expect(state.clarification).toMatchObject({ question: "Which topics?", workerCount: 2 });
    expect(state.isCurrent(old)).toBe(false);
    expect(state.handoff(turn(2), [first.id, third.id], state.clarification)).toMatchObject({ selection: selection() });
  });

  it("never revives the last cancelled reservation through a delayed answer or delegation", () => {
    const state = setup(), source = turn();
    state.reserve(source, 1, "clarifying");
    const old = state.ask(source, "Which note?", 1), id = state.jobs()[0].id;
    state.removeMember(id, "cancel");
    expect(state.isCancelled(source.key)).toBe(true);
    expect(state.clarification).toBeUndefined();
    expect(state.reserve(source, 1, "routing")).toBe(false);
    expect(state.handoff(turn(2), [id], old, true)).toBeUndefined();
    expect(state.jobs()).toEqual([]);
  });

  it("isolates an unrelated admitted request from the pending clarification and detects late duplicate delegation", () => {
    const state = setup(), source = turn();
    state.reserve(source, 3, "clarifying");
    const question = state.ask(source, "What should each investigate?", 3), original = state.jobs();
    const unrelated = turn(2, "Research the weather"), id = "weather";
    expect(state.handoff(unrelated, [id])).toEqual(unrelated);
    expect(state.clarification).toBe(question); expect(state.jobs()).toEqual(original);
    const admitted = [{ ...original[0], id, prompt: unrelated.prompt }];
    expect(state.isReplay({ ...unrelated, delegationId: "late-provider-id" }, admitted)).toBe(true);
    expect(state.isReplay({ ...unrelated, prompt: unrelated.prompt + " tomorrow" }, admitted)).toBe(false);
    expect(state.isReplay(source, [])).toBe(true);
  });

  it("rejects a stale answer after Stop/reconnect even when a new call reuses its source key and count", () => {
    const state = setup(), source = turn();
    state.reserve(source, 3, "clarifying");
    const old = state.ask(source, "Which topics?", 3);
    state.reset();
    const next = { ...source, focusNoteId: "new-call-note", selection: undefined };
    state.reserve(next, 3, "clarifying");
    const fresh = state.ask(next, "Which topics?", 3), ids = state.jobs().map(job => job.id);
    expect(fresh.epoch).not.toBe(old.epoch);
    expect(state.handoff(turn(2), ids, old)).toBeUndefined();
    expect(state.jobs().map(job => job.id)).toEqual(ids); expect(state.clarification).toBe(fresh);
    expect(state.handoff(turn(2), ids, fresh)).toMatchObject({ focusNoteId: "new-call-note", selection: undefined });
  });

  it("requires an exact valid single reservation for a clarified one-worker handoff", () => {
    const state = setup(), source = turn();
    const question = state.ask(source, "Which assignment?", 1);
    expect(state.handoff(turn(2), ["invented"], question, true)).toBeUndefined();
    state.reserve(source, 2, "clarifying");
    expect(state.handoff(turn(2), [state.jobs()[0].id], state.clarification, true)).toBeUndefined();
    expect(state.jobs()).toHaveLength(2);
  });

  it("enforces the per-request guard without capping cumulative groups or erasing them when aliases rotate", () => {
    const state = setup();
    for (const count of [0, -1, 1.5, 1_001, Infinity, NaN]) expect(state.reserve(turn(), count, "routing")).toBe(false);
    for (let key = 1; key <= 45; key++) expect(state.reserve(turn(key), 24, "clarifying")).toBe(true);
    expect(state.jobs()).toHaveLength(1_080);
    expect(state.members(1)).toHaveLength(24); expect(state.turn(1)).toBeUndefined();
    expect(state.reserve(turn(46), 1_000, "routing")).toBe(true);
    expect(new Set(state.jobs().map(job => job.id)).size).toBe(2_080);
    expect(state.jobs(46)).toHaveLength(1_080);
  });

  it("cleans only finished routing reservations and preserves clarification until explicit call reset", () => {
    const state = setup();
    state.reserve(turn(1), 2, "routing"); state.reserve(turn(2), 3, "clarifying");
    state.ask(turn(2), "Choose topics", 3);
    state.finishRoute(1); state.finishRoute(2);
    expect(state.members(1)).toEqual([]); expect(state.members(2)).toHaveLength(3);
    state.markCancelled(10); state.clearPending();
    expect(state.jobs()).toEqual([]); expect(state.clarification).toBeUndefined();
    expect(state.turn(1)).toBeDefined(); expect(state.isCancelled(10)).toBe(true);
    state.reset(); expect(state.turn(1)).toBeUndefined(); expect(state.isCancelled(10)).toBe(false);
  });
});
