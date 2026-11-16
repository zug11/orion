import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SavedConnectionsAccess } from "./SavedConnectionsAccess";
import { retrySavedConnections } from "../lib/storage";
vi.mock("../lib/storage", () => ({ retrySavedConnections: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("saved connection access", () => {
  it("requires an explicit click and coalesces clicks while the system prompt is pending", async () => {
    let finish!: () => void;
    vi.mocked(retrySavedConnections).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const unlocked = vi.fn();
    render(<SavedConnectionsAccess onUnlocked={unlocked} />);
    expect(retrySavedConnections).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unlock saved connections" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlocking…" }));
    expect(retrySavedConnections).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(unlocked).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Ready to retry");
  });
  it("shows a denied unlock without automatically retrying", async () => {
    vi.mocked(retrySavedConnections).mockRejectedValue(new Error("Access was declined. Try again when ready."));
    const unlocked = vi.fn();
    render(<SavedConnectionsAccess onUnlocked={unlocked} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock saved connections" })));
    expect(retrySavedConnections).toHaveBeenCalledTimes(1);
    expect(unlocked).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Access was declined");
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
