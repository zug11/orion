// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { WritingWindowHeader } from "./WritingWindowHeader";

it("keeps only title and export in the minimal writing header", () => {
  const onExport = vi.fn();
  const { rerender } = render(
    <WritingWindowHeader title="My document" onExport={onExport} />,
  );
  expect(screen.getByText("My document")).toHaveAttribute("title", "My document");
  expect(screen.queryByRole("button", { name: "Show in Orion" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Share or export" }));
  expect(onExport).toHaveBeenCalledOnce();

  rerender(<WritingWindowHeader title="Document unavailable" />);
  expect(screen.queryByRole("button", { name: "Share or export" })).not.toBeInTheDocument();
});
