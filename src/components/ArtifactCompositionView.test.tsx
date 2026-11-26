import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import compositions from "../lib/fixtures/mcpVisualCompositions.json";
import { parseVisualArtifact } from "../lib/visualArtifacts";
import { readVisualArtifactMarker, visualArtifactMarker } from "../lib/visualArtifactMarkdown";
import { ExportVisualArtifact } from "../lib/visualArtifactExport";
import { VisualArtifactView } from "./VisualArtifactView";

afterEach(cleanup);

function choose(label: string, option: string) {
  fireEvent.click(within(screen.getByRole("group", { name: label })).getByRole("radio", { name: option }));
}

it("drives one drawing from two independent controls, including after a note round trip", () => {
  const artifact = parseVisualArtifact(compositions[0].artifact);
  const marker = visualArtifactMarker(artifact);
  const saved = readVisualArtifactMarker(marker)!;
  expect(saved).toEqual(artifact);
  const view = render(<VisualArtifactView artifact={saved} />);
  expect(screen.queryByRole("tablist")).toBeNull();
  const reading = (label: string) => screen.getByRole("status", { name: label });
  choose("Main vocal fader", "Raised");
  expect(reading("Audience hears")).toHaveTextContent("More vocal");
  expect(reading("Singer hears")).toHaveTextContent("Soundcheck level");
  expect(screen.getByRole("group", { name: "Main fader raised" })).toBeVisible();
  view.rerender(<VisualArtifactView artifact={readVisualArtifactMarker(marker)!} />);
  choose("Monitor send", "Raised");
  expect(screen.getByRole("group", { name: "Both raised" })).toBeVisible();
  choose("Main vocal fader", "Soundcheck");
  expect(screen.getByRole("group", { name: "Monitor send raised" })).toBeVisible();
  expect(reading("Audience hears")).toHaveTextContent("Soundcheck level");
});

it("reveals a joint inference only for its combination of sources", () => {
  const artifact = parseVisualArtifact(compositions[1].artifact);
  render(<VisualArtifactView artifact={artifact} />);
  const joint = () => screen.queryByRole("heading", { name: "Supported together" });
  choose("Projectionist’s log", "Consult");
  expect(joint()).toBeNull();
  choose("Public notice", "Consult");
  expect(joint()).toBeVisible();
  choose("Projectionist’s log", "Set aside");
  expect(joint()).toBeNull();
  expect(screen.getByRole("heading", { name: "Public notice" })).toBeVisible();
});

it("prints every combination and reading without interactive controls", () => {
  const marker = visualArtifactMarker(parseVisualArtifact(compositions[0].artifact));
  render(<ExportVisualArtifact marker={marker} />);
  expect(screen.getByText("Monitor send = Soundcheck · Main vocal fader = Raised")).toBeVisible();
  expect(screen.getByText("Monitor send = Raised · Main vocal fader = Soundcheck")).toBeVisible();
  expect(screen.getAllByRole("table")).toHaveLength(2);
  expect(screen.queryByRole("radio")).toBeNull();
});
