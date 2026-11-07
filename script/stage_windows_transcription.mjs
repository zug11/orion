// Called by the Windows Tauri build. Nothing is downloaded at runtime.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";

const root = fileURLToPath(new URL("..", import.meta.url));
const resources = join(root, "src-tauri/resources");
const destination = join(resources, "windows-transcription");
const model = join(resources, "models/ggml-small.bin");
const modelHash = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
const zipHash = "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539";
const temporary = await mkdtemp(join(tmpdir(), "orion-build-"));

async function checkHash(path, expected) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest("hex") !== expected) throw new Error(`SHA-256 did not match for ${path}`);
}

async function download(url, path, length, hash) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Build input download failed: ${response.status} (${new URL(url).hostname})`);
  let received = 0;
  const bound = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      done(received > length ? new Error("Build input exceeded its pinned size.") : null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(path, { flags: "wx" }));
  if (received !== length) throw new Error("Build input did not match its pinned size.");
  await checkHash(path, hash);
}

try {
  const modelSize = 487_601_967;
  if ((await stat(model).catch(() => null))?.size !== modelSize) {
    const stagedModel = join(temporary, "ggml-small.bin");
    await download("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", stagedModel, modelSize, modelHash);
    // The repository and system temporary folder can be on different drives.
    await copyFile(stagedModel, model);
  }
  await checkHash(model, modelHash);

  const archive = join(temporary, "whisper-bin-x64.zip");
  await download("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip", archive, 7_982_101, zipHash);
  const files = await JSZip.loadAsync(await readFile(archive));
  await rm(destination, { force: true, recursive: true });
  await mkdir(destination);
  const runtime = files.file(/^Release\/(?:whisper-cli\.exe|whisper\.dll|ggml[\w-]*\.dll)$/);
  if (runtime.length < 5) throw new Error("The Windows Whisper runtime is incomplete.");
  for (const file of runtime) {
    await writeFile(join(destination, file.name.slice("Release/".length)), await file.async("nodebuffer"));
  }
  for (const [source, name] of [
    ["src-tauri/resources/licenses/whisper.cpp-LICENSE", "whisper.cpp-LICENSE"],
    ["src-tauri/resources/licenses/openai-whisper-LICENSE", "openai-whisper-LICENSE"],
    ["node_modules/tesseract.js/LICENSE.md", "tesseract.js-LICENSE"],
    ["node_modules/tesseract.js-core/LICENSE", "tesseract.js-core-LICENSE"],
    ["docs/windows-third-party.md", "THIRD-PARTY.md"],
  ]) {
    await copyFile(join(root, source), join(destination, name));
  }
  if (process.platform === "win32") {
    const version = execFileSync(join(destination, "whisper-cli.exe"), ["--version"], { encoding: "utf8", windowsHide: true });
    if (!version.includes("1.9.1")) throw new Error("The staged Windows Whisper runtime could not start.");
    console.log(version.trim());
  }
} finally {
  await rm(temporary, { force: true, recursive: true });
}
