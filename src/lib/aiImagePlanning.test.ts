// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  imagePlanningEffort, imagePlanningSchema, imagePlanningTimeoutMs, imagePlanningTokenBudget,
  parseImagePlanningContext, parseImagePlanningResult, type ImagePlanningStage,
} from "./aiImagePlanning";

const stages: ImagePlanningStage[] = ["select", "search", "read", "merge", "compose"];
const findings = { summary: "Independent sources disagree on causality.", evidenceIds: ["note:a:passage:2", "source:b:passage:9"], queries: ["underlying experiment"], complete: false };

describe("adaptive illustration protocol boundary", () => {
  it.each(stages)("keeps %s read-only and enforces the context opt-out", (stage) => {
    const schema = imagePlanningSchema(stage);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).not.toHaveProperty("noteActions");
    const context = JSON.stringify({ selectedPassage: "A claim", contextEnabled: false, evidence: [] });
    if (stage === "compose") expect(parseImagePlanningContext({ stage, context })).toBeDefined();
    else expect(() => parseImagePlanningContext({ stage, context })).toThrow(/invalid/);
    expect(() => parseImagePlanningContext({ stage: "compose", context: JSON.stringify({ ...JSON.parse(context), findings: [] }) })).toThrow(/invalid/);
  });

  it("accepts independent search directions without requiring a note quota", () => {
    expect(parseImagePlanningResult({ focus: "Resolve the selected claim", queries: [] }, "search")).toMatchObject({ queries: [] });
    expect(() => parseImagePlanningResult({ focus: "Claim", queries: Array.from({ length: 7 }, (_, i) => `query ${i}`) }, "search")).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ focus: "Claim", queries: ["same", "same"] }, "search")).toThrow(/invalid/);
  });

  it.each(["read", "merge"] as const)("validates %s evidence compression and gap requests", (stage) => {
    expect(parseImagePlanningResult(findings, stage)).toEqual(findings);
    expect(parseImagePlanningResult({ ...findings, summary: "", evidenceIds: [], queries: [] }, stage)).toMatchObject({ evidenceIds: [] });
    expect(() => parseImagePlanningResult({ ...findings, summary: "" }, stage)).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ ...findings, evidenceIds: [] }, stage)).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ ...findings, complete: "yes" }, stage)).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ ...findings, summary: "x".repeat(3201) }, stage)).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ ...findings, evidenceIds: ["same", "same"] }, stage)).toThrow(/invalid/);
    expect(() => parseImagePlanningResult({ ...findings, noteActions: [] }, stage)).toThrow(/invalid/);
  });

  it("bounds evidence records, multibyte packets and deadlines", () => {
    const context = (evidence: unknown[], extra = {}) => JSON.stringify({ selectedPassage: "A claim", contextEnabled: true, evidence, ...extra });
    expect(parseImagePlanningContext({ stage: "merge", context: context(Array(96).fill({})), timeoutMs: 1000 })).toBeDefined();
    expect(() => parseImagePlanningContext({ stage: "merge", context: context(Array(97).fill({})) })).toThrow(/invalid/);
    expect(() => parseImagePlanningContext({ stage: "merge", context: context([], { padding: "界".repeat(86_000) }) })).toThrow(/limit/);
    for (const timeoutMs of [0, 999, 240001, 1000.5, NaN]) {
      expect(() => parseImagePlanningContext({ stage: "search", context: context([]), timeoutMs })).toThrow(/timeout/);
    }
  });

  it("reserves room for hidden reasoning and applies stage-specific defaults", () => {
    expect(imagePlanningTokenBudget({ stage: "search", effort: "low" })).toBe(6000);
    expect(imagePlanningTokenBudget({ stage: "compose", effort: "xhigh" })).toBe(24000);
    expect(imagePlanningTimeoutMs({ stage: "search", effort: "low" })).toBe(60000);
    expect(imagePlanningTimeoutMs({ stage: "compose", effort: "xhigh" })).toBe(240000);
    expect(imagePlanningTimeoutMs({ stage: "read", effort: "low", timeoutMs: 17000 })).toBe(17000);
  });

  it("sends explicit None for supported OpenAI models and rejects it for Astra", () => {
    expect(imagePlanningEffort("gpt-5.6-sol", "none")).toBe("none");
    expect(imagePlanningEffort("gpt-5.6-terra", "none")).toBe("none");
    expect(imagePlanningEffort("claude-sonnet-5", "none")).toBeUndefined();
    expect(() => imagePlanningEffort("gpt-6-astra", "none")).toThrow(/at least Low/);
    expect(() => imagePlanningEffort("gpt-6-astra-2026-09-29", "none")).toThrow(/at least Low/);
  });
});
