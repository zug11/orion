// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

describe("Topbar", () => {
  it("marks the non-interactive window chrome as draggable", () => {
    const { container } = render(
      <Topbar
        workspaceName="Research"
        contextOpen={false}
        onOpenSearch={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(container.querySelector(".topbar")).toHaveAttribute(
      "data-tauri-drag-region",
    );

    const workspaceCrumb = container.querySelector(".workspace-crumb");
    expect(workspaceCrumb).toHaveAttribute("data-tauri-drag-region");
    workspaceCrumb?.querySelectorAll("span, small").forEach((element) => {
      expect(element).toHaveAttribute("data-tauri-drag-region");
    });

    screen.getAllByRole("button").forEach((button) => {
      expect(button).not.toHaveAttribute("data-tauri-drag-region");
    });
  });

  it("keeps top-bar actions clickable", () => {
    const onOpenSearch = vi.fn();
    const onExport = vi.fn();
    const onToggleContext = vi.fn();

    render(
      <Topbar
        workspaceName="Research"
        contextOpen={false}
        onOpenSearch={onOpenSearch}
        onExport={onExport}
        onToggleContext={onToggleContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Search your atlas/i }));
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Toggle context panel" }),
    );

    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
    expect(onToggleContext).toHaveBeenCalledOnce();
  });
});
