// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThreads, type ChatThreadNavigation } from "./ChatThreads";

const threads = [
  { id: "chat-a", title: "Opening scene", updatedAt: "2026-11-13T04:00:00.000Z", messageCount: 4 },
  { id: "chat-b", title: "Research questions", updatedAt: "2026-11-12T04:00:00.000Z", messageCount: 2 },
];
const props = (): ChatThreadNavigation & { id: string; spaceName: string; onClose: () => void } => ({
  id: "chat-history", spaceName: "My writing", activeThreadId: "chat-a", threads,
  onSelect: vi.fn(), onNew: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onClose: vi.fn(),
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Space chat thread list", () => {
  it("renders only supplied Space rows and distinguishes the selected chat", () => {
    const callbacks = props();
    const { rerender } = render(<ChatThreads {...callbacks}/>);
    const list = screen.getByRole("navigation", { name: "Space chat threads" });
    const active = within(list).getByRole("button", { name: /Opening scene.*Nov|Opening scene.*13/ });
    expect(active).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(list).getByRole("button", { name: /Research questions.*Nov|Research questions.*12/ }));
    expect(callbacks.onSelect).toHaveBeenCalledWith("chat-b");
    rerender(<ChatThreads {...callbacks} spaceName="Another project" threads={[]} activeThreadId=""/>);
    expect(screen.queryByText("Opening scene")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Chats in Another project" })).toBeVisible();
    expect(screen.getByText("Your chats in this Space will appear here.")).toBeVisible();
  });

  it("renames through a bounded literal input and supports cancelling with Escape", () => {
    const callbacks = props(); render(<ChatThreads {...callbacks}/>);
    fireEvent.click(screen.getByRole("button", { name: "Rename Opening scene" }));
    const input = screen.getByRole("textbox", { name: "Rename Opening scene" });
    fireEvent.change(input, { target: { value: "🌿".repeat(161) } });
    expect(screen.getByRole("button", { name: "Save chat name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "  A different opening  " } });
    fireEvent.submit(input.closest("form")!);
    expect(callbacks.onRename).toHaveBeenCalledWith("chat-a", "A different opening");
    fireEvent.click(screen.getByRole("button", { name: "Rename Opening scene" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it("deletes only after confirmation and disables mutations while the captured chat is busy", () => {
    const callbacks = props(); const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { rerender } = render(<ChatThreads {...callbacks}/>);
    fireEvent.click(screen.getByRole("button", { name: "Delete Opening scene" }));
    expect(callbacks.onDelete).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete Research questions" }));
    expect(callbacks.onDelete).toHaveBeenCalledWith("chat-b");
    rerender(<ChatThreads {...callbacks} disabledReason="Finish the current response."/>);
    expect(screen.getByRole("button", { name: "New chat" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Opening scene" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename Opening scene" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Hide chat threads" })).toBeEnabled();
  });

  it("contains keyboard focus in the narrow overlay and lets Escape close it", () => {
    const callbacks = props(); render(<ChatThreads {...callbacks} overlay/>);
    const dialog = screen.getByRole("dialog", { name: "Chats in My writing" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const first = screen.getByRole("button", { name: "Hide chat threads" });
    const last = screen.getByRole("button", { name: "Delete Research questions" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true }); expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" }); expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Escape" }); expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
});
