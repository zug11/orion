import { MAX_ARTIFACT_BYTES, parseVisualArtifact, type VisualArtifact } from "./visualArtifacts";

const prefix = "<!-- orion-artifact:v1 ";
const maxPayloadLength = 4 * Math.ceil(MAX_ARTIFACT_BYTES / 3);

// A standard base64 alphabet keeps user-written Unicode and HTML comment delimiters
// out of the marker. The inner JSON remains ordinary, versioned document data.
export function visualArtifactMarker(artifact: VisualArtifact): string {
  const bytes = new TextEncoder().encode(JSON.stringify(parseVisualArtifact(artifact)));
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new Error("This visualisation is too large to save.");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return prefix + btoa(binary) + " -->";
}

export function isVisualArtifactMarker(value: unknown): value is string {
  return typeof value === "string" && value.length <= maxPayloadLength + 64
    && /^<!-- orion-artifact:v\d+ [^<>\r\n]* -->$/.test(value);
}

export function readVisualArtifactMarker(marker: unknown): VisualArtifact | null {
  if (!isVisualArtifactMarker(marker) || !marker.startsWith(prefix)) return null;
  const payload = marker.slice(prefix.length, -4);
  if (!payload || payload.length > maxPayloadLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  try {
    const bytes = Uint8Array.from(atob(payload), char => char.charCodeAt(0));
    return parseVisualArtifact(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return null; }
}

export const unavailableVisualArtifact = "This visualisation could not be displayed.";

interface MarkdownNode {
  type: string;
  value?: string;
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  children?: MarkdownNode[];
}

/** Only standalone markers in document flow are interactive. Quoted examples and code stay literal. */
export function remarkVisualArtifacts() {
  return (tree: MarkdownNode) => {
    if (!tree.children) return;
    tree.children = tree.children.map(child => {
      if (child.type !== "html" || !isVisualArtifactMarker(child.value)) return child;
      return { type: "orionArtifact", position: child.position,
        data: { hName: "aside", hProperties: { "data-orion-artifact": child.value } }, children: [] };
    });
  };
}
