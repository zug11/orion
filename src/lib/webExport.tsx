import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { slugifyTitle } from "../data/defaults";
import type { AppSnapshot, Concept, Note, ThemeMode } from "../types";
import {
  expandOrionWikiLinks,
  splitMarkdownFrontmatter,
  stripDuplicateTitleHeading,
  stripOrionNoteMarkers,
} from "./markdown";
import { extractNoteOutline } from "./noteOutline";
import { visibleNoteTags } from "./noteMetadata";
import { isSafeNoteImageUrl } from "./noteImages";
import { canonicalizeSourceCitations } from "./sourceCitations";
import {
  resolveThemePalette,
  type ResolvedThemeMode,
  type ThemePalette,
  type ThemePreferences,
} from "./theme";
import { decorateAutoLinks, resolveConceptDestination } from "./wiki";

export type ExportScope = "note" | "linked" | "space";

export interface WebExportDocument {
  fileName: string;
  html: string;
  noteIds: string[];
  title: string;
}

interface ExportSiteProps {
  snapshot: AppSnapshot;
  notes: readonly Note[];
  scope: ExportScope;
  originNoteId: string | null;
}

interface ExportNoteProps {
  snapshot: AppSnapshot;
  note: Note;
  includedNoteIds: ReadonlySet<string>;
}

type ExportThemePreferences = ThemePreferences & { theme: ThemeMode };

const ORION_LINK_PATTERN =
  /\[[^\]\n]*\]\(orion-(note|concept):\/\/([^) \t\r\n]+)\)/g;

