import { evaluateArtifactExpression, type ArtifactBlock, type ArtifactExpression } from "./visualArtifacts";
import { formatArtifactQuantity } from "./visualArtifactQuantity";

export type CalculatorBlock = Extract<ArtifactBlock, {kind: "calculator"}>;
export type CalculatorInput = CalculatorBlock["inputs"][number];
export type CalculatorOutput = CalculatorBlock["outputs"][number];

// HTML ranges count decimal steps from min. Work in decimal ticks so a range
// such as 0.1…0.35 by 0.1 ends at exactly 0.3, as it does on the slider.
function decimalParts(value: number) {
  const [coefficient, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  return { digits: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
}

export function sliderGrid(input: CalculatorInput) {
  const decimals = [input.min, input.max, input.step].map(decimalParts);
  const exponent = Math.min(...decimals.map(decimal => decimal.exponent));
  const [min, max, step] = decimals.map(decimal => decimal.digits * 10n ** BigInt(decimal.exponent - exponent));
  const last = (max - min) / step;
  const valueAt = (tick: bigint) => Number(`${min + tick * step}e${exponent}`);
  const clampTick = (tick: bigint) => tick < 0n ? 0n : tick > last ? last : tick;
  function nearestTick(target: number) {
    if (target <= input.min) return 0n;
    if (target >= input.max) return last;
    const wanted = decimalParts(target), common = Math.min(wanted.exponent, exponent);
    const scale = 10n ** BigInt(exponent - common);
    const delta = wanted.digits * 10n ** BigInt(wanted.exponent - common) - min * scale;
    return clampTick((2n * delta + step * scale) / (2n * step * scale));
  }
  return { last, valueAt, clampTick, nearestTick, includesZero: min < 0n && max > 0n && min % step === 0n };
}

export function valueAtFraction(input: CalculatorInput, fraction: number) {
  const grid = sliderGrid(input);
  // Use the integer grid even when the input's decimals are very small.
  const precision = 1_000_000n;
  const scaled = BigInt(Math.round(Math.max(0, Math.min(1, fraction)) * Number(precision)));
  return grid.valueAt((scaled * grid.last + precision / 2n) / precision);
}

export function outputText(output: CalculatorOutput, value: number | null) {
  return output.labels?.find(entry => entry.value === value)?.label ?? formatArtifactQuantity(value, output.unit);
}

export function countGroups(block: CalculatorBlock, results: (number | null)[]) {
  if (!block.counts) return null;
  const groups = block.counts.outputs.map(i => results[i]);
  if (!groups.every((v): v is number => v !== null && Number.isInteger(v) && v >= 0)) return null;
  return groups.reduce((sum, value) => sum + value, 0) === block.counts.total ? groups : null;
}

const signs = {add: "+", subtract: "−", multiply: "×", divide: "÷"} as const;

// Derive the working from the same tree as the displayed value. Resolve the
// condition first so a hidden (possibly undefined) branch isn't reported as a step.
export function expressionWorking(expression: ArtifactExpression, inputs: CalculatorInput[], values: number[]) {
  const steps: string[] = [];
  const num = (value: number | null) => formatArtifactQuantity(value, "");
  function walk(expr: ArtifactExpression): string {
    if (typeof expr === "number") return num(expr);
    if ("input" in expr) return inputs[expr.input].label + " (" + num(values[expr.input]) + ")";
    const result = num(evaluateArtifactExpression(expr, values));
    let operation: string;
    if (expr.op === "periodicPayment") {
      const principal = walk(expr.principal), rate = walk(expr.ratePerPeriod), periods = walk(expr.periods);
      operation = evaluateArtifactExpression(expr.ratePerPeriod, values) === 0
        ? principal + " ÷ " + periods
        : principal + " × " + rate + " ÷ [1 − (1 + " + rate + ")^(−" + periods + ")]";
    } else if (expr.op === "round") {
      operation = "Round " + walk(expr.value) + " to the nearest whole number";
    } else {
      const left = walk(expr.left), right = walk(expr.right);
      if (expr.op === "ifLess") {
        const a = evaluateArtifactExpression(expr.left, values), b = evaluateArtifactExpression(expr.right, values);
        if (a === null || b === null) return result;
        const condition = a < b;
        steps.push(left + (condition ? " < " : " ≥ ") + right);
        const chosen = condition ? expr.then : expr.else;
        const branch = walk(chosen);
        if (typeof chosen === "number" || "input" in chosen) steps.push("Use " + branch);
        return branch;
      }
      operation = expr.op === "min" || expr.op === "max" ? expr.op + "(" + left + ", " + right + ")"
        : left + " " + signs[expr.op] + " " + right;
    }
    steps.push(operation + " = " + result);
    return result;
  }
  const value = walk(expression);
  return steps.length ? steps : [value];
}

export function calculatorExplanationText(block: CalculatorBlock, values: number[]) {
  return block.explanation?.map(part => {
    if (typeof part === "string") return part;
    if ("input" in part) return formatArtifactQuantity(values[part.input], block.inputs[part.input].unit);
    const output = block.outputs[part.output];
    return outputText(output, evaluateArtifactExpression(output.expression, values));
  }).join("");
}
