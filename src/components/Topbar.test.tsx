// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Topbar } from "./Topbar";

describe("Topbar writing window", () => {
  it("offers the writing action immediately before export and prevents duplicate opening", () => {
    const onOpenWritingWindow = vi.fn();
    const props = {
      workspaceName: "My space",
      contextOpen: false,
      onOpenSearch: vi.fn(),
      onExport: vi.fn(),
      onOpenWritingWindow,
    };
    const { rerender } = render(<Topbar {...props} />);
    const open = screen.getByRole("button", { name: "Open in writing window" });
    expect(open.nextElementSibling).toBe(screen.getByRole("button", { name: "Share or export" }));
    fireEvent.click(open);
    expect(onOpenWritingWindow).toHaveBeenCalledOnce();

    rerender(<Topbar {...props} openingWritingWindow />);
    expect(open).toBeDisabled();
    fireEvent.click(open);
    expect(onOpenWritingWindow).toHaveBeenCalledOnce();
  });

  it("omits the action when no document can be detached", () => {
    render(<Topbar workspaceName="My space" contextOpen={false} onOpenSearch={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Open in writing window" })).not.toBeInTheDocument();
  });
});
