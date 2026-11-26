import { VisualArtifactTable } from "../components/VisualArtifactTable";
import { evaluateArtifactExpression, type ArtifactBlock } from "./visualArtifacts";
import { readVisualArtifactMarker, unavailableVisualArtifact, visualArtifactMarker } from "./visualArtifactMarkdown";
import { formatArtifactQuantity } from "./visualArtifactQuantity";

function StaticBlock({ block }: { block: ArtifactBlock }) {
  switch (block.kind) {
    case "text": return <div>{block.heading && <h4>{block.heading}</h4>}<p>{block.text}</p></div>;
    case "steps": return <ol>{block.items.map((step, i) =>
      <li key={i}><strong>{step.label} · {step.heading}</strong><p>{step.text}</p></li>)}</ol>;
    case "table": return <VisualArtifactTable block={block} />;
    case "cards": return <div>{block.items.map((card, i) =>
      <div key={i}><h4>{card.front}</h4><p>{card.back}</p></div>)}</div>;
    case "quiz": return <ol>{block.items.map((item, i) =>
      <li key={i}><strong>{item.question}</strong><ol>{item.choices.map((choice, j) => <li key={j}>{choice}</li>)}</ol>
        <p><strong>{item.choices[item.answer]}</strong> · {item.explanation}</p></li>)}</ol>;
    case "scene": return <div>{block.frames.map((frame, i) =>
      <div key={i}><h4>{frame.label}</h4><p>{frame.caption}</p><ul>{block.nodes.map((node, j) =>
        <li key={j}>{node.label}{frame.values[j] ? " · " + frame.values[j] : ""}</li>)}</ul>
        {frame.flows.map((flow, j) => <p key={j}>{block.nodes[flow.from].label} → {block.nodes[flow.to].label} {flow.label}</p>)}</div>)}</div>;
    case "calculator": {
      const initial = block.inputs.map(input => input.initial);
      return <div><ul>{block.inputs.map((input, i) =>
        <li key={i}>{input.label} · {formatArtifactQuantity(input.initial, input.unit)}</li>)}</ul>
        {block.outputs.map((output, i) => <p key={i}>{output.label} · {formatArtifactQuantity(evaluateArtifactExpression(output.expression, initial), output.unit)}</p>)}</div>;
    }
  }
}

/** Printable snapshots include every step, quiz answer and the calculator's initial values. */
export function ExportVisualArtifact({ marker, interactive = false }: { marker: unknown; interactive?: boolean }) {
  const artifact = readVisualArtifactMarker(marker);
  if (!artifact) return <p>{unavailableVisualArtifact}</p>;
  const snapshot = (
    <section className={interactive ? "export-artifact-fallback" : undefined}>
      <h3>{artifact.title}</h3>
      {artifact.summary && <p>{artifact.summary}</p>}
      {artifact.blocks.map((block, i) => <StaticBlock key={i} block={block} />)}
    </section>
  );
  if (!interactive) return snapshot;
  return <>
    <div data-orion-artifact-viewer={visualArtifactMarker(artifact)} />
    {snapshot}
  </>;
}
