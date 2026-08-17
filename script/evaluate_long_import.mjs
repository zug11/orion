#!/usr/bin/env node

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const help = args.includes("--help") || args.includes("-h");
const positional = args.filter((argument) => !argument.startsWith("--"));
const pdfPath = positional[0];

if (help || !pdfPath) {
  console.log(`Usage: npm run eval:long-import -- <pdf-path> [--compliant] [--vision]

By default the deterministic provider fixture deliberately returns:
  - one incomplete source reading, exercising adaptive range splitting;
  - two invalid writing plans, exercising the local synthesis planner; and
  - two invalid responses from one writer, exercising correction and grounded recovery.

Pass --compliant to run the same PDF through an entirely compliant fixture.
Pass --vision to build/use Orion's bundled Vision helper and exercise the
page-selective OCR roundtrip before the deterministic import evaluation.
No provider key, network request, or absolute fixture path is stored.`);
  process.exit(help ? 0 : 1);
}

const invocationDirectory = process.cwd();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const absolutePdfPath = resolve(invocationDirectory, pdfPath);
let fixtureStat;
try {
  fixtureStat = statSync(absolutePdfPath);
} catch {
  console.error(`Long-import fixture not found: ${absolutePdfPath}`);
  process.exit(1);
}
if (!fixtureStat.isFile() || !absolutePdfPath.toLowerCase().endsWith(".pdf")) {
  console.error("The long-import fixture must be a readable PDF file.");
  process.exit(1);
}

const vitestEntry = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const visionRuntime = resolve(
  repositoryRoot,
  "src-tauri/binaries/orion-ocr-aarch64-apple-darwin",
);
const result = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "script/evaluate_long_import.test.ts",
    "--reporter=verbose",
    `--testTimeout=${args.includes("--vision") ? "300000" : "120000"}`,
  ],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ORION_LONG_IMPORT_EVAL_PDF: absolutePdfPath,
      ORION_LONG_IMPORT_EVAL_MODE: args.includes("--compliant")
        ? "compliant"
        : "recovery",
      ...(args.includes("--vision")
        ? { ORION_LONG_IMPORT_EVAL_OCR_RUNTIME: visionRuntime }
        : {}),
    },
    stdio: "inherit",
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
