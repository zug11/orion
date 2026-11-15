# Vault storage and windows

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the vault file and its writers, preserved source text, backups, multi-window merging and saving.

Read it before changing `src/lib/storage.ts`, `src/lib/sourceTextStore.ts`, `src/lib/windowVault*.ts`, `src-tauri/src/source_texts.rs`, `src-tauri/src/vault_backups.rs`, `src-tauri/shared/source_text_ref.rs`, `src-tauri/src/desktop_windows.rs`, and the vault commands in `src-tauri/src/lib.rs`.

Related: [Claude connector and Codex plugin](mcp-connector.md), [Desktop workflows over MCP](desktop-workflows.md).

## The vault file and its writers

`vault.json` has two writers: the desktop host and the bundled MCP server. Both
take the sibling `vault.lock` advisory lock, compare the caller's expected
`updatedAt` revision with the file, write a flushed temporary file and replace
the vault atomically. A stale save is rejected, never merged by the writer.
Renderer windows merge before they save (see Multiple Orion windows). The
connector's side of this protocol is in [the connector manual](mcp-connector.md).
Never add a writer that skips the lock, the revision check or the atomic
replacement, and never write the vault from the renderer.

## Preserved source text

Imported source text is immutable and can be megabytes per source, while the
vault is re-read, merged and rewritten on every autosave. The text therefore
lives beside the vault, the way note images do, so the cost of a save follows
the notes and not the size of the library's sources.

- Each text is one content-addressed file,
  `attachments/sources/<sha256>.txt`, in the folder that holds the vault. An
  overridden vault path keeps its texts next to it.
- A persisted source record carries `textRef: { sha256, bytes, chars }` and no
  `text`. The reference has exactly those three fields: a 64-character
  lowercase hex digest, the UTF-8 byte length and the Unicode scalar count.
  Empty text stays inline. A record never has both `text` and `textRef`.
- A vault that contains any `textRef` is written as `schemaVersion: 3`. A vault
  whose sources are all inline stays schema 2. Readers accept both. A binary
  that only knows inline text rejects schema 3 instead of reading every source
  as empty, so an older Orion build or an older installed connector reports an
  unsupported library until it is updated. Never emit a `textRef` under schema 2.
- The in-memory model is unchanged: `Source.text` is always a complete string
  in the renderer and inside the MCP server. `src/lib/sourceTextStore.ts` is the
  only renderer module that knows the on-disk form. It hydrates a loaded vault
  and externalizes a vault just before it crosses to the host, and it never
  sends or requests text the window already holds. `src/lib/storage.ts` applies
  it to `load_vault`, `save_vault` and the assistant workflow commit. Do not
  teach any other module about `textRef`.
- `src-tauri/shared/source_text_ref.rs` is shared by both crates and owns the
  reference format, path construction and length-checked reads. A path is only
  ever built from a validated digest. `src-tauri/src/source_texts.rs` owns
  hashing, atomic writes and pruning in the desktop host. The MCP server reads
  texts but never writes or prunes them, and it keeps a bounded process-wide
  cache keyed by digest.
- The host verifies the SHA-256 digest when it stores and when it loads a text.
  The connector checks the recorded length. A source's MCP version token is
  derived from the digest when the text is external.
- The host refuses to write a vault that refers to a text which is not on disk
  with its recorded length (`ORION_SOURCE_TEXT_MISSING`). The renderer answers
  that error by storing its texts again and retrying the save once. A missing
  or damaged text on load is a visible load error, never an empty source.
- An existing schema 2 library loads as before. After a successful load the
  renderer stores its texts and saves once in the background at the same
  revision; if another writer got there first, the next load migrates instead.
  The migration changes no note, source or timestamp.
- Unreferenced texts are pruned after a save, at most every six hours, and only
  when they are older than seven days. Texts referenced by the saved vault or
  by any retained backup are live. If a retained backup cannot be read, nothing
  is pruned. Deleting a source therefore never makes a restore lose text.
- Requests are bounded: 64 MiB per text, 96 MiB and 4,096 texts per IPC call.
  The renderer batches well below that.

## Backups and restore

Atomic replacement protects a save from being torn. It does not protect a
library from a save that is valid but wrong, or from a file damaged later.

