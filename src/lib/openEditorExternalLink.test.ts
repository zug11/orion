// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openEditorExternalLink } from "./openEditorExternalLink";
vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe("explicit editor browser navigation", () => {
  it("routes native web links through the default-browser opener", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    await openEditorExternalLink("example.com/paper");
    expect(openUrl).toHaveBeenCalledWith("https://example.com/paper");
  });
  it("opens preview web links without giving the destination an opener", async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await openEditorExternalLink("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com/", "_blank", "noopener,noreferrer");
    open.mockRestore();
  });
  it("rejects executable and local schemes before native dispatch", async () => {
    vi.mocked(isTauri).mockReturnValue(true);
    await expect(openEditorExternalLink("javascript:alert(1)")).rejects.toThrow();
    await expect(openEditorExternalLink("file:///etc/passwd")).rejects.toThrow();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
