import { memo, useId, useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Layers3 } from '../lib/icons';
import {
  evaluateArtifactExpression,
  type ArtifactBlock,
  type ArtifactFormat,
  type ArtifactShape,
  type VisualArtifact,
} from '../lib/visualArtifacts';
import { layoutVisualScene } from '../lib/visualSceneLayout';
import { formatArtifactQuantity } from '../lib/visualArtifactQuantity';
import { VisualArtifactTable } from './VisualArtifactTable';
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

function Calculator({ block }: { block: Block<'calculator'> }) {
  const [values, setValues] = useState(() => block.inputs.map(input => input.initial));
  const id = useId();
  return (
    <div className="visual-artifact__calculator">
      <div className="visual-artifact__inputs">
        {block.inputs.map((input, index) => {
          const displayValue = formatArtifactQuantity(values[index], input.unit);
          return <label key={index} htmlFor={`${id}-${index}`}>
            <span>{input.label}</span>
            <span className="visual-artifact__value" aria-hidden="true">{displayValue}</span>
            <input id={`${id}-${index}`} type="range" min={input.min} max={input.max} step={input.step}
              value={values[index]} aria-label={input.label} aria-valuetext={displayValue}
              onChange={event => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isFinite(value)) setValues(values.map((old, i) => i === index ? value : old));
              }} />
          </label>;
        })}
      </div>
      <dl className="visual-artifact__results" aria-live="polite" aria-atomic="true">
        {block.outputs.map((output, index) => {
          const result = evaluateArtifactExpression(output.expression, values);
          return <div key={index}>
            <dt>{output.label}</dt>
            <dd>{formatArtifactQuantity(result, output.unit)}</dd>
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

function Scene({ block }: { block: Block<'scene'> }) {
  const [index, setIndex] = useState(0);
  const id = useId();
  const frame = block.frames[index];
  const layout = useMemo(() => layoutVisualScene(block, index), [block, index]);
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
        <div className="visual-artifact__plot" data-mode={layout.mode}
          style={{ '--va-aspect': `${layout.width} / ${layout.height}` } as CSSProperties}>
          {layout.connections.length > 0 && <svg className="visual-artifact__connections"
            viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
            <defs>
              <marker id={`${id}-tip`} viewBox="0 0 10 10" refX="9" refY="5"
                markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto">
                <path d="M 1 1.2 L 9 5 L 1 8.8 L 3.2 5 Z" fill="var(--va-trace)" />
              </marker>
            </defs>
            {layout.connections.map(route => <path key={route.index} d={route.d} fill="none"
              stroke="var(--va-trace)" strokeWidth={1.75} strokeLinecap="round"
              markerEnd={`url(#${id}-tip)`} />)}
            {layout.connections.map(route => frame.flows[route.index].label && (
              <text key={route.index} x={route.labelX} y={route.labelY} dy=".32em"
                textAnchor="middle" className="visual-artifact__edge-label">
                {frame.flows[route.index].label}
              </text>
            ))}
          </svg>}
          {layout.subjects.map(subject => {
            const i = subject.index;
            const node = block.nodes[i];
            const style = {
              '--va-left': `${100 * subject.x / layout.width}%`, '--va-top': `${100 * subject.y / layout.height}%`,
              '--va-art-width': `${100 * subject.artSize / layout.width}%`,
              '--va-caption-width': `${100 * subject.width / subject.artSize}%`,
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
            <span className="visual-artifact__flow-from">{block.nodes[flow.from].label}</span>
            <svg className="visual-artifact__flow-direction" viewBox="0 0 48 12"
              role="img" aria-label="to" focusable="false">
              <path d="M1 6 H46 M40 1.5 L46 6 L40 10.5" fill="none" stroke="currentColor"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="visual-artifact__flow-to">{block.nodes[flow.to].label}</span>
            {flow.label && <strong>{flow.label}</strong>}
          </li>)}
        </ul>}
        {layout.context.length > 0 && <dl aria-label="Other readings" className="visual-artifact__context">
          {layout.context.map(i => <div key={i}>
            <dt>{block.nodes[i].label}</dt>
            <dd>{frame.values[i]}{frame.levels[i] !== null &&
              <meter min={0} max={1} value={frame.levels[i]!} aria-label={`${block.nodes[i].label} level`} />}</dd>
          </div>)}
        </dl>}
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
        <VisualArtifactTable block={block} title={title} />
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
