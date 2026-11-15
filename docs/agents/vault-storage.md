# Vault storage and windows

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the vault file and its writers, preserved source text, backups, multi-window merging and saving.

Read it before changing `src/lib/storage.ts`, `src/lib/sourceTextStore.ts`, `src/lib/windowVault*.ts`, `src-tauri/src/source_texts.rs`, `src-tauri/src/vault_backups.rs`, `src-tauri/shared/source_text_ref.rs`, `src-tauri/src/desktop_windows.rs`, and the vault commands in `src-tauri/src/lib.rs`.

Related: [Claude connector and Codex plugin](mcp-connector.md), [Desktop workflows over MCP](desktop-workflows.md).

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
Autosave coalesces 800 ms typing pauses with a five-second ceiling during
continuous input; explicit navigation/window/quit flushes retain their save
handshake. `windowVaultPublication.ts` reuses equal immutable Space, note and
vocabulary objects after disk round trips. Only incoming note/concept changes
need external vocabulary reconciliation. Do not rebuild every Space's vocabulary
or invalidate rich-editor linking after an ordinary local autosave.

Deep links target one preferred window, not every renderer. The native workflow
lease remains shared across windows. Automatic overview generation also claims
one native owner per Space to avoid duplicate provider work.
