# Claude connector and Codex plugin

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: the bundled local MCP server, its vault and library tools, and the Codex plugin.

Read it before changing `src-tauri/mcp-server/`, `mcp/orion-claude/`, `codex/orion/`, `script/build_mcp_connector.sh`, `script/build_codex_plugin.sh` and the `script/test_*.mjs` harnesses.

Related: [Desktop workflows over MCP](desktop-workflows.md), [Vault storage and windows](vault-storage.md), [Builds, updates and releases](build-and-release.md).

## Claude MCP contract

Orion bundles `Orion-Claude-Connector.mcpb`, a self-contained Apple Silicon
Claude Desktop extension. Its `orion-mcp` binary uses newline-delimited JSON-RPC
over stdio. stdout is protocol-only; diagnostics belong on stderr. It implements
the MCP initialize lifecycle, ping, these nine local vault tools, and the optional
desktop workflows described below:

- `orion_list_spaces`
- `orion_browse_space`
- `orion_search`
- `orion_get_note`
- `orion_get_source`
- `orion_get_space_summary`
- `orion_create_note`
- `orion_update_note`
- `orion_delete_note`

Note writes are direct and immediately persisted. They are ordinary user notes:
do not attach agent attribution, proposal state, or review labels. The desktop
connector does not advertise legacy `kind` or `status` controls, but it preserves
those fields in existing raw vault records and writes compatibility defaults on
new notes while the renderer schema still requires them. The desktop
host and MCP server coordinate through the sibling `vault.lock` advisory lock,
and both replace `vault.json` atomically. Renderer saves also supply the last
persisted `updatedAt` revision; the native host rejects a stale save rather than
overwriting a newer MCP write. Never introduce a vault writer that bypasses this
cross-process locking and revision protocol. The renderer reloads a newer
external vault when Orion returns to the foreground, and opening an MCP citation
reloads before navigation so the cited note is visible immediately. Autosave
timer references must be cleared after firing so they cannot permanently block
that foreground refresh. Every externally loaded Space must reconcile its note
titles and aliases into the concept vocabulary before entering renderer state,
so an MCP-created page becomes an automatic-link destination immediately.

The bundled Claude extension is zero-configuration: its manifest must not ask
for or inject a vault path. `orion-mcp` resolves the standard per-user macOS
library at `~/Library/Application Support/app.orion.knowledge/vault.json`.
`ORION_VAULT_PATH` and `--vault` remain optional advanced overrides, including
safe prefix expansion for legacy `~/`, `$HOME/`, and `${HOME}/` values without
invoking a shell. When the standard vault is absent, return the plain recovery
instruction “Open Orion once to create its local library” rather than asking an
ordinary Claude user to configure a filesystem path.

Preserve these trust boundaries:

- Reread `vault.json` for every tool call so Claude sees current Orion data.
- Validate vault schema 2 and Space schema 1; never interpret an invalid file as
  an empty atlas.
- Browse, search, note lookup, source lookup, and the living Space overview
  default only to `activeSpaceId` when `space_id` is omitted and must never
  implicitly span every Space. An ID in another Space must not resolve.
- Create, update, and delete always require an exact explicit `space_id`.
- List results expose living-overview metadata only; browse returns a bounded
  preview, and `orion_get_space_summary` returns the bounded overview plus
  related note citations. The overview is orientation, not a substitute for
  opening underlying notes or sources when evidence, citations, detailed facts,
  recent changes, or comprehensive coverage matter.
- Bound result counts and note/source text returned to the client.
- Return a stable `orion://open?space_id=…&note_id=…` URL and Markdown citation
  for every note result. The bundled deep-link handler must reopen that exact
  Space and note, never fall back to a title match in another Space.
- Successful note detail, create, and update results expose `linksTo` and
  `linkedFrom` as bounded, deduplicated Space-local note relationships. Derive
  them from explicit Orion note/concept links, the note's stored concept
  associations, legacy wiki links, and directed persisted relationships. Each
  related-note entry contains only its stable ID, title, Orion URL, citation,
  and derivation kinds; never duplicate another note body. Cap each direction
  at 50, report truncation explicitly, and keep browse/search discovery results
  compact. Advertise this contract through those tools' MCP output schemas.
