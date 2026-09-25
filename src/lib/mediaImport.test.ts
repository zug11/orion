// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { transcribeMediaFiles, transcribeYouTube } from "./storage";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const transcript = { title: "Good recording", fileName: "good.m4a", mimeType: "audio/mp4", byteSize: 100, text: "Useful spoken evidence.", warnings: [] };

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("retains successful files alongside a failed sibling", async () => {
  invoke.mockResolvedValue({ transcripts: [transcript], failures: [{ fileName: "broken.m4a", error: "No readable audio track." }] });
  const batch = await transcribeMediaFiles({ language: "en" });
  expect(batch.transcripts).toEqual([transcript]);
  expect(batch.failures[0].fileName).toBe("broken.m4a");
  expect(invoke).toHaveBeenCalledWith("transcribe_media_files", { config: { language: "en" }, requestId: expect.stringMatching(/^media_/) });
});

it("cancels the exact native job and rejects its late transcript", async () => {
  let complete!: (value: unknown) => void;
  invoke.mockImplementation((command: string) => command === "transcribe_youtube"
    ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve());
  const controller = new AbortController();
  const pending = transcribeYouTube("https://youtu.be/abcdefghijk", {}, controller.signal);
  const rejected = expect(pending).rejects.toThrow("Stopped by user");
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("transcribe_youtube", expect.anything()));
  const requestId = invoke.mock.calls[0][1].requestId;
  controller.abort(new Error("Stopped by user"));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cancel_media_import", { requestId }));
  complete(transcript);
  await rejected;
});

it("does not start a pre-cancelled request and rejects malformed batch errors", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Already stopped"));
  await expect(transcribeMediaFiles({}, [], controller.signal)).rejects.toThrow("Already stopped");
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValue({ transcripts: [transcript], failures: [{ fileName: "bad.m4a", error: 42 }] });
  await expect(transcribeMediaFiles({})).rejects.toThrow("invalid media transcription result");
});
