import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyVault } from "../../data/defaults";
import type { AssistantClaim, WorkflowDependencies, WorkflowResult } from "./types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), execute: vi.fn(), chat: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./workflows", () => ({ executeAssistantWorkflow: mocks.execute }));
vi.mock("../storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../storage")>(), chatWithOrion: mocks.chat,
}));
import { startAssistantExecutor } from "./executor";

afterEach(() => { vi.useRealTimers(); mocks.invoke.mockReset(); mocks.execute.mockReset(); mocks.chat.mockReset(); });

function setup(operation: "context" | "generate" = "context") {
  const space = createEmptyVault().spaces[0];
  space.settings.assistantAccess = { enabled: true, allowAI: true, allowWrites: true, spaceIds: [space.workspace.id] };
  const claim: AssistantClaim = { id: "job-test", request: operation === "context"
    ? { space_id: space.workspace.id, request_id: "read", operation: "context", input: { query: "Find" } }
    : { space_id: space.workspace.id, request_id: "write", operation: "generate", input: { kind: "note", instruction: "Write" } } };
  const host = {
    getSpace: vi.fn(() => space), prepareSpace: vi.fn(async () => ({ snapshot: space, revision: "persisted-revision" })),
    commit: vi.fn(async () => {}), onActivity: vi.fn(), onComplete: vi.fn(),
  };
  let polled = false;
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "assistant_poll") {
      const jobs = polled ? [] : [claim]; polled = true;
      return { jobs, activity: [], stoppedJobIds: [] };
    }
    return undefined;
  });
  return { space, claim, host };
}

describe("desktop executor lifecycle", () => {
  it("freezes the persisted revision before executing and finishes read-only work without a commit", async () => {
    const { host } = setup();
    mocks.execute.mockResolvedValue({ result: { evidence: [] } });
    const stop = startAssistantExecutor(host);
    try {
      await vi.waitFor(() => expect(host.onComplete).toHaveBeenCalledOnce());
      const commands = mocks.invoke.mock.calls.map(([command]) => command);
      expect(commands.indexOf("assistant_begin_context")).toBeLessThan(commands.indexOf("assistant_finish"));
      expect(mocks.invoke).toHaveBeenCalledWith("assistant_begin_context", expect.objectContaining({ expectedUpdatedAt: "persisted-revision" }));
      expect(host.commit).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith("assistant_finish", expect.objectContaining({ result: expect.objectContaining({ evidence: [], execution: expect.objectContaining({ scheduledAIRequests: 0 }) }) }));
    } finally { stop(); }
  });
  it("does not report a saved result when the atomic host commit fails", async () => {
    const { space, host } = setup("generate");
    mocks.execute.mockResolvedValue({ result: { notes: [] }, snapshot: space });
    host.commit.mockRejectedValue(new Error("A newer library revision exists."));
    const stop = startAssistantExecutor(host);
    try {
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("assistant_finish", expect.objectContaining({ error: "A newer library revision exists." })));
      expect(host.onComplete).not.toHaveBeenCalled();
      expect(mocks.invoke.mock.calls.some(([command, args]) => command === "assistant_finish" && args.result)).toBe(false);
    } finally { stop(); }
  });
  it("forwards the reading deadline signal to the provider and retains job cancellation for callers without one", async () => {
    const { host } = setup();
    const reader = new AbortController();
    let dependencies!: WorkflowDependencies;
    const request = { mode: "chat-reading" as const, prompt: "Find the evidence", workspaceName: "Space",
      notes: [], sources: [], concepts: [], history: [] };
    mocks.chat.mockResolvedValueOnce({ reply: "First stage" });
    mocks.chat.mockImplementationOnce((_request, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    mocks.execute.mockImplementation(async (_space, _request, deps: WorkflowDependencies) => {
      dependencies = deps;
      await deps.chat(request);
      await deps.chat(request, reader.signal);
      return { result: { answer: "Should not finish after the reader deadline" } };
    });
    const stop = startAssistantExecutor(host);
    try {
      await vi.waitFor(() => expect(mocks.chat).toHaveBeenCalledTimes(2));
      expect(mocks.chat.mock.calls[0][1]).toBe(dependencies.signal);
      expect(mocks.chat.mock.calls[1][1]).toBe(reader.signal);
      expect(dependencies.signal.aborted).toBe(false);
      reader.abort(new Error("The search reading deadline expired."));
      await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("assistant_finish",
        expect.objectContaining({ error: "The search reading deadline expired." })));
      expect(host.onComplete).not.toHaveBeenCalled();
      expect(host.commit).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("cancels late output and stays busy until the executing stage settles", async () => {
    vi.useFakeTimers();
    const { space, claim, host } = setup("generate");
    let resolve!: (result: WorkflowResult) => void;
    let dependencies!: WorkflowDependencies;
    mocks.execute.mockImplementation((_space, _request, deps) => { dependencies = deps; return new Promise<WorkflowResult>((done) => { resolve = done; }); });
    const stop = startAssistantExecutor(host);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.execute).toHaveBeenCalledOnce();
      mocks.invoke.mockImplementation(async (command: string, args) => {
        if (command === "assistant_poll") {
          expect(args.ready).toBe(false);
          return { jobs: [], activity: [], stoppedJobIds: [claim.id] };
        }
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(dependencies.signal.aborted).toBe(true);
      resolve({ result: { notes: [] }, snapshot: space });
      await vi.advanceTimersByTimeAsync(1);
      expect(host.commit).not.toHaveBeenCalled(); expect(host.onComplete).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith("assistant_finish", expect.objectContaining({ error: "The desktop workflow stopped." }));
    } finally { stop(); }
  });
});
