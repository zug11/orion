// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { VoiceWorkOrder } from "../lib/voiceResearch";
import { SpaceVoice } from "./SpaceVoice";
import type { VoiceConstellationProps } from "./VoiceConstellation";
import { createVoiceSelectionStore } from "../lib/voiceSelection";
import { spaceNoteVersion } from "../lib/spaceKnowledge";
import { createVoicePresence } from "../lib/voicePresence";
import { voiceWorkOrderSummary } from "../lib/voiceWorkOrderAccess";
import type { VoiceWorkOrderHost } from "../lib/assistant/voiceWorkOrderHost";
import { explicitVoiceAssignment } from "../lib/voiceWorkOrders";
import { voiceFindingDelivery } from "../lib/voiceFindingDelivery";

const mock = vi.hoisted(() => ({
  options: undefined as any, engine: undefined as any, connections: [] as any[], jobs: [] as any[],
  run: vi.fn(), retry: vi.fn(), cancel: vi.fn(), dispose: vi.fn(), keep: vi.fn(), announce: vi.fn(), finding: vi.fn(), route: vi.fn(),
  close: vi.fn(), append: vi.fn(), context: vi.fn(), current: vi.fn(),
  editDriver: vi.fn(),
  native: false, mailboxes: [] as { host: VoiceWorkOrderHost; dispose: ReturnType<typeof vi.fn> }[],
}));
vi.mock("../lib/storage", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/storage")>(), isTauriRuntime: () => mock.native, chatWithOrion: mock.editDriver,
}));
vi.mock("../lib/assistant/voiceWorkOrders", () => ({ startVoiceWorkOrderMailbox: (host: VoiceWorkOrderHost) => {
  const mailbox = { host, dispose: vi.fn() }; mock.mailboxes.push(mailbox); return mailbox;
} }));
vi.mock("./VoiceConstellation", () => ({ VoiceConstellation: (props: VoiceConstellationProps) => <div data-testid={`orbs-${props.size}`} data-dismissed={props.dismissedJobIds?.join(",")}>
  <button onClick={() => props.onFocus(undefined)}>Focus main conversation</button>
  {props.jobs.map(job => <button key={job.id} onClick={() => props.onDismiss(job.id)}>Dismiss orb: {job.subject}</button>)}
</div> }));
vi.mock("../lib/liveVoice", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/liveVoice")>(), LiveVoiceConnection: class {
  options: any;
  constructor(options: unknown) { this.options = options; mock.options = options; mock.connections.push(this); }
  start() { this.options.onStatus("listening"); return Promise.resolve(); }
  close() { mock.close(); this.options.onStatus("idle"); }
  mute = vi.fn(); dispose = vi.fn(); append = (...args: unknown[]) => mock.append(...args);
} }));
vi.mock("../lib/voiceResearch", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/voiceResearch")>(), VoiceResearch: class {
    constructor(options: unknown) { mock.engine = options; }
    run = mock.run; retry = mock.retry; cancel = mock.cancel; dispose = mock.dispose; keep = mock.keep;
    announceResult = mock.announce; announceFinding = mock.finding; context = mock.context;
    getJobs() { return mock.jobs.map(job => ({ ...job })); }
    inventory(taskView: "working" | "history" = "working") { return mock.jobs.map(job => voiceWorkOrderSummary(job, taskView, true)); }
    getReceipts() { return mock.jobs.filter(job => job.receipt).map(job => ({ id: job.id, revision: job.revision, prompt: job.prompt, receipt: job.receipt })); }
    isCurrent = mock.current;
    isCurrentFinding = mock.current;
  },
}));
vi.mock("../lib/voiceWorkOrders", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/voiceWorkOrders")>(), routeVoiceTurn: mock.route,
}));
beforeEach(() => {
  vi.useFakeTimers(); mock.jobs = []; mock.connections = [];
  mock.native = false; mock.mailboxes = [];
  mock.append.mockReset().mockReturnValue(true);
  mock.editDriver.mockReset().mockImplementation(async request => request.mode === "voice-synthesis"
    ? { reply: "", synthesis: { reply: "A combined finding with its caveats.", included: JSON.parse(request.synthesisContext).findings.map((f: any) => f.key), deferred: [] } }
    : { reply: "No edit was requested.", readRequests: [], editIntent: "none" });
  mock.context.mockReset().mockImplementation(() => JSON.stringify({ jobs: mock.jobs }));
  mock.current.mockReset().mockImplementation((id, revision) => mock.jobs.some(job => job.id === id && job.revision === revision && job.state !== "cancelled" && job.state !== "failed"));
  mock.route.mockReset().mockImplementation(async input => input.delegated || explicitVoiceAssignment(input.prompt) ? { action: "new", prompt: input.prompt } : { action: "conversation" });
  mock.run.mockReset().mockImplementation((id, prompt, _conversation, focusNoteId, _delegation, _retry, _selection, assignment) => {
    const previous = mock.jobs.find(job => job.id === id);
    mock.jobs = [...mock.jobs.filter(job => job.id !== id), { id, prompt, subject: assignment?.subject ?? prompt, focusNoteId, revision: (previous?.revision ?? 0) + 1, state: "running", progress: "Researching" }];
    mock.engine.onJobs(mock.jobs.map(job => ({ ...job }))); return Promise.resolve();
  });
  mock.cancel.mockReset().mockImplementation(id => {
    mock.jobs = mock.jobs.map(job => !id || job.id === id ? { ...job, state: "cancelled" } : job);
    mock.engine.onJobs(mock.jobs.map(job => ({ ...job })));
  });
  mock.keep.mockReset().mockResolvedValue(undefined);
  mock.retry.mockReset().mockResolvedValue(undefined);
  mock.close.mockClear(); mock.dispose.mockClear(); mock.announce.mockClear(); mock.finding.mockClear();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });
function setup() {
  const snapshot = createEmptySnapshot("Research", "2026-10-09", "a"); snapshot.settings.apiKeyConfigured = true;
  const props = { snapshot, enabled: true, toggleRequest: 1, commit: vi.fn(), onProposal: vi.fn(), onOpenNote: vi.fn(), onOpenSettings: vi.fn() };
  return { props, ...render(<SpaceVoice {...props} />) };
}
function event(value: unknown, connection = mock.options) { act(() => connection.onEvent(value)); }
function speak(text: string, start = 0, delegation?: string) {
  event({ type: "session.input_transcript.delta", event_id: crypto.randomUUID(), delta: text, start_ms: start, end_ms: start + 200 });
  if (delegation) event({ type: "session.delegation.created", delegation: { id: delegation, target: "client" }, offset_ms: start + 200 });
}
async function settle(ms = 1_000) { await act(() => vi.advanceTimersByTimeAsync(ms)); }
function publish(jobs: VoiceWorkOrder[]) { act(() => { mock.jobs = jobs; mock.engine.onJobs(jobs); }); }
function finished(id = "climate", subject = "Climate", revision = 1): VoiceWorkOrder {
  return { id, subject, revision, prompt: `Research ${subject}`, state: "completed", progress: "", result: { reply: `${subject} finding.` } };
}
function commentary() { return mock.append.mock.calls.filter(call => call[0] === "commentary"); }
function backgroundFinding(job: VoiceWorkOrder, spaceId: string, sequence = 1, delegationId: string | null = null) {
  const delivery = voiceFindingDelivery({ id: job.id, spaceId, revision: job.revision, sequence, subject: job.subject, state: job.state === "completed" ? "completed" : "running", result: job.result! });
  mock.engine.deliver("commentary", delivery.commentary, delegationId, { id: job.id, revision: job.revision, sequence, reference: delivery.quiet, background: true, completion: delivery.completion });
}
const synthesized = () => mock.append.mock.calls.filter(call => call[0] === "thinking" && String(call[1]).includes('"type":"consolidated_worker_finding"'));