const EXPORT_STYLES = String.raw`
:root {
  --serif: ui-serif, "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  min-width: 300px;
  min-height: 100vh;
  margin: 0;
  color: var(--text-soft);
  background:
    radial-gradient(circle at 72% -10%, var(--accent-soft), transparent 32rem),
    var(--canvas);
  font-family: var(--sans);
  -webkit-font-smoothing: antialiased;
}
button, input { font: inherit; }
a { color: inherit; }
[hidden] { display: none !important; }
.export-shell { min-height: 100vh; }
.export-sidebar {
  position: fixed;
  z-index: 5;
  inset: 0 auto 0 0;
  display: flex;
  width: 264px;
  flex-direction: column;
  padding: 28px 18px 20px;
  border-right: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface-solid) 88%, transparent);
  backdrop-filter: blur(20px) saturate(120%);
}
.export-brand { display: flex; align-items: center; gap: 10px; padding: 0 7px 23px; }
.export-brand-mark {
  display: grid;
  width: 29px;
  height: 29px;
  place-items: center;
  border-radius: 50%;
  color: var(--accent-ink);
  background: var(--accent);
  box-shadow: 0 0 0 5px var(--accent-soft);
  font-family: var(--serif);
  font-size: 15px;
}
.export-brand strong { display: block; color: var(--text); font-size: 13px; letter-spacing: .01em; }
.export-brand small { display: block; margin-top: 2px; color: var(--faint); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
.export-search {
  width: 100%;
  margin-bottom: 13px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  outline: none;
  color: var(--text);
  background: var(--surface);
  font-size: 11px;
}
.export-search:focus { border-color: color-mix(in srgb, var(--accent) 55%, var(--line)); box-shadow: 0 0 0 3px var(--accent-soft); }
.export-nav { min-height: 0; flex: 1; overflow: auto; }
.export-nav-label { display: block; padding: 7px 8px; color: var(--faint); font-size: 8px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.export-nav a {
  display: block;
  margin: 2px 0;
  padding: 8px 9px;
  overflow: hidden;
  border-radius: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.35;
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.export-nav a:hover { color: var(--text); background: var(--accent-soft); }
.export-nav a[aria-current="page"] { color: var(--text); background: var(--accent-soft); font-weight: 650; }
.export-sidebar-foot { padding: 15px 7px 0; border-top: 1px solid var(--line); color: var(--faint); font-size: 9px; line-height: 1.45; }
.export-main { min-height: 100vh; margin-left: 264px; }
.export-shell.is-single .export-sidebar { display: none; }
.export-shell.is-single .export-main { margin-left: 0; }
.export-page { min-height: 100vh; }
.export-cover {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 72px 7vw;
}
.export-cover-inner { width: min(900px, 100%); }
.export-kicker { color: var(--accent); font-size: 9px; font-weight: 760; letter-spacing: .17em; text-transform: uppercase; }
.export-cover h1 {
  max-width: 780px;
  margin: 17px 0 18px;
  color: var(--text);
  font-family: var(--serif);
  font-size: clamp(46px, 7vw, 82px);
  font-weight: 520;
  letter-spacing: -.045em;
  line-height: .98;
}
.export-cover-description { max-width: 620px; margin: 0; color: var(--muted); font-family: var(--serif); font-size: 18px; line-height: 1.65; }
.export-cover-meta { display: flex; gap: 8px; margin-top: 26px; color: var(--faint); font-size: 10px; }
.export-card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 42px; }
.export-card {
  display: block;
  min-width: 0;
  padding: 18px 19px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--surface);
  box-shadow: var(--shadow-soft);
  text-decoration: none;
  transition: transform 170ms ease, border-color 170ms ease, background 170ms ease;
}
.export-card:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); background: color-mix(in srgb, var(--surface-solid) 92%, var(--accent-soft)); transform: translateY(-2px); }
.export-card strong { display: block; overflow: hidden; color: var(--text); font-family: var(--serif); font-size: 18px; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.export-card span { display: -webkit-box; margin-top: 7px; overflow: hidden; color: var(--muted); font-size: 10.5px; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.export-note-layout {
  display: grid;
  width: min(1160px, 100%);
  grid-template-columns: minmax(0, 760px) 190px;
  gap: clamp(34px, 6vw, 76px);
  margin: 0 auto;
  padding: 72px clamp(34px, 6vw, 78px) 90px;
}
.export-note-document { min-width: 0; }
.export-note-header { padding-bottom: 31px; border-bottom: 1px solid var(--line); }
.export-note-header h1 {
  margin: 12px 0 13px;
  color: var(--text);
  font-family: var(--serif);
  font-size: clamp(42px, 5.5vw, 68px);
  font-weight: 520;
  letter-spacing: -.043em;
  line-height: 1.02;
}
.export-note-summary { max-width: 650px; margin: 0; color: var(--muted); font-family: var(--serif); font-size: 17px; line-height: 1.58; }
.export-note-meta { display: flex; flex-wrap: wrap; gap: 7px 13px; margin-top: 18px; color: var(--faint); font-size: 9px; }
.export-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 15px; }
.export-tags span { padding: 4px 7px; border-radius: 999px; color: var(--muted); background: var(--accent-soft); font-size: 8px; }
.export-prose { padding-top: 35px; color: var(--text-soft); font-family: var(--serif); font-size: 17px; line-height: 1.78; }
.export-prose > :first-child { margin-top: 0; }
.export-prose p, .export-prose ul, .export-prose ol, .export-prose blockquote, .export-prose table, .export-prose pre { margin: 0 0 1.25em; }
.export-prose h1, .export-prose h2, .export-prose h3 { color: var(--text); scroll-margin-top: 24px; }
.export-prose h1 { margin: 1.25em 0 .5em; font-size: 34px; line-height: 1.15; }
.export-prose h2 { margin: 2em 0 .58em; font-size: 26px; font-weight: 570; letter-spacing: -.02em; line-height: 1.2; }
.export-prose h3 { margin: 1.65em 0 .48em; font-size: 20px; font-weight: 590; line-height: 1.3; }
.export-prose ul, .export-prose ol { padding-left: 1.35em; }
.export-prose li { padding-left: .2em; }
.export-prose li + li { margin-top: .32em; }
.export-prose li.task-list-item { list-style: none; margin-left: -1.35em; }
.export-prose .contains-task-list { padding-left: 1.35em; }
.export-prose input[type="checkbox"] { width: 15px; height: 15px; margin: 0 9px 0 0; accent-color: var(--accent); vertical-align: -.12em; }
.export-prose blockquote { position: relative; padding: 4px 0 4px 22px; color: var(--muted); font-style: italic; }
.export-prose blockquote::before { position: absolute; inset: 0 auto 0 0; width: 2px; border-radius: 2px; content: ""; background: var(--accent); }
.export-prose code { padding: .15em .35em; border-radius: 5px; background: var(--code); font-family: var(--mono); font-size: .82em; }
.export-prose pre { padding: 17px 18px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--code); font-size: 13px; line-height: 1.55; }
.export-prose pre code { padding: 0; background: transparent; font-size: inherit; }
.export-prose hr { height: 1px; margin: 2.3em 0; border: 0; background: var(--line-strong); }
.export-prose table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; font-family: var(--sans); font-size: 12px; line-height: 1.5; }
.export-prose th, .export-prose td { min-width: 110px; padding: 9px 11px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
.export-prose th { color: var(--text); background: var(--accent-soft); font-weight: 680; }
.export-prose a, .orion-link { color: var(--accent-strong); text-decoration-color: color-mix(in srgb, var(--accent) 42%, transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.export-prose a:hover, .orion-link:hover { text-decoration-color: currentColor; }
.orion-link.is-excluded { color: inherit; text-decoration: underline dotted var(--faint); text-underline-offset: 3px; cursor: help; }
.source-citation { display: inline-flex; margin-left: .08em; color: var(--accent-strong); font-family: var(--sans); font-size: .72em; font-weight: 700; line-height: 1; text-decoration: none; vertical-align: .4em; }
.export-prose img { display: block; width: auto; max-width: 100%; height: auto; margin: 28px auto; border-radius: 12px; box-shadow: var(--shadow-soft); }
.export-image-alt { display: inline-block; padding: 8px 10px; border-radius: 7px; color: var(--muted); background: var(--code); font-family: var(--sans); font-size: 11px; }
.export-empty { color: var(--faint); font-style: italic; }
.export-outline { position: sticky; top: 38px; align-self: start; padding-top: 2px; }
.export-outline strong { display: block; margin-bottom: 11px; color: var(--faint); font-size: 8px; letter-spacing: .12em; text-transform: uppercase; }
.export-outline a { display: block; padding: 4px 0; color: var(--muted); font-size: 10px; line-height: 1.4; text-decoration: none; }
.export-outline a[data-depth="3"] { padding-left: 10px; color: var(--faint); }
.export-outline a:hover { color: var(--text); }
.export-references, .export-connected { margin-top: 52px; padding-top: 23px; border-top: 1px solid var(--line); }
.export-references h2, .export-connected h2 { margin: 0 0 16px; color: var(--text); font-family: var(--serif); font-size: 22px; font-weight: 570; }
.export-references ol { margin: 0; padding: 0; list-style: none; counter-reset: source; }
.export-references li { display: grid; grid-template-columns: 23px minmax(0, 1fr); gap: 8px; padding: 6px 0; color: var(--muted); font-size: 11px; line-height: 1.5; counter-increment: source; }
.export-references li::before { color: var(--faint); content: counter(source); font-family: var(--mono); font-size: 9px; }
.export-references a { color: var(--text-soft); text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.export-reference-meta { display: block; margin-top: 2px; color: var(--faint); font-size: 8.5px; text-transform: capitalize; }
.export-connected-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
.export-connected-list a { padding: 10px 11px; border-radius: 8px; color: var(--text-soft); background: var(--accent-soft); font-size: 10px; text-decoration: none; }
.export-connected-list a:hover { color: var(--text); }
.export-note-foot { display: flex; justify-content: space-between; gap: 12px; margin-top: 58px; padding-top: 17px; border-top: 1px solid var(--line); color: var(--faint); font-size: 8.5px; }
@media (max-width: 900px) {
  .export-sidebar { width: 220px; }
  .export-main { margin-left: 220px; }
  .export-note-layout { grid-template-columns: minmax(0, 1fr); padding-inline: clamp(25px, 6vw, 54px); }
  .export-outline { position: static; grid-row: 1; padding: 0 0 20px; border-bottom: 1px solid var(--line); }
  .export-outline a { display: inline-block; margin-right: 12px; }
}
@media (max-width: 680px) {
  .export-sidebar { position: static; width: auto; max-height: 270px; border-right: 0; border-bottom: 1px solid var(--line); }
  .export-brand { padding-bottom: 14px; }
  .export-nav { max-height: 110px; }
  .export-main { margin-left: 0; }
  .export-cover { min-height: auto; padding: 50px 24px 66px; }
  .export-card-grid, .export-connected-list { grid-template-columns: minmax(0, 1fr); }
  .export-note-layout { padding: 46px 23px 68px; }
  .export-note-header h1 { font-size: 42px; }
  .export-prose { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { transition-duration: .001ms !important; }
}
@media print {
  :root { color-scheme: light; --canvas: #fff; --surface: #fff; --surface-solid: #fff; --surface-raised: #fff; --text: #111827; --text-soft: #283247; --muted: #596273; --faint: #7b8391; --line: #dfe3ea; --line-strong: #cbd1dc; --accent: #4257b8; --accent-soft: #f1f3fb; --accent-strong: #3449aa; --accent-ink: #fff; --code: #f3f4f7; --shadow-soft: none; --shadow: none; --shadow-lg: none; }
  body { background: #fff; }
  .export-sidebar { display: none !important; }
  .export-main { margin: 0 !important; }
  .export-page[hidden] { display: block !important; }
  .export-cover { min-height: 0; page-break-after: always; }
  .export-note-layout { display: block; width: auto; padding: 22mm 18mm; }
  .export-note { page-break-before: always; }
  .export-outline { display: none; }
  .export-prose a { color: inherit; }
}
`;

