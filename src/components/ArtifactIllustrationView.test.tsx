import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactIllustrationSnapshot, ArtifactIllustrationView } from "./ArtifactIllustrationView";
import { ArtifactDrawingGlyph } from "./ArtifactDrawingGlyph";
import {
  DRAWING_GLYPHS,
  parseArtifactIllustration,
  validateIllustrationSource,
  type ArtifactIllustration,
} from "../lib/artifactIllustration";
import { illustrationBadges, illustrationLayout } from "../lib/artifactIllustrationLayout";

const block: ArtifactIllustration = {
  kind: "illustration",
  view: "landscape",
  passage: "The float rises inside the tank. Water reaches the outlet.",
  parts: [
    {
      id: "frame",
      name: "Support",
      tone: "ground",
      selectable: false,
      shapes: [{ type: "path", paint: "thin", d: "M 20 90 Q 30 100 40 90 A 20 30 0 0 1 80 90" }],
    },
    {
      id: "tank",
      name: "Tank",
      tone: "accent",
      selectable: true,
      about: "Contains the float.",
      quote: "inside the tank",
      level: 0.2,
      icon: { name: "tank", x: 30, y: 70, size: 50 },
    },
    {
      id: "float",
      name: "Float",
      tone: "cool",
      selectable: true,
      about: "Rises in the tank.",
      quote: "The float rises",
      shapes: [{ type: "circle", cx: 55, cy: 104, r: 3, paint: "fill" }],
    },
  ],
  states: {
    label: "Water level",
    items: [
      { label: "Low", caption: "Float at the bottom.", changes: [] },
      {
        label: "High",
        caption: "The float rises.",
        changes: [
          { part: "tank", level: 0.9 },
          { part: "float", shapes: [{ type: "circle", cx: 55, cy: 84, r: 3, paint: "fill" }] },
        ],
      },
    ],
  },
};

describe("explorable illustrations", () => {
  it("draws actual shared geometry, selects parts from the image or keyboard and highlights precise source words", () => {
    const ask = vi.fn();
    const { container } = render(<ArtifactIllustrationView block={block} onAskPart={ask} />);
    expect(screen.queryByRole("button", { name: "Support" })).not.toBeInTheDocument();
    fireEvent.click(container.querySelector('[data-drawing-part="tank"] rect')!);
    expect(screen.getByRole("button", { name: "Tank" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(screen.getByRole("button", { name: "Tank" }), { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: "Float" })).toHaveFocus();
    fireEvent.click(screen.getByText("Source passage"));
    expect(container.querySelector("blockquote mark")).toHaveTextContent("The float rises");
    fireEvent.click(screen.getByRole("button", { name: "Ask about this part" }));
    expect(ask).toHaveBeenCalledWith(`Explain Float in this passage.\n\n${block.passage}`);
    const before = container
      .querySelector('[data-drawing-part="tank"] [data-glyph="tank"] rect:nth-child(2)')!
      .getAttribute("height");
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(container.querySelector('[data-drawing-part="float"] circle')).toHaveAttribute("cy", "84");
    expect(
      container
        .querySelector('[data-drawing-part="tank"] [data-glyph="tank"] rect:nth-child(2)')!
        .getAttribute("height")
    ).not.toBe(before);
    expect(screen.getByText("The float rises.")).toBeVisible();
  });
  it("renders all stages and quoted explanations offline in the print fallback", () => {
    const { container } = render(<ArtifactIllustrationSnapshot block={block} />);
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(2);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("renders every glyph declared in the generator and MCP schema from local geometry", () => {
    const { container } = render(
      <svg>
        {DRAWING_GLYPHS.map((name) => (
          <ArtifactDrawingGlyph key={name} icon={{ name, x: 0, y: 0, size: 40 }} level={0.5} />
        ))}
      </svg>
    );
    const glyphs = container.querySelectorAll("[data-glyph]");
    expect(glyphs).toHaveLength(DRAWING_GLYPHS.length);
    for (const glyph of glyphs)
      expect(glyph.querySelector("path,rect,circle,ellipse,line,polygon,polyline")).not.toBeNull();
    expect(container.querySelector("image,use,foreignObject")).toBeNull();
  });
  it("checks both quote-to-passage and passage-to-selected-text correspondence", () => {
    expect(() => validateIllustrationSource(block, "Before. " + block.passage + " After.")).not.toThrow();
    expect(() => validateIllustrationSource(block, "A different selection")).toThrow(/selected text/);
    expect(() =>
      parseArtifactIllustration({ ...block, parts: [{ ...block.parts[1], quote: "made up" }] })
    ).toThrow(/quote/);
  });
  it("lays out badges from each stage’s rendered feature and bounds all leader lengths", () => {
    const layout = illustrationLayout(block),
      low = illustrationBadges(block, [], layout),
      high = illustrationBadges(block, block.states!.items[1].changes, layout);
    expect(high.get("float")!.anchor[1]).toBeLessThan(low.get("float")!.anchor[1] - 10);
    for (const badge of high.values())
      if (badge.leader)
        expect(Math.hypot(badge.x - badge.anchor[0], badge.y - badge.anchor[1])).toBeLessThan(
          Math.max(layout.width, layout.height) * 0.07
        );
  });
});
