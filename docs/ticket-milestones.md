# Ticket milestones — implementation and completion audit

Requested scope: ORION-FEAT-001, 009, 002, 007, 003 and 005 from the Orion feature
backlog. The first milestone and its remaining extensions are implemented in this
checkout. Each row distinguishes implementation evidence from live integration
checks that have not been exercised.

| Feature | Required outcome | Owning evidence / status |
| --- | --- | --- |
| 001 | Curated per-note `.orion` files share one collection/export identity; selected notes, links, boards, tickets and images survive; excluded content stays private; repeated opens preserve edits without duplicate Spaces | Implemented in `portableOrion.ts` and `portable_orion.rs`. Browser export/open/reopen passed; shared Unicode/image fixture verifies native/browser hashes and exact image bytes. Native file association and Finder queue implemented; actual Finder launch remains unexercised. See `portable-orion.md`. |
| 009 | Stable sequential codes, configurable prefix, searchable/clickable note and Chat references, MCP code resolution, collision rejection | Implemented with the merge/lock-protected Space ledger and pinned prior prefixes. Tests cover concurrent allocation, copy/duplicate guards, prefix changes and portable collisions. Browser verified old ORION codes remain while new WORK codes allocate. |
| 002 | Shared expanded details, editable/reorderable checklists, completion progress and dictated child checklists | Detail edits remain in ordinary Markdown through guarded transactions. Tests cover nested content, Undo/reload/stale drafts and faithful TS/native dictation proposals. Desktop/narrow UI exercised. Live dictation-provider output was not exercised. |
| 007 | Source-note, ticket and board navigation with backlinks and history | Shared navigation includes deep links and native writing-to-library targets. Browser verified code → details → board/source → Back restores one modal. History and native target contracts covered by tests. |
| 003 | Reviewed extraction from any note, suggested boards, source retention and likely duplicate warnings | Note entry point uses the bounded section readers. Review exposes board/urgency choices and leaves likely duplicates unchecked. Local checklist inference and acceptance exercised in-browser; provider-backed inference covered with simulated responses. |
| 005 | MCP retrieves by ID/code, updates checklists/progress, records implementation and requires evidence for completion | `orion_get_ticket`, guarded `orion_update_ticket` and generic-writer completion guards implemented. Exact packaged executable tests cover ticket identity/version and completion requirements. Caller-supplied verification is explicitly labelled. |

Implementation order: identity/reference and MCP contracts, shared navigation,
reviewed extraction/dictation structures, then curated portable packages. All
features extend ordinary notes, existing save/version guards and Space boundaries.
No parallel ticket content store, credential propagation, or graph canvas.

Verification: `npm run check` passed 3,597 tests (one skipped), TypeScript and the
production renderer build. Native Rust passed 338 tests (eight ignored); MCP
passed 134. Both formatting checks and `git diff --check` passed. Packaged Claude
and Codex connector tests verify 66 advertised tools against the actual executable.
The final UI corrections passed all 44 tests in the three affected component
suites, followed by another production renderer and macOS app build. Desktop
build and UI-review outcomes are recorded in
`output/playwright/ticket-next-milestones/verification.md`.

UI checks use an isolated browser vault, including real per-note downloads,
opening both files into one Space and preserving a local checklist edit. Current
captures cover ticket, export and inference dialogs at 1440 and 550px, inference
empty state, and the existing orb in Chat. The orb source/CSS changes remain as
they were; no orb commit was merged or replaced. Live provider requests, real
simultaneous native windows and Finder launch are separate from these checks.
