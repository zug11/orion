// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { resolveThemePalette } from "./theme";
import { useThemeIcon } from "./useThemeIcon";

const mocks = vi.hoisted(() => ({ render: vi.fn(), invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: mocks.native }));
vi.mock("./themeIcon", async (original) => ({ ...await original<object>(), renderThemeIcon: mocks.render }));
const palette = resolveThemePalette(defaultSettings, "dark");
const advance = async (ms: number) => { await act(() => vi.advanceTimersByTimeAsync(ms)); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  mocks.native.mockReturnValue(true);
  mocks.render.mockResolvedValue({ mark: "themed.png", dock: "encoded-png" });
  mocks.invoke.mockResolvedValue({ applied: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

it("waits for hydration, debounces drawing, and keeps native icons out of browser preview", async () => {
  mocks.native.mockReturnValue(false);
  const { result, rerender, unmount } = renderHook(({ ready }) => useThemeIcon(palette, true, ready), { initialProps: { ready: false } });
  await advance(500);
  expect(mocks.render).not.toHaveBeenCalled();
  rerender({ ready: true });
  await advance(119);
  expect(mocks.render).not.toHaveBeenCalled();
  await advance(500);
  expect(result.current.mark).toBe("themed.png");
  expect(mocks.invoke).not.toHaveBeenCalled();
  unmount();
});

it("ignores a late render after selecting Original and restores the native icon", async () => {
  let finish!: (value: { mark: string; dock: string }) => void;
  mocks.render.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const { result, rerender, unmount } = renderHook(({ enabled }) => useThemeIcon(palette, enabled), { initialProps: { enabled: true } });
  await advance(120);
  rerender({ enabled: false });
  await act(async () => finish({ mark: "late.png", dock: "late" }));
  await advance(350);
  expect(result.current.mark).toBe("/orion-symbol.png");
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("set_theme_icon", { png: null });
  unmount();
  await advance(500);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("serializes native updates so an older theme cannot overwrite an Original reset", async () => {
  let finish!: (value: { applied: boolean }) => void;
  mocks.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const { rerender, unmount } = renderHook(({ enabled }) => useThemeIcon(palette, enabled), { initialProps: { enabled: true } });
  await advance(120);
  await advance(350);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  await advance(350);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  await act(async () => finish({ applied: true }));
  expect(mocks.invoke).toHaveBeenLastCalledWith("set_theme_icon", { png: null });
  unmount();
});

it("retains the in-app mark after a Dock failure and clears the error on a successful retry", async () => {
  mocks.invoke.mockRejectedValueOnce(new Error("Dock unavailable"));
  const { result, unmount } = renderHook(() => useThemeIcon(palette, true));
  await advance(120);
  await advance(350);
  expect(result.current.mark).toBe("themed.png");
  expect(result.current.message).toContain("could not update");
  act(() => window.dispatchEvent(new Event("focus")));
  await advance(350);
  expect(result.current.message).toBeNull();
  expect(mocks.invoke).toHaveBeenLastCalledWith("set_theme_icon", { png: "encoded-png" });
  unmount();
});
