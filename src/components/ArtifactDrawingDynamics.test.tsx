import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixtures from "../lib/fixtures/mcpVisualDrawingDynamics.json";
import motionFixtures from "../lib/fixtures/mcpVisualMotion.json";
import { parseArtifactIllustration } from "../lib/artifactIllustration";
import { parseArtifactMotion } from "../lib/artifactMotion";
import { illustrationLayout } from "../lib/artifactIllustrationLayout";
import { animationTimeForValue, drawingPoses, handlePoint, handlePosition, posePoint } from "../lib/illustrationHandles";
import { illustrationPoses } from "../lib/illustrationPoses";
import { ExportVisualArtifact } from "../lib/visualArtifactExport";
import { visualArtifactMarker } from "../lib/visualArtifactMarkdown";
import { parseVisualArtifact, type VisualArtifact } from "../lib/visualArtifacts";
import { ArtifactIllustrationView } from "./ArtifactIllustrationView";
import { ArtifactMotionView } from "./ArtifactMotionView";
import { VisualArtifactView } from "./VisualArtifactView";

const [mic, bridge, turntable] = fixtures.slice(0, 3).map(f => parseArtifactIllustration(f.artifact.blocks[0]));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function clock() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0, now = 0;
  vi.spyOn(performance,"now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame",(cb: FrameRequestCallback) => { frames.set(++id,cb); return id; });
  vi.stubGlobal("cancelAnimationFrame",(which: number) => frames.delete(which));
  return {frames, advance: (seconds: number) => {
    now += seconds * 1000;
    const scheduled = [...frames.values()]; frames.clear();
    act(() => scheduled.forEach(cb => cb(now)));
  }};
}

