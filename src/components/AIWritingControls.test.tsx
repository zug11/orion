// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { AIWritingControls, type AIWritingPhase } from "./AIWritingControls";

const VISIBLE = { left: 420, bottom: 18, visible: true } as const;
const SELECTION = { left: 420, top: 240, visible: true } as const;
type ControlProps = ComponentProps<typeof AIWritingControls>;

function renderControls(options: {
  phase?: AIWritingPhase;
  hasSelection?: boolean;
  suspended?: boolean;
  onRequest?: ControlProps["onRequest"];
  onAccept?: ControlProps["onAccept"];
  onRetry?: ControlProps["onRetry"];
  onDiscard?: ControlProps["onDiscard"];
  onRequestImage?: ControlProps["onRequestImage"];
  imageGenerationAvailable?: boolean;
} = {}) {
  const callbacks = {
    onRequest: options.onRequest ?? vi.fn<ControlProps["onRequest"]>(),
    onAccept: options.onAccept ?? vi.fn<ControlProps["onAccept"]>(),
    onRetry: options.onRetry ?? vi.fn<ControlProps["onRetry"]>(),
    onDiscard: options.onDiscard ?? vi.fn<ControlProps["onDiscard"]>(),
    onRequestImage:
      options.onRequestImage ?? vi.fn<NonNullable<ControlProps["onRequestImage"]>>(),
  };
  const view = render(
    <AIWritingControls
      active
      suspended={options.suspended ?? false}
      phase={options.phase ?? "idle"}
      hasSelection={options.hasSelection ?? false}
      selectionPosition={SELECTION}
      dockPosition={VISIBLE}
      onRequest={callbacks.onRequest}
      onAccept={callbacks.onAccept}
      onRetry={callbacks.onRetry}
      onDiscard={callbacks.onDiscard}
      onRequestImage={callbacks.onRequestImage}
      imageGenerationAvailable={options.imageGenerationAvailable}
    />,
  );
  return { ...callbacks, view };
}

