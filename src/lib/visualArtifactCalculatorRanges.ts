import { evaluateArtifactExpression, type ArtifactBlock, type VisualArtifact } from "./visualArtifacts";

type Calculator = Extract<ArtifactBlock, { kind: "calculator" }>;

// HTML ranges count decimal steps from min. Work in decimal ticks so a range
// such as 0.1…0.35 by 0.1 ends at exactly 0.3, as it does on the slider.
function sliderGrid(input: Calculator["inputs"][number]) {
  const decimals = [input.min, input.max, input.step].map(value => {
    const [coefficient, exponent = "0"] = String(value).split("e");
    const [whole, fraction = ""] = coefficient.split(".");
    return { digits: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
  });
  const exponent = Math.min(...decimals.map(decimal => decimal.exponent));
  const [min, max, step] = decimals.map(decimal => decimal.digits * 10n ** BigInt(decimal.exponent - exponent));
  const last = (max - min) / step;
  const valueAt = (tick: bigint) => Number(`${min + tick * step}e${exponent}`);
  return { last, valueAt, includesZero: min < 0n && max > 0n && min % step === 0n };
}

function validateCalculatorRange({ inputs, outputs }: Calculator) {
  const grids = inputs.map(sliderGrid);
  const exhaustive = grids.reduce((count, grid) => count * (grid.last + 1n), 1n) <= 256n;
  const values = inputs.map(input => input.initial);

  function checkResults() {
    for (const output of outputs) {
      if (evaluateArtifactExpression(output.expression, values) === null) {
        const settings = inputs.map((input, i) => `${input.label} = ${values[i]}`).join(", ");
        throw new Error(`“${output.label}” has no result at ${settings}. Try generating the calculator again.`);
      }
    }
  }

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
