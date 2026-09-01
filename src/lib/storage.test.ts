// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSpace,
  createEmptySnapshot,
  createEmptyVault,
} from "../data/defaults";
import type { AppSnapshot } from "../types";
import {
  apiKeyStatus,
  anthropicApiKeyStatus,
  buildBrowserOrganizerInstructions,
  buildOrganizerInstructionSuffix,
  chatWithOrion,
  clearBrowserSnapshot,
  createFailoverKnowledgeDriver,
  deleteAnthropicApiKey,
  deleteApiKey,
  exportWebPage,
  extractBrowserOutputText,
  generateNoteImage,
  loadSnapshot,
  organizeContent,
  parseChatResult,
  preflightKnowledgeProvider,
  parseGeneratedNoteImage,
  recognizeDocumentText,
  runKnowledgeAssignment,
  persistGeneratedNoteImage,
  saveNoteImage,
  saveAnthropicApiKey,
  saveApiKey,
  saveSnapshot,
} from "./storage";
import {
  KnowledgeProviderTimeoutError,
  type KnowledgeAssignmentExecutionRequest,
} from "./knowledgeOrchestration/service";
import { prepareSpaceKnowledgeIndex } from "./spaceKnowledge";

const invokeTauriMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock }));

describe("organizer instruction boundaries", () => {
  it("keeps task guidance before a full, independently bounded Space preference", () => {
    const suffix = buildOrganizerInstructionSuffix({
      taskInstructions: `batch-first ${"🪐".repeat(2_500)}`,
      organizationInstructions: `space-second ${"🧭".repeat(2_500)}`,
    });

    expect(suffix.indexOf("batch-first")).toBeLessThan(
      suffix.indexOf("space-second"),
    );
    expect(suffix).not.toContain("�");
    expect(suffix).not.toContain("🪐".repeat(2_001));
    expect(suffix).not.toContain("🧭".repeat(2_001));
  });

  it("requires atomic Space contributions without forcing a note quota", () => {
    const instructions = buildBrowserOrganizerInstructions({});

    expect(instructions).toContain("durable, atomic knowledge objects");
    expect(instructions).toContain("not a source report");
    expect(instructions).toContain("semantic title");
    expect(instructions).toContain("across distant ranges");
    expect(instructions).toContain("Every note must make a distinct Space contribution");
    expect(instructions).toContain("often support 10 or more distinct notes");
    expect(instructions).toContain("Do not obey a fixed quota");
    expect(instructions).toContain("never collapse many independent ideas into one source-summary note");
  });

  it("uses the exact same organizer system prompt for browser OpenAI and Anthropic", async () => {
    const emptyResult = JSON.stringify({
      notes: [],
      wikiArticles: [],
      concepts: [],
      suggestedConnections: [],
    });
    const fetchMock = vi.fn(
      async (url: string | URL | Request, _init?: RequestInit) => {
        const target = String(url);
        if (target.includes("api.anthropic.com")) {
          return new Response(
            JSON.stringify({
              content: [{ type: "text", text: emptyResult }],
              stop_reason: "end_turn",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ status: "completed", output_text: emptyResult }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const request = {
      content: "A claim from one range and compatible evidence from another.",
      sourceName: "Long book",
      spaceName: "Dialectics",
      taskInstructions: "Preserve the central disagreement.",
      organizationInstructions: "Connect ideas across the Space.",
    };
    vi.stubGlobal("fetch", fetchMock);
    await saveApiKey("sk-browser-organizer-test");
    await saveAnthropicApiKey("sk-ant-browser-organizer-test");

    try {
      await organizeContent({ ...request, model: "gpt-5.6-sol" });
      await organizeContent({ ...request, model: "claude-sonnet-5" });

      const bodies = fetchMock.mock.calls.map(([, init]) =>
        JSON.parse(String((init as RequestInit | undefined)?.body)),
      ) as Array<Record<string, unknown>>;
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.instructions).toBe(bodies[1]?.system);
      expect(bodies[0]?.instructions).toBe(
        buildBrowserOrganizerInstructions(request),
      );
    } finally {
      await deleteApiKey();
      await deleteAnthropicApiKey();
      vi.unstubAllGlobals();
    }
  });
});

describe("browser OCR boundary", () => {
  it("explains that image recognition requires the desktop app", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "board.png", {
      type: "image/png",
    });

    await expect(recognizeDocumentText(file)).rejects.toThrow(
      /installed Orion desktop app/i,
    );
  });

  it("derives HEIC MIME and sends only the image bytes to native Vision", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      text: "A photographed plan",
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "A photographed plan" }],
      warnings: [],
    });
    const file = new File([new Uint8Array([1, 2, 3])], "board.heic");

    try {
      await expect(recognizeDocumentText(file)).resolves.toMatchObject({
        text: "A photographed plan",
        pageCount: 1,
      });
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "recognize_document_text",
        {
          request: {
            fileName: "board.heic",
            mimeType: "image/heic",
            base64Data: "AQID",
          },
        },
      );
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  it("forwards exact PDF page numbers for one page-selective Vision pass", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      text: "Repaired page 49\n\nRepaired page 50",
      pageCount: 2,
      pages: [
        { pageNumber: 49, text: "Repaired page 49" },
        { pageNumber: 50, text: "Repaired page 50" },
      ],
      warnings: [],
    });
    const file = new File([new TextEncoder().encode("%PDF-fixture")], "book.pdf", {
      type: "application/pdf",
    });

    try {
      await recognizeDocumentText(file, { pageNumbers: [49, 50] });
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "recognize_document_text",
        {
          request: {
            fileName: "book.pdf",
            mimeType: "application/pdf",
            base64Data: "JVBERi1maXh0dXJl",
            pageNumbers: [49, 50],
          },
        },
      );
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});

