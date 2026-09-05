import {
  useEffect,
  useRef,
  useState,
} from "react";
import { LoaderCircle, Mic2, Square } from "../lib/icons";
import {
  MAX_VOICE_MEMO_BYTES,
  mergeVoiceTranscriptParts,
  VOICE_MEMO_SEGMENT_MS,
} from "../lib/transcription";

const MIME_TYPES = [
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
] as const;

export { VOICE_MEMO_SEGMENT_MS } from "../lib/transcription";

type VoiceMemoPhase = "idle" | "recording" | "transcribing" | "inserted";

interface VoiceMemoButtonProps {
  noteId: string;
  onSessionStart?: (sessionId: string) => Promise<void> | void;
  onSessionEnd?: (sessionId: string) => Promise<void> | void;
  onTranscribe: (audio: Blob, sessionId: string) => Promise<string>;
  onComplete: (sessionId: string, transcript: string) => Promise<void>;
}

function supportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

function recordingErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Allow Orion in System Settings → Privacy & Security → Microphone.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "No microphone is available.";
  }
  return error instanceof Error ? error.message : String(error);
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceMemoButton({
  noteId,
  onSessionStart,
  onSessionEnd,
  onTranscribe,
  onComplete,
}: VoiceMemoButtonProps) {
  const [phase, setPhase] = useState<VoiceMemoPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingSegments, setPendingSegments] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionPreparationRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const sequenceRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const finishingRef = useRef(false);
  const sessionEndedRef = useRef(false);
  const failureRef = useRef<unknown>(null);
  const transcriptsRef = useRef<string[]>([]);
  const transcriptionChainRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSegmentsRef = useRef(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);
  const onSessionStartRef = useRef(onSessionStart);
  const onSessionEndRef = useRef(onSessionEnd);
  const onTranscribeRef = useRef(onTranscribe);
  const onCompleteRef = useRef(onComplete);
  onSessionStartRef.current = onSessionStart;
  onSessionEndRef.current = onSessionEnd;
  onTranscribeRef.current = onTranscribe;
  onCompleteRef.current = onComplete;

  function clearElapsedTimer() {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  function clearSegmentTimer() {
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  }

  function clearResetTimer() {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }

  function clearTimers() {
    clearElapsedTimer();
    clearSegmentTimer();
    clearResetTimer();
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function updatePendingSegments(delta: number, generation: number) {
    pendingSegmentsRef.current = Math.max(0, pendingSegmentsRef.current + delta);
    if (generationRef.current === generation) {
      setPendingSegments(pendingSegmentsRef.current);
    }
  }

  function requestStop() {
    stopRequestedRef.current = true;
    clearSegmentTimer();
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  }

  function endSession() {
    if (sessionEndedRef.current) return;
    sessionEndedRef.current = true;
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (!sessionId) return;
    void sessionPreparationRef.current
      .catch(() => undefined)
      .then(() => onSessionEndRef.current?.(sessionId))
      .catch(() => undefined);
  }

  function queueSegment(audio: Blob, generation: number) {
    const sequence = sequenceRef.current;
    sequenceRef.current += 1;
    updatePendingSegments(1, generation);

    transcriptionChainRef.current = transcriptionChainRef.current
      .then(async () => {
        if (generationRef.current !== generation) return;
        const sessionId = sessionIdRef.current;
        if (!sessionId) throw new Error("The dictation session is no longer active.");
        await sessionPreparationRef.current;
        if (generationRef.current !== generation) return;
        transcriptsRef.current[sequence] = await onTranscribeRef.current(
          audio,
          sessionId,
        );
      })
      .catch((caught) => {
        if (generationRef.current !== generation) return;
        failureRef.current ??= caught;
        requestStop();
      })
      .finally(() => updatePendingSegments(-1, generation));
  }

  async function finishSession(generation: number) {
    if (finishingRef.current) return;
    finishingRef.current = true;
    clearElapsedTimer();
    clearSegmentTimer();
    releaseStream();
    setPhase("transcribing");

    await transcriptionChainRef.current;
    if (generationRef.current !== generation) return;

    const failure = failureRef.current;
    if (failure) {
      endSession();
      setPhase("idle");
      setError(recordingErrorMessage(failure));
      return;
    }

    const sessionId = sessionIdRef.current;
    const transcript = mergeVoiceTranscriptParts(transcriptsRef.current);
    try {
      if (!sessionId) {
        throw new Error("The dictation session ended before its text was ready.");
      }
      if (!transcript) {
        throw new Error("Whisper finished without detecting any speech.");
      }
      await onCompleteRef.current(sessionId, transcript);
      if (generationRef.current !== generation) return;
      setPhase("inserted");
      resetTimerRef.current = window.setTimeout(() => {
        if (generationRef.current === generation) setPhase("idle");
        resetTimerRef.current = null;
      }, 2_000);
    } catch (caught) {
      if (generationRef.current !== generation) return;
      setPhase("idle");
      setError(recordingErrorMessage(caught));
    } finally {
      endSession();
    }
  }

  function startSegment(stream: MediaStream, generation: number, mimeType: string) {
    if (generationRef.current !== generation || stopRequestedRef.current) return;

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: 64_000,
    });
    const chunks: Blob[] = [];
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (generationRef.current !== generation) return;
      failureRef.current ??= new Error(
        "The microphone recording stopped unexpectedly.",
      );
      requestStop();
    };
    recorder.onstop = () => {
      if (recorderRef.current === recorder) recorderRef.current = null;
      clearSegmentTimer();
      if (generationRef.current !== generation) return;

      const isFinal = stopRequestedRef.current;
      const audio = new Blob(chunks, { type: "audio/mp4" });
      if (audio.size === 0) {
        if (sequenceRef.current === 0) {
          failureRef.current ??= new Error(
            "The voice memo was empty. Try recording again.",
          );
        }
        stopRequestedRef.current = true;
        void finishSession(generation);
        return;
      }
      if (audio.size > MAX_VOICE_MEMO_BYTES) {
        failureRef.current ??= new Error(
          "A dictation segment exceeded 64 MB and could not be transcribed.",
        );
        stopRequestedRef.current = true;
        void finishSession(generation);
        return;
      }

      queueSegment(audio, generation);
      if (isFinal) {
        void finishSession(generation);
      } else {
        startSegment(stream, generation, mimeType);
      }
    };
    recorder.start(1_000);
    segmentTimerRef.current = window.setTimeout(() => {
      if (
        generationRef.current === generation &&
        !stopRequestedRef.current &&
        recorder.state === "recording"
      ) {
        recorder.stop();
      }
    }, VOICE_MEMO_SEGMENT_MS);
  }

  useEffect(() => {
    return () => {
      endSession();
      generationRef.current += 1;
      clearTimers();
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder?.state === "recording") recorder.stop();
      releaseStream();
    };
  }, [noteId]);

  async function startRecording() {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    sequenceRef.current = 0;
    stopRequestedRef.current = false;
    finishingRef.current = false;
    sessionEndedRef.current = false;
    failureRef.current = null;
    transcriptsRef.current = [];
    transcriptionChainRef.current = Promise.resolve();
    pendingSegmentsRef.current = 0;
    setPendingSegments(0);
    setError(null);
    clearTimers();

    try {
      const mimeType = supportedMimeType();
      if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice memos are not supported by this Mac's recording engine.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (generationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const startedAt = Date.now();
      streamRef.current = stream;
      const randomId = globalThis.crypto?.randomUUID?.();
      const sessionId = randomId ?? `voice-${Date.now()}-${generation}`;
      sessionIdRef.current = sessionId;
      try {
        sessionPreparationRef.current = Promise.resolve(
          onSessionStartRef.current?.(sessionId),
        );
      } catch (caught) {
        sessionPreparationRef.current = Promise.reject(caught);
      }
      void sessionPreparationRef.current.catch(() => undefined);
      startSegment(stream, generation, mimeType);
      setElapsedMs(0);
      setPhase("recording");
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAt);
      }, 250);
    } catch (caught) {
      releaseStream();
      endSession();
      setPhase("idle");
      setError(recordingErrorMessage(caught));
    }
  }

  function toggleRecording() {
    if (phase === "recording") {
      requestStop();
      return;
    }
    if (phase === "idle" || phase === "inserted") void startRecording();
  }

  const recordingStatus = `${formatElapsed(elapsedMs)}${
    pendingSegments > 0 ? " · transcribing" : ""
  }`;
  const label =
    phase === "recording"
      ? `Stop dictation, recording ${formatElapsed(elapsedMs)}`
      : phase === "transcribing"
        ? "Finishing dictation transcription"
        : "Start dictation";

  return (
    <span className="voice-memo-control">
      <button
        type="button"
        className={phase === "recording" ? "icon-button voice-memo active" : "icon-button voice-memo"}
        aria-label={label}
        title={phase === "recording" ? "Stop dictation" : "Dictate at cursor"}
        aria-pressed={phase === "recording"}
        disabled={phase === "transcribing"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleRecording}
      >
        {phase === "recording" ? (
          <Square size={13} fill="currentColor" />
        ) : phase === "transcribing" ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Mic2 size={16} />
        )}
      </button>
      {phase !== "idle" || error ? (
        <span
          className={`voice-memo-status${error ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {error
            ? error
            : phase === "recording"
              ? recordingStatus
              : phase === "transcribing"
                ? "Finishing transcription…"
                : "Inserted"}
        </span>
      ) : null}
    </span>
  );
}
