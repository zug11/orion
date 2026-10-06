import type { ReasoningEffort } from "../types";
import protocol from "./aiImagePlanningProtocol.json";

export const IMAGE_PLANNING_INSTRUCTIONS = protocol.instructions;
export const MAX_IMAGE_PLANNING_BYTES = 256_000;
export type ImagePlanningStage = "select" | "search" | "read" | "merge" | "compose";
export type ImageGenerationQuality = "fast" | "detailed";
export interface ImagePlanningRequest {
  stage: ImagePlanningStage;
  context: string;
  model: string;
  effort: ReasoningEffort;
  timeoutMs?: number;
}
/** Retained for old in-flight callers; new requests search before selecting evidence. */
export interface ImageContextSelection {
  queries: string[];
  noteIds: string[];
  sourceIds: string[];
}
export interface ImageSearchPlan {
  queries: string[];
  focus: string;
}
export interface ImageResearchFinding {
  summary: string;
  evidenceIds: string[];
  queries: string[];
  complete: boolean;
}
export interface ImageVisualPlan {
  visualBrief: string;
  alt: string;
  evidenceIds: string[];
}
export type ImagePlanningResult = ImageContextSelection | ImageSearchPlan | ImageResearchFinding | ImageVisualPlan;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && [...value].length <= maximum &&
    !/[^\P{Cc}\n\t]/u.test(value);
}
function strings(value: unknown, maximum: number, width: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum &&
    value.every((item) => text(item, width)) && new Set(value).size === value.length;
}

export function imagePlanningSchema(stage: ImagePlanningStage): Record<string, unknown> {
  return protocol[`${stage}Schema`];
}

export function imagePlanningStageLabel(stage: ImagePlanningStage): string {
  return { select: "Context selection", search: "Context search", read: "Evidence reading", merge: "Evidence merging", compose: "Image brief preparation" }[stage];
}

/** A caller may shorten a stage to its remaining research budget, never exceed four minutes. */
export function imagePlanningTimeoutMs(request: Pick<ImagePlanningRequest, "stage" | "effort" | "timeoutMs">): number {
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > 240_000)) {
    throw new Error("The image planning timeout must be between 1 and 240 seconds.");
  }
  return request.timeoutMs ?? (request.stage === "compose"
    ? (["high", "xhigh", "max"].includes(request.effort) ? 240_000 : 120_000)
    : 60_000);
}

export function imagePlanningTokenBudget(request: Pick<ImagePlanningRequest, "stage" | "effort">): number {
  if (["high", "xhigh", "max"].includes(request.effort)) return 24_000;
  return request.stage === "compose" || request.effort === "medium" ? 12_000 : 6_000;
}

/** None is explicit for supported OpenAI models; omission would invoke their default reasoning. */
export function imagePlanningEffort(model: string, effort: ReasoningEffort): ReasoningEffort | undefined {
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Choose a valid image planning reasoning effort.");
  if (effort !== "none") return effort;
  if (model === "gpt-6-astra" || model.startsWith("gpt-6-astra-")) throw new Error("GPT-6 Astra requires at least Low reasoning for image planning.");
  return /^gpt-(?:5\.[1-9]|6(?:\.|-))/.test(model) ? "none" : undefined;
}

export function imagePlanningTimeoutMessage(stage: ImagePlanningStage, milliseconds: number): string {
  return `${imagePlanningStageLabel(stage)} did not finish within ${Math.ceil(milliseconds / 1_000)} ${milliseconds <= 1_000 ? "second" : "seconds"}. Retry to resume from completed work.`;
}

/** Shared renderer/native packet contract; no Chat or note-write authority. */
export function parseImagePlanningContext(request: Pick<ImagePlanningRequest, "stage" | "context" | "timeoutMs">) {
  if (!["select", "search", "read", "merge", "compose"].includes(request.stage) ||
    new TextEncoder().encode(request.context).length > MAX_IMAGE_PLANNING_BYTES) {
    throw new Error("The image planning context exceeded its limit.");
  }
  imagePlanningTimeoutMs({ ...request, effort: "low" });
  const value: unknown = JSON.parse(request.context);
  if (!record(value) || !text(value.selectedPassage, 32_000) ||
    typeof value.contextEnabled !== "boolean" ||
    (request.stage !== "compose" && !value.contextEnabled) ||
    !Array.isArray(value.evidence) || value.evidence.length > 96 ||
    (!value.contextEnabled && (value.evidence.length > 0 ||
      Object.keys(value).some((key) => !["selectedPassage", "activeNoteTitle", "visualDirection", "contextEnabled", "evidence"].includes(key))))) {
    throw new Error("Orion received invalid image planning context.");
  }
  return value;
}

export function parseImagePlanningResult(value: unknown, stage: ImagePlanningStage): ImagePlanningResult {
  if (record(value)) {
    const keys = Object.keys(value).sort().join(",");
    if (stage === "select" && keys === "noteIds,queries,sourceIds" &&
      strings(value.queries, 3, 300) && strings(value.noteIds, 4, 200) && strings(value.sourceIds, 4, 200)) {
      return value as unknown as ImageContextSelection;
    }
    if (stage === "search" && keys === "focus,queries" && strings(value.queries, 6, 300) && text(value.focus, 600)) {
      return value as unknown as ImageSearchPlan;
    }
    if ((stage === "read" || stage === "merge") && keys === "complete,evidenceIds,queries,summary" &&
      strings(value.evidenceIds, 96, 200) && strings(value.queries, 3, 300) && typeof value.complete === "boolean" &&
      ((text(value.summary, 3_200) && value.evidenceIds.length > 0) || (value.summary === "" && value.evidenceIds.length === 0))) {
      return value as unknown as ImageResearchFinding;
    }
    if (stage === "compose" && keys === "alt,evidenceIds,visualBrief" &&
      text(value.visualBrief, 6_000) && text(value.alt, 240) && strings(value.evidenceIds, 96, 200)) {
      return value as unknown as ImageVisualPlan;
    }
  }
  throw new Error(`${imagePlanningStageLabel(stage)} returned invalid structured evidence or an invalid visual brief. Try again.`);
}
