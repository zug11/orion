# Editor and narration — Orion 0.4.6

Orion 0.4.6 includes the editor and narration work developed on
`codex/editor-preview` in both Whisper Small and Medium editions. This guide
describes its product behavior and limits. Historical preview evidence is kept
separate from verification of the final 0.4.6 installers.

The existing **Orion Preview** development workflow still uses
`app.orion.desktop-preview` and its own persistent library. Never copy, reset or
seed the user's normal vault to demonstrate these features. Release builds keep
Orion's normal application identity and existing library; they do not import the
separate preview library automatically.

## The six changes

1. **Compact slash menu.** Type `/` at a word boundary anywhere in a paragraph, then search or
   choose with the arrow keys and Enter. Commands are `/heading`, `/todo`,
   `/bullet`, `/numbered`, `/divider`, `/image`, `/code`, `/link`, `/excerpt` and
   `/table`. `/h1` through `/h6` apply a heading directly. Escape closes the menu.
   The menu stays below the caret and scrolls within a bounded height; its icon
   and label columns stay aligned.
   Only the typed command is replaced; surrounding prose is preserved.
   Commands operate at the captured cursor; a changed document invalidates
   a pending picker choice. Image uploads track their insertion point through
   intervening edits. Tasks remain ordinary Markdown checkboxes used by Home.
2. **Exact excerpts.** Search the active Space's note titles and complete visible
   contents. Open a full, scrollable article reader, jump to the matched passage,
   and highlight exact words. The footer previews the quote while the article
   scrolls. **Add another passage** joins separate selections with an ellipsis
   in source order and merges overlaps. Reading and editing share a calm left
   rule, the note's body typography, compact spacing and a 12 px bottom-right
   source link, without a decorative quote mark. Backspace at the beginning of
   the following paragraph removes the excerpt in one undoable edit; there is no Change excerpt
   button. `/link` uses the same Space-scoped discovery to insert a note link.
3. **Tables.** `/table` and the toolbar open a Word-style hover grid with live
   dimensions, keyboard selection, a header toggle and custom sizes. The picker
   supports 1–12 columns and 1–20 rows. In the document, Pages-style lettered
   columns and numbered rows appear while the table is selected. Numeric row
   and column counts with chevrons sit at the table edges. Reducing a count
   requires confirmation if it would remove nonempty content. Select rows or
   columns, drag column boundaries, resize the table, and choose its header and
   alternating-row treatment through contextual tools. There is no floating
   action bar below the table. Tab advances to the next
   cell and adds a row at the end. `/delete` inside a table offers this row, this
   column or the table. Return to prose to hide the editing rails.
4. **Image placement.** Selecting an image reveals corner resize handles and
   image tools. Dragging places it continuously across and down the writing
   area, keeping its displayed size and full opacity throughout the gesture.
   The moving image includes its caption without a separate destination box,
   position label or added drag styling. The writing viewport clips large
   images instead of shrinking them. The image
   keeps an internal paragraph anchor plus its exact horizontal position and
   vertical offset; its visible position does not snap to paragraph boundaries
   or alignment presets. Left/centre/right remain explicit shortcuts. Choose
   Wrap text, Above & below or In line, adjust text spacing, and add a caption.
   Wrap text flows on the roomier side, returning to full width above and below
   the image. Above & below reserves the complete line across the image band.
   Dragging an In line image switches it to Wrap text. In line remains an image
   on its own line, not embedded between words. Both-sided wrapping around an
   image in the middle of a line is outside this native text-flow implementation.
   Separate images occupy separate vertical bands, and tables clear those bands
   rather than overlapping an image.
   Prose wraps live during the gesture, including the caption and chosen gap.
   A transient editor-owned exclusion controls text flow without changing the
   saved document or replacing its prose DOM. Only the final move is committed;
   cancelling restores the original image and surrounding flow.
   Backspace/Delete and each completed move use the editor's existing history.
5. **Contextual toolbar.** The toolbar retains its original width and changes
   its main controls to match text, a selected image or a table. Returning to
   prose restores writing tools. Lower-priority actions move into the contextual
   More menu as the available width narrows, without horizontal scrolling.
   More stays at the far right after the Undo/Redo history group, showing only
   an ellipsis without a chevron. Menu items use
   fixed icon and text columns. Image/table tools preserve the selected object.
6. **Six heading levels.** Heading 1–6 are available from the toolbar and slash
   menu, with appearance previews. The note title remains separate. The outline,
   reading surface and web export recognise all six levels with duplicate-safe
   anchors. Deeper headings remain readable rather than shrinking to tiny text.

LaTeX is outside the 0.4.6 editor scope.

## Narration and usability additions