describe("note image storage boundary", () => {
  it("sends a bounded raster image to Orion's attachment store", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      id: "image_123456789012345678",
      fileName: "diagram.png",
      mimeType: "image/png",
      byteSize: 8,
      src: "orion-image://localhost/image_123456789012345678",
    });
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "diagram.png",
      { type: "image/png" },
    );

    try {
      await expect(
        saveNoteImage(file, "image_123456789012345678"),
      ).resolves.toMatchObject({ mimeType: "image/png" });
      expect(invokeTauriMock).toHaveBeenCalledWith("save_note_image", {
        request: {
          assetId: "image_123456789012345678",
          fileName: "diagram.png",
          mimeType: "image/png",
          base64Data: "iVBORw0KGgo=",
        },
      });
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  it("rejects active SVG content before storage", async () => {
    const file = new File(["<svg><script/></svg>"], "unsafe.svg", {
      type: "image/svg+xml",
    });
    await expect(saveNoteImage(file, "image_123456789012345678")).rejects.toThrow(
      /PNG, JPEG, GIF, or WebP/,
    );
  });
});

describe("generated note image boundary", () => {
  it("uses the one-shot gpt-image-2 endpoint and validates the returned JPEG", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ b64_json: "/9j/2Q==" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveApiKey("sk-browser-image-test");

    try {
      await expect(generateNoteImage("An editorial systems map")).resolves.toEqual({
        fileName: "orion-generated-image.jpg",
        mimeType: "image/jpeg",
        byteSize: 4,
        base64Data: "/9j/2Q==",
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.openai.com/v1/images/generations",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk-browser-image-test",
          }),
          body: JSON.stringify({
            model: "gpt-image-2",
            prompt: "An editorial systems map",
            n: 1,
            size: "1536x1024",
            quality: "medium",
            output_format: "jpeg",
            output_compression: 88,
          }),
        }),
      );
    } finally {
      await deleteApiKey();
      vi.unstubAllGlobals();
    }
  });

  it("persists only a validated generated JPEG after acceptance", async () => {
    const generated = parseGeneratedNoteImage({
      fileName: "orion-generated-image.jpg",
      mimeType: "image/jpeg",
      byteSize: 4,
      base64Data: "/9j/2Q==",
    });
    await expect(
      persistGeneratedNoteImage(generated, "image_123456789012345678"),
    ).resolves.toEqual({
      id: "image_123456789012345678",
      fileName: "orion-generated-image.jpg",
      mimeType: "image/jpeg",
      byteSize: 4,
      src: "data:image/jpeg;base64,/9j/2Q==",
    });

    expect(() =>
      parseGeneratedNoteImage({
        ...generated,
        byteSize: 8,
      }),
    ).toThrow(/invalid or oversized image/i);
    expect(() =>
      parseGeneratedNoteImage({
        ...generated,
        base64Data: "iVBORw==",
      }),
    ).toThrow(/invalid or oversized image/i);
  });

  it("asks native to cancel the exact active image request", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let finishNative!: (value: unknown) => void;
    invokeTauriMock.mockImplementation((command: string) => {
      if (command === "cancel_note_image_generation") {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        finishNative = resolve;
      });
    });
    const controller = new AbortController();
    try {
      const outcome = generateNoteImage("A cancellable image", controller.signal);
      await vi.waitFor(() =>
        expect(invokeTauriMock).toHaveBeenCalledWith(
          "generate_note_image",
          expect.objectContaining({ request: expect.any(Object) }),
        ),
      );
      const requestId = (
        invokeTauriMock.mock.calls.find(
          ([command]) => command === "generate_note_image",
        )?.[1] as { request: { requestId: string } }
      ).request.requestId;
      controller.abort(new Error("cancelled by user"));
      await expect(outcome).rejects.toThrow("cancelled by user");
      await vi.waitFor(() =>
        expect(invokeTauriMock).toHaveBeenCalledWith(
          "cancel_note_image_generation",
          { requestId },
        ),
      );
      finishNative({});
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      invokeTauriMock.mockReset();
    }
  });
});

