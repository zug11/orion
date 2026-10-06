import type { Source } from "../types";
import type { ExcerptPassage } from "./noteExcerpts";
import { sourceEvidenceVersion } from "./evidenceVersions";

let pending: { sourceId: string; version: string; passage: ExcerptPassage; requestedAt: number } | undefined;
export const SOURCE_PASSAGE_NAVIGATION_EVENT = "orion-source-passage-navigation";

/** One-shot, in-window request tied to the exact source and current text. */
export function requestSourcePassageNavigation(source: Source, passage: ExcerptPassage): void {
  if (source.text.slice(passage.from, passage.to) !== passage.text) return;
  pending = { sourceId: source.id, version: sourceEvidenceVersion(source), passage: { ...passage }, requestedAt: Date.now() };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SOURCE_PASSAGE_NAVIGATION_EVENT, { detail: { sourceId: source.id } }));
}

export function consumeSourcePassageNavigation(source: Source): ExcerptPassage | undefined {
  const request = pending;
  pending = undefined;
  return request?.sourceId === source.id && Date.now() - request.requestedAt < 10_000 &&
    request.version === sourceEvidenceVersion(source) && source.text.slice(request.passage.from, request.passage.to) === request.passage.text
    ? request.passage : undefined;
}
