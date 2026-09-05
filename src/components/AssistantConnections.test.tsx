import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AssistantConnections } from "./AssistantConnections";
import type { AssistantAccess, WorkspaceInfo } from "../types";

const spaces: WorkspaceInfo[] = [{ id: "space-a", name: "Research", description: "", createdAt: "2026-01-01" }];
const access: AssistantAccess = { enabled: false, allowAI: false, allowWrites: false, spaceIds: [] };

describe("desktop workflow settings", () => {
  it("defaults off and keeps API, writes, and exact Space grants independent", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AssistantConnections access={access} spaces={spaces} jobs={[]} desktop onChange={onChange} />);
    expect(screen.getByRole("checkbox", { name: /Use Orion AI/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Enable desktop workflows/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...access, enabled: true });
    rerender(<AssistantConnections access={{ ...access, enabled: true }} spaces={spaces} jobs={[]} desktop onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Research/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...access, enabled: true, spaceIds: ["space-a"] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Use Orion AI/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...access, enabled: true, allowAI: true });
  });
  it("shows native activity and cancels only the selected job", async () => {
    const onCancel = vi.fn(async () => {});
    const job = { id: "job-a", spaceId: "space-a", operation: "research" as const, state: "running" as const, stage: "Reading exact evidence", createdAt: 1, updatedAt: 1 };
    render(<AssistantConnections access={access} spaces={spaces} jobs={[job]} desktop onChange={vi.fn()} onCancel={onCancel} />);
    expect(screen.getByText("Reading exact evidence")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledWith(job));
  });
  it("does not enable native workflow controls in a browser preview", () => {
    render(<AssistantConnections spaces={spaces} jobs={[]} desktop={false} onChange={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /Enable desktop workflows/ })).toBeDisabled();
  });
});
