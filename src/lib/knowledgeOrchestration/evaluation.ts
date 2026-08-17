import type { KnowledgeRunResult } from "./protocol";

export interface KnowledgeEvaluationParameters {
  caseId: string;
  provider: "openai" | "anthropic";
  model: string;
  sourceFingerprint: string;
  spaceFingerprint: string;
  inputBudgetTokens?: number;
  outputBudgetTokens?: number;
  rubric: string[];
}

export interface KnowledgeEvaluationMetrics {
  result: KnowledgeRunResult;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  qualityScores: Record<string, number>;
  irrelevantContextCount: number;
  contradictionRecoveryCount: number;
  duplicateRevisionCount: number;
  staleRevisionCount: number;
  invalidCoordinationCallCount: number;
  userInterventionCount: number;
  topologyExplanation?: string;
}

export interface KnowledgeEvaluationRecord {
  parameters: KnowledgeEvaluationParameters;
  baseline: KnowledgeEvaluationMetrics;
  variableWidth: KnowledgeEvaluationMetrics;
  evidenceAgainst: string[];
}

export type KnowledgeEvaluationRunner = (
  parameters: Readonly<KnowledgeEvaluationParameters>,
) => Promise<KnowledgeEvaluationMetrics>;

/**
 * Opt-in evaluation only. Callers supply the paid/provider runners explicitly;
 * normal tests and production imports never invoke this function on their own.
 */
export async function compareKnowledgeTopologies(
  parameters: KnowledgeEvaluationParameters,
  baselineRunner: KnowledgeEvaluationRunner,
  variableWidthRunner: KnowledgeEvaluationRunner,
): Promise<KnowledgeEvaluationRecord> {
  const frozen = deepFreeze(structuredClone(parameters));
  const baseline = await baselineRunner(frozen);
  const variableWidth = await variableWidthRunner(frozen);
  return {
    parameters: structuredClone(parameters),
    baseline,
    variableWidth,
    evidenceAgainst: evidenceAgainstVariableWidth(baseline, variableWidth),
  };
}

export function evidenceAgainstVariableWidth(
  baseline: KnowledgeEvaluationMetrics,
  variableWidth: KnowledgeEvaluationMetrics,
): string[] {
  const evidence: string[] = [];
  const baselineQuality = mean(Object.values(baseline.qualityScores));
  const variableQuality = mean(Object.values(variableWidth.qualityScores));
  if (variableQuality < baselineQuality) {
    evidence.push("Variable-width output scored below the fixed baseline.");
  }
  if (
    tokens(variableWidth) > tokens(baseline) * 1.35 &&
    variableQuality <= baselineQuality
  ) {
    evidence.push("Coordination cost increased substantially without a quality gain.");
  }
  if (variableWidth.irrelevantContextCount > baseline.irrelevantContextCount) {
    evidence.push("Narrow assignments introduced more irrelevant or rediscovered context.");
  }
  if (
    variableWidth.duplicateRevisionCount + variableWidth.staleRevisionCount >
    baseline.duplicateRevisionCount + baseline.staleRevisionCount
  ) {
    evidence.push("Variable-width execution produced more duplicate or stale revisions.");
  }
  if (variableWidth.invalidCoordinationCallCount > 0) {
    evidence.push("The model emitted invalid coordination calls.");
  }
  if (!variableWidth.topologyExplanation?.trim()) {
    evidence.push("The causal record does not explain why logical width changed.");
  }
  return evidence;
}

function tokens(metrics: KnowledgeEvaluationMetrics): number {
  return (metrics.inputTokens ?? 0) + (metrics.outputTokens ?? 0);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}
