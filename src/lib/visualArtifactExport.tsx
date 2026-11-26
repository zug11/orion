import { ArtifactMotionSnapshot } from "../components/ArtifactMotionView";
import { ArtifactScaleTimeSnapshot } from "../components/ArtifactScaleTimeView";
import { ArtifactArgumentSnapshot } from "../components/ArtifactArgumentView";
import { ArtifactIllustrationSnapshot } from "../components/ArtifactIllustrationView";
import { outputText, calculatorExplanationText, expressionWorking, formatRecipeYield } from "./visualArtifactCalculator";
import { VisualArtifactTable } from "../components/VisualArtifactTable";
import { evaluateArtifactExpression, type ArtifactBlock } from "./visualArtifacts";
import { readVisualArtifactMarker, unavailableVisualArtifact, visualArtifactMarker } from "./visualArtifactMarkdown";
import { formatArtifactQuantity, formatRecipeIngredient } from "./visualArtifactQuantity";

function StaticBlock({ block }: { block: ArtifactBlock }) {
  switch (block.kind) {
    case "cycle":
    case "linkedViews": return <ArtifactMotionSnapshot block={block} />;
    case "argument": return <ArtifactArgumentSnapshot block={block} />;
    case "scaleZoom":
    case "deepTime": return <ArtifactScaleTimeSnapshot block={block} />;
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
    case "illustration": return <ArtifactIllustrationSnapshot block={block} />;
    case "calculator": {
      const initial = block.inputs.map(input => input.initial);
      const recipe = block.recipe;
      const serving = recipe && block.inputs[recipe.input];
      const otherInputs = block.inputs.filter((_, i) => i !== recipe?.input);
      const otherOutputs = block.outputs.filter((_, i) => !recipe?.ingredients.includes(i));
      const amount = (output: typeof block.outputs[number]) => outputText(output, evaluateArtifactExpression(output.expression, initial));
      return <div>
        {recipe && serving && <>
          <table><thead><tr><th scope="col">Ingredient</th>
            <th scope="col">For {formatRecipeYield(serving.initial, serving.unit)}, as written</th></tr></thead>
            <tbody>{recipe.ingredients.map(i => <tr key={i}><th scope="row">{block.outputs[i].label}</th>
              <td>{formatRecipeIngredient(evaluateArtifactExpression(block.outputs[i].expression, initial), block.outputs[i].unit)}</td></tr>)}</tbody></table>
          {recipe.cookingNote && <p>{recipe.cookingNote}</p>}
        </>}
        {otherInputs.length > 0 && <ul>{otherInputs.map((input, i) =>
          <li key={i}>{input.label} · {formatArtifactQuantity(input.initial, input.unit)}</li>)}</ul>}
        {otherOutputs.map((output, i) => <p key={i}>{output.label} · {amount(output)}</p>)}
        {block.explanation && <p>{calculatorExplanationText(block, initial)}</p>}
        {otherOutputs.length > 0 && <details><summary>Show the working</summary>{otherOutputs.map((output, i) =>
          <div key={i}><strong>{output.label}</strong><ol>{expressionWorking(output.expression,block.inputs,initial).map((line,j) => <li key={j}>{line}</li>)}</ol></div>)}</details>}</div>;
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
      {artifact.evidence && <div><h4>Sources in the passage</h4>{artifact.evidence.claims.map((claim, i) => <p key={i}>
        <strong>{claim.label}</strong> · {claim.quotes.length ? claim.quotes.map(q => artifact.evidence!.passage.includes(q) ? q : "No matching excerpt").join(" · ") : "No matching excerpt"}
      </p>)}</div>}
    </section>
  );
  if (!interactive) return snapshot;
  return <>
    <div data-orion-artifact-viewer={visualArtifactMarker(artifact)} />
    {snapshot}
  </>;
}
