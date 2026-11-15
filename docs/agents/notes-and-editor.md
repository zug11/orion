# Notes and the editor

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the note surface, the rich editor and its blocks, tables and images, narration, writing sessions, and note or source deletion.

Read it before changing `src/components/NoteView.tsx`, `src/components/RichNoteEditor.tsx`, `src/components/editor/`, `src/lib/note*.ts`, `src/lib/noteNarration.ts`, `src/lib/narrationDownload.ts`, `src/lib/writingSession.ts`, `src-tauri/src/ruler_glass.rs`, `src-tauri/src/speech_timing.rs` and `src-tauri/src/narration_export.rs`.

Related: [Dictation and transcription](dictation-and-transcription.md), [To-dos, tickets, boards and the calendar](work-and-calendar.md), [Generation and AI actions in the editor](generation-and-inline-ai.md), [Interface and appearance](ui-and-appearance.md).

## Product decisions

- Notes have one direct reading/writing surface. Editing reveals a lightweight
  word-processing toolbar; users never need to understand Markdown.
  Editing places the optional Title and Subtitle lines below that toolbar,
  aligned with the body. Only the focused empty line shows its faint Title or
  Subtitle hint; both disappear in the body, which has no third hint. These
  placeholders are presentation only; new
  manual notes persist empty title/summary strings. Enter moves through those
  lines into the body without requiring either field. At the absolute start of
  an ordinary body paragraph/heading, Backspace removes the nearest empty
  heading row without changing prose; repeated Backspace can remove both so
  the body starts directly below the toolbar. Backspace in an empty heading
  removes its own row. From that body boundary Enter restores a missing title,
  then subtitle; Enter from the title can also restore the subtitle. Preserve
  normal Enter/Backspace elsewhere, structured blocks, selection and IME input.
  Optional `Note.headingLayout` accepts only `both`, `title`, `subtitle`, or
  `none`; older notes default to both. Persist this per-note choice through
  ordinary autosave and window merging. Nonempty authored headings always
  remain visible, including incoming MCP/window changes. Keep title/summary in
  their existing metadata fields rather than copying them into Markdown or
  changing body offsets for Chat, dictation, citations or exports. Old starter
  copy is hidden locally, without a vault migration. Unnamed notes retain a
  New note navigation label, and existing authored headings stay intact.
  Each window remembers each note's last edit/preview mode independently by
  Space during the session, including navigation through Home or another view.
  Returning to a note resumes that mode; Done explicitly returns it to preview.
  This is transient window navigation state, never a persisted note field.
- Edit mode shows a small translucent word-count pill at the bottom
  centre of the note's text column. Count the displayed title, subtitle and body,
  excluding placeholders, Markdown metadata, citation controls and separate
  image captions/metadata. Reading mode never mounts the count, including when
  text is highlighted; Done removes it along with its listeners and spacing.
  Highlighting prose or a heading shows selected words out of the total; a
  collapsed or unrelated selection restores the total. Counts are transient
  per-window presentation and never trigger autosave or alter note text. Cache
  immutable editor subtrees so typing recounts only changed textblocks, and
  coalesce updates into a frame inside the badge component. Keep it visible while scrolling,
  clear of selection actions and narration controls, with opaque accessibility
  fallbacks and no per-keystroke screen-reader announcements.
  Hide the badge while an AI composer, generation/progress/error dock or review
  controls are visible, so Accept/Insert/Discard remain unobscured. Restore it
  when those controls close without moving the document.
- Every note can be deleted from its header, the complete active-Space sidebar
  list, or the Notes index after confirmation. Deletion must remove orphaned
  original-dictation recovery sources attached only to that note. Preserve
  originals referenced by another surviving note and ordinary imported sources.
  Use source deletion cleanup for removed originals so provenance is detached.
  Deletion also removes orphaned
  concepts, relationships, source/import references, dead Orion link marks,
  navigation state, and affected transient AI jobs without deleting the
  surviving prose around a removed link.
