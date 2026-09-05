# Orion for Claude

This local Claude Desktop extension gives Claude direct access to Orion.

- It reads `vault.json` directly and rereads it for every tool call.
- Browse, search, note lookup, source lookup, and the living Space overview
  default only to Orion's active Space when no Space ID is supplied.
- Listing Spaces discovers exact IDs; all create, update, and delete operations
  require one explicitly.
- The living overview is for orientation. Claude can search and open the
  underlying notes or sources when an answer needs evidence, citations,
  detailed facts, recent changes, or comprehensive coverage.
- Note detail and successful write results include citations plus bounded
  `linksTo` and `linkedFrom` note identities derived inside the same Space.
  Connected note bodies are never duplicated into those relationship arrays.
- It can create, edit, and delete ordinary notes in an explicit Space.
- Writes are immediate and carry no Claude attribution or proposal state.
- The MCP executable makes no provider request and never reads API keys. Its
  existing local read/write tools need no Orion API key.

## Additional local tools

The connector also exposes 20 additional local library tools (41 tools total):
exact source passages and note sections, batch reads, concepts, link resolution
and paths, provenance, tags, Markdown tasks, duplicate detection, integrity,
recent changes, guarded text edits, and atomic metadata batches. These work
with Orion closed. Every new write requires an exact Space and current note
version; conflicts stop before saving. Source offsets count Unicode scalar
values. Coverage flags distinguish bounded discovery from exhaustive reads.

## Optional Orion workflows

Keep Orion open and enable **Settings → Connections → Orion workflows** for the
Spaces you choose. Separately allow AI use and import/generation writes.
Orion runs the work using its configured model and provider account. Its
existing-note AI-context preference still applies. Context and results returned
to Claude are also governed by the user's Claude account settings.

The connector exposes local context packets, evidence-based research (answer,
compare, gaps, review, brief), full source imports, preserved-source reprocessing,
note/podcast/deck generation, canonical article development, enrichment, and
Space-overview refresh. Call `orion_get_capabilities` to check availability.

Every workflow requires an exact Space ID and a unique `request_id`. It returns
a job immediately; use `orion_get_job`, `orion_list_jobs`, and `orion_cancel_job`
to follow or stop work. Retry uncertain submissions with identical input and the
same request ID. Deduplication and results last up to one hour, 32 retained jobs,
or app restart. Avoid rapid polling. Results distinguish partial evidence,
staleness, AI interpretation, recovery output, and unknown token usage.

Import accepts text, supported absolute local file paths, and public HTTPS
webpage/YouTube URLs. Local mode preserves source notes without AI. AI mode uses
Orion's existing synthesis and canonical-reuse pipeline. Reprocessing keeps
original source IDs. Generation creates editable notes and scripts; playback
uses Orion's ordinary controls. Research and context never save notes or Chat.

The running app owns the private per-user Unix socket, validates permissions and
Space revisions, and commits through Orion's lock-safe atomic vault writer. No
separate service starts. These workflow grants do not change the installed
connector's existing direct read/write access.

There is no vault-path setup during installation. The connector automatically
uses Orion's per-user macOS library at
`~/Library/Application Support/app.orion.knowledge/vault.json`. Open Orion once
before first use so that local library exists.

Advanced command-line integrations that deliberately keep Orion data somewhere
else can set `ORION_VAULT_PATH` or launch `orion-mcp --vault /path/to/vault.json`.
These overrides are not required for the bundled Claude Desktop extension.
