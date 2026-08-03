import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const [binaryPath, vaultPath] = process.argv.slice(2);
if (!binaryPath || !vaultPath) {
  throw new Error(
    "usage: node script/test_mcp_connector.mjs /path/to/orion-mcp /path/to/vault.json",
  );
}

await Promise.all([access(binaryPath), access(vaultPath)]);
const testDirectory = await mkdtemp(join(tmpdir(), "orion-mcp-test-"));
const writableVaultPath = join(testDirectory, "vault.json");
await copyFile(vaultPath, writableVaultPath);

const child = spawn(binaryPath, [], {
  env: {
    ...process.env,
    ORION_VAULT_PATH: writableVaultPath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orion-package-test", version: "1.0.0" },
    },
  },
  {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "orion_list_spaces",
      arguments: {},
    },
  },
  {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "orion_search",
      arguments: { query: "purple-capybara" },
    },
  },
  {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "orion_create_note",
      arguments: {
        space_id: "space-alpha",
        title: "Connector package write",
        body: "This note verifies direct MCP persistence.",
        status: "ready",
      },
    },
  },
  {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "orion_get_note",
      arguments: {
        space_id: "space-alpha",
        note_id: "note-comte",
      },
    },
  },
];

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
}
child.stdin.end();

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
if (exitCode !== 0) {
  throw new Error(`orion-mcp exited ${exitCode}: ${stderr}`);
}

const lines = stdout.split("\n").filter(Boolean);
const responses = lines.map((line) => JSON.parse(line));
if (responses.length !== 6) {
  throw new Error(
    `Expected six JSON-RPC responses and no stdout noise; received ${responses.length}.`,
  );
}

const byId = new Map(responses.map((response) => [response.id, response]));
if (byId.get(1)?.result?.serverInfo?.name !== "orion") {
  throw new Error("MCP initialize response is invalid.");
}
if (byId.get(2)?.result?.tools?.length !== 8) {
  throw new Error("MCP tool list is invalid.");
}
if (
  byId.get(3)?.result?.structuredContent?.activeSpaceId !== "space-alpha"
) {
  throw new Error("MCP Space listing is invalid.");
}
const search = byId.get(4)?.result?.structuredContent;
if (search?.space?.id !== "space-alpha" || search?.results?.length !== 0) {
  throw new Error("Active-Space search leaked content from another Space.");
}
const created = byId.get(5)?.result?.structuredContent;
if (
  created?.created !== true ||
  !created?.orionUrl?.startsWith(
    "orion://open?space_id=space-alpha&note_id=note-",
  )
) {
  throw new Error("MCP note creation or Orion citation is invalid.");
}
if (
  byId.get(6)?.result?.structuredContent?.note?.citation !==
  "[Auguste Comte](orion://open?space_id=space-alpha&note_id=note-comte)"
) {
  throw new Error("MCP note lookup did not include the Orion citation.");
}
const writtenVault = JSON.parse(await readFile(writableVaultPath, "utf8"));
const writtenSpace = writtenVault.spaces.find(
  (space) => space.workspace.id === "space-alpha",
);
if (
  !writtenSpace?.notes?.some(
    (note) => note.title === "Connector package write",
  )
) {
  throw new Error("MCP note creation did not persist to the vault.");
}
if (
  writtenVault.spaces.find(
    (space) => space.workspace.id === "space-private",
  )?.notes?.length !== 1
) {
  throw new Error("MCP write changed another Space.");
}

await rm(testDirectory, { recursive: true, force: true });
process.stdout.write(
  "Orion MCP protocol, citation, write, and Space-boundary checks passed.\n",
);