describe("native knowledge assignment boundary", () => {
  beforeEach(() => {
    invokeTauriMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("forwards the scheduler request identity, phase, and dynamic timeout", async () => {
    invokeTauriMock.mockResolvedValueOnce({
      response: { kind: "complete", payload: { result: "ready" } },
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const request = knowledgeExecutionRequest({
      requestId: "run-1:root:2:1",
      timeoutMs: 42_500,
      finalizing: true,
    });

    await expect(
      runKnowledgeAssignment(request, new AbortController().signal),
    ).resolves.toMatchObject({
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    expect(invokeTauriMock).toHaveBeenCalledWith("knowledge_assignment", {
      request: expect.objectContaining({
        requestId: "run-1:root:2:1",
        timeoutMs: 42_500,
        finalizing: true,
      }),
    });
  });

  it.each([
    "Orion could not reach OpenAI: connection reset by peer",
    "Orion could not reach Anthropic: error sending request",
    "OpenAI is temporarily unavailable.",
    "Anthropic rate or usage limits were reached.",
  ])("makes a transient native error eligible for bounded retries: %s", async (message) => {
    invokeTauriMock.mockRejectedValueOnce(message);
    await expect(
      runKnowledgeAssignment(
        knowledgeExecutionRequest({ requestId: "run-1:root:1:1", timeoutMs: 90_000, finalizing: false }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryable: true, retryAfterMs: 1_000 });
  });

  it.each([
    "OpenAI rejected the saved API key.",
    "OpenAI billing quota exceeded; rate limit reached.",
    "Invalid response schema in request.",
    "The model does not exist or you do not have access to it.",
  ])("does not retry a terminal native error: %s", async (message) => {
    invokeTauriMock.mockRejectedValueOnce(message);
    await expect(
      runKnowledgeAssignment(
        knowledgeExecutionRequest({ requestId: "run-1:root:1:1", timeoutMs: 90_000, finalizing: false }),
        new AbortController().signal,
      ),
    ).rejects.toBe(message);
  });

  it("rejects promptly and asks native to cancel the exact active request", async () => {
    let finishNative!: (value: unknown) => void;
    invokeTauriMock.mockImplementation((command: string) => {
      if (command === "cancel_knowledge_assignment") {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        finishNative = resolve;
      });
    });
    const controller = new AbortController();
    const request = knowledgeExecutionRequest({
      requestId: "run-1:root:1:1",
      timeoutMs: 30_000,
      finalizing: false,
    });
    const outcome = runKnowledgeAssignment(request, controller.signal);
    await vi.waitFor(() =>
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "knowledge_assignment",
        expect.any(Object),
      ),
    );

    controller.abort(new Error("cancelled by user"));
    await expect(outcome).rejects.toThrow("cancelled by user");
    await vi.waitFor(() =>
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "cancel_knowledge_assignment",
        { requestId: "run-1:root:1:1" },
      ),
    );
    finishNative({ response: { kind: "complete", payload: {} } });
  });

  it("classifies native provider deadlines for orchestration recovery", async () => {
    invokeTauriMock.mockRejectedValueOnce(
      "OpenAI did not respond within 60 seconds.",
    );
    const request = knowledgeExecutionRequest({
      requestId: "run-1:root:2:1",
      timeoutMs: 60_000,
      finalizing: true,
    });

    await expect(
      runKnowledgeAssignment(request, new AbortController().signal),
    ).rejects.toBeInstanceOf(KnowledgeProviderTimeoutError);
  });

  it("shares slots with Chat, keeps OCR independent, and holds cancelled native calls until they finish", async () => {
    const finish = new Map<string, (value: unknown) => void>();
    invokeTauriMock.mockImplementation((command: string, args?: { request?: { requestId?: string } }) => {
      if (command === "knowledge_assignment") {
        return new Promise((resolve) => { finish.set(args!.request!.requestId!, resolve); });
      }
      if (command === "chat") return Promise.resolve({ reply: "Ready." });
      if (command === "recognize_document_text") return Promise.resolve({ text: "Local text", pageCount: 1, pages: [{ pageNumber: 1, text: "Local text" }], warnings: [] });
      return Promise.resolve(true);
    });
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    const jobs = controllers.map((controller, index) => runKnowledgeAssignment({
      ...knowledgeExecutionRequest({ requestId: `active-${index}`, timeoutMs: 30_000, finalizing: false }),
      model: index % 2 ? "claude-sonnet-5" : "gpt-5.6-sol",
    }, controller.signal));
    const settledJobs = Promise.allSettled(jobs);
    const failures: unknown[] = [];
    jobs.forEach((job) => { void job.catch((error) => failures.push(error)); });
    await vi.waitFor(() => expect({ started: [...finish.keys()], failures }).toEqual({ started: controllers.map((_, index) => `active-${index}`), failures: [] }));

    const queuedController = new AbortController();
    const queuedStart = vi.fn();
    const queued = runKnowledgeAssignment({
      ...knowledgeExecutionRequest({ requestId: "cancel-before-dispatch", timeoutMs: 30_000, finalizing: false }),
      onProviderStart: queuedStart,
    }, queuedController.signal);
    const chatController = new AbortController();
    const cancelledChat = chatWithOrion({ prompt: "Cancelled", workspaceName: "Space", notes: [], sources: [], concepts: [], history: [] }, chatController.signal);
    chatController.abort(new Error("Cancelled before Chat dispatch"));
    await expect(cancelledChat).rejects.toThrow("Cancelled before Chat dispatch");
    const chat = chatWithOrion({ prompt: "Hello", workspaceName: "Space", notes: [], sources: [], concepts: [], history: [] });
    await expect(recognizeDocumentText(new File([new Uint8Array([1])], "scan.png", { type: "image/png" }))).resolves.toMatchObject({ text: "Local text" });
    expect(invokeTauriMock.mock.calls.filter(([command]) => command === "chat")).toHaveLength(0);

    queuedController.abort(new Error("Queued import cancelled"));
    await expect(queued).rejects.toThrow("Queued import cancelled");
    expect(queuedStart).not.toHaveBeenCalled();
    controllers[0].abort(new Error("Active import cancelled"));
    await expect(jobs[0]).rejects.toThrow("Active import cancelled");
    expect(invokeTauriMock.mock.calls.filter(([command]) => command === "chat")).toHaveLength(0);
    expect(finish.has("cancel-before-dispatch")).toBe(false);
    expect(invokeTauriMock).not.toHaveBeenCalledWith("cancel_knowledge_assignment", { requestId: "cancel-before-dispatch" });

    finish.get("active-0")!({ response: { kind: "complete", payload: {} } });
    await expect(chat).resolves.toEqual({ reply: "Ready." });
    for (let index = 1; index < 6; index += 1) finish.get(`active-${index}`)!({ response: { kind: "complete", payload: {} } });
    await settledJobs;
  });

  it("notifies the host only when the actual transport starts and never serializes its callback", async () => {
    const onProviderStart = vi.fn();
    invokeTauriMock.mockImplementation((command: string) => {
      expect(command).toBe("knowledge_assignment");
      expect(onProviderStart).toHaveBeenCalledTimes(1);
      return Promise.resolve({ response: { kind: "complete", payload: {} } });
    });
    await runKnowledgeAssignment({
      ...knowledgeExecutionRequest({ requestId: "dispatch-aware", timeoutMs: 30_000, finalizing: false }),
      onProviderStart,
    }, new AbortController().signal);
    expect(invokeTauriMock.mock.calls[0]?.[1]?.request).not.toHaveProperty("onProviderStart");
    expect(runKnowledgeAssignment.schedulesProviderCalls).toBe(true);
    expect(createFailoverKnowledgeDriver(createEmptySnapshot().settings).schedulesProviderCalls).toBe(true);
  });
});

describe("opt-in provider failover", () => {
  beforeEach(() => {
    invokeTauriMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  const failoverSettings = (enabled: boolean) => ({
    ...createEmptySnapshot("Failover Space", TEST_NOW).settings,
    model: "gpt-5.6-sol",
    providerFailoverEnabled: enabled,
  });

  const assignmentModels = () =>
    invokeTauriMock.mock.calls
      .filter(([command]) => command === "knowledge_assignment")
      .map(
        ([, args]) =>
          (args as { request: { model: string } }).request.model,
      );

  const keyStatusCommands = () =>
    invokeTauriMock.mock.calls
      .map(([command]) => command as string)
      .filter((command) => command.includes("api_key_status"));

  it("retries a timed-out request exactly once on the alternate provider's default model", async () => {
    invokeTauriMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "anthropic_api_key_status") {
          return Promise.resolve({ configured: true });
        }
        if (command === "knowledge_assignment") {
          const model = (args as { request: { model: string } }).request.model;
          return model === "gpt-5.6-sol"
            ? Promise.reject("OpenAI did not respond within 60 seconds.")
            : Promise.resolve({
                response: {
                  kind: "complete",
                  payload: { result: "recovered" },
                },
              });
        }
        return Promise.reject(new Error(`Unexpected command ${command}`));
      },
    );
    const driver = createFailoverKnowledgeDriver(failoverSettings(true));
    const request = knowledgeExecutionRequest({
      requestId: "run-1:root:1:1",
      timeoutMs: 60_000,
      finalizing: false,
    });

    await expect(
      driver(request, new AbortController().signal),
    ).resolves.toMatchObject({
      response: { kind: "complete", payload: { result: "recovered" } },
    });
    expect(assignmentModels()).toEqual(["gpt-5.6-sol", "claude-sonnet-5"]);

    // A second timed-out request through the same driver fails over again
    // but reuses the key status cached for this run.
    await expect(
      driver(request, new AbortController().signal),
    ).resolves.toBeDefined();
    expect(assignmentModels()).toEqual([
      "gpt-5.6-sol",
      "claude-sonnet-5",
      "gpt-5.6-sol",
      "claude-sonnet-5",
    ]);
    expect(keyStatusCommands()).toEqual(["anthropic_api_key_status"]);
  });

  it("never fails over while the setting is off", async () => {
    invokeTauriMock.mockRejectedValue(
      "OpenAI did not respond within 60 seconds.",
    );
    const driver = createFailoverKnowledgeDriver(failoverSettings(false));

    await expect(
      driver(
        knowledgeExecutionRequest({
          requestId: "run-1:root:1:1",
          timeoutMs: 60_000,
          finalizing: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(KnowledgeProviderTimeoutError);
    expect(assignmentModels()).toEqual(["gpt-5.6-sol"]);
    expect(keyStatusCommands()).toEqual([]);
  });

  it("never fails over when the alternate provider has no configured key", async () => {
    invokeTauriMock.mockImplementation((command: string) => {
      if (command === "anthropic_api_key_status") {
        return Promise.resolve({ configured: false });
      }
      return Promise.reject("OpenAI did not respond within 60 seconds.");
    });
    const driver = createFailoverKnowledgeDriver(failoverSettings(true));

    await expect(
      driver(
        knowledgeExecutionRequest({
          requestId: "run-1:root:1:1",
          timeoutMs: 60_000,
          finalizing: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(KnowledgeProviderTimeoutError);
    expect(assignmentModels()).toEqual(["gpt-5.6-sol"]);
    expect(keyStatusCommands()).toEqual(["anthropic_api_key_status"]);
  });

  it("never fails over on an authentication failure", async () => {
    invokeTauriMock.mockRejectedValue(
      "OpenAI rejected this key. Replace it in Settings and try again.",
    );
    const driver = createFailoverKnowledgeDriver(failoverSettings(true));

    await expect(
      driver(
        knowledgeExecutionRequest({
          requestId: "run-1:root:1:1",
          timeoutMs: 60_000,
          finalizing: false,
        }),
        new AbortController().signal,
      ),
    ).rejects.toMatch(/rejected this key/);
    expect(assignmentModels()).toEqual(["gpt-5.6-sol"]);
    expect(keyStatusCommands()).toEqual([]);
  });
});

describe("knowledge provider preflight", () => {
  beforeEach(async () => {
    // Key changes invalidate the process-local readiness cache without a
    // test-only reset API or any native credential operation.
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await deleteApiKey();
    await deleteAnthropicApiKey();
    invokeTauriMock.mockReset();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.useRealTimers();
  });

  it("confirms a working provider through the native key test", async () => {
    invokeTauriMock.mockResolvedValueOnce({
      valid: true,
      message: "OpenAI accepted the key. Orion is ready to organize.",
    });

    const result = await preflightKnowledgeProvider("gpt-5.6-sol");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(invokeTauriMock).toHaveBeenCalledWith("test_openai_key", undefined);
  });

  it("routes Claude models to the Anthropic key test", async () => {
    invokeTauriMock.mockResolvedValueOnce({
      valid: true,
      message: "Anthropic accepted the key. Claude models are ready.",
    });

    await expect(
      preflightKnowledgeProvider("claude-4-6-opus"),
    ).resolves.toMatchObject({ ok: true });
    expect(invokeTauriMock).toHaveBeenCalledWith(
      "test_anthropic_key",
      undefined,
    );
  });

  it("explains a missing key as a complete sentence", async () => {
    invokeTauriMock.mockResolvedValueOnce({
      valid: false,
      message: "Add an OpenAI API key in Settings first.",
    });

    await expect(
      preflightKnowledgeProvider("gpt-5.6-sol"),
    ).resolves.toEqual({
      ok: false,
      message:
        "No OpenAI API key is configured, so Orion cannot start this import. Add one in Settings first.",
    });
  });

  it("explains a rejected key without starting the import", async () => {
    invokeTauriMock.mockResolvedValueOnce({
      valid: false,
      message: "OpenAI rejected this key. Replace it in Settings and try again.",
    });

    const result = await preflightKnowledgeProvider("gpt-5.6-sol");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/rejected the saved API key/);
      expect(result.message).toMatch(/Settings/);
    }
  });

  it("gives up after the local timeout instead of hanging the flow", async () => {
    vi.useFakeTimers();
    let finishNative!: (value: unknown) => void;
    invokeTauriMock.mockImplementationOnce(
      () => new Promise((resolve) => { finishNative = resolve; }),
    );

    const pending = preflightKnowledgeProvider("gpt-5.6-sol");
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/could not reach OpenAI/);
    }
    // A local timeout cannot release a still-running native request's slot.
    finishNative({ valid: true });
    await vi.advanceTimersByTimeAsync(0);
    invokeTauriMock.mockResolvedValueOnce({ valid: false, message: "OpenAI rejected this key." });
    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toMatchObject({ ok: false });
    expect(invokeTauriMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a successful probe for two minutes, then checks again", async () => {
    vi.useFakeTimers();
    invokeTauriMock.mockResolvedValue({ valid: true, message: "Ready." });
    await preflightKnowledgeProvider("gpt-5.6-sol");
    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toEqual({ ok: true, latencyMs: 0 });
    expect(invokeTauriMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    await preflightKnowledgeProvider("gpt-5.6-sol");
    expect(invokeTauriMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent probes for the same provider", async () => {
    let finish!: (value: unknown) => void;
    invokeTauriMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = preflightKnowledgeProvider("gpt-5.6-sol");
    const second = preflightKnowledgeProvider("gpt-5.6-luna");
    await vi.waitFor(() => expect(invokeTauriMock).toHaveBeenCalledTimes(1));
    finish({ valid: true, message: "Ready." });
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ ok: true }, { ok: true }]);
  });

  it("uses successful content traffic as readiness only for its own provider", async () => {
    invokeTauriMock.mockResolvedValueOnce({ response: { kind: "complete", payload: {} } });
    await runKnowledgeAssignment(knowledgeExecutionRequest({ requestId: "ready-content", timeoutMs: 30_000, finalizing: false }), new AbortController().signal);
    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toEqual({ ok: true, latencyMs: 0 });
    expect(invokeTauriMock).toHaveBeenCalledTimes(1);
    invokeTauriMock.mockResolvedValueOnce({ valid: true });
    await preflightKnowledgeProvider("claude-sonnet-5");
    expect(invokeTauriMock).toHaveBeenLastCalledWith("test_anthropic_key", undefined);
  });

  it("does not let a late success for a replaced key authorize later imports", async () => {
    let finishOldProbe!: (value: unknown) => void;
    invokeTauriMock.mockImplementation((command: string) => command === "test_openai_key"
      ? new Promise((resolve) => { finishOldProbe = resolve; })
      : Promise.resolve(undefined));
    const oldProbe = preflightKnowledgeProvider("gpt-5.6-sol");
    await vi.waitFor(() => expect(invokeTauriMock).toHaveBeenCalledTimes(1));
    await saveApiKey("replacement-fixture-key");
    finishOldProbe({ valid: true });
    await oldProbe;
    invokeTauriMock.mockResolvedValueOnce({ valid: false, message: "OpenAI rejected this key." });
    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toMatchObject({ ok: false });
    expect(invokeTauriMock.mock.calls.filter(([command]) => command === "test_openai_key")).toHaveLength(2);
  });

  it("invalidates a recent success when a content call fails", async () => {
    invokeTauriMock.mockResolvedValueOnce({ valid: true });
    await preflightKnowledgeProvider("gpt-5.6-sol");
    invokeTauriMock.mockRejectedValueOnce("OpenAI billing quota exceeded.");
    await expect(runKnowledgeAssignment(knowledgeExecutionRequest({ requestId: "failed-content", timeoutMs: 30_000, finalizing: false }), new AbortController().signal)).rejects.toBeDefined();
    invokeTauriMock.mockResolvedValueOnce({ valid: false, message: "OpenAI billing quota exceeded." });
    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toMatchObject({ ok: false });
    expect(invokeTauriMock).toHaveBeenCalledTimes(3);
  });

  it("never throws when the native command rejects", async () => {
    invokeTauriMock.mockRejectedValueOnce(
      "Orion could not reach OpenAI: dns lookup failed",
    );

    const result = await preflightKnowledgeProvider("gpt-5.6-sol");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/could not reach OpenAI/);
    }
  });

  it("notes repeated recent failures from the provider health memory", async () => {
    invokeTauriMock.mockResolvedValue({
      valid: false,
      message: "OpenAI rejected this key. Replace it in Settings and try again.",
    });

    const first = await preflightKnowledgeProvider("gpt-5.6-sol");
    const second = await preflightKnowledgeProvider("gpt-5.6-sol");

    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.message).not.toMatch(/recent connection checks/);
    }
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.message).toMatch(
        /OpenAI has failed 2 of Orion's recent connection checks from this Mac\./,
      );
    }
  });

  it("does not block browser preview", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

    await expect(preflightKnowledgeProvider("gpt-5.6-sol")).resolves.toEqual({
      ok: true,
      latencyMs: 0,
    });
    expect(invokeTauriMock).not.toHaveBeenCalled();
  });
});

