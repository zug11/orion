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
  it("disables only starting another recording, preserving Stop and Use original", async () => {
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onComplete = vi.fn(async (_id, _text, options) => {
      options.onPhase("cleaning");
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const props = { noteId: "note-one", onTranscribe: vi.fn().mockResolvedValue("Raw transcript."), onComplete };
    const view = render(<VoiceMemoButton {...props} disabled/>);
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    expect(getUserMedia).not.toHaveBeenCalled();
    view.rerender(<VoiceMemoButton {...props}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await screen.findByRole("button", { name: /Stop dictation/ });
    view.rerender(<VoiceMemoButton {...props} disabled/>);
    expect(screen.getByRole("button", { name: /Stop dictation/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Stop dictation/ }));
    expect(await screen.findByRole("button", { name: "Use original dictation" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use original dictation" }));
    expect(await screen.findByRole("button", { name: "Start dictation" })).toBeDisabled();
  });
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

  it("drains queued segments in order before completing once after rapid Stop clicks", async () => {
    vi.useFakeTimers();
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    let finishFirst!: (text: string) => void;
    const onTranscribe = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("Final passage.");
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onSessionEnd = vi.fn();
    render(<VoiceMemoButton noteId="queued" onTranscribe={onTranscribe} onComplete={onComplete} onSessionEnd={onSessionEnd}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start dictation" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_MEMO_SEGMENT_MS * 2); });
    expect(FakeMediaRecorder.instances).toHaveLength(3);
    expect(onTranscribe).toHaveBeenCalledTimes(1);
    const stop = screen.getByRole("button", { name: /Stop dictation/ });
    act(() => { fireEvent.click(stop); fireEvent.click(stop); });
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => { finishFirst("First passage."); });
    expect(onTranscribe).toHaveBeenCalledTimes(3);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][1]).toBe("First passage. Final passage.");
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("preserves successful segments without AI after a later transcription failure and reports missing speech", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onTranscribe = vi.fn()
      .mockResolvedValueOnce("Keep this completed passage.")
      .mockRejectedValueOnce(new Error("Whisper worker stopped."));
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const onSessionEnd = vi.fn();
    render(<VoiceMemoButton noteId="partial" onTranscribe={onTranscribe} onComplete={onComplete} onSessionEnd={onSessionEnd}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start dictation" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_MEMO_SEGMENT_MS); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Stop dictation/ })); });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][1]).toBe("Keep this completed passage.");
    expect(onComplete.mock.calls[0][2].signal.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(/recording incomplete/i);
    expect(screen.getByRole("status")).toHaveTextContent(/Whisper worker stopped/);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeEnabled();
  });
});

describe("VoiceMemoButton leaving its note", () => {
  function microphone() {
    const stopTrack = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    return stopTrack;
  }

  async function outcomes() {
    const { onDetachedDictation } = await import("../lib/dictationOutcome");
    const seen: unknown[] = [];
    const stop = onDetachedDictation((outcome) => seen.push(outcome));
    return { seen, stop };
  }

  it("finishes transcribing and archives the original instead of discarding the recording", async () => {
    const { DictationNotInsertedError } = await import("../lib/dictationCleanup");
    const stopTrack = microphone();
    const { seen, stop } = await outcomes();
    const onTranscribe = vi.fn().mockResolvedValue("Ten minutes of thinking aloud.");
    // The editor archives the original, then refuses to insert into a note that is gone.
    const onComplete = vi.fn(async (_id: string, _text: string, _options: { signal: AbortSignal }) => { throw new DictationNotInsertedError("This note changed, so dictation was not inserted. Its original is saved in Sources.", "source-dictation-1"); });
    const onSessionEnd = vi.fn();
    const view = render(<VoiceMemoButton noteId="note-one" onTranscribe={onTranscribe} onComplete={onComplete} onSessionEnd={onSessionEnd}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await screen.findByRole("button", { name: /Stop dictation/ });

    view.unmount();

    await waitFor(() => expect(onSessionEnd).toHaveBeenCalledTimes(1));
    // The microphone is released at once and the audio recorded so far is kept.
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onTranscribe).toHaveBeenCalledTimes(1);
    expect(onTranscribe.mock.calls[0][0]).toMatchObject({ size: 3, type: "audio/mp4" });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][1]).toBe("Ten minutes of thinking aloud.");
    // Nothing will be inserted, so no AI cleanup is requested either.
    expect(onComplete.mock.calls[0][2].signal.aborted).toBe(true);
    expect(seen).toEqual([{ saved: true }]);
    stop();
  });

  it("keeps the leaving note's callbacks and gives the next note a clean, independent button", async () => {
    vi.useFakeTimers();
    microphone();
    const { seen, stop } = await outcomes();
    let finishFirst!: (text: string) => void;
    const first = {
      onTranscribe: vi.fn()
        .mockImplementationOnce(() => new Promise<string>((resolve) => { finishFirst = resolve; }))
        .mockResolvedValueOnce("and the rest."),
      onComplete: vi.fn().mockResolvedValue(undefined),
      onSessionEnd: vi.fn(),
    };
    const second = { onTranscribe: vi.fn().mockResolvedValue("Second note."), onComplete: vi.fn().mockResolvedValue(undefined), onSessionEnd: vi.fn() };
    const view = render(<VoiceMemoButton noteId="note-one" {...first}/>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start dictation" })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(VOICE_MEMO_SEGMENT_MS); });
    expect(first.onTranscribe).toHaveBeenCalledTimes(1);

    // The same editor now shows another note, with that note's callbacks.
    await act(async () => { view.rerender(<VoiceMemoButton noteId="note-two" {...second}/>); });
    const start = screen.getByRole("button", { name: "Start dictation" });
    expect(start).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // The new note can record while the first recording is still finishing.
    await act(async () => { fireEvent.click(start); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Stop dictation/ })); });
    expect(second.onComplete).toHaveBeenCalledTimes(1);
    expect(second.onComplete.mock.calls[0][1]).toBe("Second note.");
    expect(second.onComplete.mock.calls[0][2].signal.aborted).toBe(false);
    expect(first.onComplete).not.toHaveBeenCalled();

    await act(async () => { finishFirst("The first half,"); });
    expect(first.onTranscribe).toHaveBeenCalledTimes(2);
    expect(second.onTranscribe).toHaveBeenCalledTimes(1);
    expect(first.onComplete).toHaveBeenCalledTimes(1);
    expect(first.onComplete.mock.calls[0][1]).toBe("The first half, and the rest.");
    expect(first.onSessionEnd).toHaveBeenCalledTimes(1);
    expect(second.onSessionEnd).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ saved: true }]);
    expect(screen.getByRole("button", { name: "Start dictation" })).toBeEnabled();
    stop();
  });

  it("reports a recording that could not be saved after its note was left", async () => {
    microphone();
    const { seen, stop } = await outcomes();
    const onSessionEnd = vi.fn();
    const view = render(<VoiceMemoButton noteId="note-one" onTranscribe={vi.fn().mockRejectedValue(new Error("Whisper worker stopped."))} onComplete={vi.fn()} onSessionEnd={onSessionEnd}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await screen.findByRole("button", { name: /Stop dictation/ });
    view.unmount();
    await waitFor(() => expect(onSessionEnd).toHaveBeenCalledTimes(1));
    expect(seen).toEqual([{ saved: false, message: "Whisper worker stopped." }]);

    // An archive that fails is reported too, never swallowed.
    const failing = render(<VoiceMemoButton noteId="note-two" onTranscribe={vi.fn().mockResolvedValue("Spoken.")} onComplete={vi.fn().mockRejectedValue(new Error("This note changed before dictation could be inserted."))}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await screen.findByRole("button", { name: /Stop dictation/ });
    failing.unmount();
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toEqual({ saved: false, message: "This note changed before dictation could be inserted." });
    stop();
  });

  it("releases a microphone that is granted only after the note was left", async () => {
    const stopTrack = vi.fn();
    let grant!: (stream: unknown) => void;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
      getUserMedia: vi.fn(() => new Promise((resolve) => { grant = resolve; })),
    } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const onSessionStart = vi.fn();
    const view = render(<VoiceMemoButton noteId="note-one" onSessionStart={onSessionStart} onTranscribe={vi.fn()} onComplete={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    view.unmount();
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }); });
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(onSessionStart).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });
});
