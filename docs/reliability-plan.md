# Orion reliability plan

Review of `41829ab` (0.6.1) on 2026-11-15. Everything below was checked against
the code; the numbers come from the real modules run in a 4-core Linux
container (browser-preview mode, no Tauri). Treat absolute timings as
indicative and rerun on a Mac; the *shapes* (cliffs, O(size) costs) are the
point. Probe scripts are listed in the appendix.

## Context

Orion's hard parts are already done well: the vault write path is lock → CAS →
temp file → fsync → atomic rename → directory fsync; multi-window saves use a
three-way merge; AI never holds authority; the webpage fetcher blocks private
addresses including the IPv6 disguises; 3,471 renderer tests and 120 MCP tests
pass. What is missing is the layer around that core: recovery when something
does go wrong, behaviour at library sizes the heavy users will reach, and a few
edge cases where data is silently lost. This plan is ordered by how much user
data or usability each item protects, not by how hard it is.

## Verified healthy (do not spend time here)

- Browser-preview smoke (Playwright): create → autosave → reload → search →
  manual paste import (note + source with two-way provenance) → edit/re-save →
  delete via confirm, plus every route at 1280×800, 1024×680 and 900×600 with
  no horizontal overflow. Zero console or page errors across all runs.
- Local search cost: 1,500 notes ≈ 20 ms per keystroke warm (268 ms once cold);
  80 × 700 KB sources ≈ 1–21 ms. Not a problem.
- `rustfmt --check` clean on both crates; `tsc` + `vite build` clean.
- `fetch_webpage` SSRF guard (`src-tauri/src/lib.rs:4370`): thorough, pinned
  resolution, redirects revalidated.
- Space creation uses `space-${nanoid(10)}`; duplicate Space names are rejected.
- `localSearch` builds regexes only from escaped or alphanumeric terms.

## P0 — data loss and freezes

### P0-1 No vault backups; the recovery screen has nothing to restore
- **Evidence:** no rotation/backup anywhere in `src-tauri/src/lib.rs` or
  `src/lib/storage.ts`. The "Vault protected" veil (`src/App.tsx:4710`) offers
  only *open data folder* and *retry*. One 62 MB JSON file is the whole library.
  Atomic replace protects against torn writes, not against a merge bug that
  writes a valid-but-wrong vault, or user error.
- **Fix:** in `write_vault_file` (`lib.rs:1426`), before `persist`, hard-link
  the current `vault.json` to `backups/vault-<ISO>.json` (O(1), off the hot
  path). Policy: keep the last 3 writes at least 10 min apart, 7 dailies, 4
  weeklies, bounded total bytes; prune after each save. Add **Restore from a
  backup** to the veil: list backups with date/size, validate the chosen file
  with `parseVault` before restoring, keep the bad file as
  `vault.json.corrupt-<ISO>`. The MCP crate writes the vault too: share the
  rotation helper or document that only Orion rotates.
- **Tests:** Rust unit tests for the rotation policy and prune bounds; renderer
  test: invalid vault → veil lists backups → restore → app hydrates.
- **Effort:** M.

### P0-2 A hung Whisper worker freezes dictation app-wide, with no way out
- **Evidence:** `transcribe_voice_memo_with_worker`
  (`src-tauri/src/local_transcription.rs:346–392`) holds the global
  `VoiceMemoWorkers` mutex across the blocking `write_all` + `read_line`, with
  no timeout. `start_`/`finish_voice_memo_session` need the same mutex, so a
  stuck worker in one window blocks starting *or finishing* dictation in every
  window (finish is what would kill it). The renderer awaits the command
  forever; `toggleRecording` is a no-op in the `transcribing` phase
  (`src/components/VoiceMemoButton.tsx:352`), so the button spins until the app
  restarts. The Small edition's non-worker path inherits media-job deadlines of
  minutes, which is the same from the user's seat.