describe("AIWritingControls", () => {
  it("keeps Continue at the bottom and opens only amount and instruction options", async () => {
    const { onRequest } = renderControls();

    expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue writing options" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Continue writing options",
    });
    const amount = within(dialog).getByRole("slider", {
      name: "Amount of text",
    });
    await waitFor(() => expect(amount).toHaveFocus());
    expect(amount).toHaveAttribute("min", "0");
    expect(amount).toHaveAttribute("max", "2");
    expect(amount).toHaveAttribute("step", "1");
    expect(amount).toHaveValue("1");
    expect(amount).toHaveAttribute("aria-valuetext", "Paragraph");
    fireEvent.change(amount, { target: { value: "0" } });
    expect(amount).toHaveAttribute("aria-valuetext", "Sentence");
    fireEvent.change(amount, { target: { value: "2" } });
    expect(amount).toHaveAttribute("aria-valuetext", "Section");
    fireEvent.change(
      within(dialog).getByRole("textbox", {
        name: /^Custom instructions/,
      }),
      {
        target: { value: "End on a concrete implication." },
      },
    );
    expect(
      within(dialog).queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(onRequest).toHaveBeenCalledWith(
      "continue",
      "section",
      "End on a concrete implication.",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Continue writing options" }),
    );
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Add a direction for what comes next…"),
      ).toHaveValue(""),
    );
  });

  it("closes Continue options from the slider and returns focus to the chevron", async () => {
    renderControls();
    const toggle = screen.getByRole("button", {
      name: "Continue writing options",
    });
    fireEvent.click(toggle);
    const slider = screen.getByRole("slider", { name: "Amount of text" });
    await waitFor(() => expect(slider).toHaveFocus());

    fireEvent.keyDown(slider, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Continue writing options" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());

    fireEvent.click(toggle);
    const reopenedSlider = screen.getByRole("slider", {
      name: "Amount of text",
    });
    await waitFor(() => expect(reopenedSlider).toHaveFocus());
    fireEvent.click(toggle);
    expect(
      screen.queryByRole("dialog", { name: "Continue writing options" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it("replaces Continue with Rewrite for a selection and supports a blank custom direction", () => {
    const { onRequest } = renderControls({ hasSelection: true });

    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    const dialog = screen.getByRole("dialog", { name: "Rewrite selected text" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rewrite" }));

    expect(onRequest).toHaveBeenCalledWith("rewrite", "paragraph", "");
  });

  it("offers the exact rewrite presets and supports menu keyboard navigation", async () => {
    const { onRequest } = renderControls({ hasSelection: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Choose rewrite action" }),
    );
    const menu = screen.getByRole("menu", { name: "Rewrite actions" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.querySelector("strong")?.textContent)).toEqual([
      "Clarify",
      "Tighten",
      "Simplify",
      "Expand",
      "Enrich",
    ]);
    await waitFor(() => expect(items[0]).toHaveFocus());
    fireEvent.keyDown(menu, { key: "End" });
    expect(items[4]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();
    fireEvent.click(items[4]);
    expect(onRequest).toHaveBeenCalledWith("enrich", "paragraph", "");
  });

  it("opens optional image direction from a selection and generates without guidance", async () => {
    const { onRequestImage } = renderControls({
      hasSelection: true,
      imageGenerationAvailable: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Generate image from selected text" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Generate image from selected text",
    });
    const input = within(dialog).getByRole("textbox", { name: /^Image direction/ });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.click(within(dialog).getByRole("button", { name: "Generate" }));

    expect(onRequestImage).toHaveBeenCalledWith("");
  });

  it("returns focus to Generate image when its optional direction is cancelled", async () => {
    renderControls({
      hasSelection: true,
      imageGenerationAvailable: true,
    });
    const trigger = screen.getByRole("button", {
      name: "Generate image from selected text",
    });
    fireEvent.click(trigger);
    const input = screen.getByRole("textbox", { name: /^Image direction/ });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Generate image from selected text",
        }),
      ).toHaveFocus(),
    );
  });

  it("passes custom visual guidance and labels image review controls", () => {
    const onRequestImage = vi.fn<NonNullable<ControlProps["onRequestImage"]>>();
    const { view } = renderControls({
      hasSelection: true,
      imageGenerationAvailable: true,
      onRequestImage,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Generate image from selected text" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: /^Image direction/ }), {
      target: { value: "Make it a restrained ink diagram." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(onRequestImage).toHaveBeenCalledWith(
      "Make it a restrained ink diagram.",
    );

    view.rerender(
      <AIWritingControls
        active
        suspended={false}
        phase="preview"
        hasSelection
        selectionPosition={SELECTION}
        dockPosition={VISIBLE}
        operationKind="image"
        onRequest={vi.fn()}
        onAccept={vi.fn()}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Insert generated image" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate image again" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard generated image" })).toBeVisible();
  });

  it("morphs into accept, retry, and discard controls without a document action", () => {
    const callbacks = renderControls({ phase: "preview" });

    fireEvent.click(screen.getByRole("button", { name: "Accept AI writing" }));
    fireEvent.click(screen.getByRole("button", { name: "Try AI writing again" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard AI writing" }));
    expect(callbacks.onAccept).toHaveBeenCalledOnce();
    expect(callbacks.onRetry).toHaveBeenCalledOnce();
    expect(callbacks.onDiscard).toHaveBeenCalledOnce();
  });

  it("cancels an active operation with Escape and hides while another composer owns focus", () => {
    const onDiscard = vi.fn<ControlProps["onDiscard"]>();
    const { view } = renderControls({ phase: "generating", onDiscard });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onDiscard).toHaveBeenCalledOnce();

    view.rerender(
      <AIWritingControls
        active
        suspended
        phase="idle"
        hasSelection={false}
        selectionPosition={SELECTION}
        dockPosition={VISIBLE}
        onRequest={vi.fn()}
        onAccept={vi.fn()}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("ai-writing-dock")).not.toBeInTheDocument();
  });
});
