// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { NoteView } from "./NoteView";

afterEach(cleanup);
function renderTable(body: string) {
  const note: Note = { id: "table-note", title: "Table note", slug: "table-note", summary: "", body, aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
  return render(<NoteView note={note} notes={[note]} concepts={[]} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onUpdateNote={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
}

describe("reading tables from preview Markdown", () => {
  it("suppresses only the synthetic empty header and preserves author data and layout", () => {
    const { container } = renderTable('# Table note\n\n<!-- orion-table:v1 {"width":65,"header":false,"banded":true,"columns":[160,220]} -->\n| | |\n| --- | --- |\n| Author row | Evidence |\n| Second row | Details |');
    const wrapper = container.querySelector<HTMLElement>(".note-table-reading")!;
    expect(wrapper.style.width).toBe("65%");
    expect(wrapper.dataset.header).toBe("false");
    expect(wrapper.dataset.banded).toBe("true");
    expect(wrapper.querySelector("thead")).toBeNull();
    expect([...wrapper.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual(["Author rowEvidence", "Second rowDetails"]);
    expect([...wrapper.querySelectorAll<HTMLElement>("col")].map((column) => column.style.width)).toEqual(["160px", "220px"]);
    expect(container.querySelector(".note-prose")?.textContent).not.toContain("orion-table:v1");
  });

  it("keeps a nonempty authored header when pasted header-off metadata is inconsistent", () => {
    const { container } = renderTable('<!-- orion-table:v1 {"header":false} -->\n| Keep this | Evidence |\n| --- | --- |\n| Author row | Details |');
    const wrapper = container.querySelector<HTMLElement>(".note-table-reading")!;
    expect(wrapper.dataset.header).toBe("true");
    expect(wrapper.querySelector("thead")?.textContent).toBe("Keep thisEvidence");
    expect(wrapper.querySelector("tbody")?.textContent).toBe("Author rowDetails");
  });

  it("hides only real table metadata while preserving literal code examples and later table line positions", () => {
    const metadata = '<!-- orion-table:v1 {"width":65,"header":false,"banded":false,"columns":[160,220]} -->';
    const second = '<!-- orion-table:v1 {"width":80,"header":true,"columns":[120,190]} -->';
    const { container } = renderTable([
      "```markdown", metadata, "| | |", "| --- | --- |", "| Example | Code |", "```", "",
      `Inline example: \`${metadata}\``, "",
      metadata, "| | |", "| --- | --- |", "| Actual | Contents |", "",
      "## Following heading", "",
      second, "", "| First | Second |", "| --- | --- |", "| Later | Table |",
    ].join("\n"));
    const prose = container.querySelector(".note-prose")!;
    expect([...prose.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      `${metadata}\n| | |\n| --- | --- |\n| Example | Code |\n`, metadata,
    ]);
    const reading = [...prose.querySelectorAll<HTMLElement>(".note-table-reading")];
    expect(reading.map((table) => table.style.width)).toEqual(["65%", "80%"]);
    expect(reading.map((table) => table.dataset.header)).toEqual(["false", "true"]);
    expect(reading[1].querySelectorAll("col")[1].getAttribute("style")).toContain("190px");
    expect(prose.textContent?.match(/orion-table:v1/g)).toHaveLength(2);
    expect(prose.querySelector("h2")?.textContent).toBe("Following heading");
  });
});
