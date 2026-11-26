import type { ArtifactBlock } from "./visualArtifacts";
import { list, literal, object } from "./artifactValidation";

export interface CompositionControl {
  label: string;
  options: string[];
  initial?: number;
}
interface Condition { control: number; is: number }
type Cell = { control: number } |
  ({ when?: Condition[] } & (
    { block: number; stageControls?: number[] } |
    { readout: number; label: string; values: string[] }
  ));

export interface ArtifactComposition {
  controls: CompositionControl[];
  rows: Cell[][];
}

export class ArtifactCompositionError extends Error {}

function layoutError(detail: string): never {
  throw new ArtifactCompositionError("Orion could not read the custom layout. " + detail);
}

function index(value: unknown, count: number) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= count) {
    return layoutError("Use a zero-based index for an existing block, control or option.");
  }
  return value;
}

function readLayout(raw: unknown, blocks: ArtifactBlock[]): ArtifactComposition {
  const layout = object(raw, ["controls", "rows"]);
  const controls = list(layout.controls, 0, 4, rawControl => {
    const control = object(rawControl, ["label", "options", "initial"]);
    const options = list(control.options, 2, 8, option => literal(option, 80));
    if (new Set(options).size !== options.length) return layoutError("Give each option in a control a distinct label.");
    return { label: literal(control.label, 100), options,
      ...(control.initial !== undefined && { initial: index(control.initial, options.length) }) };
  });
  const placedBlocks = new Set<number>();
  const placedControls = new Set<number>();
  const usedControls = new Set<number>();
  function binding(value: unknown) {
    const control = index(value, controls.length);
    usedControls.add(control);
    return control;
  }

  const rows = list(layout.rows, 1, 16, row => list(row, 1, 3, (rawCell): Cell => {
    const cell = object(rawCell, ["control", "block", "stageControls", "readout", "label", "values", "when"]);
    if ("control" in cell) {
      object(cell, ["control"]);
      const control = index(cell.control, controls.length);
      if (placedControls.has(control)) return layoutError("Place each control in exactly one cell.");
      placedControls.add(control);
      return { control };
    }
    const when = cell.when === undefined ? undefined : list(cell.when, 1, controls.length, rawCondition => {
      const condition = object(rawCondition, ["control", "is"]);
      const control = binding(condition.control);
      return { control, is: index(condition.is, controls[control].options.length) };
    });
    if (when && new Set(when.map(condition => condition.control)).size !== when.length) return layoutError("Each condition must test a different control.");
    if ("block" in cell) {
      object(cell, ["block", "stageControls", "when"]);
      const block = index(cell.block, blocks.length);
      if (placedBlocks.has(block)) return layoutError("Place each block in exactly one cell.");
      placedBlocks.add(block);
      const stageControls = cell.stageControls === undefined ? undefined : list(cell.stageControls, 1, controls.length, binding);
      if (stageControls) {
        const frames = stageControls.reduce((count, i) => count * controls[i].options.length, 1);
        const content = blocks[block];
        if (new Set(stageControls).size !== stageControls.length || content.kind !== "scene" || content.frames.length !== frames) {
          return layoutError("stageControls must bind distinct choices to one scene frame per combination.");
        }
      }
      return { block, ...(stageControls && { stageControls }), ...(when && { when }) };
    }
    object(cell, ["readout", "label", "values", "when"]);
    const readout = binding(cell.readout);
    const count = controls[readout].options.length;
    return { readout, label: literal(cell.label, 100), values: list(cell.values, count, count, v => literal(v, 200)), ...(when && { when }) };
  }));
  if (placedBlocks.size !== blocks.length || placedControls.size !== controls.length || usedControls.size !== controls.length) {
    return layoutError("Place every block and control exactly once. Each control must drive a readout, condition or scene.");
  }
  return { controls, rows };
}

export function parseArtifactComposition(raw: unknown, blocks: ArtifactBlock[]) {
  try {
    return readLayout(raw, blocks);
  } catch (error) {
    if (error instanceof ArtifactCompositionError) throw error;
    return layoutError("Check controls and rows. Each cell places one block, control or readout; each reading needs one value per option.");
  }
}

/** Frames follow the Cartesian product of the bound choices, last choice varying fastest. */
export function compositionFrame(axes: number[], controls: CompositionControl[], values: number[]) {
  return axes.reduce((frame, i) => frame * controls[i].options.length + values[i], 0);
}

export function compositionFrameLabel(axes: number[], controls: CompositionControl[], frame: number) {
  const labels: string[] = [];
  for (const i of [...axes].reverse()) {
    const { label, options } = controls[i];
    labels.unshift(label + " = " + options[frame % options.length]);
    frame = Math.floor(frame / options.length);
  }
  return labels.join(" · ");
}