- Every imported source can be deleted from the Sources index or its preserved
  source viewer after confirmation. Deletion removes that provenance ID from
  notes, relationships, and dormant compatibility cards without deleting the
  notes or relationships themselves.

## Note image attachment contract

The rich editor accepts local PNG, JPEG, GIF, and WebP images from its Image
tool, the clipboard, or drag and drop. A note persists ordinary Markdown image
syntax whose source is a compact `orion-image://localhost/<asset-id>` reference;
never put native absolute paths or desktop base64 payloads in note bodies or
`vault.json`. The filename-derived alt text must remain visible to Markdown,
MCP clients, exports, and assistive technology, and users can select and delete
the image as one editor node.

The native `save_note_image` boundary accepts at most 12 MiB per image, validates
the opaque asset ID, safe filename, canonical MIME, decoded byte count, and file
signature, then atomically writes the bytes under the private app-data
`attachments/images` folder. SVG and other active document formats are never
accepted. The read-only `orion-image` protocol may resolve only one validated
asset ID from that folder, returns a signature-derived content type with
`nosniff`, and must never accept a renderer-provided path. Browser preview may
use a bounded raster data URL because it has no native attachment store.

Web export retains managed `<img>` elements and the native save boundary replaces
their Orion URLs with raster data URLs, keeping the final HTML offline and within
its restrictive `img-src data:` CSP. Markdown export copies each referenced image
into an adjacent `orion-images` directory and rewrites the exported Markdown to a
relative path. Missing or damaged managed images must fail export clearly rather
than silently producing a broken article. OCR source imports remain a different
pipeline: they discard original source bytes after recognition and never become
note attachments automatically.

## Editor and narration contract (0.4.6)

Orion 0.4.6 includes the six editor changes and narration/usability additions
developed on `codex/editor-preview` in both Whisper Small and Medium editions.
Preserve them as supported product behavior. Release publication requires the
normal packaging and verification procedure; historical preview checks do not
certify new release artifacts.

Development builds continue to use `app.orion.desktop-preview` and its separate
persistent library. Never copy, reset or seed the normal vault for a preview or
release check. Installing a release retains Orion's existing application identity
and library; the preview library is not automatically transferred. See
`docs/editor-preview.md` for scope, interactions and limitations. LaTeX is outside
this integration's scope.

- Written-note Play builds its script from the displayed title, summary and
  prose through `noteNarration.ts`. Compact DOM text spans retain UTF-16 offsets
  across formatting and line breaks without rewriting the document. Custom
  Highlights dim unread words; Follow text disables that decoration. Pointer
  seeks require an actual glyph hit and preserve selection gestures and modified
  link clicks. Pause retains the current word, while editing, changed wording,
  navigation and Stop clear the timing map. Keep the Markdown subtree stable
  across playback ticks. The playback slider also supports arrow keys/Home/End.
  Seeking immediately updates three disjoint highlight ranges, even while audio
  loads: all preceding text uses the normal foreground, the current word has the
  active highlight, and only following text is dim. Do not restore the visible
  Click text to jump hint; retain the Passage timing fallback when needed.
- Formatted empty paragraphs retain their margins and justification through
  unescaped `&nbsp;` markers. Strip paragraph metadata before recognizing a blank
  marker, and preserve every formatted blank on repeated save/reopen. Escaped
  literal entities and code must never be globally decoded to repair old data.
- System narration uses actual speech word-boundary events. ElevenLabs uses
  the original-text alignment from its `/with-timestamps` response. OpenAI
  keeps its existing speech request and optionally aligns the generated MP3
  locally with bundled Whisper's separate `--align` mode. `speech_timing.rs`
  validates and conservatively matches acoustic words to the original script;
  never infer word positions from an elapsed-time percentage. Failed alignment
  keeps playable audio and visibly falls back to passage timing. No additional
  transcription provider call is made. Native alignment owns a temporary 0600
  file, window-scoped media job and existing shared Whisper process slot;
  120-second execution, 12-MiB audio, 600 decoded seconds, 8192 tokens and
  256-KiB alignment output are bounded. Existing dictation modes and recording
  deletion stay unchanged. Cloud note playback lazily generates 1200-character
  passages with at most one following passage prefetched; seeking reuses cached
  audio/timings. The optional `trackWords` IPC field defaults false for decks.
