import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { createVoiceSelectionStore } from "../lib/voiceSelection";
import type { Note } from "../types";
import type { VisualArtifact } from "../lib/visualArtifacts";
import { generateVisualArtifact } from "../lib/visualArtifactGeneration";
import { NoteAISettingsContext } from "./NoteAISettingsContext";
import { NoteView } from "./NoteView";

vi.mock("../lib/visualArtifactGeneration", () => ({ generateVisualArtifact: vi.fn() }));
const generate = vi.mocked(generateVisualArtifact);
const passage = "An electric motor spins the drum.";
const initial: Note = { id: "washer", title: "Wash cycle", body: [passage, "First rinse.", passage, "Final rinse."].join("\n\n"),
  kind: "article", slug: "washer", status: "ready", summary: "", tags: [], aliases: [], sourceIds: [], conceptIds: [],
  createdAt: "2026-11-24", updatedAt: "2026-11-24" };
const artifact: VisualArtifact = { version: 1, format: "explainer", title: "The rotating drum",
  blocks: [{ kind: "text", text: "The motor turns the drum." }] };

beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect(10, 10, 150, 24) },
}));
beforeAll(() => Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
}));
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  generate.mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); });

function setup() {
  const store = createVoiceSelectionStore("space");
  const onFinish = vi.fn();
  const settings = { ...createEmptySnapshot().settings, apiKeyConfigured: true, model: "gpt-5.6-sol" };
  let latest: Note = initial;
  function Harness() {
    const [note, setNote] = useState(initial); latest = note;
    return <NoteAISettingsContext.Provider value={settings}><NoteView note={note} notes={[note]} concepts={[]} voiceSelection={store}
      onUpdateNote={setNote} onFinishEditing={onFinish}
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} /></NoteAISettingsContext.Provider>;
  }
  const view = render(<Harness />);
  async function open() {
    const body = view.container.querySelector('[data-voice-note-body="reading"]')!;
    const target = body.querySelectorAll("p")[2];
    fireEvent.pointerDown(target);
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(target);
      const selected = window.getSelection()!;
      selected.removeAllRanges(); selected.addRange(range);
    });
    fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(target);
    fireEvent.click(await screen.findByRole("button", { name: "Visualise" }));
    return screen.findByRole("dialog", { name: "Visualise" });
  }
  return { open, latest: () => latest, onFinish, view };
}

it("anchors the second identical passage, retries on request, then renders the saved card without a wiki refresh", async () => {
  generate.mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce(artifact);
  const { open, latest, onFinish } = setup();
  await open();
  const button = screen.getByRole("button", { name: "Generate for me" });
  expect(generate).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(latest().body).not.toContain("orion-artifact");
  fireEvent.click(button);
  await waitFor(() => expect(latest().body).toContain("orion-artifact:v1"));
  expect(latest().body).toContain([passage, "First rinse.", passage, "<!-- orion-artifact:v1"].join("\n\n"));
  expect(latest().body.trimEnd()).toMatch(/-->\n\nFinal rinse\.$/);
  expect(generate.mock.calls.map(call => call.slice(0,3))).toEqual([[passage, "auto", ""], [passage, "auto", ""]]);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByRole("heading", { name: artifact.title })).toBeVisible();
  expect(onFinish).not.toHaveBeenCalled();
});

it("cancels an in-flight request and ignores a late result after returning to reading", async () => {
  let finish!: (value: VisualArtifact) => void;
  generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { open, latest } = setup();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Generate for me" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(generate.mock.calls[0][4].aborted).toBe(true);
  await act(async () => { finish(artifact); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(latest().body.trimEnd()).toBe(initial.body);
  expect(document.querySelector('[data-voice-note-body="reading"]')).toBeTruthy();
});
