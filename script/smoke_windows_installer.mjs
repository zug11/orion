// Run against the installed production WebView2 app, on an ephemeral CI user.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

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
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
      WEBVIEW2_USER_DATA_FOLDER: join(process.env.RUNNER_TEMP, "Orion-WebView2"),
    },
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

  await closeAndWait();
  const context = await launch();
  await page.getByRole("button", { name: `Open ${title}` }).click();
  await page.getByText(body, { exact: true }).waitFor();
  const writing = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open in writing window" }).click();
  const writingPage = await writing;
  await writingPage.getByRole("textbox", { name: "Note body" }).waitFor();
  assert.match(await writingPage.getByRole("textbox", { name: "Note body" }).innerText(), /phrase saved/);
  assert.equal(await writingPage.getByRole("navigation", { name: "Workspace" }).count(), 0);
  assert(!JSON.stringify(await vault()).includes(fixtureKey), "A credential must never be written to the vault");
  assert.deepEqual(pageErrors, []);
  console.log("Verified native close, reopen, and detached writing window.");
} catch (error) {
  if (page) {
    console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 4000));
    await page.screenshot({ path: join(process.env.RUNNER_TEMP, "orion-smoke-failure.png") }).catch(() => {});
  }
  throw error;
} finally {
  if (app && app.exitCode === null) app.kill();
  await browser?.close().catch(() => {});
}
