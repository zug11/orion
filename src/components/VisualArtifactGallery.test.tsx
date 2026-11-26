import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VisualArtifactView } from "./VisualArtifactView";
import { ExportVisualArtifact } from "../lib/visualArtifactExport";
import { visualArtifactMarker } from "../lib/visualArtifactMarkdown";
import { addReadingArtifactTasks } from "../lib/visualArtifactNoteTasks";
import { parseVisualArtifact } from "../lib/visualArtifacts";
import fixtures from "../lib/fixtures/mcpVisualArtifacts.json";

const flow = parseVisualArtifact(fixtures.find(entry => entry.name.startsWith("Quantity flow,"))!.artifact);
const marker = visualArtifactMarker(flow);

describe("gallery artifacts in notes", () => {
  it("updates the flow at zero and full allocation while keeping zero destinations readable", () => {
    const {container} = render(<VisualArtifactView artifact={flow}/>);
    const bands = () => container.querySelectorAll(".va-quantity-flow svg path");
    expect(bands()).toHaveLength(2);
    const start = bands()[0].getAttribute("d");
    const slider = screen.getByRole("slider", { name: "Allocated" });
    fireEvent.change(slider,{target:{value:"10"}});
    expect(bands()).toHaveLength(1);
    expect(bands()[0].getAttribute("d")).not.toBe(start);
    const figure = container.querySelector<HTMLElement>(".va-quantity-flow")!;
    expect(within(figure).getByText("Tank B · 0 L")).toBeVisible();
    fireEvent.change(slider,{target:{value:"0"}});
    expect(bands()).toHaveLength(1);
    expect(within(figure).getByText("Tank A · 0 L")).toBeVisible();
  });

  it("matches source excerpts literally, marks missing support and keeps it legible in print", () => {
    const artifact = {...flow, evidence:{passage:"In July there were ten litres.",claims:[
      {label:"Month",quotes:["July"]},{label:"Invented amount",quotes:["ninety litres"]}]}};
    const {container, unmount} = render(<VisualArtifactView artifact={artifact}/>);
    fireEvent.click(screen.getByText("Sources in the passage"));
    fireEvent.focus(screen.getByRole("button",{name:"Month"}));
    expect(container.querySelector("mark")).toHaveTextContent("July");
    fireEvent.click(screen.getByRole("button",{name:/Invented amount.*No matching excerpt/}));
    expect(container.querySelector("mark")).toBeNull();
    unmount();
    render(<ExportVisualArtifact marker={visualArtifactMarker(artifact)}/>);
    expect(screen.getByText("Sources in the passage")).toBeVisible();
    expect(screen.getByText(/No matching excerpt/)).toBeVisible();
  });

  it("opens the matching passage directly from a cited input, including a missing-source flag", () => {
    const artifact = parseVisualArtifact({...flow, evidence:{passage:"Ten litres are available.", claims:[
      {label:"Initial volume",quotes:["Ten litres"],target:{block:0,field:"input",index:0}},
      {label:"Destination",quotes:[],target:{block:0,field:"output",index:1}}]}});
    const {container} = render(<VisualArtifactView artifact={artifact}/>);
    fireEvent.click(screen.getByRole("button",{name:"Source for Initial volume"}));
    expect(container.querySelector("details.va-evidence")).toHaveAttribute("open");
    expect(container.querySelector("mark")).toHaveTextContent("Ten litres");
    const absent = screen.getByRole("button",{name:"Source for Destination"});
    expect(absent).toHaveTextContent("Missing source");
    fireEvent.click(absent);
    expect(container.querySelector("mark")).toBeNull();
  });

  it("highlights overlapping excerpts and resets the selection when the source changes", () => {
    const evidence = { passage: "aaaa", claims: [
      { label: "First", quotes: ["a"] }, { label: "Second", quotes: ["aaa"] },
    ] };
    const { container, rerender } = render(<VisualArtifactView artifact={{...flow, evidence}}/>);
    fireEvent.click(screen.getByText("Sources in the passage"));
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(container.querySelector("mark")).toHaveTextContent("aaaa");
    rerender(<VisualArtifactView artifact={{...flow, evidence: {passage: "New source", claims: [
      {label: "New", quotes: ["source"]},
    ]}}}/>);
    expect(container.querySelector("mark")).toHaveTextContent("source");
  });

  it("places literal shopping tasks below the clicked occurrence, skipping frontmatter and code examples", () => {
    const before = "---\nlayout: page\n---\n\n```md\n" + marker + "\n```\n\n" + marker + "\n\nMiddle\n\n" + marker;
    const updated = addReadingArtifactTasks(before, marker, 1, ["4 pears","1 kg\nflour", "1 <b>"]);
    expect(updated).toBe(before + "\n\n- [ ] 4 pears\n- [ ] 1 kg flour\n- [ ] 1 &#60;b&#62;");
    expect(addReadingArtifactTasks(before, marker, 2, ["4 pears"])).toBeUndefined();
  });
});
