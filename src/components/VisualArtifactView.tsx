import { memo, useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Layers3 } from '../lib/icons';
import {
  evaluateArtifactExpression,
  type ArtifactBlock,
  type ArtifactFormat,
  type ArtifactShape,
  type VisualArtifact,
} from '../lib/visualArtifacts';
import './VisualArtifactView.css';

type Block<K extends ArtifactBlock['kind']> = Extract<ArtifactBlock, { kind: K }>;

const formatNames: Record<ArtifactFormat, string> = {
  timeline: 'Timeline', explainer: 'Explainer', comparison: 'Comparison',
  quiz: 'Quiz', flashcards: 'Flashcards', calculator: 'Calculator',
};

function Navigation({ index, count, noun, onChange }: {
  index: number; count: number; noun: string; onChange: (index: number) => void;
}) {
  return (
    <div className="visual-artifact__navigation">
      <span aria-live="polite">{noun} {index + 1} of {count}</span>
      {count > 1 && <div>
        <button type="button" aria-label={`Previous ${noun.toLowerCase()}`}
          title={`Previous ${noun.toLowerCase()}`} disabled={index === 0} onClick={() => onChange(index - 1)}>
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label={`Next ${noun.toLowerCase()}`}
          title={`Next ${noun.toLowerCase()}`} disabled={index === count - 1} onClick={() => onChange(index + 1)}>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>}
    </div>
  );
}

function Steps({ block }: { block: Block<'steps'> }) {
  const [open, setOpen] = useState<number | null>(0);
  const id = useId();
  return (
    <ol className="visual-artifact__steps">
      {block.items.map((item, index) => (
        <li key={index} data-open={open === index}>
          <button type="button" aria-expanded={open === index} aria-controls={`${id}-${index}`}
            onClick={() => setOpen(open === index ? null : index)}>
            <span className="visual-artifact__step-label">{item.label}</span>{' '}
            <span className="visual-artifact__step-heading">{item.heading}</span>
          </button>
          <p id={`${id}-${index}`} hidden={open !== index}>{item.text}</p>
        </li>
      ))}
    </ol>
  );
}

function Quiz({ block }: { block: Block<'quiz'> }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const question = block.items[index];
  const selected = answers[index];
  const answered = selected !== undefined;
  const questionId = useId();
  return (
    <div className="visual-artifact__exercise">
      <div className="visual-artifact__question" id={questionId}>{question.question}</div>
      <div className="visual-artifact__choices" role="group" aria-labelledby={questionId}>
        {question.choices.map((choice, i) => (
          <button key={i} type="button" aria-pressed={selected === i}
            data-correct={answered && question.answer === i}
            onClick={() => setAnswers({ ...answers, [index]: i })}>
            <span className="visual-artifact__choice-letter" aria-hidden="true">
              {answered && question.answer === i ? <Check size={14} /> : String.fromCharCode(65 + i)}
            </span>
            {choice}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {answered && <p className="visual-artifact__feedback">
          <strong>{selected === question.answer ? 'Correct.' : `Correct answer: ${question.choices[question.answer]}.`}</strong>
          {' '}{question.explanation}
        </p>}
      </div>
      <Navigation index={index} count={block.items.length} noun="Question" onChange={setIndex} />
    </div>
  );
}

function Cards({ block }: { block: Block<'cards'> }) {
  const [index, setIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const answerId = useId();
  return (
    <div className="visual-artifact__exercise">
      <div className="visual-artifact__flashcard">
        <div className="visual-artifact__question">{block.items[index].front}</div>
        <p id={answerId} hidden={!showAnswer}>{block.items[index].back}</p>
        <button type="button" className="visual-artifact__minor-button" aria-expanded={showAnswer}
          aria-controls={answerId} onClick={() => setShowAnswer(!showAnswer)}>
          {showAnswer ? 'Hide answer' : 'Show answer'}
        </button>
      </div>
      <Navigation index={index} count={block.items.length} noun="Card" onChange={next => {
        setIndex(next);
        setShowAnswer(false);
      }} />
    </div>
  );
}

// Use significant digits so small probabilities and unit conversions stay visible.
const numberFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 10 });
function quantity(value: number, unit: string) {
  return [numberFormat.format(value), unit].filter(Boolean).join(' ');
}

function Calculator({ block }: { block: Block<'calculator'> }) {
  const [values, setValues] = useState(() => block.inputs.map(input => input.initial));
  const id = useId();
  return (
    <div className="visual-artifact__calculator">
      <div className="visual-artifact__inputs">
        {block.inputs.map((input, index) => (
          <label key={index} htmlFor={`${id}-${index}`}>
            <span>{input.label}</span>
            <span className="visual-artifact__value" aria-hidden="true">{quantity(values[index], input.unit)}</span>
            <input id={`${id}-${index}`} type="range" min={input.min} max={input.max} step={input.step}
              value={values[index]} aria-label={input.label} aria-valuetext={quantity(values[index], input.unit)}
              onChange={event => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isFinite(value)) setValues(values.map((old, i) => i === index ? value : old));
              }} />
          </label>
        ))}
      </div>
      <dl className="visual-artifact__results" aria-live="polite" aria-atomic="true">
        {block.outputs.map((output, index) => {
          const result = evaluateArtifactExpression(output.expression, values);
          return <div key={index}>
            <dt>{output.label}</dt>
            <dd>{result === null ? 'Undefined' : quantity(result, output.unit)}</dd>
          </div>;
        })}
      </dl>
    </div>
  );
}

