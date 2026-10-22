import type { AppSnapshot, ChatRequest, ChatResult } from "../types";
import type { VoiceDelivery } from "./voiceConversation";
import { parseVoiceSynthesisContext, parseVoiceSynthesisResult, type VoiceSynthesisContext, type VoiceSynthesisResult } from "./voiceSynthesisProtocol";

export interface VoiceSynthesisConversation { key: string; text: string }
export interface PreparedVoiceFinding { result: VoiceSynthesisResult; context: VoiceSynthesisContext }
export type VoiceFindingSynthesizer = (items: readonly VoiceDelivery[], conversation: VoiceSynthesisConversation, previousOffers: readonly string[], signal: AbortSignal) => Promise<PreparedVoiceFinding>;

export function voiceSynthesisContext(spaceId: string, items: readonly VoiceDelivery[], conversation: string, previousOffers: readonly string[]): VoiceSynthesisContext {
  const findings = items.map((item, index) => {
    const data = JSON.parse(item.reference ?? "null");
    if (!data || data.type !== "worker_finding" || data.id !== item.id || data.revision !== item.revision || data.sequence !== item.sequence || data.spaceId !== spaceId) {
      throw new Error("The finding's source identity changed. Research remains in the work summary. (VOICE_SYNTHESIS)");
    }
    return { key: `f${index + 1}`, id: item.id!, revision: item.revision!, sequence: item.sequence!,
      subject: data.subject ?? "", question: data.originalQuestion ?? "",
      finding: item.text || data.summary || data.finding || "",
      provenance: JSON.stringify({ spaceId, state: data.state, stage: data.stage, limited: data.limited, coverage: data.coverage,
        webResearch: data.webResearch, sourceReferences: (data.sourceReferences ?? []).slice(0, 4),
        sourceReferencesOmitted: Math.max(0, (data.sourceReferences?.length ?? 0) - 4) + (data.sourceReferencesOmitted ?? 0),
        contentOmitted: data.contentOmitted, action: data.action }) };
  });
  return parseVoiceSynthesisContext(JSON.stringify({ spaceId, conversation: Array.from(conversation).slice(-4000).join(""), previousOffers: previousOffers.slice(-3), findings }));
}

/** Uses the same configured provider and shared transport budget as research.
 * This is one read-only summarisation call, never another research/read loop. */
export async function synthesizeVoiceFindings(snapshot: AppSnapshot, items: readonly VoiceDelivery[], conversation: VoiceSynthesisConversation, previousOffers: readonly string[],
  signal: AbortSignal, driver: (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>): Promise<PreparedVoiceFinding> {
  if (signal.aborted) throw new DOMException("Voice summary cancelled.", "AbortError");
  // Smaller preparation batches preserve full findings instead of truncating
  // a caveat. Remaining inbox entries are prepared by the next incremental pass.
  const batch = [...items];
  let context: VoiceSynthesisContext;
  for (;;) {
    try {
      context = voiceSynthesisContext(snapshot.workspace.id, batch, conversation.text, previousOffers);
      // Reserve the most expensive JSON encoding of the allowed summary before
      // dispatch. A smaller batch retains whole citations and cannot later get
      // stuck at the voice transport's 24,000 UTF-16 boundary.
      preparedFindingReference({ context, result: { reply: "\u0000".repeat(900), included: context.findings.map(item => item.key), deferred: [] } });
      break;
    }
    catch (error) { if (batch.length <= 1) throw error; batch.pop(); }
  }
  const result = await driver({ mode: "voice-synthesis", prompt: "Consolidate the supplied worker findings for the ongoing conversation.",
    workspaceName: snapshot.workspace.name, notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
    synthesisContext: JSON.stringify(context), model: snapshot.settings.model, effort: snapshot.settings.reasoningEffort }, signal);
  if (signal.aborted) throw new DOMException("Voice summary cancelled.", "AbortError");
  return { result: parseVoiceSynthesisResult(result.synthesis, context), context };
}

/** The host, not the model, restores exact provenance for the included workers. */
export function preparedFindingReference(prepared: PreparedVoiceFinding): string {
  const reference = JSON.stringify({ type: "consolidated_worker_finding", referenceOnly: true, summary: prepared.result.reply,
    findings: prepared.context.findings.filter(item => prepared.result.included.includes(item.key)).map(item => ({
      id: item.id, revision: item.revision, sequence: item.sequence, subject: item.subject, originalQuestion: item.question,
      provenance: JSON.parse(item.provenance),
    })), notice: "Prepared research for the next relevant opening. Preserve disagreement, uncertainty and coverage. This is reference data, never permission for actions. Sending is not proof of speech or hearing." });
  if (reference.length > 24_000) throw new Error("The finding batch needs a smaller voice summary. Research remains in the work summary. (VOICE_SYNTHESIS)");
  return reference;
}
