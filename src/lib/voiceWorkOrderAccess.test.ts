import { writeFileSync } from "node:fs";
import projectionContract from "./assistant/voiceWorkOrders.contract.json";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { VoiceResearch } from "./voiceResearch";
import { voiceWorkOrderDetail, type VoiceExternalAuthority, type VoiceWorkOrderDetail } from "./voiceWorkOrderAccess";
import { spaceNoteVersion } from "./spaceKnowledge";

function fixture() {
  const snapshot = createEmptySnapshot("Private Space", "2026-10-11", "space");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "n", title: "Exact 😀 title", slug: "n", body: "Alpha 😀 is supported.\n\n- [x] PRIVATE HISTORY EVENT",
    summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" }];
  return snapshot;
}
function reader(request: ChatRequest, reply = "A supported conclusion"): ChatResult {
  const context = JSON.parse(request.readingContext!);
  return context.evidence.length ? { reply: `${reply} [[${context.evidence[0].id}]].` }
    : { reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] };
}
function setup(driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => reader(request))) {
  const snapshot = fixture(), commit = vi.fn(async () => ({ savedNoteIds: ["saved"], savedTitles: ["Saved title"] })), deliver = vi.fn(), onResult = vi.fn();
  const engine = new VoiceResearch({ snapshot: () => snapshot, driver, commit, deliver, onResult, onProgress: vi.fn() });
  return { engine, snapshot, driver, commit, deliver, onResult };
}
const grant = (taskView: "working" | "history" = "working", grantId = "grant"): VoiceExternalAuthority => ({ grantId, taskView, assertCurrent: vi.fn(async () => {}) });
const settled = async (engine: VoiceResearch, id = "a") => vi.waitFor(() => expect(engine.inventory().find(job => job.id === id)?.state).not.toBe("running"));
const publicProse = (detail: VoiceWorkOrderDetail) => [detail.subject, ...[...(detail.result ? [detail.result] : []), ...detail.findings].flatMap(item => [
  ...item.text.fragments.map(part => part.text), ...item.evidence.flatMap(entry => [entry.title, entry.text])]),
  ...[...detail.decisions, ...detail.openQuestions].flatMap(item => item.fragments.map(part => part.text))].join("");

 describe("finite external voice work-order access", () => {
  it("projects lightweight public state without raw prompts, selections, progress errors or checkpoint discovery", async () => {
    const f = setup();
    await f.engine.run("a", "Research alpha with PRIVATE PROMPT", "PRIVATE CONVERSATION", "n");
    vi.spyOn(f.engine, "getJobs").mockImplementation(() => { throw new Error("No full-memory clone"); });
    const inventory = f.engine.inventory();
    expect(inventory[0]).toMatchObject({ id: "a", revision: 1, taskView: "working", current: true, stage: "completed" });
    const detail = f.engine.inspect("a", 1, { taskView: "working", maxChars: 200 });
    expect(detail).toMatchObject({ referenceOnly: true, result: { coverage: { openedNotes: 1 } } });
    expect(detail).not.toHaveProperty("prompt"); expect(detail).not.toHaveProperty("selection");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE CONVERSATION");
    expect(detail.completedOperations.every(operation => Object.keys(operation).every(key => ["kind", "entityId"].includes(key)))).toBe(true);
  });

  it("withholds all history-derived findings, even paraphrases, until explicit history is requested", async () => {
    const f = setup(vi.fn(async request => reader(request, "A paraphrase that omits the original checked text")));
    await f.engine.run("a", "Research completed task history", "", "n");
    expect(f.engine.inventory()[0]).toMatchObject({ subject: "History research", historyWithheld: true });
    const working = f.engine.inspect("a", 1, { taskView: "working", maxChars: 12000 });
    expect(working.withheld).toBe("history"); expect(working.result).toBeUndefined();
    expect(JSON.stringify(working)).not.toContain("paraphrase");
    const history = f.engine.inspect("a", 1, { taskView: "history", maxChars: 12000 });
    expect(publicProse(history)).toContain("paraphrase");
    expect(() => f.engine.steerExternal("a", 1, "Explore that further", grant())).toThrow("history");
    f.engine.steerExternal("a", 1, "Research alpha differently", grant());
    await settled(f.engine);
    const requests = f.driver.mock.calls.map(call => call[0]).filter(request => request.prompt === "Research alpha differently");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(JSON.stringify(request)).not.toContain("PRIVATE HISTORY EVENT");
    expect(f.engine.inventory()[0]).toMatchObject({ revision: 2, taskView: "working", historyWithheld: false });
  });

  it("bounds Unicode prose jointly and returns exact evidence fragments, with stale evidence withheld", async () => {
    const f = setup(vi.fn(async request => reader(request, "😀".repeat(300))));
    await f.engine.run("a", "Research alpha", "", "n");
    for (const maxChars of [1, 17, 75, 12000]) {
      const detail = f.engine.inspect("a", 1, { taskView: "working", maxChars });
      expect([...publicProse(detail)].length).toBeLessThanOrEqual(maxChars);
      expect(publicProse(detail)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      for (const evidence of detail.result?.evidence ?? []) expect(f.snapshot.notes[0].body.slice(evidence.start, evidence.end)).toBe(evidence.text);
    }
    f.snapshot.notes[0].body += " New fact.";
    expect(f.engine.inspect("a", 1, { taskView: "working", maxChars: 200 })).toMatchObject({ current: false, withheld: "stale", findings: [] });
    expect(() => f.engine.inspect("a", 1, { taskView: "working", maxChars: 12001 })).toThrow("12000");
  });

  it("withholds a generated stale subject when its formerly open task becomes completed", async () => {
    const f = setup();
    f.snapshot.notes[0].body = "- [ ] PRIVATE PLANNED ACTION";
    await f.engine.run("a", "Research open tasks", "", "n", null, false, undefined,
      { subject: "A private paraphrase of the planned action", focus: "Read the task" });
    expect(f.engine.inventory()[0].subject).toContain("private paraphrase");
    f.snapshot.notes[0].body = "- [x] PRIVATE PLANNED ACTION";
    expect(f.engine.inventory()[0]).toMatchObject({ subject: "Stale research", current: false, subjectTruncated: false });
    const detail = f.engine.inspect("a", 1, { taskView: "working", maxChars: 2000 });
    expect(detail.withheld).toBe("stale"); expect(JSON.stringify(detail)).not.toContain("private paraphrase");
  });

  it("uses compare-and-advance controls and terminal cancellation preserves completed results", async () => {
    const f = setup(); await f.engine.run("a", "Research alpha", "", "n");
    const before = f.engine.inspect("a", 1, { taskView: "working", maxChars: 200 });
    expect(f.engine.cancelVersion("a", 1)).toMatchObject({ changed: false, state: "completed", revision: 1 });
    expect(f.engine.inspect("a", 1, { taskView: "working", maxChars: 200 })).toEqual(before);
    expect(() => f.engine.retryExternal("a", 1, grant())).toThrow("failed or cancelled");
    expect(f.engine.steerExternal("a", 1, "Explore that further", grant())).toMatchObject({ changed: true, revision: 2, readOnly: true });
    expect(() => f.engine.cancelVersion("a", 1)).toThrow("current revision");
    expect(() => f.engine.steerExternal("a", 1, "Research a different fact", grant())).toThrow("current revision");
    await settled(f.engine);
  });

  it("never replays save/edit authority or speech when externally retrying an original save prompt", async () => {
    let fail = true;
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      if (fail) throw new Error("Provider unavailable");
      return { ...reader(request), noteActions: [{ title: "Unauthorized", body: "Do not save", summary: "", aliases: [], tags: [] }],
        editProposal: { spaceId: "space", noteId: "n", title: "Wrong", baseBody: "Alpha", edits: [{ before: "Alpha", after: "Bad" }] } };
    });
    const f = setup(driver), authority = grant();
    await f.engine.run("a", "Save a note about alpha", "PRIVATE CONVERSATION", "n");
    expect(f.engine.inventory()[0].state).toBe("failed"); f.deliver.mockClear(); f.onResult.mockClear();
    fail = false;
    f.engine.retryExternal("a", 1, authority); await settled(f.engine);
    const request = driver.mock.calls[driver.mock.calls.length - 1][0];
    expect(request).toMatchObject({ prompt: "Save a note about alpha", allowNoteActions: false });
    expect(request.editNoteId).toBeUndefined(); expect(JSON.stringify(request)).not.toContain("PRIVATE CONVERSATION");
    expect(f.commit).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled(); expect(f.onResult).not.toHaveBeenCalled();
    expect(f.engine.getJobs()[0].result).not.toHaveProperty("editProposal");
    expect(f.engine.getJobs()[0].result?.noteActions).toBeUndefined();
    expect(authority.assertCurrent).toHaveBeenCalled();
    f.engine.cancel("a"); await f.engine.retry("a", "");
    expect(f.commit).not.toHaveBeenCalled();
    expect(driver.mock.calls[driver.mock.calls.length - 1][0].allowNoteActions).toBe(false);
  });

  it("rechecks grants before each provider call and rejects a result arriving after revocation", async () => {
    let revoke = false, resolve!: (result: ChatResult) => void;
    const f = setup(vi.fn((_request: ChatRequest) => new Promise<ChatResult>(done => { resolve = done; })));
    const authority: VoiceExternalAuthority = { grantId: "g", taskView: "working", assertCurrent: vi.fn(async () => { if (revoke) throw new Error("Grant revoked"); }) };
    f.engine.admitExternalReserved("a", "Research alpha", { focusNoteId: "n" }, authority);
    await vi.waitFor(() => expect(f.driver).toHaveBeenCalledOnce());
    revoke = true; resolve({ reply: "Forbidden late result" }); await settled(f.engine);
    expect(f.engine.inventory()[0].state).toBe("failed"); expect(f.engine.getJobs()[0].result).toBeUndefined();
    expect(f.onResult).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
    expect(authority.assertCurrent).toHaveBeenCalledTimes(3); // admission, before call, after transport
  });

  it("revokes only matching external revisions and frees a hung authorization without starting a provider", async () => {
    const f = setup();
    const blocked = grant("working", "blocked"); blocked.assertCurrent = () => new Promise(() => {});
    f.engine.admitExternalReserved("a", "Research alpha", { focusNoteId: "n" }, blocked);
    f.engine.admitExternalReserved("b", "Research beta", { focusNoteId: "n" }, grant("working", "other"));
    const local = f.engine.run("local", "Research local", "", "n");
    f.engine.cancelExternal("blocked");
    await local; await settled(f.engine, "b");
    expect(f.engine.inventory().map(job => [job.id, job.state])).toEqual([["a", "cancelled"], ["b", "completed"], ["local", "completed"]]);
    expect(f.driver.mock.calls.every(call => call[0].prompt !== "Research alpha")).toBe(true);
    expect(() => f.engine.admitExternalReserved("a", "Research something", {}, grant())).toThrow("no longer available");
  });

  it("keeps the original exact binding and current checkpoint only for continuation, not a changed scope", async () => {
    const f = setup();
    const selection = { id: "selection", spaceId: "space", noteId: "n", noteTitle: "Exact 😀 title", version: spaceNoteVersion(f.snapshot.notes[0]),
      text: "Alpha 😀", range: { from: 0, to: 8, unit: "dom-text-utf16" as const }, hiddenTaskRanges: [] };
    await f.engine.run("a", "Research alpha", "", "n", null, false, selection, { subject: "Alpha", focus: "Research this part" });
    let before = f.driver.mock.calls.length;
    f.engine.steerExternal("a", 1, "Explore that further", grant()); await settled(f.engine);
    expect(f.driver.mock.calls.length - before).toBe(1);
    const continued = f.driver.mock.calls[before][0];
    expect(JSON.stringify(continued.history)).toContain("completed_worker_reference");
    expect(JSON.stringify(continued.history)).toContain("Alpha 😀");
    expect(f.engine.getJobs()[0]).toMatchObject({ focusNoteId: "n", selection });
    before = f.driver.mock.calls.length;
    f.engine.steerExternal("a", 2, "Investigate another interpretation", grant()); await settled(f.engine);
    expect(f.driver.mock.calls.length - before).toBe(2);
    expect(JSON.stringify(f.driver.mock.calls[before][0].history)).not.toContain("completed_worker_reference");
    expect(f.engine.getJobs()[0].assignment).toBeUndefined();
    expect(f.engine.getJobs()[0]).toMatchObject({ focusNoteId: "n", selection });
  });

  it("publishes bounded public checkpoints without raw discovery or pending query payloads", async () => {
    let reads = 0;
    const f = setup(vi.fn(async request => {
      const context = JSON.parse(request.readingContext!);
      if (!context.evidence.length) return reader(request);
      if (reads++ < 2) return { reply: "", checkpoint: { finding: `Finding ${reads} [[${context.evidence[0].id}]].`,
        decisions: ["Use the supported distinction"], openQuestions: ["What remains uncertain?"] },
        readRequests: [{ kind: "related" as const, id: "n", query: "PRIVATE QUERY", start: reads - 1 }] };
      return reader(request);
    }));
    f.engine.admitExternalReserved("a", "Research alpha", { focusNoteId: "n" }, grant()); await settled(f.engine);
    const detail = f.engine.inspect("a", 1, { taskView: "working", maxChars: 2000 });
    expect(detail.findings.map(item => item.sequence)).toEqual([1, 2]);
    expect(detail.decisions.length).toBeGreaterThan(0);
    expect(detail.completedOperations.some(item => item.kind === "related")).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE QUERY");
    expect(detail).not.toHaveProperty("discovered");
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("preserves an exact multiline direction accepted by the shared native contract", async () => {
    const f = setup(); await f.engine.run("a", "Research alpha", "", "n");
    const direction = "Investigate alpha\nThen compare beta\tcarefully.";
    f.engine.steerExternal("a", 1, direction, grant()); await settled(f.engine);
    expect(f.driver.mock.calls.slice(-2).every(call => call[0].prompt === direction)).toBe(true);
    expect(() => f.engine.steerExternal("a", 2, "Bad\u0000direction", grant())).toThrow("control");
  });

  it("retains history provenance across a local continuation rather than revealing a generated paraphrase", async () => {
    const f = setup();
    await f.engine.run("a", "Research completed task history", "", "n");
    await f.engine.run("a", "Follow that please", "A paraphrase of that history", "n");
    expect(f.engine.inspect("a", 2, { taskView: "working", maxChars: 2000 })).toMatchObject({ withheld: "history", historyWithheld: true });
    f.engine.cancel("a");
    expect(() => f.engine.retryExternal("a", 2, grant())).toThrow("history");
  });

  it("fences a superseded revision after an in-flight authorization resolves", async () => {
    const f = setup(); let authorize!: () => void;
    const old = grant("working", "old"); old.assertCurrent = () => new Promise<void>(resolve => { authorize = resolve; });
    f.engine.admitExternalReserved("a", "Research original", {}, old);
    await vi.waitFor(() => expect(authorize).toBeDefined());
    f.engine.steerExternal("a", 1, "Research replacement", grant("working", "new"));
    authorize(); await settled(f.engine);
    expect(f.engine.externalIsRunning("old", "a", 1)).toBe(false);
    expect(f.driver.mock.calls.every(call => call[0].prompt === "Research replacement")).toBe(true);
    expect(f.engine.inventory()[0]).toMatchObject({ revision: 2, state: "completed" });
  });

  it("provides an actual-engine supplementary-Unicode projection fixture for the native validator", async () => {
    const f = setup(vi.fn(async request => reader(request, "😀 A finding with exact evidence. ".repeat(15))));
    await f.engine.run("a", "Research alpha 😀", "", "n");
    const summary = f.engine.inventory()[0];
    const detail = f.engine.inspect("a", 1, { taskView: "working", maxChars: 700 });
    const smallest = f.engine.inspect("a", 1, { taskView: "working", maxChars: 1 });
    const short = f.engine.inspect("a", 1, { taskView: "working", maxChars: 17 });
    expect(detail.result?.evidence[0].title).toBe("Exact 😀 title");
    expect([...publicProse(detail)].length).toBeLessThanOrEqual(700);
    await f.engine.run("history", "Research completed task history", "", "n");
    const history = f.engine.inspect("history", 1, { taskView: "history", maxChars: 700 });
    const withheldHistory = f.engine.inspect("history", 1, { taskView: "working", maxChars: 700 });
    f.snapshot.notes[0].body += " A new version.";
    const stale = f.engine.inspect("a", 1, { taskView: "working", maxChars: 700 });
    expect(stale.withheld).toBe("stale"); expect(withheldHistory.withheld).toBe("history");
    const cases = [[detail, "working", "a", 700], [history, "history", "history", 700], [withheldHistory, "working", "history", 700],
      [stale, "working", "a", 700], [smallest, "working", "a", 1], [short, "working", "a", 17]] as const;
    const actual = cases.map(([workOrder, taskView, id, maxChars]) => ({ request: { operation: "get", space_id: "space", voice_target_id: "target",
      work_order_id: id, expected_revision: 1, task_view: taskView, max_chars: maxChars }, result: { spaceId: "space", voiceTargetId: "target", taskView,
      workOrder: { ...workOrder, controlVersion: "control" } } }));
    const path = process.env.ORION_VOICE_PUBLIC_FIXTURE_OUT;
    if (path) writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
    expect(actual).toEqual(projectionContract.filter(item => item.request.operation === "get"));
    expect(summary).not.toHaveProperty("prompt");
  });

  it("rejects an expired grant before any provider dispatch and accepts independent reserved identities", async () => {
    const f = setup(), authority = grant(); authority.assertCurrent = vi.fn(async () => { throw new Error("Expired grant"); });
    expect(f.engine.admitExternalReserved("a", "Research alpha", {}, authority)).toMatchObject({ revision: 1, action: "steer", readOnly: true });
    await settled(f.engine); expect(f.driver).not.toHaveBeenCalled();
    expect(() => f.engine.steerExternal("a", 1, "😀".repeat(2001), grant())).toThrow("2000");
    expect(() => voiceWorkOrderDetail(f.engine.getJobs()[0], undefined, { taskView: "working", maxChars: 0, current: true })).toThrow();
  });
});
