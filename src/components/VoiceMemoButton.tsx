import {
  useEffect,
  useRef,
  useState,
} from "react";
import { LoaderCircle, Mic2, Square } from "../lib/icons";
import { createPortal } from "react-dom";
import { useDictationNavigation } from "./DictationNavigation";
import { DictationNotInsertedError, type DictationCompletionOptions } from "../lib/dictationCleanup";
import { reportDetachedDictation } from "../lib/dictationOutcome";
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

type VoiceMemoPhase = "idle" | "recording" | "transcribing" | "saving" | "cleaning";

interface VoiceMemoButtonProps {
  noteId: string;
  disabled?: boolean;
  onSessionStart?: (sessionId: string) => Promise<void> | void;
  onSessionEnd?: (sessionId: string) => Promise<void> | void;
  onTranscribe: (audio: Blob, sessionId: string) => Promise<string>;
  onComplete: (sessionId: string, transcript: string, options: DictationCompletionOptions) => Promise<string | void>;
}

type SessionCallbacks = Pick<VoiceMemoButtonProps, "onSessionEnd" | "onTranscribe" | "onComplete">;

/**
 * One recording, from microphone to archived transcript. Its state lives here
 * rather than on the component, so a recording can outlive the note it was
 * started in: leaving the note detaches the session, which then finishes
 * transcribing and archives its original without a button to report through.
 */