- **Fix:** store `Arc<Mutex<VoiceMemoWorker>>` per session; take the `Arc` under
  the global lock, release it, then lock the worker. Read responses on a
  dedicated thread and `recv_timeout` with a per-segment deadline (e.g.
  `max(45 s, 3 × audio duration)`). On timeout: kill the child, mark the session
  failed, return an actionable error; the existing partial-recovery path keeps
  earlier segments. In the renderer, let Stop abort a stuck `transcribing`
  wait (archive what exists, show the incomplete-recording error).
- **Tests:** Rust test with a fake worker that never answers (the media_jobs
  tests already spawn fixture processes); renderer test for stuck → cancel.
- **Effort:** M.

### P0-3 Navigating away mid-dictation discards the whole recording
- **Evidence:** the `[noteId]` cleanup effect (`VoiceMemoButton.tsx:279–290`)
  bumps `generationRef`, so `recorder.onstop` returns early, `finishSession`
  never runs, queued segments skip transcription, and nothing is archived.
  AGENTS.md only promises that a *completed* original survives. A sidebar
  click during a ten-minute dictation loses it silently.
- **Fix:** the session callbacks (`onSessionStart/onTranscribe/onComplete/
  onSessionEnd`) already live in App. Move session ownership there: on unmount
  while recording, stop the recorder, hand pending blobs + transcripts to an
  App-level finisher that transcribes, stitches and archives
  `source-dictation-<session>` in the originating Space, then toasts
  "Dictation saved to Sources (not inserted)". Insertion stays cancelled.
- **Tests:** unmount mid-recording → source archived, no insertion, no late
  insertion into the next note.
- **Effort:** M.

### P0-4 No error boundary or global error handlers
- **Evidence:** no `componentDidCatch`/`getDerivedStateFromError`, no
  `error`/`unhandledrejection` listeners anywhere in `src/`; `src/main.tsx` is a
  bare `createRoot().render`. One render exception in any node view (kanban,
  image, excerpt, ticket card) white-screens the window.
- **Fix:** boundaries around NoteView/RichNoteEditor (fallback: read-only view
  + *Reload editor*), each Home section, Chat, Settings and Import, so one
  broken surface cannot take the others down. Global listeners feed the
  diagnostics buffer (P2-5) and a toast; never swallow silently.
- **Tests:** a node view that throws → fallback renders, sidebar/autosave of
  other notes keep working.
- **Effort:** S.

## P1 — scale cliffs and correctness

### P1-1 Automatic concept links hit a performance cliff at ~600–800 concepts
- **Evidence:** `decorateAutoLinks` compiles every phrase into one alternation
  regex (`src/lib/wiki.ts:718`). Measured per decoration pass over a 20k-char
  note: 200 concepts 2.3 ms · 500: 2.7 ms · **800: 285 ms · 1,200: 620 ms ·
  1,600: 970 ms · 2,000: 1.6 s**; 2,000 concepts on a 150k-char note: 11.7 s.
  The editor plugin (`src/components/editor/AutoConceptLinks.ts`) recomputes
  the whole document in `props.decorations` on **every** transaction, including
  selection-only moves. The reading view (`src/components/NoteView.tsx:1137`),
  Home, exports and tasks call the same function. Every note title is a
  concept, so a 1,000-note Space is already past the cliff.
- **Fix:** (a) replace the alternation with a tokenised lookup: split text into
  words with offsets, index candidates by normalised first word
  (`Map<string, Candidate[]>` sorted longest-first), try candidates at each
  token; cost becomes O(text), independent of vocabulary size, and keeps the
  protected-range and word-boundary rules. (b) Make the plugin incremental:
  plugin `state` with `apply` that maps old decorations when `!tr.docChanged`
  and recomputes only text nodes inside changed ranges; memoise per text-node
  string. (c) Memoise the reading view per paragraph string + concepts identity.
- **Target:** < 5 ms per pass at 2,000 concepts / 20k chars; add a Vitest guard
  (2,000 concepts under 50 ms) so it cannot regress.
