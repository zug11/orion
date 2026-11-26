import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../lib/fixtures/mcpVisualMotion.json";
import { parseArtifactMotion, sampleMotion } from "../lib/artifactMotion";
import { ArtifactMotionSnapshot, ArtifactMotionView } from "./ArtifactMotionView";

const engine = parseArtifactMotion(fixtures[0].artifact.blocks[0]);
const moon = parseArtifactMotion(fixtures[1].artifact.blocks[0]);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("moving diagrams", () => {
  it("shares its strict wire fixtures with MCP and interpolates between keyframes", () => {
    for (const { artifact, valid } of fixtures) {
      const parse = () => parseArtifactMotion(artifact.blocks[0]);
      if (valid) expect(parse()).toEqual(artifact.blocks[0]);
      else expect(parse).toThrow();
    }
    const sampled = sampleMotion([{ at: 0, x: 0, opacity: 1 }, { at: 4, x: 8, opacity: 0 }], 1);
    expect(sampled).toEqual({ x: 2, y: 0, angle: 0, opacity: .75, scaleX: 1, scaleY: 1 });
  });

  it("turns the cycle from the dial, slider and phase chips while highlighting the quoted sentence", () => {
    const { container } = render(<ArtifactMotionView block={engine}/>);
    const slider = screen.getByRole("slider", { name: "Crank angle" });
    const dial = screen.getByRole("slider", { name: "Turn Crank angle" });
    fireEvent.click(screen.getByRole("button", { name: "Exhaust" }));
    expect(slider).toHaveAttribute("aria-valuetext", "540°");
    fireEvent.click(screen.getByText("Source passage"));
    expect(container.querySelector("mark")).toHaveTextContent(engine.phases[3].quote);
    fireEvent.keyDown(dial, { key: "End" });
    expect(screen.getByRole("button", { name: "Intake" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    expect(slider).toHaveAttribute("aria-valuetext", "7.2°");
    fireEvent.change(slider, { target: { value: 180 } });
    expect(container.querySelector("mark")).toHaveTextContent(engine.phases[1].quote);
    expect(screen.getByRole("button", { name: "Compression" })).toHaveAttribute("aria-pressed", "true");
  });

  it("plays only on request, wraps at the full turn, and stops on manual control and unmount", () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++nextId, fn); return nextId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
    const now = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const { unmount } = render(<ArtifactMotionView block={engine}/>);
      expect(callbacks.size).toBe(0);
      const frame = (ms: number) => {
        const callback = callbacks.get(nextId)!;
        callbacks.delete(nextId);
        act(() => callback(100 + ms));
      };
      fireEvent.click(screen.getByRole("button", { name: "Play cycle" }));
      frame(3000);
      expect(screen.getByRole("button", { name: "Compression" })).toHaveAttribute("aria-pressed", "true");
      frame(12000);
      expect(screen.getByRole("button", { name: "Intake" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "Power" }));
      expect(callbacks.size).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "Play cycle" }));
      unmount();
      expect(callbacks.size).toBe(0);
    } finally { now.mockRestore(); }
  });

  it("updates both perspectives and their quoted passage as one continuous position changes", () => {
    const { container } = render(<ArtifactMotionView block={moon}/>);
    const orbit = screen.getByRole("img", { name: moon.views[0].label });
    const disc = screen.getByRole("img", { name: moon.views[1].label });
    const initialOrbit = orbit.innerHTML, initialDisc = disc.innerHTML;
    fireEvent.click(screen.getByRole("button", { name: "First quarter" }));
    expect(orbit.innerHTML).not.toBe(initialOrbit);
    expect(disc.innerHTML).not.toBe(initialDisc);
    const slider = screen.getByRole("slider", { name: moon.label });
    expect(slider).toHaveAttribute("aria-valuetext", "7.375 days");
    fireEvent.keyDown(slider, { key: "End" });
    expect(slider).toHaveAttribute("aria-valuetext", "29.5 days");
    expect(screen.getByRole("button", { name: "Next new moon" })).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("mark")).toHaveTextContent(moon.phases[4].quote);
  });

  it("prints every named position with the corresponding diagrams, readings and source", () => {
    const { container } = render(<ArtifactMotionSnapshot block={moon}/>);
    expect(container.querySelectorAll("figure")).toHaveLength(moon.phases.length * 2);
    expect(container.querySelectorAll("blockquote")).toHaveLength(moon.phases.length);
    expect(screen.getByRole("heading", { name: "Full moon · 14.75 days" })).toBeVisible();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