- Written-note Download narration captures the same complete displayed script.
  `narrationDownload.ts` reuses the same 1200-character cloud passage/cache keys,
  decodes complete files, then packs one 24-kHz mono 16-bit PCM WAV; never simply
  concatenate MP3 containers. Bound downloads to 80,000 UTF-16 characters and
  128 MiB; reject oversize output rather than truncating it. Abort on navigation,
  changed wording, editing or explicit cancellation. Existing provider gates
  apply to missing passages; never fall back to a different provider silently.
  `narration_export.rs` accepts exactly one bounded WAV or system script and a
  window-scoped media job. Only a native Save As dialog supplies the destination.
  Mac system speech exports AIFF locally through `/usr/bin/say`, using private
  temporary files, cancellation, a 300-second deadline and kernel file-size
  limit. Final writes are flushed and atomic. Browser previews support cloud
  downloads only. Do not change dictation retention or vault data for export.
- Space renaming stays in the existing switcher, using exact IDs, normalized
  bounded names and duplicate checks. Reject a changed original name rather
  than overwriting a concurrent rename. Preserve the existing vault merge/save
  path and every Space's content/navigation identity.
- Import supporting text has a 13px minimum, with 14px inputs/actions and 16px
  source titles. The editor's AI control uses a standalone monochrome sparkle
  without adjacent text, accessibly named AI tools because it includes both
  text and image actions. Its tooltip describes those capabilities. Preserve
  provider gates and preview/accept behavior; merely opening it performs no
  generation. Narrow layouts move secondary tools into More without scrolling.
  Keep redundant file-count/size/privacy captions out of the import intake;
  retain the actual validation limits and actionable error messages.
- Keep the toolbar's original width. Its text, image and table modes share
  contextual More at the far right after Undo/Redo, using only the ellipsis
  without a chevron in every context. Move lower-priority actions
  into More as width narrows; do not add horizontal scrolling. Align menu icons
  and labels in fixed columns, and preserve the selected object during actions.
  Opening text More by pointer focuses the menu container without an outline,
  never the native Text style select. Enter, Space and Arrow Down open at the
  first enabled control; Arrow Up opens at the last. Preserve native select
  keys and ordinary Tab navigation. Escape returns focus to More, and all
  opening paths preserve the editor selection.
- Justify text toggles selected prose paragraphs/headings with one undoable
  transaction (Cmd+Shift+J). `NoteStarterKit` and `NoteTaskItem` preserve it through
  tight/loose lists using only the exact inline suffix
  `<!-- orion-text:v1 justify -->`. `remarkNoteTextAlignment` hides that marker
  and applies the same bounded attribute in reading and offline HTML. Preserve
  code examples, links, task line indices and ordinary left-aligned Markdown;
  never accept arbitrary CSS. Table cells keep their separate GFM alignment.
  Reading tasks recursively remove the GFM-generated checkbox before adding the
  interactive control; leave nested lists to their own item renderer.
- Note actions (Done/Edit, Play, Find, Favorite and Delete) sit above the title
  and subtitle. Keep the heading and subtitle together and omit the divider
  above the formatting toolbar. Do not show concept/source counts in the header.
  Editing removes the header bottom padding and uses a 12px editor gap, bringing
  the toolbar directly under the subtitle without changing its sticky behavior.
