import { evaluateArtifactExpression, type ArtifactBlock, type VisualArtifact } from "./visualArtifacts";

import { withinFlowCapacity } from "./visualArtifactFlow";
import { countGroups, sliderGrid } from "./visualArtifactCalculator";

type Calculator = Extract<ArtifactBlock, { kind: "calculator" }>;

function validateCalculatorRange(block: Calculator) {
  const {inputs, outputs} = block;
  const grids = inputs.map(sliderGrid);
  const exhaustive = grids.reduce((count, grid) => count * (grid.last + 1n), 1n) <= 256n;
  const values = inputs.map(input => input.initial);

  function checkResults() {
    const results = outputs.map(output => evaluateArtifactExpression(output.expression, values));
    for (const [i, output] of outputs.entries()) {
      if (results[i] === null) {
        const settings = inputs.map((input, i) => `${input.label} = ${values[i]}`).join(", ");
        throw new Error(`“${output.label}” has no result at ${settings}. Try generating the calculator again.`);
      }
    }
    if (block.flow && !withinFlowCapacity(block.flow.destinations.map(i => results[i]), block.flow.capacity)) {
      throw new Error("A flow needs nonnegative quantities whose sum fits its capacity at every offered setting.");
    }
    if (block.counts && !countGroups(block, results)) {
      throw new Error("The population counts must be whole numbers that add up to the stated total.");
    }
    if (block.recipe && (values[block.recipe.input] <= 0 || block.recipe.ingredients.some(i => results[i]! < 0))) {
      throw new Error("A recipe needs positive servings and nonnegative ingredient amounts.");
    }
  }

  for (const preset of block.presets ?? []) {
    values.splice(0, values.length, ...preset.values);
    checkResults();
  }
  values.splice(0, values.length, ...inputs.map(input => input.initial));

  // Large ranges still cover every combination of defaults and endpoints
  // (at most 3⁶). Probe a reachable interior zero for each slider as well.
  const samples = grids.map((grid, i) => {
    if (exhaustive) return Array.from({ length: Number(grid.last) + 1 }, (_, tick) => grid.valueAt(BigInt(tick)));
    if (grid.includesZero) {
      values[i] = 0;
      checkResults();
      values[i] = inputs[i].initial;
    }
    return [...new Set([inputs[i].min, inputs[i].initial, grid.valueAt(grid.last)])];
  });

  function visit(index: number) {
    if (index === samples.length) return checkResults();
    for (const sample of samples[index]) {
      values[index] = sample;
      visit(index + 1);
    }
  }
  visit(0);
}

/** Existing v1 documents stay readable. Apply generation checks before a new visual is inserted. */
export function validateGeneratedCalculatorRanges(artifact: VisualArtifact) {
  for (const block of artifact.blocks) {
    if (block.kind === "calculator") validateCalculatorRange(block);
  }
}
