import type { ChatEvidence, Source } from "../types";
import { stableKnowledgeHash } from "./spaceKnowledge";

/** Provenance attachments do not change the source that a citation supports. */
export function sourceEvidenceVersion(source: Source): string {
  const { noteIds: _attachments, ...content } = source;
  return stableKnowledgeHash(JSON.stringify(content));
}

/** Upgrade only a legacy snapshot that still exactly matches before a write. */
export function normalizeSourceEvidenceVersions(evidence: readonly ChatEvidence[], sources: readonly Source[]): ChatEvidence[] {
  return evidence.map((item) => {
    const source = item.kind === "source" ? sources.find((candidate) => candidate.id === item.entityId) : undefined;
    return source && item.version === stableKnowledgeHash(JSON.stringify(source)) &&
      source.text.slice(item.start, item.end) === item.text
      ? { ...item, version: sourceEvidenceVersion(source) }
      : item;
  });
}