function DrawShape({ shape, level }: { shape: ArtifactShape; level: number | null }) {
  const paint = {
    fill: shape.fill === 'none' ? 'none' : `var(--va-${shape.fill})`,
    stroke: shape.stroke === 'none' ? 'none' : `var(--va-${shape.stroke})`,
    strokeWidth: 2, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const,
  };
  switch (shape.kind) {
    case 'path': return <path d={shape.d} {...paint} />;
    case 'circle': return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint} />;
    case 'rect': {
      const height = shape.height * (shape.level ? level ?? 0 : 1);
      if (height === 0) return null;
      return <rect x={shape.x} y={shape.y + shape.height - height} width={shape.width} height={height} {...paint} />;
    }
  }
}

const diagramWidth = 640;
function sceneLayout(nodes: Block<'scene'>['nodes']) {
  const columns = Math.min(nodes.length, 4);
  const rows = Math.ceil(nodes.length / columns);
  const spreadY = Math.max(...nodes.map(node => node.y)) - Math.min(...nodes.map(node => node.y));
  const height = Math.max(rows * 150 + 44, spreadY < 20 ? 206 : 314);
  const size = nodes.length > 4 ? 62 : 78;
  const insetX = 73, top = 50, bottom = 78;
  const points = nodes.map(node => ({
    x: insetX + (diagramWidth - 2 * insetX) * node.x / 100,
    y: top + (height - top - bottom) * node.y / 100,
  }));
  const overlap = points.some((p, i) => points.slice(i + 1).some(q =>
    Math.abs(p.x - q.x) < size + 25 && Math.abs(p.y - q.y) < size + 39));
  // Closely placed generated subjects still need distinct, readable labels.
  if (overlap) {
    points.forEach((p, i) => {
      const row = Math.floor(i / columns);
      const rowCount = Math.min(columns, nodes.length - row * columns);
      p.x = diagramWidth * ((i % columns) + 0.5) / rowCount;
      p.y = (row + 0.5) * height / rows - 17;
    });
  }
  return { points, size, height };
}

type Point = { x: number; y: number };
type Obstacle = { left: number; top: number; right: number; bottom: number; subject?: Point };

function crossesBox(a: Point, b: Point, box: Obstacle) {
  // Clipping against the open interior lets a line skirt a box at its corner.
  let first = 0, last = 1;
  for (const [origin, delta, low, high] of [
    [a.x, b.x - a.x, box.left + 0.01, box.right - 0.01],
    [a.y, b.y - a.y, box.top + 0.01, box.bottom - 0.01],
  ]) {
    if (delta === 0) {
      if (origin <= low || origin >= high) return false;
      continue;
    }
    const t1 = (low - origin) / delta, t2 = (high - origin) / delta;
    first = Math.max(first, Math.min(t1, t2));
    last = Math.min(last, Math.max(t1, t2));
    if (first >= last) return false;
  }
  return true;
}

