// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Source } from "../types";
import { RichNoteEditor } from "./RichNoteEditor";

const NOW = "2026-08-07T00:00:00.000Z";

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: {
      configurable: true,
      value: () => [],
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    },
  });
});

const attachedSource: Source = {
  id: "source-attached",
  title: "Attached lecture",
  kind: "audio",
  importedAt: NOW,
  text: "Existing provenance.",
  noteIds: ["note-citation"],
};

const spaceSource: Source = {
  id: "source-space",
  title: "Space report",
  kind: "pdf",
  importedAt: NOW,
  text: "A source from elsewhere in the Space.",
  noteIds: [],
};

describe("RichNoteEditor source citations", () => {
  it("lists attached sources first and writes a portable citation", async () => {
    const onChange = vi.fn();
    const onAttachSource = vi.fn();
    render(
      <RichNoteEditor
        noteId="note-citation"
        markdown="Claim."
        notes={[]}
        concepts={[]}
        sources={[spaceSource, attachedSource]}
        attachedSourceIds={[attachedSource.id]}
        onChange={onChange}
        onAttachSource={onAttachSource}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cite a source" }));
    const dialog = screen.getByRole("dialog", { name: "Cite a source" });
    const sourceChoices = within(dialog)
      .getAllByRole("button")
      .filter(
        (button) =>
          button.getAttribute("aria-label") !==
          "Close source citation picker",
      );
    expect(sourceChoices[0]).toHaveTextContent("Attached lecture");
    expect(sourceChoices[0]).toHaveTextContent("Attached to this note");
    await waitFor(() => expect(sourceChoices[0]).toHaveFocus());

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Cite a source" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cite a source" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Cite a source" })).getByRole(
        "button",
        { name: /Space report/ },
      ),
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[1](orion-source://source-space) Claim.\n\n## References\n\n1. [Space report](orion-source://source-space)",
      ),
    );
    expect(screen.getByRole("heading", { name: "References" })).toBeVisible();
    expect(screen.getByText("Space report")).toBeVisible();
    expect(onAttachSource).toHaveBeenCalledOnce();
    expect(onAttachSource).toHaveBeenCalledWith(spaceSource.id);
  });
});

describe("RichNoteEditor images", () => {
  it("pastes a local image as a rendered, portable Markdown attachment", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <RichNoteEditor
        noteId="note-image"
        markdown="Before image."
        notes={[]}
        concepts={[]}
        sources={[]}
        attachedSourceIds={[]}
        onChange={onChange}
        onAttachSource={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );
    const image = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      "system-map.png",
      { type: "image/png" },
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { files: [image] } });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.stringMatching(/!\[system map\]\(data:image\/png;base64,/),
      ),
    );
    expect(container.querySelector('img[alt="system map"]')).toBeInTheDocument();
  });
});

describe("RichNoteEditor AI writing", () => {
  it("keeps generation out of the document, accepts once, and undoes once", async () => {
    const geometry = installEditorGeometry();
    const onChange = vi.fn();
    const onGenerateAIWriting = vi.fn().mockResolvedValue(
      "A generated continuation.",
    );
    try {
      render(
        <div className="workspace-content">
          <RichNoteEditor
            noteId="note-writing"
            markdown="The opening thought."
            notes={[]}
            concepts={[]}
            sources={[]}
            attachedSourceIds={[]}
            onChange={onChange}
            onAttachSource={vi.fn()}
            onRegisterConcept={vi.fn()}
            onGenerateAIWriting={onGenerateAIWriting}
            onDisableConceptAutoLink={vi.fn()}
            aiArticleWritingEnabled
            aiProviderName="OpenAI"
          />
        </div>,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Turn on AI writing" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Continue" }),
      );

      expect(
        await screen.findByRole("region", { name: "AI writing preview" }),
      ).toHaveTextContent("A generated continuation.");
      expect(onChange).not.toHaveBeenCalled();
      expect(onGenerateAIWriting).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "continue",
          length: "paragraph",
          instruction: "",
          documentMarkdown: "The opening thought.",
        }),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Accept AI writing" }),
      );
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith(
          "The opening thought.\n\nA generated continuation.",
        ),
      );
      expect(onChange).toHaveBeenCalledOnce();

      const undo = screen.getByRole("button", { name: "Undo" });
      await waitFor(() => expect(undo).toBeEnabled());
      fireEvent.click(undo);
      await waitFor(() =>
        expect(onChange).toHaveBeenLastCalledWith("The opening thought."),
      );
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      geometry.mockRestore();
    }
  });

  it("ignores a late result after Escape cancels generation", async () => {
    const geometry = installEditorGeometry();
    const onChange = vi.fn();
    let resolveWriting!: (markdown: string) => void;
    const onGenerateAIWriting = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveWriting = resolve;
        }),
    );
    try {
      render(
        <div className="workspace-content">
          <RichNoteEditor
            noteId="note-writing-cancel"
            markdown="Keep this."
            notes={[]}
            concepts={[]}
            sources={[]}
            attachedSourceIds={[]}
            onChange={onChange}
            onAttachSource={vi.fn()}
            onRegisterConcept={vi.fn()}
            onGenerateAIWriting={onGenerateAIWriting}
            onDisableConceptAutoLink={vi.fn()}
            aiArticleWritingEnabled
          />
        </div>,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Turn on AI writing" }),
      );
      fireEvent.click(
        await screen.findByRole("button", { name: "Continue" }),
      );
      expect(
        await screen.findByRole("button", { name: "Cancel AI writing" }),
      ).toBeVisible();
      fireEvent.keyDown(document, { key: "Escape" });

      await act(async () => {
        resolveWriting("This late proposal must not appear.");
        await Promise.resolve();
      });
      expect(
        screen.queryByRole("region", { name: "AI writing preview" }),
      ).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent(
        "Keep this.",
      );
    } finally {
      geometry.mockRestore();
    }
  });
});

function installEditorGeometry() {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function editorRect(this: HTMLElement) {
      if (this.classList.contains("workspace-content")) {
        return makeRect(0, 0, 1_200, 760);
      }
      if (this.classList.contains("rich-note-editor")) {
        return makeRect(200, 80, 840, 620);
      }
      if (this.classList.contains("editor-prose")) {
        return makeRect(280, 130, 680, 500);
      }
      return makeRect(0, 0, 0, 0);
    });
}

function makeRect(left: number, top: number, width: number, height: number) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}
