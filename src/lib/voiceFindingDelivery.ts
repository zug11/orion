import type { ChatResult } from "../types";

interface VoiceFindingInput {
  id: string;
  spaceId?: string;
  revision: number;
  sequence: number;
  subject: string;
  state: "running" | "completed";
  result: ChatResult;
  receipt?: { savedNoteIds: readonly string[]; savedTitles: readonly string[] };
  acknowledgement?: "saved" | "already-saved";
}

/** Evidence IDs are local to one worker. Keep exact host-validated identities
 * and names together, without copying passages or inventing shortened names. */
function sourceReferences(result: ChatResult) {
  const references: { evidenceId: string; kind: "note" | "source"; entityId: string; title: string; version: string;
    start: number; end: number; offsetUnit: "utf16" }[] = [];
  let length = 2;
  const seen = new Set<string>();
  for (const item of result.evidence ?? []) {
    if (references.length === 12 || seen.has(item.id) ||
      [item.id, item.entityId, item.version].some(value => !value || [...value].length > 200) || [...item.title].length > 500) continue;
    const reference = { evidenceId: item.id, kind: item.kind, entityId: item.entityId, title: item.title,
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
export function voiceFindingDelivery(input: VoiceFindingInput): { quiet: string; commentary: string } {
  const { result } = input;
  const receipt = input.receipt?.savedNoteIds.length ? input.receipt : undefined;
  const body = prose(result.reply);
  // Native replies are bounded to 6,000 code points. Do not cut a larger reply
  // into a misleading prefix that could lose its final qualification or caveat.
  const oversized = [...body].length > 6_000;
  let commentary = oversized ? "The detailed finding is available in the work summary." : body;
  if (input.acknowledgement && receipt) {
    commentary = input.acknowledgement === "already-saved" ? "It’s already saved." : "Saved.";
  } else {
    if (!oversized && commentary && result.coverage?.limited) commentary = `From the material checked so far:\n${commentary}`;
    if (result.editProposal) commentary += `${commentary ? "\n" : ""}You can review the proposed changes in the note and accept or discard them.`;
  }
  const sources = sourceReferences(result);
  const reference = {
    type: "worker_finding", referenceOnly: true,
    id: input.id, revision: input.revision, sequence: input.sequence,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    subject: [...input.subject].slice(0, 120).join(""), state: input.state,
    stage: input.state === "running" ? "intermediate" : "complete",
    ...(input.state === "running" && !oversized ? { finding: body } : {}),
    evidenceIds: sources.references.map(item => item.evidenceId),
    sourceReferences: sources.references, sourceReferencesOmitted: sources.omitted,
    limited: result.coverage?.limited ?? null,
    ...(result.coverage ? { coverage: result.coverage } : {}),
    action: receipt ? { kind: "saved", confirmed: true,
      savedNoteIds: receipt.savedNoteIds.slice(0, 3), savedTitles: receipt.savedTitles.slice(0, 3).map(title => [...title].slice(0, 120).join("")) }
      : result.editProposal ? { kind: "proposal", applied: false, noteId: result.editProposal.noteId, requiresReview: true }
      : { kind: "none", saved: false },
    contentOnScreen: true, contentOmitted: oversized,
    notice: "Quiet reference metadata, not a script to read aloud or a new request. This packet identifies the accompanying finding; evidence IDs belong only to this worker/revision/update. Source references identify captured Space material, not new web research. When attribution helps, use its exact title; do not infer omitted sources or repeat bookkeeping. Connect the finding to the current conversation when relevant and preserve uncertainty and coverage limits. An intermediate finding does not end its worker. Only a confirmed saved receipt establishes persistence; a proposal still needs the user's review. Transport delivery does not establish that the user heard it.",
  };
  let quiet = JSON.stringify(reference);
  // JSON escaping may expand a valid 6,000-character finding beyond the
  // transport's 24,000 UTF-16 limit. Keep the exact paired commentary, omitting
  // only its redundant quiet copy rather than truncating into invalid JSON.
  if (quiet.length > 24_000 && reference.finding !== undefined) {
    delete reference.finding; reference.contentOmitted = true; quiet = JSON.stringify(reference);
  }
  return { quiet, commentary };
}
