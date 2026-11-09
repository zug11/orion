// Run against the installed production WebView2 app, on an ephemeral CI user.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import JSZip from "jszip";

const { chromium } = createRequire(join(process.env.ORION_SMOKE_TOOLS, "package.json"))("playwright-core");
const executable = join(process.env.ORION_SMOKE_INSTALL, "orion.exe");
const vaultPath = join(process.env.APPDATA, "app.orion.knowledge", "vault.json");
const endpoint = "http://127.0.0.1:9222";
const title = "Orion Windows smoke note";
const body = "A phrase saved by the installed Windows build.";
const pageErrors = [];

async function eventually(operation, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await operation();
      if (result) return result;
    } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`, { cause: last });
}

async function vault() {
  return JSON.parse(await readFile(vaultPath, "utf8"));
}

let app;
let browser;
let page;
async function launch() {
  app = spawn(executable, [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.pipe(process.stdout, { end: false });
  app.stderr.pipe(process.stderr, { end: false });
  app.on("error", (error) => console.error("Could not start Orion:", error));
  app.on("exit", (code) => console.log(`Orion exited: ${code} (0x${(code >>> 0).toString(16)})`));
  await eventually(async () => {
    if (app.exitCode !== null) throw new Error(`Orion exited before WebView2 was ready (0x${(app.exitCode >>> 0).toString(16)}).`);
    return (await fetch(`${endpoint}/json/version`)).ok;
  }, "WebView2 debugging endpoint");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  assert(context, "WebView2 browsing context");
  page = await eventually(() => context.pages().find((candidate) => /tauri\.localhost/.test(candidate.url())), "Orion library renderer");
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.getByRole("button", { name: "New note", exact: true }).waitFor();
  await page.locator(".loading-veil").waitFor({ state: "hidden" });
  return context;
}

async function closeAndWait() {
  execFileSync("powershell.exe", [
    "-NoProfile", "-Command",
    `$process = Get-Process -Id ${app.pid}; if (!$process.CloseMainWindow()) { exit 1 }`,
  ]);
  await eventually(() => app.exitCode !== null, "native close and save");
  assert.equal(app.exitCode, 0);
  await browser.close().catch(() => {});
  browser = undefined;
}

async function invoke(name, args = {}) {
  return page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
}

async function installedConnectors(extensionDirectory) {
  const install = process.env.ORION_SMOKE_INSTALL;
  const archive = await JSZip.loadAsync(await readFile(join(install, "Orion-Claude-Connector.mcpb")));
  const manifest = JSON.parse(await archive.file("manifest.json").async("string"));
  assert.deepEqual(manifest.compatibility.platforms, ["win32"]);
  assert.equal(manifest.user_config, undefined);
  assert.equal(manifest.server.entry_point, "server/orion-mcp.exe");
  const claudeConfig = manifest.server.mcp_config;
  assert.equal(claudeConfig.command, "${__dirname}/server/orion-mcp.exe");
  assert.equal(claudeConfig.env, undefined);
  const claudeExecutable = claudeConfig.command.replace("${__dirname}", extensionDirectory);
  const binary = await archive.file(manifest.server.entry_point).async("nodebuffer");
  await mkdir(dirname(claudeExecutable), { recursive: true });
  await writeFile(claudeExecutable, binary);

  const pluginRoot = join(install, "Orion-Codex-Plugin");
  const marketplace = JSON.parse(await readFile(join(pluginRoot, ".agents", "plugins", "marketplace.json"), "utf8"));
  const plugin = marketplace.plugins.find((entry) => entry.name === "orion");
  assert.equal(plugin.source.path, "./plugins/orion");
  const pluginDirectory = join(pluginRoot, plugin.source.path);
  const codexConfig = JSON.parse(await readFile(join(pluginDirectory, ".mcp.json"), "utf8")).mcpServers.orion;
  assert.deepEqual(codexConfig, { command: "./server/orion-mcp.exe", args: [], cwd: "." });
  const codexExecutable = join(pluginDirectory, codexConfig.command);
  assert((await readFile(codexExecutable)).equals(binary), "Both packages must contain the same verified MCP executable");

  const env = { ...process.env };
  delete env.ORION_VAULT_PATH;
  function tool(program, args, cwd) {
    return (name, arguments_ = {}, { error = false } = {}) => {
      const requests = [
        { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Orion installer smoke", version: "1" } } },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/call", params: { name, arguments: arguments_ } },
      ];
      const input = requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request }) + "\n").join("");
      const output = execFileSync(program, args, { cwd, env, input, timeout: 12_000, windowsHide: true, encoding: "utf8" });
      const responses = output.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(responses.length, 2);
      assert.equal(responses[0].result?.serverInfo.name, "orion");
      const response = responses[1];
      assert.equal(response.id, 2);
      assert.ifError(response.error);
      assert.equal(Boolean(response.result.isError), error, JSON.stringify(response.result));
      return response.result.structuredContent;
    };
  }
  return {
    claude: tool(claudeExecutable, claudeConfig.args ?? [], extensionDirectory),
    codex: tool(codexExecutable, codexConfig.args, join(pluginDirectory, codexConfig.cwd)),
  };
}

async function assertPipeRequiresToken() {
  const descriptor = JSON.parse(await readFile(join(dirname(vaultPath), "assistant-bridge.json"), "utf8"));
  const reply = await new Promise((resolve, reject) => {
    const stream = createConnection(descriptor.socket_path);
    let response = "";
    stream.setEncoding("utf8");
    stream.setTimeout(5_000, () => stream.destroy(new Error("Timed out waiting for a pipe response")));
    stream.once("error", reject);
    stream.once("close", () => reject(new Error("The pipe closed before sending a response")));
    stream.once("connect", () => stream.write(JSON.stringify({
      version: 1, token: "0".repeat(64), method: "capabilities", arguments: {},
    }) + "\n"));
    stream.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) {
        resolve(response);
        stream.destroy();
      }
    });
  });
  assert.equal(JSON.parse(reply).error.code, "unauthorized");
}

function scannedPdf(jpeg, width, height) {
  const draw = `q ${width} 0 0 ${height} 0 0 cm /Scan Do Q\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>`,
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      Buffer.from("\nendstream"),
    ]),
    `<< /Length ${draw.length} >>\nstream\n${draw}endstream`,
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  let length = chunks[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(length);
    const data = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n")]);
    length += data.length;
    chunks.push(data);
  }
  chunks.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

try {
  await stat(executable);
  await assert.rejects(stat(vaultPath), { code: "ENOENT" }, "The smoke test must start with a fresh vault");
  await launch();
  const setup = await invoke("transcription_setup_status");
  assert(setup.whisperAvailable, JSON.stringify(setup));
  assert.match(setup.whisperVersion, /1\.9\.1/);
  console.log("Installed Orion launched and the bundled Whisper runtime is available.");
  const aac = await readFile("src-tauri/tests/fixtures/windows-transcription-jfk.m4a");
  const transcript = await invoke("transcribe_voice_memo", {
    request: {
      fileName: "voice-memo.m4a",
      mimeType: "audio/mp4",
      base64Data: aac.toString("base64"),
    },
    config: { language: "en" },
  });
  assert.match(transcript.text, /what you can do for your country/i);
  console.log("Transcribed a real AAC recording through the installed app.");

  const fixtureKey = `orion-ci-test-${randomUUID()}`;
  assert.equal((await invoke("api_key_status")).configured, false);
  try {
    await invoke("save_api_key", { apiKey: fixtureKey });
    assert.equal((await invoke("api_key_status")).configured, true);
  } finally {
    await invoke("delete_api_key");
  }
  assert.equal((await invoke("api_key_status")).configured, false);
  console.log("Windows Credential Manager round trip passed.");

  await page.keyboard.press("Control+n");
  await page.getByRole("textbox", { name: "Note title" }).fill(title);
  const editor = page.getByRole("textbox", { name: "Note body" });
  await editor.fill(body);
  await eventually(async () => (await vault()).spaces[0].notes.some((note) => note.title === title && note.body.includes(body)), "note autosave");

  const fixtures = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1100;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000";
    ctx.font = "58px Arial";
    ctx.fillText("Orion reads this local scan.", 36, 144);
    return {
      png: canvas.toDataURL("image/png").split(",")[1],
      jpeg: canvas.toDataURL("image/jpeg", 0.94).split(",")[1],
      width: canvas.width,
      height: canvas.height,
    };
  });

  await editor.evaluate((element, png) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "windows-image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, fixtures.png);
  await page.waitForFunction(() => [...document.querySelectorAll(".editor-prose img")].some((img) =>
    img.src.startsWith("http://orion-image.localhost/") && img.complete && img.naturalWidth > 0,
  ));
  await eventually(async () => (await vault()).spaces[0].notes.some((note) => note.body.includes("orion-image://localhost/")), "portable image URL persisted");

  await page.keyboard.press("Control+Shift+i");
  const importDialog = page.getByRole("dialog", { name: "Import", exact: true });
  const pdf = scannedPdf(Buffer.from(fixtures.jpeg, "base64"), fixtures.width, fixtures.height);
  await importDialog.locator('input[type="file"]').first().setInputFiles([
    { name: "windows-scan.png", mimeType: "image/png", buffer: Buffer.from(fixtures.png, "base64") },
    { name: "windows-scan.pdf", mimeType: "application/pdf", buffer: pdf },
  ]);
  try {
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".import-studio__queue-item")];
      return rows.length === 2 && rows.every((row) => !row.querySelector(".import-studio__spinner"));
    }, null, { timeout: 90_000 });
    assert.equal(await importDialog.locator(".import-studio__queue-item--error").count(), 0);
    await importDialog.getByRole("button", { name: "Review sources" }).click();
    await importDialog.getByRole("button", { name: "Create notes" }).click();
    await importDialog.getByRole("button", { name: "Add to Orion" }).click();
    await eventually(async () => (await vault()).spaces[0].sources.filter((source) =>
      /Orion reads this local scan/i.test(JSON.stringify(source)),
    ).length === 2, "PNG and scanned PDF preserved as recognized sources");
  } catch (error) {
    console.error(await importDialog.innerText().catch(() => ""));
    throw error;
  }
  console.log("Verified note autosave, managed image rendering and offline OCR for PNG and scanned PDF.");

  const extensionDirectory = await mkdtemp(join(process.env.RUNNER_TEMP, "Orion Claude Extension "));
  let noteCitation;
  try {
    const { claude, codex } = await installedConnectors(extensionDirectory);
    const { activeSpaceId: spaceId, spaces } = await vault();
    const noteId = spaces[0].notes.find((note) => note.title === title).id;
    for (const call of [claude, codex]) {
      assert.equal(call("orion_list_spaces").activeSpaceId, spaceId);
      const note = call("orion_get_note", { space_id: spaceId, note_id: noteId }).note;
      assert(note.body.includes(body));
      assert.match(note.orionUrl, /^orion:\/\//);
      noteCitation = note.orionUrl;
    }
    const contextRequest = { space_id: spaceId, request_id: "windows-smoke-context", query: "phrase saved", note_ids: [noteId] };
    claude("orion_get_context", contextRequest, { error: true });

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    assert(await page.getByRole("button", { name: "Install in Claude" }).isEnabled());
    assert(await page.getByRole("button", { name: "Install in Codex" }).isEnabled());
    await page.getByRole("checkbox", { name: /Enable desktop workflows/ }).check();
    await page.locator(".assistant-spaces input").first().check();
    await eventually(() => {
      const capabilities = codex("orion_get_capabilities");
      assert(capabilities.workflowExecutorAvailable, capabilities.instruction ?? "The Orion workflow executor is unavailable");
      return capabilities.access.spaceIds.includes(spaceId);
    }, "approved desktop workflow over the named pipe");
    assert.equal(claude("orion_get_capabilities").access.allowAI, false);
    await assertPipeRequiresToken();
    const started = claude("orion_get_context", contextRequest);
    const completed = await eventually(() => {
      const job = codex("orion_get_job", { space_id: spaceId, job_id: started.id });
      return ["succeeded", "failed", "cancelled"].includes(job.state) ? job : undefined;
    }, "renderer completion of the connector context request");
    assert.equal(completed.state, "succeeded", completed.error);
    assert.equal(completed.result.providerCalls, 0);
    assert(completed.result.evidence.some((item) => item.entityId === noteId
      && item.passages.some((passage) => passage.text.includes(body))));

    await closeAndWait();
    assert.equal(codex("orion_get_capabilities").available, false);
    const created = claude("orion_create_note", { space_id: spaceId, title: "Windows connector smoke note", body });
    const reread = codex("orion_get_note", { space_id: spaceId, note_id: created.note.id });
    assert.equal(reread.note.body, body);
    assert.match(reread.note.orionUrl, /^orion:\/\//);
    codex("orion_delete_note", { space_id: spaceId, note_id: created.note.id });
    console.log("Verified the installed Claude and Codex packages, zero-configuration discovery, direct note writes, and authenticated Space-scoped workflows.");
  } finally {
    await rm(extensionDirectory, { recursive: true, force: true });
  }
  await launch();
  execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Process -FilePath $env:ORION_SMOKE_CITATION"], {
    env: { ...process.env, ORION_SMOKE_CITATION: noteCitation },
    timeout: 10_000,
  });
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
  await page.waitForFunction((text) => document.querySelector("article .note-prose")?.textContent.includes(text), body);
  await page.getByRole("button", { name: "Open in writing window" }).click();
  const writingPage = await eventually(() => browser.contexts().flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("view=writing")), "detached writing window");
  await writingPage.getByRole("textbox", { name: "Note body" }).waitFor();
  assert.match(await writingPage.getByRole("textbox", { name: "Note body" }).innerText(), /phrase saved/);
  assert.equal(await writingPage.getByRole("navigation", { name: "Workspace" }).count(), 0);
  assert(!JSON.stringify(await vault()).includes(fixtureKey), "A credential must never be written to the vault");
  assert.deepEqual(pageErrors, []);
  console.log("Verified native close, Windows citation activation, and detached writing window.");
} catch (error) {
  if (app && !page && app.exitCode === null) {
    const processState = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process -Id ${app.pid} | Select-Object Id, MainWindowHandle, MainWindowTitle, Responding | Format-List; Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Select-Object Id, SessionId | Format-Table`,
    ], { encoding: "utf8" });
    console.error(processState.trim());
  }
  if (page) {
    console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 4000));
    await page.screenshot({ path: join(process.env.RUNNER_TEMP, "orion-smoke-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app && app.exitCode === null) app.kill();
  await browser?.close().catch(() => {});
}
