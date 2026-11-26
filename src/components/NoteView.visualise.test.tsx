import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { createVoiceSelectionStore } from "../lib/voiceSelection";
import type { Note } from "../types";
import type { VisualArtifact } from "../lib/visualArtifacts";
import { generatePassageIllustration, generateVisualArtifact } from "../lib/visualArtifactGeneration";
import { NoteAISettingsContext } from "./NoteAISettingsContext";
import { DictationNavigationContext } from "./DictationNavigation";
import { NoteView } from "./NoteView";

vi.mock("../lib/visualArtifactGeneration", async original => ({
  ...await original<typeof import("../lib/visualArtifactGeneration")>(), generatePassageIllustration: vi.fn(), generateVisualArtifact: vi.fn(),
}));
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
  vi.mocked(generatePassageIllustration).mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.getSelection()?.removeAllRanges(); });

function setup(noteToOpen = initial) {
  const store = createVoiceSelectionStore("space");
  const onFinish = vi.fn();
  const settings = { ...createEmptySnapshot().settings, apiKeyConfigured: true, model: "gpt-5.6-sol" };
  let latest: Note = noteToOpen;
  function Harness({ background = false }: { background?: boolean }) {
    const [note, setNote] = useState(noteToOpen); latest = note;
    return <DictationNavigationContext.Provider value={{ background, blocked: false, noteTitle: note.title, onReturn: undefined }}>
      <NoteAISettingsContext.Provider value={settings}><NoteView note={note} notes={[note]} concepts={[]} voiceSelection={store}
      onUpdateNote={next => setNote(next)} onFinishEditing={onFinish}
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} /></NoteAISettingsContext.Provider>
    </DictationNavigationContext.Provider>;
  }
  const view = render(<Harness />);
  async function open(start = 2, end = start) {
    const body = view.container.querySelector('[data-voice-note-body="reading"]')!;
    const paragraphs = body.querySelectorAll("p");
    const target = paragraphs[start];
    fireEvent.pointerDown(target);
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(target);
      if (start !== end) range.setEnd(paragraphs[end], paragraphs[end].childNodes.length);
      const selected = window.getSelection()!;
      selected.removeAllRanges(); selected.addRange(range);
    });
    fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(target);
    fireEvent.click(await screen.findByRole("button", { name: "Visualise" }));
    return screen.findByRole("dialog", { name: "Visualise" });
  }
  return { open, latest: () => latest, onFinish, view, setBackground: (background: boolean) => view.rerender(<Harness background={background} />) };
}

it("anchors the second identical passage, retries on request, then renders the saved card without a wiki refresh", async () => {
  generate.mockRejectedValueOnce(new Error("Connection interrupted")).mockResolvedValueOnce(artifact);
  const { open, latest, onFinish } = setup({ ...initial, writingOrigins: ["mcp"] });
  await open();
  const button = screen.getByRole("button", { name: "Generate for me" });
  expect(generate).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
  expect(latest().body).not.toContain("orion-artifact");
  expect(latest().writingOrigins).toEqual(["mcp"]);
  fireEvent.click(button);
  await waitFor(() => expect(latest().body).toContain("orion-artifact:v1"));
  expect(latest().body).toContain([passage, "First rinse.", passage, "<!-- orion-artifact:v1"].join("\n\n"));
  expect(latest().body.trimEnd()).toMatch(/-->\n\nFinal rinse\.$/);
  expect(generate.mock.calls.map(call => call.slice(0,3))).toEqual([[passage, "auto", ""], [passage, "auto", ""]]);
  expect(latest().writingOrigins).toEqual(["orion-ai", "mcp"]);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(latest().body.trimEnd()).toBe(initial.body));
  expect(latest().writingOrigins).toEqual(["mcp"]);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  await waitFor(() => expect(latest().body).toContain("orion-artifact:v1"));
  expect(latest().writingOrigins).toEqual(["orion-ai", "mcp"]);
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByRole("heading", { name: artifact.title })).toBeVisible();
  expect(onFinish).not.toHaveBeenCalled();
});

it("passes an entire long reading selection to generation, reports progress and cancels safely", async () => {
  const first = "First section 🚲. ".repeat(450).trim();
  const middle = "Middle section 🚀. ".repeat(450).trim();
  const last = "Last section 🧭. ".repeat(450) + "Only at the end.";
  const body = ["Outside before.", first, middle, last, "Outside after."].join("\n\n");
  const selectedText = [first, middle, last].join("\n\n");
  let finish!: (value: VisualArtifact) => void;
  generate.mockImplementation((_source, _format, _guidance, _settings, _signal, _preview, _heading, _model, progress) => {
    progress?.("Reading selection · section 2 of 3");
    return new Promise(resolve => { finish = resolve; });
  });
  const { open, latest } = setup({ ...initial, body });
  await open(1, 3);
  expect(screen.getByRole("blockquote", { name: "Selected passage" }).textContent!.length).toBeLessThan(400);
  expect(generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Generate for me" }));
  expect(generate.mock.calls[0][0]).toBe(selectedText);
  expect(screen.getByText("Reading selection · section 2 of 3")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(generate.mock.calls[0][4].aborted).toBe(true);
  await act(async () => finish(artifact));
  expect(latest().body).toBe(body);
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
  expect(latest().writingOrigins).toBeUndefined();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(latest().body.trimEnd()).toBe(initial.body);
  expect(document.querySelector('[data-voice-note-body="reading"]')).toBeTruthy();
});

it("cancels generation when a recording keeps the note mounted in the background", async () => {
  let finish!: (value: VisualArtifact) => void;
  generate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { open, latest, setBackground } = setup();
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Generate for me" }));
  setBackground(true);
  expect(generate.mock.calls[0][4].aborted).toBe(true);
  await act(async () => finish(artifact));
  setBackground(false);
  expect(screen.queryByRole("dialog", { name: "Visualise" })).toBeNull();
  expect(latest().body.trimEnd()).toBe(initial.body);
  expect(latest().writingOrigins).toBeUndefined();
});


it("shows the drawing model before any call and the verified model during optional visual review", async () => {
  const longDrawingSource = passage.repeat(500) + " Draw the belt behind the drum.";
  let finish!: (value: VisualArtifact) => void;
  vi.mocked(generatePassageIllustration).mockImplementation((_source, _guidance, _settings, _signal, options) => {
    options?.onModelSelected?.("Verified Astra · high effort");
    options?.onReviewStart?.();
    return new Promise(resolve => { finish = resolve; });
  });
  const { open, latest } = setup({ ...initial, body: longDrawingSource });
  await open(0);
  fireEvent.click(screen.getByText("Choose a starting format"));
  fireEvent.change(screen.getByRole("combobox", { name: "Format" }), { target: { value: "illustration" } });
  expect(screen.getByText(/Drawing model · .*astra/i)).toBeVisible();
  expect(generatePassageIllustration).not.toHaveBeenCalled();
  const checkbox = screen.getByRole("checkbox", { name: /Have AI review the drawing/ });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  expect(vi.mocked(generatePassageIllustration).mock.calls[0][0]).toBe(longDrawingSource);
  expect(vi.mocked(generatePassageIllustration).mock.calls[0][4]?.review).toBe(true);
  expect(screen.getByRole("button", { name: "Reviewing drawing…" })).toBeDisabled();
  expect(screen.getByText("Drawing model · Verified Astra · high effort")).toBeVisible();
  await act(async () => finish(artifact));
  expect(latest().body).toContain("orion-artifact");
});
