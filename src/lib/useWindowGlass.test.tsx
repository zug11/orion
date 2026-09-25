// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultWindowGlass, type WindowGlassStatus } from "./windowGlass";
import { useWindowGlass } from "./useWindowGlass";

const native = vi.hoisted(() => ({ isTauri: vi.fn(() => true), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);

beforeEach(() => {
  native.isTauri.mockReturnValue(true);
  native.invoke.mockImplementation(async (_command, { request }) => ({ material: request.material, liquidAvailable: true, interactiveAvailable: true }));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh)");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); native.invoke.mockReset(); });

describe("native window glass", () => {
  it("keeps browser preview opaque without invoking native commands", () => {
    native.isTauri.mockReturnValue(false);
    const { result } = renderHook(() => useWindowGlass(defaultWindowGlass));
    expect(result.current).toBeNull();
    expect(native.invoke).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
  });
  it("accepts the native fallback and adjusts tint without reparenting the view", async () => {
    native.invoke.mockResolvedValue({ material: "frosted", liquidAvailable: false, interactiveAvailable: false });
    const { result, rerender } = renderHook(({ glass }) => useWindowGlass(glass), { initialProps: { glass: defaultWindowGlass } });
    await waitFor(() => expect(result.current?.material).toBe("frosted"));
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
    rerender({ glass: { ...defaultWindowGlass, tintOpacity: 72 } });
    expect(document.documentElement.style.getPropertyValue("--glass-tint-opacity")).toBe("72%");
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it("serializes rapid mode changes and does not let stale results re-enable glass", async () => {
    let release: (value: WindowGlassStatus) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise<WindowGlassStatus>((resolve) => { release = resolve; }));
    const { result, rerender } = renderHook(({ glass }) => useWindowGlass(glass), { initialProps: { glass: defaultWindowGlass } });
    await waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    rerender({ glass: { ...defaultWindowGlass, enabled: false } });
    expect(native.invoke).toHaveBeenCalledTimes(1);
    await act(async () => release({ material: "liquid", liquidAvailable: true, interactiveAvailable: true }));
    await waitFor(() => expect(result.current?.material).toBe("solid"));
    expect(document.documentElement.dataset.nativeGlass).toBeUndefined();
    expect(native.invoke).toHaveBeenLastCalledWith("set_window_glass", { request: { material: "solid", style: "regular", cornerRadius: 16, interactive: false, blur: 50 } });
  });
  it("honors a live reduced-transparency preference without rewriting the saved choice", async () => {
    const listeners = new Map<string, () => void>();
    let reduce = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query.includes("reduced-transparency") && reduce; },
      addEventListener: (_: string, fn: () => void) => listeners.set(query, fn),
      removeEventListener: () => undefined,
    }));
    const { result } = renderHook(() => useWindowGlass(defaultWindowGlass));
    await waitFor(() => expect(result.current?.material).toBe("liquid"));
    act(() => { reduce = true; listeners.get("(prefers-reduced-transparency: reduce)")?.(); });
    await waitFor(() => expect(result.current?.material).toBe("solid"));
    expect(defaultWindowGlass.enabled).toBe(true);
    act(() => { reduce = false; listeners.get("(prefers-reduced-transparency: reduce)")?.(); });
    await waitFor(() => expect(result.current?.material).toBe("liquid"));
  });
});
