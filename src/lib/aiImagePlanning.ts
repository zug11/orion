import type { ReasoningEffort } from "../types";
import protocol from "./aiImagePlanningProtocol.json";

export const IMAGE_PLANNING_INSTRUCTIONS = protocol.instructions;
export const MAX_IMAGE_PLANNING_BYTES = 256_000;
export type ImagePlanningStage = "select" | "compose";
export interface ImagePlanningRequest {
  stage: ImagePlanningStage;
  context: string;
  model: string;
  effort: ReasoningEffort;
}
export interface ImageContextSelection {
  queries: string[];
  noteIds: string[];
  sourceIds: string[];
}
export interface ImageVisualPlan {
  visualBrief: string;
  alt: string;
  evidenceIds: string[];
}
export type ImagePlanningResult = ImageContextSelection | ImageVisualPlan;

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
  return stage === "select" ? protocol.selectSchema : protocol.composeSchema;
}

/** Shared renderer/native packet contract; no Chat or note-write authority. */
export function parseImagePlanningContext(request: Pick<ImagePlanningRequest, "stage" | "context">) {
  if (!["select", "compose"].includes(request.stage) ||
    new TextEncoder().encode(request.context).length > MAX_IMAGE_PLANNING_BYTES) {
    throw new Error("The image planning context exceeded its limit.");
  }
  const value: unknown = JSON.parse(request.context);
  if (!record(value) || !text(value.selectedPassage, 32_000) ||
    typeof value.contextEnabled !== "boolean" ||
    (request.stage === "select" && !value.contextEnabled) ||
    !Array.isArray(value.evidence) || value.evidence.length > 11 ||
    (!value.contextEnabled && (value.evidence.length > 0 ||
      Object.keys(value).some((key) => !["selectedPassage", "activeNoteTitle", "visualDirection", "contextEnabled", "evidence"].includes(key))))) {
    throw new Error("Orion received invalid image planning context.");
  }
  return value;
}

export function parseImagePlanningResult(value: unknown, stage: ImagePlanningStage): ImagePlanningResult {
  if (record(value)) {
    if (stage === "select" && Object.keys(value).sort().join(",") === "noteIds,queries,sourceIds" &&
      strings(value.queries, 3, 300) && strings(value.noteIds, 4, 200) && strings(value.sourceIds, 4, 200)) {
      return value as unknown as ImageContextSelection;
    }
    if (stage === "compose" && Object.keys(value).sort().join(",") === "alt,evidenceIds,visualBrief" &&
      text(value.visualBrief, 6_000) && text(value.alt, 240) && strings(value.evidenceIds, 11, 200)) {
      return value as unknown as ImageVisualPlan;
    }
  }
  throw new Error("The illustration planner returned invalid context or an invalid visual brief. Try again.");
}
