# Portable export

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the offline web article, Word and Markdown exports and their shared scope and privacy rules.

Read it before changing `src/lib/webExport.tsx`, `src/lib/wordExport.ts`, `src/components/ExportDialog.tsx`, `src-tauri/src/word_export.rs` and the `export_web_page` command.

Related: [Import pipeline](import-pipeline.md), [Notes and the editor](notes-and-editor.md).

## Portable export contract

The top-bar Share or export action supports a self-contained web article,
an editable Word document, and portable Markdown files. All formats share three active-Space scopes: the
open note, the open note plus exactly one hop through its visible links, or the
entire Space. A linked-page scope includes destinations reached through
explicit note/concept links, resolved wiki syntax, and the same automatic
concept-title matching shown in the reading surface. It is not recursive and
must never cross a Space boundary.

`src/lib/webExport.tsx` produces one semantic offline HTML document rather than
capturing Orion's live DOM. Preserve these rules:

- Explicit and automatic Orion links remain live only when their destination
  is inside the selected scope. Excluded destinations retain readable text but
  become inert; never silently add another note merely to satisfy a link.
- Render the selected notes' GFM headings, tables, tasks, code, blockquotes,
  dividers, numbered citations, per-note outline, and linked-page navigation.
  Whole-Space export includes a Space cover and note navigation; the file must
  remain useful at narrow widths, with reduced motion, and when printed.
- Web articles inherit the complete active appearance palette through the
  shared theme resolver: preset, accent, canvas, surface, text warmth,
  contrast, and validated custom colors. Explicit light or dark mode remains
  fixed; System remains adaptive in the exported browser. Embed only derived
  CSS values, never the raw Settings record, and retain the neutral print
  palette.
- Include citation titles, source kinds, and validated public `http(s)` source
  URLs as attribution. Never include raw source bodies, source filenames,
  import guidance, Chat, settings, provider keys, import-draft state, dormant
  Studio data, another Space, or the vault schema itself.
- Do not execute raw HTML from a note or interpolate user text into scripts or
  styles. Keep all CSS and fixed navigation JavaScript inside the file, load no
  remote assets, and retain the restrictive export CSP. The browser file must
  have no dependency on Orion, a server, or the network.
- The native `export_web_page` command revalidates a non-empty HTML doctype,
  enforces a 16 MiB document-shell bound before managed images and a 128 MiB
  final offline-file bound, asks for an explicit local destination, then flushes
  and atomically replaces that file. Browser preview uses a normal Blob
  download. A renderer-provided path is never accepted.
- Markdown export continues to write portable UTF-8 notes with title/tag
  frontmatter and no overwrite, but it uses the same scope resolver as web
  export. Adding a new export format must not weaken these scope/privacy rules.

`src/lib/wordExport.ts` lazily loads the DOCX library and converts the semantic
scoped HTML export to OOXML. Preserve headings, emphasis, safe external and
included-note links, lists/tasks, tables, code, quotes, text alignment, image
captions, document/paragraph margins, and citation attribution. Document body
margins become per-note paragraph insets, with paragraph percentages applied
inside the remaining width. Preserve list hanging indents and quote/code
padding, constrain tables/images to that width, and reset document insets for
table-cell content and the next note. Headers and references retain their own
layout. Word uses document flow; note frames and
free image placement become ordinary Word content. Managed raster attachments
use the native opaque-ID resolver; WebP is converted only in the exported copy.
No remote images are downloaded. Bound text to 16 MiB, each image to 12 MiB,
and final document to 128 MiB. `word_export.rs` validates the ZIP package,
entry paths, content types, CRCs, expanded sizes, and required OOXML parts before
Save As; it flushes then atomically replaces only the user-selected `.docx` file.

DOCX imports use Mammoth semantic HTML with embedded style maps and external
file access disabled, then `docxImport.ts` delegates to the bounded inert HTML
extractor. Its Word profile retains leading checkbox glyph tasks and safe
mailto links without changing ordinary HTML import. Preserve headings, emphasis,
lists, actual table headers/data rows, quotes, literal punctuation/entities and
code spacing. Embedded pictures remain descriptive alt text during extraction;
never read their bytes or load arbitrary image paths. Return explicit conversion
warnings for omitted pictures and simplified structures alongside Mammoth's
warnings. Both
Import Studio and `orion_import` use this same parser. Markdown import and MCP
note writes preserve Orion's portable blocks/table/alignment/margins/image
metadata. Mammoth's semantic DOCX extraction does not retain paragraph indents;
do not claim that importing a Word document restores Orion margin settings.
Validate real generated DOCX bytes through the shared file parser, import
payload and repeated production-editor save/reopen cycles, including headerless
tables with a blank first data row and exact literal code.
Word export must omit `tableHeader` on data rows rather than serialize false:
the current Mammoth reader interprets the presence of `w:tblHeader` as true.
Imported multiple header rows keep their grid/content with one clear warning
that portable Markdown retains only the first row as a header.

Local import preserves the complete parsed/extracted text in its source record.
HTML inputs share `htmlImport.ts` across Import Studio and desktop MCP import.
Parse into detached inert template content, never attach imported nodes or
resolve resource properties. Bound input, node count, nesting and generated
output before returning content; fail without creating a partial source.
Preserve semantic headings, paragraphs, marks, safe absolute HTTP(S) links,
lists/tasks, quotes and simple tables. Headerless tables need their portable
metadata plus synthetic header; real blank rows must remain. Escape authored
Markdown punctuation and ignore imported Orion metadata. Unknown containers
must preserve readable descendants and block boundaries. Images are descriptions
only; unsupported links, complex tables and styling get bounded warnings and
readable fallbacks. Inline/fenced code uses the shared literal serializer,
including edge spaces, dynamic backticks and table pipes. Never fetch resources,
interpret interactive HTML or claim full original-layout/raw-HTML preservation.
Validate through `parseTextImport`, the real import payload and repeated editor
reopening, with a separate real-browser passive-resource probe.
Import payloads carry their originating snapshot version. Keep frontmatter at
the start when adding a generated note heading. After a guarded local or
assistant import merge, reconcile citations only for imported note IDs and
sources that occur exactly once in both the original and merged active Space.
Attach both provenance arrays in the same immutable update without changing
source content. Code, images, raw HTML, metadata and generated References do
not establish citation edges. Preserve ordinary imported-source provenance;
never fetch missing targets, remap IDs or look in another Space.
The editable note copies at most 200,000 UTF-16 units of that text through
`importNoteExcerpt.ts`, ending before an incomplete top-level Markdown unit.
Keep Orion frames balanced and table metadata attached to its table; never cut a
fence, link, list, frontmatter or surrogate pair. Oversized single structures are
omitted from the excerpt, so it may be much shorter than the cap. A generated
title and an explicit shortened-excerpt notice are additional. Do not silently
truncate the source or claim original binary layout is preserved.