describe("native web export boundary", () => {
  it("passes the generated file through the narrow native save command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      path: "/tmp/atlas.html",
      cancelled: false,
    });

    try {
      await expect(
        exportWebPage("atlas.html", "<!doctype html><title>Atlas</title>"),
      ).resolves.toEqual({ path: "/tmp/atlas.html", cancelled: false });
      expect(invokeTauriMock).toHaveBeenCalledWith("export_web_page", {
        request: {
          fileName: "atlas.html",
          html: "<!doctype html><title>Atlas</title>",
        },
      });
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  it("refuses an empty web article before invoking native code", async () => {
    invokeTauriMock.mockClear();
    await expect(exportWebPage("empty.html", "   ")).rejects.toThrow(
      /no web article/i,
    );
    expect(invokeTauriMock).not.toHaveBeenCalled();
  });
});

describe("browser persistence fallback", () => {
  beforeEach(async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    window.localStorage.clear();
    clearBrowserSnapshot();
    await deleteApiKey();
    await deleteAnthropicApiKey();
  });

  it("round-trips a vault snapshot through localStorage", async () => {
    const vault = createEmptyVault("Test constellation", TEST_NOW);

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      schemaVersion: 2,
      spaces: [{ workspace: { name: "Test constellation" } }],
    });
  });

  it("round-trips named voices and the active selection", async () => {
    const vault = createEmptyVault("Voice preferences", TEST_NOW);
    const settings = activeSpace(vault).settings;
    settings.elevenLabsVoices = [
      { name: "Everyday reading", voiceId: "21m00Tcm4TlvDq8ikWAM" },
      { name: "Storyteller", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
    ];
    settings.elevenLabsVoiceId = settings.elevenLabsVoices[1].voiceId;
    await saveSnapshot(vault);
    const loaded = await loadSnapshot();
    expect(activeSpace(loaded!).settings).toEqual(settings);
  });

  it("accepts older settings without saved voices", async () => {
    const legacy = mutablePopulatedSnapshot();
    delete legacy.settings.elevenLabsVoices;
    legacy.settings.elevenLabsVoiceId = "21m00Tcm4TlvDq8ikWAM";
    window.localStorage.setItem("orion:vault:v1", JSON.stringify(legacy));
    const loaded = await loadSnapshot();
    expect(activeSpace(loaded!).settings.elevenLabsVoiceId).toBe("21m00Tcm4TlvDq8ikWAM");
  });

  it.each([
    "not a list",
    [null],
    [{ name: "Reading", voiceId: "../voice" }],
    [{ name: "Reading", voiceId: "21m00Tcm4TlvDq8ikWAM\n" }],
    [{ name: "  ", voiceId: "21m00Tcm4TlvDq8ikWAM" }],
    [{ name: "A".repeat(81), voiceId: "21m00Tcm4TlvDq8ikWAM" }],
    [{ name: "Hidden\u0000name", voiceId: "21m00Tcm4TlvDq8ikWAM" }],
  ].map((voices) => [voices]))("rejects malformed saved voices (%j) without clearing the vault", async (voices) => {
    const snapshot = mutablePopulatedSnapshot();
    snapshot.settings.elevenLabsVoices = voices;
    await expectInvalidBrowserVault(snapshot);
  });

  it("round-trips a fully populated import draft", async () => {
    const vault = createEmptyVault("Test vault", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.importDrafts.push({
      id: "draft-test",
      title: "Field notes",
      fileName: "field-notes.md",
      mimeType: "text/markdown",
      format: "markdown",
      byteSize: 128,
      extractedText: "Notes about the winter sky.",
      createdAt: "2026-07-27T10:00:00.000Z",
      status: "error",
      warnings: ["A heading could not be classified."],
      error: "Import paused.",
      generatedNoteIds: [],
    });

    await saveSnapshot(vault);

    expect((await loadSnapshot())?.spaces[0].importDrafts[0]).toMatchObject({
      id: "draft-test",
      status: "error",
      error: "Import paused.",
    });
  });

  it("round-trips import guidance, a living overview, and the Space knowledge index", async () => {
    const vault = createEmptyVault("Guided research", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.sources.push({
      id: "source-guided",
      title: "Interview",
      kind: "text",
      importedAt: TEST_NOW,
      importGuidance: "Focus on objections and explicit next actions.",
      text: "Interview transcript.",
      noteIds: [],
    });
    snapshot.spaceOverview = {
      title: "A dispute takes shape",
      body: "The Space centres on a developing disagreement.",
      relatedNoteIds: [],
      generatedAt: TEST_NOW,
      stale: true,
    };
    snapshot.notes.push({
      id: "note-indexed",
      title: "Indexed note",
      slug: "indexed-note",
      summary: "A substantive note represented in the semantic directory.",
      body: "# Indexed note\n\nThe complete body contributes to a distributed sketch.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: ["source-guided"],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
    snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, TEST_NOW);

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      spaces: [
        {
          sources: [
            {
              importGuidance:
                "Focus on objections and explicit next actions.",
            },
          ],
          spaceOverview: {
            title: "A dispute takes shape",
            stale: true,
          },
          spaceKnowledge: {
            schemaVersion: 1,
            digests: [
              expect.objectContaining({
                noteId: "note-indexed",
                contentFingerprint: expect.any(String),
              }),
            ],
            rootBlueprintId: "space-blueprint-root",
          },
        },
      ],
    });
  });

  it("round-trips the optional last-opened navigation timestamp", async () => {
    const vault = createEmptyVault("Reading order", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.notes.push({
      id: "note-opened",
      title: "Opened note",
      slug: "opened-note",
      summary: "A note with navigation recency.",
      body: "Body",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      lastOpenedAt: "2026-08-07T02:00:00.000Z",
    });

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      spaces: [
        {
          notes: [
            { lastOpenedAt: "2026-08-07T02:00:00.000Z" },
          ],
        },
      ],
    });
  });

  it("tracks API key state without putting the key in the snapshot", async () => {
    expect(await apiKeyStatus()).toEqual({ configured: false });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: false });

    await saveApiKey("sk-test-secret");
    await saveAnthropicApiKey("sk-ant-test-secret");
    expect(await apiKeyStatus()).toEqual({ configured: true });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: true });
    expect(JSON.stringify(await loadSnapshot())).not.toContain("sk-test-secret");
    expect(JSON.stringify(await loadSnapshot())).not.toContain(
      "sk-ant-test-secret",
    );
    expect(JSON.stringify(window.localStorage)).not.toContain("sk-test-secret");
    expect(JSON.stringify(window.localStorage)).not.toContain(
      "sk-ant-test-secret",
    );

    await deleteApiKey();
    await deleteAnthropicApiKey();
    expect(await apiKeyStatus()).toEqual({ configured: false });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: false });
  });

  it("rejects a corrupt snapshot instead of treating it as a new vault", async () => {
    window.localStorage.setItem("orion:vault:v2", "{not-json");

    await expect(loadSnapshot()).rejects.toThrow(
      "browser preview vault could not be loaded",
    );
  });

  it("migrates a valid single-space v1 snapshot without losing content", async () => {
    const legacy = createPopulatedSnapshot();
    window.localStorage.setItem("orion:vault:v1", JSON.stringify(legacy));

    const vault = await loadSnapshot();

    expect(vault).toMatchObject({
      schemaVersion: 2,
      activeSpaceId: legacy.workspace.id,
      spaces: [
        {
          workspace: { id: legacy.workspace.id },
          notes: [{ id: "note-test" }],
          concepts: [{ id: "concept-test" }],
        },
      ],
    });
  });

  it("accepts a vault saved before appearance preferences existed", async () => {
    const legacy = mutablePopulatedSnapshot();
    delete legacy.settings.themePreset;
    delete legacy.settings.themeAccent;
    delete legacy.settings.themeAccentCustom;
    delete legacy.settings.themeCanvasTone;
    delete legacy.settings.themeCanvasCustom;
    delete legacy.settings.themeSurfaceLift;
    delete legacy.settings.themeSurfaceCustom;
    delete legacy.settings.themeTextWarmth;
    delete legacy.settings.themeContrast;
    delete legacy.settings.homeAtmosphere;
    delete legacy.settings.homeAtmosphereTone;
    delete legacy.settings.homeAtmosphereMotion;
    window.localStorage.setItem("orion:vault:v1", JSON.stringify(legacy));

    await expect(loadSnapshot()).resolves.toMatchObject({
      schemaVersion: 2,
      spaces: [{ workspace: { id: "workspace-test-vault" } }],
    });
  });

  it("keeps spaces isolated through persistence", async () => {
    const vault = createEmptyVault("Main project", TEST_NOW);
    const second = createEmptySnapshot(
      "Second project",
      TEST_NOW,
      "workspace-second",
    );
    second.notes.push({
      ...createPopulatedSnapshot().notes[0],
      id: "note-second",
      conceptIds: [],
      sourceIds: [],
    });
    vault.spaces.push(second);
    vault.activeSpaceId = second.workspace.id;

    await saveSnapshot(vault);
    const loaded = await loadSnapshot();

    expect(loaded?.spaces[0].notes).toHaveLength(0);
    expect(loaded?.spaces[1].notes.map((note) => note.id)).toEqual([
      "note-second",
    ]);
    expect(loaded?.activeSpaceId).toBe("workspace-second");
  });

  it("keeps Chat isolated while round-tripping dormant legacy Studio data", async () => {
    const vault = createEmptyVault("Main project", TEST_NOW);
    const second = createEmptySnapshot(
      "Second project",
      TEST_NOW,
      "workspace-second",
    );
    second.studio.view = "dialectic";
    second.studio.zoom = 1.2;
    second.studio.selectedCardIds = ["legacy-card"];
    second.studio.cards.push({
      id: "legacy-card",
      kind: "synthesis",
      title: "Legacy synthesis",
      body: "A thought created by an older Orion build.",
      epistemicStatus: "inferred",
      origin: "orion",
      stage: "proposed",
      dialecticRole: "synthesis",
      conceptIds: [],
      noteIds: [],
      sourceIds: [],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
    second.studio.messages.push({
      id: "studio-message",
      role: "assistant",
      content: "A reply from the older Studio.",
      cardIds: ["legacy-card"],
      contextCardIds: ["legacy-card"],
      createdNoteIds: ["note-from-chat"],
      createdAt: TEST_NOW,
    });
    vault.spaces.push(second);

    await saveSnapshot(vault);
    const loaded = await loadSnapshot();

    expect(loaded?.spaces[0].studio.messages).toEqual([]);
    expect(loaded?.spaces[1].studio).toMatchObject({
      view: "dialectic",
      zoom: 1.2,
      selectedCardIds: ["legacy-card"],
      cards: [
        {
          id: "legacy-card",
          stage: "proposed",
          dialecticRole: "synthesis",
        },
      ],
      messages: [
        {
          content: "A reply from the older Studio.",
          cardIds: ["legacy-card"],
          contextCardIds: ["legacy-card"],
          createdNoteIds: ["note-from-chat"],
        },
      ],
    });
  });

  it("accepts only a non-empty reply from Chat", () => {
    expect(parseChatResult({ reply: "A grounded answer." })).toEqual({
      reply: "A grounded answer.",
    });
    expect(() => parseChatResult({ reply: "   " })).toThrow(
      "unexpected response",
    );
    expect(() => parseChatResult({ cards: [] })).toThrow(
      "unexpected response",
    );
    expect(() =>
      parseChatResult({ reply: "Looks valid.", cards: [] }),
    ).toThrow("unexpected response");
  });

  it("accepts bounded Chat note actions and drops unsafe actions without the reply", () => {
    expect(
      parseChatResult({
        reply: "I created one note.",
        noteActions: [
          {
            title: "Grounded note",
            summary: "A summary.",
            body: "Permanent Markdown.",
            tags: ["research"],
            aliases: [],
          },
          {
            title: "Unsafe note",
            summary: "",
            body: "x".repeat(20_001),
            tags: [],
            aliases: [],
          },
        ],
      }),
    ).toEqual({
      reply: "I created one note.",
      noteActions: [
        {
          title: "Grounded note",
          summary: "A summary.",
          body: "Permanent Markdown.",
          tags: ["research"],
          aliases: [],
        },
      ],
    });
    expect(
      parseChatResult({
        reply: "The conversational reply remains usable.",
        noteActions: "not an array",
      }),
    ).toEqual({ reply: "The conversational reply remains usable." });
  });

  it("rejects incomplete OpenAI output and joins multipart text like native", () => {
    expect(() =>
      extractBrowserOutputText(
        {
          status: "incomplete",
          output_text: '{"reply":"partial"}',
          incomplete_details: { reason: "max_output_tokens" },
        },
        "finish Chat",
      ),
    ).toThrow("max_output_tokens");
    expect(
      extractBrowserOutputText(
        {
          output: [
            { content: [{ type: "output_text", text: "first" }] },
            { content: [{ type: "output_text", text: " second" }] },
          ],
        },
        "finish Chat",
      ),
    ).toBe("first second");
  });

  it("rejects a v2 vault with a missing active space", async () => {
    const vault = createEmptyVault("Test vault", TEST_NOW);
    vault.activeSpaceId = "workspace-missing";
    window.localStorage.setItem("orion:vault:v2", JSON.stringify(vault));

    await expect(loadSnapshot()).rejects.toThrow(
      "browser preview vault could not be loaded",
    );
  });

  it.each([
    [
      "non-string title",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].title = 42;
      },
    ],
    [
      "invalid status",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].status = "published";
      },
    ],
    [
      "non-string nested tag",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].tags = ["valid", 42];
      },
    ],
    [
      "non-string last-opened timestamp",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].lastOpenedAt = 42;
      },
    ],
  ])("rejects a note with a %s", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });

  it.each([
    [
      "non-boolean auto-link preference",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.autoLink = "yes";
      },
    ],
    [
      "non-boolean provider failover preference",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.providerFailoverEnabled = "yes";
      },
    ],
    [
      "unsupported reasoning effort",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.reasoningEffort = "extreme";
      },
    ],
    [
      "unsupported theme",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.theme = "sepia";
      },
    ],
    [
      "unsupported theme preset",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themePreset = "laser";
      },
    ],
    [
      "unsupported theme accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeAccent = "neon";
      },
    ],
    [
      "malformed custom accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeAccentCustom = "electric-blue";
      },
    ],
    [
      "unsupported canvas tone",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeCanvasTone = "black";
      },
    ],
    [
      "malformed custom canvas",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeCanvasCustom = "#123";
      },
    ],
    [
      "unsupported surface lift",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeSurfaceLift = "floating";
      },
    ],
    [
      "malformed custom surface",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeSurfaceCustom = "rgb(1, 2, 3)";
      },
    ],
    [
      "unsupported text warmth",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeTextWarmth = "hot";
      },
    ],
    [
      "unsupported theme contrast",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeContrast = "maximum";
      },
    ],
    [
      "unsupported home atmosphere",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphere = "galaxy";
      },
    ],
    [
      "unsupported atmosphere accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphereTone = "ultraviolet";
      },
    ],
    [
      "unsupported atmosphere motion",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphereMotion = "chaotic";
      },
    ],
  ])("rejects settings with an %s", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });

  it.each([
    [
      "workspace",
      (snapshot: MutableSnapshot) => {
        snapshot.workspace.createdAt = false;
      },
    ],
    [
      "source",
      (snapshot: MutableSnapshot) => {
        snapshot.sources[0].byteSize = -1;
      },
    ],
    [
      "concept",
      (snapshot: MutableSnapshot) => {
        snapshot.concepts[0].noteIds = ["note-test", 7];
      },
    ],
    [
      "relationship",
      (snapshot: MutableSnapshot) => {
        snapshot.relationships[0].strength = null;
      },
    ],
    [
      "import draft",
      (snapshot: MutableSnapshot) => {
        snapshot.importDrafts.push({
          id: "draft-test",
          title: "Draft",
          fileName: "draft.md",
          mimeType: "text/markdown",
          format: "markdown",
          byteSize: 12,
          extractedText: "Draft text",
          createdAt: "2026-07-27T10:00:00.000Z",
          status: "ready",
          warnings: [false],
          generatedNoteIds: [],
        });
      },
    ],
    [
      "active note reference",
      (snapshot: MutableSnapshot) => {
        snapshot.activeNoteId = 99;
      },
    ],
    [
      "Space overview",
      (snapshot: MutableSnapshot) => {
        snapshot.spaceOverview = {
          title: "Overview",
          body: "Body",
          relatedNoteIds: [42],
          generatedAt: TEST_NOW,
          stale: false,
        };
      },
    ],
    [
      "Space overview timestamp",
      (snapshot: MutableSnapshot) => {
        snapshot.spaceOverview = {
          title: "Overview",
          body: "Body",
          relatedNoteIds: [],
          generatedAt: "2026-02-30T12:00:00.000Z",
          stale: false,
        };
      },
    ],
  ])("rejects a malformed %s entity", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });
});

