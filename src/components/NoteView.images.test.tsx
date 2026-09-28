import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { serializeNoteImageTitle } from "../lib/noteImageLayout";
import { NoteView } from "./NoteView";

afterEach(cleanup);

function renderImage(layout: unknown) {
  const title = serializeNoteImageTitle(layout, "Original image title");
  const note: Note = {
    id: "image-note", title: "Image note", slug: "image-note", summary: "", aliases: [], tags: [],
    body: `![Surface](orion-image://localhost/image_123456789012345678 "${title}")\n\nSurrounding prose.`,
    kind: "article", status: "ready", conceptIds: [], sourceIds: [],
    createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z",
  };
  return render(<NoteView note={note} notes={[note]} concepts={[]} onOpenNote={vi.fn()} onOpenConcept={vi.fn()}
    onUpdateNote={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
}

describe("reading freely placed images", () => {
  it("uses shared bounded position and intrinsic caption layout while keeping captions inert", () => {
    const caption = '<img src=x onerror="leak()">';
    const { container } = renderImage({ placement: "wrap", widthPercent: 35, xPercent: 55.25, offsetY: 140, gap: 20, caption, showCaption: true });
    const wrapper = container.querySelector<HTMLElement>(".note-image-reading")!;
    const content = wrapper.querySelector<HTMLElement>(".note-image-free-content")!;
    expect(wrapper.style.width).toBe("100%");
    expect(wrapper.style.float).toBe("right");
    expect(wrapper.style.paddingTop).toBe("160px");
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(content.style.width).toBe("35%");
    expect(content.style.marginLeft).toBe("55.25%");
    expect(content.style.pointerEvents).toBe("auto");
    expect(content.style.position).toBe("");
    expect(content.querySelector("img")?.title).toBe("Original image title");
    expect(content.textContent).toBe(caption);
    expect(content.querySelectorAll("img")).toHaveLength(1);
    expect(content.querySelector("[onerror]")).toBeNull();
    expect(container.querySelector(".note-prose")?.textContent).not.toContain("orion-image-layout");
  });

  it("preserves the legacy alignment wrapper when no free position was saved", () => {
    const { container } = renderImage({ placement: "wrap", alignment: "right", widthPercent: 45, gap: 22 });
    const wrapper = container.querySelector<HTMLElement>(".note-image-reading")!;
    expect(wrapper.style.width).toBe("45%");
    expect(wrapper.style.float).toBe("right");
    expect(wrapper.querySelector(".note-image-free-content")).toBeNull();
    expect(wrapper.querySelector(":scope > img")).not.toBeNull();
  });
});
