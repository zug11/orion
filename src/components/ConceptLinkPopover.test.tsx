// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Concept, Note } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";

const NOW = "2026-07-28T10:00:00.000Z";

describe("ConceptLinkPopover", () => {
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
    expect(onGenerateTitle).toHaveBeenCalledWith(selectedText);
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

  it("ignores a late title after the composer is cancelled", async () => {
    let resolveTitle: ((title: string) => void) | undefined;
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onGenerateTitle = vi.fn(
      () =>
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
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    view.unmount();
    await act(async () => resolveTitle?.("Late title"));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

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
