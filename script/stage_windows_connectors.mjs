// Build one Windows MCP server and stage both desktop-client packages.
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = fileURLToPath(new URL("../", import.meta.url));
const resources = join(root, "src-tauri", "resources");
const output = join(resources, "windows-connectors");
const pluginRoot = join(output, "Orion-Codex-Plugin");
const plugin = join(pluginRoot, "plugins", "orion");
const claudeSource = join(root, "mcp", "orion-claude");
const binaryName = "orion-mcp.exe";
const target = "x86_64-pc-windows-msvc";
const manifest = join(root, "src-tauri", "mcp-server", "Cargo.toml");
const encodedFlags = [
  process.env.CARGO_ENCODED_RUSTFLAGS,
  `--remap-path-prefix=${root.replace(/[\\/]$/, "")}=/orion`,
  `--remap-path-prefix=${homedir()}=/build-user`,
].filter(Boolean).join("\x1f");

const { target_directory: targetDirectory } = JSON.parse(execFileSync("cargo", [
  "metadata", "--locked", "--no-deps", "--format-version", "1", "--manifest-path", manifest,
], { cwd: root, encoding: "utf8", windowsHide: true }));
execFileSync("cargo", [
  "build", "--locked", "--release", "--target", target, "--manifest-path", manifest,
], {
  cwd: root,
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: encodedFlags },
  stdio: "inherit",
  windowsHide: true,
});

const binary = await readFile(join(targetDirectory, target, "release", binaryName));
const header = binary.length >= 64 ? binary.readUInt32LE(60) : binary.length;
if (header > binary.length - 6 || binary.readUInt16LE(0) !== 0x5a4d
  || binary.readUInt32LE(header) !== 0x00004550 || binary.readUInt16LE(header + 4) !== 0x8664) {
  throw new Error("The connector build did not produce a Windows x64 executable.");
}
const licenses = ["pulldown-cmark-LICENSE", "unicase-LICENSE-MIT"];
const notices = await readFile(join(resources, "MCP_THIRD_PARTY_NOTICES.md"));

await rm(output, { recursive: true, force: true });
await mkdir(join(pluginRoot, ".agents", "plugins"), { recursive: true });
await cp(join(root, "codex", "orion"), plugin, { recursive: true });
await mkdir(join(plugin, "server"), { recursive: true });
await mkdir(join(plugin, "licenses"), { recursive: true });
await writeFile(join(plugin, "server", binaryName), binary);
await writeFile(join(plugin, "MCP_THIRD_PARTY_NOTICES.md"), notices);

const marketplace = {
  name: "orion-desktop",
  interface: { displayName: "Orion" },
  plugins: [{
    name: "orion",
    source: { source: "local", path: "./plugins/orion" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  }],
};
await writeFile(join(pluginRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify(marketplace, null, 2));
const mcpConfigPath = join(plugin, ".mcp.json");
const mcpConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
mcpConfig.mcpServers.orion.command = `./server/${binaryName}`;
await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

const claudeManifest = JSON.parse(await readFile(join(claudeSource, "manifest.json"), "utf8"));
claudeManifest.compatibility.platforms = ["win32"];
claudeManifest.server.entry_point = `server/${binaryName}`;
claudeManifest.server.mcp_config.command = "${__dirname}/server/" + binaryName;
const pluginManifest = JSON.parse(await readFile(join(plugin, ".codex-plugin", "plugin.json"), "utf8"));
const binaryVersion = execFileSync(join(plugin, "server", binaryName), ["--version"], {
  encoding: "utf8", timeout: 10_000, windowsHide: true,
}).trim();
if (binaryVersion !== `Orion MCP ${claudeManifest.version}` || pluginManifest.version !== claudeManifest.version) {
  throw new Error("The Windows connector and plugin versions must match.");
}
const claude = new JSZip();
claude.file("manifest.json", JSON.stringify(claudeManifest, null, 2));
claude.file(claudeManifest.icon, await readFile(join(root, "public", "orion-mark.png")));
claude.file("README.md", [
  "# Orion for Claude Desktop on Windows",
  "",
  "Open Orion once, then install this extension in Claude Desktop.",
  "It discovers Orion's Windows library automatically. In Orion, open Settings → Connections",
  "to grant optional desktop workflows access to specific Spaces.",
  "",
].join("\n"));
claude.file(claudeManifest.server.entry_point, binary);
claude.file("MCP_THIRD_PARTY_NOTICES.md", notices);
for (const name of licenses) {
  const license = await readFile(join(resources, "licenses", name));
  claude.file(`licenses/${name}`, license);
  await writeFile(join(plugin, "licenses", name), license);
}
await writeFile(
  join(output, "Orion-Claude-Connector.mcpb"),
  await claude.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
);
console.log(`Staged ${binaryVersion} for Claude Desktop and Codex on Windows x64.`);
