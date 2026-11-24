import { describe, expect, it } from "vitest";
import type { ArtifactBlock } from "./visualArtifacts";
import { layoutVisualScene } from "./visualSceneLayout";

type Scene = Extract<ArtifactBlock, { kind: "scene" }>;
const flow = (from: number, to: number, label = "") => ({ from, to, label });

function scene(flows: Scene["frames"][number]["flows"], count = 4): Scene {
  return {
    kind: "scene",
    nodes: Array.from({ length: count }, (_, i) => ({
      label: `Subject ${i}`, alt: "A drawing", x: i * 28, y: i * 22,
      shapes: [{kind: "rect", x: 5, y: 5, width: 90, height: 90, fill: "warm", stroke: "ink"}],
    })),
    frames: [{
      label: "A stage", caption: "The current stage.", values: Array(count).fill(""),
      levels: Array(count).fill(null), flows,
    }],
  };
}

describe("stage-focused scene geometry", () => {
  it("draws a reverse-authored transfer left to right and retains zero output or fill as supporting information", () => {
    const block = scene([flow(2, 1, "2 kW")], 5);
    block.frames[0].values = ["0 kW", "Uses 2 kW", "Supplies 2 kW", "", ""];
    block.frames[0].levels[3] = 0;
    const layout = layoutVisualScene(block, 0);
    expect(layout.mode).toBe("diagram");
    expect(layout.subjects.map(s => s.index)).toEqual([2,1]);
    expect(layout.context).toEqual([0,3]);
    const [source, target] = layout.subjects;
    expect(source.y).toBe(target.y);
    expect(source.x + source.width / 2).toBeLessThan(target.x - target.width / 2);
    expect(source.artSize).toBeGreaterThan(120);
    expect(layout.connections[0].d).toMatch(/^M [\d.]+ [\d.]+ H [\d.]+$/);
    expect(layout.connections[0].labelX).toBeGreaterThan(source.x + source.width / 2);
    expect(layout.connections[0].labelX).toBeLessThan(target.x - target.width / 2);
  });

  it.each(["split", "merge"] as const)("assigns separated horizontal ports and unobstructed labels to a %s", kind => {
    const split = kind === "split";
    const layout = layoutVisualScene(scene(split
      ? [flow(0, 1, "direct power"), flow(0, 2, "surplus")]
      : [flow(1, 0, "transfers ink"), flow(2, 0, "presses sheet")]), 0);
    expect(layout.mode).toBe("diagram");
    expect(layout.connections).toHaveLength(2);
    const paths = layout.connections.map(c => {
      expect(c.d).toContain(" C ");
      const [x1, y1, cx1, cy1, cx2, cy2, x2, y2] = c.d.match(/[\d.]+/g)!.map(Number);
      expect(x1).toBeLessThan(cx1);
      expect(cx1).toBeLessThanOrEqual(cx2);
      expect(cx2).toBeLessThan(x2);
      expect(cy1).toEqual(y1);
      expect(cy2).toEqual(y2);
      expect(c.labelX).toBe((x1 + x2) / 2);
      expect(c.labelY).toBe((y1 + y2) / 2);
      expect(c.labelWidth).toBeGreaterThan(140);
      return { y1, y2 };
    });
    expect(paths[1].y1 - paths[0].y1).toBeGreaterThanOrEqual(22);
    expect(paths[1].y2 - paths[0].y2).toBeGreaterThanOrEqual(22);
    expect(layout.connections[1].labelY - layout.connections[0].labelY).toBeGreaterThan(56);
    const sameColumn = layout.subjects.filter(s => s.index !== 0);
    expect(sameColumn[1].y - sameColumn[0].y).toBeGreaterThan(sameColumn[0].artSize + 48);
  });

  it("keeps short serial links in separate gutters and two independent paths in distinct lanes", () => {
    const chain = layoutVisualScene(scene([flow(0,1),flow(1,2)], 3), 0);
    expect(chain.mode).toBe("diagram");
    expect(chain.connections[0].labelX).toBeLessThan(chain.subjects[1].x);
    expect(chain.connections[1].labelX).toBeGreaterThan(chain.subjects[1].x);
    const independent = layoutVisualScene(scene([flow(0,3),flow(1,2)]), 0);
    expect(independent.mode).toBe("diagram");
    expect(independent.connections.every(c => c.d.includes(" H "))).toBe(true);
  });

  it.each([
    ["cycle", [flow(0,1),flow(1,0)]],
    ["bypass", [flow(0,1),flow(1,2),flow(0,2)]],
    ["crossing", [flow(0,2),flow(0,3),flow(1,2),flow(1,3)]],
    ["two distinct relations on the same ports", [flow(0,1,"owns"),flow(0,1,"repairs")]],
    ["wide relationship text", [flow(0,1,"A long description that needs the full width of an ordinary line")]],
  ] as const)("uses the lossless relationship list for %s", (_name, flows) => {
    const layout = layoutVisualScene(scene([...flows]), 0);
    expect(layout.mode).toBe("list");
    expect(layout.connections).toEqual([]);
    expect(new Set(layout.subjects.map(s => s.index))).toEqual(new Set(flows.flatMap(f => [f.from, f.to])));
  });

  it("keeps the authored spatial arrangement on stages without connections; an empty frame still shows its subjects", () => {
    const block = scene([], 2);
    block.nodes[0].x = 82;
    block.nodes[1].x = 12;
    const empty = layoutVisualScene(block, 0);
    expect(empty.mode).toBe("diagram");
    expect(empty.subjects[0].x).toBeGreaterThan(empty.subjects[1].x);
    expect(empty.subjects[0].y).toBeLessThan(empty.subjects[1].y);
    block.frames[0].levels[1] = 0.6;
    expect(layoutVisualScene(block, 0).subjects.map(s => s.index)).toEqual([1]);
    block.frames[0].values[0] = "Ready";
    block.nodes[1].x = 82;
    expect(layoutVisualScene(block, 0).mode).toBe("list");
  });
});
