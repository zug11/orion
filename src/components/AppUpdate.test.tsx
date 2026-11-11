// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppUpdateButton, AppUpdateSettings } from "./AppUpdate";
import type { AppUpdateStatus } from "../lib/appUpdates";

const mocked = vi.hoisted(() => ({
  status: { supported: true, currentVersion: "0.6.0", phase: "idle" } as AppUpdateStatus,
  busy: false,
  checked: false,
  check: vi.fn(), download: vi.fn(), install: vi.fn(),
}));
vi.mock("../lib/useAppUpdates", () => ({ useAppUpdates: () => mocked }));

describe("Orion update controls", () => {
  beforeEach(() => {
    mocked.status = { supported: true, currentVersion: "0.6.0", phase: "idle" };
    mocked.busy = false;
    mocked.checked = false;
    vi.clearAllMocks();
  });

  it("keeps the toolbar quiet until an update exists and excludes Preview and browser hosts", () => {
    const { rerender } = render(<><AppUpdateButton /><AppUpdateSettings /></>);
    expect(screen.queryByRole("button", { name: "Update Orion" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(mocked.check).toHaveBeenCalledOnce();
    mocked.status = { ...mocked.status, supported: false, version: "0.6.1" };
    rerender(<><AppUpdateButton /><AppUpdateSettings /></>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens a compact prompt and requires a separate explicit download action", () => {
    mocked.status = { ...mocked.status, phase: "available", version: "0.6.1" };
    render(<AppUpdateButton />);
    const trigger = screen.getByRole("button", { name: "Update Orion" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Orion 0.6.1 is available")).toBeInTheDocument();
    expect(mocked.download).not.toHaveBeenCalled();
    expect(mocked.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download update" }));
    expect(mocked.download).toHaveBeenCalledOnce();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Orion update" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows progress without allowing a second download, then asks to restart", () => {
    mocked.status = { ...mocked.status, phase: "downloading", version: "0.6.1", downloaded: 30, total: 100 };
    const { rerender } = render(<AppUpdateButton />);
    fireEvent.click(screen.getByRole("button", { name: "Orion update progress" }));
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
    expect(screen.getByRole("button", { name: "30% downloaded" })).toBeDisabled();
    mocked.status = { ...mocked.status, phase: "ready" };
    rerender(<AppUpdateButton />);
    expect(mocked.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart and update" }));
    expect(mocked.install).toHaveBeenCalledOnce();
  });

  it("lets an install blocked by an unsaved window be retried without redownloading", () => {
    mocked.status = { ...mocked.status, phase: "ready", version: "0.6.1", error: "A note could not be saved. Resolve the save error and try again." };
    render(<AppUpdateSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("A note could not be saved");
    fireEvent.click(screen.getByRole("button", { name: "Try restart again" }));
    expect(mocked.install).toHaveBeenCalledOnce();
    expect(mocked.download).not.toHaveBeenCalled();
  });

  it("makes background failures quiet in the toolbar and actionable in Settings", () => {
    mocked.status = { ...mocked.status, phase: "error", error: "You appear to be offline." };
    render(<><AppUpdateButton /><AppUpdateSettings /></>);
    expect(screen.queryByRole("button", { name: "Update Orion" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("You appear to be offline.");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(mocked.check).toHaveBeenCalledOnce();
  });
});
