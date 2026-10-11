# Development checkout location

The authoritative checkout is `/Users/zzz/Developer/orion` as of 11 October 2026.
It resides outside iCloud-synced Documents. Existing Codex tasks and launch paths
can still use `/Users/zzz/Documents/Codex/2026-07-27/so/orion`, which is now a
symlink to that physical directory. Both paths refer to the same working tree.
Use the Developer path when configuring new tasks or development tools.

The prior Developer snapshot remains intact at
`/Users/zzz/Developer/orion-before-cutover-20261011-163852`. Its Git checkpoint
refs and earlier build/QA artifacts differ from the active tree, so it must not
be overwritten or treated as disposable merely because normal HEAD matches.
No conflict-copy review or cache cleanup was performed during migration.

## Verification

Both trees were fully local and on the same APFS device. To avoid another large
copy with limited free disk, strict same-volume directory renames preserved the
two complete trees, including ignored build assets, models, Git objects, outputs
and symlinks. The old Documents path was replaced by the compatibility link.

The migration compared 72,521 entries in the active tree and 65,095 entries in
the preserved snapshot using device/inode identity, mode, size, modification time
and symlink target. It also compared 1,978 maintained/Git file content hashes,
and exact Git HEAD, refs, index entries, working status and remotes. All matched.
Large assets were preserved by the same inode, rather than relying on equal file
sizes between the two previously different checkouts.

Finder's `.DS_Store` files and Git LFS scratch files under `.git/lfs/tmp` remained
in their respective trees but were excluded from equality assertions because
Finder and background Git integrations update them. An initial strict attempt
rolled back when those volatile files changed; the completed pass preserved all
stable entries. The move did not modify the application vault, installed apps,
connector installations or Codex personal configuration.

Machine-readable manifests, Git-state records and hashes are retained under
`outputs/migrations/20261011-163852`. The local native Preview remains under
`~/Applications/Orion Previews`; those app symlinks were not dereferenced or
duplicated. The isolated constellation QA server can run from the new checkout
with its existing `outputs/voice-constellation-qa/vite.config.mjs` configuration.

Keep the compatibility link until the user retargets existing Codex projects and
external launch entries. Removing it is a separate path migration, not routine
source cleanup.
