import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const [resourceRootArgument, fixtureVaultArgument] = process.argv.slice(2);
if (!resourceRootArgument || !fixtureVaultArgument) {
  throw new Error(
    "usage: node script/test_codex_plugin.mjs <resource-root> <fixture-vault>",
  );
}

const resourceRoot = resolve(resourceRootArgument);
const fixtureVaultPath = resolve(fixtureVaultArgument);
const marketplacePath = join(
  resourceRoot,
  ".agents",
  "plugins",
  "marketplace.json",
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
}

async function runProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
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
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  return { exitCode, stdout, stderr };
}

async function runMcp(binaryPath, cwd, vaultPath, requests) {
  const child = spawn(binaryPath, [], {
    cwd,
    env: { ...process.env, ORION_VAULT_PATH: vaultPath },
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

  const timeout = setTimeout(() => {
    child.kill("SIGKILL");
  }, 15_000);
  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();

  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  clearTimeout(timeout);
  assert(
    exitCode === 0,
    `Bundled Orion MCP exited ${exitCode}: ${stderr.trim()}`,
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

await access(resourceRoot, constants.R_OK);
await access(fixtureVaultPath, constants.R_OK);

const marketplace = await readJson(marketplacePath, "marketplace.json");
assert(
  marketplace.name === "orion-desktop",
  "Marketplace name must be `orion-desktop` so it cannot collide with the plugin cache namespace.",
);
assert(
  marketplace.interface?.displayName === "Orion",
  "Marketplace display name must be Orion.",
);
assert(
  Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1,
  "Marketplace must contain exactly one plugin.",
);
const marketplaceEntry = marketplace.plugins[0];
assert(marketplaceEntry.name === "orion", "Marketplace plugin must be `orion`.");
assert(
  marketplaceEntry.source?.source === "local" &&
    marketplaceEntry.source?.path === "./plugins/orion",
  "Marketplace must resolve Orion from ./plugins/orion.",
);
assert(
  marketplaceEntry.policy?.installation === "AVAILABLE" &&
    marketplaceEntry.policy?.authentication === "ON_INSTALL",
  "Marketplace must use the canonical installation policy.",
);
assert(
  marketplaceEntry.policy?.products === undefined,
  "Marketplace must not add product gating.",
);
assert(
  marketplaceEntry.category === "Productivity",
  "Marketplace category must be Productivity.",
);

const pluginRoot = resolve(resourceRoot, marketplaceEntry.source.path);
assert(
  pluginRoot.startsWith(`${resolve(resourceRoot)}${process.platform === "win32" ? "\\" : "/"}`),
  "Marketplace plugin path escaped the resource root.",
);
const pluginManifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const pluginManifest = await readJson(pluginManifestPath, "plugin.json");
assert(pluginManifest.name === "orion", "Plugin manifest name must be `orion`.");
assert(
  /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(pluginManifest.version),
  "Plugin manifest must contain a semantic version.",
);
assert(
  pluginManifest.skills === "./skills/" &&
    pluginManifest.mcpServers === "./.mcp.json",
  "Plugin manifest must use canonical skill and MCP paths.",
);
assert(
  Array.isArray(pluginManifest.interface?.defaultPrompt) &&
    pluginManifest.interface.defaultPrompt.length > 0 &&
    pluginManifest.interface.defaultPrompt.length <= 3,
  "Plugin interface must provide one to three starter prompts.",
);
for (const field of ["composerIcon", "logo", "logoDark"]) {
  const assetPath = pluginManifest.interface?.[field];
  assert(
    typeof assetPath === "string" && assetPath.startsWith("./assets/"),
    `Plugin interface ${field} must use a bundled asset.`,
  );
  await access(resolve(pluginRoot, assetPath), constants.R_OK);
}

const mcpManifest = await readJson(join(pluginRoot, ".mcp.json"), ".mcp.json");
assert(
  Object.keys(mcpManifest.mcpServers ?? {}).length === 1 &&
    mcpManifest.mcpServers?.orion,
  "Plugin must define exactly one MCP server named `orion`.",
);
const server = mcpManifest.mcpServers.orion;
assert(
  server.command === "./server/orion-mcp" && server.cwd === ".",
  "Orion MCP must launch ./server/orion-mcp with cwd `.`.",
);
assert(
  Array.isArray(server.args) && server.args.length === 0,
  "Orion MCP must not require launch arguments.",
);
assert(
  JSON.stringify(server).includes("ORION_VAULT_PATH") === false &&
    server.env === undefined &&
    server.env_vars === undefined,
  "Orion MCP configuration must not inject a vault path or environment.",
);
assert(
  Object.keys(server).sort().join(",") === "args,command,cwd",
  "Orion MCP configuration contains unsupported setup fields.",
);

const binaryPath = resolve(pluginRoot, server.cwd, server.command);
await access(binaryPath, constants.R_OK | constants.X_OK);
const binaryBytes = await readFile(binaryPath);
if (process.env.HOME) {
  assert(
    !binaryBytes.includes(Buffer.from(`${resolve(process.env.HOME)}/`)),
    "Bundled MCP must not disclose the build user's home path.",
  );
}
const versionResult = await runProcess(binaryPath, ["--version"], {
  cwd: resolve(pluginRoot, server.cwd),
});
assert(
  versionResult.exitCode === 0 &&
    versionResult.stdout.includes(pluginManifest.version),
  `Bundled MCP version must match plugin ${pluginManifest.version}.`,
);

const skillRoot = join(pluginRoot, "skills", "orion");
const skill = await readFile(join(skillRoot, "SKILL.md"), "utf8");
assert(!skill.includes("[TODO:"), "Orion skill contains an unfinished placeholder.");
for (const requiredGuidance of [
  "orion_list_spaces",
  "active Space",
  "explicit `space_id`",
  "orion_get_space_summary",
  "underlying notes or sources",
  "directly authorizes",
  "`orion://`",
]) {
  assert(
    skill.includes(requiredGuidance),
    `Orion skill is missing required guidance: ${requiredGuidance}`,
  );
}
const agentMetadata = await readFile(
  join(skillRoot, "agents", "openai.yaml"),
  "utf8",
);
assert(
  /default_prompt:\s*["'].*\$orion:orion/.test(agentMetadata),
  "Skill default prompt must explicitly invoke $orion:orion.",
);
assert(
  !/^dependencies:/m.test(agentMetadata),
  "A bundled stdio MCP must not be declared as a remote skill dependency.",
);

const fixtureVault = await readJson(fixtureVaultPath, "fixture vault");
const activeSpace = fixtureVault.spaces?.find(
  (space) => space.workspace?.id === fixtureVault.activeSpaceId,
);
const fixtureNote = activeSpace?.notes?.[0];
assert(activeSpace && fixtureNote, "Fixture must contain an active Space and note.");

const testDirectory = await mkdtemp(join(tmpdir(), "orion-codex-plugin-test-"));
const writableVaultPath = join(testDirectory, "vault.json");
try {
  await copyFile(fixtureVaultPath, writableVaultPath);
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "orion-codex-plugin-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "orion_list_spaces", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "orion_browse_space", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "orion_get_note",
        arguments: { note_id: fixtureNote.id },
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "orion_create_note",
        arguments: {
          space_id: activeSpace.workspace.id,
          title: "Codex plugin contract write",
          body: "This note verifies that the bundled Codex plugin persists writes.",
        },
      },
    },
  ];
  const responses = await runMcp(
    binaryPath,
    resolve(pluginRoot, server.cwd),
    writableVaultPath,
    requests,
  );
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert(
    byId.get(1)?.result?.serverInfo?.name === "orion",
    "Bundled MCP initialize response is invalid.",
  );
  assert(
    byId.get(2)?.result?.tools?.length === 41,
    "Bundled MCP must expose 29 local library tools and twelve desktop workflow tools.",
  );
  assert(
    byId.get(3)?.result?.structuredContent?.activeSpaceId ===
      activeSpace.workspace.id,
    "Bundled MCP did not discover the active Space.",
  );
  assert(
    byId.get(4)?.result?.structuredContent?.space?.id === activeSpace.workspace.id,
    "Zero-argument read did not stay inside the active Space.",
  );
  const noteResult = byId.get(5)?.result?.structuredContent?.note;
  assert(
    noteResult?.citation?.includes(
      `orion://open?space_id=${activeSpace.workspace.id}&note_id=${fixtureNote.id}`,
    ),
    "Bundled MCP note result is missing a clickable Orion citation.",
  );
  const created = byId.get(6)?.result?.structuredContent;
  assert(
    created?.created === true &&
      created?.citation?.includes("orion://open?space_id="),
    "Bundled MCP did not complete a direct Space-scoped write.",
  );
  const writtenVault = await readJson(writableVaultPath, "written fixture vault");
  const writtenSpace = writtenVault.spaces.find(
    (space) => space.workspace?.id === activeSpace.workspace.id,
  );
  assert(
    writtenSpace?.notes?.some(
      (note) => note.title === "Codex plugin contract write",
    ),
    "Bundled MCP write did not persist.",
  );
} finally {
  await rm(testDirectory, { recursive: true, force: true });
}

process.stdout.write(
  `Orion Codex plugin ${pluginManifest.version} marketplace, metadata, zero-config MCP, citation, and write checks passed.\n`,
);