const EXPORT_SCRIPT = String.raw`(() => {
  const pages = Array.from(document.querySelectorAll('[data-export-page]'));
  const navLinks = Array.from(document.querySelectorAll('[data-note-nav]'));
  const defaultId = document.body.dataset.defaultPage || pages[0]?.id || '';
  const titleRoot = document.body.dataset.exportTitle || 'Orion export';

  function decodedHash() {
    try { return decodeURIComponent(location.hash.slice(1)); }
    catch { return location.hash.slice(1); }
  }

  function activatePage() {
    const target = document.getElementById(decodedHash());
    const page = target?.closest('[data-export-page]') || document.getElementById(defaultId) || pages[0];
    if (!page) return;
    pages.forEach((candidate) => { candidate.hidden = candidate !== page; });
    navLinks.forEach((link) => {
      if (link.getAttribute('href') === '#' + page.id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = page.dataset.pageTitle ? page.dataset.pageTitle + ' · ' + titleRoot : titleRoot;
    requestAnimationFrame(() => {
      if (target && target !== page) target.scrollIntoView({ block: 'start' });
      else window.scrollTo({ top: 0, left: 0 });
    });
  }

  const search = document.querySelector('[data-export-search]');
  search?.addEventListener('input', () => {
    const query = search.value.trim().toLocaleLowerCase();
    navLinks.forEach((link) => {
      link.hidden = Boolean(query) && !String(link.dataset.search || '').includes(query);
    });
  });

  window.addEventListener('hashchange', activatePage);
  activatePage();
})();`;

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function noteAnchor(note: Note): string {
  const slug = slugifyTitle(note.title) || "note";
  return `note-${slug}-${stableHash(note.id)}`;
}

