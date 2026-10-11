import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Editor, EditorEvents } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { Clock3, Pause, Play, X } from "../../lib/icons";
import { FLOW_IDLE_SECONDS, flowRemaining, formatWritingTime, writingDuration, writingTimer } from "../../lib/writingSession";
import { finishInlineFlow, FLOW_RESULT, getInlineFlow, startInlineFlow } from "./FlowWriting";
import "./WritingSessionControl.css";

export function WritingSessionControl({ editor, flowDisabled = false, onAnnounce }: {
  editor: Editor; flowDisabled?: boolean; onAnnounce?: (message: string) => void;
}) {
  const timer = useSyncExternalStore(writingTimer.subscribe, writingTimer.getSnapshot);
  const flow = useEditorState({ editor, selector: ({ editor: current }) => getInlineFlow(current) });
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"timer" | "flow">("timer");
  const [minutes, setMinutes] = useState("15");
  const [idleSeconds, setIdleSeconds] = useState(10);
  const [notice, setNotice] = useState("");
  const announce = useRef(onAnnounce);
  announce.current = onAnnounce;
  const durationMs = writingDuration(Number(minutes));
  const active = timer.status === "running" || timer.status === "paused";
  const remaining = flow ? flowRemaining(flow.session, flow.now) : timer.remainingMs;
  const idleRemaining = flow ? Math.max(0, Math.ceil((flow.session.lastInputAt + flow.session.idleMs - flow.now) / 1000)) : 0;

  useEffect(() => {
    const result = ({ transaction }: EditorEvents["transaction"]) => {
      const outcome = transaction.getMeta(FLOW_RESULT);
      if (!outcome) return;
      const message = outcome === "kept" ? "Flow kept." : "Flow text disappeared. Existing text is unchanged.";
      setNotice(message); announce.current?.(message); setOpen(true);
    };
    editor.on("transaction", result);
    writingTimer.refresh();
    return () => { editor.off("transaction", result); };
  }, [editor]);

  function start() {
    if (!durationMs) return;
    setNotice("");
    if (mode === "flow") {
      if (flowDisabled || !startInlineFlow(editor, durationMs, idleSeconds)) return;
      writingTimer.stop(); setOpen(false);
      announce.current?.(`Flow started. New text disappears after ${idleSeconds} seconds without writing. Stop and keep retains it.`);
    } else {
      writingTimer.start(durationMs); setOpen(false);
      editor.commands.focus(undefined, { scrollIntoView: false });
      announce.current?.(`Writing timer started for ${minutes} ${Number(minutes) === 1 ? "minute" : "minutes"}.`);
    }
  }

  return <div className={`editor-writing-session${open ? " is-open" : ""}`} role="group" aria-label="Writing session">
    <button type="button" className={`editor-writing-timer${active || flow || open ? " active" : ""}`}
      aria-label="Writing timer" aria-expanded={open} title="Writing timer and Flow"
      onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(!open); setNotice(""); }}>
      <Clock3 size={15} aria-hidden="true"/>
      {!open && (flow || timer.status !== "idle") && <span>{flow ? "Flow " : ""}{timer.status === "complete" && !flow ? "Done" : formatWritingTime(remaining)}</span>}
      {!open && timer.status === "paused" && <Pause size={11} aria-hidden="true"/>}
    </button>
    {flow && !open && <button type="button" className="writing-session-keep" title="Stop Flow and keep this writing"
      onMouseDown={event => event.preventDefault()} onClick={() => finishInlineFlow(editor, true)}>Stop and keep</button>}
    {open && <>
      {flow || active ? <>
        <span className="writing-session-label">{flow ? "Flow" : timer.status === "paused" ? "Paused" : "Timer"}</span>
        <span className="writing-session-clock" role="timer" aria-live="off" aria-label="Writing time remaining">{formatWritingTime(remaining)}</span>
        {flow ? <>
          <span className="writing-session-hint" title="Only new session text is at risk; existing note text is protected.">
            {flow.session.phase === "ready" ? "Write below to begin" : flow.session.phase === "complete" ? "Ready to keep" : flow.session.composingAt !== null ? "Writing…" : `${idleRemaining}s until loss`}
          </span>
          <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => finishInlineFlow(editor, true)}>Stop and keep</button>
        </> : <>
          <button type="button" aria-label={timer.status === "paused" ? "Resume timer" : "Pause timer"}
            onClick={() => timer.status === "paused" ? writingTimer.resume() : writingTimer.pause()}>
            {timer.status === "paused" ? <Play size={14}/> : <Pause size={14}/>}</button>
          <button type="button" onClick={() => { writingTimer.stop(); setOpen(false); }}>Stop timer</button>
        </>}
      </> : <>
        <select aria-label="Writing mode" value={mode} onChange={event => { setMode(event.target.value as "timer" | "flow"); setNotice(""); }}>
          <option value="timer">Timer</option><option value="flow">Flow</option>
        </select>
        <label className="writing-session-duration"><input aria-label="Session duration in minutes" type="number" min={1} max={180} step={1}
          value={minutes} onChange={event => setMinutes(event.target.value)} onKeyDown={event => { if (event.key === "Enter") start(); }}/><span>min</span></label>
        {mode === "flow" && <select aria-label="Flow inactivity limit" value={idleSeconds} onChange={event => setIdleSeconds(Number(event.target.value))}>
          {FLOW_IDLE_SECONDS.map(value => <option key={value} value={value}>{value}s to disappear</option>)}
        </select>}
        <button type="button" className="writing-session-start" disabled={!durationMs || (mode === "flow" && flowDisabled)}
          title={mode === "flow" && flowDisabled ? "Finish the current editor action or close AI tools before starting Flow" : undefined}
          onClick={start}>Start {mode === "flow" ? "Flow" : "timer"}</button>
        <span className="writing-session-hint" role="status">{notice || (timer.status === "complete" ? "Time’s up. Writing kept." : mode === "flow"
          ? "New text fades, then is lost. Stop to keep." : "Write at your own pace.")}</span>
      </>}
      <button type="button" className="writing-session-close" aria-label="Close timer controls" onClick={() => { setOpen(false); editor.view.focus(); }}><X size={14}/></button>
    </>}
    {timer.status === "complete" && <span className="sr-only" role="status">Writing timer complete. Your writing is kept.</span>}
    {flow?.session.phase === "writing" && idleRemaining <= 3 && flow.session.composingAt === null &&
      <span className="sr-only" role="status">Keep typing or choose Stop and keep. Your Flow text is about to disappear.</span>}
  </div>;
}
