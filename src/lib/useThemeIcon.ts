import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ThemePalette } from "./theme";
import { renderThemeIcon, resolveIconPalette, type ThemeIconImages } from "./themeIcon";

export interface ThemeIconStatus { applied: boolean; finder: "updated" | "restored" | "read-only" | "unavailable" }

export function useThemeIcon(palette: ThemePalette, enabled: boolean, ready = true): { mark: string; message: string | null } {
  const key = JSON.stringify(resolveIconPalette(palette));
  const [rendered, setRendered] = useState<{ key: string; images: ThemeIconImages } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!enabled || !ready) return;
    let cancelled = false;
    // Let rapid colour-picker changes settle before drawing or crossing IPC.
    const timer = window.setTimeout(() => {
      void renderThemeIcon(JSON.parse(key)).then((images) => {
        if (!cancelled) setRendered({ key, images });
      }).catch(() => {
        if (!cancelled) {
          setRendered(null);
          setMessage("The themed icon could not load. Choose Original, then Theme to try again.");
        }
      });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key, enabled, ready]);

  const images = enabled && rendered?.key === key ? rendered.images : null;
  const dock = images?.dock;
  useEffect(() => {
    if (!ready || !isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    // Wait for the current render, rather than flashing the original between
    // themes. Native code lets only the preferred library window own the Dock.
    if (enabled && !dock) return;
    let cancelled = false;
    let timer: number;
    const update = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        queue.current = queue.current.then(async () => {
          if (cancelled) return;
          try {
            const status = await invoke<ThemeIconStatus>("set_theme_icon", { png: enabled ? dock : null });
            if (!cancelled && status.applied) setMessage(status.finder === "read-only"
              ? "Dock updated. Move Orion to a writable Applications folder to update its Finder icon."
              : status.finder === "unavailable" ? "Dock updated. Finder colours are available in the installed macOS app." : null);
          } catch {
            if (!cancelled) setMessage("The app icon could not update. Choose Original, then Theme to try again.");
          }
        });
      }, 300);
    };
    update();
    window.addEventListener("focus", update);
    return () => { cancelled = true; window.clearTimeout(timer); window.removeEventListener("focus", update); };
    // Never reset the app-wide icon when a secondary window unmounts.
  }, [enabled, dock, ready]);

  return {
    mark: enabled ? images?.mark ?? rendered?.images.mark ?? "/orion-symbol.png" : "/orion-symbol.png",
    message,
  };
}
