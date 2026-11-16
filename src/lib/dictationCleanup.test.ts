// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "../data/defaults";
import { cleanUpDictation, loadSnapshot, saveSnapshot } from "./storage";
import { attachDictationOriginal, dictationOriginalSource, parseDictationCleanup, parseDictationProposal, parseDictationResult, prepareDictation, resolveDictationBoard, DICTATION_CLEANUP_TIMEOUT_MS, MAX_DICTATION_CLEANUP_CHARS, type DictationTicketBlock } from "./dictationCleanup";
import type { Note } from "../types";

const invokeTauriMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock }));

const raw = "Let's have a meeting on Friday—oh no, actually Thursday. Maybe we could invite Sam.";
const blocks = [{ kind: "paragraph" as const, text: "Let's have a meeting on Thursday. Maybe we could invite Sam." }];
const now = "2026-11-11T07:00:00.000Z";
const note: Note = { id: "note-one", title: "Planning", slug: "planning", summary: "", body: "Existing writing.", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: now, updatedAt: now };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } });
});
afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invokeTauriMock.mockReset();
});

function options() {
  return { transcript: raw, aiAvailable: true, preserveOriginal: vi.fn().mockResolvedValue("source-original"),
    clean: vi.fn().mockResolvedValue(blocks), signal: new AbortController().signal, onPhase: vi.fn() };
}

/** Invalid structures remain rejected even when complete faithful prose survives. */
function expectCleanedTextOnly(value: { blocks: unknown[]; proposal: unknown }, transcript: string) {
  expect(() => parseDictationProposal(value.proposal, transcript)).toThrow();
  expect(parseDictationResult(value, transcript)).toEqual({ blocks: value.blocks, proposal: null });
}

