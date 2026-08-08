// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Concept, Note, Source } from "../types";
import { NoteView } from "./NoteView";

const NOW = "2026-07-29T01:00:00.000Z";

describe("NoteView", () => {
  it("finds and cycles through text in the reading surface", () => {
    const note: Note = {
      id: "note-search",
      title: "Searchable note",
      slug: "searchable-note",
      summary: "A note with repeated language.",
      body: "Orion keeps ideas connected. Orion keeps their context.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    const { container } = render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find in note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find text in note" }), {
      target: { value: "orion" },
    });

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-note-find-match="true"]'),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-note-find-match].is-current'),
    ).toHaveLength(1);
  });

  it("opens note find with the platform shortcut", () => {
    const note: Note = {
      id: "note-shortcut",
      title: "Shortcut note",
      slug: "shortcut-note",
      summary: "Keyboard accessible.",
      body: "Find this text.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(
      screen.getByRole("textbox", { name: "Find text in note" }),
    ).toBeInTheDocument();
  });

  it("closes Find without moving the reading position", async () => {
    const note: Note = {
      id: "note-find-position",
      title: "Long reading",
      slug: "long-reading",
      summary: "Keep the reader in place.",
      body: `${"Opening context.\n\n".repeat(20)}Find this passage.`,
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { container } = render(
      <main className="workspace-content">
        <NoteView
          note={note}
          notes={[note]}
          concepts={[]}
          onOpenNote={vi.fn()}
          onOpenConcept={vi.fn()}
          onUpdateNote={vi.fn()}
          onDeleteNote={vi.fn()}
          onRegisterConcept={vi.fn()}
          onDisableConceptAutoLink={vi.fn()}
        />
      </main>,
    );
    const workspace = container.querySelector<HTMLElement>(".workspace-content");
    if (!workspace) throw new Error("Missing workspace test container");
    workspace.scrollTop = 640;
    workspace.scrollLeft = 12;

    fireEvent.click(screen.getByRole("button", { name: "Find in note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Find text in note" }), {
      target: { value: "passage" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close find" }));

    await waitFor(() => {
      expect(workspace.scrollTop).toBe(640);
      expect(workspace.scrollLeft).toBe(12);
    });
  });

  it("finds read-mode title and summary text, then clears and restores focus", async () => {
    const note: Note = {
      id: "note-find-scope",
      title: "Atlas field notes",
      slug: "atlas-field-notes",
      summary: "An atlas summary.",
      body: "Atlas body text.",
      aliases: [],
      tags: ["research", "ai-draft", "orion-link-pending"],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    const { container } = render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    const findButton = screen.getByRole("button", { name: "Find in note" });
    const focusSpy = vi.spyOn(findButton, "focus");
    fireEvent.click(findButton);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find text in note" }),
      { target: { value: "atlas" } },
    );

    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-note-find-match="true"]'),
    ).toHaveLength(3);
    expect(screen.getByText("#research")).toBeVisible();
    expect(screen.queryByText("#ai-draft")).not.toBeInTheDocument();
    expect(screen.queryByText("#orion-link-pending")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close find" }));

    expect(
      screen.queryByRole("textbox", { name: "Find text in note" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-note-find-match="true"]'),
    ).toHaveLength(0);
    await waitFor(() => expect(findButton).toHaveFocus());
    expect(focusSpy).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("renders the note outline on the left and scrolls to duplicate-safe headings", () => {
    const note: Note = {
      id: "note-outline",
      title: "Outlined note",
      slug: "outlined-note",
      summary: "A structured note.",
      body: "## Introduction\n\nText.\n\n### Detail\n\nMore.\n\n## Introduction\n\nAgain.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { container } = render(
      <main className="workspace-content">
        <NoteView
          note={note}
          notes={[note]}
          concepts={[]}
          onOpenNote={vi.fn()}
          onOpenConcept={vi.fn()}
          onUpdateNote={vi.fn()}
          onDeleteNote={vi.fn()}
          onRegisterConcept={vi.fn()}
          onDisableConceptAutoLink={vi.fn()}
        />
      </main>,
    );

    const outline = screen.getByRole("navigation", { name: "Note outline" });
    expect(container.querySelector(".note-view")).toHaveClass("has-outline");
    expect(within(outline).getAllByRole("button")).toHaveLength(3);
    expect(container.querySelector("#heading-introduction")).toBeTruthy();
    const repeated = container.querySelector<HTMLElement>(
      "#heading-introduction-2",
    );
    expect(repeated).toBeTruthy();
    const scrollIntoView = vi.fn();
    if (repeated) repeated.scrollIntoView = scrollIntoView;

    fireEvent.click(
      within(outline).getAllByRole("button", { name: "Introduction" })[1],
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
    expect(
      within(outline).getAllByRole("button", { name: "Introduction" })[1],
    ).toHaveAttribute("aria-current", "location");
  });

  it("uses the full reading column when the note has no outline", () => {
    const note: Note = {
      id: "note-without-outline",
      title: "Unsectioned note",
      slug: "unsectioned-note",
      summary: "A note without subheadings.",
      body: "This prose should use the complete reading measure.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { container } = render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    expect(container.querySelector(".note-view")).not.toHaveClass(
      "has-outline",
    );
    expect(
      screen.queryByRole("navigation", { name: "Note outline" }),
    ).not.toBeInTheDocument();
  });

  it("marks the final outline section active at the bottom of the note", async () => {
    const note: Note = {
      id: "note-outline-bottom",
      title: "Bottom tracking",
      slug: "bottom-tracking",
      summary: "A short final section cannot reach the top threshold.",
      body: "## Earlier section\n\nLong context.\n\n## Final section\n\nShort ending.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { container } = render(
      <main className="workspace-content">
        <NoteView
          note={note}
          notes={[note]}
          concepts={[]}
          onOpenNote={vi.fn()}
          onOpenConcept={vi.fn()}
          onUpdateNote={vi.fn()}
          onDeleteNote={vi.fn()}
          onRegisterConcept={vi.fn()}
          onDisableConceptAutoLink={vi.fn()}
        />
      </main>,
    );
    const workspace = container.querySelector<HTMLElement>(".workspace-content");
    const earlier = container.querySelector<HTMLElement>(
      "#heading-earlier-section",
    );
    const final = container.querySelector<HTMLElement>("#heading-final-section");
    if (!workspace || !earlier || !final) {
      throw new Error("Missing outline scroll test elements");
    }
    Object.defineProperties(workspace, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_000 },
    });
    workspace.scrollTop = 500;
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      top: 0,
    } as DOMRect);
    vi.spyOn(earlier, "getBoundingClientRect").mockReturnValue({
      top: 80,
    } as DOMRect);
    vi.spyOn(final, "getBoundingClientRect").mockReturnValue({
      top: 460,
    } as DOMRect);

    fireEvent.scroll(workspace);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Final section" }),
      ).toHaveAttribute("aria-current", "location"),
    );
  });

  it("exposes first-class note deletion from the note header", () => {
    const onDeleteNote = vi.fn();
    const note: Note = {
      id: "note-comte",
      title: "Auguste Comte",
      slug: "auguste-comte",
      summary: "A French philosopher.",
      body: "Comte developed positivism.",
      aliases: [],
      tags: [],
      kind: "wiki",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={onDeleteNote}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(onDeleteNote).toHaveBeenCalledWith(note.id);
  });

  it("finishes dirty editing when navigation replaces the note", () => {
    const onFinishEditing = vi.fn();
    const first: Note = {
      id: "note-first",
      title: "First note",
      slug: "first-note",
      summary: "The first summary.",
      body: "The first note has enough body text to be meaningful.",
      aliases: [],
      tags: [],
      kind: "wiki",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const second = { ...first, id: "note-second", title: "Second note" };
    const shared = {
      concepts: [],
      onOpenNote: vi.fn(),
      onOpenConcept: vi.fn(),
      onUpdateNote: vi.fn(),
      onDeleteNote: vi.fn(),
      onFinishEditing,
      onRegisterConcept: vi.fn(),
      onDisableConceptAutoLink: vi.fn(),
    };
    const { rerender } = render(
      <NoteView note={first} notes={[first, second]} {...shared} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), {
      target: { value: "Revised first note" },
    });
    rerender(<NoteView note={second} notes={[first, second]} {...shared} />);

    expect(onFinishEditing).toHaveBeenCalledOnce();
    expect(onFinishEditing).toHaveBeenCalledWith("note-first");
  });

  it("checks a task directly while reading without entering edit mode", () => {
    const onUpdateNote = vi.fn();
    const note: Note = {
      id: "note-plan",
      title: "Launch plan",
      slug: "launch-plan",
      summary: "Things to finish.",
      body: "## Today\n\n- [ ] Review the release",
      aliases: [],
      tags: [],
      kind: "project",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={onUpdateNote}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Complete Review the release",
      }),
    );

    expect(onUpdateNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "## Today\n\n- [x] Review the release",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Edit" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("renders known concepts as links in the reading surface", () => {
    const sourceNote: Note = {
      id: "note-lecture",
      title: "Lecture notes",
      slug: "lecture-notes",
      summary: "A short reading note.",
      body: "The lecture introduces positivism as a theory of knowledge.",
      aliases: [],
      tags: [],
      kind: "project",
      status: "ready",
      conceptIds: ["concept-positivism"],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const article: Note = {
      ...sourceNote,
      id: "note-positivism",
      title: "Positivism",
      slug: "positivism",
      summary: "A wiki article.",
      body: "Positivism prioritizes observable knowledge.",
      kind: "wiki",
      conceptIds: ["concept-positivism"],
    };
    const concept: Concept = {
      id: "concept-positivism",
      label: "Positivism",
      aliases: [],
      description: "A theory of knowledge.",
      noteIds: [article.id],
      canonicalNoteId: article.id,
      color: "#8798ff",
      autoLink: true,
    };
    const onOpenConcept = vi.fn();

    render(
      <NoteView
        note={sourceNote}
        notes={[sourceNote, article]}
        concepts={[concept]}
        onOpenNote={vi.fn()}
        onOpenConcept={onOpenConcept}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "positivism, open wiki article",
      }),
    );
    expect(onOpenConcept).toHaveBeenCalledWith(concept.id);
  });

  it("opens a cited Orion source from the reading surface", () => {
    const source: Source = {
      id: "source-lecture",
      title: "Lecture transcript",
      kind: "audio",
      importedAt: NOW,
      text: "The original transcript.",
      noteIds: ["note-citation"],
    };
    const note: Note = {
      id: "note-citation",
      title: "Cited note",
      slug: "cited-note",
      summary: "A note with a portable source citation.",
      body: "This follows the [Lecture transcript](orion-source://source-lecture).",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [source.id],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const onOpenSource = vi.fn();

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        sources={[source]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onOpenSource={onOpenSource}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "References" })).toBeVisible();
    expect(screen.getByText("[1]")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Citation 1, open source Lecture transcript",
      }),
    );
    expect(onOpenSource).toHaveBeenCalledWith(source.id);
  });
});