- **Written-note Play:** unread words dim and the current word has a subtle
  highlight. Click visible text to seek, or use the playback slider with arrow
  keys/Home/End. Pause retains the last spoken word; Play resumes there. Stop
  restores ordinary reading. Follow text can disable the decoration while
  playback and seeking remain available. Selection drags and modified link
  clicks retain their normal behavior. Editing, switching notes or changing
  wording clears the old timing map. Titles, summaries, headings, lists, tables
  and ordinary prose follow their displayed text; code blocks and citation
  controls are excluded. Long notes are not silently clipped to the old speech
  text limit.
- **Timing:** System voices use actual word-boundary events where supported.
  ElevenLabs returns original-text timing with its synthesized audio. OpenAI
  audio is aligned on-device with the already bundled Whisper model. This adds
  local preparation time and can be approximate where Whisper misrecognizes a
  word. Missing words never receive invented timestamps; seeking chooses a
  preceding supported word, or the passage start when no timing is available.
  A visible Passage timing hint identifies the untimed fallback. Cloud audio
  is generated in bounded passages with one passage prepared ahead and reused
  for repeated seeks. No additional paid transcription request is made.
  The original dictation recording lifecycle is unchanged.
- **Rename Space:** use the pencil in the Space switcher, then Save or Enter.
  Escape/Cancel restores focus. Existing name limits and duplicate checks apply;
  IDs, notes and links stay intact. A concurrent rename requires a fresh edit.
- **Import knowledge:** supporting labels are at least 13px; inputs/actions are
  14px and source titles 16px, with checked narrow layouts.
- **AI tools:** a clearer monochrome sparkle stands alone in the toolbar. Its
  accessible name and tooltip cover writing and image capabilities without a
  visible text label. Existing credential gates and preview/accept behavior
  remain. Secondary tools move into More as the toolbar narrows.

## Excerpt behaviour and limits

Excerpts are **editable, frozen quotations**, not synchronised copies. Changes
to the original note never silently rewrite quoted words. The preserved source
metadata identifies the original selected text; editing the quote does not edit
its source. A source link opens only its note within the current Space and
attempts to reveal the first exact preserved passage. Changed, deleted or
ambiguous wording does not receive a guessed highlight. Navigation does not
search another Space for a replacement.

The article picker presents a readable text representation of the note, not a
pixel-identical replica of image and table layout. Table rows become text and
inline formatting does not become part of the quoted wording. Multiple passages
come from one source note per excerpt, with at most 12 passages and 12,000 quoted
characters. A source edit while the picker is open requires selecting again.

## Persistence

Notes continue to use the existing Markdown body; there is no new vault schema
or separate block database.

| Content | Portable representation | Implementation |
| --- | --- | --- |
| Excerpt | Ordinary blockquote and `orion-note://` attribution link; the optional link title carries bounded `orion-excerpt:v1:` passage metadata. | `src/lib/noteExcerpts.ts`, `src/components/editor/NoteExcerpt.ts`, `src/lib/noteExcerptNavigation.ts` |
| Image | Ordinary image syntax with the existing managed attachment URL; nondefault layout, caption and optional free coordinates use bounded `orion-image-layout:v1:` metadata in its optional title. | `src/lib/noteImageLayout.ts`, `src/components/editor/NoteImage.tsx` |
| Table | Ordinary GFM table plus an optional adjacent `<!-- orion-table:v1 … -->` comment for width, column widths, header-off and banding. | `src/lib/noteTables.ts`, `src/components/editor/NoteTable.ts` |
| Headings and tasks | Standard Markdown heading markers and task checkboxes. | `src/lib/noteOutline.ts`, existing task extraction |

Metadata is inert and validated before it becomes layout or navigation state.
Keep reserved payloads out of visible tooltips. Headerless GFM contains a
synthetic empty header for compatibility; Orion uses the metadata to suppress
that header without dropping author rows. Generic Markdown readers can ignore
these extensions and retain the words, images and table data, although Orion's
layout will not necessarily carry over. Do not promise arbitrary rich layout
round trips through external Markdown editors.

Reading removes validated table metadata comments from the Markdown syntax tree
only when they immediately precede a table. Original line positions stay intact
for layout lookup, and fenced or inline examples remain visible. The editor
still saves this data so widths, banding and header settings survive reopening.

## Historical preview validation — 28 September 2026

The following results describe the isolated preview before release integration.
They are retained as development evidence, not a claim that the 0.4.6 DMGs have
been built, signed, notarized or published. Final release checks must run against
each exact installer and its extracted application.

The preview included focused tests for slash matching, six-level outlines,
exact excerpt selection and navigation, image layout/undo, table transactions,
Markdown save/reopen, safe rendering, and export compatibility. Table tests
exercise headerless data, column widths, banding, row/column selection, deletion
and undo, Tab growth, custom/grid insertion and stale-picker rejection.

A disposable browser harness in `outputs/table-preview-qa/` exercised real
Tiptap tables in light/dark appearances and at a narrow viewport, including row
and column actions, both resize controls and returning to prose. It reported no
page errors or page horizontal overflow. These fixtures are not vault content.