- Margins toggles a horizontal ruler beneath the toolbar, available through
  More at narrow widths. Keep the toolbar below the note title and subtitle,
  with the ruler directly below it in the same inline sticky formatting dock.
  The dock sticks only after scrolling past the note heading; never move the
  formatting controls above the heading to work around native tracking.
  Disable vertical elastic overscroll in the writing pane while editing:
  WebKit rubber-banding occurs outside the DOM/native geometry contract. The
  toolbar and More formatting menu use untinted native Regular Liquid Glass.
  The shallow toolbar clips a 224-point-high Regular surface to its normal
  rounded bounds, matching the menu's scattering without a second material,
  tint, or blur filter. Its foreground is drawn at the original toolbar size in
  the middle of that surface; never stretch the controls. The pass-through clip
  owns the original toolbar frame, so scroll motion and hit targets stay aligned.
  Extra material opacity produces a flat grey bar; an unpadded shallow Regular
  surface remains too clear. The ruler retains Clear with no tint or added
  frosting. The toolbar clip, ruler and menu are children of one
  full-viewport pass-through NSView, with their frames updated together. Keep
  macOS's Liquid Glass appearance preference in the native QA matrix: Clear
  still follows the system tint amount. The unchanged earlier preview also
  appeared opaque with maximum system tint; grouping and parent geometry were
  not established as the cause. Never override the system preference through
  undocumented defaults. Keep the ruler aligned to the actual writing
  surface, with independent draggable markers and measured ticks on a 44px track.
  `src-tauri/src/ruler_glass.rs` hosts the scale/handles in Clear's `contentView`.
  `nativeToolbarPaint` paints only the existing local toolbar glyphs, labels and
  control states into a bounded transparent foreground inside Regular's
  `contentView`. Group toolbar controls with whitespace, never vertical rules.
  Repaint that foreground only for changes to the dock's controls or inherited
  appearance. Prose edits do not invalidate its PNG; unrelated DOM layout and
  overlay changes remeasure geometry using the existing artwork. Scroll must
  preserve any pending control repaint while dispatching updated geometry.
  Preserve active-button outlines and keyboard focus rings. The native painter
  draws controls only, not group containers or spacers. Accept only bounded PNG bytes (maximum 4096x160 pixels and
  350,000 encoded characters), never arbitrary SVG, a path or a URL. No document
  content is read by this paint path. More formatting uses a third native
  Regular glass surface above the ruler, retaining both underlying materials.
  Its local control foreground has separate limits of 1024x1536 pixels and
  700,000 encoded characters, within a 512x768 CSS-pixel viewport-bounded menu.
  Menu scrolling repaints its clipped controls and scroll indicator; closing it
  hides only that surface. Reuse foregrounds during document scrolling.
  DOM controls remain the sole source of selection, input, accessibility, undo
  and persistence. `NativeFormattingDock` owns `useNativeRulerGlass`, which
  coalesces layout/appearance updates and dispatches scroll geometry immediately
  without another frame or previous IPC acknowledgement. Once artwork is
  acknowledged, `move_ruler_glass` sends only bounded coordinates tied to that
  artwork revision, never PNGs. It only translates existing visible surfaces;
  resizing, repainting and material changes use the full command. Retry invalid
  motion once through the full path before falling back. Per-WebView monotonic
  revisions reject stale native arrivals and renderer responses. Hiding removes
  native content while retaining only a hidden noninteractive revision receipt.
  Keep the host at viewport bounds and translate the glass views without
  relaying out foregrounds. Scoped AppKit and Core Animation transactions disable implicit
  animation. Vertical scrolling must not recalculate paragraph margin state.
  Hide DOM artwork only after native activation succeeds. Restore HTML controls
  for other overlapping menus/dialogs, active numeric toolbar editing, paint failures,
  unsupported systems and accessibility requests. The ruler fallback is solid;
  never imitate native glass with a CSS shader or specular top stroke. The editor
  material does not change the shared window-frame material.
  Put fallback borders on the absolute backplate so they never offset measured horizontal geometry; do
  not clip the edge handles or focus rings. Extend only the glass backplate by
  8px at either end to give endpoint labels room inside its corners, offset the
  margin shading by the same amount, and omit the 0/100 tick strokes so no stray
  vertical lines touch the rim. Keep the document/selection scope screen-reader
  only through the ruler's accessible description, with no visible caption or
  close X. A small RotateCcw reset icon sits below the ruler on the right, named
  and titled Reset margins; the toolbar toggle hides the ruler. Do not restore a
  separate ruler popover, stacked sliders or numeric-entry panel. Handles expose
  keyboard slider semantics: arrow keys, Shift for larger steps and Home/End.
  A collapsed text selection targets the document body; a highlighted range
  targets the intersecting ordinary paragraphs/headings, including list and
  quote prose, while excluding tables and code. Never require or create a
  `noteBlock`. Left and Right are independent integer percentages from 0 to 25
  of the available writing width, with immediate reflow and a scope-local Reset.
  The visible ruler follows the current selection. Capture the target and
  measured geometry at drag/keyboard start and map it across editor
  transactions; mixed values must not overwrite the other side. Pointer
  movement reflows live, and release/cancellation ends the adjustment. Changes
  emitted by the rich editor may return through the parent after a newer drag
  update; consume pending local Markdown echoes in order without replacing the
  document or selection. Retire acknowledged echoes so genuine external edits
  and reverts still load normally. Changes retain ordinary undo/redo, with each
  drag grouped separately from later
  drags and surrounding typing. Document margins affect the body only, leaving
  note headers and the toolbar stable, in both library and writing windows.
  `src/components/editor/NoteMargins.ts` stores document attributes through the
  `NoteMarkdown` manager and changes paragraph attributes without wrapping
  content. `src/lib/noteMargins.ts` validates only the exact document prefix
  `<!-- orion-document-margins:v1 LEFT RIGHT -->` after optional frontmatter and
  paragraph/heading suffix `<!-- orion-paragraph-margins:v1 LEFT RIGHT -->`.
  Zero defaults need no metadata. Preserve literal code examples, existing
  justification suffixes and list/task structure; reject arbitrary CSS.
  `remarkNoteMargins` consumes valid suffixes into bounded numeric attributes
  for reading and offline HTML. Markdown exports/imports retain the markers;
  Word exports translate them into real indents. This adds no note schema or
  shared application preference, and DOCX import does not restore the margins.
