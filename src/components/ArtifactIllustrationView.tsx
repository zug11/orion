import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  type ArtifactIllustration,
  type DrawingPaint,
  type DrawingShape,
  type DrawingTone,
} from "../lib/artifactIllustration";
import { illustrationBadges, illustrationLayout } from "../lib/artifactIllustrationLayout";
import { saveIllustrationSvg } from "../lib/illustrationSvg";
import { ArtifactDrawingGlyph } from "./ArtifactDrawingGlyph";
import "./ArtifactIllustrationView.css";

const colors: Record<DrawingTone, string> = {
  accent: "var(--va-accent, #7665ba)",
  warm: "var(--va-warm, #996a21)",
  cool: "var(--va-cool, #377960)",
  rose: "var(--rose, #ac5064)",
  neutral: "var(--text-soft, #515760)",
  ground: "var(--muted, #727980)",
};
const weight: Record<DrawingPaint, number> = {
  outline: 2.4,
  soft: 2,
  fill: 2,
  solid: 0,
  bold: 5.5,
  heavy: 9,
  thin: 1.2,
  dashed: 1.6,
  dotted: 3.4,
  level: 0,
};
function Shape({ shape, level }: { shape: DrawingShape; level?: number }) {
  const filled = { soft: 22, fill: 46, level: 50, solid: 100 };
  const opacity = filled[shape.paint as keyof typeof filled];
  const style = {
    stroke: weight[shape.paint] ? "currentColor" : "none",
    strokeWidth: weight[shape.paint],
    fill: opacity ? "currentColor" : "none",
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
}

type DiagramProps = {
  block: ArtifactIllustration;
  stage: number;
  selected?: string;
  onSelect?: (id: string) => void;
};
export function ArtifactIllustrationDiagram({ block, stage, selected, onSelect }: DiagramProps) {
  const layout = useMemo(() => illustrationLayout(block), [block]);
  const { left, top, width, height } = layout;
  const changes = useMemo(() => block.states?.items[stage]?.changes ?? [], [block, stage]);
  const parts = useMemo(() => block.parts.slice().sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)), [block]);
  const selectable = block.parts.filter((p) => p.selectable);
  const badges = useMemo(() => illustrationBadges(block, changes, layout), [block, changes, layout]);
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
        const dim = selected && selected !== part.id;
        return (
          <g
            key={part.id}
            data-drawing-part={part.id}
            data-selectable={part.selectable || undefined}
            opacity={dim ? 0.44 : part.selectable || change?.emphasis ? 1 : 0.66}
            color={colors[part.tone]}
            onClick={part.selectable && onSelect ? () => onSelect(part.id) : undefined}
          >
            {(change?.shapes ?? part.shapes)?.map((shape, i) => (
              <Shape key={i} shape={shape} level={change?.level ?? part.level} />
            ))}
            {part.icon && <ArtifactDrawingGlyph icon={part.icon} level={change?.level ?? part.level} />}
          </g>
        );
      })}
      {selectable.map((part, i) => {
        const position = badges.get(part.id);
        if (!position) return null;
        const active =
          selected === part.id || (!selected && changes.some((c) => c.part === part.id && c.emphasis));
        return (
          <g
            key={part.id}
            transform={`translate(${position.x} ${position.y})`}
            data-drawing-badge={part.id}
            aria-hidden="true"
            onClick={onSelect ? () => onSelect(part.id) : undefined}
          >
            {position.leader && (
              <line
                x1={0}
                y1={0}
                x2={position.anchor[0] - position.x}
                y2={position.anchor[1] - position.y}
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
    </svg>
  );
}

export function ArtifactIllustrationView({
  block,
  title,
  onAskPart,
}: {
  block: ArtifactIllustration;
  title?: string;
  onAskPart?: (context: string) => void;
}) {
  const [stage, setStage] = useState(0);
  const [selected, setSelected] = useState<string>();
  const container = useRef<HTMLDivElement>(null);
  const [saveError, setSaveError] = useState("");
  const group = useRef<HTMLDivElement>(null);
  const detailId = useId();
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
      <ArtifactIllustrationDiagram block={block} stage={stage} selected={part?.id} onSelect={toggle} />
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
        ) : (
          <p>Choose a numbered part to explore it.</p>
        )}
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
      {block.states ? (
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