describe("Space voice work-order integration", () => {
  it("prepares related findings during speech without injecting job context or worker packets into the unfinished response", async () => {
    const { props } = setup();
    event({ type: "session.output_transcript.delta", delta: "The important distinction is", start_ms: 0, end_ms: 600 });
    act(() => mock.options.onActivity({ inputActive: false, outputActive: true, measured: true }));
    mock.append.mockClear();
    const jobs = [finished("one", "Narrator"), finished("two", "Memory")]; publish(jobs);
    act(() => jobs.forEach(job => backgroundFinding(job, props.snapshot.workspace.id)));
    await settle(2_000);
    expect(mock.editDriver).toHaveBeenCalledOnce();
    expect(mock.editDriver.mock.calls[0][0].mode).toBe("voice-synthesis");
    expect(mock.append).not.toHaveBeenCalled();
    act(() => mock.options.onActivity({ inputActive: false, outputActive: false, measured: true }));
    await settle(4_000); expect(mock.append).not.toHaveBeenCalled();
    event({ type: "session.output_transcript.delta", delta: " how memory affects the narrator.", start_ms: 6_000, end_ms: 6_800 });
    await settle(2_500); expect(synthesized()).toHaveLength(0);
    await settle(500);
    expect(synthesized()).toHaveLength(1);
    expect(JSON.parse(synthesized()[0][1]).findings.map((f: any) => f.id)).toEqual(["one", "two"]);
    expect(mock.append.mock.calls.filter(([kind]) => kind === "instructions")).toHaveLength(0);
    expect(mock.append.mock.calls.some(([, text]) => String(text).includes('"type":"worker_finding"'))).toBe(false);
    expect(commentary()).toEqual([["commentary", "A combined finding with its caveats.", null]]);
  });
  it("keeps a failed synthesis actionable without hiding the research or automatically retrying", async () => {
    const { props } = setup(); const job = finished(); publish([job]);
    mock.editDriver.mockRejectedValueOnce(new Error("Provider unavailable"));
    act(() => backgroundFinding(job, props.snapshot.workspace.id));
    await settle(2_000);
    expect(screen.getByText("Voice summary unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Research & references" }));
    expect(screen.getByText("Climate finding.")).toBeInTheDocument();
    await settle(60_000); expect(mock.editDriver).toHaveBeenCalledOnce(); expect(synthesized()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry voice summary" }));
    await settle(1_000);
    expect(mock.editDriver).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Shared with voice")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry voice summary" })).toBeNull();
  });
  it("delivers the actual summary after a missing final transcript delta, keeping the current task's delegation and retrying the pair", async () => {
    const { props } = setup(); speak("Research climate", 0, "current-task"); await settle();
    const job = finished(mock.jobs[0].id);
    event({ type: "session.output_transcript.delta", delta: "I'm still thinking about what you said", start_ms: 1_000, end_ms: 1_500 });
    act(() => mock.options.onActivity({ inputActive: false, outputActive: true, measured: true }));
    publish([job]); act(() => backgroundFinding(job, props.snapshot.workspace.id, 1, "current-task"));
    await settle(2_000);
    mock.append.mockClear();
    act(() => mock.options.onActivity({ inputActive: false, outputActive: false, measured: true }));
    await settle(7_500); expect(mock.append).not.toHaveBeenCalled();
    let rejectCommentary = true;
    mock.append.mockImplementation(kind => {
      if (kind === "commentary" && rejectCommentary) return false;
      return true;
    });
    // Pending job context, exact reference, and then a rejected commentary.
    await settle(1_500); expect(screen.getByText("Waiting for a pause")).toBeInTheDocument();
    const rejectedOffers = commentary().length; expect(rejectedOffers).toBeGreaterThan(0);
    rejectCommentary = false;
    await settle(500);
    expect(synthesized()).toHaveLength(rejectedOffers + 1);
    expect(commentary()).toEqual(Array.from({ length: rejectedOffers + 1 }, () => ["commentary", "A combined finding with its caveats.", "current-task"]));
    expect(synthesized().every(call => call[2] === "current-task")).toBe(true);
    expect(mock.append.mock.calls.filter(([kind]) => kind === "instructions")).toHaveLength(0);
    expect(mock.editDriver).toHaveBeenCalledOnce();
    expect(screen.getByText("Shared with voice")).toBeInTheDocument();
    await settle(20_000); expect(commentary()).toHaveLength(rejectedOffers + 1);
  });
  it("keeps all 24 ready results reachable and distinguishes queued findings from offers to voice", async () => {
    const { props } = setup();
    const jobs = Array.from({ length: 24 }, (_, i) => finished(`job-${i}`, `Investigation ${i}`)); publish(jobs);
    expect(screen.getAllByRole("button", { name: "Research & references" })).toHaveLength(24);
    expect(screen.getAllByText("Ready in work summary")).toHaveLength(24);
    event({ type: "session.input_transcript.delta", delta: "I was thinking", start_ms: 0, end_ms: 400 });
    act(() => { for (const job of jobs) backgroundFinding(job, props.snapshot.workspace.id); });
    await settle(2_000);
    expect(screen.getAllByText("Combining findings")).toHaveLength(24);
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.route).not.toHaveBeenCalled();
    await settle(2_000);
    expect(screen.getAllByText("Shared with voice")).toHaveLength(4);
    expect(screen.getAllByText(/Waiting for a pause|Combining findings/)).toHaveLength(20);
    const batches = synthesized();
    expect(batches).toHaveLength(1); expect(JSON.parse(batches[0][1]).findings).toHaveLength(4);
    expect(commentary()).toEqual([["commentary", "A combined finding with its caveats.", null]]);
    fireEvent.click(screen.getAllByRole("button", { name: "Read aloud" })[23]);
    expect(mock.announce).toHaveBeenCalledWith("job-23");
  });
  it("waits for a paused incomplete request and keeps the original note for its continuation", async () => {
    const { props, rerender } = setup();
    rerender(<SpaceVoice {...props} focusNoteId="original-note" />);
    speak("Research the relationship between", 0);
    await settle(4_000); expect(mock.run).not.toHaveBeenCalled(); expect(mock.route).not.toHaveBeenCalled();
    rerender(<SpaceVoice {...props} focusNoteId="later-note" />);
    speak("the narrator and the setting", 4_000); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0][1]).toBe("Research the relationship between the narrator and the setting");
    expect(mock.run.mock.calls[0][3]).toBe("original-note");
  });
  it("welcomes only a fresh main conversation, never on navigation, reconnect, or worker handoff", async () => {
    const initial = setup(), props = { ...initial.props, floating: true }, { rerender } = initial;
    rerender(<SpaceVoice {...props} />);
    const openings = () => mock.append.mock.calls.filter(call => call[0] === "instructions" && String(call[1]).includes("One-time opening"));
    await settle(1_500); expect(openings()).toEqual([]);
    rerender(<SpaceVoice {...props} focusNoteId="another-note" />);
    await settle(500); expect(openings()).toHaveLength(1);
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.route).not.toHaveBeenCalled();
    rerender(<SpaceVoice {...props} toggleRequest={2} />);
    rerender(<SpaceVoice {...props} toggleRequest={3} />);
    await settle(3_000); expect(openings()).toHaveLength(1);
    publish([finished()]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to worker" }));
    await settle(3_000); expect(openings()).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId("orbs-pill")).getByRole("button", { name: "Focus main conversation" }));
    await settle(3_000); expect(openings()).toHaveLength(1);
  });
  it("confirms clearing the voice chat, ends audio, removes transient work, and starts fresh only on request", async () => {
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} floating />);
    speak("My earlier private idea"); await settle();
    publish([finished(), { ...finished("running"), state: "running", result: undefined }]);
    const oldConnection = mock.options, oldEngine = mock.engine;
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 working.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear voice chat…" }));
    expect(presence.getSnapshot().jobs).toHaveLength(2); expect(mock.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep voice chat" }));
    expect(presence.getSnapshot().jobs).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Clear voice chat…" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear voice chat" }));
    expect(mock.close).toHaveBeenCalledOnce(); expect(mock.dispose).toHaveBeenCalled();
    expect(presence.getSnapshot()).toMatchObject({ status: "idle", jobs: [], focusedJobId: undefined });
    expect(props.commit).not.toHaveBeenCalled(); expect(props.onProposal).not.toHaveBeenCalled();
    event({ type: "session.input_transcript.delta", delta: "A late request", start_ms: 2_000, end_ms: 2_500 }, oldConnection);
    act(() => { oldEngine.onJobs([finished("late")]); oldEngine.deliver("commentary", "Late finding", null); });
    await settle(2_000); expect(presence.getSnapshot().jobs).toEqual([]);
    expect(mock.connections).toHaveLength(1);
    mock.jobs = []; rerender(<SpaceVoice {...props} presence={presence} floating toggleRequest={2} />);
    expect(mock.connections).toHaveLength(2);
    expect(mock.connections[1].options.context).not.toContain("My earlier private idea");
    expect(mock.connections[1].options.context).not.toContain("Climate finding");
  });
  it("opens a real note proposal from speech without reserving workers or using the research router", async () => {
    const { props, rerender } = setup();
    props.snapshot.notes = [{ id: "draft", title: "Draft", slug: "draft", body: "An awkward sentence.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: "now", updatedAt: "now" }];
    mock.editDriver.mockResolvedValue({ reply: "Review the change.", readRequests: [], editIntent: "focused", noteEdits: [{ before: "An awkward sentence.", after: "A clearer sentence." }] });
    const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} focusNoteId="draft" presence={presence} floating />);
    speak("Make this sentence clearer", 0); await settle(2_000);
    expect(props.onProposal).toHaveBeenCalledWith(expect.objectContaining({ editProposal: expect.objectContaining({ noteId: "draft", baseBody: "An awkward sentence.", edits: [{ before: "An awkward sentence.", after: "A clearer sentence." }] }) }));
    expect(mock.editDriver).toHaveBeenCalledOnce();
    expect(mock.route).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
    expect(presence.getSnapshot().jobs).toEqual([]); expect(props.commit).not.toHaveBeenCalled();
    event({ type: "session.delegation.created", delegation: { id: "late-edit", target: "client" }, offset_ms: 100 });
    await settle(); expect(mock.editDriver).toHaveBeenCalledOnce();
    expect(props.snapshot.notes[0].body).toBe("An awkward sentence.");
  });
  it("shows a rejected note-review handoff instead of silently losing the proposal", async () => {
    const { props } = setup();
    props.onProposal.mockRejectedValueOnce(new Error("Finish the current writing operation first."));
    act(() => mock.engine.onResult({ reply: "Review changes.", editProposal: { noteId: "draft", title: "Draft" } }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Finish the current writing operation first.");
  });
  it("uses the real router for four all-notes workers, keeps all four visible, and ignores a late delegation", async () => {
    const { routeVoiceTurn } = await vi.importActual<typeof import("../lib/voiceWorkOrders")>("../lib/voiceWorkOrders");
    mock.route.mockImplementation(routeVoiceTurn);
    const { props, rerender } = setup(), presence = createVoicePresence();
    props.snapshot.notes = Array.from({ length: 9 }, (_, i) => ({ id: `note-${i}`, title: `Note ${i}`, body: `Passage ${i}`, summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", slug: `note-${i}`, createdAt: "2026-10-11", updatedAt: "2026-10-11" }));
    rerender(<SpaceVoice {...props} presence={presence} />);
    speak("spawn 4 workers to read across all the notes"); await settle();
    expect(mock.run).toHaveBeenCalledTimes(4);
    const ids = presence.getSnapshot().jobs.map(job => job.id);
    expect(new Set(ids).size).toBe(4);
    expect(mock.run.mock.calls.flatMap(call => call[7].noteIds)).toEqual(props.snapshot.notes.map(note => note.id));
    expect(commentary()).toEqual([]);
    speak("That is interesting", 2_500); await settle();
    event({ type: "session.delegation.created", delegation: { id: "late-four" }, offset_ms: 200 }); await settle();
    expect(mock.run).toHaveBeenCalledTimes(4);
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual(ids);
    expect(props.commit).not.toHaveBeenCalled(); expect(props.onProposal).not.toHaveBeenCalled();
  });
  it("registers one native worker owner through note navigation without starting audio and withdraws on Space change", () => {
    mock.native = true;
    const snapshot = createEmptySnapshot("Research", "2026-10-11", "a"); snapshot.settings.apiKeyConfigured = true;
    const props = { snapshot, enabled: true, commit: vi.fn(), onProposal: vi.fn(), onOpenNote: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender, unmount } = render(<SpaceVoice {...props} focusNoteId="first" />);
    expect(mock.mailboxes).toHaveLength(1); expect(mock.mailboxes[0].host.spaceId).toBe("a");
    rerender(<SpaceVoice {...props} focusNoteId="second" chatVisible />);
    expect(mock.mailboxes).toHaveLength(1); expect(mock.connections).toEqual([]);
    const next = { ...snapshot, workspace: { ...snapshot.workspace, id: "b" } };
    rerender(<SpaceVoice {...props} snapshot={next} />);
    expect(mock.mailboxes).toHaveLength(2); expect(mock.mailboxes[0].dispose).toHaveBeenCalledOnce();
    expect(mock.mailboxes[1].host.spaceId).toBe("b"); expect(mock.connections).toEqual([]);
    unmount(); expect(mock.mailboxes[1].dispose).toHaveBeenCalledOnce();
  });
  it("an external cancellation removes one waiting orb and invalidates its late batch without changing the call", async () => {
    mock.native = true;
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "Which topics?", workerCount: 3 });
    speak("Spawn three orbs", 0); await settle();
    const ids = presence.getSnapshot().jobs.map(job => job.id), host = mock.mailboxes[0].host;
    let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("Plot, history and characters", 2_500); await settle();
    const job = host.inventory().find(job => job.id === ids[1])!;
    act(() => host.prepare({ operation: "control", space_id: "a", voice_target_id: "target", work_order_id: job.id,
      expected_revision: job.revision, expected_control_version: job.controlVersion, request_id: "external-cancel", action: "cancel", task_view: "working" }).execute());
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual([ids[0], ids[2]]);
    await act(async () => resolve({ action: "batch", prompt: "Plot, history and characters", assignments: [
      { subject: "Plot", focus: "Read plot" }, { subject: "History", focus: "Read history" }, { subject: "Characters", focus: "Read characters" },
    ] })); await settle();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.connections).toHaveLength(1); expect(mock.close).not.toHaveBeenCalled();
    expect(props.onProposal).not.toHaveBeenCalled(); expect(props.commit).not.toHaveBeenCalled();
  });
  it("preserves sibling findings across a worker conversation and pairs each source packet on the new call", async () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    publish([finished(), finished("astronomy", "Astronomy"), finished("history", "History")]);
    event({ type: "session.delegation.created", delegation: { id: "old-call" }, offset_ms: 200 });
    act(() => mock.engine.deliver("commentary", "Astronomy finding", "old-call", { id: "astronomy", revision: 1, reference: "Astronomy exact sources" }));
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*3 ready/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    act(() => mock.engine.deliver("commentary", "History finding", "old-call", { id: "history", revision: 1, reference: "History exact sources" }));
    await settle(15_000);
    expect(commentary()).toEqual([]);
    expect(mock.connections).toHaveLength(2);
    fireEvent.click(within(screen.getByTestId("orbs-pill")).getByRole("button", { name: "Focus main conversation" }));
    await settle(4_000);
    expect(mock.connections).toHaveLength(3);
    expect(commentary()).toEqual([["commentary", "Astronomy finding", null], ["commentary", "History finding", null]]);
    const packets = mock.append.mock.calls;
    for (const name of ["Astronomy", "History"]) {
      const index = packets.findIndex(call => call[0] === "commentary" && call[1] === `${name} finding`);
      expect(packets[index - 1]).toEqual(["thinking", `${name} exact sources`, null]);
    }
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.cancel).not.toHaveBeenCalled();
  });
  it.each(["active", "stopped", "disconnected"] as const)("clears an outdated worker on note change without reacquiring a %s call", async state => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} />);
    speak("Keep the original question in mind."); await settle();
    publish([finished()]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to worker" }));
    expect(presence.getSnapshot().focusedJobId).toBe("climate");
    const toggleRequest = state === "stopped" ? 2 : 1;
    if (state === "stopped") rerender(<SpaceVoice {...props} floating presence={presence} toggleRequest={toggleRequest} />);
    if (state === "disconnected") act(() => mock.options.onStatus("disconnected", "Capture ended"));
    mock.current.mockReturnValue(false);
    rerender(<SpaceVoice {...props} floating presence={presence} toggleRequest={toggleRequest} snapshot={{ ...props.snapshot, updatedAt: "2026-10-11T12:00:00Z" }} />);
    await settle();
    expect(presence.getSnapshot().focusedJobId).toBeUndefined();
    expect(mock.connections).toHaveLength(state === "active" ? 3 : 2);
    if (state === "active") expect(mock.connections[2].options.context).toContain("Keep the original question in mind.");
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("returns from an evicted worker while preserving a sibling's queued finding", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} />);
    publish([finished(), finished("astronomy", "Astronomy")]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*2 ready/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    act(() => mock.engine.deliver("commentary", "Astronomy finding", null, { id: "astronomy", revision: 1, reference: "Astronomy sources" }));
    publish([finished("astronomy", "Astronomy")]); await settle(2_000);
    expect(presence.getSnapshot().focusedJobId).toBeUndefined();
    expect(mock.connections).toHaveLength(3);
    expect(commentary()).toEqual([["commentary", "Astronomy finding", null]]);
  });
  it("hands back when a focused result advances directly to another completed revision", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} />);
    publish([finished()]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to worker" }));
    const oldConnection = mock.options;
    // The engine's local note-access answer can complete before its batched
    // publication exposes the intermediate running state.
    publish([finished("climate", "Climate", 2)]); await settle();
    expect(presence.getSnapshot().focusedJobId).toBeUndefined();
    expect(mock.connections).toHaveLength(3);
    event({ type: "session.input_transcript.delta", delta: "Follow that distinction", start_ms: 0, end_ms: 200 }, oldConnection);
    event({ type: "session.delegation.created", delegation: { id: "old-recipient" }, offset_ms: 200 }, oldConnection);
    await settle();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("dismissing the selected worker after Stop does not start another call", () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} />);
    publish([finished()]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to worker" }));
    rerender(<SpaceVoice {...props} floating presence={presence} toggleRequest={2} />);
    fireEvent.click(within(screen.getByTestId("orbs-pill")).getByRole("button", { name: "Dismiss orb: Climate" }));
    expect(presence.getSnapshot().focusedJobId).toBeUndefined();
    expect(mock.connections).toHaveLength(2); expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("continues the selected finished child among siblings with its original scope and selection, then restores main conversation", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} focusNoteId="other-note" />);
    speak("Let's keep our initial theory in mind."); await settle();
    const child: VoiceWorkOrder = { ...finished(), focusNoteId: "original-note",
      assignment: { subject: "Climate", focus: "Investigate the historical climate evidence." },
      selection: { id: "original-passage", spaceId: "a", noteId: "original-note", noteTitle: "Climate draft", version: "v1", range: { from: 0, to: 16, unit: "dom-text-utf16" }, text: "A climate claim.", hiddenTaskRanges: [] } };
    publish([child, finished("astronomy", "Astronomy")]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*2 ready/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    expect(presence.getSnapshot().focusedJobId).toBe("climate");
    speak("Follow that distinction"); await settle();
    expect(mock.run).toHaveBeenCalledExactlyOnceWith("climate", "Follow that distinction", expect.any(String), "original-note", null, false, child.selection, child.assignment);
    expect(mock.jobs.find(job => job.id === "astronomy")).toMatchObject({ state: "completed", revision: 1 });
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(presence.getSnapshot().focusedJobId).toBeUndefined();
    expect(mock.connections[mock.connections.length - 1].options.context).toContain("Let's keep our initial theory in mind.");
    expect(mock.connections[mock.connections.length - 1].options.context).not.toContain("Follow that distinction");
  });
  it("keeps main-conversation follow-that ambiguous when siblings exist", async () => {
    setup(); publish([finished(), finished("astronomy", "Astronomy")]);
    speak("Follow that distinction"); await settle();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.route).not.toHaveBeenCalled();
    expect(screen.getByText("Which research request should I change?")).toBeInTheDocument();
  });
  it("admits a second distinct spoken follow-that after completion but not its delayed delegation", async () => {
    setup(); const assignment = { subject: "Climate", focus: "Explain the climate distinction." };
    publish([{ ...finished(), assignment }]);
    speak("Follow that distinction", 0); mock.route.mockResolvedValueOnce({ action: "update", jobId: "climate", revision: 1, prompt: "Follow that distinction" }); await settle();
    expect(mock.run).toHaveBeenCalledTimes(1);
    publish([{ ...finished("climate", "Climate", 2), prompt: "Follow that distinction", assignment }]);
    event({ type: "session.delegation.created", delegation: { id: "late-first" }, offset_ms: 200 }); await settle();
    expect(mock.run).toHaveBeenCalledTimes(1);
    mock.route.mockResolvedValueOnce({ action: "update", jobId: "climate", revision: 2, prompt: "Follow that distinction" });
    speak("Follow that distinction", 3_000); await settle();
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.run.mock.calls[1]).toEqual(["climate", "Follow that distinction", expect.any(String), undefined, null, false, undefined, assignment, { expectedRevision: 2 }]);
    publish([{ ...finished("climate", "Climate", 3), prompt: "Follow that distinction", assignment }]);
    event({ type: "session.delegation.created", delegation: { id: "late-second" }, offset_ms: 3_200 }); await settle();
    expect(mock.run).toHaveBeenCalledTimes(2);
  });
  it("can re-enter a finished child and use the same follow-that phrase for its next revision", async () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    const assignment = { subject: "Climate", focus: "Explain the climate distinction." };
    publish([{ ...finished(), assignment }, finished("astronomy", "Astronomy")]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*2 ready/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    speak("Follow that distinction"); await settle();
    expect(mock.run).toHaveBeenCalledTimes(1);
    publish([{ ...finished("climate", "Climate", 2), prompt: "Follow that distinction", assignment }, finished("astronomy", "Astronomy")]);
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    speak("Follow that distinction", 0); await settle();
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(mock.run.mock.calls[1][8]).toEqual({ expectedRevision: 2 });
    expect(mock.jobs.find(job => job.id === "climate")).toMatchObject({ revision: 3 });
    expect(mock.jobs.find(job => job.id === "astronomy")).toMatchObject({ state: "completed", revision: 1 });
  });
  it("keeps a fuller pending utterance on its own reserved ID without exposing that reservation as a correction target", async () => {
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    let oldResult!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(resolve => { oldResult = resolve; }));
    speak("What is happening with climate", 0, "first"); await settle();
    const reservedId = presence.getSnapshot().jobs[0].id;
    const firstSignal = mock.route.mock.calls[0][0].signal;
    const prompt = "What is happening with climate using recent evidence";
    mock.route.mockResolvedValueOnce({ action: "new", prompt });
    event({ type: "session.input_transcript.delta", delta: " using recent evidence", start_ms: 300, end_ms: 500 });
    await settle();
    expect(firstSignal.aborted).toBe(true);
    expect(mock.route.mock.calls[1][0].jobs).toEqual([]);
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0].slice(0, 2)).toEqual([reservedId, prompt]);
    expect(mock.cancel).not.toHaveBeenCalled();
    await act(async () => oldResult({ action: "new", prompt: "What is happening with climate" }));
    expect(mock.run).toHaveBeenCalledOnce();
  });
  it("admits a separate correction of the last pending reservation without inheriting its cancelled turn key", async () => {
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "Which climate evidence should I examine?" });
    speak("What is happening with climate", 0, "first"); await settle();
    const reservedId = presence.getSnapshot().jobs[0].id;
    const prompt = "Actually, check climate in 2024 instead";
    mock.route.mockResolvedValueOnce({ action: "update", jobId: reservedId, revision: 1, prompt });
    speak(prompt, 2_500); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0].slice(0, 2)).toEqual([reservedId, prompt]);
    expect(presence.getSnapshot().jobs).toHaveLength(1);
    expect(presence.getSnapshot().jobs[0]).toMatchObject({ id: reservedId, state: "running" });
    event({ type: "session.delegation.created", delegation: { id: "late-correction" }, offset_ms: 2_700 }); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
  });
  it("cancels the focused completed worker on stop-that without touching its sole running sibling", async () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    publish([finished(), { ...finished("astronomy", "Astronomy"), state: "running", result: undefined }]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Talk to worker" }));
    speak("Stop that"); await settle();
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("climate");
    expect(mock.jobs.find(job => job.id === "astronomy")).toMatchObject({ state: "running", revision: 1 });
  });
  it("does not continue a focused finished worker whose evidence becomes stale before routing", async () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    publish([finished(), finished("astronomy", "Astronomy")]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*2 ready/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Talk to worker" })[0]);
    speak("Follow that distinction");
    mock.current.mockImplementation((id, revision) => id !== "climate" && mock.jobs.some(job => job.id === id && job.revision === revision));
    await settle();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.cancel).not.toHaveBeenCalled();
    expect(screen.getByText("Which research request should I change?")).toBeInTheDocument();
  });
  it("retains child read-only authority but replaces its scope only for an explicit scoped correction", async () => {
    setup(); const child = { ...finished("climate", "Historical climate"), assignment: { subject: "Climate", focus: "Compare climate and astronomy." } };
    publish([child, finished("astronomy", "Astronomy")]);
    const prompt = "Focus only on the historical climate evidence";
    mock.route.mockResolvedValueOnce({ action: "update", jobId: "climate", revision: 1, prompt });
    speak(prompt); await settle();
    expect(mock.run).toHaveBeenCalledExactlyOnceWith("climate", prompt, expect.any(String), undefined, null, false, undefined, { subject: "Climate", focus: prompt });
    expect(mock.jobs.find(job => job.id === "astronomy")).toMatchObject({ revision: 1, state: "completed" });
  });
  it("reserves three stable orbs through clarification, then admits three distinct workers on the original note", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} focusNoteId="original-note" />);
    let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("Spawn three orbs to research the note", 0); await settle();
    expect(mock.route).toHaveBeenCalledOnce();
    const reserved = presence.getSnapshot().jobs;
    expect(reserved).toHaveLength(3); expect(new Set(reserved.map(job => job.id)).size).toBe(3);
    expect(mock.run).not.toHaveBeenCalled();
    await act(async () => resolve({ action: "clarify", question: "What should each worker investigate?", workerCount: 3 })); await settle();
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual(reserved.map(job => job.id));
    expect(presence.getSnapshot().jobs.every(job => job.phase === "clarifying")).toBe(true);
    expect(screen.getByRole("button", { name: /0 working · 0 ready · 3 waiting/ })).toBeInTheDocument();
    mock.route.mockResolvedValueOnce({ action: "conversation" });
    speak("This is such an interesting idea", 2_500); await settle();
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual(reserved.map(job => job.id));
    expect(mock.run).not.toHaveBeenCalled();
    rerender(<SpaceVoice {...props} floating presence={presence} focusNoteId="different-note" />);
    const answer = "This note";
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: answer, assignments: [
      { subject: "Plot", focus: "Research the plot" }, { subject: "Characters", focus: "Research the characters" }, { subject: "History", focus: "Research the history" },
    ] });
    speak(answer, 5_000); await settle();
    expect(mock.route.mock.calls.slice(-1)[0][0]).toMatchObject({ focusNoteId: "original-note", clarification: { prompt: "Spawn three orbs to research the note", workerCount: 3 }, jobs: [] });
    expect(mock.run).toHaveBeenCalledTimes(3);
    expect(mock.run.mock.calls.map(call => call[0])).toEqual(reserved.map(job => job.id));
    expect(mock.run.mock.calls.every(call => call[1] === answer && call[3] === "original-note")).toBe(true);
    expect(presence.getSnapshot().jobs.map(job => job.subject)).toEqual(["Plot", "Characters", "History"]);
    event({ type: "session.delegation.created", delegation: { id: "late-batch", target: "client" }, offset_ms: 5_200 });
    await settle(); expect(mock.run).toHaveBeenCalledTimes(3);
  });
  it("keeps an admitted worker when clarifying an expansion to three", async () => {
    setup(); speak("Research climate", 0); await settle(); const first = mock.jobs[0];
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "I meant three orbs for that research", assignments: [
      { subject: "Climate causes", focus: "Research causes", jobId: first.id, revision: first.revision },
      { subject: "Climate impacts", focus: "Research impacts" }, { subject: "Climate responses", focus: "Research responses" },
    ] });
    speak("I meant three orbs for that research", 2_500); await settle();
    expect(mock.jobs).toHaveLength(3); expect(mock.jobs[0].id).toBe(first.id);
    expect(new Set(mock.jobs.map(job => job.id)).size).toBe(3);
    expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("cancels one waiting orb without removing its siblings or reviving it on clarification", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "What should each worker investigate?", workerCount: 3 });
    speak("Spawn three orbs", 0); await settle();
    const ids = presence.getSnapshot().jobs.map(job => job.id);
    expect(ids).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: Worker 2" }));
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual([ids[0], ids[2]]);
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "Plot and history", assignments: [
      { subject: "Plot", focus: "Research plot" }, { subject: "History", focus: "Research history" },
    ] });
    speak("Plot and history", 2_500); await settle();
    expect(mock.run.mock.calls.map(call => call[0])).toEqual([ids[0], ids[2]]);
    expect(mock.route.mock.calls.slice(-1)[0][0].clarification.workerCount).toBe(2);
  });
  it("invalidates a clarification answer already routing when one reserved worker is cancelled", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "Which topics?", workerCount: 3 });
    speak("Spawn three orbs", 0); await settle();
    const ids = presence.getSnapshot().jobs.map(job => job.id);
    let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("Plot, characters and history", 2_500); await settle();
    const signal = mock.route.mock.calls.slice(-1)[0][0].signal;
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: Worker 1" }));
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ action: "batch", prompt: "Plot, characters and history", assignments: [
      { subject: "Plot", focus: "Plot" }, { subject: "Characters", focus: "Characters" }, { subject: "History", focus: "History" },
    ] })); await settle();
    expect(mock.run).not.toHaveBeenCalled();
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual(ids.slice(1));
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "Characters and history", assignments: [
      { subject: "Characters", focus: "Characters" }, { subject: "History", focus: "History" },
    ] });
    speak("Characters and history", 5_000); await settle();
    expect(mock.run.mock.calls.map(call => call[0])).toEqual(ids.slice(1));
  });
  it("preserves a pending question while discussing an unrelated worker result", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    publish([finished("climate", "Climate")]);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "Which topics?", workerCount: 3 });
    speak("Spawn three orbs", 0); await settle();
    speak("What did the climate research find?", 2_500); await settle();
    expect(screen.getByText("Which topics?")).toBeInTheDocument();
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "Plot, characters and history", assignments: [
      { subject: "Plot", focus: "Plot" }, { subject: "Characters", focus: "Characters" }, { subject: "History", focus: "History" },
    ] });
    speak("Plot, characters and history", 5_000); await settle();
    expect(mock.route.mock.calls.slice(-1)[0][0].clarification).toMatchObject({ workerCount: 3 });
    expect(mock.run).toHaveBeenCalledTimes(3);
  });
  it("admits ten distinct workers from one request instead of silently applying a six-orb limit", async () => {
    const { props, rerender } = setup(); const presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} />);
    const prompt = "Spawn 10 workers to research this story";
    mock.route.mockResolvedValueOnce({ action: "batch", prompt, assignments: Array.from({ length: 10 }, (_, index) => ({ subject: `Angle ${index + 1}`, focus: `Research angle ${index + 1}` })) });
    speak(prompt, 0); await settle();
    expect(mock.run).toHaveBeenCalledTimes(10);
    expect(new Set(mock.run.mock.calls.map(call => call[0])).size).toBe(10);
    expect(presence.getSnapshot().jobs).toHaveLength(10);
  });
  it("starts three closely spaced requests without delegation, then ignores delayed delegation replays", async () => {
    setup();
    for (const [index, prompt] of ["Research climate", "Also compare astronomy notes", "Now read the whole story"].entries()) {
      speak(prompt, index * 1_200); await settle();
    }
    expect(mock.run).toHaveBeenCalledTimes(3);
    const ids = mock.run.mock.calls.map(call => call[0]);
    expect(new Set(ids).size).toBe(3);
    expect(mock.jobs.map(job => job.revision)).toEqual([1, 1, 1]);
    event({ type: "session.delegation.created", delegation: { id: "late", target: "client" }, offset_ms: 1_400 });
    await settle();
    expect(mock.run).toHaveBeenCalledTimes(3);
    speak("Cancel the climate research", 5_000); await settle();
    expect(mock.cancel).toHaveBeenLastCalledWith(ids[0]);
    expect(mock.jobs.slice(1).map(job => job.state)).toEqual(["running", "running"]);
  });
  it("keeps call controls and transcripts out of the composer and stops from the parent button", async () => {
    const { props, rerender, container } = setup(); speak("Read the note", 0, "pending");
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/Listening|Mute mic|Stop speaking|Online|Read the note/)).toBeNull();
    rerender(<SpaceVoice {...props} toggleRequest={2} />);
    expect(mock.close).toHaveBeenCalledOnce(); expect(mock.cancel).not.toHaveBeenCalled();
    speak("Late transcript", 400); await settle(2_000); expect(mock.run).not.toHaveBeenCalled();
  });
  it("assembles full-duplex fragments, deduplicates delegation, and preserves the captured note", async () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} focusNoteId="original-note" />);
    event({ type: "session.input_transcript.delta", event_id: "1", delta: "Compare alpha", start_ms: 0, end_ms: 100 });
    event({ type: "session.output_transcript.delta", event_id: "2", delta: "Mm-hmm.", start_ms: 80, end_ms: 150 });
    event({ type: "session.input_transcript.delta", event_id: "3", delta: " and beta", start_ms: 100, end_ms: 200 });
    for (let index = 0; index < 2; index++) event({ type: "session.delegation.created", delegation: { id: "d1", target: "client" }, offset_ms: 200 });
    rerender(<SpaceVoice {...props} focusNoteId="different-note" />); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0]).toEqual([expect.any(String), "Compare alpha and beta", expect.any(String), "original-note", "d1"]);
  });
  it("binds a delayed delegation to its original utterance rather than newer discussion", async () => {
    setup(); speak("Research climate", 0); await settle(); speak("This is a fascinating idea", 2_500);
    event({ type: "session.delegation.created", delegation: { id: "late", target: "client" }, offset_ms: 200 }); await settle();
    expect(mock.run).toHaveBeenCalledOnce(); expect(mock.run.mock.calls[0][1]).toBe("Research climate"); expect(mock.run.mock.calls[0][4]).toBe(null);
  });
  it("retains an early delegation until its transcript arrives", async () => {
    setup(); event({ type: "session.delegation.created", delegation: { id: "early", target: "client" }, offset_ms: 300 });
    await settle(1_200); expect(mock.run).not.toHaveBeenCalled();
    event({ type: "session.input_transcript.delta", delta: "Read this note", start_ms: 0, end_ms: 500 }); await settle();
    expect(mock.run).toHaveBeenCalledOnce(); expect(mock.run.mock.calls[0][1]).toBe("Read this note"); expect(mock.run.mock.calls[0][4]).toBe("early");
  });
  it("keeps two jobs running during ordinary speech and cancels only the named job", async () => {
    setup(); speak("Research climate", 0, "climate-delegation"); await settle(); speak("Research astronomy", 2_500, "astronomy-delegation"); await settle();
    expect(mock.run).toHaveBeenCalledTimes(2);
    const climateId = mock.run.mock.calls[0][0], astronomyId = mock.run.mock.calls[1][0]; expect(climateId).not.toBe(astronomyId);
    speak("This could make the experience much nicer", 5_000); await settle();
    expect(mock.run).toHaveBeenCalledTimes(2); expect(mock.cancel).not.toHaveBeenCalled();
    speak("Cancel climate", 7_500); await settle();
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith(climateId); expect(mock.jobs.find(job => job.id === astronomyId).state).toBe("running");
  });
  it("corrects the chosen job with the current spoken words and retains the other job", async () => {
    setup(); speak("Research climate", 0, "climate"); await settle(); speak("Research astronomy", 2_500, "astronomy"); await settle();
    const climateId = mock.run.mock.calls[0][0], astronomyId = mock.run.mock.calls[1][0];
    mock.route.mockResolvedValueOnce({ action: "update", jobId: climateId, revision: 1, prompt: "Actually, research climate in 2024 instead" });
    speak("Actually, research climate in 2024 instead", 5_000); await settle();
    expect(mock.run).toHaveBeenCalledTimes(3); expect(mock.run.mock.calls[2][0]).toBe(climateId);
    expect(mock.run.mock.calls[2][1]).toBe("Actually, research climate in 2024 instead");
    expect(mock.jobs.find(job => job.id === climateId).revision).toBe(2); expect(mock.jobs.find(job => job.id === astronomyId).revision).toBe(1);
    expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("does not let assistant speech rearm a batch of background findings", async () => {
    const { props } = setup();
    speak("Research climate", 0); await settle();
    const jobs = [finished("one", "Climate"), finished("two", "Astronomy")]; publish(jobs);
    act(() => { for (const job of jobs) {
      const packet = voiceFindingDelivery({ id: job.id, spaceId: props.snapshot.workspace.id, revision: 1, sequence: 1, subject: job.subject, state: "running", result: job.result! });
      mock.engine.deliver("commentary", packet.commentary, null, { id: job.id, revision: 1, sequence: 1, reference: packet.quiet, background: true });
    } });
    await settle(2_000); expect(synthesized()).toHaveLength(1);
    event({ type: "session.output_transcript.delta", delta: "Climate finding.", offset_ms: 3_000 });
    await settle(30_000); expect(synthesized()).toHaveLength(1);
    speak("That connection is interesting", 34_000); await settle(2_000);
    expect(synthesized()).toHaveLength(1); expect(commentary()).toHaveLength(1);
  });
  it("buffers a complete finding during transcript activity, then sends it after a quiet interval", async () => {
    setup(); publish([finished()]);
    act(() => mock.options.onActivity({ inputActive: true, outputActive: false, measured: true }));
    speak("This is an interesting connection", 0);
    act(() => { mock.engine.deliver("thinking", "Quiet progress", null, { id: "climate", revision: 1 }); mock.engine.deliver("commentary", "Complete finding with its qualification.", null, { id: "climate", revision: 1 }); });
    expect(mock.append).not.toHaveBeenCalledWith("thinking", "Quiet progress", null);
    await settle(1_000); expect(commentary()).toEqual([]);
    act(() => mock.options.onActivity({ inputActive: false, outputActive: false, measured: true }));
    await settle(400); expect(commentary()).toEqual([]); await settle(200);
    expect(commentary()).toEqual([["commentary", "Complete finding with its qualification.", null]]);
    expect(mock.append).toHaveBeenCalledWith("thinking", "Quiet progress", null);
  });
  it("drops cancelled and superseded findings before they can be spoken", async () => {
    setup(); publish([finished("climate", "Climate"), finished("astronomy", "Astronomy")]);
    act(() => { mock.engine.deliver("commentary", "Old climate finding", "d1", { id: "climate", revision: 1 }); mock.engine.deliver("commentary", "Old astronomy finding", "d2", { id: "astronomy", revision: 1 }); });
    publish([{ ...finished("climate", "Climate"), state: "cancelled" }, finished("astronomy", "Astronomy", 2)]); await settle(4_000); expect(commentary()).toEqual([]);
    act(() => mock.engine.deliver("commentary", "Current astronomy finding", null, { id: "astronomy", revision: 2 })); await settle(2_000);
    expect(commentary()).toEqual([["commentary", "Current astronomy finding", null]]);
  });
  it("withholds a queued finding while intent routing is unresolved", async () => {
    setup(); publish([finished()]); let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("Actually, check climate in 2024 instead", 0); await settle();
    act(() => mock.engine.deliver("commentary", "Original finding", "d", { id: "climate", revision: 1 })); await settle(3_000); expect(commentary()).toEqual([]);
    await act(async () => resolve({ action: "update", jobId: "climate", revision: 1, prompt: "Actually, check climate in 2024 instead" })); await settle(3_000);
    expect(mock.run.mock.calls[0][0]).toBe("climate"); expect(commentary()).toEqual([]);
  });
  it("offers ready findings while an unrelated new request is still being routed", async () => {
    setup(); publish([finished()]);
    mock.route.mockImplementationOnce(() => new Promise(() => undefined));
    speak("Research astronomy", 0, "astronomy"); await settle();
    act(() => mock.engine.deliver("commentary", "Climate finding", null, { id: "climate", revision: 1 }));
    await settle(2_000);
    expect(commentary()).toEqual([["commentary", "Climate finding", null]]);
    expect(screen.getByRole("button", { name: "Cancel research: Research astronomy" })).toBeInTheDocument();
  });
  it("does not hold an astronomy finding while an explicitly named climate correction is routed", async () => {
    setup(); publish([finished("climate", "Climate"), finished("astronomy", "Astronomy")]);
    mock.route.mockImplementationOnce(() => new Promise(() => undefined));
    speak("Actually, check climate in 2024 instead", 0); await settle();
    act(() => mock.engine.deliver("commentary", "Astronomy finding", null, { id: "astronomy", revision: 1 }));
    await settle(2_000);
    expect(commentary()).toEqual([["commentary", "Astronomy finding", null]]);
  });
  it("routes speech and offers findings despite a continuously noisy microphone", async () => {
    setup();
    act(() => mock.options.onActivity({ inputActive: true, outputActive: false, measured: true }));
    speak("Research climate", 0, "climate"); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    const id = mock.run.mock.calls[0][0]; publish([finished(id)]);
    act(() => mock.engine.deliver("commentary", "Current finding", null, { id, revision: 1 }));
    await settle(3_000);
    expect(commentary()).toEqual([["commentary", "Current finding", null]]);
  });
  it("waits for the assistant to finish even when output metering is unavailable and a finding is overdue", async () => {
    setup(); publish([finished()]);
    act(() => mock.engine.deliver("commentary", "Ready finding", null, { id: "climate", revision: 1 }));
    for (let index = 0; index < 50; index++) {
      event({ type: "session.output_transcript.delta", delta: " Continuing.", start_ms: index * 400, end_ms: index * 400 + 200 });
      await settle(400);
      expect(commentary()).toEqual([]);
    }
    await settle(3_000);
    expect(commentary()).toEqual([["commentary", "Ready finding", null]]);
  });
  it("suppresses a delayed delegation after its exact earlier request was cancelled", async () => {
    setup(); speak("Research climate", 0); await settle();
    speak("Cancel climate", 2_500); await settle();
    event({ type: "session.delegation.created", delegation: { id: "late", target: "client" }, offset_ms: 200 });
    await settle(2_000);
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.jobs[0].state).toBe("cancelled");
    expect(screen.queryByText("Which research request should I cancel?")).toBeNull();
  });
  it("lets work finish after Stop, restores quiet context on reconnect, and ignores old callbacks", async () => {
    const { props, rerender } = setup(); speak("Research climate", 0, "d"); await settle(); const old = mock.options;
    rerender(<SpaceVoice {...props} toggleRequest={2} />); expect(mock.cancel).not.toHaveBeenCalled();
    publish([finished(mock.run.mock.calls[0][0])]);
    act(() => mock.engine.deliver("commentary", "A finding while disconnected", "d", { id: mock.jobs[0].id, revision: 1 }));
    rerender(<SpaceVoice {...props} toggleRequest={3} />); await settle(3_000);
    expect(mock.connections).toHaveLength(2); expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.append.mock.calls.some(call => call[0] === "thinking" && String(call[1]).includes("Climate finding"))).toBe(true); expect(commentary()).toEqual([]);
    event({ type: "session.input_transcript.delta", delta: "Research stale task", start_ms: 4_000, end_ms: 4_200 }, old);
    event({ type: "session.delegation.created", delegation: { id: "old", target: "client" }, offset_ms: 4_200 }, old);
    act(() => old.onStatus("disconnected", "Old connection error")); await settle();
    expect(mock.run).toHaveBeenCalledOnce(); expect(screen.queryByText("Old connection error")).toBeNull();
  });
  it("does not let an old router clear or admit a new call's reservations after reconnect", async () => {
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} presence={presence} focusNoteId="old-note" />);
    let resolveOld!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }));
    speak("Spawn three orbs", 0); await settle();
    const oldIds = presence.getSnapshot().jobs.map(job => job.id), oldSignal = mock.route.mock.calls[0][0].signal;
    rerender(<SpaceVoice {...props} presence={presence} toggleRequest={2} />);
    rerender(<SpaceVoice {...props} presence={presence} toggleRequest={3} focusNoteId="new-note" />);
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "What should the new workers investigate?", workerCount: 3 });
    speak("Spawn three orbs", 0); await settle();
    const newIds = presence.getSnapshot().jobs.map(job => job.id);
    expect(newIds).toHaveLength(3); expect(newIds.every(id => !oldIds.includes(id))).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld({ action: "batch", prompt: "Spawn three orbs", assignments: [
      { subject: "Old plot", focus: "Plot" }, { subject: "Old people", focus: "People" }, { subject: "Old history", focus: "History" },
    ] })); await settle();
    expect(mock.run).not.toHaveBeenCalled();
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual(newIds);
    expect(screen.getByText("What should the new workers investigate?")).toBeInTheDocument();
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "Plot, people and history", assignments: [
      { subject: "Plot", focus: "Plot" }, { subject: "People", focus: "People" }, { subject: "History", focus: "History" },
    ] });
    speak("Plot, people and history", 2_500); await settle();
    expect(mock.run.mock.calls.map(call => call[0])).toEqual(newIds);
    expect(mock.run.mock.calls.every(call => call[3] === "new-note")).toBe(true);
  });
  it.each(["hidden", "key", "space"])("closes capture and cancels jobs at the %s boundary", async boundary => {
    const { props, rerender } = setup(); speak("Research climate", 0, "d"); await settle();
    const next = boundary === "hidden" ? { ...props, enabled: false } : boundary === "key" ? { ...props, snapshot: { ...props.snapshot, settings: { ...props.snapshot.settings, apiKeyConfigured: false } } } : { ...props, snapshot: { ...props.snapshot, workspace: { ...props.snapshot.workspace, id: "other" } } };
    rerender(<SpaceVoice {...next} />);
    if (boundary === "space") expect(mock.dispose).toHaveBeenCalled();
    else { expect(mock.close).toHaveBeenCalled(); expect(mock.cancel).toHaveBeenCalled(); }
  });
  it("resolves a brief answer to an ambiguous cancellation against the pending request", async () => {
    setup(); publish([{ ...finished("climate", "Climate"), state: "running" }, { ...finished("astronomy", "Astronomy"), state: "running" }]);
    speak("Cancel that research", 0); await settle();
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(screen.getByText("Which research request should I cancel?")).toBeInTheDocument();
    speak("The climate one", 2_500); await settle();
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("climate");
    expect(mock.jobs.find(job => job.id === "astronomy").state).toBe("running");
  });
  it("does not revive a job cancelled while its correction was being interpreted", async () => {
    setup(); publish([{ ...finished(), state: "running" }]);
    let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("Actually, check climate in 2024 instead", 0); await settle();
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: Climate" }));
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("climate");
    await act(async () => resolve({ action: "update", jobId: "climate", revision: 1, prompt: "Actually, check climate in 2024 instead" }));
    expect(mock.run).not.toHaveBeenCalled();
  });
  it.each(["Cancel climate", "Cancel that"])("cancels a pending new assignment before its slow router returns: %s", async cancellation => {
    setup(); let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("What about climate?", 0, "climate"); await settle();
    expect(mock.route).toHaveBeenCalledOnce(); expect(mock.run).not.toHaveBeenCalled();
    const signal = mock.route.mock.calls[0][0].signal as AbortSignal;
    speak(cancellation, 2_500); await settle();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ action: "new", prompt: "What about climate?" }));
    await settle(2_000);
    expect(mock.run).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel research: What about climate?" })).toBeNull();
  });
  it("starts an unrelated queued interpretation after cancellation even if the old router never settles", async () => {
    setup();
    mock.route.mockImplementationOnce(() => new Promise(() => {}));
    speak("What about climate?", 0, "climate"); await settle();
    const oldSignal = mock.route.mock.calls[0][0].signal;
    mock.route.mockResolvedValueOnce({ action: "new", prompt: "What about astronomy?" });
    speak("What about astronomy?", 2_500, "astronomy"); await settle();
    expect(mock.route).toHaveBeenCalledOnce(); expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: What about climate?" }));
    await settle();
    expect(oldSignal.aborted).toBe(true); expect(mock.route).toHaveBeenCalledTimes(2);
    expect(mock.run).toHaveBeenCalledExactlyOnceWith(expect.any(String), "What about astronomy?", expect.any(String), undefined, "astronomy");
  });
  it("does not carry hidden cancellation authority through Stop and reconnect", async () => {
    const { props, rerender } = setup();
    publish([{ ...finished("climate", "Climate"), state: "running" }, { ...finished("astronomy", "Astronomy"), state: "running" }]);
    speak("Cancel that research", 0); await settle();
    expect(screen.getByText("Which research request should I cancel?")).toBeInTheDocument();
    rerender(<SpaceVoice {...props} toggleRequest={2} />);
    rerender(<SpaceVoice {...props} toggleRequest={3} />);
    speak("Climate", 0); await settle(2_000);
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(mock.jobs.every(job => job.state === "running")).toBe(true);
    expect(commentary()).toEqual([]);
  });
  it.each(["failed", "completed"] as const)("allows an explicit correction to refresh a %s job whose previous evidence is no longer current", async state => {
    setup(); publish([{ ...finished("climate", "Climate", 3), state, focusNoteId: "original-note" }]);
    mock.current.mockReturnValue(false);
    mock.route.mockResolvedValueOnce({ action: "update", jobId: "climate", revision: 3, prompt: "Actually, check climate in 2024 instead" });
    speak("Actually, check climate in 2024 instead", 0); await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0]).toEqual(["climate", "Actually, check climate in 2024 instead", expect.any(String), "original-note", null]);
    expect(mock.jobs[0].revision).toBe(4);
  });
  it("interprets successive corrections in spoken order against the revision produced by the preceding correction", async () => {
    setup(); publish([{ ...finished("climate", "Climate"), state: "running" }]);
    let first!: (value: unknown) => void, second!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(resolve => { first = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve; }));
    speak("Actually, check climate in 2024 instead", 0); await settle();
    expect(mock.route).toHaveBeenCalledOnce();
    speak("Actually, check climate in 2025 instead", 2_500); await settle();
    expect(mock.route).toHaveBeenCalledOnce();
    await act(async () => first({ action: "update", jobId: "climate", revision: 1, prompt: "Actually, check climate in 2024 instead" }));
    expect(mock.jobs[0].revision).toBe(2);
    expect(mock.route).toHaveBeenCalledTimes(2);
    expect(mock.route.mock.calls[1][0].jobs).toEqual([expect.objectContaining({ id: "climate", revision: 2, prompt: "Actually, check climate in 2024 instead" })]);
    await act(async () => second({ action: "update", jobId: "climate", revision: 2, prompt: "Actually, check climate in 2025 instead" }));
    expect(mock.jobs[0]).toMatchObject({ id: "climate", revision: 3, prompt: "Actually, check climate in 2025 instead" });
    expect(mock.run).toHaveBeenCalledTimes(2); expect(mock.cancel).not.toHaveBeenCalled();
  });
  it("removes a timed-out pending request even if its router ignores abort and later returns", async () => {
    setup(); let resolve!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    speak("What about climate?", 0, "climate"); await settle();
    expect(screen.getByRole("button", { name: "Cancel research: What about climate?" })).toBeInTheDocument();
    const signal = mock.route.mock.calls[0][0].signal as AbortSignal;
    await settle(45_000);
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "Cancel research: What about climate?" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(/understanding this request took too long/i);
    await act(async () => resolve({ action: "new", prompt: "What about climate?" }));
    await settle();
    expect(mock.run).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Cancel research: What about climate?" })).toBeNull();
  });
  it("targets Keep and saved-note navigation to their own completed research result", async () => {
    const { props } = setup(); publish([finished("climate", "Climate"), finished("astronomy", "Astronomy")]);
    const astronomy = screen.getByText("Astronomy").closest(".space-voice__job") as HTMLElement;
    await act(async () => fireEvent.click(within(astronomy).getByRole("button", { name: "Keep as note" })));
    expect(mock.keep).toHaveBeenCalledExactlyOnceWith("astronomy");
    publish([finished("climate", "Climate"), { ...finished("astronomy", "Astronomy"), receipt: { savedNoteIds: ["saved-astronomy"], savedTitles: ["Astronomy notes"] } }]);
    fireEvent.click(screen.getByRole("button", { name: "Saved · Astronomy notes" }));
    expect(props.onOpenNote).toHaveBeenCalledExactlyOnceWith("saved-astronomy");
    expect(screen.getAllByRole("button", { name: "Keep as note" })).toHaveLength(1);
  });
  it("reconnects explicitly from an error without rerunning research or losing its saved receipt", async () => {
    setup();
    speak("We agreed to keep the climate comparison brief", 0); await settle();
    const saved = { ...finished(), receipt: { savedNoteIds: ["saved-climate"], savedTitles: ["Climate notes"] } };
    publish([saved, { ...finished("astronomy", "Astronomy"), state: "running" }]);
    act(() => mock.options.onStatus("disconnected", "Voice disconnected. Research is retained here."));
    expect(mock.connections).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect voice" }));
    expect(mock.connections).toHaveLength(2);
    expect(mock.options.context).toContain("We agreed to keep the climate comparison brief");
    expect(mock.append).toHaveBeenCalledWith("thinking", expect.stringContaining("saved-climate"));
    expect(screen.getByRole("button", { name: "Saved · Climate notes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel research: Astronomy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect voice" })).toBeNull();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.cancel).not.toHaveBeenCalled();
    expect(commentary()).toEqual([]);
  });
  it("updates current-note context without replacing the running research target", async () => {
    const { props, rerender } = setup();
    const note = { id: "n", title: "Open draft", slug: "n", body: "The lighthouse went dark.", summary: "", kind: "article" as const, status: "ready" as const, aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" };
    rerender(<SpaceVoice {...props} snapshot={{ ...props.snapshot, notes: [note] }} focusNoteId="n" />); await settle(2_000);
    expect(mock.append.mock.calls.some(call => call[0] === "thinking" && String(call[1]).includes("The lighthouse went dark."))).toBe(true);
    expect(mock.cancel).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
    mock.append.mockClear();
    for (let index = 0; index < 5; index++) {
      rerender(<SpaceVoice {...props} snapshot={{ ...props.snapshot, notes: [{ ...note, body: note.body + " Still typing.".repeat(index + 1), updatedAt: String(index) }] }} focusNoteId="n" />);
      await settle(1_000);
    }
    expect(mock.append).not.toHaveBeenCalled();
  });
  it("sends only the changed work order and uses provider context pressure for later updates", async () => {
    const { props, rerender } = setup();
    const running = [{ ...finished("climate", "Climate"), state: "running" as const }, { ...finished("astronomy", "Astronomy"), state: "running" as const }];
    publish(running); mock.append.mockClear();
    publish([{ ...running[0], progress: "Reading the climate passage" }, running[1]]);
    expect(mock.append).toHaveBeenCalledOnce();
    expect(JSON.parse(mock.append.mock.calls[0][1]).jobs).toEqual([{ id: "climate", revision: 1, progress: "Reading the climate passage" }]);
    mock.append.mockClear();
    event({ type: "session.usage.updated", context_window: { usage_ratio: 0.82 } });
    publish([{ ...running[0], progress: "Another progress update" }, running[1]]);
    expect(mock.append).not.toHaveBeenCalled();
    const note = { id: "n", title: "New focus", slug: "n", body: "Large note body that must not be sent at high pressure.", summary: "", kind: "article" as const, status: "ready" as const, aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" };
    rerender(<SpaceVoice {...props} snapshot={{ ...props.snapshot, notes: [note] }} focusNoteId="n" />);
    expect(JSON.parse(mock.append.mock.calls[0][1]).currentNote).toMatchObject({ id: "n", passages: [], excerptsOmitted: true });
    expect(mock.append.mock.calls.every(call => !String(call[1]).includes(note.body))).toBe(true);
    event({ type: "session.usage.updated", context_window: { usage_ratio: 0.86 } });
    event({ type: "session.usage.updated", context_window: { usage_ratio: 0.91 } });
    expect(mock.append.mock.calls.filter(call => String(call[1]).includes('"type":"conversation_checkpoint"'))).toHaveLength(1);
    expect(mock.connections).toHaveLength(1); expect(mock.run).not.toHaveBeenCalled();
  });
  it("returns a finished orb to the small swarm without cancelling its result, then restores it explicitly", async () => {
    const { props, rerender } = setup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} floating presence={presence} />);
    publish([finished()]);
    fireEvent.click(within(screen.getByTestId("orbs-pill")).getByRole("button", { name: "Dismiss orb: Climate" }));
    expect(mock.cancel).not.toHaveBeenCalled();
    expect(mock.jobs[0]).toMatchObject({ id: "climate", state: "completed", result: { reply: "Climate finding." } });
    expect(screen.getByTestId("orbs-pill")).toHaveAttribute("data-dismissed", "climate");
    expect(presence.getSnapshot().dismissedJobIds).toEqual(["climate"]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*0 working.*1 ready/ }));
    fireEvent.click(screen.getByRole("button", { name: "Research & references" }));
    expect(screen.getByText("Climate finding.")).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep as note" })));
    expect(mock.keep).toHaveBeenCalledExactlyOnceWith("climate");
    fireEvent.click(screen.getByRole("button", { name: "Bring back & talk" }));
    expect(mock.connections).toHaveLength(2);
    expect(screen.getByTestId("orbs-pill")).toHaveAttribute("data-dismissed", "");
    expect(presence.getSnapshot().focusedJobId).toBe("climate");
    expect(mock.cancel).not.toHaveBeenCalled(); expect(mock.run).not.toHaveBeenCalled();
  });
  it("throwing a researching orb cancels only that job while completed work remains available", () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    publish([{ ...finished("climate", "Climate"), state: "running" }, finished("astronomy", "Astronomy")]);
    fireEvent.click(within(screen.getByTestId("orbs-pill")).getByRole("button", { name: "Dismiss orb: Climate" }));
    expect(mock.cancel).toHaveBeenCalledExactlyOnceWith("climate");
    expect(mock.jobs.find(job => job.id === "astronomy")).toMatchObject({ state: "completed", result: { reply: "Astronomy finding." } });
  });
  it("uses the explicit retry path so replay deduplication cannot swallow a failed job retry", async () => {
    setup(); publish([{ ...finished(), state: "failed", progress: "Provider timed out" }]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(mock.retry).toHaveBeenCalledExactlyOnceWith("climate", expect.any(String));
    expect(mock.run).not.toHaveBeenCalled();
  });
  it("keeps intermediate findings collapsed and reference-aware without opening work, speaking, or moving the writing cursor", () => {
    const { props, rerender } = setup(); rerender(<SpaceVoice {...props} floating />);
    render(<textarea aria-label="Draft cursor" />); const draft = screen.getByRole("textbox", { name: "Draft cursor" }); draft.focus();
    const update = { sequence: 1, reply: "A supported first finding [1](#orion-evidence-e1).", evidence: [{ id: "e1", kind: "note" as const, entityId: "draft", title: "Draft", version: "v1", start: 0, end: 16, text: "Exact reference.", offsetUnit: "utf16" as const }],
      coverage: { availableNotes: 2, availableSources: 0, openedNotes: 1, openedSources: 0, searches: 1, limited: true } };
    const working = { ...finished(), state: "running" as const, result: undefined, progress: "Checking another passage", updates: [update] };
    publish([working]);
    expect(draft).toHaveFocus(); expect(screen.queryByText("Latest finding")).toBeNull(); expect(commentary()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: /Talk to Space.*1 working.*0 ready/ }));
    const summary = screen.getByText("Latest finding"), disclosure = summary.closest("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText(/A supported first finding/)).not.toBeVisible();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute("open"); expect(screen.getByText(/A supported first finding/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Read citation: Draft" })).toBeVisible();
    expect(screen.getByText("Read 1 note and 0 sources · Partial Space coverage")).toBeVisible();
    expect(commentary()).toEqual([]); expect(props.commit).not.toHaveBeenCalled(); expect(props.onProposal).not.toHaveBeenCalled();
    publish([{ ...working, updates: [update, { ...update, sequence: 2, reply: "A newer supported finding [1](#orion-evidence-e1)." }] }]);
    expect(screen.getByText(/A newer supported finding/)).toBeVisible(); expect(screen.queryByText(/A supported first finding/)).toBeNull();
    publish([finished()]);
    expect(screen.queryByText("Latest finding")).toBeNull(); expect(screen.getByRole("button", { name: "Research & references" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Research & references" })); expect(screen.getByText("Climate finding.")).toBeVisible();
  });
  it("retains a cancelled work row and retries only through an explicit action", async () => {
    setup(); publish([{ ...finished(), state: "running", result: undefined }]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: Climate" }));
    expect(screen.getByText("Climate")).toBeVisible(); expect(screen.getByRole("status")).toHaveTextContent("Cancelled");
    expect(mock.retry).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(mock.retry).toHaveBeenCalledExactlyOnceWith("climate", expect.any(String)); expect(mock.run).not.toHaveBeenCalled();
  });
  it("retains an atomic save receipt after cancellation without offering a duplicate-save retry", () => {
    const { props } = setup(); publish([{ ...finished(), state: "cancelled", receipt: { savedNoteIds: ["saved-before-stop"], savedTitles: ["Prior finding"] } }]);
    expect(screen.getByText("Saved before cancellation")).toBeVisible(); expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Saved · Prior finding" }));
    expect(props.onOpenNote).toHaveBeenCalledExactlyOnceWith("saved-before-stop"); expect(mock.keep).not.toHaveBeenCalled(); expect(mock.retry).not.toHaveBeenCalled();
  });
});