describe("playable, directly manipulable drawings", () => {
  it("moves output meters with the signal, keeps both faders live during playback, and freezes on pause or hide", () => {
    const timer = clock();
    const {container, rerender, unmount} = render(<ArtifactIllustrationView block={mic}/>);
    const meter = (channel: string) => Number(container.querySelector(`[data-drawing-part="${channel}-meter"] rect`)?.getAttribute("height"));
    expect(timer.frames.size).toBe(0);
    const start = meter("house");
    fireEvent.click(screen.getByRole("button",{name:"Play vocal signal"}));
    timer.advance(.62);
    expect(meter("house")).toBeGreaterThan(start);
    const unaffected = meter("house");
    fireEvent.change(screen.getByRole("slider",{name:"Monitor send"}),{target:{value:"0"}});
    expect(meter("house")).toBe(unaffected);
    expect(meter("monitor")).toBe(0);
    timer.advance(.7);
    expect(meter("monitor")).toBe(0);
    expect(meter("house")).not.toBe(unaffected);
    fireEvent.click(screen.getByRole("button",{name:"Pause vocal signal"}));
    const frozen = meter("house"); timer.advance(4);
    expect(meter("house")).toBe(frozen);
    fireEvent.click(screen.getByRole("button",{name:"Play vocal signal"}));
    rerender(<ArtifactIllustrationView block={mic} visible={false}/>);
    expect(timer.frames.size).toBe(0);
    rerender(<ArtifactIllustrationView block={mic}/>);
    expect(screen.getByRole("button",{name:"Play vocal signal"})).toBeVisible();
    fireEvent.click(screen.getByRole("button",{name:"Play vocal signal"}));
    unmount(); expect(timer.frames.size).toBe(0);
  });

  it("plays through a hold, scrubs the nearest leg of a shared movement and replays from the beginning", () => {
    const timer = clock();
    const {container} = render(<ArtifactIllustrationView block={bridge}/>);
    const slider = screen.getByRole("slider",{name:"Bridge position"});
    const time = screen.getByRole("slider",{name:"Animation time"}) as HTMLInputElement;
    const pose = (id: string) => container.querySelector(`[data-drawing-part="${id}"]`)!.getAttribute("transform");
    fireEvent.click(screen.getByRole("button",{name:"Play bridge opening"}));
    timer.advance(4);
    expect(slider).toHaveValue("1");
    expect(pose("leaf")).toBe(pose("counterweight"));
    expect(pose("rail")).toBe(pose("leaf"));
    expect(pose("axle")).toBeNull();
    timer.advance(2);
    fireEvent.change(slider,{target:{value:".5"}});
    expect(Number(time.value)).toBeGreaterThan(5);
    expect(timer.frames.size).toBe(0);
    fireEvent.keyDown(time,{key:"End"});
    expect(slider).toHaveValue("0");
    fireEvent.click(screen.getByRole("button",{name:"Replay bridge opening"}));
    timer.advance(1.25); expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(.15);
    timer.advance(8); expect(screen.getByRole("button",{name:"Replay bridge opening"})).toBeVisible();
  });

  it("projects straight and turning gestures in drawing coordinates and keeps every pose in the shared frame", () => {
    for (const drawing of [mic,bridge]) for (const handle of drawing.handles!) for (const t of [0,.13,.5,.95,1])
      expect(handlePosition(handle.track,handlePoint(handle.track,t),.5)).toBeCloseTo(t,8);
    const time = bridge.animation!.tracks[0].keys;
    expect(animationTimeForValue(time,1,4.4)).toBe(4.4);
    const layout = illustrationLayout(bridge);
    const rest = [526,225] as [number,number];
    for (let time = 0; time <= 8; time += .2) {
      const pose = drawingPoses(bridge.handles!,[],bridge.animation,time).get("leaf")!;
      const [x,y] = posePoint(rest,pose);
      expect(x).toBeGreaterThanOrEqual(layout.left); expect(x).toBeLessThanOrEqual(layout.left+layout.width);
      expect(y).toBeGreaterThanOrEqual(layout.top); expect(y).toBeLessThanOrEqual(layout.top+layout.height);
    }
  });

  it("leaves a loop still on load and plays only one pass on a reduced-motion system", () => {
    const timer = clock();
    vi.stubGlobal("matchMedia", () => ({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    render(<ArtifactIllustrationView block={mic}/>);
    expect(timer.frames.size).toBe(0);
    fireEvent.click(screen.getByRole("button",{name:"Play vocal signal"}));
    timer.advance(5);
    expect(timer.frames.size).toBe(0);
    expect(screen.getByRole("button",{name:"Replay vocal signal"})).toBeVisible();
  });

  it("plays saved staged drawings and keeps both linked views on their own shared clock", () => {
    const timer = clock();
    const staged = parseArtifactIllustration({
      ...turntable, animation: undefined,
      states: { label: "Drum position", items: [
        { label: "Set", caption: "The drum is set.", changes: [] },
        { label: "Lifted", caption: "The drum is raised.", changes: [{ part: "drum", emphasis: true }] },
      ] },
    });
    const linked = parseArtifactMotion(motionFixtures[1].artifact.blocks[0]);
    const { container } = render(<><ArtifactIllustrationView block={staged}/><ArtifactMotionView block={linked}/></>);
    const artwork = () => Array.from(container.querySelectorAll(".artifact-motion__diagram")).map(drawing =>
      [...drawing.querySelectorAll("path")].map(path => [path.getAttribute("transform"), path.getAttribute("opacity")]));
    const before = artwork();
    fireEvent.click(screen.getByRole("button", { name: "Play stages" }));
    fireEvent.click(screen.getByRole("button", { name: "Play linked views" }));
    timer.advance(1.6);
    expect(screen.getByRole("button", { name: "Lifted" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Replay stages" })).toBeVisible();
    for (const [i, view] of artwork().entries()) expect(view).not.toEqual(before[i]);
    expect(screen.getByRole("button", { name: "Pause linked views" })).toBeVisible();
    timer.advance(11);
    expect(screen.getByRole("button", { name: "Replay linked views" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next new moon" })).toHaveAttribute("aria-pressed", "true");
  });

  it("traces the active solar transfers in a saved scene and keeps each stage's original readings", () => {
    const timer = clock();
    const nodes = ["Panels", "Battery", "Home"].map((label, i) => ({
      label, alt: label, x: i * 40 + 5, y: 50, shapes: [{kind: "circle" as const, cx: 50, cy: 50, r: 30, fill: "accent" as const, stroke: "ink" as const}],
    }));
    const artifact: VisualArtifact = {version: 1, format: "explainer", title: "Solar supply", blocks: [{kind: "scene", nodes, frames: [
      {label: "Day", caption: "The panels power the house and charge the battery.", values: ["8 kW", "Charging", "6 kW"], levels: [null, .5, null],
        flows: [{from: 0, to: 2, label: "6 kW"}, {from: 0, to: 1, label: "2 kW"}]},
      {label: "Night", caption: "The battery supplies the house.", values: ["Idle", "Discharging", "2 kW"], levels: [null, .25, null],
        flows: [{from: 1, to: 2, label: "2 kW"}]},
    ]}]};
    const { container } = render(<VisualArtifactView artifact={artifact}/>);
    const traces = () => container.querySelectorAll("path.visual-artifact__transfer");
    expect(traces()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", {name: "Play stages"}));
    timer.advance(.6);
    expect(traces()).toHaveLength(2);
    const arrows = [...container.querySelectorAll("path[marker-end]")].map(p => p.getAttribute("d"));
    expect([...traces()].map(p => p.getAttribute("d"))).toEqual(arrows);
    expect(container.querySelectorAll("circle.visual-artifact__transfer")).toHaveLength(2);
    timer.advance(2);
    expect(screen.getByRole("tab", {name: "Night"})).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Discharging")).toBeVisible();
    expect(traces()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", {name: "Pause stages"}));
    const paused = traces()[0].getAttribute("stroke-dashoffset");
    timer.advance(3);
    expect(traces()[0]).toHaveAttribute("stroke-dashoffset", paused);
    fireEvent.click(screen.getByRole("tab", {name: "Day"}));
    expect(traces()).toHaveLength(0);
  });

  it("selects visible intermediate poses for a complete turn and exports controls, captions and evidence without scripts", () => {
    const turn = illustrationPoses(turntable,true);
    const times = turn.map(pose => pose.time ?? 0);
    expect(times).toContain(1);
    expect(times).toEqual([...times].sort((a,b) => a-b));
    const bridgeAngles = illustrationPoses(bridge, true).map(pose =>
      drawingPoses(bridge.handles!, pose.positions, bridge.animation, pose.time).get("leaf")!.angle);
    expect(new Set(bridgeAngles).size).toBe(4);
    expect(illustrationPoses(mic,true).length).toBeLessThanOrEqual(4);
    const artifact = parseVisualArtifact(fixtures[0].artifact);
    const {container} = render(<ExportVisualArtifact marker={visualArtifactMarker(artifact)}/>);
    expect(within(container).getByText("Monitor send · Muted")).toBeVisible();
    expect(container.textContent).toContain(mic.animation!.quote);
    expect(container.querySelectorAll("figure").length).toBeGreaterThan(3);
    expect(container.querySelector("button,input,[data-drawing-handle]")).toBeNull();
  });
});
