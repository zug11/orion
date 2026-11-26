import { formatArtifactQuantity } from "./visualArtifactQuantity";
import { ARTIFACT_FORMATS, type ArtifactFormat, type VisualArtifact } from "./visualArtifacts";

type Format = ArtifactFormat | "auto";
export function chatVisualSuggestion(reply: string): { reply: string; format?: Format } {
  const match = /(?:^|\n)\s*\[\[visualise:([a-z]+)\]\]\s*$/u.exec(reply);
  if (!match) return { reply };
  const clean = reply.slice(0, match.index).trimEnd();
  const format = match[1] as Format;
  return { reply: clean, ...(format === "auto" || ARTIFACT_FORMATS.includes(format) ? { format } : {}) };
}


/** Text context for the next turn. Geometry, encoded markers and control state
 * never enter Chat history; a follow-up can refer to the initial values. */
export function describedChatVisual(visual: VisualArtifact): string {
  const descriptions = visual.blocks.map(block => {
    switch (block.kind) {
      case "calculator": return [
        ...block.inputs.map(input => input.label + " " + input.initial + input.unit + " (" + input.min + " to " + input.max + ")"),
        ...block.outputs.map(output => output.label + " = " + JSON.stringify(output.expression)),
      ].join("; ");
      case "illustration": return block.parts.filter(part => part.selectable).map(part => part.name).join(", ");
      case "scene": return block.frames.map(frame => frame.label + " · " + frame.caption).join("; ");
      case "steps": return block.items.map(item => item.label + " · " + item.heading).join("; ");
      case "quiz": return block.items.map(item => item.question).join("; ");
      case "cards": return block.items.map(item => item.front).join("; ");
      case "table": return block.columns.join(" / ");
      case "text": return block.text;
    }
  });
  return [visual.title, visual.summary, ...descriptions].filter(Boolean).join("\n");
}

export function visualFollowUp(visual: VisualArtifact): string {
  const calculator = visual.blocks.find(block => block.kind === "calculator");
  if (calculator?.kind === "calculator") {
    const input = calculator.inputs[0];
    const setting = input.initial === input.max ? input.min : input.max;
    return "What happens to " + calculator.outputs[0].label + " if " + input.label + " changes to " + formatArtifactQuantity(setting, input.unit) + "?";
  }
  return "Explain the main idea behind “" + visual.title + "”.";
}
