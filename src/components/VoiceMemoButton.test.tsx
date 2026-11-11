// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoiceMemoButton,
  VOICE_MEMO_SEGMENT_MS,
} from "./VoiceMemoButton";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported(type: string) {
    return type.startsWith("audio/mp4");
  }

  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(
    _stream: MediaStream,
    _options?: MediaRecorderOptions,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
    } as BlobEvent);
    this.onstop?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
});

describe("VoiceMemoButton", () => {
  it("offers Use original only during cleanup, cancels that wait and keeps recording released", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onComplete = vi.fn(async (_id, _text, options) => {
      options.onPhase("cleaning");
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      return "Original dictation inserted.";
    });
    const onSessionEnd = vi.fn();
    render(<VoiceMemoButton noteId="note-one" onTranscribe={vi.fn().mockResolvedValue("Maybe Friday, or Thursday.")} onComplete={onComplete} onSessionEnd={onSessionEnd}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop dictation/ }));
    const skip = await screen.findByRole("button", { name: "Use original dictation" });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(skip).toBeEnabled();
    expect(skip).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(skip);
    expect(await screen.findByRole("button", { name: "Start dictation" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][2].signal.aborted).toBe(true);
  });

  it("aborts pending cleanup and releases its session when the note unmounts", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    let cleanupSignal: AbortSignal | undefined;
    const onComplete = vi.fn(async (_id, _text, options) => {
      cleanupSignal = options.signal;
      options.onPhase("cleaning");
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const end = vi.fn();
    const view = render(<VoiceMemoButton noteId="note-one" onTranscribe={vi.fn().mockResolvedValue("Raw text.")} onComplete={onComplete} onSessionEnd={end}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop dictation/ }));
    await screen.findByRole("button", { name: "Use original dictation" });
    view.unmount();
    expect(cleanupSignal?.aborted).toBe(true);
    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
  });

  it("records, stops, and submits one temporary audio blob", async () => {
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onTranscribe = vi.fn().mockResolvedValue("Spoken note.");
    const onComplete = vi.fn().mockResolvedValue(undefined);

    render(
      <VoiceMemoButton
        noteId="note-one"
        onTranscribe={onTranscribe}
        onComplete={onComplete}
      />,
    );
    const startButton = screen.getByRole("button", {
      name: "Start dictation",
    });
    expect(fireEvent.mouseDown(startButton)).toBe(false);
    fireEvent.click(startButton);

    const stopButton = await screen.findByRole("button", {
      name: /Stop dictation/,
    });
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ audio: expect.any(Object), video: false }),
    );
    fireEvent.click(stopButton);

    await waitFor(() => expect(onTranscribe).toHaveBeenCalledTimes(1));
    expect(onTranscribe.mock.calls[0]?.[0]).toMatchObject({
      size: 3,
      type: "audio/mp4",
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0]?.[1]).toBe("Spoken note.");
    expect(await screen.findByRole("button", { name: "Start dictation" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("keeps finishing, recovery saving and cleanup quiet, then allows another recording immediately", async () => {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    let finishTranscription!: (text: string) => void;
    let finishSaving!: () => void;
    let finishCleanup!: () => void;
    const onTranscribe = vi.fn(() => new Promise<string>(resolve => { finishTranscription = resolve; }));
    const onComplete = vi.fn(async (_id, _text, options) => {
      options.onPhase("saving");
      await new Promise<void>(resolve => { finishSaving = resolve; });
      options.onPhase("cleaning");
      await new Promise<void>(resolve => { finishCleanup = resolve; });
      return "Dictation cleaned up and inserted. Original saved.";
    });
    render(<VoiceMemoButton noteId="note-one" onTranscribe={onTranscribe} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop dictation/ }));
    await waitFor(() => expect(onTranscribe).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Finishing dictation transcription" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    await act(async () => { finishTranscription("Friday, actually Thursday."); });
    expect(screen.getByRole("button", { name: "Saving original dictation" })).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => { finishSaving(); });
    expect(screen.getByRole("button", { name: "Use original dictation" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => { finishCleanup(); });
    const start = screen.getByRole("button", { name: "Start dictation" });
    expect(start).toBeEnabled();
    expect(start).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(start);
    expect(await screen.findByRole("button", { name: /Stop dictation/ })).toBeEnabled();
  });

  it("keeps actionable recording failures visible", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    render(<VoiceMemoButton noteId="note-one" onTranscribe={vi.fn()} onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Microphone access was denied.");
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeEnabled();
  });

  it("rotates bounded segments and keeps recording without a duration cap", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopTrack }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onSessionStart = vi.fn();
    const onTranscribe = vi
      .fn()
      .mockResolvedValueOnce("First passage.")
      .mockResolvedValueOnce("Second passage.");
    const onComplete = vi.fn().mockResolvedValue(undefined);

    render(
      <VoiceMemoButton
        noteId="note-long"
        onSessionStart={onSessionStart}
        onTranscribe={onTranscribe}
        onComplete={onComplete}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(VOICE_MEMO_SEGMENT_MS);
    });

    expect(onTranscribe).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: /Stop dictation/ }),
    ).toBeEnabled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Stop dictation/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onTranscribe).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[1]).toBe(
      "First passage. Second passage.",
    );
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