- The contextual More menu's optional Block controls action uses a three-rectangle icon and
  wraps the current top-level content or adjacent selected nodes in one persistent
  `noteBlock` within the same Tiptap document. It is not a shared setting or a
  separate note format. `NoteBlock.ts` preserves ordinary rich children between
  exact `<!-- orion-block:v1 -->` and `<!-- /orion-block -->` Markdown comments;
  parsing is bounded, preserves fenced examples, and flattens nested wrappers.
  `remarkNoteBlocks` in `src/lib/noteBlocks.ts` gives reading and offline HTML the
  same grouping without exposing those comments. Whole lists, tables, images and
  excerpts retain their own structure and attributes.
  Ordinary prose coexists outside blocks. Clicking outside a block hides its
  controls without unwrapping it; selecting its content restores them. Keep an
  ordinary writable paragraph after the last block. Enter in a block's direct
  paragraph or heading splits it into persistent sibling blocks and puts the
  cursor in the new block; Shift+Enter inserts a line break in the same block.
  Enter in ordinary prose outside blocks stays ordinary. Lists, tables, code and
  nested quotes keep their existing Enter behavior. An open slash menu consumes
  its Enter choice before the block keymap. Clicking Block controls while
  inside a block explicitly unwraps it without deleting its children. Wrapping,
  unwrapping, deletion and movement each have an independent Undo step.
  `NoteBlockControls.tsx` adds no visible box, outline or decorative corners.
  Small plus controls sit just above/below the active block, with trash at its
  upper right and a hamburger move handle on the left. The upper plus, hamburger
  and trash share one horizontal centre line above the block, clear of table
  selection controls. Plus circles are 20 px
  with 12 px glyphs; the 12 px hamburger sits in a 20 px control. Invisible 4 px
  hit-area expansion keeps the controls easy to target without enlarging their
  visual footprint. Dragging the handle reorders the
  persistent block; Arrow Up/Down moves it one adjacent sibling. `useBlockReorder`
  keeps the original document unchanged until drop, supports bounded auto-scroll,
  and cancels on Escape, pointer cancellation, lost capture, blur, changed content
  or unmount. `noteBlocks.ts` validates immutable captured targets and top-level
  boundaries, rejects drops into the source itself, and preserves child attributes
  plus text, image and table-cell selections through movement.
  `BlockInsertMenu.tsx` reuses slash vocabulary/icons with Text as the base choice,
  keyboard navigation and scroll room below the boundary. Plus actions insert new
  persistent blocks. Deferred choices reject changed content; cancelling a picker
  never inserts a placeholder. Controls and drag indicators remain outside
  ProseMirror's owned prose. `blockGeometry.ts` positions controls in the available
  text lane using intrinsic image/caption bounds and live drag exclusions; geometry
  reads are batched with requestAnimationFrame. Preserve normal image size, free
  placement and live wrapping. Text style/Header choices live in the contextual
  More menu, alongside Block controls in every editing context. Compact image
  tools also move alignment and width into More while
  keeping placement visible.
