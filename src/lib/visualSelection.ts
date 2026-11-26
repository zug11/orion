import type { Settings } from "../types";
import { isSelectedAIConfigured } from "./ai";
import { isChatGPTModel } from "./chatgpt";
import { chatWithOrion } from "./storage";
import { MAX_ARTIFACT_GUIDANCE, MAX_ARTIFACT_SOURCE, parseArtifactGenerationInput, type ArtifactFormat } from "./visualArtifacts";

// A provider packet and a saved excerpt both have bounds. The user's selection
// can span any number of packets. Only exact spans move between reading passes.
const gap = "\n\n[…]\n\n";
const excerptBudget = 1_200;
const overlap = 240;

export interface VisualSelection {
  text: string;
  excerpts?: string[];
}

export function matchesSelectionPassage(selection: VisualSelection, passage: string): boolean {
  if (!selection.text.includes(passage)) return false;
  const {excerpts} = selection;
  return !excerpts || passage.split(gap).every(span =>
    span.length > 0 && excerpts.some(excerpt => excerpt.includes(span)));
}

function safeBoundary(text: string, at: number) {
  const code = text.charCodeAt(at);
  return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
}

function sections(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + MAX_ARTIFACT_SOURCE;
    if (end >= text.length) end = text.length;
    else {
      // Search only the end of the window, even for a book with no newlines.
      const tail = text.slice(end - 1_000, end);
      const split = Math.max(tail.lastIndexOf("\n"), tail.lastIndexOf(" "));
      end = safeBoundary(text, split < 0 ? end : end - tail.length + split + 1);
    }
    const piece = text.slice(start, end);
    if (/\S/u.test(piece)) result.push(piece);
    if (end === text.length) break;
    start = safeBoundary(text, end - overlap);
  }
  return result;
}

function pack(excerpts: string[]): string[] {
  const packets: string[] = [];
  let current = "";
  for (const excerpt of excerpts) {
    if (current && current.length + gap.length + excerpt.length > MAX_ARTIFACT_SOURCE) {
      packets.push(current);
      current = "";
    }
    current += (current ? gap : "") + excerpt;
  }
  if (current) packets.push(current);
  return packets;
}

function readExcerpts(reply: string, packet: string, combining: boolean): string[] {
  const invalid = () => new Error("The reader could not return verified excerpts from this section.");
  if (reply.length > 12_000) throw invalid();
  let raw;
  try { raw = JSON.parse(reply); } catch { throw invalid(); }
  const quotes = raw?.excerpts;
  if (!raw || Object.keys(raw).length !== 1 || !Array.isArray(quotes) || !quotes.length || quotes.length > 8 ||
      quotes.some(q => typeof q !== "string" || !q.trim()) || quotes.join(gap).length > excerptBudget) throw invalid();
  // A reduction can select only text inside one of its supplied excerpts.
  const parts = combining ? packet.split(gap) : [packet];
  const found = [...new Set<string>(quotes)].map(quote => {
    const index = packet.indexOf(quote);
    if (index < 0 || !parts.some(part => part.includes(quote)) || quote.includes(gap)) throw invalid();
    return { quote, index };
  });
  return found.sort((a, b) => a.index - b.index).map(item => item.quote);
}

export async function prepareVisualSelection(
  text: string, format: ArtifactFormat | "auto", guidance: string, settings: Settings,
  signal: AbortSignal, onProgress?: (message: string) => void,
): Promise<VisualSelection> {
  signal.throwIfAborted();
  if (!/\S/u.test(text)) throw new Error("Select some note text to visualise.");
  if (!isSelectedAIConfigured(settings)) throw new Error("Connect your selected AI provider in Settings to generate a visual.");
  // Check the options before any requests. Formatting/guidance and per-packet
  // validation still apply to short and long inputs alike.
  if (guidance.length > MAX_ARTIFACT_GUIDANCE) throw new Error("Keep the guidance within 800 characters.");
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(text)) throw new Error("The selected text contains unsupported control characters.");
  const direct = text.length <= MAX_ARTIFACT_SOURCE;
  let packets = direct ? [text] : sections(text);
  parseArtifactGenerationInput({source: packets[0], format, guidance});
  if (direct) return {text};

  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, {once: true});
  try {
    let combining = false;
    for (;;) {
      const results: string[][] = new Array(packets.length);
      let next = 0;
      let completed = 0;
      const phase = combining ? "Combining selection · group" : "Reading selection · section";
      onProgress?.(phase + " 1 of " + packets.length);
      async function read() {
        while (next < packets.length) {
          controller.signal.throwIfAborted();
          const i = next++;
          const timer = setTimeout(() => controller.abort(new Error(phase + " " + (i + 1) + " timed out. Try generating again.")), 120_000);
          try {
            const result = await chatWithOrion({
              mode: "visual-artifact", prompt: JSON.stringify({source: packets[i], format, guidance, readSelection:true}),
              model: settings.model, effort: settings.reasoningEffort, workspaceName:"",
              ...(isChatGPTModel(settings.model) && settings.chatgptAccountId && { drawingAccountId: settings.chatgptAccountId }),
              notes:[], sources:[], concepts:[], history:[], allowNoteActions:false,
            }, controller.signal);
            controller.signal.throwIfAborted();
            results[i] = readExcerpts(result.reply, packets[i], combining);
            completed++;
            if (completed < packets.length) onProgress?.(phase + " " + (completed + 1) + " of " + packets.length);
          } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            const reason = new Error(phase + " " + (i + 1) + " of " + packets.length + " failed. " +
              (error instanceof Error ? error.message : "Try generating again."));
            controller.abort(reason);
            throw reason;
          } finally { clearTimeout(timer); }
        }
      }
      await Promise.all([read(), read()]);
      controller.signal.throwIfAborted();
      const excerpts = [...new Set(results.flat())];
      packets = pack(excerpts);
      if (packets.length === 1) {
        onProgress?.("");
        return {text: packets[0], excerpts};
      }
      combining = true;
    }
  } finally { signal.removeEventListener("abort", cancel); }
}
