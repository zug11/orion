import { invoke, isTauri } from "@tauri-apps/api/core";

const ns = "http://www.w3.org/2000/svg";
const tags = new Set(["svg", "g", "path", "rect", "circle", "ellipse", "line", "polygon", "polyline"]);
const attributes = [
  "viewBox",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "rx",
  "ry",
  "r",
  "d",
  "points",
  "transform",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "fill-opacity",
  "opacity",
  "vector-effect",
];

/** Reconstruct just Orion's geometry. Never serialise the surrounding note,
 * controls, page CSS, event attributes, asset references or arbitrary nodes. */
export function standaloneIllustrationSvg(figure: SVGSVGElement, title: string): string {
  const doc = figure.ownerDocument;
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Orion could not resolve the drawing colours.");
  const colors = new Map<string, string>();
  function paint(value: string) {
    if (!value || value === "none") return "none";
    let hex = colors.get(value);
    if (!hex) {
      context!.clearRect(0, 0, 1, 1);
      context!.fillStyle = "#000";
      context!.fillStyle = value;
      context!.fillRect(0, 0, 1, 1);
      const rgba = context!.getImageData(0, 0, 1, 1).data;
      hex =
        "#" +
        Array.from(rgba)
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      colors.set(value, hex);
    }
    return hex;
  }
  function copy(element: Element): Element | undefined {
    if (element.namespaceURI !== ns || !tags.has(element.localName) || element.hasAttribute("data-drawing-badge"))
      return;
    const result = doc.createElementNS(ns, element.localName);
    for (const key of attributes) {
      const value = element.getAttribute(key);
      if (value !== null) result.setAttribute(key, value);
    }
    const style = getComputedStyle(element);
    result.setAttribute("fill", paint(style.fill));
    result.setAttribute("stroke", paint(style.stroke));
    for (const child of Array.from(element.children)) {
      const node = copy(child);
      if (node) result.append(node);
    }
    return result;
  }
  const root = copy(figure);
  if (!root) throw new Error("The drawing is unavailable.");
  const box = figure.getAttribute("viewBox")!.split(/\s+/).map(Number);
  root.setAttribute("width", String(Math.ceil(box[2])));
  root.setAttribute("height", String(Math.ceil(box[3])));
  const caption = doc.createElementNS(ns, "title");
  caption.textContent = title;
  root.prepend(caption);
  return new XMLSerializer().serializeToString(root);
}

export async function saveIllustrationSvg(figure: SVGSVGElement, title: string) {
  const svg = standaloneIllustrationSvg(figure, title);
  const fileName =
    (title
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .trim()
      .slice(0, 110) || "Orion illustration") + ".svg";
  if (isTauri()) {
    await invoke("export_illustration_svg", { fileName, svg });
    return;
  }
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
