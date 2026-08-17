// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { resolveThemePalette } from "./theme";
import { useResolvedTheme } from "./useResolvedTheme";

describe("useResolvedTheme", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-preset");
    document.documentElement.removeAttribute("style");
    document.head.innerHTML = "";
  });

  it("updates the root palette and browser chrome when System mode changes", async () => {
    let prefersLight = false;
    let changeListener: (() => void) | null = null;
    const addEventListener = vi.fn(
      (_event: string, listener: EventListenerOrEventListenerObject) => {
        changeListener = () =>
          typeof listener === "function"
            ? listener(new Event("change"))
            : listener.handleEvent(new Event("change"));
      },
    );
    const removeEventListener = vi.fn();
    const mediaQuery = {
      get matches() {
        return prefersLight;
      },
      media: "(prefers-color-scheme: light)",
      onchange: null,
      addEventListener,
      removeEventListener,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
    document.head.innerHTML = '<meta name="theme-color" content="#090d15">';
    const settings = {
      ...defaultSettings,
      theme: "system" as const,
      themePreset: "ember" as const,
      themeAccentCustom: "#3456A8",
      themeCanvasTone: "airy" as const,
      themeTextWarmth: "warm" as const,
      themeContrast: "high" as const,
    };
    const dark = resolveThemePalette(settings, "dark");
    const light = resolveThemePalette(settings, "light");

    const { result, unmount } = renderHook(() => useResolvedTheme(settings));

    await waitFor(() => expect(result.current.mode).toBe("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(
      document.documentElement.style.getPropertyValue("--ink"),
    ).toBe(dark.canvas);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe(dark.canvas);

    act(() => {
      prefersLight = true;
      changeListener?.();
    });

    await waitFor(() => expect(result.current.mode).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      document.documentElement.style.getPropertyValue("--ink"),
    ).toBe(light.canvas);
    expect(
      document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.content,
    ).toBe(light.canvas);

    unmount();
    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });
});