describe("selected passage during a live Space call", () => {
  function selectionSetup() {
    const { props, rerender } = setup();
    const note = { id: "story", title: "Story", slug: "story", body: "First passage. Second passage.", summary: "", kind: "article" as const, status: "ready" as const, aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "now", updatedAt: "now" };
    props.snapshot.notes = [note, { ...note, id: "other" }];
    const store = createVoiceSelectionStore(props.snapshot.workspace.id);
    const selected = { spaceId: props.snapshot.workspace.id, noteId: note.id, noteTitle: note.title, version: spaceNoteVersion(note), text: "First passage.", range: { from: 0, to: 14, unit: "dom-text-utf16" as const }, hiddenTaskRanges: [] };
    rerender(<SpaceVoice {...props} focusNoteId={note.id} voiceSelection={store} floating />);
    return { props, rerender, store, selected };
  }
  it("acknowledges selection locally without sending it, speech, research or mutation; mute controls retain it", async () => {
    const { props, store, selected } = selectionSetup();
    mock.append.mockClear();
    act(() => store.capture(selected)); await settle();
    expect(screen.getByText("Selected text")).toBeTruthy();
    expect(mock.run).not.toHaveBeenCalled(); expect(mock.route).not.toHaveBeenCalled(); expect(commentary()).toEqual([]);
    expect(props.commit).not.toHaveBeenCalled(); expect(props.onProposal).not.toHaveBeenCalled();
    expect(mock.append).not.toHaveBeenCalled();
    const before = store.getSnapshot(); fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(store.getSnapshot()).toBe(before);
  });
  it("keeps replacement and deselection silent until the next spoken turn, including on a new call", async () => {
    const { props, rerender, store, selected } = selectionSetup();
    act(() => store.capture(selected)); await settle();
    fireEvent.click(screen.getByRole("button", { name: "End voice call" }));
    rerender(<SpaceVoice {...props} toggleRequest={2} focusNoteId="story" voiceSelection={store} floating />); await settle();
    const connection = mock.connections[mock.connections.length - 1];
    expect(JSON.parse(connection.options.context)).not.toHaveProperty("selectedText");
    mock.append.mockClear();
    act(() => store.capture({ ...selected, text: "Second passage.", range: { ...selected.range, from: 15, to: 30 } })); await settle();
    act(() => store.clear()); await settle();
    expect(mock.append).not.toHaveBeenCalled();
    act(() => store.capture(selected)); await settle();
    event({ type: "session.input_transcript.delta", delta: "What do you think of this?", start_ms: 0, end_ms: 100 });
    const packets = () => mock.append.mock.calls.filter(call => call[0] === "thinking").flatMap(call => {
      try { const packet = JSON.parse(call[1]); return packet.type === "selection_update" ? [packet] : []; } catch { return []; }
    });
    expect(packets()).toHaveLength(1);
    expect(packets()[0].selectedText.passage).toBe(selected.text);
    act(() => store.clear()); await settle();
    expect(packets()).toHaveLength(1);
    event({ type: "session.input_transcript.delta", delta: "Something else", start_ms: 2000, end_ms: 2100 });
    expect(packets()).toHaveLength(2);
    expect(packets()[1].selectedText).toBeNull();
  });
  it("dispatches the original selection despite a replacement and navigation before the spoken question finishes", async () => {
    const { props, rerender, store, selected } = selectionSetup();
    act(() => store.capture(selected)); const original = store.getSnapshot();
    event({ type: "session.input_transcript.delta", delta: "What do you think", start_ms: 0, end_ms: 100 });
    act(() => store.capture({ ...selected, text: "Second passage.", range: { ...selected.range, from: 15, to: 30 } }));
    act(() => store.clear()); rerender(<SpaceVoice {...props} focusNoteId="other" voiceSelection={store} floating />);
    event({ type: "session.input_transcript.delta", delta: " of this?", start_ms: 100, end_ms: 300 });
    event({ type: "session.delegation.created", delegation: { id: "selection-work", target: "client" }, offset_ms: 300 });
    await settle();
    expect(mock.run).toHaveBeenCalledOnce();
    expect(mock.run.mock.calls[0]).toEqual([expect.any(String), "What do you think of this?", expect.any(String), "story", "selection-work", false, original]);
    expect(mock.route.mock.calls[0][0].conversation).toContain("First passage.");
    expect(mock.route.mock.calls[0][0].conversation).not.toContain("Second passage.");
  });
  it("keeps the original passage through navigation, a cancelled clarification answer and the surviving workers' next answer", async () => {
    const { props, rerender, store, selected } = selectionSetup(), presence = createVoicePresence();
    rerender(<SpaceVoice {...props} focusNoteId="story" voiceSelection={store} presence={presence} />);
    act(() => store.capture(selected)); const original = store.getSnapshot();
    mock.route.mockResolvedValueOnce({ action: "clarify", question: "Which angles?", workerCount: 3 });
    speak("Spawn three orbs to study this passage", 0); await settle();
    const ids = presence.getSnapshot().jobs.map(job => job.id);
    act(() => store.capture({ ...selected, text: "Second passage.", range: { ...selected.range, from: 15, to: 30 } }));
    rerender(<SpaceVoice {...props} focusNoteId="other" voiceSelection={store} presence={presence} />);
    let resolveOld!: (value: unknown) => void;
    mock.route.mockImplementationOnce(() => new Promise(done => { resolveOld = done; }));
    speak("Meaning, cadence and history", 2_500); await settle();
    expect(mock.route.mock.calls.slice(-1)[0][0].conversation).toContain("First passage.");
    expect(mock.route.mock.calls.slice(-1)[0][0].conversation).not.toContain("Second passage.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel research: Worker 2" }));
    await act(async () => resolveOld({ action: "batch", prompt: "Meaning, cadence and history", assignments: [
      { subject: "Meaning", focus: "Meaning" }, { subject: "Cadence", focus: "Cadence" }, { subject: "History", focus: "History" },
    ] })); await settle();
    expect(mock.run).not.toHaveBeenCalled();
    expect(presence.getSnapshot().jobs.map(job => job.id)).toEqual([ids[0], ids[2]]);
    mock.route.mockResolvedValueOnce({ action: "batch", prompt: "Meaning and history", assignments: [
      { subject: "Meaning", focus: "Meaning" }, { subject: "History", focus: "History" },
    ] });
    speak("Meaning and history", 5_000); await settle();
    expect(mock.run.mock.calls.map(call => call[0])).toEqual([ids[0], ids[2]]);
    expect(mock.run.mock.calls.every(call => call[3] === "story")).toBe(true);
    expect(mock.run.mock.calls.map(call => call[6])).toEqual([original, original]);
    expect(props.commit).not.toHaveBeenCalled(); expect(props.onProposal).not.toHaveBeenCalled();
  });
  it("can speak the latest intermediate finding while its worker continues", async () => {
    setup();
    const job = { ...finished("climate", "Climate"), state: "running" as const, result: undefined, updates: [{ sequence: 1, reply: "A preliminary finding", evidence: [], coverage: { availableNotes: 2, availableSources: 0, openedNotes: 1, openedSources: 0, searches: 0, limited: false } }] };
    publish([job]); speak("Tell me the climate result", 0); await settle();
    expect(mock.finding).toHaveBeenCalledWith("climate"); expect(mock.announce).not.toHaveBeenCalled();
  });
});
