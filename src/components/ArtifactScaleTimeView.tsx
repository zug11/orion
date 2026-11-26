import { useMemo, useRef, useState, type PointerEvent } from "react";
import {
  DAY_SECONDS, adaptiveLength, dayClockTime, daySecondOf, dimension, durationText, scaleCamera, scaleStops, timeRemaining,
  type ArtifactDeepTime, type ArtifactScaleZoom, type DayEvent,
} from "../lib/artifactScaleTime";
import "./ArtifactScaleTimeView.css";

type Block = ArtifactScaleZoom | ArtifactDeepTime;
const tones = ["var(--va-cool)", "var(--va-warm)", "var(--va-trace)"];
const width = 600;

function ScaleZoom({ block }: {block: ArtifactScaleZoom}) {
  const stops = useMemo(() => scaleStops(block.items), [block]);
  const [progress, setProgress] = useState(0);
  const {field, centre, nearest, bar} = scaleCamera(stops, progress);
  const largest = stops[0];
  return <div className="va-scale-zoom">
    <div className="va-zoom-window">
      <div className="va-zoom-distance">{adaptiveLength(field)} across</div>
      <svg viewBox="0 0 600 290" role="img" aria-label={`Size comparison at ${adaptiveLength(field)} across, focused on ${nearest.item.label}`}>
        {stops.map((stop, i) => {
          const pixels = stop.metres / field * width;
          const x = width / 2 + (stop.centre - centre) / field * width;
          if (pixels < 0.8 || x + pixels / 2 < 0 || x - pixels / 2 > width || pixels > 10000) return null;
          return <g key={i} transform={`translate(${x},145)`} color={tones[i % tones.length]}>
            {stop.item.path
              ? <g transform={`scale(${pixels / 100}) translate(-50,-50)`}>
                  <path d={stop.item.path} className="va-zoom-silhouette" fillRule="evenodd" vectorEffect="non-scaling-stroke" />
                </g>
              : <g className="va-zoom-measure" stroke="currentColor">
                  <line x1={-pixels / 2} x2={pixels / 2} y1="0" y2="0" />
                  <path d={`M ${-pixels / 2} -8 v16 M ${pixels / 2} -8 v16`} />
                </g>}
          </g>;
        })}
      </svg>
      <div className="va-zoom-scale">
        <span style={{width: `${bar / field * 100}%`}} />
        {adaptiveLength(bar)}
      </div>
    </div>
    <label className="va-scale-range">Zoom
      <input type="range" min={0} max={10000} step={1} value={Math.round(progress * 10000)}
        aria-valuetext={`${adaptiveLength(field)} across`} onChange={e => setProgress(e.currentTarget.valueAsNumber / 10000)} />
    </label>
    <div role="group" aria-label="Zoom to a subject" className="va-scale-options">
      {stops.map((stop, i) => <button type="button" key={i} aria-pressed={stop === nearest}
        onClick={() => setProgress(stop.zoom)}><span className="va-scale-swatch" style={{background: tones[i % tones.length]}} />{stop.item.label}</button>)}
    </div>
    <div className="va-scale-reading">
      <strong>{nearest.item.label}</strong> · {dimension(nearest.item.size, nearest.item.unit)}
      {nearest !== largest && <div>{largest.item.label} measures {dimension(largest.metres / nearest.metres)} times this size.</div>}
      {nearest.item.detail && <p>{nearest.item.detail}</p>}
    </div>
  </div>;
}

function positionOnDial(seconds: number, radius: number) {
  const angle = seconds / DAY_SECONDS * 2 * Math.PI;
  return {x: 100 + radius * Math.sin(angle), y: 100 - radius * Math.cos(angle)};
}

