import { createWorker, OEM, type Worker } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import corePath from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import englishPath from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import type { RecognizedDocumentText } from "../types";

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_DIMENSION = 2400;
const MAX_PAGE_TEXT = 100_000;
const MAX_TEXT = 1_000_000;

// Share a single slot: the import queue can submit several documents at once.
let pending: Promise<unknown> = Promise.resolve();

export function recognizeWindowsDocument(
  file: File,
  mimeType: string,
  requestedPages?: readonly number[],
): Promise<RecognizedDocumentText> {
  const work = pending.then(() => recognize(file, mimeType, requestedPages));
  pending = work.catch(() => undefined);
  return work;
}

async function recognize(
  file: File,
  mimeType: string,
  requestedPages?: readonly number[],
): Promise<RecognizedDocumentText> {
  if (!file.size || file.size > MAX_BYTES) throw new Error("Choose a nonempty document up to 25 MB for text recognition.");
  if (mimeType !== "application/pdf" && mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new Error("Text recognition on Windows supports PNG, JPEG, and PDF. Convert HEIC or HEIF images to PNG or JPEG first.");
  }
  const response = await fetch(englishPath);
  if (!response.ok) throw new Error("Orion's bundled English text recognition model could not load.");
  const model = new Uint8Array(await response.arrayBuffer());
  let worker: Worker | undefined;
  let timedOut = false;
  let failWorker: (reason: Error) => void = () => {};
  const failed = new Promise<never>((_resolve, reject) => { failWorker = reject; });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    failWorker(new Error("Text recognition reached its time limit. Try fewer pages."));
  }, 10 * 60_000);
  try {
    const starting = createWorker([{ code: "eng", data: model }], OEM.LSTM_ONLY, {
      corePath,
      workerPath,
      workerBlobURL: false,
      cacheMethod: "none",
      errorHandler: () => failWorker(new Error("Orion's local text recognition worker could not finish.")),
    });
    // The library exposes terminate only once initialization succeeds.
    void starting.then((ready) => { if (timedOut) void ready.terminate(); }).catch(() => undefined);
    worker = await Promise.race([starting, failed]);
    const read = async (canvas: HTMLCanvasElement) => {
      const result = await Promise.race([worker!.recognize(canvas), failed]);
      const text = result.data.text.trim();
      if (text.length > MAX_PAGE_TEXT) throw new Error("A page contains too much recognized text.");
      return text;
    };
    const pages = mimeType === "application/pdf"
      ? await recognizePdf(file, read, requestedPages)
      : [{ pageNumber: 1, text: await recognizeImage(file, read) }];
    const text = pages.map((page) => page.text).filter(Boolean).join("\n\n");
    if (!text) throw new Error("No readable text was found in this document.");
    if (text.length > MAX_TEXT) throw new Error("This document contains too much recognized text.");
    return {
      text,
      pageCount: pages.length,
      pages,
      warnings: pages.filter((page) => !page.text).map((page) => `No text was recognized on page ${page.pageNumber}.`),
    };
  } finally {
    window.clearTimeout(timeout);
    await worker?.terminate();
  }
}

type ReadCanvas = (canvas: HTMLCanvasElement) => Promise<string>;

async function recognizeImage(file: File, read: ReadCanvas): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_DIMENSION / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Orion could not prepare this image for recognition.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await read(canvas);
  } finally {
    image.close();
  }
}

async function recognizePdf(file: File, read: ReadCanvas, requestedPages?: readonly number[]) {
  const { openImportPdf } = await import("./files");
  const task = await openImportPdf(file);
  try {
    const pdf = await task.promise;
    const numbers = requestedPages ?? Array.from({ length: Math.min(pdf.numPages, MAX_PAGES + 1) }, (_, i) => i + 1);
    if (!numbers.length || numbers.length > MAX_PAGES || numbers.some((number, index) =>
      !Number.isInteger(number) || number < 1 || number > pdf.numPages || (index > 0 && number <= numbers[index - 1])
    )) {
      throw new Error(`Choose up to ${MAX_PAGES} valid pages for text recognition.`);
    }
    const pages: RecognizedDocumentText["pages"] = [];
    const canvas = document.createElement("canvas");
    let totalCharacters = 0;
    for (const pageNumber of numbers) {
      const page = await pdf.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, MAX_DIMENSION / Math.max(base.width, base.height));
        if (!Number.isFinite(scale) || scale <= 0) throw new Error("The PDF page size is invalid.");
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        await page.render({ canvas, viewport }).promise;
        const text = await read(canvas);
        totalCharacters += text.length;
        if (totalCharacters > MAX_TEXT) throw new Error("This document contains too much recognized text.");
        pages.push({ pageNumber, text });
      } finally {
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
