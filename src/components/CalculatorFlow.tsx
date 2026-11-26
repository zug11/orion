import { evaluateArtifactExpression, type ArtifactBlock } from "../lib/visualArtifacts";
import { type ArtifactFlow, withinFlowCapacity } from "../lib/visualArtifactFlow";
import { formatArtifactQuantity } from "../lib/visualArtifactQuantity";

type Outputs = Extract<ArtifactBlock, {kind:"calculator"}>["outputs"];
const colours = ["var(--va-accent)", "var(--va-cool)", "var(--va-warm)", "var(--va-muted)", "var(--va-ink)", "var(--va-trace)"];

export function CalculatorFlow({ flow, outputs, values }: { flow: ArtifactFlow; outputs: Outputs; values: readonly number[] }) {
  const parts = flow.destinations.map(index => outputs[index]);
  const amounts = parts.map(part => evaluateArtifactExpression(part.expression, values));
  if (!withinFlowCapacity(amounts, flow.capacity)) return <p role="status">The quantities at these settings exceed the range of this flow diagram.</p>;
  const total = amounts.reduce<number>((sum, amount) => sum + amount!, 0);
  const display = (amount: number) => formatArtifactQuantity(amount, parts[0].unit);
  // Reserve room for the entire capacity on the right regardless of the split.
  // Stacking each destination's own band plus a fixed gap avoids overlaps at 0% and 100%.
  const height = 84 + 18 * (parts.length - 1);
  const scale = (amount: number) => amount / flow.capacity * 84;
  let y = (height - scale(total)) / 2;
  return <figure className="va-quantity-flow">
    <figcaption><strong>{flow.source}</strong> · {display(total)}</figcaption>
    <svg viewBox={`0 0 400 ${height}`} role="img" aria-label={parts.map((part, i) => part.label + " " + display(amounts[i]!)).join(", ")}>
      {amounts.map((amount, i) => {
        const thickness = scale(amount!);
        const from = y;
        y += thickness;
        const to = from + (i - (parts.length - 1) / 2) * 18;
        return thickness > 0 && <path key={i} fill={colours[i]} opacity={0.76}
          d={`M0 ${from} C190 ${from} 210 ${to} 400 ${to} v${thickness} C210 ${to + thickness} 190 ${y} 0 ${y} Z`} />;
      })}
    </svg>
    <ul>{parts.map((part, i) => <li key={i}><i aria-hidden="true" style={{background: colours[i]}}/>{part.label} · {display(amounts[i]!)}</li>)}</ul>
  </figure>;
}