function sourceAnchor(note: Note, sourceId: string): string {
  return `source-${stableHash(note.id)}-${stableHash(sourceId)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exportPaletteVariables(
  palette: ThemePalette,
  mode: ResolvedThemeMode,
): Record<`--${string}`, string> {
  return {
    "--canvas": palette.canvas,
    "--canvas-deep": palette.canvasDeep,
    "--surface": `color-mix(in srgb, ${palette.surface1} 92%, transparent)`,
    "--surface-0": palette.surface0,
    "--surface-solid": palette.surface1,
    "--surface-2": palette.surface2,
    "--surface-3": palette.surface3,
    "--surface-raised": palette.surfaceRaised,
    "--text": palette.text,
    "--text-soft": palette.textSoft,
    "--muted": palette.muted,
    "--faint": palette.faint,
    "--line": palette.line,
    "--line-strong": palette.lineStrong,
    "--accent": palette.accent,
    "--accent-soft": `color-mix(in srgb, ${palette.accent} ${mode === "dark" ? 13 : 10}%, transparent)`,
    "--accent-strong": palette.accentStrong,
    "--accent-ink": palette.accentInk,
    "--mint": palette.mint,
    "--gold": palette.gold,
    "--rose": palette.rose,
    "--danger": palette.danger,
    "--code": palette.surface2,
    "--shadow-soft": palette.shadowSm,
    "--shadow": palette.shadowMd,
    "--shadow-lg": palette.shadowLg,
  };
}

function exportPaletteRule(
  settings: ExportThemePreferences,
  mode: ResolvedThemeMode,
): string {
  const declarations = Object.entries(
    exportPaletteVariables(resolveThemePalette(settings, mode), mode),
  )
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n  color-scheme: ${mode};\n${declarations}\n}`;
}

