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
- Note results include citations that open the exact note in Orion.
- It can create, edit, and delete ordinary notes in an explicit Space.
- Writes are immediate and carry no Claude attribution or proposal state.
- It makes no network request and needs no OpenAI key.

There is no vault-path setup during installation. The connector automatically
uses Orion's per-user macOS library at
`~/Library/Application Support/app.orion.knowledge/vault.json`. Open Orion once
before first use so that local library exists.

Advanced command-line integrations that deliberately keep Orion data somewhere
else can set `ORION_VAULT_PATH` or launch `orion-mcp --vault /path/to/vault.json`.
These overrides are not required for the bundled Claude Desktop extension.