describe("dictation cleanup and recovery", () => {
  it("saves the exact original before sending the finished transcript for cleanup", async () => {
    const input = options();
    let resolveSave!: (value: string) => void;
    input.preserveOriginal.mockReturnValue(new Promise<string>(resolve => { resolveSave = resolve; }));
    const pending = prepareDictation(input);
    expect(input.clean).not.toHaveBeenCalled();
    resolveSave("source-original");
    expect(await pending).toMatchObject({ original: raw, sourceId: "source-original", blocks });
    expect(input.clean).toHaveBeenCalledTimes(1);
    expect(input.onPhase.mock.calls.map(call => call[0])).toEqual(["saving", "cleaning"]);
  });

  it.each(["missing-key", "too-long", "save-failed", "provider-failed", "malformed-result"])("keeps complete local text when %s", async reason => {
    const input = options();
    if (reason === "missing-key") input.aiAvailable = false;
    if (reason === "too-long") input.transcript = "語".repeat(MAX_DICTATION_CLEANUP_CHARS + 1);
    if (reason === "save-failed") input.preserveOriginal.mockRejectedValue(new Error("Disk full"));
    if (reason === "provider-failed") input.clean.mockRejectedValue(new Error("Offline"));
    if (reason === "malformed-result") input.clean.mockResolvedValue([{ kind: "heading", text: "Wrong" }]);
    const result = await prepareDictation(input);
    expect(result.original).toBe(input.transcript);
    expect(result.blocks).toBeUndefined();
    if (["missing-key", "too-long", "save-failed"].includes(reason)) expect(input.clean).not.toHaveBeenCalled();
    if (reason === "missing-key") expect(input.onPhase.mock.calls.map(call => call[0])).toEqual(["saving"]);
  });

  it.each([MAX_DICTATION_CLEANUP_CHARS, MAX_DICTATION_CLEANUP_CHARS + 1])("counts astral Unicode characters at input length %s", async count => {
    const input = options();
    input.transcript = "🙂".repeat(count);
    const faithful = [{ kind: "paragraph", text: input.transcript }];
    input.clean.mockResolvedValue({ blocks: faithful });
    const result = await prepareDictation(input);
    expect(result.original).toBe(input.transcript);
    if (count === MAX_DICTATION_CLEANUP_CHARS) {
      expect(result.blocks).toEqual(faithful);
      expect(input.clean).toHaveBeenCalledOnce();
    } else {
      expect(result.blocks).toBeUndefined();
      expect(input.clean).not.toHaveBeenCalled();
    }
  });

  it.each(["skip", "timeout"])("stops waiting on %s and ignores a late cleanup response", async reason => {
    vi.useFakeTimers();
    const input = options(), controller = new AbortController();
    input.signal = controller.signal;
    let nativeSignal: AbortSignal | undefined, resolveClean!: (value: typeof blocks) => void;
    input.clean.mockImplementation((signal: AbortSignal) => { nativeSignal = signal; return new Promise(resolve => { resolveClean = resolve; }); });
    const pending = prepareDictation(input);
    await Promise.resolve();
    if (reason === "skip") controller.abort();
    else await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS);
    expect(await pending).toMatchObject({ original: raw, sourceId: "source-original" });
    expect((await pending).blocks).toBeUndefined();
    expect(nativeSignal?.aborted).toBe(true);
    resolveClean(blocks);
    await Promise.resolve();
    expect((await pending).blocks).toBeUndefined();
  });

  it("does not start cleanup if cancellation happens while announcing the cleanup phase", async () => {
    const input = options(), controller = new AbortController();
    input.signal = controller.signal;
    input.onPhase.mockImplementation(phase => { if (phase === "cleaning") controller.abort(new Error("Use original")); });
    const result = await prepareDictation(input);
    expect(result).toMatchObject({ original: raw, sourceId: "source-original" });
    expect(result.blocks).toBeUndefined();
    expect(input.clean).not.toHaveBeenCalled();
  });

  it("does not call a provider after cancellation while the recovery copy is saving", async () => {
    const input = options(), controller = new AbortController();
    input.signal = controller.signal;
    let save!: (value: string) => void;
    input.preserveOriginal.mockReturnValue(new Promise<string>(resolve => { save = resolve; }));
    const pending = prepareDictation(input);
    controller.abort();
    save("source-original");
    expect(await pending).toMatchObject({ original: raw, sourceId: "source-original" });
    expect(input.clean).not.toHaveBeenCalled();
  });

  it("persists recovery with the originating note through the existing vault format", async () => {
    const source = dictationOriginalSource(note.id, "session-one", raw, now);
    const snapshot = { ...createEmptySnapshot(), notes: [note] };
    const updated = attachDictationOriginal(snapshot, note.id, source);
    expect(updated.notes[0].body).toBe(note.body);
    expect(snapshot.notes[0].sourceIds).toEqual([]);
    expect(updated.notes[0].sourceIds).toEqual([source.id]);
    expect(attachDictationOriginal(updated, note.id, source)).toBe(updated);
    expect(() => attachDictationOriginal(createEmptySnapshot(), note.id, source)).toThrow();
    expect(() => attachDictationOriginal(updated, note.id, { ...source, text: "Replacement" })).toThrow();
    const vault = { ...createEmptyVault(), activeSpaceId: updated.workspace.id, spaces: [updated] };
    await saveSnapshot(vault);
    const recovered = (await loadSnapshot())!.spaces[0];
    expect(recovered.sources[0].text).toBe(raw);
    expect(recovered.notes[0].sourceIds).toContain(source.id);
  });

  it("rejects new actions, invalid blocks, severe loss and inflated output while retaining literal symbols", () => {
    expect(parseDictationCleanup({ blocks }, raw)).toEqual(blocks);
    expect(parseDictationCleanup({ blocks: [{ kind: "paragraph", text: "Literal <tag> & [word](url)." }] }, raw)[0].text).toContain("<tag>");
    for (const invalid of [
      { blocks, noteActions: [] }, { blocks: [] }, { blocks: [{ kind: "todo", text: "Email Sam", checked: true }] },
      { blocks: [{ kind: "paragraph", text: "\u0000" }] }, { blocks: [{ kind: "paragraph", text: "A\nB" }] },
      { blocks: [{ kind: ["paragraph"], text: "Coerced kind" }] },
      { blocks: Array.from({ length: 257 }, () => blocks[0]) },
    ]) expect(() => parseDictationCleanup(invalid, raw)).toThrow();
    expect(() => parseDictationCleanup({ blocks }, "x".repeat(1_000))).toThrow();
    expect(() => parseDictationCleanup({ blocks: [{ kind: "paragraph", text: "x".repeat(200) }] }, "x")).toThrow();
  });
});

