import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import { runAutomaticKnowledgeImport } from "./automaticImport";
import { KnowledgeDeadlineExceededError, KnowledgeProviderTimeoutError, type KnowledgeAssignmentDriver } from "./service";
import { fixedPipelineResponse } from "./testFixtures";
import type { KnowledgeImportBatchOptions } from "./import";

function options(driver: KnowledgeAssignmentDriver, count = 1): KnowledgeImportBatchOptions {
  const snapshot = createEmptySnapshot("Recovery Space", "2026-09-05T00:00:00.000Z");
  return {
    snapshot, model: "gpt-5.6-sol", effort: "high", importGuidance: "", driver,
    sources: Array.from({ length: count }, (_, index) => ({
      sourceId: `source-${index}`,
      parsed: {
        title: `Source ${index}`, fileName: `source-${index}.txt`, mimeType: "text/plain", format: "text" as const,
        byteSize: 60, text: `Source ${index} explains a complete, substantive idea with supporting evidence.`, warnings: [],
      },
    })),
  };
}

describe("automatic import recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("recovers a direct time limit through one compact plan without user input", async () => {
    const kinds: string[] = [];
    const models = new Set<string>();
    const onRecovery = vi.fn();
    const pending = runAutomaticKnowledgeImport({ ...options(async (request) => {
      kinds.push(request.assignment.output.kind);
      models.add(request.model);
      if (request.assignment.purpose === "root") throw new KnowledgeDeadlineExceededError();
      return fixedPipelineResponse(request);
    }), onRecovery });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.landing).toBeUndefined();
    expect(result.organized.notes.length).toBeGreaterThan(0);
    expect(kinds.filter((kind) => kind === "source-reading")).toHaveLength(1);
    expect(kinds).not.toContain("reading-blueprint");
    expect(models).toEqual(new Set(["gpt-5.6-sol"]));
    expect(onRecovery).toHaveBeenCalledOnce();
    expect(onRecovery.mock.calls[0][0].kind).toBe("planned-reading");
  });

  it("resumes only a failed writer and retains every completed source reading", async () => {
    const kinds: string[] = [];
    let writes = 0;
    const pending = runAutomaticKnowledgeImport(options(async (request) => {
      kinds.push(request.assignment.output.kind);
      if (request.assignment.output.kind === "writer-result" && ++writes === 1) {
        throw new KnowledgeProviderTimeoutError("Provider timeout.");
      }
      return fixedPipelineResponse(request);
    }, 2));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.landing).toBeUndefined();
    expect(writes).toBe(2);
    expect(kinds.filter((kind) => kind === "source-reading")).toHaveLength(2);
  });

  it("bounds repeated writer failures and returns honest grounded fallback notes", async () => {
    let writes = 0;
    let readings = 0;
    const pending = runAutomaticKnowledgeImport(options(async (request) => {
      if (request.assignment.output.kind === "source-reading") readings += 1;
      if (request.assignment.output.kind === "writer-result") {
        writes += 1;
        throw new KnowledgeProviderTimeoutError("Provider timeout.");
      }
      return fixedPipelineResponse(request);
    }, 2));
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(writes).toBe(3);
    expect(readings).toBe(2);
    expect(result.landing).toMatchObject({ tier: 1, code: "provider-timeout" });
    expect(result.organized.notes.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("Orion landed this import plainly");
  });

  it.each(["Invalid API key", "Billing quota exhausted", "Model does not exist", "Invalid request schema HTTP 400"])(
    "does not spend more calls on a provider action: %s", async (message) => {
      const driver = vi.fn(async () => { throw new Error(message); });
      const pending = runAutomaticKnowledgeImport(options(driver));
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(driver).toHaveBeenCalledOnce();
      expect(result.landing?.tier).toBe(2);
      expect(result.organized.notes[0].body).toContain("complete, substantive idea");
    },
  );

  it.each(["cancel", "space-change"])("does not dispatch recovery after %s", async (reason) => {
    const controller = new AbortController();
    let current = true;
    const driver = vi.fn(async () => { throw new KnowledgeDeadlineExceededError(); });
    const pending = runAutomaticKnowledgeImport({ ...options(driver), signal: controller.signal,
      isCurrent: () => current,
      onRecovery: () => {
        if (reason === "cancel") controller.abort(new Error("Import cancelled"));
        else current = false;
      },
    });
    const rejection = expect(pending).rejects.toThrow(reason === "cancel" ? /cancelled/ : /Space context changed/);
    await vi.runAllTimersAsync();
    await rejection;
    expect(driver).toHaveBeenCalledOnce();
  });
});
