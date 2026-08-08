import { spawn } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const [binaryPath, vaultPath, manifestPath] = process.argv.slice(2);
if (!binaryPath || !vaultPath || !manifestPath) {
  throw new Error(
    "usage: node script/test_mcp_connector.mjs /path/to/orion-mcp /path/to/vault.json /path/to/manifest.json",
  );
}

await Promise.all([
  access(binaryPath),
  access(vaultPath),
  access(manifestPath),
]);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.user_config !== undefined) {
  throw new Error("The bundled Orion connector must not request user configuration.");
}
if (manifest.server?.mcp_config?.env !== undefined) {
  throw new Error("The bundled Orion connector must resolve its vault without injected environment settings.");
}

const testDirectory = await mkdtemp(join(tmpdir(), "orion-mcp-test-"));
const writableVaultPath = join(testDirectory, "vault.json");
await copyFile(vaultPath, writableVaultPath);

async function runConnector(requests, environment) {
  const child = spawn(binaryPath, [], {
    env: environment,
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
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const automaticHome = join(testDirectory, "automatic-home");
const automaticVaultDirectory = join(
  automaticHome,
  "Library",
  "Application Support",
  "app.orion.knowledge",
);
await mkdir(automaticVaultDirectory, { recursive: true });
await copyFile(vaultPath, join(automaticVaultDirectory, "vault.json"));
const automaticEnvironment = { ...process.env, HOME: automaticHome };
delete automaticEnvironment.ORION_VAULT_PATH;
const automaticResponses = await runConnector(
  [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "orion_list_spaces", arguments: {} },
    },
  ],
  automaticEnvironment,
);
if (
  automaticResponses[0]?.result?.structuredContent?.activeSpaceId !==
  "space-alpha"
) {
  throw new Error("MCP did not discover Orion's standard per-user vault automatically.");
}

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
      name: "orion_browse_space",
      arguments: {},
    },
  },
  {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "orion_get_space_summary",
      arguments: {},
    },
  },
  {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "orion_search",
      arguments: { query: "purple-capybara" },
    },
  },
  {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "orion_create_note",
      arguments: {
        space_id: "space-alpha",
        title: "Connector package write",
        body: "This note verifies direct MCP persistence.",
      },
    },
  },
  {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "orion_get_note",
      arguments: {
        note_id: "note-comte",
      },
    },
  },
  {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "orion_browse_space",
      arguments: { space_id: "space-missing" },
    },
  },
];

const responses = await runConnector(requests, {
  ...process.env,
  ORION_VAULT_PATH: writableVaultPath,
});
if (responses.length !== 9) {
  throw new Error(
    `Expected nine JSON-RPC responses and no stdout noise; received ${responses.length}.`,
  );
}

const byId = new Map(responses.map((response) => [response.id, response]));
if (byId.get(1)?.result?.serverInfo?.name !== "orion") {
  throw new Error("MCP initialize response is invalid.");
}
if (byId.get(2)?.result?.tools?.length !== 9) {
  throw new Error("MCP tool list is invalid.");
}
if (
  byId.get(3)?.result?.structuredContent?.activeSpaceId !== "space-alpha"
) {
  throw new Error("MCP Space listing is invalid.");
}
const browse = byId.get(4)?.result?.structuredContent;
if (
  browse?.space?.id !== "space-alpha" ||
  browse?.spaceOverview?.title !== "The architecture of positivism" ||
  browse?.notes?.some((note) => note.id === "note-secret")
) {
  throw new Error("Zero-argument browse did not stay inside the active Space.");
}
const overview = byId.get(5)?.result?.structuredContent;
if (
  overview?.space?.id !== "space-alpha" ||
  overview?.spaceOverview?.available !== true ||
  overview?.relatedNotes?.[0]?.citation !==
    "[Auguste Comte](orion://open?space_id=space-alpha&note_id=note-comte)" ||
  !overview?.guidance?.includes("underlying notes or sources")
) {
  throw new Error("MCP living Space overview response is invalid.");
}
const search = byId.get(6)?.result?.structuredContent;
if (search?.space?.id !== "space-alpha" || search?.results?.length !== 0) {
  throw new Error("Active-Space search leaked content from another Space.");
}
const created = byId.get(7)?.result?.structuredContent;
if (
  created?.created !== true ||
  !created?.orionUrl?.startsWith(
    "orion://open?space_id=space-alpha&note_id=note-",
  ) ||
  created?.note?.kind !== undefined ||
  created?.note?.status !== undefined
) {
  throw new Error("MCP note creation or Orion citation is invalid.");
}
if (
  byId.get(8)?.result?.structuredContent?.note?.citation !==
  "[Auguste Comte](orion://open?space_id=space-alpha&note_id=note-comte)"
) {
  throw new Error("MCP note lookup did not include the Orion citation.");
}
const missingSpace = byId.get(9)?.result;
if (
  missingSpace?.isError !== true ||
  missingSpace?.structuredContent?.errorCode !== "unknown_space_id" ||
  missingSpace?.structuredContent?.recovery?.tool !== "orion_list_spaces"
) {
  throw new Error("MCP invalid-Space recovery is invalid.");
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
if (writtenSpace?.spaceOverview?.stale !== true) {
  throw new Error("MCP content write did not mark the living overview stale.");
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
  "Orion MCP zero-config discovery, protocol, citation, write, and Space-boundary checks passed.\n",
);