describe("hybrid dictation proposals", () => {
  const evidence = "Make a ticket to ask Jo about the venue, due Friday—actually Thursday.";
  const transcript = `The launch needs a smaller venue. ${evidence} I’m still unsure whether a smaller event is right.`;
  const faithful = [{ kind: "paragraph" as const, text: "The launch needs a smaller venue. Make a ticket to ask Jo about the venue, due Thursday. I’m still unsure whether a smaller event is right." }];
  const ticket: DictationTicketBlock = { kind: "ticket", text: "Ask Jo about the venue", evidence, boardName: "Launch", dueDate: "2026-11-19", urgency: "" };
  const proposal = { blocks: [
    { kind: "paragraph" as const, text: "The launch needs a smaller venue." }, ticket,
    { kind: "paragraph" as const, text: "I’m still unsure whether a smaller event is right." },
  ] };
  const result = () => ({ blocks: faithful, proposal });

  it("keeps faithful text separate from inert interleaved ticket proposals", () => {
    expect(parseDictationResult(result(), transcript)).toEqual(result());
    expect(parseDictationResult({ blocks: faithful }, transcript)).toEqual({ blocks: faithful });
    expect(parseDictationResult({ blocks: faithful, proposal: null }, transcript)).toEqual({ blocks: faithful, proposal: null });
    expect(() => parseDictationCleanup(result(), transcript)).toThrow();
  });
  it('requires exact speech evidence and bounded literal child checklist items, falling back without losing prose',()=>{
    const withChildren={...ticket,checklist:[{text:'Ask Jo about the venue',evidence:'ask Jo about the venue'}]};
    expect(parseDictationProposal({blocks:[withChildren]},transcript).blocks[0]).toEqual(withChildren);
    for(const checklist of [[{text:'Invented',evidence:'not spoken'}],[{text:'Call',evidence,completed:true}],Array.from({length:33},()=>({text:'Call Jo',evidence}))]){
      expect(parseDictationResult({...result(),proposal:{blocks:[{...ticket,checklist}]}},transcript)).toEqual({blocks:faithful,proposal:null});
    }
  });

  it("accepts expanded native proposals and discards provider-only references without discarding faithful prose", () => {
    const value = { blocks: [proposal.blocks[0], { kind: "paragraph", text: evidence }, proposal.blocks[2]], proposal };
    expect(parseDictationResult(value, transcript)).toEqual(value);
    expectCleanedTextOnly({ ...value, proposal: { blocks: [{ kind: "keep", index: 0 }, ticket] } }, transcript);
    expectCleanedTextOnly({ ...value, proposal: { blocks: [{ ...ticket, sourceIndices: [0, 1, 2] }] } }, transcript);
  });

  it("sends only the transcript, selected model and captured local date across IPC", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const settings = { ...createEmptySnapshot().settings, notes: [note], workspaceName: "Private Space", boardId: "model-must-not-receive" };
    invokeTauriMock.mockResolvedValue(result());
    const response = await cleanUpDictation(transcript, settings, new AbortController().signal, "2026-11-13");
    expect(response).toEqual(result());
    expect(invokeTauriMock).toHaveBeenCalledExactlyOnceWith("cleanup_dictation", { request: {
      requestId: expect.stringMatching(/^dictation:/), transcript,
      model: settings.model, effort: settings.reasoningEffort, referenceDate: "2026-11-13",
    } });
  });

  it("rejects malformed recording dates before IPC and leaves absent dates absent", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    const settings = createEmptySnapshot().settings, signal = new AbortController().signal;
    for (const date of ["", "2026-02-29", "0999-12-31", "2026-11-13T00:00:00Z", " 2026-11-13"]) {
      await expect(cleanUpDictation(transcript, settings, signal, date)).rejects.toThrow("The dictation date is invalid.");
    }
    expect(invokeTauriMock).not.toHaveBeenCalled();
    invokeTauriMock.mockResolvedValue(result());
    await cleanUpDictation(transcript, settings, signal);
    expect(invokeTauriMock.mock.calls[0][1].request).not.toHaveProperty("referenceDate");
  });

  it("archives once and returns a validated proposal without executing or adding another provider pass", async () => {
    const input = options();
    input.transcript = transcript;
    input.clean.mockResolvedValue(result());
    const prepared = await prepareDictation(input);
    expect(prepared).toMatchObject({ original: transcript, sourceId: "source-original", blocks: faithful, proposal });
    expect(input.preserveOriginal).toHaveBeenCalledOnce();
    expect(input.clean).toHaveBeenCalledOnce();
    expect(input.onPhase.mock.calls.map(call => call[0])).toEqual(["saving", "cleaning"]);
  });

  it("keeps complete cleaned text without another request when a proposal is malformed", async () => {
    const input = options();
    input.transcript = transcript;
    input.clean.mockResolvedValue({ blocks: faithful, proposal: { blocks: [{ ...ticket, boardId: "invented-target" }] } });
    expect(await prepareDictation(input)).toEqual({ original: transcript, sourceId: "source-original", blocks: faithful,
      notice: "Dictation cleaned up and inserted. Original saved." });
    expect(input.clean).toHaveBeenCalledOnce();
    expect(input.preserveOriginal).toHaveBeenCalledOnce();
  });

  it("still rejects a bad envelope or untrustworthy faithful alternative even when a ticket is valid", async () => {
    for (const invalid of [
      { ...result(), actions: [] }, { proposal },
      { ...result(), blocks: [] }, { ...result(), blocks: [{ kind: "ticket", text: "Ask Jo" }] },
      { ...result(), blocks: [{ kind: "paragraph", text: "Ask\u0085Jo" }] },
      { ...result(), blocks: [{ kind: "paragraph", text: "x".repeat(1_000) }] },
    ]) {
      expect(() => parseDictationResult(invalid, transcript)).toThrow();
      const input = options();
      input.transcript = transcript;
      input.clean.mockResolvedValue(invalid);
      const prepared = await prepareDictation(input);
      expect(prepared.original).toBe(transcript);
      expect(prepared.blocks).toBeUndefined();
      expect(prepared.proposal).toBeUndefined();
    }
  });

  it("accepts exact multiline evidence and literal symbols while trimming bounded display fields", () => {
    const source = "Make a ticket\n to check <tag> and **literal words**.";
    const value = { blocks: [{ kind: "paragraph", text: source.replace("\n", " ") }], proposal: { blocks: [{
      ...ticket, text: "  Check <tag> and **literal words**.  ", evidence: `  ${source}  `, boardName: "  Launch  ", dueDate: " 2026-11-19 ",
    }] } };
    expect(parseDictationResult(value, source).proposal?.blocks).toEqual([{
      ...ticket, text: "Check <tag> and **literal words**.", evidence: source, boardName: "Launch", dueDate: "2026-11-19",
    }]);
  });

  it("rejects unsupported actions, invented evidence, target IDs and invalid optional fields", () => {
    const invalidBlocks = [
      { ...ticket, kind: "deleteTicket" }, { ...ticket, noteId: "other-note" }, { ...ticket, boardId: "other-board" },
      { ...ticket, evidence: "Make a ticket for something never said." }, { ...ticket, evidence: "" },
      { ...ticket, dueDate: "2026-02-30" }, { ...ticket, dueDate: "0999-12-31" }, { ...ticket, dueDate: "next Thursday" },
      { ...ticket, urgency: "critical" }, { ...ticket, urgency: "High" }, { ...ticket, checked: true },
      { ...ticket, text: "x".repeat(141) }, { ...ticket, text: "bad\ntext" }, { ...ticket, text: "\u007f" },
      { ...ticket, text: "\nCall Jo" }, { ...ticket, boardName: "\tLaunch" },
      { ...ticket, boardName: "x".repeat(141) }, { ...ticket, boardName: "Launch\nOther" },
      Object.fromEntries(Object.entries(ticket).filter(([key]) => key !== "dueDate")),
      { kind: "paragraph", text: "Keep this", href: "https://example.com" },
    ];
    for (const block of invalidBlocks) {
      expectCleanedTextOnly({ blocks: faithful, proposal: { blocks: [block] } }, transcript);
    }
    expect(() => parseDictationResult({ ...result(), actions: [] }, transcript)).toThrow();
    for (const invalid of [
      { ...result(), proposal: [] }, { ...result(), proposal: { blocks: [], targetNote: "other" } },
      { ...result(), proposal: { blocks: faithful } }, { ...result(), proposal: { blocks: [ticket], tool: "create_ticket" } },
    ]) expectCleanedTextOnly(invalid, transcript);
    const controlEvidence = `Make a ticket\u0085to call Jo.`;
    expect(() => parseDictationResult({ blocks: [{ kind: "paragraph", text: controlEvidence }], proposal: { blocks: [{ ...ticket, evidence: controlEvidence }] } }, controlEvidence)).toThrow();
  });

  it("bounds proposal counts, evidence and visible output while allowing instructions to shrink", () => {
    const longInstruction = `Make a ticket to call Jo. ${"Further spoken details. ".repeat(25)}`;
    const value = { blocks: [{ kind: "paragraph", text: longInstruction }], proposal: { blocks: [{ ...ticket, text: "Call Jo", evidence: "Make a ticket to call Jo." }] } };
    expect(parseDictationResult(value, longInstruction).proposal?.blocks[0].text).toBe("Call Jo");
    expectCleanedTextOnly({ ...result(), proposal: { blocks: Array.from({ length: 33 }, () => ticket) } }, transcript);
    expectCleanedTextOnly({ ...result(), proposal: { blocks: [ticket, ...Array.from({ length: 256 }, () => ({ kind: "bullet", text: "a" }))] } }, transcript);
    expectCleanedTextOnly({ ...result(), proposal: { blocks: [ticket, { kind: "paragraph", text: "x".repeat(2_000) }] } }, transcript);
    const tooLongEvidence = "語".repeat(2_001);
    expectCleanedTextOnly({ blocks: [{ kind: "paragraph", text: tooLongEvidence }], proposal: { blocks: [{ ...ticket, evidence: tooLongEvidence }] } }, tooLongEvidence);
    const largeSource = "語".repeat(20_000);
    expectCleanedTextOnly({ blocks: [{ kind: "paragraph", text: largeSource }], proposal: { blocks: [{ ...ticket, evidence: "語" }, { kind: "paragraph", text: "語".repeat(32_000) }] } }, largeSource);
    const unicodeTitle = "語".repeat(140);
    expect(parseDictationResult({ blocks: [{ kind: "paragraph", text: unicodeTitle }], proposal: { blocks: [{ ...ticket, text: unicodeTitle, evidence: "語" }] } }, unicodeTitle).proposal?.blocks[0].text).toBe(unicodeTitle);
  });

  it("does not resurrect a proposal returned after Use original", async () => {
    const input = options(), controller = new AbortController();
    input.transcript = transcript;
    input.signal = controller.signal;
    let finish!: (value: ReturnType<typeof result>) => void;
    input.clean.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = prepareDictation(input);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ original: transcript, sourceId: "source-original" });
    finish(result());
    await Promise.resolve();
    expect((await pending).proposal).toBeUndefined();
    expect((await pending).blocks).toBeUndefined();
  });

  it("resolves only a unique exact board title from the caller's Space", () => {
    const boards = [{ id: "board-one", title: "Launch plan" }, { id: "board-two", title: "Research" }];
    expect(resolveDictationBoard(" LAUNCH   plan ", boards)).toBe("board-one");
    expect(resolveDictationBoard("Ｌａｕｎｃｈ plan", boards)).toBe("board-one");
    expect(resolveDictationBoard("Launch", boards)).toBe("");
    expect(resolveDictationBoard("", boards)).toBe("");
    expect(resolveDictationBoard("Launch plan", [...boards, { id: "board-three", title: "Launch Plan" }])).toBe("");
    expect(resolveDictationBoard("Launch plan", [...boards, { id: "board-one", title: "Other board" }])).toBe("");
    expect(resolveDictationBoard("Launch plan", [])).toBe("");
  });
});