function TimeDial({seconds, milestones, set}: {seconds: number; milestones: number[]; set: (n: number) => void}) {
  const dragging = useRef<number | null>(null);
  function readPointer(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dx = e.clientX - rect.left - rect.width / 2, dy = e.clientY - rect.top - rect.height / 2;
    if (Math.hypot(dx, dy) < Math.min(rect.width, rect.height) * 0.07) return;
    const turn = (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1;
    set(turn === 0 && seconds > DAY_SECONDS / 2 ? DAY_SECONDS : Math.round(turn * DAY_SECONDS));
  }
  const tip = positionOnDial(seconds, 78);
  return <svg className="va-time-dial" viewBox="0 0 200 200" role="img"
    aria-label={`24-hour clock at ${dayClockTime(seconds)}`}
    onPointerDown={e => {
      if (dragging.current !== null || e.button !== 0) return;
      dragging.current = e.pointerId;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      readPointer(e);
    }}
    onPointerMove={e => {if (e.pointerId === dragging.current) readPointer(e);}}
    onPointerUp={() => {dragging.current = null;}} onPointerCancel={() => {dragging.current = null;}}
    onLostPointerCapture={() => {dragging.current = null;}}>
    <circle cx="100" cy="100" r="83" className="va-time-rim" />
    {Array.from({length:24}, (_, hour) => {
      const tick = positionOnDial(hour * 3600, hour % 6 === 0 ? 70 : 77);
      const rim = positionOnDial(hour * 3600, 82);
      return <line key={hour} x1={tick.x} y1={tick.y} x2={rim.x} y2={rim.y} className="va-time-tick" />;
    })}
    {[0, 6, 12, 18].map(hour => {
      const pos = positionOnDial(hour * 3600, 56);
      return <text key={hour} x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="central">{hour === 0 ? "00" : hour}</text>;
    })}
    {milestones.map((n, i) => {
      const p = positionOnDial(n, 88);
      return <circle key={i} cx={p.x} cy={p.y} r="2.7" fill={tones[i % tones.length]} />;
    })}
    <line x1="100" y1="100" x2={tip.x} y2={tip.y} className="va-time-hand" />
    <circle cx={tip.x} cy={tip.y} r="4.5" className="va-time-pin" /><circle cx="100" cy="100" r="3.5" className="va-time-pin" />
  </svg>;
}

function TimeRange({title, start, step, seconds, milestones, set}: {
  title: string; start: number; step: number; seconds: number; milestones: number[]; set: (n: number) => void;
}) {
  const value = Math.max(start, seconds);
  return <label className="va-time-range">{title}
    <span className="va-time-range-control">
      <span className="va-time-range-marks" aria-hidden="true">{milestones.map((n, i) => n >= start &&
        <i key={i} style={{left:`${(n - start) / (DAY_SECONDS - start) * 100}%`, background:tones[i % tones.length]}} />)}</span>
      <input type="range" min={start} max={DAY_SECONDS} step={step} value={value} aria-label={title}
        data-outside={seconds < start} aria-valuetext={seconds < start ? `Window begins at ${dayClockTime(start)}` : dayClockTime(value)}
        onPointerDown={() => { if (seconds < start) set(start); }}
        onKeyDown={e => { if (seconds < start && e.key === "Home") set(start); }}
        onChange={e => set(e.currentTarget.valueAsNumber)} />
    </span>
    <span className="va-time-range-labels" aria-hidden="true"><span>{dayClockTime(start)}</span><span>24:00:00</span></span>
  </label>;
}

function DeepTime({block}: {block: ArtifactDeepTime}) {
  const times = useMemo(() => block.events.map(event => daySecondOf(event, block.duration)), [block]);
  const [selection, select] = useState<{index: number} | {seconds: number}>({index:0});
  const index = "index" in selection ? selection.index : -1;
  const event = block.events[index];
  const seconds = "seconds" in selection ? selection.seconds : times[index] ?? 0;
  const remaining = event && "beforeEnd" in event ? event.beforeEnd : timeRemaining(seconds, block.duration);
  const set = (n: number) => select({seconds:n});
  return <div className="va-deep-time">
    <div className="va-time-grid">
      <div>
        <TimeDial seconds={seconds} milestones={times} set={set} />
        <div className="va-time-readout"><strong>{dayClockTime(seconds)}</strong>
          <span>{durationText(remaining, block.unit)} before the end</span></div>
      </div>
      <div role="group" aria-label="Jump to an event" className="va-time-events">
        {block.events.map((e, i) => <button type="button" key={i} aria-pressed={i === index} onClick={() => select({index:i})}>
          <span className="va-scale-swatch" style={{background:tones[i % tones.length]}} />
          <span>{e.label}</span><time>{dayClockTime(times[i])}</time>
        </button>)}
      </div>
    </div>
    {event?.detail && <p className="va-time-detail">{event.detail}</p>}
    <TimeRange title="Whole day" start={0} step={1} seconds={seconds} milestones={times} set={set} />
    {([["Last hour", 3600], ["Last minute", 60]] as const).map(([title, window]) =>
      times.some(n => n >= DAY_SECONDS - window) && <TimeRange key={title} title={title} start={DAY_SECONDS - window}
        step={1} seconds={seconds} milestones={times} set={set} />)}
    <p className="va-time-units">One second on the clock represents {durationText(block.duration / DAY_SECONDS, block.unit)}.</p>
  </div>;
}

export function ArtifactScaleTimeView({block}: {block: Block}) {
  return block.kind === "scaleZoom" ? <ScaleZoom block={block}/> : <DeepTime block={block}/>;
}

function eventSnapshot(e: DayEvent, block: ArtifactDeepTime) {
  const seconds = daySecondOf(e, block.duration);
  const before = "beforeEnd" in e ? e.beforeEnd : timeRemaining(seconds, block.duration);
  return <><strong>{e.label}</strong> · {dayClockTime(seconds)} · {durationText(before, block.unit)} before the end{e.detail && <p>{e.detail}</p>}</>;
}

export function ArtifactScaleTimeSnapshot({block}: {block: Block}) {
  if (block.kind === "deepTime") return <div><p>{durationText(block.duration, block.unit)} shown as one day.</p>
    <ul>{block.events.map((e, i) => <li key={i}>{eventSnapshot(e, block)}</li>)}</ul></div>;
  const stops = scaleStops(block.items);
  return <ul>{stops.map((s,i) => <li key={i}><strong>{s.item.label}</strong> · {dimension(s.item.size, s.item.unit)}
    {i > 0 && <> · {stops[0].item.label} measures {dimension(stops[0].metres / s.metres)} times this size.</>}
    {s.item.detail && <p>{s.item.detail}</p>}</li>)}</ul>;
}
