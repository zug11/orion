import { FactSource } from "./ArtifactEvidenceView";
import { useId, useRef, useState } from 'react';
import { evaluateArtifactExpression } from '../lib/visualArtifacts';
import { formatArtifactQuantity } from '../lib/visualArtifactQuantity';
import { countGroups, expressionWorking, outputText, sliderGrid, type CalculatorBlock, type CalculatorInput } from '../lib/visualArtifactCalculator';
import { CalculatorFlow } from './CalculatorFlow';
import { VisualArtifactCalculatorChart } from './VisualArtifactCalculatorChart';
import './VisualArtifactCalculator.css';

function InlineNumber({ input, value, set }: { input: CalculatorInput; value: number; set: (v: number) => void }) {
  const dragging = useRef<{pointer: number; x: number; value: number} | null>(null);
  const display = formatArtifactQuantity(value, input.unit);
  const grid = sliderGrid(input), last = grid.valueAt(grid.last);
  function increment(from: number, steps: number) {
    set(grid.valueAt(grid.clampTick(grid.nearestTick(from) + BigInt(steps))));
  }
  return <span role="slider" tabIndex={0} className="va-calc-scrub" aria-label={'Adjust ' + input.label + ' in explanation'}
    aria-valuemin={input.min} aria-valuemax={last} aria-valuenow={value} aria-valuetext={display}
    title={'Drag or use arrow keys to change ' + input.label} onKeyDown={e => {
      switch (e.key) {
        case 'ArrowLeft': case 'ArrowDown': increment(value, -1); break;
        case 'ArrowRight': case 'ArrowUp': increment(value, 1); break;
        case 'Home': set(input.min); break;
        case 'End': set(last); break;
        default: return;
      }
      e.preventDefault(); e.stopPropagation();
    }}
    onPointerDown={e => {
      if (e.button !== 0 || dragging.current) return;
      e.currentTarget.focus();
      dragging.current = {pointer: e.pointerId, value, x: e.clientX};
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }}
    onPointerMove={e => {
      if (dragging.current?.pointer !== e.pointerId) return;
      increment(dragging.current.value, Math.round((e.clientX - dragging.current.x) / 4));
    }}
    onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }}
    onPointerUp={() => { dragging.current = null; }}>{display}</span>;
}

const dotColors = ['var(--va-accent)', 'var(--va-warm)', 'var(--va-cool)', 'var(--va-muted)', 'var(--va-ink)', 'var(--va-trace)'];
function PopulationGrid({block, results}: {block: CalculatorBlock; results: (number | null)[]}) {
  const [only, setOnly] = useState<number | null>(null);
  const counts = block.counts!, groups = countGroups(block, results);
  if (!groups) return <p>Counts do not add up to {counts.total} at these settings.</p>;
  const cols = Math.ceil(Math.sqrt(counts.total * 2.5));
  const rows = Math.ceil(counts.total / cols);
  let offset = 0;
  return <figure className="va-calc-population">
    <figcaption>One dot per individual · {counts.total.toLocaleString()} total</figcaption>
    <svg viewBox={`0 0 ${cols * 10} ${rows * 10}`} aria-label={groups.map((n,i) => block.outputs[counts.outputs[i]].label + ' ' + n).join(', ')} role="img">
      {groups.map((n,i) => {
        const first = offset;
        offset += n;
        return <g key={i} fill={dotColors[i]} opacity={only === null || only === i ? 1 : .12}>
          {Array.from({length:n}, (_,k) => <circle key={k} cx={Math.floor((first + k) / rows) * 10 + 5} cy={(first + k) % rows * 10 + 5} r="3.4"/>)}
        </g>;
      })}
    </svg>
    <div className="va-calc-presets" aria-label="Highlight groups">{groups.map((n, i) => <button key={i} type="button"
      aria-pressed={only === i} onClick={() => setOnly(only === i ? null : i)}>
      <span className="va-calc-dot" style={{backgroundColor:dotColors[i]}}/>{block.outputs[counts.outputs[i]].label} · {n.toLocaleString()}</button>)}</div>
  </figure>;
}

