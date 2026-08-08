export interface NoteOutlineHeading {
  id: string;
  text: string;
  level: 2 | 3;
  line: number;
}

export interface NoteOutlinePosition {
  id: string;
  top: number;
}

const ATX_HEADING = /^ {0,3}(#{2,3})[\t ]+(.+?)[\t ]*#*[\t ]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function headingText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/\\([\\`*_[\]{}()#+.!-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function headingSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractNoteOutline(markdown: string): NoteOutlineHeading[] {
  const counts = new Map<string, number>();
  const headings: NoteOutlineHeading[] = [];
  let closingFence: string | null = null;

  markdown.split(/\r?\n/).forEach((line, index) => {
    const fence = line.match(FENCE)?.[1];
    if (fence) {
      const marker = fence[0];
      if (!closingFence) {
        closingFence = marker;
      } else if (closingFence === marker) {
        closingFence = null;
      }
      return;
    }
    if (closingFence) return;

    const match = line.match(ATX_HEADING);
    if (!match) return;
    const text = headingText(match[2]);
    if (!text) return;
    const base = headingSlug(text) || "section";
    const occurrence = (counts.get(base) ?? 0) + 1;
    counts.set(base, occurrence);
    headings.push({
      id: `heading-${base}${occurrence > 1 ? `-${occurrence}` : ""}`,
      text,
      level: match[1].length as 2 | 3,
      line: index + 1,
    });
  });

  return headings;
}

export function resolveActiveOutlineHeading(
  headings: readonly NoteOutlinePosition[],
  threshold: number,
  atScrollEnd = false,
): string | null {
  if (headings.length === 0) return null;
  if (atScrollEnd) return headings[headings.length - 1].id;

  let active = headings[0].id;
  for (const heading of headings) {
    if (heading.top > threshold) break;
    active = heading.id;
  }
  return active;
}
