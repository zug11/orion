// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { NoteView } from "./NoteView";
import type { Note } from "../types";
import type { ChatEditApplication } from "../lib/chatEdits";
const base = "---\nprivate: kept\n---\n\nAn old opening.\n\nKeep **this formatting**.\n\n- [x] A finished task";
const note: Note = { id: "draft", title: "Draft", slug: "draft", summary: "", body: base, aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" };
const request: ChatEditApplication = { id: "apply-once", proposal: { spaceId: "space", noteId: note.id, title: note.title, baseBody: base, edits: [{ before: "An old opening.", after: "A clearer opening." }] } };
afterEach(cleanup);
beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) },
}));
it("opens the real editor from preview, autosaves once, and preserves one Undo through parent echoes", async () => {
  const save = vi.fn(), complete = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(note), [application, setApplication] = useState<ChatEditApplication>();
    return <><button onClick={() => setApplication(request)}>Apply proposed edit</button><NoteView note={current} notes={[current]} concepts={[]}
      chatEdit={application} onChatEditComplete={(id, error, accepted) => { complete(id, error, accepted); setApplication(undefined); }}
      onUpdateNote={next => { save(next); setCurrent(next); }} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} /></>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Apply proposed edit" }));
  await screen.findByRole("button", { name: "Accept changes" });
  expect(save).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(Array.from(document.querySelectorAll(".chat-note-removed"), el => el.textContent).join(" ")).toContain("old");
  expect(Array.from(document.querySelectorAll(".chat-note-addition"), el => el.textContent).join(" ")).toContain("clearer");
  fireEvent.click(screen.getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(request.id, undefined, true));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("A clearer opening.");
  expect(save.mock.calls.filter(([next]) => next.body.includes("A clearer opening."))).toHaveLength(1);
  expect(save.mock.lastCall![0].body).toContain("private: kept");
  expect(save.mock.lastCall![0].body).toContain("**this formatting**");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("An old opening."));
  expect(save.mock.lastCall![0].body).toContain("- [x] A finished task");
});
it("refuses a stale proposal before opening or changing the note", async () => {
  const complete = vi.fn(), save = vi.fn();
  render(<NoteView note={{ ...note, body: base + "\n\nTyped later." }} notes={[note]} concepts={[]} chatEdit={request} onChatEditComplete={complete}
    onUpdateNote={save} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  await waitFor(() => expect(complete).toHaveBeenCalledWith(request.id, expect.stringContaining("changed")));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
});
it.each([false, true])("reviews a full rewrite and added paragraph without saving; accept=%s", async accept => {
  const save = vi.fn(), complete = vi.fn();
  const rewrite = "A new opening.\n\nKeep **this formatting**.\n\n- [x] A finished task\n\nAn added closing paragraph.";
  const application: ChatEditApplication = { id: "rewrite", proposal: { ...request.proposal, mode: "rewrite", rewrite, edits: [] } };
  render(<NoteView note={note} notes={[note]} concepts={[]} chatEdit={application} onChatEditComplete={complete}
    onUpdateNote={save} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  await screen.findByRole("button", { name: "Accept changes" });
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector(".chat-note-addition--block")).toHaveTextContent("An added closing paragraph.");
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveAttribute("contenteditable", "false");
  fireEvent.click(screen.getByRole("button", { name: accept ? "Accept changes" : "Discard" }));
  await waitFor(() => expect(complete).toHaveBeenCalledWith("rewrite", undefined, accept));
  expect(document.querySelector(".chat-note-addition")).toBeNull();
  if (accept) {
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.lastCall![0].body).toContain("An added closing paragraph.");
    expect(save.mock.lastCall![0].body).toContain("private: kept");
  } else { expect(save).not.toHaveBeenCalled(); expect(screen.getByRole("textbox", { name: "Note body" })).not.toHaveTextContent("An added closing paragraph."); }
});
it("invalidates the in-note preview when an external body arrives", async () => {
  const save = vi.fn(), complete = vi.fn();
  const props = { note, notes: [note], concepts: [], chatEdit: request, onChatEditComplete: complete,
    onUpdateNote: save, onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const { rerender } = render(<NoteView {...props} />);
  await screen.findByRole("button", { name: "Accept changes" });
  rerender(<NoteView {...props} note={{ ...note, body: base + "\n\nNew text from another window." }} />);
  await waitFor(() => expect(complete).toHaveBeenCalledWith(request.id, expect.stringContaining("changed")));
  expect(screen.queryByRole("button", { name: "Accept changes" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("New text from another window.");
  expect(save).not.toHaveBeenCalled();
});

it("keeps external review visible during its native claim, prevents duplicate accepts, and retains one Undo", async () => {
  const save = vi.fn(), complete = vi.fn();
  let approve!: () => void;
  const claim = vi.fn(() => new Promise<void>(resolve => { approve = resolve; }));
  function Harness() {
    const [current, setCurrent] = useState(note), [application, setApplication] = useState<ChatEditApplication | undefined>(request);
    return <NoteView note={current} notes={[current]} concepts={[]} chatEdit={application}
      onChatEditBeforeAccept={claim} onChatEditComplete={(...args) => { complete(...args); setApplication(undefined); }}
      onUpdateNote={next => { save(next); setCurrent(next); }} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />;
  }
  render(<Harness />);
  const accept = await screen.findByRole("button", { name: "Accept changes" });
  fireEvent.click(accept); fireEvent.click(accept);
  await waitFor(() => expect(claim).toHaveBeenCalledExactlyOnceWith(request.id));
  expect(screen.getByRole("region", { name: "Review note changes" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Accepting…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
  approve();
  await waitFor(() => expect(complete).toHaveBeenCalledExactlyOnceWith(request.id, undefined, true));
  expect(save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(save.mock.lastCall![0].body).toContain("An old opening."));
});

it.each(["external body", "cancelled review", "unmount"])("does not apply a pending claimed edit after %s", async reason => {
  const save = vi.fn(), complete = vi.fn();
  let approve!: () => void;
  const claim = vi.fn(() => new Promise<void>(resolve => { approve = resolve; }));
  const props = { note, notes: [note], concepts: [], chatEdit: request, onChatEditBeforeAccept: claim, onChatEditComplete: complete,
    onUpdateNote: save, onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const view = render(<NoteView {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(claim).toHaveBeenCalledOnce());
  if (reason === "external body") view.rerender(<NoteView {...props} note={{ ...note, body: base + "\n\nNew author text." }} />);
  else if (reason === "cancelled review") view.rerender(<NoteView {...props} chatEdit={undefined} />);
  else view.unmount();
  approve();
  await waitFor(() => expect(complete).toHaveBeenCalled());
  expect(complete.mock.calls.some(call => call[2] === true)).toBe(false);
  expect(save).not.toHaveBeenCalled();
});

it("reports preview readiness, then refuses another review while the real editor has an inline operation", async () => {
  const ready: { current: (() => boolean) | null } = { current: null };
  const receive = vi.fn((_id: string, check: (() => boolean) | null) => { ready.current = check; });
  const view = render(<NoteView note={note} notes={[note]} concepts={[]} sources={[{ id: "source", title: "Source", kind: "text", text: "Evidence", noteIds: [], importedAt: "now" }]} onReviewReadinessChange={receive}
    onUpdateNote={vi.fn()} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  expect(ready.current?.()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Note body" });
  await waitFor(() => expect(ready.current?.()).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Cite a source" }));
  await waitFor(() => expect(ready.current?.()).toBe(false));
  view.unmount(); expect(ready.current).toBe(null);
});
