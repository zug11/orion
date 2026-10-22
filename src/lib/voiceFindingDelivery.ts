import type { ChatResult } from "../types";

interface VoiceFindingInput {
  id: string;
  spaceId?: string;
  revision: number;
  sequence: number;
  subject: string;
  prompt?: string;
  state: "running" | "completed";
  result: ChatResult;
  receipt?: { savedNoteIds: readonly string[]; savedTitles: readonly string[] };
  acknowledgement?: "saved" | "already-saved";
  /** The user explicitly asked to hear this finding; ordinary arrivals are quiet. */
  requested?: boolean;
}

/** Evidence IDs are local to one worker. Keep exact host-validated identities
 * and names together, without copying passages or inventing shortened names. */
function sourceReferences(result: ChatResult) {
  const references: { evidenceId: string; kind: "note" | "source" | "web"; url?: string; retrievedAt?: string; entityId: string; title: string; version: string;
    start: number; end: number; offsetUnit: "utf16" }[] = [];
  let length = 2;
  const seen = new Set<string>();
  for (const item of result.evidence ?? []) {
    if (references.length === 12 || seen.has(item.id) ||
      [item.id, item.entityId, item.version].some(value => !value || [...value].length > 200) || [...item.title].length > 500) continue;
    const reference = { evidenceId: item.id, kind: item.kind, entityId: item.entityId, title: item.title,
      ...(item.web ? { url: item.web.url, retrievedAt: item.web.retrievedAt } : {}),
      version: item.version, start: item.start, end: item.end, offsetUnit: item.offsetUnit };
    const size = JSON.stringify(reference).length + 1;
    if (length + size > 6_000) continue;
    references.push(reference); seen.add(item.id); length += size;
  }
  return { references, omitted: (result.evidence?.length ?? 0) - references.length };
}

function prose(text: string): string {
  return text
    .replace(/[ \t]*\[[^\]]*\]\(#orion-evidence-e\d+\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/**
 * Quiet context uses session.thinking.append; only commentary is offered to
 * session.commentary.append. Neither transport acknowledgement proves speech.
 * Keep bookkeeping out of the offered prose, while retaining qualifications
 * and the actual next action a person needs to take.
 */
export function voiceFindingDelivery(input: VoiceFindingInput): { quiet: string; commentary: string; background: boolean; completion: boolean } {
  const { result } = input;
  const receipt = input.receipt?.savedNoteIds.length ? input.receipt : undefined;
  const body = prose(result.reply);
  // Native replies are bounded to 6,000 code points. Do not cut a larger reply
  // into a misleading prefix that could lose its final qualification or caveat.
  const oversized = [...body].length > 6_000;
  const brief = result.voice?.summary ? prose(result.voice.summary) : "";
  // The host outcome must survive a worker's separate spoken summary. A later
  // failed lookup does not invalidate evidence that was already returned.
  const web = result.webResearch;
  const webIssue = web?.issue ? `${web.completed ? "Some web research returned; another lookup could not finish." : "Web research did not return usable evidence."} ${prose(web.issue).replace(/\s*\(WEB_[A-Z0-9_]+\)/g, "")}` : "";
  let commentary = !input.requested && brief ? brief : oversized ? "The detailed finding is available in the work summary." : body;
  if (input.acknowledgement && receipt) {
    commentary = input.acknowledgement === "already-saved" ? "It’s already saved." : "Saved.";
  } else {
    if ((!oversized || brief) && commentary && result.coverage?.limited) commentary = `From the material checked so far:\n${commentary}`;
    if (result.editProposal) commentary += `${commentary ? "\n" : ""}You can review the proposed changes in the note and accept or discard them.`;
    if (webIssue && (brief && !input.requested || oversized)) commentary += `${commentary ? "\n" : ""}${webIssue}`;
  }
  const background = !input.requested && !(input.acknowledgement && receipt) && !result.editProposal;
  // One small, complete finding can be offered spontaneously. A long answer is
  // context, not a series of speech requests. Never trim away its final caveat.
  if (!input.requested && new TextEncoder().encode(commentary).length > (brief ? 1_600 : 480)) {
    commentary = result.editProposal ? "You can review the proposed changes in the note and accept or discard them." : "";
  }
  if (background && oversized && !brief) commentary = "";
  const sources = sourceReferences(result);
  const reference = {
    type: "worker_finding", referenceOnly: true,
    id: input.id, revision: input.revision, sequence: input.sequence,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    subject: [...input.subject].slice(0, 120).join(""), state: input.state,
    ...(input.prompt ? { originalQuestion: input.prompt.length <= 600 ? input.prompt : undefined, questionOmitted: input.prompt.length > 600 } : {}),
    stage: input.state === "running" ? "intermediate" : "complete",
    ...(brief ? { summary: brief } : {}),
    ...(!oversized ? { finding: body } : {}),
    evidenceIds: sources.references.map(item => item.evidenceId),
    sourceReferences: sources.references, sourceReferencesOmitted: sources.omitted,
    limited: result.coverage?.limited ?? null,
    ...(result.coverage ? { coverage: result.coverage } : {}),
    ...(web ? { webResearch: web } : {}),
    action: receipt ? { kind: "saved", confirmed: true,
      savedNoteIds: receipt.savedNoteIds.slice(0, 3), savedTitles: receipt.savedTitles.slice(0, 3).map(title => [...title].slice(0, 120).join("")) }
      : result.editProposal ? { kind: "proposal", applied: false, noteId: result.editProposal.noteId, requiresReview: true }
      : { kind: "none", saved: false },
    contentOnScreen: true, contentOmitted: oversized,
    notice: "Quiet reference material, not a script to read aloud or a new request. Do not announce this packet on arrival. Use it when relevant to what the user says. Evidence IDs belong only to this worker/revision/update. Source kind distinguishes captured Space material from web research. Web references include the retrieved URL and retrieval time; do not describe them as local notes or claim to have read beyond the retained excerpts. webResearch is the host-observed outcome: a failed later lookup does not erase earlier completed research. Preserve its issue when discussing the result; do not replace it with a blanket claim that Perplexity never responded. When attribution helps, use its exact title; do not infer omitted sources or repeat bookkeeping. Preserve uncertainty and coverage limits. An intermediate finding does not end its worker. Only a confirmed saved receipt establishes persistence; a proposal still needs the user's review. Transport delivery does not establish that the user heard it.",
  };
  let quiet = JSON.stringify(reference);
  // JSON escaping may expand a valid 6,000-character finding beyond the
  // transport's 24,000 UTF-16 limit. Keep the exact paired commentary, omitting
  // only its redundant quiet copy rather than truncating into invalid JSON.
  if (quiet.length > 24_000 && reference.finding !== undefined) {
    delete reference.finding; reference.contentOmitted = true; quiet = JSON.stringify(reference);
  }
  return { quiet, commentary, background, completion: input.state === "completed" };
}