- `SlashMenu.tsx` and `slashCommands.ts` expose the compact icon menu only for a
  slash prefix at a word boundary within ordinary text, including the middle of
  an existing paragraph. Replace only the command range and preserve surrounding
  prose. Keep URLs, paths and code literal.
  Commands are write, comment, block, heading, todo, bullet, numbered, divider, image,
  code, link, excerpt and table; H1–H6 also have direct shortcuts. `/write` opens
  **Write with AI** and requires an explicit Write submission before generation.
  `/comment` selects the current paragraph after removing only its command token,
  or the immediately preceding nonempty non-code text block on the next line. A blank
  paragraph between them (two Enters), or an empty note, creates a standalone note
  comment in the same modal. Its optional anchor `scope: "note"` requires empty
  quote/text, persists as metadata without invented prose, and remains current as
  the note evolves. Renderer and MCP validators accept this additive schema; legacy
  passage anchors retain exact quote requirements. Note comments can continue in
  Chat or generate an article; text additions/rewrites require explicit passage
  attachment first. Opening/saving makes no provider call. Stale command ranges remain unchanged. The command is available only when the comment
  handler is mounted, is excluded from block insertion, and is suspended while its
  modal is open. `passageCommentSelection.ts` owns the one-step undoable selection.
  In tables, `/delete` offers row, column or table. The menu stays below the caret with a bounded,
  scrollable height and aligned icon/text columns. Preserve keyboard choice,
  Escape, the captured insertion point and single-transaction replacement. Reject deferred insertion
  when the captured document changed.
- `ExcerptPicker.tsx` receives only the active Space's notes. Search titles and
  complete visible bodies, show a scrollable full-article text reader and jump
  to the matching passage. Selections preserve exact visible words, merge
  overlaps and join separate passages in source order with an ellipsis. Bound
  each excerpt to 12 passages and 12,000 characters from one source note. A
  changed source requires a fresh selection; never insert from stale offsets.
- Excerpts remain editable, frozen Markdown blockquotes with an attribution
  link, not synced content or a parallel block schema. `noteExcerpts.ts` owns
  bounded `orion-excerpt:v1:` metadata in the optional `orion-note://` link title.
  Hide reserved titles from tooltips. Backspace immediately after an excerpt
  removes it as one undoable edit; do not restore a Change excerpt button.
  Source navigation stays inside the current Space and reveals exact preserved
  wording only when it can be located without guessing. Source edits/deletion
  never silently rewrite the quote or select a same-title note elsewhere.
  Reading and editing share the note's body typography, a calm left rule,
  compact spacing and a 12 px bottom-right attribution. Suppress decorative
  quotation marks only for excerpts; ordinary quotation styling stays intact.