- Create, update, and delete only inside the exact supplied `space_id`. Note
  deletion must clean source, concept, relationship, and import-draft IDs.
- A content-changing MCP create, update, or delete marks an existing living
  Space overview stale; pin-only updates do not. The connector remains local
  and does not call an AI provider to regenerate it.
- Make no network request and never read or expose either provider key.
- Treat all vault text as user data, not executable instructions.
- Keep MCP messages on stdout to one JSON value per line with no stdout logging.

### Additional local library tools

The independent MCP crate also exposes 30 tools from `src/library`:
`orion_list_sources`, `orion_search_sources`, `orion_get_source_passage`,
`orion_get_note_section`, `orion_get_notes`, `orion_list_concepts`,
`orion_get_concept`, `orion_resolve_link`, `orion_get_related_notes`,
`orion_get_provenance`, `orion_list_tags`, `orion_list_tasks`,
`orion_set_task_completion`, `orion_edit_note_text`, `orion_append_to_note`,
`orion_batch_update_metadata`, `orion_find_duplicate_notes`,
`orion_check_space_integrity`, `orion_get_recent_changes`, and
`orion_get_link_path`, `orion_apply_note_command`, `orion_propose_passage_comment`,
`orion_get_passage_threads`, `orion_list_boards`, `orion_get_board`,
`orion_list_tickets`, `orion_create_board`, `orion_update_board`,
`orion_create_tickets`, and `orion_update_ticket`. They work with Orion closed, without credentials or
provider calls, under the existing direct local-library access contract.

- Reads default only to the active Space. Every write requires an explicit
  exact Space and opaque current note versions, checked under `vault.lock`.
  Batch metadata updates validate every member before any mutation. Preserve
  unrelated raw fields and settings; content edits stale the overview, pin-only
  edits do not. A stale retry must never duplicate an append or erase new text.