function knowledgeExecutionRequest(
  timing: Pick<
    KnowledgeAssignmentExecutionRequest,
    "requestId" | "timeoutMs" | "finalizing"
  >,
): KnowledgeAssignmentExecutionRequest {
  return {
    assignment: {
      assignmentId: "root",
      parent: { kind: "run", runId: "run-1" },
      purpose: "root",
      objective: "Return a grounded result.",
      references: [],
      constraints: { rules: [], mustPreserve: [] },
      authority: { kind: "read-only" },
      output: { kind: "root-result" },
      termination: { condition: "Return a complete result." },
    },
    context: {
      runId: "run-1",
      space: {
        spaceId: "space-1",
        name: "Space",
        description: "",
        snapshotVersion: "snapshot-1",
      },
      objective: "Return a grounded result.",
      purpose: "root",
      authority: { kind: "read-only" },
      constraints: { rules: [], mustPreserve: [] },
      output: { kind: "root-result" },
      termination: { condition: "Return a complete result." },
      resolvedMaterials: [],
      spaceOrientation: {
        importGuidance: "",
        organizationInstructions: "",
        noteTitles: [],
        conceptLabels: [],
        noteSignals: [],
      },
      excludedContext: [],
    },
    completedChildArtifacts: [],
    observations: [],
    model: "gpt-5.6-sol",
    effort: "high",
    attempt: 1,
    ...timing,
  };
}

