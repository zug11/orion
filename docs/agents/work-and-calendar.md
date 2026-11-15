# To-dos, tickets, boards and the calendar

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: note-backed to-dos, tickets and kanban boards, ticket inference, inline dates and Home's work and calendar sections.

Read it before changing `src/lib/tasks.ts`, `src/lib/tickets.ts`, `src/lib/ticketInference.ts`, `src/lib/calendar*.ts`, `src/components/Tickets.tsx`, `src/components/HomeTickets.tsx`, `src/components/HomeCalendar.tsx`, `src/components/CalendarPicker.tsx` and the ticket, kanban and calendar editor extensions.

Related: [Notes and the editor](notes-and-editor.md), [Claude connector and Codex plugin](mcp-connector.md).

## Product decisions

- To-do items use portable Markdown task lists inside ordinary notes. Home
  derives a scrollable To-dos section for ordinary checklists in the active Space, including source
  note and best matching canonical concept; do not add a parallel task schema.
  Checkboxes remain interactive in the reading surface, so completing a task
  never requires entering edit mode. Home collapses exact task copies only when
  provenance establishes the same derivation (a shared imported source or a
  derivative canonical article), and prefers the ordinary source note. Identical
  recurring tasks in unrelated notes remain distinct.
- Tickets remain ordinary Markdown tasks, with optional validated
  `<!-- orion-ticket:v1 ID STATUS BOARD_OR_DASH [due=YYYY-MM-DD] [origin=board] [urgency=LEVEL] -->` metadata on their first
  line. `STATUS` is `todo`, `progress`, or `done`; the checkbox is authoritative
  for completion. Explicit tickets appear in Home's separate Tickets section.
  Checking an ordinary to-do preserves its plain Markdown and To-dos membership;
  assigning one to a board explicitly promotes it into a ticket. Explicit
  separate ticket IDs are not collapsed as derived copies. `/ticket` and
  `/kanban` use the existing keyboard slash picker, a small named-item dialog,
  and one undoable cursor insertion. Escape preserves the command and prose;
  changed documents reject a delayed insertion. Home creation chooses an
  existing storage note. Dashboard-created tickets record `origin=board` and show
  no source-note label; tickets authored/inferred in a note retain attribution.
  Older tickets without origin retain their note attribution; do not guess or migrate it.
  Explicit tickets render as editable cards in notes and reading mode, with a soft
  shadow instead of a border. Ordinary to-dos retain the native TaskItem node view.
  Card footers anchor the date control at bottom left; urgency and status actions
  sit to the right and may wrap without displacing that date alignment.
  Ticket cards expose a small top-right delete button on hover or keyboard focus
  (always visible without hover). It is excluded from drag initiation. Confirm
  before removing the complete authored task item and its contents from its note
  and derived boards. Resolve a unique durable identity and reject stale captured
  content; preserve unrelated prose and siblings. The optional derived rawBlock
  on Ticket is transient deletion evidence, never a persisted field. Editor
  deletion uses one Undo and restores focus; board deletion focuses a neighbouring
  card or the column's Add ticket action.
  Promote/demote node views when ticket identity changes, including Undo. Card
  actions resolve the current editor node by position and unique durable ticket ID,
  preserving its live text and attributes if React's rendered props lag behind a
  transaction. A different, removed or duplicated identity still rejects the action.
  Status/date/urgency controls are not prose or narration. Urgency is optional
  (`urgent`, `high`, `medium`, `low`), unset by default. Its native dropdown shows
  a muted Set urgency action with a chevron until chosen, and Clear urgency
  clears the selection. Selected urgency uses a small semantic colour dot beside
  neutral text, without a coloured border or persistent fill. Keep native keyboard
  selection and a visible focus ring. Due dates are strict valid all-day Gregorian dates.
  Preserve both optional values and origin across moves, copies, autosave and MCP.
  Exactly one valid first-line marker establishes ticket identity. Multiple valid
  markers remain ambiguous ordinary tasks; preserve their comments through editor
  round-trips and reject ticket mutations rather than choosing one identity.
  Do not create a second ticket store.
  A board is an atomic rich-editor node serialized as
  `<!-- orion-kanban:v1 ID URI_ENCODED_TITLE -->`. Home and note boards derive
  the same Space-local tasks through `src/lib/tickets.ts`; statuses and board
  assignment write the originating note through ordinary autosave. Changes to
  the open note use editor transactions and retain Undo. Never replace the
  live document just to move a card. Stable IDs locate moved lines, exact
  captured lines guard concurrent changes, and duplicated IDs fail closed.
  Pasted copies receive new identities; copied board/ticket assignments remain
  together. Missing/deleted boards leave tickets as No board. Deleting a note
  naturally removes its work from the derived list. Cache immutable notes and
  editor branches; ordinary typing without a board does not index the library.
  Ignore code, quoted examples and frontmatter. Keep board controls out of
  narration/word counts. Readable exports show static boards using only notes
  included in the chosen scope. Markdown retains metadata and checkboxes.
