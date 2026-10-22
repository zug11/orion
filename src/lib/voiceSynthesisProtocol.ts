import protocol from "./voiceSynthesisProtocol.json";

export const VOICE_SYNTHESIS_INSTRUCTIONS = protocol.instructions;
export const VOICE_SYNTHESIS_SCHEMA = protocol.schema;
export const VOICE_SYNTHESIS_MAX_FINDINGS = protocol.maxFindings;
export interface VoiceSynthesisFinding {
  key: string; id: string; revision: number; sequence: number;
  subject: string; question: string; finding: string; provenance: string;
}
export interface VoiceSynthesisContext {
  spaceId: string; conversation: string; previousOffers: string[]; findings: VoiceSynthesisFinding[];
}
export interface VoiceSynthesisResult { reply: string; included: string[]; deferred: string[] }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, required = false): value is string => typeof value === "string" && [...value].length <= max && (!required || !!value.trim());
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
const invalid = () => new Error("The voice finding summary could not be prepared. Research remains in the work summary. (VOICE_SYNTHESIS)");

export function parseVoiceSynthesisContext(raw: string | undefined): VoiceSynthesisContext {
  if (!raw || new TextEncoder().encode(raw).length > protocol.maxContextBytes) throw invalid();
  let value: unknown; try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!record(value) || !exactKeys(value, ["spaceId", "conversation", "previousOffers", "findings"]) || !text(value.spaceId, 200, true) || !text(value.conversation, 4000) ||
    !Array.isArray(value.previousOffers) || value.previousOffers.length > 3 || !value.previousOffers.every(item => text(item, 900)) ||
    !Array.isArray(value.findings) || !value.findings.length || value.findings.length > protocol.maxFindings) throw invalid();
  const identities = new Set<string>();
  value.findings.forEach((item: unknown, index: number) => {
    if (!record(item) || !exactKeys(item, ["key", "id", "revision", "sequence", "subject", "question", "finding", "provenance"]) || item.key !== `f${index + 1}` ||
      !text(item.id, 200, true) || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 ||
      !text(item.subject, 120) || !text(item.question, 600) || !text(item.finding, 6000, true) || !text(item.provenance, 8000, true) || identities.has(item.id)) throw invalid();
    identities.add(item.id);
    let provenance: unknown; try { provenance = JSON.parse(item.provenance); } catch { throw invalid(); }
    if (!record(provenance) || provenance.spaceId !== value.spaceId) throw invalid();
  });
  return value as unknown as VoiceSynthesisContext;
}

export function parseVoiceSynthesisResult(value: unknown, context: VoiceSynthesisContext): VoiceSynthesisResult {
  if (!record(value) || !exactKeys(value, ["reply", "included", "deferred"]) || !text(value.reply, protocol.maxReplyChars) ||
    !Array.isArray(value.included) || !Array.isArray(value.deferred)) throw invalid();
  const keys = [...value.included, ...value.deferred];
  const expected = new Set(context.findings.map(item => item.key));
  if (keys.length !== expected.size || new Set(keys).size !== expected.size || keys.some(key => typeof key !== "string" || !expected.has(key)) ||
    Boolean(value.reply.trim()) !== Boolean(value.included.length)) throw invalid();
  return { reply: value.reply.trim(), included: value.included as string[], deferred: value.deferred as string[] };
}
