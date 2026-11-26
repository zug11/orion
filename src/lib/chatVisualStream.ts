import { ARTIFACT_FORMATS, type ArtifactFormat, MAX_ARTIFACT_BYTES, parseVisualArtifact, type VisualArtifact } from "./visualArtifacts";
import { validateGeneratedCalculatorRanges } from "./visualArtifactCalculatorRanges";

export interface ChatVisualHeading { title: string; format: ArtifactFormat; summary?: string }

/** The provider streams a JSON envelope whose reply is itself serialized JSON.
 * Only complete blocks pass to the renderer. The terminal provider response is
 * independently validated by generateVisualArtifact before anything is saved. */
function decodeEnvelopePrefix(envelope: string): string | undefined {
  const prefix = /^\s*\{\s*"reply"\s*:\s*"/u.exec(envelope);
  if (!prefix) return;
  const encoded = envelope.slice(prefix[0].length);
  const complete = /^(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*/u.exec(encoded)?.[0];
  if (!complete) return;
  return JSON.parse('"' + complete + '"');
}

export function streamedVisualPreview(envelope: string, onHeading?: (heading: ChatVisualHeading) => void): VisualArtifact | undefined {
  const decoded = decodeEnvelopePrefix(envelope);
  if (!decoded) return;
  let depth = 0, string = false, escaped = false, end = 0;
  for (let i = 0; i < decoded.length; i++) {
    const c = decoded[i];
    if (string) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') string = false;
    } else if (c === '"') string = true;
    else if (c === "{" || c === "[") {
      if (c === "[" && depth === 1 && onHeading) {
        try {
          const header = JSON.parse(decoded.slice(0, i) + "[]}");
          if (header.version === 1 && Array.isArray(header.blocks) && ARTIFACT_FORMATS.includes(header.format) &&
              typeof header.title === "string" && header.title.trim() && header.title.length <= 160 &&
              (header.summary === undefined || typeof header.summary === "string" && header.summary.length <= 600) &&
              !/[\u0000-\u001f\u007f]/u.test(header.title + (header.summary ?? ""))) {
            onHeading({ title: header.title, format: header.format, summary: header.summary });
          }
        } catch { /* A property or an escaped string can still be incomplete. */ }
      }
      depth++;
    }
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 2 && c === "}") end = i + 1;
    }
  }
  if (!end) return;
  try {
    const artifact = parseVisualArtifact(JSON.parse(decoded.slice(0, end) + "]}"));
    validateGeneratedCalculatorRanges(artifact);
    return artifact;
  } catch { return; }
}

export function visualStreamPreview(onPreview: (artifact: VisualArtifact) => void, onHeading?: (heading: ChatVisualHeading) => void) {
  let receivedHeading = false;
  let text = "", blocks = 0, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    delta(delta: string) {
      if (closed || text.length + delta.length > MAX_ARTIFACT_BYTES * 6) {
        closed = true;
        return;
      }
      text += delta;
      if (timer !== undefined || !delta.includes("}") && (receivedHeading || !delta.includes("["))) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (closed) return;
        const preview = streamedVisualPreview(text, !receivedHeading && onHeading ? heading => {
          receivedHeading = true;
          onHeading(heading);
        } : undefined);
        if (preview && preview.blocks.length > blocks) {
          blocks = preview.blocks.length;
          onPreview(preview);
        }
      }, 60);
    },
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}

/** Read bounded SSE frames, including split UTF-8 characters and CRLF. */
export async function readVisualProviderStream(response: Response, provider: "openai" | "anthropic", onDelta: (text: string) => void): Promise<unknown> {
  if (!response.body) throw new Error("The visual stream did not start.");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", bytes = 0, stopReason: string | undefined;
  const texts = new Map<number, string>();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The visual stream ended before the response was complete.");
      bytes += value.byteLength;
      if (bytes > 4_000_000) throw new Error("The visual stream exceeded its size limit.");
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/u.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") throw new Error("The provider could not finish the visual.");
        if (provider === "openai") {
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") onDelta(event.delta);
          if (event.type === "response.completed" && event.response?.status === "completed") return event.response;
        } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
          const initial = event.content_block.text ?? "";
          if (!Number.isInteger(event.index) || event.index < 0 || texts.has(event.index) || typeof initial !== "string") throw new Error("Invalid visual stream.");
          texts.set(event.index, initial);
          onDelta(initial);
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const prior = texts.get(event.index);
          if (prior === undefined || typeof event.delta.text !== "string") throw new Error("Invalid visual stream.");
          texts.set(event.index, prior + event.delta.text);
          onDelta(event.delta.text);
        } else if (event.type === "message_delta") stopReason = event.delta?.stop_reason;
        else if (event.type === "message_stop") {
          if (stopReason !== "end_turn" && stopReason !== "stop_sequence") throw new Error("Anthropic could not finish the visual.");
          return { stop_reason: stopReason, content: [...texts].sort(([a], [b]) => a-b).map(([,text]) => ({ type: "text", text })) };
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
