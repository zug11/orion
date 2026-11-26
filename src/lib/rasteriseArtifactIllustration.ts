import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactIllustrationDiagram } from "../components/ArtifactIllustrationView";
import { parseArtifactIllustration, type ArtifactIllustration } from "./artifactIllustration";
import { standaloneIllustrationSvg } from "./illustrationSvg";
import { illustrationPoses } from "./illustrationPoses";

/** Re-render bounded data; never capture the screen or anything in the note. */
export async function rasteriseArtifactIllustration(
  block: ArtifactIllustration,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const drawing = parseArtifactIllustration(block);
  const samples = illustrationPoses(drawing, true);
  const host = document.createElement("div");
  host.className = "visual-artifact";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:640px;pointer-events:none";
  document.body.append(host);
  let images: string[], paper: string, background: string, foreground: string;
  try {
    images = samples.map(({stage, positions, time, label}) => {
      const markup = renderToStaticMarkup(createElement(ArtifactIllustrationDiagram, {block: drawing, stage, positions, time}));
      const svg = new DOMParser().parseFromString(markup, "text/html").querySelector("svg");
      if (!svg) throw new Error("Could not prepare the drawing for visual review.");
      host.replaceChildren(svg);
      return standaloneIllustrationSvg(svg, label);
    });
    background = getComputedStyle(host).backgroundColor;
    foreground = getComputedStyle(host).color;
    const backing = document.createElement("span");
    backing.style.backgroundColor = "Canvas";
    host.append(backing);
    paper = getComputedStyle(backing).backgroundColor;
  } finally {
    host.remove();
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the drawing preview.");
  const cols = samples.length > 1 ? 2 : 1, rows = Math.ceil(samples.length / cols);
  const caption = samples.length === 1 ? 0 : 30;
  for (const [i, svg] of images.entries()) {
    const image = await loadImage(svg, signal);
    const scale = Math.min(960 / cols / image.naturalWidth, (960 / rows - caption) / image.naturalHeight);
    const w = Math.max(1, Math.floor(image.naturalWidth * scale)), h = Math.max(1, Math.floor(image.naturalHeight * scale));
    if (i === 0) {
      canvas.width = cols * w; canvas.height = rows * (h + caption);
      // A transparent window or unthemed host must still send an opaque PNG
      // with legible captions, regardless of the provider's image background.
      context.fillStyle = paper; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = background; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = foreground; context.font = "16px system-ui";
    }
    const x = (i % cols) * w, y = Math.floor(i / cols) * (h + caption);
    context.drawImage(image, x, y + caption, w, h);
    if (caption) context.fillText(samples[i].label, x + 6, y + 21, Math.max(1,w - 12));
  }
  signal.throwIfAborted();
  return canvas.toDataURL("image/png");
}

async function loadImage(svg: string, signal: AbortSignal) {
  signal.throwIfAborted();
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
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}
