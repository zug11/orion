# Orion for Claude

This local Claude Desktop extension gives Claude direct access to Orion.

- It reads `vault.json` directly and rereads it for every tool call.
- Search is restricted to one Space and defaults to Orion's active Space.
- Note and source lookup require both the Space ID and content ID.
- Note results include citations that open the exact note in Orion.
- It can create, edit, and delete ordinary notes in an explicit Space.
- Writes are immediate and carry no Claude attribution or proposal state.
- It makes no network request and needs no OpenAI key.

If Orion uses a nonstandard data location, choose its `vault.json` when Claude
asks for the vault file.