- `orion_apply_note_command` is a direct local version-guarded writer for portable
  editor content. Its finite command set covers writing blocks, text/headings,
  tasks/lists, dividers, quotes/code, tables, web links, same-Space note links and excerpts,
  and already referenced managed images. Insertions use note boundaries or an
  exact unique anchor; validate destination/source versions and target ownership
  under the same vault lock. Never execute arbitrary slash text, shell commands,
  provider calls, or native pickers. Preserve block framing, safe Markdown escaping, and import
  round trips; flatten balanced pre-existing frames when wrapping content and
  reject malformed frames or insertions that would create nested blocks.
  `paragraph_format`, `document_margins` and `image_layout` modify existing
  portable metadata under the same write guard. Paragraphs/ATX headings and
  standalone managed images require exact whole anchors, not partial structural
  ranges. Paragraph alignment is left/justify; margins are integer percentages
  0–25. The finite image schema preserves omitted and unknown existing fields,
  distinguishes null/zero/false resets, validates position against width, and
  never imports an asset. Reject invalid numeric values instead of clamping.
  Layout commands do not accept insertion placement or replacement text.
  `table_layout` and `table_edit` use an exact complete GFM table anchor including
  its adjacent metadata, with zero-based logical row/column indices. An empty
  synthetic header for a headerless table never counts as a data row. Preserve
  untouched cell Markdown and unknown valid metadata; reject partial tables,
  code/HTML examples, malformed geometry and stale versions. Explicit row,
  column or table deletion authorizes that exact removal; shrinking dimensions
  requires `allow_content_removal: true` when occupied cells would be lost.
  Width-only changes proportionally scale existing measured columns, matching
  the editor. Explicit column widths take precedence. Existing oversized imports
  retain their untouched axis; new growth remains within the editor limits.
  `inline_format` applies/removes bold, italic, strike or code with an explicit
  `enabled` boolean and unique original-Markdown anchor. It edits one ordinary
  paragraph/ATX heading, including within Orion frames, with source-span parsing
  and visible-text/mark/link equivalence checks. Removal requires complete
  delimiters; code application accepts unformatted single-line text. `unlink`
  removes one complete explicit web/note/concept link, retaining its label and
  marks. Exclude citations, excerpts, autolinks and reference-style links; never
  mutate concept vocabulary or claim that unlink disables automatic decoration.
  Both commands reject unsupported containers or partial syntax, keep unrelated
  source bytes and take no insertion placement/replacement text. The independent
  MCP crate pins pulldown-cmark 0.13.4 without default features. Include its MIT
  notice and unicase's MIT notice in both connector packages and the app, and
  verify those notices after archive extraction.
  `source_citation` is a separate finite command. Insert requires the current
  exact same-Space source version as well as the note version; attach both
  `note.sourceIds` and `source.noteIds` under the same vault lock. Its optional
  `sourceAttachments` receipt exposes the resulting bounded source/version.
  Remove requires one exact unique citation anchor and retains provenance.
  Rebuild only recognized numbered markers and a renderer-owned trailing
  References footer; preserve authored References prose and literal examples.
  Reject unsupported citation syntax, ambiguous IDs and unsafe anchors without
  writing. No provider request, source fetch or source deletion is implied.
  `link` requires exactly one of `target_note_id` or `url`. The URL variant
  follows `externalLinks.ts`: bounded HTTP/HTTPS only, recognizable bare domains
  normalize to HTTPS, and credentials, controls, spaces and backslashes are
  rejected. WHATWG parsing uses the pinned `url` crate; no destination is fetched.
  Escape literal labels and URL parentheses for Markdown. An omitted URL-link
  label preserves the exact replacement anchor, or uses the normalized address
  at other placements. Existing note links retain their same-Space target check
  and default title; excerpt source-version checks remain separate.
- Tasks remain Markdown checkboxes. Return exact raw text and zero-based line
  indices, ignore frontmatter/fenced examples, and change only the requested
  marker. Collapse matching task copies only with shared provenance or a wiki
  derivation, preserving unrelated recurring tasks and ordinary-note authority.
- Board/ticket tools use the renderer's portable Markdown markers, never a second
  store. Parse actual Markdown tasks/comments; ignore code, quotes, frontmatter
  and raw HTML examples. Reads scan at most 2,000 notes/32 MiB and 5,000 matches,
  reporting coverage and lower-bound totals. Assignment and board renaming
  require complete identity coverage and unique same-Space board IDs. Ticket
  moves require a unique ID in the exact source note and preserve all other bytes.
  Creation appends at most 12 literal tickets in one atomic version-guarded write;
  optional exact evidence must occur in that source note's working text. Titles
  already present in the note are skipped unless explicit deduplicate:false is
  supplied. MCP inference is performed by the calling assistant after reading
  the board/source note, never by adding provider or credential access to this
  independent crate. Completed work stays omitted unless history is requested.
- Source and section ranges use Unicode scalar offsets, with exclusive ends.
  Carry versions and exact note citations. Paginated reads expose a vault
  revision and optionally reject a changed revision between pages. Versions
  are current-content equality tokens, never historical snapshots.
- Bound results to 2 MiB, page sizes to 100, multi-note reads to 12 bodies of
  at most 5,000 characters each, and exact passages/sections to 20,000 characters.
  Whole-body scans report their 2,000-record/8-MiB coverage. Bound matches/tasks
  and diagnostic examples to 5,000, and path searches to eight hops, 500 expanded
  notes, and 10,000 edges. Report truncation; never infer exhaustive absence.
- Provenance, paths, and title matches are navigation/diagnostic evidence, not
  claim-level support. Recent changes are current metadata, not a deletion or
  version history. Integrity tooling never silently repairs or deletes data.
