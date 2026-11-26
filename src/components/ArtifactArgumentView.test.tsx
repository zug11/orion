import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../lib/fixtures/mcpVisualArgument.json";
import { evaluateArgument, parseArtifactArgument, readArgumentParagraph, type ArgumentParagraph } from "../lib/artifactArgument";
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
    const firstReading = first.getByRole("region", { name: "Current reading" });
    expect(firstReading).toHaveTextContent(block.conclusions[1].text);
    expect(first.getByRole("status")).toHaveTextContent("2 of 2");
    const assumption = first.getByRole("switch", { name: "Grant unstated premise 3" });
    fireEvent.click(assumption);
    expect(assumption).toHaveAttribute("aria-checked", "false");
    expect(first.getByRole("status")).toHaveTextContent("1 of 2");
    expect(firstReading).toHaveTextContent(block.conclusions[0].text);
    expect(firstReading).not.toHaveTextContent(block.conclusions[1].text);
    expect(first.getByText("The remaining premises leave this claim open.")).toContainElement(first.getByText(block.conclusions[1].text, { selector: "q" }));
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
    expect(firstReading).toHaveTextContent(block.conclusions[1].text);
    expect(first.queryByText(block.premises[2].without)).toBeNull();
  });

  it("replaces whole paragraphs for both, either or neither source and restores the exact full reading", () => {
    const library = parseArtifactArgument(fixtures[1].artifact.blocks[0]);
    const [context, paragraph] = library.reading!;
    if (typeof context !== "string" || typeof paragraph === "string") throw new Error("Expected the library reading.");
    const [countOnly, slipsOnly, both] = paragraph.variants.map(v => v.text);
    render(<ArtifactArgumentView block={library} />);
    const reading = within(screen.getByRole("region", { name: "Current reading" }));
    const counts = screen.getByRole("switch", { name: "Grant premise 1" });
    const slips = screen.getByRole("switch", { name: "Grant premise 2" });
    const fixed = reading.getByText(context);
    expect(reading.getByText(both)).toBeVisible();
    fireEvent.click(slips);
    expect(reading.getByText(countOnly)).toBeVisible();
    expect(reading.queryByText(both)).toBeNull();
    fireEvent.click(counts);
    expect(reading.getByText(paragraph.fallback!)).toBeVisible();
    fireEvent.click(slips);
    expect(reading.getByText(slipsOnly)).toBeVisible();
    fireEvent.click(counts);
    expect(reading.getByText(both)).toBeVisible();
    expect(reading.getByText(context)).toBe(fixed);
    fireEvent.click(screen.getByRole("button", { name: "Source for premise 1" }));
    expect(screen.getByText(library.premises[0].quote!, { selector: "mark" })).toBeVisible();
  });

  it("keeps readings backed by an alternative route and propagates losses through dependent conclusions", () => {
    const paragraph: ArgumentParagraph = { variants: [
      { requires: ["inside"], text: "Visitors can reach the hall." },
      { requires: ["inside","accessible"], text: "Visitors can reach the hall and participate." },
    ], fallback: "How visitors reach the hall remains open." };
    const read = (...ids: string[]) => readArgumentParagraph(paragraph, evaluateArgument(block, new Set(ids)));
    expect(read("ramp")).toBe(paragraph.variants[1].text);
    expect(read("participate")).toBe(paragraph.variants[0].text);
    expect(read("ramp", "lift")).toBe(paragraph.fallback);
    const equal: ArgumentParagraph = { variants: [
      { requires: ["lift"], text: "First reading." }, { requires: ["inside"], text: "Second reading." },
    ], fallback: "Neither." };
    expect(readArgumentParagraph(equal, evaluateArgument(block, new Set()))).toBe("First reading.");
  });

  it("includes the complete alternative readings and their conditions for static exports", () => {
    const library = parseArtifactArgument(fixtures[1].artifact.blocks[0]);
    render(<ArtifactArgumentSnapshot block={library} />);
    const paragraph = library.reading![1];
    if (typeof paragraph === "string") throw new Error("Expected an adaptive paragraph.");
    for (const variant of paragraph.variants) expect(screen.getAllByText(variant.text)[0]).toBeVisible();
    expect(screen.getByText(paragraph.fallback!)).toBeVisible();
    expect(screen.getByText("Conclusion 2 + Conclusion 1")).toBeVisible();
  });

  it("can remove a paragraph whose whole argument loses support and bring it back", () => {
    const variant = { requires: ["inside"], text: "At least one route leads inside." };
    const reading = parseArtifactArgument({ ...block, reading: [{ variants: [variant], fallback: null }] });
    render(<ArtifactArgumentView block={reading} />);
    const prose = within(screen.getByRole("region", { name: "Current reading" }));
    const ramp = screen.getByRole("switch", { name: "Grant premise 1" });
    const lift = screen.getByRole("switch", { name: "Grant premise 2" });
    fireEvent.click(ramp);
    expect(prose.getByText(variant.text)).toBeVisible();
    fireEvent.click(lift);
    expect(prose.queryByText(variant.text)).toBeNull();
    expect(prose.getByText("The remaining premises leave the argument open.")).toBeVisible();
    fireEvent.click(ramp);
    expect(prose.getByText(variant.text)).toBeVisible();
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
