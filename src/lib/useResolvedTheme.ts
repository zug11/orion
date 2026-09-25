import { useEffect, useMemo, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "../types";
import { useWindowGlass } from "./useWindowGlass";
import type { WindowGlassStatus } from "./windowGlass";
import {
  resolveThemeMode,
  resolveThemePalette,
  themePaletteCssVariables,
  type ThemePalette,
} from "./theme";

const SYSTEM_THEME_QUERY = "(prefers-color-scheme: light)";

function readSystemPrefersLight(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(SYSTEM_THEME_QUERY).matches
  );
}

export function applyResolvedTheme(
  palette: ThemePalette,
  preset: Settings["themePreset"],
  root = document.documentElement,
): void {
  root.dataset.theme = palette.mode;
  root.dataset.themePreset = preset;
  root.style.colorScheme = palette.mode;
  for (const [name, value] of Object.entries(
    themePaletteCssVariables(palette),
  )) {
    root.style.setProperty(name, value);
  }
  root.ownerDocument
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", palette.canvas);
}

export function useResolvedTheme(settings: Settings): {
  mode: ThemePalette["mode"];
  palette: ThemePalette;
  glassStatus: WindowGlassStatus | null;
} {
  const glassStatus = useWindowGlass(settings.windowGlass);
  const [systemPrefersLight, setSystemPrefersLight] = useState(
    readSystemPrefersLight,
  );
  const mode = resolveThemeMode(settings.theme, systemPrefersLight);
  const palette = useMemo(
    () => resolveThemePalette(settings, mode),
    [mode, settings],
  );

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return undefined;
    }
    const systemTheme = window.matchMedia(SYSTEM_THEME_QUERY);
    const updateSystemTheme = () => setSystemPrefersLight(systemTheme.matches);
    updateSystemTheme();
    systemTheme.addEventListener("change", updateSystemTheme);
    return () => systemTheme.removeEventListener("change", updateSystemTheme);
  }, []);

  useEffect(() => {
    applyResolvedTheme(palette, settings.themePreset);
  }, [palette, settings.themePreset]);

  useEffect(() => {
    if (!isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) {
      return undefined;
    }
    // Let macOS own System mode so forcing an appearance cannot stop subsequent
    // system changes from reaching the WebView's prefers-color-scheme listener.
    void getCurrentWindow()
      .setTheme(settings.theme === "system" ? null : settings.theme)
      .catch(() => console.warn("Orion could not update the native window appearance."));
  }, [settings.theme]);

  return { mode, palette, glassStatus };
}
