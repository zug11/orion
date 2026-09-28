import type { CSSProperties } from "react";

export type NoteImagePlacement = "inline" | "break" | "wrap";
export type NoteImageAlignment = "left" | "center" | "right";

export interface NoteImageLayout {
  placement: NoteImagePlacement;
  alignment: NoteImageAlignment;
  widthPercent: number;
  xPercent: number | null;
  offsetY: number;
  gap: number;
  caption: string;
  showCaption: boolean;
}

export const defaultNoteImageLayout: Readonly<NoteImageLayout> = {
  placement: "inline",
  alignment: "center",
  widthPercent: 100,
  xPercent: null,
  offsetY: 0,
  gap: 18,
  caption: "",
  showCaption: false,
};

const METADATA_PREFIX = "orion-image-layout:v1:";
const MAX_TITLE_LENGTH = 8_192;
const MAX_CAPTION_LENGTH = 500;

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : fallback;
}

/** The only values allowed to reach layout CSS, persisted metadata or node attributes. */
export function normalizeNoteImageLayout(value: unknown): NoteImageLayout {
  const input = value && typeof value === "object"
    ? value as Partial<Record<keyof NoteImageLayout, unknown>>
    : {};
  const widthPercent = boundedNumber(input.widthPercent, 100, 15, 100);
  const xPercent = typeof input.xPercent === "number" && Number.isFinite(input.xPercent)
    ? Math.round(Math.min(100 - widthPercent, Math.max(0, input.xPercent)) * 100) / 100
    : null;
  return {
    placement: input.placement === "wrap" || input.placement === "break"
      ? input.placement
      : "inline",
    alignment: input.alignment === "left" || input.alignment === "right"
      ? input.alignment
      : "center",
    widthPercent,
    xPercent,
    offsetY: xPercent === null ? 0 : boundedNumber(input.offsetY, 0, 0, 10_000),
    gap: boundedNumber(input.gap, 18, 8, 40),
    caption: typeof input.caption === "string"
      ? input.caption.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, MAX_CAPTION_LENGTH)
      : "",
    showCaption: input.showCaption === true || (input.showCaption == null && typeof input.caption === "string" && input.caption.length > 0),
  };
}

/** Layout lives in the optional image title; every note remains ordinary Markdown. */
export function serializeNoteImageTitle(layout: unknown, title?: string | null): string | null {
  const normalized = normalizeNoteImageLayout(layout);
  if (Object.keys(defaultNoteImageLayout).every(
    (key) => normalized[key as keyof NoteImageLayout] === defaultNoteImageLayout[key as keyof NoteImageLayout],
  )) return title || null;
  return METADATA_PREFIX + encodeURIComponent(JSON.stringify({
    ...normalized,
    title: typeof title === "string" ? title.slice(0, 500) : "",
  }));
}

export function parseNoteImageTitle(title: unknown): { layout: NoteImageLayout; title: string | null } {
  if (typeof title !== "string") return { layout: { ...defaultNoteImageLayout }, title: null };
  if (!title.startsWith(METADATA_PREFIX)) {
    return { layout: { ...defaultNoteImageLayout }, title };
  }
  if (title.length > MAX_TITLE_LENGTH) return { layout: { ...defaultNoteImageLayout }, title: null };
  try {
    const input: unknown = JSON.parse(decodeURIComponent(title.slice(METADATA_PREFIX.length)));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid image layout");
    const data = input as Record<string, unknown>;
    return {
      layout: normalizeNoteImageLayout(data),
      title: typeof data.title === "string" ? data.title.slice(0, 500) || null : null,
    };
  } catch {
    // Reserved, malformed metadata remains inert and never becomes a tooltip.
    return { layout: { ...defaultNoteImageLayout }, title: null };
  }
}

/** Shared by the editor node view, reading surface and offline HTML export. */
export function noteImageLayoutStyle(value: unknown): CSSProperties {
  const { widthPercent, placement, alignment, gap, xPercent, offsetY } = normalizeNoteImageLayout(value);
  if (xPercent !== null) {
    const remainingRight = Math.round((100 - xPercent - widthPercent) * 100) / 100;
    const side = placement === "wrap" && xPercent > remainingRight ? "right" : "left";
    const shapeOutside = placement !== "wrap"
      ? `inset(${offsetY}px 0 0 0)`
      : side === "left"
        ? `inset(${offsetY}px max(0px, calc(${remainingRight}% - ${gap}px)) 0 0)`
        : `inset(${offsetY}px 0 0 max(0px, calc(${xPercent}% - ${gap}px)))`;
    return {
      display: "block",
      boxSizing: "border-box",
      width: "100%",
      maxWidth: "100%",
      float: side,
      clear: "both",
      margin: 0,
      paddingTop: `${offsetY + gap}px`,
      paddingBottom: `${gap}px`,
      shapeOutside,
      pointerEvents: "none",
    };
  }
  const wrap = placement === "wrap" && alignment !== "center";
  return {
    display: "block",
    width: `${widthPercent}%`,
    maxWidth: "100%",
    float: wrap ? alignment as "left" | "right" : "none",
    clear: wrap ? alignment as "left" | "right" : "both",
    marginTop: `${gap}px`,
    marginBottom: `${gap}px`,
    marginLeft: wrap ? (alignment === "right" ? `${gap}px` : "0") : alignment === "left" ? "0" : "auto",
    marginRight: wrap ? (alignment === "left" ? `${gap}px` : "0") : alignment === "right" ? "0" : "auto",
  };
}

/** The intrinsic image/caption box is shared by every free-placement surface. */
export function noteImageContentStyle(value: unknown): CSSProperties {
  const { widthPercent, xPercent } = normalizeNoteImageLayout(value);
  return xPercent === null ? {} : {
    display: "block",
    boxSizing: "border-box",
    width: `${widthPercent}%`,
    maxWidth: "100%",
    marginLeft: `${xPercent}%`,
    marginRight: 0,
    pointerEvents: "auto",
  };
}

function styleCss(style: CSSProperties): string {
  return Object.entries(style).map(([property, entry]) =>
    `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${entry}`,
  ).join(";");
}

export function noteImageLayoutCss(value: unknown): string {
  return styleCss(noteImageLayoutStyle(value));
}

export function noteImageContentCss(value: unknown): string {
  return styleCss(noteImageContentStyle(value));
}

export function escapeNoteImageMarkdownText(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/([\[\]"])/g, "\\$1").replace(/\r?\n/g, " ");
}
