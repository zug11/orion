import { parseArtifactIllustration, validateIllustrationSource, type ArtifactIllustration } from "./artifactIllustration";
import { MAX_ARTIFACT_BYTES } from "./visualArtifacts";

export interface VisualReviewInput {
  png: string;
  drawing: ArtifactIllustration;
}

export function validatedVisualReview(raw: VisualReviewInput, source: string): VisualReviewInput {
  const drawing = parseArtifactIllustration(raw.drawing);
  validateIllustrationSource(drawing, source);
  if (new TextEncoder().encode(JSON.stringify(drawing)).length > MAX_ARTIFACT_BYTES) throw new Error("The drawing is too large to review.");
  const png = raw.png;
  const prefix = "data:image/png;base64,";
  const invalid = () => new Error("The visual review requires a locally rendered PNG of up to 960 pixels.");
  if (typeof png !== "string" || !png.startsWith(prefix) || png.length > 2_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(png.slice(prefix.length))) throw invalid();
  let decoded: string;
  try { decoded = atob(png.slice(prefix.length)); } catch { throw invalid(); }
  const size = (i: number) => ((decoded.charCodeAt(i) * 256 + decoded.charCodeAt(i+1)) * 256 + decoded.charCodeAt(i+2)) * 256 + decoded.charCodeAt(i+3);
  const width = size(16), height = size(20);
  if (decoded.length < 45 || !decoded.startsWith("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") || width < 1 || height < 1 || width > 960 || height > 960 ||
      decoded.charCodeAt(24) !== 8 || ![2,6].includes(decoded.charCodeAt(25)) || !decoded.endsWith("\x00\x00\x00\x00IEND\xae\x42\x60\x82")) throw invalid();
  return { drawing, png };
}