- Before the host replaces `vault.json` it keeps the version being replaced as
  `backups/vault-YYYYMMDDTHHMMSSZ.json`, using a hard link (a copy where the
  file system has none), at most once every ten minutes. Retention keeps the three most recent backups, one per day for
  seven days and one per week for four weeks. A backup failure never blocks a
  save.
- The connector's writes replace the vault without making a backup. The next
  desktop save does.
- When the vault cannot be loaded, the error screen lists the backups
  (`VaultBackupRestore`). Restoring validates the chosen backup, checks that
  its source texts exist, sets the current file aside as
  `backups/replaced-<stamp>.json` (the five most recent are kept) and replaces
  the vault under the write lock. It never deletes the damaged file outright
  and never restores a backup that would not load.
- Backups are local files beside the vault. They are not an export and not a
  substitute for the user's own backup of the application data folder.

## Multiple Orion windows

**File → New Window** and **Cmd+Shift+N** open another full library window in the
current Space after flushing the originating window. **Cmd+N** still creates a
note. Windows share one vault while keeping their active Space, selected note,
history, scroll position, and transient UI independent. Titles identify the
current Space and note for the macOS Window menu.

The note toolbar's **Open in writing window** icon (left of Export) flushes the
current edits and opens a dedicated window for that exact Space and note. Reuse
an existing writing window for the same target. Its immutable launch route uses
`view=writing`, `space`, and `note`; it starts in the normal rich editor with no
sidebar or library navigation. Deleted or invalid targets show an unavailable
state, never a different note. Linked notes and excerpt
references route into a library window while the draft stays open. The minimal
window header has only the title and Export; do not add a back button. Excerpt
passages travel only as bounded transient native navigation data. Library
listeners register before declaring navigation ready, so loading windows can
queue a target. External citations and global theme-icon changes target library
windows. Writing windows retain ordinary autosave, conflict choices, native
fullscreen, and the shared Close/Quit save handshake; there is no separate copy
or persisted writing-window schema. Cmd+N in a writing window opens a library
window so it cannot replace the bound draft.

`src-tauri/src/desktop_windows.rs` owns window creation, native menus, citation
routing, overview ownership, and the per-window quit handshake. New windows use
the main window configuration and the narrowly scoped `orion-window-*`
capability pattern. Closing a window flushes and destroys only that window;
application Quit waits for every registered window to save. A failed save
cancels Quit in all windows. Never force-exit after an arbitrary timeout.

`src/lib/windowVault.ts` merges each window's changes against its last persisted
snapshot and freshly read disk data. Disjoint fields and records merge, while
competing text or deletion/edit changes require a visible choice. A choice is
bound to the displayed disk revision, and must not overwrite a later unseen
revision. Pending typing during a save is rebased as subsequent local edits.
Every write still uses `vault.lock`, the expected revision, and atomic file
replacement. Retries are bounded; failed writes leave local edits available.
Native save/workflow events refresh other windows without changing their
navigation; browser preview uses storage events and Web Locks. An external
refresh must recheck the save queue and persisted base after its asynchronous
read. If a save started or the base advanced during that read, discard the
result and retry against fresh disk data after saving settles. A delayed read
must never roll back the editor or mistake this window's own save for a
competing edit. JSON object key
order is not a content change. New save revisions must advance monotonically.
When both sides changed one record list, the merged list keeps the order on
disk, and a record only this window has keeps its place relative to its local
neighbours: a note created at the top of the list stays at the top. Records
another writer added at the same place come first, so appended Chat messages
keep the order in which they reached disk.
Autosave coalesces 800 ms typing pauses with a five-second ceiling during
continuous input; explicit navigation/window/quit flushes retain their save
handshake. `windowVaultPublication.ts` reuses equal immutable Space, note and
vocabulary objects after disk round trips. Only incoming note/concept changes
need external vocabulary reconciliation. Do not rebuild every Space's vocabulary
or invalidate rich-editor linking after an ordinary local autosave.

Deep links target one preferred window, not every renderer. The native workflow
lease remains shared across windows. Automatic overview generation also claims
one native owner per Space to avoid duplicate provider work.
