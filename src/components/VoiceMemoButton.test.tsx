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
    await screen.findByText("Inserted");
    expect(stopTrack).toHaveBeenCalledTimes(1);
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
