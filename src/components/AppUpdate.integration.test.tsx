// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppUpdateButton } from "./AppUpdate";
import type { AppUpdateStatus } from "../lib/appUpdates";

const native = vi.hoisted(() => ({
  receive: (_event: { payload: AppUpdateStatus }) => {},
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => ({ supported: true, currentVersion: "0.6.0", phase: "available", version: "0.6.1" })),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, callback) => { native.receive = callback; return native.stop; }),
}));

it("isolates native download progress from the workspace and editor render tree", async () => {
  let workspaceRenders = 0;
  let editorRenders = 0;
  function Editor() {
    editorRenders += 1;
    return <div role="textbox" contentEditable suppressContentEditableWarning>Writing stays responsive.</div>;
  }
  function Workspace() {
    workspaceRenders += 1;
    return <><AppUpdateButton /><Editor /></>;
  }
  const { unmount } = render(<Workspace />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Update Orion" })).toBeInTheDocument());
  const editor = screen.getByRole("textbox");
  editor.focus();
  for (let downloaded = 1; downloaded <= 20; downloaded += 1) {
    act(() => native.receive({ payload: { supported: true, currentVersion: "0.6.0", phase: "downloading", version: "0.6.1", downloaded, total: 100 } }));
  }
  expect(screen.getByRole("button", { name: "Orion update progress" })).toBeInTheDocument();
  expect(workspaceRenders).toBe(1);
  expect(editorRenders).toBe(1);
  expect(editor).toHaveFocus();
  expect(editor).toHaveTextContent("Writing stays responsive.");
  unmount();
  expect(native.stop).toHaveBeenCalledOnce();
});