function RecipeTable({block, values, results, onAddTasks}: {
  block:CalculatorBlock; values:number[]; results:(number | null)[]; onAddTasks?: (tasks:string[])=>boolean;
}) {
  const recipe = block.recipe!, base = block.inputs.map(input => input.initial);
  const [lastWrite, setLastWrite] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const rows = recipe.ingredients.map(i => {
    const out = block.outputs[i];
    return {name: out.label, original: formatArtifactQuantity(evaluateArtifactExpression(out.expression, base), out.unit),
      current: formatArtifactQuantity(results[i], out.unit)};
  });
  const tasks = rows.map(row => row.current + ' ' + row.name);
  const saved = lastWrite?.every((s,i) => s === tasks[i]);
  const serving = block.inputs[recipe.input];
  return <div className="va-calc-recipe">
    <div className="visual-artifact__table" role="region" tabIndex={0} aria-label="Scaled ingredient quantities"><table>
      <thead><tr><th scope="col">Ingredient</th><th scope="col">As written · {formatArtifactQuantity(serving.initial, serving.unit)}</th>
        <th scope="col">For {formatArtifactQuantity(values[recipe.input], serving.unit)}</th></tr></thead>
      <tbody>{rows.map((row,i) => <tr key={i}><th scope="row">{row.name}</th><td>{row.original}</td><td>{row.current}</td></tr>)}</tbody>
    </table></div>
    {onAddTasks && <button type="button" className="visual-artifact__minor-button" disabled={Boolean(saved) || recipe.ingredients.some(i => results[i] === null)}
      onClick={() => { const ok = onAddTasks(tasks); if (ok) setLastWrite(tasks); setFailed(!ok); }}>
        {saved ? 'Shopping list added' : 'Add shopping list as to-dos'}</button>}
    {failed && <small role="status">The note changed. Try adding the shopping list again.</small>}
  </div>;
}

export function VisualArtifactCalculator({block, onAddTasks}: {block: CalculatorBlock; onAddTasks?: (tasks:string[])=>boolean}) {
  const [values, setValues] = useState(() => block.inputs.map(input => input.initial));
  const [working, setWorking] = useState<number | null>(null);
  const id = useId();
  const results = block.outputs.map(output => evaluateArtifactExpression(output.expression, values));
  const changed = block.inputs.some((input,i) => input.initial !== values[i]);
  const set = (i: number, v: number) => {
    if (Number.isFinite(v)) setValues(previous => previous.map((old,j) => i === j ? v : old));
  };
  return <div className="visual-artifact__calculator">
    {block.presets && <div className="va-calc-presets" aria-label="Scenarios">{block.presets.map((preset,i) =>
      <button key={i} type="button" aria-pressed={preset.values.every((v,j) => values[j] === v)} onClick={() => setValues([...preset.values])}>{preset.label}</button>)}</div>}
    {block.explanation && <p className="va-calc-explanation">{block.explanation.map((token,i) => typeof token === 'string' ? token :
      'input' in token ? <InlineNumber key={i} input={block.inputs[token.input]} value={values[token.input]} set={v => set(token.input,v)} /> :
      <strong key={i}>{outputText(block.outputs[token.output], results[token.output])}</strong>)}</p>}
    <div className="visual-artifact__inputs">{block.inputs.map((input,index) => {
      const value = formatArtifactQuantity(values[index], input.unit);
      return <div key={index}><label htmlFor={id + '-slider-' + index}>
        <span>{input.label}</span><span className="visual-artifact__value" aria-hidden="true">{value}</span>
        <input id={id + '-slider-' + index} type="range" min={input.min} max={input.max} step={input.step}
          value={values[index]} aria-label={input.label} aria-valuetext={value} onChange={e => set(index,e.currentTarget.valueAsNumber)}/>
      </label><FactSource field="input" index={index}/></div>;
    })}</div>
    {changed && <button type="button" className="visual-artifact__minor-button va-calc-reset" onClick={() => setValues(block.inputs.map(v => v.initial))}>Back to the passage</button>}
    {block.recipe && <RecipeTable block={block} values={values} results={results} onAddTasks={onAddTasks}/>}
    {block.counts && <PopulationGrid block={block} results={results}/>}
    {block.flow && <CalculatorFlow flow={block.flow} outputs={block.outputs} values={values}/>}
    <dl className="visual-artifact__results" aria-live="polite" aria-atomic="true">
      {block.outputs.map((out,i) => <div key={i}>
        <dt><button type="button" className="va-calc-working-toggle" aria-label={'Show working for ' + out.label}
          aria-controls={id + '-working'} aria-expanded={working === i} onClick={() => setWorking(working === i ? null : i)}>{out.label} <span aria-hidden="true">⌄</span></button></dt>
        <dd data-unavailable={results[i] === null || undefined}>{outputText(out, results[i])}<FactSource field="output" index={i}/></dd>
      </div>)}
    </dl>
    {working !== null && <div className="va-calc-working" id={id + '-working'}><strong>How {block.outputs[working].label.toLowerCase()} is calculated</strong>
      <ol>{expressionWorking(block.outputs[working].expression, block.inputs, values).map((line,i) => <li key={i}>{line}</li>)}</ol></div>}
    <VisualArtifactCalculatorChart block={block} values={values} onSet={set}/>
  </div>;
}
