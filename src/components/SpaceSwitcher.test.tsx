// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { SpaceSwitcher } from "./SpaceSwitcher";

const NOW = "2026-07-28T04:30:00.000Z";

function renderSwitcher(deleteResult = true, renameResult = true) {
  const main = createEmptySnapshot("Main project", NOW, "space-main");
  const research = createEmptySnapshot(
    "Research project",
    NOW,
    "space-research",
  );
  const onCreateSpace = vi.fn();
  const onDeleteSpace = vi.fn(() => deleteResult);
  const onRenameSpace = vi.fn(() => renameResult);
  const onSwitchSpace = vi.fn();

  render(
    <SpaceSwitcher
      spaces={[main, research]}
      activeSpaceId={main.workspace.id}
      onCreateSpace={onCreateSpace}
      onRenameSpace={onRenameSpace}
      onDeleteSpace={onDeleteSpace}
      onSwitchSpace={onSwitchSpace}
    />,
  );

  return { onCreateSpace, onDeleteSpace, onRenameSpace, onSwitchSpace };
}

describe("SpaceSwitcher", () => {
  it("switches to a different isolated space", () => {
    const { onSwitchSpace } = renderSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(
      screen.getByRole("button", { name: "Research project, 0 notes" }),
    );

    expect(onSwitchSpace).toHaveBeenCalledOnce();
    expect(onSwitchSpace).toHaveBeenCalledWith("space-research");
  });

  it("creates a normalized blank space name", () => {
    const { onCreateSpace } = renderSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(screen.getByRole("button", { name: /New blank space/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Space name/i }), {
      target: { value: "  Client   archive  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onCreateSpace).toHaveBeenCalledWith("Client archive");
  });

  it("prevents duplicate space names", () => {
    const { onCreateSpace } = renderSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(screen.getByRole("button", { name: /New blank space/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /Space name/i }), {
      target: { value: "research PROJECT" },
    });

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(screen.getByText("That name is already in use.")).toBeVisible();
    expect(onCreateSpace).not.toHaveBeenCalled();
  });

  it("deletes from a sibling trash control without switching Spaces", () => {
    const { onDeleteSpace, onSwitchSpace } = renderSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete Research project space",
      }),
    );

    expect(onDeleteSpace).toHaveBeenCalledOnce();
    expect(onDeleteSpace).toHaveBeenCalledWith("space-research");
    expect(onSwitchSpace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Main project space/i }),
    ).toHaveFocus();
    expect(
      screen.queryByRole("dialog", { name: "Switch space" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the Space list open when deletion is cancelled", () => {
    renderSwitcher(false);

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete Research project space",
      }),
    );

    expect(screen.getByRole("dialog", { name: "Switch space" })).toBeVisible();
  });

  it("does not offer deletion for the final Space", () => {
    const only = createEmptySnapshot("Only space", NOW, "space-only");

    render(
      <SpaceSwitcher
        spaces={[only]}
        activeSpaceId={only.workspace.id}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn(() => false)}
        onSwitchSpace={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Only space/i }));
    expect(
      screen.queryByRole("button", { name: /Delete Only space/i }),
    ).not.toBeInTheDocument();
  });

  it("prefills and selects the requested Space name, then submits only that ID", async () => {
    const { onRenameSpace, onSwitchSpace, onCreateSpace } = renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Open space switcher/i }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Research project space" }));
    const input = screen.getByRole("textbox", { name: "Space name" }) as HTMLInputElement;
    await waitFor(() => expect(input).toHaveFocus());
    expect(input.value).toBe("Research project");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Research project".length]);
    expect(input).toHaveAttribute("maxlength", "60");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  Client   research  " } });
    fireEvent.submit(screen.getByRole("form", { name: "Rename space" }));
    expect(onRenameSpace).toHaveBeenCalledExactlyOnceWith("space-research", "Client research", "Research project");
    expect(onSwitchSpace).not.toHaveBeenCalled();
    expect(onCreateSpace).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open space switcher/i })).toHaveFocus();
  });

  it("rejects blank, duplicate and oversized rename drafts but permits a case-only change", () => {
    const { onRenameSpace } = renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Open space switcher/i }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Research project space" }));
    const input = screen.getByRole("textbox", { name: "Space name" });
    for (const value of ["   ", "MAIN PROJECT", "x".repeat(61)]) {
      fireEvent.change(input, { target: { value } });
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
      fireEvent.submit(screen.getByRole("form", { name: "Rename space" }));
    }
    expect(onRenameSpace).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Research Project" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameSpace).toHaveBeenCalledWith("space-research", "Research Project", "Research project");
  });

  it("cancels a rename with Escape and restores focus without leaving the menu", () => {
    const { onRenameSpace } = renderSwitcher();
    fireEvent.click(screen.getByRole("button", { name: /Open space switcher/i }));
    const rename = screen.getByRole("button", { name: "Rename Main project space" });
    fireEvent.click(rename);
    const input = screen.getByRole("textbox", { name: "Space name" });
    fireEvent.change(input, { target: { value: "Discard me" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRenameSpace).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Switch space" })).toBeVisible();
    expect(rename).toHaveFocus();
  });

  it("keeps the draft available when the host rejects a stale rename", () => {
    const { onRenameSpace } = renderSwitcher(true, false);
    fireEvent.click(screen.getByRole("button", { name: /Open space switcher/i }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Main project space" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Space name" }), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRenameSpace).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox")).toHaveValue("New title");
    expect(screen.getByText("The name could not be saved. Reopen Rename to try again.")).toBeVisible();
  });

  it("never retargets a rename when its Space is removed or renamed in another window", () => {
    const main = createEmptySnapshot("Main", NOW, "space-main");
    const other = createEmptySnapshot("Other", NOW, "space-other");
    const onRenameSpace = vi.fn(() => true);
    const props = { spaces: [main, other], activeSpaceId: main.workspace.id, onRenameSpace,
      onCreateSpace: vi.fn(), onSwitchSpace: vi.fn(), onDeleteSpace: vi.fn(() => true) };
    const view = render(<SpaceSwitcher {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Open space switcher/i }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Other space" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My draft" } });
    view.rerender(<SpaceSwitcher {...props} spaces={[main, { ...other, workspace: { ...other.workspace, name: "Changed elsewhere" } }]} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/This Space was renamed elsewhere/)).toBeVisible();
    view.rerender(<SpaceSwitcher {...props} spaces={[main]} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Rename space" }));
    expect(onRenameSpace).not.toHaveBeenCalled();
    expect(screen.getByText("This Space is no longer available.")).toBeVisible();
  });
});
