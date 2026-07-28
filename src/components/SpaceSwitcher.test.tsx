// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { SpaceSwitcher } from "./SpaceSwitcher";

const NOW = "2026-07-28T04:30:00.000Z";

function renderSwitcher() {
  const main = createEmptySnapshot("Main project", NOW, "space-main");
  const research = createEmptySnapshot(
    "Research project",
    NOW,
    "space-research",
  );
  const onCreateSpace = vi.fn();
  const onSwitchSpace = vi.fn();

  render(
    <SpaceSwitcher
      spaces={[main, research]}
      activeSpaceId={main.workspace.id}
      onCreateSpace={onCreateSpace}
      onSwitchSpace={onSwitchSpace}
    />,
  );

  return { onCreateSpace, onSwitchSpace };
}

describe("SpaceSwitcher", () => {
  it("switches to a different isolated space", () => {
    const { onSwitchSpace } = renderSwitcher();

    fireEvent.click(screen.getByRole("button", { name: /Main project/i }));
    fireEvent.click(screen.getByRole("button", { name: /Research project/i }));

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
});