function exportThemeStyles(settings: ExportThemePreferences): string {
  if (settings.theme !== "system") {
    return exportPaletteRule(settings, settings.theme);
  }
  return `${exportPaletteRule(settings, "light")}\n@media (prefers-color-scheme: dark) {\n${exportPaletteRule(settings, "dark")}\n}`;
}

function exportThemeMetadata(settings: ExportThemePreferences): string {
  if (settings.theme !== "system") {
    const palette = resolveThemePalette(settings, settings.theme);
    return `<meta name="color-scheme" content="${settings.theme}">\n<meta name="theme-color" content="${palette.canvas}">`;
  }
  const light = resolveThemePalette(settings, "light");
  const dark = resolveThemePalette(settings, "dark");
  return `<meta name="color-scheme" content="light dark">\n<meta name="theme-color" content="${light.canvas}" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="${dark.canvas}" media="(prefers-color-scheme: dark)">`;
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value || !/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  return value;
}

function conceptDestinationIds(
  concept: Concept,
  notes: readonly Note[],
): string[] {
  const destination = resolveConceptDestination(concept, notes);
  return destination.kind === "note"
    ? [destination.noteId]
    : destination.kind === "connections"
      ? destination.noteIds
      : [];
}

export function linkedNoteIdsForExport(
  note: Note,
  snapshot: AppSnapshot,
): string[] {
  const expanded = expandOrionWikiLinks(
    splitMarkdownFrontmatter(stripOrionNoteMarkers(note.body)).content,
    snapshot.notes,
    snapshot.concepts,
  );
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  ORION_LINK_PATTERN.lastIndex = 0;
  while ((match = ORION_LINK_PATTERN.exec(expanded)) !== null) {
    if (match[1] === "note") {
      ids.add(match[2]);
      continue;
    }
    const concept = snapshot.concepts.find((item) => item.id === match?.[2]);
    if (concept) {
      conceptDestinationIds(concept, snapshot.notes).forEach((id) => ids.add(id));
    }
  }

  for (const segment of decorateAutoLinks(expanded, snapshot.concepts, {
    excludeNoteIdFromTargets: note.id,
  })) {
    if (segment.type !== "concept") continue;
    const concept = snapshot.concepts.find(
      (candidate) => candidate.id === segment.conceptId,
    );
    if (concept) {
      conceptDestinationIds(concept, snapshot.notes).forEach((id) => ids.add(id));
    }
  }

  ids.delete(note.id);
  return snapshot.notes.filter((candidate) => ids.has(candidate.id)).map(({ id }) => id);
}

export function notesForExportScope(
  snapshot: AppSnapshot,
  scope: ExportScope,
  originNoteId: string | null,
): Note[] {
  if (scope === "space") return [...snapshot.notes];
  const origin = snapshot.notes.find((note) => note.id === originNoteId);
  if (!origin) return [];
  if (scope === "note") return [origin];
  const linkedIds = new Set(linkedNoteIdsForExport(origin, snapshot));
  return [origin, ...snapshot.notes.filter((note) => linkedIds.has(note.id))];
}

function ExportLink({
  children,
  noteIds,
  notes,
  title,
}: {
  children: ReactNode;
  noteIds: readonly string[];
  notes: readonly Note[];
  title?: string;
}) {
  const destination = notes.find((note) => noteIds.includes(note.id));
  if (!destination) {
    return (
      <span className="orion-link is-excluded" title={title ?? "This page is not included in the export"}>
        {children}
      </span>
    );
  }
  return (
    <a className="orion-link" href={`#${noteAnchor(destination)}`}>
      {children}
    </a>
  );
}

