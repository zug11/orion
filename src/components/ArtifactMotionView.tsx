import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ArtifactMotion, MotionDrawing, MotionPhase } from "../lib/artifactMotion";
import { phaseAt, sampleMotion } from "../lib/artifactMotion";
import { formatArtifactQuantity } from "../lib/visualArtifactQuantity";
import "./ArtifactMotionView.css";

function readout(position: number, unit: string) {
  const rounded = Number(position.toPrecision(5));
  if (unit === "°") return `${rounded}°`;
  return formatArtifactQuantity(rounded, unit);
}

function Diagram({ view, position }: { view: MotionDrawing; position: number }) {
  return (
    <svg className="artifact-motion__diagram" viewBox="0 0 240 160" role="img" aria-label={view.label}>
      {view.marks.map((mark, i) => {
        const state = mark.motion && sampleMotion(mark.motion, position);
        const [px, py] = mark.pivot ?? [0, 0];
        return (
          <path key={i} d={mark.d} data-tone={mark.tone}
            fill={mark.filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8"
            opacity={state?.opacity} strokeLinecap="round" strokeLinejoin="round"
            transform={state ? `translate(${state.x + px} ${state.y + py}) rotate(${state.angle}) scale(${state.scaleX} ${state.scaleY}) translate(${-px} ${-py})` : undefined}/>
        );
      })}
    </svg>
  );
}

function CycleDial({ block, fraction, onChange, onKeyDown }: {
  block: ArtifactMotion; fraction: number; onChange: (fraction: number) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const dragging = useRef<number | null>(null);
  const dialPoint = (turn: number, r: number) => {
    const a = turn * 2 * Math.PI;
    return [50 + r * Math.sin(a), 50 - r * Math.cos(a)];
  };
  function turn(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) < Math.min(rect.width, rect.height) * .12) return;
    onChange(((Math.atan2(dx, -dy) / (2 * Math.PI)) + 1) % 1);
  }
  const [x, y] = dialPoint(fraction, 34);
  return (
    <svg className="artifact-motion__dial" viewBox="0 0 100 100" role="slider" tabIndex={0}
      aria-label={`Turn ${block.label}`} aria-valuemin={0} aria-valuemax={block.period}
      aria-valuenow={fraction * block.period} aria-valuetext={readout(fraction * block.period, block.unit)}
      onKeyDown={onKeyDown}
      onPointerDown={event => {
        if (dragging.current !== null || event.button !== 0) return;
        dragging.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        turn(event); event.preventDefault();
      }}
      onPointerMove={event => { if (dragging.current === event.pointerId) turn(event); }}
      onPointerUp={event => { if (dragging.current === event.pointerId) dragging.current = null; }}
      onPointerCancel={event => { if (dragging.current === event.pointerId) dragging.current = null; }}
      onLostPointerCapture={event => { if (dragging.current === event.pointerId) dragging.current = null; }}>
      <circle cx="50" cy="50" r="34" fill="none" stroke="var(--line-strong)" strokeWidth="5"/>
      {block.phases.map(p => {
        const [x1, y1] = dialPoint(p.at / block.period, 39);
        const [x2, y2] = dialPoint(p.at / block.period, 44);
        return <line key={p.at} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--text-soft)" strokeWidth="2"/>;
      })}
      <line x1="50" y1="50" x2={x} y2={y} stroke="var(--va-accent)" strokeWidth="3"/>
      <circle cx="50" cy="50" r="5" fill="var(--text-soft)"/>
      <circle cx={x} cy={y} r="7" fill="var(--va-accent)"/>
    </svg>
  );
}

function Source({ passage, phase }: { passage: string; phase: MotionPhase }) {
  const at = passage.indexOf(phase.quote);
  return <details className="artifact-motion__source">
    <summary>Source passage</summary>
    <blockquote>{passage.slice(0, at)}<mark>{phase.quote}</mark>{passage.slice(at + phase.quote.length)}</blockquote>
  </details>;
}

