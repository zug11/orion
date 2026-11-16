# Expanded tickets and stable codes

The first ticket milestone connects Home, embedded boards and note cards to one
ordinary Markdown task. It adds manual expanded editing and stable human-readable
codes. It extends the existing ticket system without changing its comment format.

## Behavior

Click a board or Home ticket title, or a note card’s Details action, to open the
same native modal. The large editable title leads into Priority and Status, a
description and checklist. Add, rename, reorder, remove or check off items; the
count and card progress update together. A source-note action opens rich editing.
Completing the checklist never changes the parent status. Rich descriptions are
shown faithfully and remain editable in the original note.

Every change resolves a unique durable ticket identity in its originating note.
`ticketDetails.ts` patches only that captured task subtree. Stale drafts fail
closed when another view changes the block; unrelated prose survives. The live
rich editor applies a schema-checked transaction with one Undo boundary. Home
and reading mode use the existing note update, autosave and window merge paths.
There is no independent ticket or checklist content database.

## Code identity and persistence

Optional Space `ticketCodes` has shape
`{version:1, prefix:"ORION", nextNumber:2, assigned:{"ticket-id":1}}`.
Numbers start at one and display with at least three digits. Assignments include
deleted identities so reopening, status changes, moves and Undo never renumber
published tickets or recycle a number. Copies with new IDs get fresh codes.
Ambiguous duplicate IDs receive no new assignment and cannot be edited as tickets.

The renderer allocates after the three-way merge with current disk, before the
revision-guarded save. A concurrent writer retries against the new ledger. The
renderer exposes only acknowledged assignments. MCP allocates within its existing
exclusive vault lock and includes codes in work receipts and ticket reads. Shared
native validation rejects duplicate numbers, removed assignments and renumbering.
Ordinary saves with an existing ledger check only changed notes for unassigned
identities; full Space reconciliation runs when an allocation is needed.

Codes are scoped to the Space. Exact code search opens the source note, and bare
codes in note prose, the rich editor and Chat open the shared detail view. Code,
existing external links and other Spaces are not decorated. Settings → Data has
the prefix for future tickets; optional `assignedPrefixes` pins old codes through
prefix changes and concurrent allocation. The reference index uses acknowledged
ledger entries, not a per-keystroke library scan. Deleted or ambiguous identities
fail navigation clearly. Ticket, board and source destinations participate in
Back/Forward; a history restoration retains its reading position. Writing-window
navigation transports the exact board/ticket target to the main library.

Every reading note offers Infer tickets from this note. The same bounded readers
and local checklist collector now work without a board. Review suggests a unique
board by overlapping stated words, lets each action choose another board or No
board, and leaves likely duplicate candidates unchecked. This heuristic is a
suggestion, never proof of duplication. Only the originating note is read by AI;
board matching and duplicate candidates are local. Acceptance rechecks the note,
Space and unique board identities. Existing to-dos are promoted in place, and
new actions remain in that source note even when assigned to another note's board.

Dictation's existing single cleanup request can return a bounded `checklist` for
a new ticket or a new board's child ticket. Every item requires literal text and
an exact speech quote; no completion flags or target IDs are accepted. Children
become ordinary nested tasks in the same Undo transaction. Invalid structure
falls back to independently validated cleaned prose. This is not a second AI call.

`orion_get_ticket` resolves exactly one ID/code and returns bounded source,
checklist and relationship context. `orion_update_ticket` can check off exact
versioned child lines and append a literal implementation summary and verification
report inside the original task. An existing open ticket may become done only
when its ordinary checklist is finished, a nonempty summary is supplied and all
reported checks pass. The shared MCP mutation boundary also rejects completion
through generic note writers, including moving a ticket between notes. These are
caller-reported checks; Orion does not independently run or certify the evidence.
Manual UI completion remains the person's decision. Explicit historical reads
retain completed reports; ordinary working reads omit completed material.

Portable `.orion` collections preserve only included ticket codes and identities.
They import into a separate Space, retain local edits on reopening, and reject
malformed/colliding registries with an explicit error. See `portable-orion.md`.

## Direction contract

Extend Orion’s existing dark/light surfaces and typography. The user’s screenshot
is a loose reference ("sorta like screenshot for expanded"), not a pixel-exact comp.
Use one quiet, opaque raised panel, a large wrapped title, paired native property
controls, readable description and an editable checklist. The existing accent
marks focus and completion. Keep the original note one action away. At narrow
widths text wraps and the modal scrolls internally. Native dialog behavior owns
focus containment and Escape; content is local and remains useful without AI.
The CSS is scoped to ticket details, avoiding the shared orb presentation files.

## Verification

Logic tests exercise nested Markdown edits, literal escaping, stale/duplicate
rejection, CRLF, concurrent code allocation and stable saved identities. Editor
integration tests cover checklist changes, Undo, reload and stale external edits.
MCP tests verify the same code through creation, status updates and reads. Browser
QA uses an isolated synthetic vault, never demonstration notes in a real vault.
