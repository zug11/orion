import { describe, expect, it, vi } from "vitest";
import {
  compareKnowledgeTopologies,
  evidenceAgainstVariableWidth,
  type KnowledgeEvaluationMetrics,
} from "./evaluation";
import { runResult } from "./testFixtures";

describe("knowledge orchestration falsification harness", () => {
  it("holds provider, model, sources, Space, budgets, and rubric constant", async () => {
    const baseline = vi.fn().mockResolvedValue(metrics());
    const variable = vi.fn().mockResolvedValue(metrics());
    const parameters = {
      caseId: "case-1",
      provider: "openai" as const,
      model: "gpt-5.6-sol",
      sourceFingerprint: "source-hash",
      spaceFingerprint: "space-hash",
      inputBudgetTokens: 20_000,
      outputBudgetTokens: 8_000,
      rubric: ["grounding", "coherence"],
    };
    await compareKnowledgeTopologies(parameters, baseline, variable);
    expect(baseline).toHaveBeenCalledWith(parameters);
    expect(variable).toHaveBeenCalledWith(parameters);
    expect(baseline.mock.calls[0][0]).toEqual(variable.mock.calls[0][0]);
  });

  it("records concrete evidence against a costly decorative topology", () => {
    const baseline = metrics();
    const variable = metrics({
      inputTokens: 3_000,
      outputTokens: 1_000,
      qualityScores: { grounding: 0.5, coherence: 0.5 },
      irrelevantContextCount: 4,
      invalidCoordinationCallCount: 2,
      topologyExplanation: "",
    });
    expect(evidenceAgainstVariableWidth(baseline, variable)).toEqual(
      expect.arrayContaining([
        "Variable-width output scored below the fixed baseline.",
        "Coordination cost increased substantially without a quality gain.",
        "The model emitted invalid coordination calls.",
        "The causal record does not explain why logical width changed.",
      ]),
    );
  });
});

function metrics(
  overrides: Partial<KnowledgeEvaluationMetrics> = {},
): KnowledgeEvaluationMetrics {
  return {
    result: runResult(),
    elapsedMs: 1_000,
    inputTokens: 1_000,
    outputTokens: 500,
    qualityScores: { grounding: 0.9, coherence: 0.9 },
    irrelevantContextCount: 1,
    contradictionRecoveryCount: 1,
    duplicateRevisionCount: 0,
    staleRevisionCount: 0,
    invalidCoordinationCallCount: 0,
    userInterventionCount: 0,
    topologyExplanation: "The model widened around two independent disputes.",
    ...overrides,
  };
}