function sceneRoutes(layout: ReturnType<typeof sceneLayout>, flows: Block<'scene'>['frames'][number]['flows']) {
  const radius = layout.size / 2 + 6;
  const obstacles: Obstacle[] = layout.points.flatMap(p => [
    { left: p.x - radius, top: p.y - radius, right: p.x + radius, bottom: p.y + radius, subject: p },
    { left: p.x - layout.size * .82, top: p.y + layout.size / 2,
      right: p.x + layout.size * .82, bottom: p.y + layout.size / 2 + 36 },
  ]);
  const clear = (a: Point, b: Point) => !obstacles.some(box =>
    box.subject !== a && box.subject !== b && crossesBox(a, b, box));
  const corners = obstacles.flatMap(box => [
    { x: box.left, y: box.top }, { x: box.right, y: box.top },
    { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom },
  ]);
  const coordinate = (p: Point) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
  function edge(p: Point, toward: Point): Point {
    const dx = toward.x - p.x, dy = toward.y - p.y;
    const ratio = radius / Math.max(Math.abs(dx), Math.abs(dy));
    return { x: p.x + dx * ratio, y: p.y + dy * ratio };
  }
  return flows.map(flow => {
    const start = layout.points[flow.from], end = layout.points[flow.to];
    if (clear(start, end)) {
      const a = edge(start, end), b = edge(end, start);
      if (!flows.some(other => other.from === flow.to && other.to === flow.from)) {
        return `M ${coordinate(a)} L ${coordinate(b)}`;
      }
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      const control = { x: (a.x + b.x) / 2 - 16 * dy / length, y: (a.y + b.y) / 2 + 16 * dx / length };
      if (clear(start, control) && clear(control, end)) return `M ${coordinate(a)} Q ${coordinate(control)} ${coordinate(b)}`;
    }
    // Shortest visible route via the corners of subject drawings and captions.
    // With eight subjects at most, this graph is small and local to the frame.
    const points = [start, end, ...corners];
    const distances = points.map(() => Infinity);
    const previous = points.map(() => -1);
    const visited = new Set<number>();
    distances[0] = 0;
    while (!visited.has(1)) {
      let nearest = -1;
      for (let i = 0; i < points.length; i++) {
        if (!visited.has(i) && distances[i] < (nearest < 0 ? Infinity : distances[nearest])) nearest = i;
      }
      if (nearest < 0) return null;
      visited.add(nearest);
      if (nearest === 1) break;
      const a = points[nearest];
      for (let j = 1; j < points.length; j++) {
        if (visited.has(j)) continue;
        const b = points[j];
        const length = distances[nearest] + Math.hypot(b.x - a.x, b.y - a.y);
        if (length < distances[j] && clear(a, b)) {
          distances[j] = length;
          previous[j] = nearest;
        }
      }
    }
    const route = [end];
    for (let i = previous[1]; i >= 0; i = previous[i]) route.unshift(points[i]);
    route[0] = edge(start, route[1]);
    route[route.length - 1] = edge(end, route[route.length - 2]);
    return route.map((p, i) => `${i === 0 ? 'M' : 'L'} ${coordinate(p)}`).join(' ');
  });
}

