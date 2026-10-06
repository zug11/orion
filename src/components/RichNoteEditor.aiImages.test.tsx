// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIImageProposal } from "../lib/aiImages";
import * as storage from "../lib/storage";
import { RichNoteEditor, type AIImageGenerationCallbacks } from "./RichNoteEditor";

type ImageRequest = NonNullable<ComponentProps<typeof RichNoteEditor>["onGenerateAIImage"]>;
const image: AIImageProposal = { fileName: "illustration.jpg", mimeType: "image/jpeg", byteSize: 4,
  base64Data: "/9j/2Q==", alt: "Roots linked beneath trees" };

beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-content")) return new DOMRect(0, 0, 1200, 760);
    if (this.classList.contains("rich-note-editor")) return new DOMRect(200, 80, 840, 620);
    if (this.classList.contains("editor-prose")) return new DOMRect(280, 130, 680, 500);
    return new DOMRect(280, 200, 50, 20);
  });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(280, 200, 80, 20) },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fixture(onGenerateAIImage: ImageRequest) {
  const onChange = vi.fn();
  const view = render(<div className="workspace-content"><RichNoteEditor
    noteId="image-note" markdown="The roots connect trees." notes={[]} concepts={[]} sources={[]}
    attachedSourceIds={[]} onChange={onChange} onAttachSource={vi.fn()} onRegisterConcept={vi.fn()}
    onDisableConceptAutoLink={vi.fn()} onGenerateAIImage={onGenerateAIImage} aiImageGenerationEnabled
    imageContextEnabled /></div>);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  act(() => { editor.commands.setTextSelection({ from: 1, to: 10 }); });
  fireEvent.click(screen.getByRole("button", { name: "Turn on AI tools" }));
  fireEvent.click(await screen.findByRole("button", { name: "Generate image from selected text" }));
  fireEvent.click(screen.getByRole("radio", { name: "Fast" }));
  fireEvent.click(screen.getByRole("button", { name: "Generate" }));
  return { ...view, editor, onChange };
}

describe("image planning sessions in the real note editor", () => {
  it("reuses the captured session on error, clears only the image on regenerate, and discloses partial context", async () => {
    const sessions: AIImageGenerationCallbacks[] = [];
    const generate = vi.fn<ImageRequest>(async (_input, _signal, callbacks) => {
      sessions.push(callbacks!);
      if (sessions.length === 1) {
        callbacks!.onProgress?.({ stage: "read", message: "Reading available context", partial: true });
        throw new Error("The image brief took too long.");
      }
      callbacks!.onProgress?.({ stage: "render", message: "Generating image" });
      return image;
    });
    const { onChange } = await fixture(generate);
    fireEvent.click(await screen.findByRole("button", { name: "Retry image generation" }));
    await screen.findByRole("region", { name: "Generated image preview" });
    expect(sessions[1].session).toBe(sessions[0].session);
    expect(generate.mock.calls[1][0]).toMatchObject({ quality: "fast", contextMode: "space", selectedText: "The roots" });
    expect(screen.getByText(/Some context could not be read/)).toBeVisible();
    const clearImage = vi.spyOn(sessions[0].session!, "clearImage");
    const clear = vi.spyOn(sessions[0].session!, "clear");
    fireEvent.click(screen.getByRole("button", { name: "Generate image again" }));
    await screen.findByRole("region", { name: "Generated image preview" });
    expect(clearImage).toHaveBeenCalledOnce();
    expect(sessions[2].session).toBe(sessions[0].session);
    expect(clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard generated image" }));
    expect(clear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows stage progress and ignores both late progress and late images after cancellation", async () => {
    let callbacks!: AIImageGenerationCallbacks;
    let signal!: AbortSignal;
    let resolve!: (value: AIImageProposal) => void;
    const generate = vi.fn<ImageRequest>((_input, nextSignal, nextCallbacks) => {
      callbacks = nextCallbacks!; signal = nextSignal;
      callbacks.onProgress?.({ stage: "compose", message: "Preparing image brief" });
      return new Promise((done) => { resolve = done; });
    });
    const { onChange } = await fixture(generate);
    expect(await screen.findByText("Preparing image brief")).toBeVisible();
    const clear = vi.spyOn(callbacks.session!, "clear");
    fireEvent.click(screen.getByRole("button", { name: "Cancel image generation" }));
    expect(signal.aborted).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    await act(async () => {
      callbacks.onProgress?.({ stage: "render", message: "Late progress must be ignored" });
      resolve(image);
    });
    expect(screen.queryByText("Late progress must be ignored")).toBeNull();
    expect(screen.queryByRole("region", { name: "Generated image preview" })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restores a downloaded image after insertion fails without regenerating, then inserts with one undo", async () => {
    const save = vi.spyOn(storage, "persistGeneratedNoteImage")
      .mockRejectedValueOnce(new Error("Could not save the image."))
      .mockResolvedValueOnce({ id: "saved-image", fileName: "illustration.jpg", mimeType: "image/jpeg",
        byteSize: 4, src: "data:image/jpeg;base64,/9j/2Q==" });
    const generate = vi.fn<ImageRequest>().mockResolvedValue(image);
    const { editor, onChange } = await fixture(generate);
    fireEvent.click(await screen.findByRole("button", { name: "Insert generated image" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore generated image preview" }));
    expect(generate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Insert generated image" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(generate).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toBe(save.mock.calls[0][1]);
    expect(editor.getHTML()).toContain("<img");
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("The roots connect trees.");
  });

  it("clears the operation session and cancels the request when the editor unmounts", async () => {
    let callbacks!: AIImageGenerationCallbacks;
    let signal!: AbortSignal;
    const generate = vi.fn<ImageRequest>((_input, nextSignal, nextCallbacks) => {
      callbacks = nextCallbacks!; signal = nextSignal;
      return new Promise(() => undefined);
    });
    const { unmount } = await fixture(generate);
    const clear = vi.spyOn(callbacks.session!, "clear");
    unmount();
    expect(clear).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(true);
  });
});
