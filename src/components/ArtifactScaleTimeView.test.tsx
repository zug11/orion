import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import fixtures from "../lib/fixtures/mcpVisualScaleTime.json";
import { parseVisualArtifact } from "../lib/visualArtifacts";
import { readVisualArtifactMarker, visualArtifactMarker } from "../lib/visualArtifactMarkdown";
import { ExportVisualArtifact } from "../lib/visualArtifactExport";
import {
  adaptiveLength, dayClockTime, daySecondOf, parseArtifactScaleZoom, parseArtifactDeepTime,
  scaleCamera, scaleStops, timeRemaining, type ArtifactScaleZoom,
} from "../lib/artifactScaleTime";
import { ArtifactScaleTimeView } from "./ArtifactScaleTimeView";

const zoom = parseArtifactScaleZoom(fixtures[0].artifact.blocks[0]);
const clock = parseArtifactDeepTime(fixtures[1].artifact.blocks[0]);

describe("measurements and clock analogies in saved visuals", () => {
  it("round-trips both kinds and rejects mixed or malformed source data", () => {
    for (const fixture of fixtures) {
      const parse = () => parseVisualArtifact(fixture.artifact);
      if (fixture.valid) expect(readVisualArtifactMarker(visualArtifactMarker(parse()))).toEqual(fixture.artifact);
      else expect(parse, fixture.name).toThrow();
    }
  });

  it("maintains physical ratios across units, including for equal objects", () => {
    const block: ArtifactScaleZoom = {...zoom, items: [
      {label:"Plate",size:4,unit:"cm"}, {label:"Coin",size:20,unit:"mm"}, {label:"Opening",size:0.02,unit:"m"},
    ]};
    const stops = scaleStops(block.items);
    expect(stops.map(s => s.metres)).toEqual([0.04,0.02,0.02]);
    for (const stop of stops) {
      const pose = scaleCamera(stops, stop.zoom);
      expect(pose.field).toBeCloseTo(stop.field, 12);
      expect(pose.centre).toBeCloseTo(stop.centre, 12);
      expect(pose.nearest).toBe(stop);
    }
    expect(scaleCamera(stops, 0.5).field).toBeCloseTo(Math.sqrt(stops[0].field * stops[2].field), 12);
    expect(adaptiveLength(7e-6)).toBe("7 µm");
    expect(adaptiveLength(2e-9)).toBe("2 nm");
  });

  it("keeps a finite camera and a visible scale bar across the accepted extremes", () => {
    const stops = scaleStops([{label:"Wide",size:1e60,unit:"ly"}, {label:"Narrow",size:1e-60,unit:"pm"}]);
    for (const progress of [0, 0.5, 0.9, 1]) {
      const pose = scaleCamera(stops, progress);
      expect([pose.field, pose.centre, pose.bar].every(Number.isFinite)).toBe(true);
      expect(pose.bar / pose.field).toBeGreaterThan(0.1);
      expect(pose.bar / pose.field).toBeLessThan(0.5);
    }
  });

  it("changes magnification from either the slider or a named object", () => {
    const {container} = render(<ArtifactScaleTimeView block={zoom} />);
    const slider = screen.getByRole("slider", {name:"Zoom"});
    const initialBar = container.querySelector(".va-zoom-scale")?.textContent;
    fireEvent.click(screen.getByRole("button", {name:"Pigment grain"}));
    expect(screen.getByRole("button", {name:"Pigment grain"})).toHaveAttribute("aria-pressed","true");
    expect(screen.getByText(/measures 500 times/)).toBeVisible();
    expect(slider).toHaveValue("10000");
    expect(container.querySelector(".va-zoom-scale")?.textContent).not.toBe(initialBar);
    fireEvent.change(slider, {target:{value:"0"}});
    expect(screen.getByRole("button", {name:"Mosaic tile"})).toHaveAttribute("aria-pressed","true");
  });

  it("maps stated clock times and source ages onto one day and preserves both midnights", () => {
    expect(daySecondOf({label:"Start",beforeEnd:4700},4700)).toBe(0);
    expect(daySecondOf({label:"End",beforeEnd:0},4700)).toBe(86400);
    expect(timeRemaining(43200,4700)).toBe(2350);
    expect(dayClockTime(daySecondOf({label:"Near end",beforeEnd:1e-20},4700))).toBe("23:59:59");
    expect(dayClockTime(daySecondOf({label:"Analogy",daySecond:86394},4700))).toBe("23:59:54");
  });

  it("selects late events, magnifies the final minute and reaches the end from every control", () => {
    const {container} = render(<ArtifactScaleTimeView block={clock} />);
    fireEvent.click(screen.getByRole("button",{name:/Our species/}));
    const dial = screen.getByRole("img", {name:"24-hour clock at 23:59:54"});
    const lastMinute = screen.getByRole("slider", {name:"Last minute"});
    expect(lastMinute).toHaveValue("86394");
    fireEvent.change(lastMinute, {target:{value:"86400"}});
    expect(dial).toHaveAttribute("aria-label","24-hour clock at 24:00:00");
    expect(container.querySelector(".va-time-readout")).toHaveTextContent("0 years before the end");
    fireEvent.change(screen.getByRole("slider",{name:"Whole day"}),{target:{value:"0"}});
    expect(dial).toHaveAttribute("aria-label","24-hour clock at 00:00:00");
    expect(screen.getByText("4.54 billion years before the end")).toBeVisible();
  });

  it("keeps every event and measured object legible in static exports", () => {
    const {rerender} = render(<ExportVisualArtifact marker={visualArtifactMarker(parseVisualArtifact(fixtures[0].artifact))} />);
    expect(screen.getByText("Pigment grain").closest("li")).toHaveTextContent("40 µm");
    rerender(<ExportVisualArtifact marker={visualArtifactMarker(parseVisualArtifact(fixtures[1].artifact))} />);
    const row = screen.getByText("Our species").closest("li")!;
    expect(row).toHaveTextContent("23:59:54");
    expect(within(row).getByText(/six seconds before midnight/)).toBeVisible();
    expect(screen.queryByRole("slider")).toBeNull();
  });
});
