// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { SpaceSwitcher } from "./SpaceSwitcher";

const NOW = "2026-07-28T04:30:00.000Z";

function renderSwitcher(deleteResult = true) {
  const main = createEmptySnapshot("Main project", NOW, "space-main");
  const research = createEmptySnapshot(
    "Research project",
    NOW,
    "space-research",
  );
  const onCreateSpace = vi.fn();
  const onDeleteSpace = vi.fn(() => deleteResult);
  const onSwitchSpace = vi.fn();

  render(
    <SpaceSwitcher
      spaces={[main, research]}
      activeSpaceId={main.workspace.id}
      onCreateSpace={onCreateSpace}
      onDeleteSpace={onDeleteSpace}
      onSwitchSpace={onSwitchSpace}
    />,
  );

  return { onCreateSpace, onDeleteSpace, onSwitchSpace };
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
});
