import { memo, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  type ArtifactIllustration,
  type DrawingPaint,
  type DrawingShape,
  type DrawingTone,
} from "../lib/artifactIllustration";
import { illustrationBadges, illustrationLayout } from "../lib/artifactIllustrationLayout";
import { animationTimeForValue, currentHandlePositions, drawingPoses, handleValueText, posePoint, poseTransform, type DrawingHandle } from "../lib/illustrationHandles";
import { illustrationPoses } from "../lib/illustrationPoses";
import { saveIllustrationSvg } from "../lib/illustrationSvg";
import { ArtifactDrawingGlyph } from "./ArtifactDrawingGlyph";
import { IllustrationHandleTrack } from "./IllustrationHandleTrack";
import { useArtifactPlayback } from "./useArtifactPlayback";
import "./ArtifactIllustrationView.css";

const colors: Record<DrawingTone, string> = {
  accent: "var(--va-accent, #7665ba)",
  warm: "var(--va-warm, #996a21)",
  cool: "var(--va-cool, #377960)",
  rose: "var(--rose, #ac5064)",
  neutral: "var(--text-soft, #515760)",
  ground: "var(--muted, #727980)",
};
function handleColor(block: ArtifactIllustration, handle: DrawingHandle) {
  const tone = block.parts.find(part => part.id === handle.effects[0].parts[0])?.tone;
  return tone && tone !== "neutral" && tone !== "ground" ? colors[tone] : colors.accent;
}
const weight: Record<DrawingPaint, number> = {
  outline: 2.4,
  soft: 2,
  fill: 2,
  solid: 0,
  surface: 2,
  bold: 5.5,
  heavy: 9,
  thin: 1.2,
  dashed: 1.6,
  dotted: 3.4,
  level: 0,
};
const Shape = memo(function Shape({ shape, level }: { shape: DrawingShape; level?: number }) {
  const filled = { soft: 22, fill: 46, level: 50, solid: 100 };
  const opacity = filled[shape.paint as keyof typeof filled];
  const style = {
    stroke: weight[shape.paint] ? "currentColor" : "none",
    strokeWidth: weight[shape.paint],
    fill: shape.paint === "surface" ? "var(--surface-1, Canvas)" : opacity ? "currentColor" : "none",
    fillOpacity: opacity ? opacity / 100 : undefined,
    strokeDasharray: shape.paint === "dashed" ? "6 5" : shape.paint === "dotted" ? "3 2.2" : undefined,
  };
  switch (shape.type) {
    case "rect": {
      const height = shape.h * (shape.paint === "level" ? (level ?? 0) : 1);
      return (
        <rect x={shape.x} y={shape.y + shape.h - height} width={shape.w} height={height} rx={shape.r} {...style} />
      );
    }
    case "circle":
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...style} />;
    case "ellipse":
      return <ellipse cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} {...style} />;
    case "line":
      return <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} {...style} />;
    case "path":
      return <path d={shape.d} {...style} />;
    case "polygon":
    case "polyline": {
      const points = shape.points.map((p) => p.join(",")).join(" ");
      return shape.type === "polygon" ? (
        <polygon points={points} {...style} />
      ) : (
        <polyline points={points} {...style} />
      );
    }
  }
});

