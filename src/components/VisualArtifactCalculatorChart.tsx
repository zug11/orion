import { useId, useRef, useState, type PointerEvent } from 'react';
import { evaluateArtifactExpression } from '../lib/visualArtifacts';
import { outputText, sliderGrid, valueAtFraction, type CalculatorBlock } from '../lib/visualArtifactCalculator';
import { formatArtifactQuantity } from '../lib/visualArtifactQuantity';

const left = 16, right = 524, top = 20, bottom = 160;
const paints = ['var(--va-accent)', 'var(--va-warm)', 'var(--va-cool)'];
const dashes = [undefined, '7 3', '2 3'];

export function VisualArtifactCalculatorChart({ block, values, onSet }: {
  block: CalculatorBlock; values: number[]; onSet: (index: number, value: number) => void;
}) {
  const id = useId();
  const [axis, setAxis] = useState(block.chart?.input ?? 0);
  const [output, setOutput] = useState(block.chart?.outputs[0] ?? block.outputs.length - 1);
  const drag = useRef<{id: number; kind: 'axis' | 'curve'} | null>(null);
  const [dragExtent, setDragExtent] = useState<{min: number; max: number} | null>(null);
  const input = block.inputs[axis], grid = sliderGrid(input);
  const series = block.chart?.outputs ?? [output];
  const samples = Math.max(1, Number(grid.last > 64n ? 64n : grid.last));
  const lastValue = grid.valueAt(grid.last);
  const states = Array.from({length: samples + 1}, (_, i) => grid.valueAt((BigInt(i) * grid.last) / BigInt(samples)));
  const points = series.map(index => states.map(v => {
    const settings = [...values];
    settings[axis] = v;
    return evaluateArtifactExpression(block.outputs[index].expression, settings);
  }));
  const readings = series.map(index => evaluateArtifactExpression(block.outputs[index].expression, values));
  const dragInput = block.chart?.dragInput;
  // Leave the handle room to move even if the first curve starts out flat.
  const dragExtremes = dragInput === undefined ? [] : [0, .5, 1].map(fraction => {
    const settings = [...values];
    settings[dragInput] = valueAtFraction(block.inputs[dragInput], fraction);
    return evaluateArtifactExpression(block.outputs[series[0]].expression, settings);
  });
  const numeric = [...points.flat(), ...readings, ...dragExtremes].filter((v): v is number => v !== null);
  const min = dragExtent?.min ?? (numeric.length ? Math.min(...numeric) : 0);
  const max = dragExtent?.max ?? (numeric.length ? Math.max(...numeric) : 0);
  const unit = block.outputs[series[0]].unit;
  const format = (value: number) => series.length === 1 ? outputText(block.outputs[series[0]], value) : formatArtifactQuantity(value, unit);
  // Normalise first so opposite-signed finite extremes do not overflow during scaling.
  const magnitude = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const y = (value: number) => min === max ? (bottom + top) / 2 :
    bottom - (bottom - top) * ((value / magnitude - min / magnitude) / (max / magnitude - min / magnitude));
  const x = (v: number) => lastValue === input.min ? (left + right) / 2 : left + (right - left) * ((v - input.min) / (lastValue - input.min));
  const settleOutput = block.chart?.settleOutput;
  const settle = settleOutput === undefined ? null : evaluateArtifactExpression(block.outputs[settleOutput].expression, values);

  function move(event: PointerEvent<SVGSVGElement>, kind: 'axis' | 'curve') {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const xFraction = ((event.clientX - rect.left) / rect.width * 540 - left) / (right - left);
    if (kind === 'axis') {
      onSet(axis, valueAtFraction(input, xFraction));
    } else if (dragInput !== undefined) {
      const targetY = (event.clientY - rect.top) / rect.height * 180;
      const settings = [...values];
      const candidateGrid = sliderGrid(block.inputs[dragInput]);
      const steps = Math.max(1, Number(candidateGrid.last > 100n ? 100n : candidateGrid.last));
      let closest = values[dragInput], distance = Infinity;
      // Move the first curve to the pointer's height at the current axis setting.
      for (let i = 0; i <= steps; i++) {
        const candidate = candidateGrid.valueAt(BigInt(i) * candidateGrid.last / BigInt(steps));
        settings[dragInput] = candidate;
        const result = evaluateArtifactExpression(block.outputs[series[0]].expression, settings);
        if (result === null) continue;
        const delta = Math.abs(y(result) - targetY);
        if (delta < distance || (delta === distance && Math.abs(candidate - values[dragInput]) < Math.abs(closest - values[dragInput]))) {
          closest = candidate;
          distance = delta;
        }
      }
      onSet(dragInput, closest);
    }
  }
  function finish(pointerId: number) {
    if (!drag.current || drag.current.id !== pointerId) return;
    drag.current = null;
    setDragExtent(null);
  }
  const label = series.map(i => block.outputs[i].label).join(' and ') + ' by ' + input.label;
  return <figure className="va-calc-chart" aria-labelledby={id}>
    <figcaption id={id}>{label}</figcaption>
    {!block.chart && (block.inputs.length > 1 || block.outputs.length > 1) && <div className="va-calc-chart-select">
      {block.inputs.length > 1 && <label>Vary <select value={axis} onChange={e => setAxis(Number(e.target.value))}>
        {block.inputs.map((v, i) => <option key={i} value={i}>{v.label}</option>)}</select></label>}
      {block.outputs.length > 1 && <label>Plot <select value={output} onChange={e => setOutput(Number(e.target.value))}>
        {block.outputs.map((v, i) => <option key={i} value={i}>{v.label}</option>)}</select></label>}
    </div>}
    <div className="va-calc-plot">
      <div className="va-calc-axis-va" aria-hidden="true">
        {numeric.length > 0 && (min === max ? <span className="va-calc-axis-center">{format(min)}</span> :
          <><span>{format(max)}</span><span>{format(min)}</span></>)}
      </div>
    <svg viewBox="0 0 540 180" role="img" aria-label={label} focusable="false" onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      const target = event.target as Element;
      const kind = target.closest('[data-curve-handle]') ? 'curve' : 'axis';
      drag.current = {id: event.pointerId, kind};
      if (kind === 'curve') setDragExtent({min,max});
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      if (kind === 'axis') move(event, kind);
    }} onPointerMove={e => { if (drag.current?.id === e.pointerId) move(e, drag.current.kind); }}
      onPointerUp={e => finish(e.pointerId)} onPointerCancel={e => finish(e.pointerId)}
      onLostPointerCapture={e => finish(e.pointerId)}>
      {[top, (top + bottom) / 2, bottom].map(h => <path key={h} d={`M${left} ${h} H${right}`} className="va-calc-gridline"/>)}
      {min < 0 && max > 0 && <path className="va-calc-zero" d={`M${left} ${y(0)} H${right}`}/>}
      {series.map((index, i) => {
        if (block.outputs[index].labels) return <g key={index} fill={paints[i]}>{points[i].map((value, k) =>
          value === null ? null : <circle key={k} cx={x(states[k])} cy={y(value)} r="2.3"/>)}</g>;
        let penDown = false;
        const path = points[i].map((value, k) => {
          if (value === null) { penDown = false; return ''; }
          const cmd = penDown ? 'L' : 'M';
          penDown = true;
          return cmd + x(states[k]) + ' ' + y(value);
        }).join(' ');
        return <path key={index} d={path} fill="none" stroke={paints[i]} strokeDasharray={dashes[i]} strokeWidth="2.6"/>;
      })}
      <path d={`M${x(values[axis])} ${top} V${bottom}`} className="va-calc-guide" />
      {readings.map((value, i) => value !== null && <g key={i} data-curve-handle={i === 0 && dragInput !== undefined ? '' : undefined}>
        <circle cx={x(values[axis])} cy={y(value)} r="13" fill="transparent" />
        <circle cx={x(values[axis])} cy={y(value)} r="5" fill={paints[i]} stroke="var(--va-surface)" strokeWidth="1.5"/>
      </g>)}
    </svg></div>
    <div className="va-calc-axis"><span>{input.label} · {formatArtifactQuantity(input.min, input.unit)}</span>
      <span>{formatArtifactQuantity(lastValue, input.unit)}</span></div>
    {series.length > 1 && <ul className="va-calc-legend">{series.map((s, i) => <li key={s}>
      <svg viewBox="0 0 22 4" aria-hidden="true"><path d="M0 2 H22" stroke={paints[i]} strokeWidth="3" strokeDasharray={dashes[i]}/></svg>
      {block.outputs[s].label}</li>)}</ul>}
    {dragInput !== undefined && <small>Drag across to change {input.label}. Drag the first curve’s point up or down to adjust {block.inputs[dragInput].label}.</small>}
    {settle !== null && settleOutput !== undefined && <button type="button" className="visual-artifact__minor-button"
      disabled={lastValue === input.min || settle < input.min || settle > lastValue} onClick={() => onSet(axis, grid.valueAt(grid.nearestTick(settle)))}>
      Set {input.label} to {block.outputs[settleOutput].label}</button>}
  </figure>;
}