- **Effort:** M.

### P1-2 Autosave, focus refresh and MCP reads all scale with total library bytes
- **Evidence (real `persistWindowVault` + `mergeWindowVault`):**

  | Library | vault.json | main-thread per autosave |
  |---|---|---|
  | 50 notes, 5 sources | 0.4 MB | 3 ms |
  | 400 notes, 30 books | 10.5 MB | 77 ms |
  | 1,500 notes, 80 books | 62 MB | **420 ms** |
  | same, source text outside the vault | 5 MB | 30 ms |

  Autosave fires every 800 ms pause / 5 s during typing. `refreshExternalVault`
  (`src/App.tsx:1283`) does a full `loadSnapshot` + validate + merge on every
  window `focus`/`visibilitychange`, so alt-tabbing back costs the same. The
  MCP server re-parses the whole file on every tool call.
- **Fix:** move `Source.text` out of the vault, mirroring the note-image store:
  `attachments/sources/<id>.txt` with `textBytes`/`textSha256` on the record;
  read lazily (viewer, search cache, import). Migration on first load writes the
  files then rewrites the vault once; keep inline `text` accepted for old
  vaults; MCP crate reads the side files; deletion cascade and exports handle
  them. Cheaper first step for the refresh hitch: a native `vault_revision`
  command (reads `updatedAt`/mtime only) so focus refresh loads nothing when
  unchanged.
- **Effort:** L (storage) + S (revision check).

### P1-3 Home's calendar invents dates from ordinary prose
- **Evidence (real `recognizeNoteDates`, reference 2026-11-15):** "Sun
  exposure" → Sunday, "Mon ami" → Monday, "The 1990s" → **today**, "lasted 45
  minutes" → **today**; "Pay rent on the 15th" → missed. Because entries from
  the current month onward always show, a today-resolving false positive is
  always visible on Home. (`src/lib/calendarRecognition.ts:89`)
- **Fix:** post-filter chrono results: drop durations
  (`/^\d+\s*(min(ute)?s?|h(ou)?rs?|sec(ond)?s?|days?|weeks?|months?|years?)$/i`),
  decades (`/^\d{4}s$/`), bare three-letter weekday tokens unless preceded by
  on/next/this/last or followed by a day number, and anything that is neither
  `isCertain('month')` nor `isCertain('weekday')` nor contains a day number.
  Keep casual relatives ("tomorrow", "next Friday"). Add the probe cases as
  tests.
- **Effort:** S.

### P1-4 Markdown round trips lose or mangle content (real editor extension stack)
- **Evidence:** HTML comments in prose are deleted on the first save
  (`Before <!-- private reminder --> after.` → `Before  after.`); an image alt
  containing `"` gains backslashes **every** save/reopen cycle
  (`a "q"` → `a \"q\"` → `a \\\"q\\\"`); two adjacent bullet lists with
  different markers merge into one list on the second pass. Indented code →
  fenced, reference links → inline, setext → ATX are normalisations without
  loss and are fine. (Frontmatter is split off before the editor and was not
  affected.)
- **Fix:** parse unrecognised HTML comments into an atom node that serialises
  verbatim (Orion control comments stay owned by their extensions); make
  alt-text escaping idempotent (CommonMark alt only needs `]` escaped); emit a
  comment separator or alternate `-`/`*` for consecutive sibling lists and
  parse it back. Add a two-pass stability + no-word-loss test over the probe
  corpus in `src/components/editor/NoteStarterKit.test.ts`.
- **Effort:** S–M.

