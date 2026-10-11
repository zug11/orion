// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Concept, Note } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";
import { createEmptySnapshot } from "../data/defaults";
import { generateLinkTitleWithDeduplication } from "../lib/linkTitle";

const NOW = "2026-07-28T10:00:00.000Z";

describe("ConceptLinkPopover", () => {
  it("starts with a focused note or URL destination and never requests AI on opening or search", () => {
    const onGenerateTitle = vi.fn();
    const onSubmit = vi.fn();
    const onNoteLink = vi.fn();
    renderView(<ConceptLinkPopover initialPhrase="it" selectedText="it" selectionMode="inline"
      initialDestinationIds={[]} currentNoteId="current"
      notes={[makeNote("current", "Draft"), makeNote("research", "Relational algebra")]}
      aiArticleWritingEnabled onGenerateTitle={onGenerateTitle} onCancel={vi.fn()}
      onSubmit={onSubmit} onNoteLink={onNoteLink} />);

    const destination = screen.getByRole("textbox", { name: "Search notes or paste a URL" });
    expect(destination).toHaveFocus();
    expect(screen.queryByLabelText("Page title")).not.toBeInTheDocument();
    fireEvent.change(destination, { target: { value: "algebra" } });
    expect(screen.queryByRole("button", { name: /Draft/ })).not.toBeInTheDocument();
    fireEvent.keyDown(destination, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /Relational algebra/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Relational algebra/ }));
    expect(onNoteLink).toHaveBeenCalledWith("research");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onGenerateTitle).not.toHaveBeenCalled();
  });

  it("links a selected phrase to a normalized URL with no key or article creation", () => {
    const onExternalLink = vi.fn();
    const onSubmit = vi.fn();
    renderView(<ConceptLinkPopover initialPhrase="the evidence" selectedText="the evidence" selectionMode="inline"
      initialDestinationIds={[]} currentNoteId="current" notes={[makeNote("current", "Draft")]}
      onExternalLink={onExternalLink} onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes or paste a URL" }), {
      target: { value: "example.com/research?year=2026#results" },
    });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(onExternalLink).toHaveBeenCalledWith("https://example.com/research?year=2026#results");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["javascript:alert(1)", "data:text/html,script", "file:///Users/me/note", "https://user:secret@example.com"])("refuses %s instead of creating an article", (url) => {
    const onExternalLink = vi.fn();
    const onSubmit = vi.fn();
    renderView(<ConceptLinkPopover initialPhrase="a phrase" initialDestinationIds={[]} currentNoteId="current"
      notes={[]} onExternalLink={onExternalLink} onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes or paste a URL" }), { target: { value: url } });
    expect(screen.getByRole("button", { name: "Add web link" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("dialog"));
    expect(screen.getByRole("alert")).toHaveTextContent("valid http:// or https://");
    expect(onExternalLink).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("opens the saved external destination explicitly while allowing its replacement", () => {
    const onOpenExternalLink = vi.fn();
    const onExternalLink = vi.fn();
    renderView(<ConceptLinkPopover initialPhrase="source" initialHref="https://example.com/original"
      initialDestinationIds={[]} currentNoteId="current" notes={[]}
      onOpenExternalLink={onOpenExternalLink} onExternalLink={onExternalLink} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const destination = screen.getByRole("textbox", { name: "Search notes or paste a URL" });
    expect(destination).toHaveValue("https://example.com/original");
    fireEvent.change(destination, { target: { value: "https://example.com/replacement" } });
    fireEvent.click(screen.getByRole("button", { name: "Open link in browser" }));
    expect(onOpenExternalLink).toHaveBeenCalledWith("https://example.com/original");
    expect(onExternalLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update link" }));
    expect(onExternalLink).toHaveBeenCalledWith("https://example.com/replacement");
  });

  it("returns from article creation to the destination search, and Escape cancels either view", () => {
    const onCancel = vi.fn();
    renderView(<ConceptLinkPopover initialPhrase="SQL" initialDestinationIds={[]} currentNoteId="current"
      notes={[]} onCancel={onCancel} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create a linked article" }));
    expect(screen.getByLabelText("Page title")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Back to link destinations" }));
    expect(screen.getByRole("textbox", { name: "Search notes or paste a URL" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("creates a blank named article without invoking AI", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit);

    fireEvent.click(
      screen.getByRole("button", { name: "Create blank article" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", [], {
      articleMode: "blank",
    });
  });

  it("round-trips explicit destinations for a legacy branched link", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit, ["note-current"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Create branched link" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", ["note-current"], {
      articleMode: "blank",
    });
  });

  it("makes source-aware AI writing explicit before article creation", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit, [], true);

    fireEvent.change(
      screen.getByPlaceholderText(
        "What should this page explain or emphasize?",
      ),
      { target: { value: "Focus on joins and relational algebra." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Generate article" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", [], {
      articleMode: "ai",
      articleInstructions: "Focus on joins and relational algebra.",
    });
  });

  it("keeps a large selection as context and requires a separate page title", () => {
    const onSubmit = vi.fn();
    render(
      <ConceptLinkPopover
        initialPhrase=""
        selectedText={[
          "const role = permissions.get(user);",
          "return role.canEdit;",
        ].join("\n")}
        selectionMode="context"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes")]}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Link selected context" }),
    ).toBeVisible();
    expect(screen.getByText("kept unchanged")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create blank article" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Page title"), {
      target: { value: "Permission check" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create blank article" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("Permission check", [], {
      articleMode: "blank",
    });
  });

  it("uses a short inline selection when the optional title is empty", () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn();
    render(
      <ConceptLinkPopover
        initialPhrase=""
        selectedText="SQL"
        selectionMode="inline"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes")]}
        aiArticleWritingEnabled
        onGenerateTitle={onGenerateTitle}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Generate article" }),
    );
    expect(onSubmit).toHaveBeenCalledWith("SQL", [], {
      articleMode: "ai",
    });
    expect(onGenerateTitle).not.toHaveBeenCalled();
  });

  it("optionally names a short selection even when it already fills the title field", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn().mockResolvedValue("Deleuze and Becoming");
    render(<ConceptLinkPopover initialPhrase="becoming" selectedText="becoming" selectionMode="inline"
      initialDestinationIds={[]} currentNoteId="note-current" notes={[makeNote("note-current", "Project notes")]}
      aiArticleWritingEnabled onGenerateTitle={onGenerateTitle} onCancel={vi.fn()} onSubmit={onSubmit} />);
    const toggle = screen.getByRole("checkbox", { name: "Generate title with AI" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Page title")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Name & generate article" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Deleuze and Becoming", [], { articleMode: "ai" }));
    expect(onGenerateTitle).toHaveBeenCalledWith("becoming", expect.any(AbortSignal));
  });

  it("keeps the user's title when AI naming is unchecked again", () => {
    const onSubmit = vi.fn(); const onGenerateTitle = vi.fn();
    render(<ConceptLinkPopover initialPhrase="Becoming" selectedText="becoming" selectionMode="inline"
      initialDestinationIds={[]} currentNoteId="note-current" notes={[makeNote("note-current", "Project notes")]}
      aiArticleWritingEnabled onGenerateTitle={onGenerateTitle} onCancel={vi.fn()} onSubmit={onSubmit} />);
    const toggle = screen.getByRole("checkbox", { name: "Generate title with AI" });
    fireEvent.click(toggle); fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Generate article" }));
    expect(onGenerateTitle).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith("Becoming", [], { articleMode: "ai" });
  });

  it("lets AI name a large selection before creating its article", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn().mockResolvedValue("Permission model");
    const selectedText = [
      "const role = permissions.get(user);",
      "return role.canEdit;",
    ].join("\n");
    render(
      <ConceptLinkPopover
        initialPhrase=""
        selectedText={selectedText}
        selectionMode="context"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes")]}
        aiArticleWritingEnabled
        onGenerateTitle={onGenerateTitle}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText("Page title")).toHaveAttribute(
      "placeholder",
      "Leave blank and Orion will name it…",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );
    expect(screen.getByRole("button", { name: "Naming page…" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("Permission model", [], {
        articleMode: "ai",
      }),
    );
    expect(onGenerateTitle).toHaveBeenCalledWith(selectedText, expect.any(AbortSignal));
  });

  it("recovers from an AI title collision and submits once with the original writing instruction", async () => {
    const snapshot = createEmptySnapshot("Test", NOW, "space-test");
    snapshot.notes = [makeNote("note-current", "Project notes")];
    const requestTitle = vi.fn()
      .mockResolvedValueOnce({ reply: "Project notes" })
      .mockResolvedValueOnce({ reply: "Inherited permissions" });
    const onSubmit = vi.fn();
    renderContextSelection({
      onSubmit,
      onGenerateTitle: (selection, signal) => generateLinkTitleWithDeduplication(
        () => snapshot, "note-current", selection, requestTitle, signal,
      ),
    });
    fireEvent.change(screen.getByPlaceholderText("What should this page explain or emphasize?"), {
      target: { value: "Explain inherited permissions." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Name & generate article" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith("Inherited permissions", [], {
      articleMode: "ai", articleInstructions: "Explain inherited permissions.",
    });
    expect(requestTitle).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("A large selected passage about inherited permissions and user roles.")).toBeVisible();
  });

  it("shows that an existing populated article will be reused", () => {
    const onSubmit = vi.fn();
    const existing = { ...makeNote("note-existing", "SQL"), body: "Preserve this explanation.", aliases: ["Structured Query Language"] };
    render(
      <ConceptLinkPopover
        initialPhrase="Structured Query Language"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes"), existing]}
        aiArticleWritingEnabled
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("“SQL” already exists in this Space");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link existing article" }));
    expect(onSubmit).toHaveBeenCalledWith("Structured Query Language", [], { articleMode: "ai" });
    expect(existing.body).toBe("Preserve this explanation.");
  });

  it("keeps generation available for an existing empty article matched by alias", () => {
    const existing: Note = {
      ...makeNote("note-existing", "SQL"), kind: "wiki", summary: "",
      aliases: ["Structured Query Language"],
    };
    render(
      <ConceptLinkPopover
        initialPhrase="Structured Query Language"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes"), existing]}
        aiArticleWritingEnabled
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Continue the existing empty article “SQL”");
    expect(screen.getByRole("button", { name: "Generate article" })).toBeEnabled();
  });

  it("keeps a typed ambiguous title open for an explicit destination choice", () => {
    const onSubmit = vi.fn();
    render(
      <ConceptLinkPopover
        initialPhrase="SQL"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes"), makeNote("one", "SQL"), makeNote("two", "sql")]}
        aiArticleWritingEnabled
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate article" }));
    expect(screen.getByRole("alert")).toHaveTextContent("has several destinations");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the composer open when AI names the selection after its source note", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn().mockResolvedValue("Project notes");
    renderContextSelection({ onSubmit, onGenerateTitle });

    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already names this note",
    );
    expect(screen.getByDisplayValue("Project notes")).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Generate article" }),
    ).toBeEnabled();
  });

  it("rejects a stale self-alias from the current note's canonical concept", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn().mockResolvedValue("Earlier title");
    render(
      <ConceptLinkPopover
        initialPhrase=""
        selectedText="A multi-block selection that needs its own page."
        selectionMode="context"
        initialDestinationIds={[]}
        currentNoteId="note-current"
        notes={[makeNote("note-current", "Project notes")]}
        concepts={[canonicalConcept("note-current", "Project notes", ["Earlier title"])]}
        aiArticleWritingEnabled
        onGenerateTitle={onGenerateTitle}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already names this note",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can use AI only for the title while creating a blank page", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn().mockResolvedValue("Permission model");
    renderContextSelection({ onSubmit, onGenerateTitle });

    fireEvent.click(screen.getByRole("radio", { name: /Blank page/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Name & create blank page" }),
    );

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("Permission model", [], {
        articleMode: "blank",
      }),
    );
  });

  it("always lets a typed title override AI naming", () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi.fn();
    renderContextSelection({ onSubmit, onGenerateTitle });

    fireEvent.change(screen.getByLabelText("Page title"), {
      target: { value: "Access control" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate article" }));

    expect(onGenerateTitle).not.toHaveBeenCalled();
    expect(onSubmit).toHaveBeenCalledWith("Access control", [], {
      articleMode: "ai",
    });
  });

  it("keeps the composer intact when naming fails and permits retry", async () => {
    const onSubmit = vi.fn();
    const onGenerateTitle = vi
      .fn()
      .mockRejectedValueOnce(new Error("The provider is unavailable."))
      .mockResolvedValueOnce("Access control");
    renderContextSelection({ onSubmit, onGenerateTitle });

    fireEvent.change(
      screen.getByPlaceholderText(
        "What should this page explain or emphasize?",
      ),
      { target: { value: "Explain inherited permissions." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The provider is unavailable.",
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByDisplayValue("Explain inherited permissions."),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith("Access control", [], {
        articleMode: "ai",
        articleInstructions: "Explain inherited permissions.",
      }),
    );
  });

  it.each(["button", "Escape"])("ignores a late title after cancelling with %s", async (method) => {
    let resolveTitle: ((title: string) => void) | undefined;
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onGenerateTitle = vi.fn(
      (_selection: string, _signal?: AbortSignal) =>
        new Promise<string>((resolve) => {
          resolveTitle = resolve;
        }),
    );
    const view = renderContextSelection({
      onSubmit,
      onGenerateTitle,
      onCancel,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Name & generate article" }),
    );
    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    expect(cancelButton).toHaveFocus();
    if (method === "Escape") {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    } else {
      fireEvent.click(cancelButton);
    }
    view.unmount();
    await act(async () => resolveTitle?.("Late title"));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onGenerateTitle.mock.calls[0][1]?.aborted).toBe(true);
  });
});

/** Existing article-flow checks enter its explicit secondary step. */
function render(ui: ReactElement) {
  const view = renderView(ui);
  fireEvent.click(screen.getByRole("button", { name: /^(Create a linked article|Edit linked article or destinations)$/ }));
  return view;
}

function renderContextSelection({
  onSubmit,
  onGenerateTitle,
  onCancel = vi.fn(),
}: {
  onSubmit: Parameters<typeof ConceptLinkPopover>[0]["onSubmit"];
  onGenerateTitle: NonNullable<
    Parameters<typeof ConceptLinkPopover>[0]["onGenerateTitle"]
  >;
  onCancel?: () => void;
}) {
  return render(
    <ConceptLinkPopover
      initialPhrase=""
      selectedText="A large selected passage about inherited permissions and user roles."
      selectionMode="context"
      initialDestinationIds={[]}
      currentNoteId="note-current"
      notes={[makeNote("note-current", "Project notes")]}
      aiArticleWritingEnabled
      onGenerateTitle={onGenerateTitle}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  );
}

function renderPopover(
  onSubmit: (
    phrase: string,
    destinationIds: string[],
    options: {
      articleMode: "ai" | "blank";
      articleInstructions?: string;
    },
  ) => void,
  initialDestinationIds: readonly string[] = [],
  aiArticleWritingEnabled = false,
) {
  render(
    <ConceptLinkPopover
      initialPhrase="SQL"
      initialDestinationIds={initialDestinationIds}
      currentNoteId="note-current"
      notes={[makeNote("note-current", "Project notes")]}
      aiArticleWritingEnabled={aiArticleWritingEnabled}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
}

function makeNote(id: string, title: string): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: `${title} summary`,
    body: "",
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function canonicalConcept(
  noteId: string,
  label: string,
  aliases: string[],
): Concept {
  return {
    id: `concept-${noteId}`,
    label,
    aliases,
    description: `${label} concept`,
    noteIds: [noteId],
    canonicalNoteId: noteId,
    autoLink: true,
    color: "#8798ff",
  };
}