export function ArtifactMotionView({ block }: { block: ArtifactMotion }) {
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const current = useRef(0);
  const drag = useRef<{ pointer: number; x: number; start: number } | null>(null);
  const slider = useId();
  const fraction = position / block.period;
  const cycle = block.kind === "cycle";
  const phase = phaseAt(block.phases, cycle && position === block.period ? 0 : position);
  const set = (next: number) => {
    setPlaying(false);
    current.current = Math.max(0, Math.min(block.period, next));
    setPosition(current.current);
  };
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const initial = current.current / block.period;
    const start = performance.now();
    const tick = (now: number) => {
      // Playback length is an interface choice, independent of the authored units.
      current.current = ((initial + (now - start) / 12000) % 1) * block.period;
      setPosition(current.current);
      frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", onVisibility);
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("visibilitychange", onVisibility); };
  }, [playing, block.period]);

  function keys(event: KeyboardEvent) {
    const increment = event.shiftKey ? .1 : .01;
    let next: number;
    switch (event.key) {
      case "ArrowRight": case "ArrowUp": next = fraction + increment; break;
      case "ArrowLeft": case "ArrowDown": next = fraction - increment; break;
      case "Home": next = 0; break;
      case "End": next = 1; break;
      default: return;
    }
    event.preventDefault(); event.stopPropagation();
    if (cycle && (next > 1 || next < 0)) next = ((next % 1) + 1) % 1;
    set(next * block.period);
  }
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (cycle || event.button !== 0 || drag.current) return;
    drag.current = { pointer: event.pointerId, x: event.clientX, start: fraction };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveDrag(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (active?.pointer !== event.pointerId) return;
    const width = event.currentTarget.getBoundingClientRect().width;
    if (width > 0) set((active.start + (event.clientX - active.x) / width) * block.period);
  }
  function endDrag(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointer === event.pointerId) drag.current = null;
  }
  return <div className="artifact-motion" data-mode={block.kind}>
    <div className="artifact-motion__views">
      {block.views.map((view, i) => <figure key={i}
        onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}>
        <Diagram view={view} position={position}/>
        <figcaption>{view.label}</figcaption>
      </figure>)}
      {cycle && <div className="artifact-motion__dial-control">
        <CycleDial block={block} fraction={fraction} onChange={f => set(f * block.period)} onKeyDown={keys}/>
        <button type="button" className="visual-artifact__minor-button" aria-pressed={playing}
          onClick={() => setPlaying(!playing)}>{playing ? "Pause cycle" : "Play cycle"}</button>
      </div>}
    </div>
    <div className="artifact-motion__control">
      <div><label htmlFor={slider}>{block.label}</label><output htmlFor={slider}>{readout(position, block.unit)}</output></div>
      <input id={slider} type="range" min={0} max={block.period} step="any" value={position}
        aria-valuetext={readout(position, block.unit)} onKeyDown={keys} onChange={e => set(e.currentTarget.valueAsNumber)}/>
      {!cycle && <small>Drag either view or adjust the slider.</small>}
    </div>
    <div className="artifact-motion__phases" role="group" aria-label={cycle ? "Cycle phases" : "View positions"}>
      {block.phases.map(p => <button key={p.at} type="button" aria-pressed={p === phase}
        onClick={() => set(p.at)}>{p.label}</button>)}
    </div>
    <p className="artifact-motion__caption" aria-live="polite">{phase.caption}</p>
    <Source passage={block.passage} phase={phase}/>
  </div>;
}

export function ArtifactMotionSnapshot({ block }: { block: ArtifactMotion }) {
  return <section><h4>{block.label}</h4>
    {block.phases.map(phase => <div key={phase.at}>
      <h5>{phase.label} · {readout(phase.at, block.unit)}</h5>
      <div className="artifact-motion__views">{block.views.map((view, i) => <figure key={i}>
        <Diagram view={view} position={phase.at}/><figcaption>{view.label}</figcaption>
      </figure>)}</div>
      <p>{phase.caption}</p><blockquote>{phase.quote}</blockquote>
    </div>)}
  </section>;
}
