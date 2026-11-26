import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../lib/fixtures/mcpVisualArgument.json";
import { evaluateArgument, parseArtifactArgument } from "../lib/artifactArgument";
import { ArtifactArgumentView, ArtifactArgumentSnapshot } from "./ArtifactArgumentView";

const block = parseArtifactArgument(fixtures[0].artifact.blocks[0]);

afterEach(cleanup);

describe("testing an argument", () => {
  it.each(fixtures)("checks the source and supports in $name", ({ valid, artifact }) => {
    const parse = () => parseArtifactArgument(artifact.blocks[0]);
    if (valid) expect(parse).not.toThrow();
    else expect(parse).toThrow();
  });

  it("rejects duplicate identifiers, forward references, empty support and ungrounded premises", () => {
    const [ramp, lift, assumption] = block.premises;
    const [inside, accessible] = block.conclusions;
    for (const changes of [
      { premises: [ramp, { ...lift, id: ramp.id }] },
      { conclusions: [{ ...inside, id: ramp.id }] },
      { conclusions: [accessible, inside] },
      { conclusions: [{ ...inside, supports: [[ramp.id, ramp.id]] }] },
      { conclusions: [{ ...inside, supports: [[]] }] },
      { conclusions: [{ ...inside, supports: [] }] },
      { conclusions: [{ ...inside, quote: "Missing from source" }] },
      { premises: [assumption] },
      { premises: [{ ...ramp, script: "unexpected" }] },
      { premises: [{ ...ramp, id: "1foo" }] },
      { premises: [{ ...ramp, text: "🌺".repeat(251) }] },
    ]) {
      expect(() => parseArtifactArgument({ ...block, ...changes })).toThrow();
    }
    expect(parseArtifactArgument({ ...block, premises: [{ ...ramp, text: "🌺".repeat(250) }, lift, assumption] })).toBeTruthy();
  });

  it("evaluates each alternative and propagates withdrawn support only to dependent conclusions", () => {
    const outcomes = (ids: string[]) => {
      const supported = evaluateArgument(block, new Set(ids));
      return block.conclusions.map(c => supported.has(c.id));
    };
    expect(outcomes([])).toEqual([true, true]);
    expect(outcomes(["ramp"])).toEqual([true, true]);
    expect(outcomes(["participate"])).toEqual([true, false]);
    expect(outcomes(["ramp", "lift"])).toEqual([false, false]);
  });

  it("can withdraw and restore premises, inspect exact text, and keep two copies independent", () => {
    render(<><article><ArtifactArgumentView block={block} /></article><article><ArtifactArgumentView block={block} /></article></>);
    const [first, second] = screen.getAllByRole("article").map(el => within(el));
    expect(first.getByRole("status")).toHaveTextContent("2 of 2");
    const assumption = first.getByRole("switch", { name: "Grant unstated premise 3" });
    fireEvent.click(assumption);
    expect(assumption).toHaveAttribute("aria-checked", "false");
    expect(first.getByRole("status")).toHaveTextContent("1 of 2");
    expect(second.getByRole("status")).toHaveTextContent("2 of 2");
    expect(first.getByText(block.premises[2].without)).toBeVisible();
    expect(first.queryByRole("button", { name: "Source for unstated premise 3" })).toBeNull();

    fireEvent.click(first.getByRole("button", { name: "Source for premise 1" }));
    expect(first.getByText("The hall has a ramp.", { selector: "mark" })).toBeVisible();
    fireEvent.click(first.getByRole("button", { name: "Source for conclusion 2" }));
    expect(first.queryByText("The hall has a ramp.", { selector: "mark" })).toBeNull();
    expect(first.getByText("The meeting is therefore accessible.", { selector: "mark" })).toBeVisible();
    fireEvent.click(assumption);
    expect(first.getByRole("status")).toHaveTextContent("2 of 2");
    expect(first.queryByText(block.premises[2].without)).toBeNull();
  });

  it("preserves every dependency, excerpt and unstated assumption in the static reading copy", () => {
    render(<ArtifactArgumentSnapshot block={block} />);
    expect(screen.getByText("Unstated premise 3")).toBeVisible();
    expect(screen.getByText("Supported by Premise 1 or Premise 2")).toBeVisible();
    expect(screen.getByText("Supported by Conclusion 1 + Unstated premise 3")).toBeVisible();
    expect(screen.getByText(block.passage)).toBeVisible();
    expect(screen.queryByRole("switch")).toBeNull();
  });
});
