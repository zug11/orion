import type { ChatEvidence } from "../types";

export function resolveChatEvidenceMarkers(markdown: string, evidence: ChatEvidence[], cited = new Map<string, ChatEvidence>()): string {
  if (/\]\(\s*(?:orion[^: ]*:\/\/|#orion-evidence-)/i.test(markdown)) {
    throw new Error("Use only the supplied evidence markers for Orion citations.");
  }
  return markdown.replace(/\[\[(e\d+)\]\]/g, (_marker, id: string) => {
    const item = evidence.find((candidate) => candidate.id === id);
    if (!item) throw new Error("The answer cited a passage outside the current evidence. Recheck its citations.");
    cited.set(id, item);
    return `[${[...cited.keys()].indexOf(id) + 1}](#orion-evidence-${id})`;
  });
}

/** Keep as note uses ordinary portable Orion links, not Chat-only anchors. */
export function portableChatEvidence(markdown: string, evidence: readonly ChatEvidence[]): string {
  return markdown.replace(/\[[^\]]*\]\(#orion-evidence-(e\d+)\)/g, (_match, id: string) => {
    const item = evidence.find((candidate) => candidate.id === id);
    if (!item) return "";
    const title = item.title.replace(/([\\\[\]])/g, "\\$1").replace(/[\r\n]/g, " ");
    return `[${title}](orion-${item.kind}://${encodeURIComponent(item.entityId)})`;
  });
}
