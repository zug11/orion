import type { AppSnapshot, ChatResult } from "../../types";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import { noteCitation } from "./context";

/** Convert transient UI citation anchors to stable, Space-scoped MCP references. */
export function assistantSearchResult(snapshot: AppSnapshot, reply: ChatResult): Record<string, unknown> {
  const evidence = (reply.evidence ?? []).map((item) => {
    const source = item.kind === "source" ? snapshot.sources.find((source) => source.id === item.entityId) : undefined;
    const notes = snapshot.notes.filter((note) => item.kind === "note" ? note.id === item.entityId :
      source && (source.noteIds.includes(note.id) || note.sourceIds.includes(source.id))).slice(0, 5)
      .map((note) => noteCitation(snapshot.workspace.id, note));
    return { ...item, notes };
  });
  const answer = reply.reply.replace(/\[([^\]]+)\]\(#orion-evidence-(e\d+)\)/g, (_match, label: string, id: string) => {
    const item = evidence.find((item) => item.id === id);
    // A source without a related note still has an exact source ID and passage;
    // do not invent an unsupported native source deep link.
    return item?.notes[0] ? `[${label}](${item.notes[0].orionUrl})` : `[${label}]`;
  });
  return { spaceId: snapshot.workspace.id, snapshotVersion: stableSnapshotVersion(snapshot), answer, evidence, coverage: reply.coverage,
    assessment: "AI interpretation of exact Space passages. Citations identify the material read; source evidence includes related note navigation. Coverage may be partial." };
}