interface Session {
  id: string;
  stream: MediaStream;
  mimeType: string;
  recorder: MediaRecorder | null;
  segmentTimer: number | null;
  sequence: number;
  stopRequested: boolean;
  finishing: boolean;
  ended: boolean;
  failure: unknown;
  transcripts: string[];
  chain: Promise<void>;
  pending: number;
  preparation: Promise<void>;
  completion: AbortController | null;
  /** The callbacks of the note it started in, frozen when it leaves that note. */
  detached: SessionCallbacks | null;
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
  disabled = false,
  onSessionStart,
  onSessionEnd,
  onTranscribe,
  onComplete,
}: VoiceMemoButtonProps) {
  const navigation = useDictationNavigation();
  disabled ||= navigation.blocked;
  const [phase, setPhase] = useState<VoiceMemoPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pendingSegments, setPendingSegments] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The session this button currently shows. Detached sessions are not here. */
  const sessionRef = useRef<Session | null>(null);
  /** Invalidates a microphone request that resolves after the note was left. */
  const generationRef = useRef(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const onSessionStartRef = useRef(onSessionStart);
  const callbacksRef = useRef<SessionCallbacks>({ onSessionEnd, onTranscribe, onComplete });
  onSessionStartRef.current = onSessionStart;
  // Updated after commit, not during render: when the note changes, the cleanup
  // below must still see the callbacks of the note being left. React runs every
  // cleanup of a commit before any effect of that commit.
  useEffect(() => {
    callbacksRef.current = { onSessionEnd, onTranscribe, onComplete };
  });

  const attached = (session: Session) => sessionRef.current === session;
  /** Attached sessions follow the latest props; detached ones keep their note's. */
  const callbacks = (session: Session) => session.detached ?? callbacksRef.current;

  function clearElapsedTimer() {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }

  function clearSegmentTimer(session: Session) {
    if (session.segmentTimer !== null) {
      window.clearTimeout(session.segmentTimer);
      session.segmentTimer = null;
    }
  }

  function updatePendingSegments(session: Session, delta: number) {
    session.pending = Math.max(0, session.pending + delta);
    if (attached(session)) setPendingSegments(session.pending);
  }

  function requestStop(session: Session) {
    session.stopRequested = true;
    clearSegmentTimer(session);
    if (session.recorder?.state === "recording") session.recorder.stop();
  }

  function endSession(session: Session) {
    if (session.ended) return;
    session.ended = true;
    void session.preparation
      .catch(() => undefined)
      .then(() => callbacks(session).onSessionEnd?.(session.id))
      .catch(() => undefined);
  }

  function queueSegment(session: Session, audio: Blob) {
    const sequence = session.sequence;
    session.sequence += 1;
    updatePendingSegments(session, 1);

    session.chain = session.chain
      .then(async () => {
        await session.preparation;
        session.transcripts[sequence] = await callbacks(session).onTranscribe(audio, session.id);
      })
      .catch((caught) => {
        session.failure ??= caught;
        requestStop(session);
      })
      .finally(() => updatePendingSegments(session, -1));
  }

  async function finishSession(session: Session) {
    if (session.finishing) return;
    session.finishing = true;
    if (attached(session)) clearElapsedTimer();
    clearSegmentTimer(session);
    session.stream.getTracks().forEach((track) => track.stop());
    if (attached(session)) setPhase("transcribing");

    await session.chain;

    const failure = session.failure;
    const transcript = mergeVoiceTranscriptParts(session.transcripts);
    const release = () => {
      session.completion = null;
      endSession(session);
      if (attached(session)) sessionRef.current = null;
    };
    if (!transcript) {
      const message = failure
        ? recordingErrorMessage(failure)
        : "Whisper finished without detecting any speech.";
      if (attached(session)) {
        setPhase("idle");
        setError(message);
      } else if (failure) {
        reportDetachedDictation({ saved: false, message });
      }
      release();
      return;
    }

    let outcome: { error?: unknown } = {};
    try {
      const controller = new AbortController();
      // Preserve already-transcribed speech through the ordinary original-source
      // archive and insertion path. Missing speech could contain a correction or
      // cancellation, so incomplete recordings must never create AI work items.
      // A recording that has left its note is archived but never cleaned up or
      // inserted, so it needs no provider call either.
      if (failure) controller.abort(failure);
      else if (session.detached) controller.abort(new DOMException("The note was closed.", "AbortError"));
      session.completion = controller;
      await callbacks(session).onComplete(session.id, transcript, {
        signal: controller.signal,
        onPhase: (next) => { if (attached(session)) setPhase(next); },
      });
    } catch (caught) {
      outcome = { error: caught };
    }

    if (attached(session)) {
      setPhase("idle");
      if (outcome.error !== undefined) setError(recordingErrorMessage(outcome.error));
      else if (failure) setError(`Recording incomplete. The transcribed portion was kept, but some speech could not be recovered. ${recordingErrorMessage(failure)}`);

    } else {
      // The editor refuses to insert into a note that is gone, after archiving.
      const archived = outcome.error instanceof DictationNotInsertedError && Boolean(outcome.error.sourceId);
      reportDetachedDictation(archived || outcome.error === undefined
        ? { saved: true }
        : { saved: false, message: recordingErrorMessage(outcome.error) });
    }
    release();
  }

  function startSegment(session: Session) {
    if (session.stopRequested) return;

    const recorder = new MediaRecorder(session.stream, {
      mimeType: session.mimeType,
      audioBitsPerSecond: 64_000,
    });
    const chunks: Blob[] = [];
    session.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      session.failure ??= new Error(
        "The microphone recording stopped unexpectedly.",
      );
      requestStop(session);
    };
    recorder.onstop = () => {
      if (session.recorder === recorder) session.recorder = null;
      clearSegmentTimer(session);

      const isFinal = session.stopRequested;
      const audio = new Blob(chunks, { type: "audio/mp4" });
      if (audio.size === 0) {
        if (session.sequence === 0) {
          session.failure ??= new Error(
            "The voice memo was empty. Try recording again.",
          );
        }
        session.stopRequested = true;
        void finishSession(session);
        return;
      }
      if (audio.size > MAX_VOICE_MEMO_BYTES) {
        session.failure ??= new Error(
          "A dictation segment exceeded 64 MB and could not be transcribed.",
        );
        session.stopRequested = true;
        void finishSession(session);
        return;
      }

      queueSegment(session, audio);
      if (isFinal) {
        void finishSession(session);
      } else {
        startSegment(session);
      }
    };
    recorder.start(1_000);
    session.segmentTimer = window.setTimeout(() => {
      if (!session.stopRequested && recorder.state === "recording") {
        recorder.stop();
      }
    }, VOICE_MEMO_SEGMENT_MS);
  }

  useEffect(() => {
    // A new note starts with a clean button, whatever the last one was doing.
    setPhase("idle");
    setElapsedMs(0);
    setPendingSegments(0);
    setError(null);
    return () => {
      generationRef.current += 1;
      clearElapsedTimer();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      // Leaving the note must not lose what was said. The session keeps the
      // callbacks of the note it belongs to, stops the microphone, and finishes
      // on its own: remaining audio is transcribed and the original archived.
      session.detached = callbacksRef.current;
      session.completion?.abort(new DOMException("The note was closed.", "AbortError"));
      requestStop(session);
    };
  }, [noteId]);

  async function startRecording() {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setPendingSegments(0);
    setError(null);
    clearElapsedTimer();

    let stream: MediaStream | undefined;
    let session: Session | undefined;
    try {
      const mimeType = supportedMimeType();
      if (!mimeType || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice memos are not supported by this Mac's recording engine.");
      }
      stream = await navigator.mediaDevices.getUserMedia({
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
      const randomId = globalThis.crypto?.randomUUID?.();
      const id = randomId ?? `voice-${Date.now()}-${generation}`;
      let preparation: Promise<void>;
      try {
        preparation = Promise.resolve(onSessionStartRef.current?.(id));
      } catch (caught) {
        preparation = Promise.reject(caught);
      }
      const recording: Session = {
        id,
        stream,
        mimeType,
        recorder: null,
        segmentTimer: null,
        sequence: 0,
        stopRequested: false,
        finishing: false,
        ended: false,
        failure: null,
        transcripts: [],
        chain: Promise.resolve(),
        pending: 0,
        preparation,
        completion: null,
        detached: null,
      };
      session = recording;
      sessionRef.current = recording;
      // Recording can begin while Whisper warms up. If startup fails, release
      // the mic now even if the user has navigated away from this editor.
      void preparation.catch(error => {
        if (recording.ended || recording.finishing) return;
        recording.failure ??= error;
        requestStop(recording);
      });
      startSegment(recording);
      setElapsedMs(0);
      setPhase("recording");
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startedAt);
      }, 250);
    } catch (caught) {
      stream?.getTracks().forEach((track) => track.stop());
      if (session) {
        endSession(session);
        if (attached(session)) sessionRef.current = null;
      }
      setPhase("idle");
      setError(recordingErrorMessage(caught));
    }
  }

  function toggleRecording() {
    const session = sessionRef.current;
    if (phase === "cleaning") {
      session?.completion?.abort();
      return;
    }
    if (phase === "recording") {
      if (session) requestStop(session);
      return;
    }
    if (phase === "idle" && !disabled) void startRecording();
  }

  const recordingStatus = `${formatElapsed(elapsedMs)}${
    pendingSegments > 0 ? " · transcribing" : ""
  }`;
  const finishing = phase === "transcribing" || phase === "saving" || phase === "cleaning";
  const label =
    phase === "recording"
      ? `Stop dictation, recording ${formatElapsed(elapsedMs)}`
      : phase === "cleaning"
        ? "Use original dictation"
        : phase === "saving"
          ? "Saving original dictation"
          : phase === "transcribing"
        ? "Finishing dictation transcription"
        : "Start dictation";

  const control = (
    <span className="voice-memo-control">
      <button
        type="button"
        className={phase === "recording" ? "icon-button voice-memo active" : "icon-button voice-memo"}
        aria-label={label}
        title={phase === "recording" ? "Stop dictation" : phase === "cleaning" ? "Use original dictation without AI cleanup" : navigation.blocked ? "Stop the current dictation before starting another" : disabled ? "Finish the current writing operation first" : "Dictate at cursor"}
        aria-pressed={phase === "recording"}
        aria-busy={finishing}
        disabled={(phase === "idle" && disabled) || (finishing && phase !== "cleaning")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleRecording}
      >
        {phase === "recording" ? (
          <Square size={13} fill="currentColor" />
        ) : finishing ? (
          <LoaderCircle size={16} className="spin" />
        ) : (
          <Mic2 size={16} />
        )}
      </button>
      {phase === "recording" || error ? (
        <span
          className={`voice-memo-status${error ? " is-error" : ""}`}
          role="status"
          aria-live="polite"
        >
          {error ?? recordingStatus}
        </span>
      ) : null}
    </span>
  );
  if (!navigation.background) return control;
  if (phase === "idle" && !error) return null;
  return createPortal(<div className="dictation-floating" role="region" aria-label="Background dictation">
    <button type="button" className="dictation-floating-note" onClick={navigation.onReturn}
      title={`Return to ${navigation.noteTitle}`}><span>{phase === "idle" ? "Dictation needs attention" : "Dictating to"}</span><strong>{navigation.noteTitle}</strong></button>
    {control}
  </div>, document.body);
}