- `NoteImage.tsx` preserves the ordinary image node and managed attachment
  contract. Corner resizing maintains proportions. Pointer drag sets continuous
  horizontal position and a vertical offset from an internal paragraph anchor,
  keeping the image at its displayed size and full opacity during the gesture.
  Text must wrap live around the moving image and caption before release. Use
  transient editor-owned exclusion decorations; do not save intermediate drag
  positions or rewrite the prose DOM. Commit the completed move once so Undo
  restores the original placement; cancellation restores the original flow.
  Do not show a scaled thumbnail, destination outline or position label. Clip
  the moving image at the writing viewport instead of shrinking it. Never snap a drag
  to left/centre/right or visible paragraph boundaries; alignment presets are
  explicit shortcuts. Avoid WebKit's native bitmap drag ghost. Layout and
  caption use bounded `orion-image-layout:v1:` image-title metadata validated by
  `noteImageLayout.ts`, shared by editing, reading and offline HTML. Optional
  `xPercent` is null for legacy alignment or clamped to 0–(100-widthPercent)
  at hundredth-percent precision; `offsetY` is 0–10000 px from the anchor.
  Width is 15–100%, spacing is 8–40 px, and captions are at most 500 characters.
  Free layouts use a floated exclusion wrapper and an intrinsic image/caption
  box. Preserve normal editable prose; do not replace ProseMirror-managed text
  with manually measured line DOM. Wrap text flows on the roomier side, while
  Above & below excludes the complete image band. Both restore full-width prose
  above and below. In line remains on its own line, and dragging it enters Wrap
  text. This is not simultaneous two-sided wrapping around a centred image.
- `NoteTable.ts` keeps real Tiptap table transactions and native column
  resizing. `TablePicker.tsx` offers the hover/keyboard grid, header toggle and
  custom size bounded to 12 columns and 20 rows. Contextual row/column rails
  support selection, with numeric count fields and chevrons at the table edges.
  Count reductions require confirmation before removing nonempty content.
  Keep additional actions in contextual tools, not a floating bar below the
  table. Table width is 35–100%, and Tab at the last
  cell adds a row. Controls disappear when selection returns to prose.
  Preserve undo and cell data.
  The table toolbar exposes row/column insert/delete, header, banding and width
  with icons and hover labels, without a redundant Table rows-by-columns label.
  Width shows just its percentage select with a Table width tooltip/accessibility
  label; do not add a decorative non-clickable icon beside it.
  At narrower widths move secondary actions into More, keeping the core row and
  column actions visible and native select keyboard behavior intact.
  Optional adjacent `orion-table:v1` JSON comments carry bounded width,
  column-width, header and banding metadata while the
  table remains GFM. `noteTables.ts` is the pure validator/read-rendering helper.
  Its remark filter hides only validated adjacent table metadata in the reading
  tree while retaining source positions and visible code examples.
  Headerless GFM uses a synthetic empty header; suppress that header without
  deleting an author's row. Never interpret metadata as arbitrary CSS or HTML.

## Writing sessions

The rich editor's clock button offers an ordinary writing timer and optional
Flow drafting. `writingSession.ts` owns the deadline-based state machines;
`WritingSessionControl` expands setup and status directly inside the toolbar;
there is no modal, popover, or separate writing surface.
The ordinary timer is transient and per window, survives editor/navigation
remounts, and supports pause/resume/stop without affecting normal autosave.
Neither mode adds a vault field or makes provider calls.

`FlowWriting` is a ProseMirror plugin that appends a new writing paragraph to
the real editor and protects all pre-session nodes. Its unsaved rich-text
passage starts timing with the first text input. After 30% of the chosen
5/10/20-second inactivity interval it gradually dims through node decorations;
expiry deletes it. All provisional transactions and their removal exclude
history, and RichNoteEditor suppresses their onChange publication. Expired text
must never reach autosave or Undo/Redo. Actual text changes reset inactivity;
IME composition pauses both clocks. Compare absolute deadlines on every input,
tick, and Stop so suspended callbacks cannot rescue an expired passage.
Finishing the 1–180-minute timer or choosing **Stop and keep** commits the rich
passage in one separate Undo group and resumes normal autosave. Existing note
content is never subject to expiry. Leaving the editor or closing Orion loses
unfinished Flow text. An external note replacement ends Flow before loading
the newer document. Sessions belong to their exact editor and never transfer
across notes or Spaces. Native toolbar paint includes the inline timer labels.
