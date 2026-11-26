import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactIllustrationDiagram } from "../components/ArtifactIllustrationView";
import { parseArtifactIllustration, type ArtifactIllustration } from "./artifactIllustration";
import { standaloneIllustrationSvg } from "./illustrationSvg";

/** Re-render bounded data; never capture the screen or anything in the note. */
export async function rasteriseArtifactIllustration(
  block: ArtifactIllustration,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const drawing = parseArtifactIllustration(block);
  const markup = renderToStaticMarkup(createElement(ArtifactIllustrationDiagram, { block: drawing, stage: 0 }));
  const host = document.createElement("div");
  host.className = "visual-artifact";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:640px;pointer-events:none";
  // React's root <svg> from static markup may omit xmlns; parse as HTML so
  // the browser creates proper SVG nodes in that case.
  const parsed = new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
  if (!parsed) throw new Error("Could not prepare the drawing for visual review.");
  host.append(parsed);
  document.body.append(host);
  let svg: string, background: string;
  try {
    svg = standaloneIllustrationSvg(parsed, "Drawing for visual review");
    background = getComputedStyle(host).backgroundColor;
  } finally {
    host.remove();
  }
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", cancel);
        image.onload = null;
        image.onerror = null;
      };
      const cancel = () => {
        finish();
        reject(signal.reason ?? new Error("Visual review cancelled."));
      };
      image.onload = () => {
        finish();
        resolve();
      };
      image.onerror = () => {
        finish();
        reject(new Error("Could not render the drawing for visual review."));
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else image.src = url;
    });
    signal.throwIfAborted();
    const canvas = document.createElement("canvas"),
      scale = 960 / Math.max(image.naturalWidth, image.naturalHeight, 1);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the drawing preview.");
    context.fillStyle = background || "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
