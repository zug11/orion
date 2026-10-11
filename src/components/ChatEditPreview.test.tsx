// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatEditPreview } from "./ChatEditPreview";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatEditProposal } from "../types";
afterEach(cleanup);
const proposal: ChatEditProposal = { spaceId: "space", noteId: "draft", title: "My draft", baseBody: "An old thought.", edits: [{ before: "old", after: "new" }] };
function props() {
  const snapshot = createEmptySnapshot("Space", "2026-10-08", "space");
  snapshot.notes = [{ id: "draft", title: "My draft", body: proposal.baseBody, summary: "", slug: "draft", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" }];
  return { snapshot, proposal, busy: false, onReview: vi.fn().mockResolvedValue(true), onDiscard: vi.fn() };
}
it("shows the proposed text without applying, then applies only on request", async () => {
  const p = props(); render(<ChatEditPreview {...p} />);
  expect(screen.getByText(/gray additions directly/)).toBeVisible();
  expect(p.onReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review in note" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Changes accepted"));
  expect(p.onReview).toHaveBeenCalledExactlyOnceWith(proposal);
});
it("discards without invoking the writer", () => {
  const p = props(); render(<ChatEditPreview {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(p.onDiscard).toHaveBeenCalledOnce(); expect(p.onReview).not.toHaveBeenCalled();
});
it("disables Apply after typing or when the target Space changes", () => {
  const p = props(); const { rerender } = render(<ChatEditPreview {...p} />);
  p.snapshot.notes[0].body += " Typed.";
  rerender(<ChatEditPreview {...p} snapshot={{ ...p.snapshot }} />);
  expect(screen.getByRole("button", { name: "Review in note" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("changed");
  p.snapshot.workspace.id = "other"; rerender(<ChatEditPreview {...p} snapshot={{ ...p.snapshot }} />);
  expect(screen.getByRole("button", { name: "Review in note" })).toBeDisabled();
});
it("keeps a failed application reviewable and reports the failure", async () => {
  const p = props(); p.onReview.mockRejectedValue(new Error("Save operation interrupted")); render(<ChatEditPreview {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Review in note" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Save operation interrupted"));
  expect(screen.getByRole("button", { name: "Review in note" })).toBeEnabled();
});