describe("mixed dictation structures", () => {
  const original = "For the release, fix the menu and test updates. Remember to bring a notebook. The Small edition is 500 MB and Medium is 1.5 GB. Make a ticket to call Jo.";
  const child = { text: "Fix the menu", evidence: "fix the menu", dueDate: "", urgency: "" };
  const board = { kind: "kanban", text: "Release", evidence: "For the release, fix the menu and test updates.", tickets: [child, { ...child, text: "Test updates", evidence: "test updates" }] };
  const table = { kind: "table", text: "", evidence: "The Small edition is 500 MB and Medium is 1.5 GB.", columns: ["Edition", "Size", "Notes"], rows: [["Small", "500 MB", ""], ["Medium", "1.5 GB", ""]] };
  const response = (blocks: unknown[]) => ({ blocks: [{ kind: "paragraph", text: original }], proposal: { blocks } });

  it("accepts one response mixing prose, boards, todos, tables and standalone tickets", () => {
    const blocks = [
      { kind: "paragraph", text: "For the release:" }, board,
      { kind: "todo", text: "Bring a notebook" }, table,
      { kind: "ticket", ...child, text: "Call Jo", evidence: "Make a ticket to call Jo.", boardName: "" },
    ];
    expect(parseDictationResult(response(blocks), original).proposal?.blocks).toEqual(blocks);
    expect(parseDictationResult(response([{ ...board, tickets: [] }]), original).proposal?.blocks).toHaveLength(1);
  });

  it("rejects malformed tables and board children, unknown fields and nonliteral content", () => {
    for (const block of [
      { ...board, id: "model-id" }, { ...board, text: "" }, { ...board, evidence: "invented" },
      { ...board, tickets: [{ ...child, status: "done" }] },
      { ...board, tickets: [{ ...child, boardId: "elsewhere" }] },
      { ...board, tickets: [{ ...child, evidence: "invented" }] },
      { ...board, tickets: [{ ...child, dueDate: "2026-02-30" }] },
      { ...board, tickets: [{ ...child, urgency: "critical" }] },
      { ...board, tickets: [{ ...child, text: "bad\ntext" }] },
      { ...table, rows: [["Only one cell"]] }, { ...table, columns: [""] },
      { ...table, rows: [] }, { ...table, columns: [] }, { ...table, evidence: "invented" },
      { ...table, rows: [["Small", "500 MB", { html: "<b>value</b>" }]] },
      { ...table, rows: [["Small", "500 MB", "bad\u0085text"]] },
      { ...table, rows: [["Small", "500 MB", "a".repeat(501)]] },
      { ...table, rows: Array.from({ length: 21 }, () => ["a", "b", "c"]) },
      { ...table, columns: Array.from({ length: 13 }, () => "Header"), rows: [Array.from({ length: 13 }, () => "")] },
    ]) expectCleanedTextOnly(response([block]), original);
  });

  it("counts nested tickets and every table cell toward bounded output", () => {
    const big = "fix the menu. ".repeat(500).trim();
    const value = (blocks: unknown[]) => ({ blocks: [{ kind: "paragraph", text: big }], proposal: { blocks } });
    const smallBoard = { ...board, evidence: "fix the menu", tickets: [child] };
    expectCleanedTextOnly(value(Array.from({ length: 5 }, () => smallBoard)), big);
    expectCleanedTextOnly(value([{ ...smallBoard, tickets: Array.from({ length: 32 }, () => child) }, { ...smallBoard, tickets: [child] }]), big);
    const smallTable = { ...table, evidence: "fix the menu", columns: ["Name"], rows: [["Value"]] };
    expectCleanedTextOnly(value(Array.from({ length: 5 }, () => smallTable)), big);
    expectCleanedTextOnly(value([{ ...smallTable, columns: Array.from({ length: 12 }, () => "Name"), rows: Array.from({ length: 20 }, () => Array.from({ length: 12 }, () => "a".repeat(200))) }]), big);
    expect(parseDictationResult(value([{ ...smallBoard, tickets: Array.from({ length: 32 }, () => child) }]), big).proposal?.blocks).toHaveLength(1);
  });
});
