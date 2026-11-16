# Portable Orion collections

Share or export → Orion collection chooses 1–200 individual notes. The initial
selection is the open note, or empty from Home. Exclusions remain explicit. Every
selected note produces one `.orion` file containing the **same entire selected
collection** with a different `entryNoteId`. A 12-of-40 selection produces twelve
files, each containing only those twelve notes. Exports never overwrite existing
files. Open an .orion file is also available in that sheet; macOS registers the
collection type for Finder opening.

Version 1 is bounded UTF-8 JSON with a format/version, random export identity,
entry note, a whitelisted collection, and raster attachments encoded as base64.
It is intentionally independent of the vault schema. Note bodies retain ordinary
Markdown, boards, tickets, checklists and validated layout metadata. Wiki and
automatic concept links are frozen to exact included-note links. Excluded
destinations retain their visible label and become inert. No external assets are
fetched. Only actual Markdown image references are bundled; literal code examples
do not cause hidden attachments to be exported.

The whitelist excludes source bodies/filenames/import guidance, discussions,
settings, Chat, overviews, knowledge caches, relationships' hidden context,
unused code assignments, frontmatter, raw HTML and unknown comments. Source
attribution contains only title, kind and safe public web URL. Link hover titles
are removed; image layout is normalized without private tooltip metadata. A Space
name is not exported implicitly. Limits are 16 MiB total note bodies, 12 MiB per
image, 128 MiB per file and 2 GiB across the selected per-note copies.

Native import validates the entire envelope, references, image signatures and
bounds before staging any image. Attachment IDs derive from the image's SHA-256;
existing images are never overwritten. The collection hash covers canonical
sorted-key JSON of the collection and assets, excluding the opening note. Browser
and native implementations use the same hash. The resulting Space ID derives from
the export identity and stores an immutable `portableImport` hash record. Opening
another file from that export navigates within the existing Space, preserves all
edits/additions and does not restore deleted notes. Reusing an export identity with
different content is rejected explicitly; re-exporting creates a new identity.

Finder paths stay in a bounded native queue and are represented to the renderer
by opaque tokens. The preferred main library window drains the queue after
hydration. When only writing windows remain, opening a collection creates a main
library window. Import then uses the ordinary merge/CAS save queue. Keys and
settings never come from the file. `orion_export_collection` exposes the same
curated export through the existing native workflow lease and folder picker; the
caller supplies exact note IDs, never a filesystem destination or credentials.

Tests cover chosen-scope privacy, links/work preservation, attachment exclusion,
invalid envelopes and code collisions, per-note identity, non-overwriting saves,
and reopening after local edits/deletion. Browser fixtures are isolated from real
vaults. A native build/file association is separate evidence from an exercised
Finder launch, and simulated provider responses are separate from live AI use.