type DiagramProps = {
  block: ArtifactIllustration;
  stage: number;
  selected?: string;
  onSelect?: (id: string) => void;
  positions?: readonly number[];
  time?: number;
  onPosition?: (index: number, position: number) => void;
};
export function ArtifactIllustrationDiagram({ block, stage, selected, onSelect, positions, onPosition, time = 0 }: DiagramProps) {
  const layout = useMemo(() => illustrationLayout(block), [block]);
  const { left, top, width, height } = layout;
  const changes = useMemo(() => block.states?.items[stage]?.changes ?? [], [block, stage]);
  const parts = useMemo(() => block.parts.slice().sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)), [block]);
  const selectable = block.parts.filter((p) => p.selectable);
  const hasBadges = (!block.handles && !block.animation) || !!selected;
  const badges = useMemo(() => hasBadges ? illustrationBadges(block, changes, layout) : undefined, [block, changes, layout, hasBadges]);
  const poses = useMemo(() => drawingPoses(block.handles ?? [], positions ?? [], block.animation, time), [block, positions, time]);
  const radius = Math.max(width, height) * 0.019;
  return (
    <svg
      className="artifact-illustration__figure"
      viewBox={`${left} ${top} ${width} ${height}`}
      role="img"
      aria-label={`Illustration of ${selectable.map((p) => p.name).join(", ")}`}
      width="100%"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {parts.map((part) => {
        const change = changes.find((c) => c.part === part.id);
        if (change?.hidden) return null;
        const pose = poses.get(part.id);
        const level = pose?.level ?? change?.level ?? part.level;
        const dim = selected && selected !== part.id;
        return (
          <g
            key={part.id}
            data-drawing-part={part.id}
            data-selectable={part.selectable || undefined}
            opacity={(pose?.opacity ?? 1) * (dim ? 0.44 : part.selectable || change?.emphasis ? 1 : 0.66)}
            transform={poseTransform(pose)}
            pointerEvents={pose?.opacity === 0 ? "none" : undefined}
            color={colors[part.tone]}
            onClick={part.selectable && onSelect ? () => onSelect(part.id) : undefined}
          >
            {(change?.shapes ?? part.shapes)?.map((shape, i) => (
              <Shape key={i} shape={shape} level={level} />
            ))}
            {part.icon && <ArtifactDrawingGlyph icon={part.icon} level={level} />}
          </g>
        );
      })}
      {selectable.map((part, i) => {
        const base = badges?.get(part.id);
        if (!base || ((block.handles || block.animation) && selected !== part.id)) return null;
        const pose = poses.get(part.id);
        const [x, y] = pose ? posePoint([base.x, base.y], pose) : [base.x, base.y];
        const anchor = pose ? posePoint(base.anchor, pose) : base.anchor;
        const active =
          selected === part.id || (!selected && changes.some((c) => c.part === part.id && c.emphasis));
        return (
          <g
            key={part.id}
            transform={`translate(${x} ${y})`}
            data-drawing-badge={part.id}
            aria-hidden="true"
            onClick={onSelect ? () => onSelect(part.id) : undefined}
          >
            {base.leader && (
              <line
                x1={0}
                y1={0}
                x2={anchor[0] - x}
                y2={anchor[1] - y}
                stroke="var(--text-soft, #686b70)"
                strokeWidth={radius * 0.12}
              />
            )}
            <circle
              r={radius}
              fill={active ? "var(--va-accent, #7665ba)" : "var(--surface-raised, var(--surface-1, #fff))"}
              stroke="var(--line-strong, #687078)"
              strokeWidth={radius * 0.12}
            />
            <text
              dy=".34em"
              textAnchor="middle"
              fill={active ? "var(--surface-1, #fff)" : "var(--text, #202428)"}
              fontFamily="system-ui,sans-serif"
              fontWeight="600"
              fontSize={radius * 1.15}
            >
              {i + 1}
            </text>
          </g>
        );
      })}
      {onPosition && block.handles?.map((handle, i) => <IllustrationHandleTrack key={i} handle={handle} color={handleColor(block,handle)}
        value={positions?.[i] ?? handle.initial ?? 0} radius={radius * .7} onChange={value => onPosition(i, value)} />)}
    </svg>
  );
}