- Home adapts to the active Space's authored work: omit unused To-dos/Tickets
  sections, place the kanban/ticket view first above a paired To-do and Across
  this Space card row, then Continue exploring, and compact the atmosphere
  hero around the Space name. Fold completed list items behind a disclosure;
  completing the final item keeps a compact All caught up state in place.
  Board view exists only when boards do and is the default whenever a board exists.
  An explicitly chosen List view is remembered for that Space/window session.
  Remember view, selected board and completed disclosures per Space/window in
  App-owned session refs, never in the vault or autosave. Use the cached work
  index, not per-keystroke dashboard extraction. Keep source-note/concept links.
  The paired cards retain independent internal scrolling and stack at narrow widths.
  Work dialogs use the opaque theme surface-raised colour with readable text;
  backdrop dimming and 18px blur apply behind the dialog, never through it.
  `HomeTickets.tsx` owns this presentation; ordinary checkbox completion and
  ticket changes use the same guarded note update path.
  Continue exploring has no Recent notes heading or three-note limit. Show every
  active-Space note in a keyboard-focusable horizontal strip, newest updated
  first, with contained horizontal overflow and offscreen rendering containment.
- Boards in Home and notes offer Add ticket inside every column. Enter creates
  in that board's source note with the column's status and keeps the field ready
  for another; Escape cancels and restores its Add button. Editor creation is
  one Undo, with literal titles and fresh IDs. Cards use pointer capture for drag,
  not native HTML drag (Tauri's file-drop bridge can intercept it). Highlight
  valid destinations, ignore drops outside the local board/work section, and
  cancel on Escape, pointer cancellation or window blur.
  Cancel native selection on eligible pointer-down while retaining click focus.
  Suppress selection across the work area only during an active drag, restoring
  it on drop, cancellation, capture loss, blur and unmount. Date/urgency inputs,
  checkboxes and assignment/concept/delete buttons remain ordinary
  controls; dragging must never select column headings or surrounding prose.
  Board cards have no directional buttons or status dropdowns: drag between columns,
  or use Left/Right on a focused card. Keep urgency at the far right of the footer. Home's
  board chips accept dragged list tickets/to-dos; a small board-choice dialog
  supplies the keyboard alternative. Preserve focus after moves/completion.
- Infer tickets from note first collects open written to-dos from the whole note,
  then optionally uses the selected provider for prose inference. Collect original
  task structure while excluding completed items, preserving independently open
  subtasks under completed parents. Mask completed prose before splitting or any
  provider request; summaries,
  sources, other notes and history are excluded. A coordinator splits working
  text into at most 6,000 UTF-16-character sections (below native Chat's 8,000
  Unicode-character note-body cap), with 500-character overlap. Two bounded
  readers return up to 32 literal titles with exact section evidence; a local
  reducer deduplicates across readers and existing tickets. No tools or writes
  are granted. Every section is read; no first-24,000-character cutoff. Report
  section progress, cancel sibling readers on failure/close and enforce a
  60-second deadline per call. Failure must not claim complete coverage.
  Review is capped at 2,000 actions with explicit continuation guidance, never a
  silent note-reading cutoff. Without a key, collect open written to-dos locally.
  Reviewed existing to-dos retain their text and are promoted in place; only new
  prose suggestions append tasks. Recheck Space, unique board, exact captured
  body/title and live editor document; acceptance is one note write/editor Undo.
  Do not revive completed work or reassign tickets already on another board.
- `/calendar` inserts a fixed inline date using a keyboard month grid: arrows
  move days/weeks, Home/End move within the week, PageUp/Down change month, Enter
  chooses, Escape cancels without removing the command. Store a readable
  `[date label](orion-date://YYYY-MM-DD)` link in portable Markdown. Native editor
  links allow this exact scheme; reading/export render a `time`, never open it
  externally. Insert in one Undo at the captured unchanged cursor/document.
  Use the same picker for optional ticket due dates, including removal.
- Home derives a Space-local calendar between the top kanban and paired context
  cards when undismissed dates/ranges reach the current month or later, or an
  unfinished ticket has a due date (including overdue work). Older historical
  mentions alone do not keep it on the dashboard; they remain browseable when
  the calendar has current work. Lazy local English/Australian date recognition
  runs in yielded batches on saved notes, never on the typing path. Cache
  immutable note results. Infer dates/ranges only in prose, skipping code, raw
  HTML, frontmatter, quoted examples and completed task prose; independently open
  nested tasks remain eligible. A ticket's chosen due
  date takes precedence over prose mentions in its task. Picked dates never
  move; relative inferred mentions resolve against the note's saved `updatedAt`
  and expose this reference in their tooltip. Editing the note may change that
  reference. All-day dates avoid UTC conversion; numeric dates use day/month.
  An inferred mention must be a date by its own wording or its immediate
  surroundings. Drop bare durations and decades ("45 minutes", "3 days", "the
  1990s"), anything measured in seconds, minutes or hours, "now", and vague
  quantities ("a few days ago"); keep an anchored relative phrase ("in 3 days",
  "two weeks ago", "within 2 weeks", "next week", "end of month"). Keep a bare
  weekday abbreviation only when capitalised and preceded by a date cue (on, by,
  due, until, next…), followed by a day number, or used as a schedule label
  ("Mon: gym"); "the Sun" and "they wed" are words. Keep a day/month without a
  year only at the start of its block, after a date cue, or beside a label
  separator; "3/4 of the total" and "24/7" are not dates. "On the 15th" resolves
  to the next such day on or after the saved date, and only when a sentence
  boundary or connective follows ("on the 15th floor" is not a date). Whether a
  phrase is found must not depend on an unrelated digit in its paragraph, and a
  phrase cut by a scan window is read once, from the window that holds it whole.
  Keep inferred mentions visibly distinct from picked dates and firm ticket
  deadlines, with navigation back to the note. An inferred entry has a small
  Remove control on hover or keyboard focus (always shown without hover).
  Removing it stores a versioned key in optional `Note.dismissedCalendarMentions`,
  leaving its prose and `Note.updatedAt` unchanged; use ordinary vault autosave
  and a metadata-only Undo. Keys are bounded, unique strings derived from the
  full source block, duplicate-group size, block occurrence and match position,
  never the resolved date or document offset. A yielded prepass counts completed
  and due-dated duplicate blocks before eligibility filtering so dismissals cannot
  transfer to another task; adding/removing identical blocks conservatively makes
  that group eligible again. Different source wording may produce a new mention.
  Filter after date deduplication and before counts, grid marks and visibility.
  Dismissal-only saves reuse the completed scan. Guard Space, unique note identity
  and captured body; Undo preserves subsequent prose. Merge concurrent first
  dismissal lists as independent additions and preserve live metadata when an
  editor saves older captured props. When no relevant entries remain, unmount
  the complete calendar and restore keyboard focus to Home; keep picked dates
  and ticket deadlines independent. Detection never rewrites prose,
  triggers autosave or creates external calendar events. All calendar features
  work without AI or a key.
- Work-item dialogs use an 18px blurred backdrop, with opaque accessibility
  fallbacks for Reduce Transparency/Increase Contrast.