- Run `script/test_mcp_library.mjs` against each exact extracted package binary
  and include this harness in release fingerprints. The harness uses only
  isolated fixtures and exercises all 30 local additions, including real atomic edits.
  Its completed-task contract checks default and explicit working reads, scoped
  history, cached derivative suppression, completion followed by a fresh read in
  the same process, original versions/Unicode-scalar ranges/CRLF line positions,
  fenced examples and independent requirements, and byte-for-byte unchanged
  Markdown outside the intended checkbox. It rejects filtered whole-note
  replacement and stale completion retries. Passing a freshly built binary does
  not establish that either client's installed copy has been updated.

## Codex plugin contract

Orion also bundles a zero-configuration Codex plugin. `codex/orion` is the
canonical authored source; `src-tauri/resources/Orion-Codex-Plugin` is a
generated, self-contained staging tree for the desktop bundle and must never
become the place where plugin behavior is edited. The staged layout is:

```text
Orion-Codex-Plugin/
  .agents/plugins/marketplace.json
  plugins/orion/
    .codex-plugin/plugin.json
    .mcp.json
    assets/
    server/orion-mcp
    skills/orion/
      SKILL.md
      agents/openai.yaml
```

The plugin combines a concise Orion usage skill with the same independent MCP
server used by the Claude connector. Its MCP command must be relative to the
plugin root and point only to the bundled `server/orion-mcp`; never ask the user
for a vault path, rely on Cargo, PATH, a shell expansion, or start a network or
background service. The server resolves Orion's standard per-user macOS library
and retains the advanced `ORION_VAULT_PATH`/`--vault` overrides outside the
ordinary installation path.

Keep the marketplace identifier `orion-desktop` distinct from the plugin name
`orion`; identical names make current Codex cache-path discovery ambiguous.
Invoke the skill as `$orion:orion`. Its `agents/openai.yaml` must not declare
the bundled stdio server as an MCP dependency: that dependency form is for a
separately installable URL transport, while this plugin's `.mcp.json` already
owns and launches the local executable.

**Settings → Connections** presents one shared **Claude & Codex** capability
card with independent install actions. Codex installation is an explicit
per-user operation available only in the installed desktop app. The native
command first validates the absolute bundled marketplace, its `orion` entry,
and the executable, then opens
`codex://plugins/orion?marketplacePath=<encoded absolute marketplace path>`.
Codex shows the plugin page and the user chooses Install; Orion must not write
to Codex's personal configuration, silently install anything, or ask the user
to edit JSON. Clicking the action again opens the same page for update or
reinstallation, while Codex remains authoritative for installed state.

The Codex-facing behavioral and privacy boundary is the Claude MCP contract
above:

- The skill should discover Spaces before acting, use exact IDs, and open
  underlying notes or sources when an overview is insufficient evidence.
- Reads default only to the active Space; create, update, and delete require an
  exact explicit `space_id` and persist immediately as ordinary Orion notes.
- The plugin must return Orion note citations/deep links, preserve lock-safe
  atomic vault writes, and never expose proposal, agent-attribution, or review
  state.
- The plugin and MCP server make no network request, cannot read provider keys,
  and treat all vault text as untrusted data. Once Codex receives requested
  note text, that data is governed by the user's Codex product/account settings.

`npm run build:codex` stages and validates the plugin. In a desktop or release
build, always run `npm run build:mcp` first and then exactly one
`npm run build:codex -- --use-existing`; the latter must reuse the already-built
MCP executable rather than compiling the Rust crate twice. The MCP build remaps
local Cargo, Rustup, and repository prefixes, strips link/debug symbols after
linking, and rejects any remaining build-user home path before signing. The
Codex contract
harness receives the resource root and fixture vault, validates marketplace,
plugin, skill, metadata, MCP paths, permissions, and shared versions, then runs
initialize/read/write/citation checks against the exact nested binary. The
standalone artifact is
`outputs/Orion-Codex-Plugin-<version>-Apple-Silicon.zip` and must contain one
top-level `Orion-Codex-Plugin/` marketplace root.