interface MutableSnapshot {
  workspace: Record<string, unknown>;
  notes: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  concepts: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  importDrafts: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  spaceOverview?: Record<string, unknown>;
  activeNoteId: unknown;
}

const TEST_NOW = "2026-07-27T10:00:00.000Z";

function mutablePopulatedSnapshot(): MutableSnapshot {
  return createPopulatedSnapshot() as unknown as MutableSnapshot;
}

function createPopulatedSnapshot(): AppSnapshot {
  const snapshot = createEmptySnapshot("Test vault", TEST_NOW);
  snapshot.notes.push({
    id: "note-test",
    title: "Test note",
    slug: "test-note",
    summary: "A validation fixture.",
    body: "Fixture body.",
    aliases: [],
    tags: ["test"],
    kind: "article",
    status: "ready",
    conceptIds: ["concept-test"],
    sourceIds: ["source-test"],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  });
  snapshot.sources.push({
    id: "source-test",
    title: "Test source",
    kind: "text",
    importedAt: TEST_NOW,
    fileName: "test.txt",
    mimeType: "text/plain",
    byteSize: 12,
    text: "Fixture text",
    noteIds: ["note-test"],
  });
  snapshot.concepts.push({
    id: "concept-test",
    label: "Test concept",
    aliases: [],
    description: "A validation concept.",
    noteIds: ["note-test"],
    color: "#8ea6ff",
    autoLink: true,
  });
  snapshot.relationships.push({
    id: "relationship-test",
    fromNoteId: "note-test",
    toNoteId: "note-test",
    kind: "related",
    label: "relates to",
    strength: 0.5,
  });
  return snapshot;
}

async function expectInvalidBrowserVault(
  snapshot: MutableSnapshot,
): Promise<void> {
  window.localStorage.setItem("orion:vault:v1", JSON.stringify(snapshot));
  await expect(loadSnapshot()).rejects.toThrow(
    "browser preview vault could not be loaded",
  );
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