The recorded preview renderer check passed 1,179 tests (one optional fixture was
skipped) and the production build. Its required Rust checks passed 88 native
tests, 45 MCP tests and both
`cargo fmt --check` commands. Logs are in `outputs/editor-preview-checks/`.
Production WebKit checks confirm matching excerpt geometry, typography and
attribution in reading/editing, with no page errors; disposable evidence is in
`outputs/excerpt-preview-qa/`.

That native preview was rebuilt and launched on 28 September 2026 with
`script/build_and_run.sh --verify`. The exact staged renderer source matched
this worktree. Deep/strict code-signature verification passed before launch and
the process was verified running. The preview library was preserved.

The validated preview artifact was
`~/Applications/Orion Previews/orion-desktop-preview.eIrSS0/Orion Preview.app`.
Build evidence is in `outputs/editor-preview-checks/native-preview-narration.log`.
Production Chromium/WebKit checks also cover table count controls, content
protection and Undo, narrow toolbars, aligned menu labels, and below-caret slash
navigation. Their fixtures and results are in `outputs/editor-integration-qa/`.

Follow-up checks cover inline and repeated slash commands, six table edit/read
cycles across Chromium/WebKit with full reload and preserved layout, and actual
pointer image movement, cancellation, duplicate image
files, one-step Undo/Redo, and scrolling in both directions. Hidden table
comments also stay out of import previews and connection snippets.

Continuous image placement was checked with actual pointer drags in WebKit and
Chromium: repeated non-preset horizontal/vertical moves, paragraph-anchor
changes, large images, resizing, cancellation, scrolling and Undo/Redo. The
committed image matched its displayed drag position without measurable drift.
Actual reading and offline export passed 32 browser/viewport/placement cases,
including captions, native text selection and zero image/text overlap. Evidence
is in `outputs/editor-integration-qa/image-free-placement.json` and
`outputs/image-reader-qa/results.json`.

Full-size drag presentation was rechecked in WebKit and Chromium: seven moves
per engine kept exactly the same image width/height and the committed position
matched the moving image with zero measured drift. Checks cover caption
presentation, a single visible image, full opacity, no added drag decoration,
viewport clipping, scrolling, cancellation on viewport resize, Escape and
outside drops, resizing, duplicate images and one-step Undo/Redo. The document
height reservation survives through commit so lifting a large image does not
prematurely clamp the reading pane's scroll position.
At 1024×680, both engines kept a 672×672 px image full-size inside a 553 px-high
writing viewport, clipped it during movement, edge-scrolled and committed with
zero measured position drift. Evidence is in
`outputs/editor-integration-qa/image-oversized-viewport.json`.

Live wrapping was verified with the mouse held at multiple positions in both
engines. Text avoided the image, caption and configured gap before release;
all measured word rectangles then matched the committed layout exactly. The
same checks cover paragraph-anchor changes, Above & below, multiple images,
and a full-size image taller than the compact writing viewport. Document JSON
and Markdown remained unchanged throughout the gesture. Two unit regressions
also check that decoration updates emit no document update or history step,
and that concurrent edits immediately remove the temporary exclusion.
Evidence is in `outputs/editor-integration-qa/image-live-wrapping.json`,
`outputs/editor-integration-qa/image-live-oversized-viewport.json`, and
`outputs/editor-preview-checks/renderer-check-live-wrap.log`.


Written-note narration was checked in Chromium and WebKit in both themes with
actual text hits, keyboard seeking, pause/resume, native range highlighting,
Find, editing, note switches, completion and cancellation. Prose DOM stayed
unchanged during playback, and the playhead fit normal and narrow viewports.
Evidence is in `outputs/narration-qa/`. Import typography and AI toolbar
layout passed 90 browser checks across all import stages and 15 toolbar widths
per engine; see `outputs/import-ai-qa/`. Space renaming passed keyboard,
validation and layout checks in both engines (`outputs/space-rename-qa/`).

The rebuilt Whisper sidecar was exercised against locally synthesized English,
French and Japanese MP3 fixtures. Its existing plaintext/server paths, input
bounds, Unicode, signal cancellation and error output were also checked.
Real English/French token output was passed through the native timing matcher.
Repeated-word ambiguity was independently checked against 3,844 exhaustive
small sequence pairs. Native provider transport is covered by mocked responses;
no paid OpenAI or ElevenLabs request was made during this validation. Evidence
is in `outputs/whisper-alignment-qa/` and `outputs/speech-mapping-qa/`.

The exact Whisper helper and model packaged in that preview also aligned the
local English MP3 successfully after launch. Output is in
`outputs/editor-preview-checks/packaged-narration-alignment.json`. The native
window opened with the existing preview library, confirmed through macOS accessibility.
