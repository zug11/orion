import { useId, useState, type ReactNode } from "react";
import { compositionFrame, type ArtifactComposition, type CompositionControl } from "../lib/artifactComposition";
import "./ArtifactCompositionView.css";

function Choice({ control, value, onChange }: { control: CompositionControl; value: number; onChange: (value: number) => void }) {
  const group = useId();
  if (control.options.length > 3) return <label className="va-layout-select">{control.label}
    <select value={value} onChange={event => onChange(Number(event.currentTarget.value))}>
      {control.options.map((option, i) => <option key={i} value={i}>{option}</option>)}
    </select>
  </label>;
  return <fieldset className="va-layout-choice"><legend>{control.label}</legend>
    <div>{control.options.map((option, i) => <label key={i}>
      <input type="radio" name={group} checked={i === value} onChange={() => onChange(i)} />
      <span>{option}</span>
    </label>)}</div>
  </fieldset>;
}

export function ArtifactCompositionView({ layout, renderBlock }: {
  layout: ArtifactComposition;
  renderBlock: (index: number, stage: number | undefined, visible: boolean) => ReactNode;
}) {
  const [values, setValues] = useState(() => layout.controls.map(control => control.initial ?? 0));
  return <div className="va-layout">{layout.rows.map((row, r) => {
    // Keep study answers and slider edits when a choice temporarily hides a cell.
    const visible = row.map(cell => !("when" in cell && cell.when?.some(condition => values[condition.control] !== condition.is)));
    const cells = row.map((cell, c) => {
      let content: ReactNode;
      if ("control" in cell) {
        content = <Choice control={layout.controls[cell.control]} value={values[cell.control]}
          onChange={next => setValues(previous => previous.map((v, i) => i === cell.control ? next : v))} />;
      } else if ("readout" in cell) {
        content = <div className="va-layout-reading"><span>{cell.label}</span>
          <output aria-label={cell.label}>{cell.values[values[cell.readout]]}</output></div>;
      } else {
        content = renderBlock(cell.block, cell.stageControls && compositionFrame(cell.stageControls, layout.controls, values), visible[c]);
      }
      return <div key={c} className="va-layout-cell" hidden={!visible[c]}>{content}</div>;
    });
    return <div key={r} className="va-layout-row" hidden={!visible.some(Boolean)}>{cells}</div>;
  })}</div>;
}