### P1-5 Dictation window stitching duplicates words
- Already queued as a suggested task ("Fix dictation overlap stitching
  duplicates"). Summary: exact-word matching anchored on the new window's first
  word fails when the 2 s cut word is misheard or clipped, and never matches in
  scripts without spaces (Japanese/Chinese duplicate every boundary). Prefer a
  time-based seam using whisper.cpp token timestamps (the sidecar already reads
  them for `--align`), with a script-agnostic tolerant text fallback. Covers
  both `src/lib/transcription.ts` and `appendTranscript` in
  `src-tauri/native/OrionWhisper/main.swift` (media import).
- **Effort:** M.

### P1-6 Dictation structure is all-or-nothing
- **Evidence:** `valid_proposal` (`src-tauri/src/dictation_cleanup.rs:632–750`)
  returns `false` for the whole proposal if one ticket's evidence quote is not
  an exact substring of the transcript; `parse_result` then drops every board,
  ticket and table from that dictation.
- **Fix:** validate each structured block independently; on failure replace
  only that block with its `sourceIndices` faithful blocks (`keep` semantics);
  discard the whole proposal only when coverage itself is broken. The existing
  tests for malformed structures adapt directly.
- **Effort:** S.

## P2 — hygiene, polish, process

### P2-1 Managed note images are never deleted from disk
- **Evidence:** the only `attachments` reference in `lib.rs` is the directory
  helper (`lib.rs:1084`); no `remove_file` targets it; the note-deletion cascade
  lists concepts/relationships/sources/links but not image assets.
- **Fix:** native `prune_note_images`: collect every `orion-image://localhost/<id>`
  across all Spaces (renderer supplies the set, including unsaved windows),
  delete unreferenced files older than 24 h (grace for Undo), run after note
  deletion and at idle/startup. Report freed bytes in Settings → Data.
- **Effort:** S–M.

### P2-2 A new note jumps to the bottom after a concurrent save from another window
- **Evidence (real `mergeWindowVault`):** local `[note-9 (new), note-1, note-2]`
  merged against a remote that only tagged note-2 publishes
  `[note-1, note-2, note-9]`, because record arrays are ordered remote-first
  (`src/lib/windowVault.ts:74`). Notes are prepended on creation
  (`src/App.tsx:1916`), so the user's new note visibly moves.
- **Fix:** insert local-only IDs at their local relative position (after the
  nearest preceding ID present in the remote order). Test with the case above.
- **Effort:** S.

### P2-3 Voice: unbounded paid fan-out and English-only turn heuristics
- One spoken number can launch up to 1,000 workers (`MAX_VOICE_WORKERS_PER_REQUEST`)
  with no confirmation; numbers are easy to mishear. Add a spoken confirmation
  above a threshold (e.g. 12). The instant-start/unfinished-thought/decision
  grammars in `src/lib/voiceUtterance.ts` and `voiceWorkOrders.ts` are English
  regexes; other languages still work via provider delegation but lose the fast
  paths — document it, and consider a bounded provider intent check when the
  transcript is not English.
- **Effort:** S (confirmation), M (i18n).

### P2-4 Startup bundle
- `vite build`: main chunk **2.13 MB** minified (667 KB gzip) plus 661 KB and
  504 KB index chunks loaded eagerly; `SettingsView`, `ChatDock`, `ExportDialog`
  are static imports in `App.tsx` (0 `lazy()` there). pdf.js, docx, mammoth,
  chrono and the shaders are already lazy. Lazy-load Settings, Export, Chat
  internals and Import; target main chunk < 1 MB; measure cold start on a Mac.
  Minor: the browser preview warns that the two preloaded fonts are "not used
  within a few seconds" — verify the preload is not a wasted double fetch in
  WKWebView.
- **Effort:** M.

### P2-5 No privacy-safe diagnostics
- There is no local log or error history, so user bug reports cannot be
  actioned. Add a bounded ring buffer (≈500 redacted events: error kinds, save
  conflicts, provider failure classes, stage timings — never note text or keys)
  plus a rotated native log, with **Copy diagnostics** in Settings → Data.
- **Effort:** M.

### P2-6 Tests and process (queued: "Fix timing-sensitive NoteView test and add CI")
- `src/components/NoteView.test.tsx:63` fails deterministically on slower
  machines (lazy editor import vs 1 s default wait). No CI. Release commits of
  up to 45k lines defeat review and `git bisect`. Adopt the Playwright
  browser-preview smoke (appendix) as `script/smoke_preview.mjs` in CI; commit
  per feature, not per release.

### P2-7 AGENTS.md (queued: "Reconcile stale AGENTS.md rules with the code")
- 343 KB (~85k tokens, 19× growth since July) with contradictions (atmosphere
  list, packet ceiling). Fix the stale rules, then split per-feature detail into
  `docs/` and keep AGENTS.md to the cross-cutting invariants.

### P2-8 Pasted-text import defaults
- A pasted document titled `# Pasted research` becomes a note titled "Pasted
  notes" with a mechanical summary containing table syntax residue
  ("Thinker Year --- --- Hegel 1820"). Default the title to the first heading
  when the name field is blank; strip GFM table/fence syntax from the excerpt
  (`src/components/ImportStudio.tsx:644`, `src/lib/importSummary.ts`).
- **Effort:** S.

## Not covered here

Native macOS paths (updater, quit handshake, Liquid Glass, Keychain, live
voice/provider behaviour) cannot run in this environment. Keep a short macOS
test matrix in `docs/` for each release: update install → save handshake,
two-window conflict, dictation hang/cancel, voice reconnect.

## Suggested sequencing

1. **Safety pass (≈1 week):** P0-1 backups, P0-2 dictation hang/mutex, P0-3
   dictation unmount archive, P0-4 error boundaries, P1-3 calendar filter,
   P2-2 merge order. All small-to-medium, all protect data or unblock the user.
2. **Scale pass:** P1-1 auto-link matcher + incremental plugin, P1-2 revision
   check for focus refresh, P1-4 round-trip fixes, P1-5 stitching, P1-6
   per-block structure fallback.
3. **Storage pass:** P1-2 source text out of the vault, P2-1 image GC.
4. **Process pass:** P2-4 bundle, P2-5 diagnostics, P2-6 CI + smoke, P2-7 docs
   split, P2-3 voice confirmation, P2-8 import defaults.

## Verification

Run after each pass:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/mcp-server/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo fmt --manifest-path src-tauri/mcp-server/Cargo.toml -- --check
```

Targets that make the fixes measurable:

- Auto-link pass at 2,000 concepts / 20k chars: < 5 ms (was 1.6 s).
- Autosave at 1,500 notes + 80 books: < 50 ms main thread (was 420 ms).
- Window focus with an unchanged vault: no full load.
- Stitch probe: all six boundary cases produce the speaker's words.
- Calendar probe: zero entries for the seven "none" cases; "on the 15th" found.
- Round-trip corpus: second pass identical to first; no lost words outside
  documented normalisations.
- Dictation: a worker that never answers fails within the deadline and other
  windows can still start/finish dictation.
- Vault: a deliberately corrupted `vault.json` offers a restorable backup.

## Appendix — probe scripts used for this review

These live in the session scratchpad (ephemeral); copy into `outputs/` or
`script/` if you want to keep them.

- `…/scratchpad/bench/autosave-bench.ts` — persistWindowVault cost by library size
- `…/scratchpad/bench/autolink-bench.ts` — decorateAutoLinks cost by vocabulary
- `…/scratchpad/bench/calendar-probe.ts` — recognizeNoteDates false positives
- `…/scratchpad/bench/stitch-probe.ts` — mergeVoiceTranscriptParts boundaries
- `…/scratchpad/bench/search-merge-probe.ts` — local search cost; merge ordering
- `…/scratchpad/bench/probe/MarkdownRoundTrip.test.tsx` — editor round trips
- `…/scratchpad/bench/smoke/flows*.cjs` — Playwright browser-preview smoke

Scratchpad root: `/tmp/claude-0/-home-user-orion/ea746e80-ce34-50d5-a4b4-628c74004054/scratchpad`.