function Scene({ block }: { block: Block<'scene'> }) {
  const [index, setIndex] = useState(0);
  const id = useId();
  const frame = block.frames[index];
  const layout = useMemo(() => sceneLayout(block.nodes), [block.nodes]);
  const routes = useMemo(() => sceneRoutes(layout, frame.flows), [layout, frame.flows]);
  function selectWithKeys(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    let next: number;
    switch (event.key) {
      case 'ArrowRight': next = (current + 1) % block.frames.length; break;
      case 'ArrowLeft': next = (current + block.frames.length - 1) % block.frames.length; break;
      case 'Home': next = 0; break;
      case 'End': next = block.frames.length - 1; break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    setIndex(next);
    document.getElementById(`${id}-stage-${next}`)?.focus();
  }
  return (
    <div className="visual-artifact__scene">
      {block.frames.length > 1 && <div className="visual-artifact__tabs" role="tablist" aria-label="Diagram stages">
        {block.frames.map((stage, i) => <button key={i} id={`${id}-stage-${i}`} role="tab" type="button"
          aria-selected={index === i} tabIndex={index === i ? 0 : -1} aria-controls={`${id}-diagram`}
          onKeyDown={event => selectWithKeys(event, i)} onClick={() => setIndex(i)}>{stage.label}</button>)}
      </div>}
      <div id={`${id}-diagram`} role={block.frames.length > 1 ? 'tabpanel' : 'group'}
        aria-labelledby={block.frames.length > 1 ? `${id}-stage-${index}` : undefined}
        aria-label={block.frames.length === 1 ? frame.label : undefined}>
        <div className="visual-artifact__plot" data-list={block.nodes.some((node, i) => node.label.length > 32 || frame.values[i].length > 28)}
          style={{ "--va-aspect": `${diagramWidth} / ${layout.height}` } as CSSProperties}>
          <svg className="visual-artifact__connections" viewBox={`0 0 ${diagramWidth} ${layout.height}`}
            aria-hidden="true" focusable="false">
            <defs><marker id={`${id}-tip`} viewBox="0 0 9 9" refX="8" refY="4.5"
              markerWidth="6" markerHeight="6" orient="auto">
              <path d="M1 1 L8 4.5 L1 8" fill="none" stroke="var(--va-accent)" strokeWidth="1.5" />
            </marker></defs>
            {routes.map((d, i) => d && (
              <path key={i} d={d} fill="none" stroke="var(--va-accent)" strokeWidth="2"
                strokeLinejoin="round" markerEnd={`url(#${id}-tip)`} />
            ))}
          </svg>
          {block.nodes.map((node, i) => {
            const point = layout.points[i];
            const style = {
              left: `${100 * point.x / diagramWidth}%`, top: `${100 * point.y / layout.height}%`,
              "--va-subject-width": `${100 * layout.size / diagramWidth}%`,
            } as CSSProperties;
            return <figure key={i} className="visual-artifact__subject" style={style}>
              <svg viewBox="0 0 100 100" role="img" aria-label={node.alt} focusable="false">
                {node.shapes.map((shape, j) => <DrawShape key={j} shape={shape} level={frame.levels[i]} />)}
              </svg>
              <figcaption><strong>{node.label}</strong>{frame.values[i] && <span>{frame.values[i]}</span>}</figcaption>
            </figure>;
          })}
        </div>
        {frame.flows.length > 0 && <ul aria-label="Connections" className="visual-artifact__flows">
          {frame.flows.map((flow, i) => <li key={i}>
            {block.nodes[flow.from].label} <ArrowRight size={13} aria-label="to" role="img" /> {block.nodes[flow.to].label}
            {flow.label && <strong>{flow.label}</strong>}
          </li>)}
        </ul>}
        <p className="visual-artifact__caption">{frame.caption}</p>
      </div>
    </div>
  );
}

function RenderBlock({ block, title }: { block: ArtifactBlock; title: string }) {
  switch (block.kind) {
    case 'scene': return <Scene block={block} />;
    case 'steps': return <Steps block={block} />;
    case 'quiz': return <Quiz block={block} />;
    case 'cards': return <Cards block={block} />;
    case 'calculator': return <Calculator block={block} />;
    case 'table': return (
      <div className="visual-artifact__table" tabIndex={0} role="region" aria-label={`${title} table`}>
        <table aria-label={title}>
          <thead><tr>{block.columns.map((column, i) => <th key={i} scope="col">{column}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, i) => <tr key={i}>
            {row.map((cell, j) => j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    );
    case 'text': return <div className="visual-artifact__text">
      {block.heading && <h4>{block.heading}</h4>}<p>{block.text}</p>
    </div>;
  }
}

export const VisualArtifactView = memo(function VisualArtifactView({ artifact }: { artifact: VisualArtifact }) {
  const titleId = useId();
  // A reparse of identical Markdown preserves a reader's place. A replaced
  // block resets just its own controls, including answers and slider values.
  const blocks = useMemo(() => artifact.blocks.map((block, index) => (
    <RenderBlock key={`${index}:${JSON.stringify(block)}`} block={block} title={artifact.title} />
  )), [artifact.blocks, artifact.title]);
  return (
    <section className="visual-artifact" data-visual-artifact="" data-narration-ignore="true"
      aria-labelledby={titleId} contentEditable={false} draggable={false}
      onDragStart={event => event.preventDefault()} onDoubleClick={event => event.stopPropagation()}>
      <header className="visual-artifact__header">
        <div className="visual-artifact__format"><Layers3 size={14} aria-hidden="true" />{formatNames[artifact.format]}</div>
        <h3 id={titleId}>{artifact.title}</h3>
        {artifact.summary && <p>{artifact.summary}</p>}
      </header>
      <div className="visual-artifact__blocks">{blocks}</div>
    </section>
  );
});