export function ArtifactIllustrationView({
  block,
  title,
  onAskPart,
  visible = true,
}: {
  block: ArtifactIllustration;
  title?: string;
  onAskPart?: (context: string) => void;
  visible?: boolean;
}) {
  const [chosenStage, setChosenStage] = useState(0);
  const [manual, setManual] = useState(() => block.handles?.map(h => h.initial ?? 0) ?? []);
  const [selected, setSelected] = useState<string>();
  const container = useRef<HTMLDivElement>(null);
  const duration = block.animation?.duration ?? ((block.states?.items.length ?? 1) - 1) * 1.5;
  const playback = useArtifactPlayback(duration, block.animation?.loop ?? false, visible, container);
  const positions = useMemo(() => currentHandlePositions(block.handles ?? [], manual, block.animation, playback.time),
    [block, manual, playback.time]);
  const moveHandle = (index: number, value: number) => {
    const track = block.animation?.tracks.find(t => "handle" in t && t.handle === index);
    if (track) playback.seek(animationTimeForValue(track.keys, value, playback.time));
    else setManual(previous => previous[index] === value ? previous : previous.map((p, i) => i === index ? value : p));
  };
  const stage = block.animation ? chosenStage : Math.floor(playback.time / 1.5);
  const setStage = (next: number) => block.animation ? setChosenStage(next) : playback.seek(next * 1.5);
  const [saveError, setSaveError] = useState("");
  const group = useRef<HTMLDivElement>(null);
  const detailId = useId();
  const controlId = useId();
  const activeStage = block.states?.items[stage];
  const activeParts = block.parts.filter(
    (p) => p.selectable && !activeStage?.changes.some((c) => c.part === p.id && c.hidden)
  );
  const part = activeParts.find((p) => p.id === selected);
  const toggle = (id: string) => setSelected(id === selected ? undefined : id);
  function stepPart(event: KeyboardEvent<HTMLButtonElement>, i: number) {
    const count = activeParts.length;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (i + 1) % count;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (i + count - 1) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelected(activeParts[next].id);
    group.current?.querySelectorAll("button")[next]?.focus();
  }
  const quote = part?.quote;
  const start = quote ? block.passage.indexOf(quote) : -1;
  const numbered = block.parts.filter((p) => p.selectable);
  return (
    <div className="artifact-illustration" ref={container}>
      <ArtifactIllustrationDiagram block={block} stage={stage} selected={part?.id} onSelect={toggle}
        positions={positions} onPosition={moveHandle} time={playback.time} />
      {duration > 0 && <div className="artifact-illustration__playback">
        <button type="button" className="visual-artifact__minor-button" onClick={playback.toggle}
          aria-label={(playback.playing ? "Pause " : playback.time === duration ? "Replay " : "Play ") + (block.animation?.label ?? "stages")}>
          {playback.playing ? "Pause" : playback.time === duration ? "Replay" : "Play"} {block.animation?.label ?? "stages"}
        </button>
        {block.animation && <label>
          <input type="range" min={0} max={duration} step="any" value={playback.time} aria-label="Animation time"
            aria-valuetext={playback.time.toFixed(1) + " of " + duration + " seconds"}
            onKeyDown={event => {
              if (!["ArrowLeft","ArrowDown","ArrowRight","ArrowUp","Home","End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              const step = duration * (event.shiftKey ? .1 : .01);
              playback.seek(event.key === "Home" ? 0 : event.key === "End" ? duration :
                playback.time + (event.key === "ArrowLeft" || event.key === "ArrowDown" ? -step : step));
            }} onChange={event => playback.seek(event.currentTarget.valueAsNumber)} />
          <span aria-hidden="true">{playback.time.toFixed(1)} / {duration} s</span>
        </label>}
      </div>}
      {block.handles && <div className="artifact-illustration__handles">
        {block.handles.map((handle, i) => {
          const value = positions[i] ?? handle.initial ?? 0;
          const reading = handleValueText(handle, value);
          return <div key={i} className="artifact-illustration__handle" style={{"--handle-color":handleColor(block,handle)} as CSSProperties}>
            <label><span>{handle.label}</span><span className="artifact-illustration__value" aria-hidden="true">{reading}</span>
              <input type="range" min="0" max="1" step=".01" value={value} aria-label={handle.label}
                aria-describedby={controlId + "-" + i} aria-valuetext={reading} onChange={event => moveHandle(i, Number(event.currentTarget.value))} /></label>
            <div className="artifact-illustration__ends" id={controlId + "-" + i}><span>{handle.ends[0]}</span><span>{handle.ends[1]}</span></div>
          </div>;
        })}
      </div>}
      <div className="artifact-illustration__parts" role="group" aria-label="Explore parts" ref={group}>
        {activeParts.map((p, i) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={p.id === part?.id}
            aria-controls={detailId}
            onClick={() => toggle(p.id)}
            onKeyDown={(event) => stepPart(event, i)}
          >
            <span aria-hidden="true">{numbered.indexOf(p) + 1}</span>
            {p.name}
          </button>
        ))}
      </div>
      <div id={detailId} aria-live="polite" className="artifact-illustration__detail">
        {part ? (
          <>
            <strong>{part.name}</strong>
            <p>{part.about}</p>
            <details>
              <summary>Source passage</summary>
              <blockquote>
                {block.passage.slice(0, start)}
                <mark>{quote}</mark>
                {block.passage.slice(start + (quote?.length ?? 0))}
              </blockquote>
            </details>
            {onAskPart && (
              <button
                className="visual-artifact__minor-button"
                type="button"
                onClick={() => onAskPart(`Explain ${part.name} in this passage.\n\n${block.passage}`)}
              >
                Ask about this part
              </button>
            )}
          </>
        ) : block.handles || block.animation ? <details><summary>Source for the movement</summary>
          {block.handles?.map((h,i) => <p key={i}><strong>{h.label}</strong> · <q>{h.quote}</q></p>)}
          {block.animation && <p><strong>{block.animation.label}</strong> · <q>{block.animation.quote}</q></p>}
        </details> : <p>Choose a numbered part to explore it.</p>}
      </div>
      {block.states && (
        <div className="artifact-illustration__stages">
          {block.states.items.length > 5 ? (
            <label>
              {block.states.label} <strong>{activeStage?.label}</strong>
              <input
                type="range"
                min={0}
                max={block.states.items.length - 1}
                step={1}
                value={stage}
                aria-valuetext={activeStage?.label}
                aria-label={block.states.label}
                onChange={(event) => setStage(Number(event.target.value))}
              />
            </label>
          ) : (
            <div role="group" aria-label={block.states.label}>
              {block.states.items.map((item, i) => (
                <button type="button" key={i} aria-pressed={i === stage} onClick={() => setStage(i)}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <p className="visual-artifact__caption" aria-live="polite">
            {activeStage?.caption}
          </p>
        </div>
      )}
      <footer className="artifact-illustration__export">
        <button
          type="button"
          className="visual-artifact__minor-button"
          onClick={async () => {
            const figure = container.current?.querySelector<SVGSVGElement>(".artifact-illustration__figure");
            if (!figure) return;
            setSaveError("");
            const fileTitle = [title || numbered.map((p) => p.name).join(", "), activeStage?.label]
              .filter(Boolean)
              .join(" — ");
            try {
              await saveIllustrationSvg(figure, fileTitle);
            } catch (error) {
              setSaveError(error instanceof Error ? error.message : "Orion could not save this SVG.");
            }
          }}
        >
          Save SVG
        </button>
        {saveError && <p role="alert">{saveError}</p>}
      </footer>
    </div>
  );
}

/** A script-free illustration, including every stage and quoted part, for print
 * and readers without the interactive HTML viewer. */
export function ArtifactIllustrationSnapshot({ block }: { block: ArtifactIllustration }) {
  return (
    <div className="artifact-illustration__snapshot">
      {block.handles || block.animation ? (
        illustrationPoses(block).map((pose, i) => <figure key={i}>
          <ArtifactIllustrationDiagram block={block} stage={pose.stage} positions={pose.positions} time={pose.time} />
          <figcaption><strong>{pose.label}</strong>{block.states?.items[pose.stage] && " · " + block.states.items[pose.stage].caption}</figcaption>
        </figure>)
      ) : block.states ? (
        block.states.items.map((stage, i) => (
          <figure key={i}>
            <ArtifactIllustrationDiagram block={block} stage={i} />
            <figcaption>
              <strong>{stage.label}</strong> · {stage.caption}
            </figcaption>
          </figure>
        ))
      ) : (
        <ArtifactIllustrationDiagram block={block} stage={0} />
      )}
      {block.handles?.map((handle, i) => <p key={i}><strong>{handle.label}</strong> · {handle.ends.join(" → ")}. <q>{handle.quote}</q></p>)}
      {block.animation && <p><strong>{block.animation.label}</strong> · <q>{block.animation.quote}</q></p>}
      <ol>
        {block.parts
          .filter((p) => p.selectable)
          .map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> · {p.about} <q>{p.quote}</q>
            </li>
          ))}
      </ol>
    </div>
  );
}