function ExportNote({ snapshot, note, includedNoteIds }: ExportNoteProps) {
  const document = splitMarkdownFrontmatter(note.body);
  const expanded = expandOrionWikiLinks(
    stripDuplicateTitleHeading(
      stripOrionNoteMarkers(document.content),
      note.title,
    ),
    snapshot.notes,
    snapshot.concepts,
  );
  const citations = canonicalizeSourceCitations(expanded, snapshot.sources);
  const outline = extractNoteOutline(citations.body);
  const headingByLine = new Map(outline.map((heading) => [heading.line, heading]));
  const sourceById = new Map(snapshot.sources.map((source) => [source.id, source]));
  const referenceById = new Map(
    citations.references.map((reference) => [reference.sourceId, reference]),
  );
  const includedNotes = snapshot.notes.filter((candidate) => includedNoteIds.has(candidate.id));
  const linkableConcepts = snapshot.concepts
    .filter((concept) => concept.canonicalNoteId !== note.id)
    .map((concept) => ({
      ...concept,
      noteIds: concept.noteIds.filter((noteId) => noteId !== note.id),
    }))
    .filter((concept) => concept.noteIds.length > 0);

  function renderLinkedChildren(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
      if (typeof child === "string") {
        return decorateAutoLinks(child, linkableConcepts).map((segment, index) => {
          if (segment.type === "text") return segment.text;
          const concept = linkableConcepts.find(
            (candidate) => candidate.id === segment.conceptId,
          );
          if (!concept) return segment.text;
          return (
            <ExportLink
              key={`${concept.id}-${index}`}
              noteIds={conceptDestinationIds(concept, snapshot.notes).filter((id) =>
                includedNoteIds.has(id),
              )}
              notes={includedNotes}
            >
              {segment.text}
            </ExportLink>
          );
        });
      }
      if (!isValidElement(child)) return child;
      const element = child as ReactElement<{
        children?: ReactNode;
        href?: string;
        className?: string;
      }>;
      const protectedInline =
        child.type === "code" ||
        child.type === "a" ||
        typeof element.props.href === "string";
      if (protectedInline || element.props.children === undefined) return child;
      return cloneElement(element, {
        ...element.props,
        children: renderLinkedChildren(element.props.children),
      });
    });
  }

  const components: Components = {
    p: ({ children }) => <p>{renderLinkedChildren(children)}</p>,
    li: ({ children, className }) => (
      <li className={className}>{renderLinkedChildren(children)}</li>
    ),
    h1: ({ children }) => <h1>{renderLinkedChildren(children)}</h1>,
    h2: ({ children, node }) => {
      const heading = headingByLine.get(node?.position?.start.line ?? -1);
      return (
        <h2 id={heading ? `${noteAnchor(note)}--${heading.id}` : undefined}>
          {renderLinkedChildren(children)}
        </h2>
      );
    },
    h3: ({ children, node }) => {
      const heading = headingByLine.get(node?.position?.start.line ?? -1);
      return (
        <h3 id={heading ? `${noteAnchor(note)}--${heading.id}` : undefined}>
          {renderLinkedChildren(children)}
        </h3>
      );
    },
    a: ({ href, children }) => {
      if (href?.startsWith("orion-note://")) {
        const targetId = href.slice("orion-note://".length);
        return (
          <ExportLink
            noteIds={includedNoteIds.has(targetId) ? [targetId] : []}
            notes={includedNotes}
          >
            {children}
          </ExportLink>
        );
      }
      if (href?.startsWith("orion-concept://")) {
        const concept = snapshot.concepts.find(
          (candidate) => candidate.id === href.slice("orion-concept://".length),
        );
        const destinationIds = concept
          ? conceptDestinationIds(concept, snapshot.notes).filter((id) =>
              includedNoteIds.has(id),
            )
          : [];
        return (
          <ExportLink noteIds={destinationIds} notes={includedNotes}>
            {children}
          </ExportLink>
        );
      }
      if (href?.startsWith("orion-source://")) {
        const sourceId = href.slice("orion-source://".length);
        const reference = referenceById.get(sourceId);
        return (
          <a
            className="source-citation"
            href={`#${sourceAnchor(note, sourceId)}`}
            aria-label={`Reference ${reference?.number ?? children}`}
          >
            [{reference?.number ?? children}]
          </a>
        );
      }
      const safe = safeExternalUrl(href);
      return safe ? (
        <a href={safe} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      ) : (
        <span>{children}</span>
      );
    },
    img: ({ alt, src }) =>
      src && isSafeNoteImageUrl(src) ? (
        <img src={src} alt={alt ?? ""} />
      ) : (
        <span className="export-image-alt">
          {alt ? `Image: ${alt}` : "Image omitted from offline export"}
        </span>
      ),
    input: ({ checked, ...props }) => (
      <input {...props} type="checkbox" checked={Boolean(checked)} readOnly />
    ),
  };

  const directlyLinked = linkedNoteIdsForExport(note, snapshot)
    .map((id) => snapshot.notes.find((candidate) => candidate.id === id))
    .filter(
      (candidate): candidate is Note =>
        candidate !== undefined && includedNoteIds.has(candidate.id),
    );
  const updated = formatDate(note.updatedAt);
  const tags = visibleNoteTags(note);

  return (
    <article
      className="export-page export-note"
      id={noteAnchor(note)}
      data-export-page
      data-page-title={note.title}
      hidden
    >
      <div className="export-note-layout">
        <div className="export-note-document">
          <header className="export-note-header">
            <span className="export-kicker">From {snapshot.workspace.name}</span>
            <h1>{note.title.trim() || "Untitled note"}</h1>
            {note.summary.trim() ? <p className="export-note-summary">{note.summary}</p> : null}
            <div className="export-note-meta">
              <span>Updated {updated}</span>
              <span>{wordCount(citations.body).toLocaleString()} words</span>
            </div>
            {tags.length > 0 ? (
              <div className="export-tags">
                {tags.map((tag) => <span key={tag}>#{tag}</span>)}
              </div>
            ) : null}
          </header>

          <div className="export-prose">
            {citations.body.trim() ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={components}
                skipHtml
                urlTransform={(url) => url}
              >
                {citations.body}
              </ReactMarkdown>
            ) : (
              <p className="export-empty">This note is blank.</p>
            )}
          </div>

          {citations.references.length > 0 ? (
            <section className="export-references" aria-label="References">
              <h2>References</h2>
              <ol>
                {citations.references.map((reference) => {
                  const source = sourceById.get(reference.sourceId);
                  const externalUrl = safeExternalUrl(source?.sourceUrl);
                  return (
                    <li id={sourceAnchor(note, reference.sourceId)} key={reference.sourceId}>
                      <div>
                        {externalUrl ? (
                          <a href={externalUrl} target="_blank" rel="noreferrer noopener">
                            {reference.title}
                          </a>
                        ) : (
                          <span>{reference.title}</span>
                        )}
                        <span className="export-reference-meta">
                          {source ? `${source.kind} source · source text not included` : "Source unavailable"}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {directlyLinked.length > 0 ? (
            <section className="export-connected" aria-label="Connected pages">
              <h2>Continue through this space</h2>
              <div className="export-connected-list">
                {directlyLinked.map((connected) => (
                  <a href={`#${noteAnchor(connected)}`} key={connected.id}>{connected.title}</a>
                ))}
              </div>
            </section>
          ) : null}

          <footer className="export-note-foot">
            <span>Exported from Orion</span>
            <span>Snapshot · {formatDate(new Date().toISOString())}</span>
          </footer>
        </div>

        {outline.length > 0 ? (
          <nav className="export-outline" aria-label={`On this page: ${note.title}`}>
            <strong>On this page</strong>
            {outline.map((heading) => (
              <a
                href={`#${noteAnchor(note)}--${heading.id}`}
                data-depth={heading.level}
                key={heading.id}
              >
                {heading.text}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </article>
  );
}

function ExportCover({ snapshot, notes }: { snapshot: AppSnapshot; notes: readonly Note[] }) {
  return (
    <section
      className="export-page export-cover"
      id="space-home"
      data-export-page
      data-page-title={snapshot.workspace.name}
    >
      <div className="export-cover-inner">
        <span className="export-kicker">An Orion knowledge space</span>
        <h1>{snapshot.workspace.name}</h1>
        {snapshot.workspace.description.trim() ? (
          <p className="export-cover-description">{snapshot.workspace.description}</p>
        ) : null}
        <div className="export-cover-meta">
          <span>{notes.length} {notes.length === 1 ? "note" : "notes"}</span>
          <span>·</span>
          <span>Exported {formatDate(new Date().toISOString())}</span>
        </div>
        <div className="export-card-grid">
          {notes.map((note) => (
            <a className="export-card" href={`#${noteAnchor(note)}`} key={note.id}>
              <strong>{note.title.trim() || "Untitled note"}</strong>
              <span>{note.summary.trim() || firstReadableSentence(note.body)}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExportSite({ snapshot, notes, scope, originNoteId }: ExportSiteProps) {
  const includedNoteIds = new Set(notes.map((note) => note.id));
  const origin = notes.find((note) => note.id === originNoteId) ?? notes[0];
  const defaultPage = scope === "space" ? "space-home" : origin ? noteAnchor(origin) : "space-home";
  const showSidebar = notes.length > 1 || scope === "space";
  return (
    <div className={`export-shell${showSidebar ? "" : " is-single"}`}>
      <aside className="export-sidebar">
        <div className="export-brand">
          <span className="export-brand-mark" aria-hidden="true">O</span>
          <span>
            <strong>{snapshot.workspace.name}</strong>
            <small>Orion export</small>
          </span>
        </div>
        {notes.length > 7 ? (
          <input className="export-search" data-export-search type="search" placeholder="Filter pages…" aria-label="Filter exported pages" />
        ) : null}
        <nav className="export-nav" aria-label="Exported pages">
          {scope === "space" ? (
            <a href="#space-home" data-note-nav data-search={snapshot.workspace.name.toLocaleLowerCase()}>
              Space overview
            </a>
          ) : null}
          <span className="export-nav-label">Pages</span>
          {notes.map((note) => (
            <a
              href={`#${noteAnchor(note)}`}
              data-note-nav
              data-search={`${note.title} ${note.summary} ${visibleNoteTags(note).join(" ")}`.toLocaleLowerCase()}
              key={note.id}
            >
              {note.title.trim() || "Untitled note"}
            </a>
          ))}
        </nav>
        <div className="export-sidebar-foot">
          A private snapshot. Raw imported source text and Orion settings are not included.
        </div>
      </aside>
      <main className="export-main">
        {scope === "space" ? <ExportCover snapshot={snapshot} notes={notes} /> : null}
        {notes.map((note) => (
          <ExportNote
            snapshot={snapshot}
            note={note}
            includedNoteIds={includedNoteIds}
            key={note.id}
          />
        ))}
      </main>
      <span hidden data-default-page={defaultPage} />
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function wordCount(markdown: string): number {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

function firstReadableSentence(markdown: string): string {
  const readable = splitMarkdownFrontmatter(stripOrionNoteMarkers(markdown)).content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~|\[\]-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!readable) return "A page from this knowledge space.";
  return readable.length > 150 ? `${readable.slice(0, 147).trimEnd()}…` : readable;
}

export function buildWebExportDocument(
  snapshot: AppSnapshot,
  scope: ExportScope,
  originNoteId: string | null,
): WebExportDocument {
  const notes = notesForExportScope(snapshot, scope, originNoteId);
  if (notes.length === 0) {
    throw new Error(scope === "space" ? "There are no notes to export." : "Open a note before exporting this scope.");
  }
  const origin = notes.find((note) => note.id === originNoteId) ?? notes[0];
  const title = scope === "space" ? snapshot.workspace.name : origin.title;
  const body = renderToStaticMarkup(
    <ExportSite snapshot={snapshot} notes={notes} scope={scope} originNoteId={originNoteId} />,
  );
  const defaultPage = scope === "space" ? "space-home" : noteAnchor(origin);
  const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${exportThemeMetadata(snapshot.settings)}\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'">\n<title>${escapeHtml(title)} · Orion</title>\n<style>${exportThemeStyles(snapshot.settings)}\n${EXPORT_STYLES}</style>\n</head>\n<body data-default-page="${escapeHtml(defaultPage)}" data-export-title="${escapeHtml(snapshot.workspace.name)}">\n${body}\n<script>${EXPORT_SCRIPT}</script>\n</body>\n</html>\n`;
  return {
    fileName: `${slugifyTitle(title) || "orion-export"}.html`,
    html,
    noteIds: notes.map((note) => note.id),
    title,
  };
}
