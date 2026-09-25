import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { WindowGlassSettings } from "../types";
import { normalizeWindowGlass, requestedWindowMaterial, type WindowGlassStatus } from "./windowGlass";

// Serialize view reparenting. A quick toggle cannot be overtaken by an
// older IPC request, and changes never rebuild the renderer or its note editor.
let nativeUpdate: Promise<unknown> = Promise.resolve();
const accessibilityQueries = [
  "(prefers-reduced-transparency: reduce)",
  "(prefers-contrast: more)",
];

export function useWindowGlass(preference: WindowGlassSettings): WindowGlassStatus | null {
  const glass = useMemo(() => normalizeWindowGlass(preference), [preference]);
  const [status, setStatus] = useState<WindowGlassStatus | null>(null);
  const [opaque, setOpaque] = useState(false);
  const material = opaque ? "solid" : requestedWindowMaterial(glass);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const queries = accessibilityQueries.map((query) => window.matchMedia(query));
    const update = () => setOpaque(queries.some((query) => query.matches));
    update();
    queries.forEach((query) => query.addEventListener("change", update));
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--glass-tint-opacity", `${glass.enabled ? glass.tintOpacity : 100}%`);
    return () => {
      root.style.removeProperty("--glass-tint-opacity");
    };
  }, [glass.enabled, glass.tintOpacity]);

  useEffect(() => {
    if (!isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    let current = true;
    const root = document.documentElement;
    const request = { material, style: "regular", cornerRadius: 16, interactive: false, blur: glass.blur };
    const updated = nativeUpdate.catch(() => undefined).then(() => invoke<WindowGlassStatus>("set_window_glass", { request }));
    nativeUpdate = updated;
    void updated.then((result) => {
      if (!current) return;
      if (result.material === "solid") delete root.dataset.nativeGlass;
      else root.dataset.nativeGlass = "true";
      root.dataset.windowMaterial = result.material;
      setStatus(result);
    }).catch(() => {
      if (!current) return;
      delete root.dataset.nativeGlass;
      root.dataset.windowMaterial = "solid";
      setStatus({ material: "solid", liquidAvailable: false, interactiveAvailable: false, error: true });
      console.warn("Orion could not update the native glass; using solid surfaces.");
    });
    return () => { current = false; };
  }, [material, glass.blur]);

  useEffect(() => () => {
    delete document.documentElement.dataset.nativeGlass;
    delete document.documentElement.dataset.windowMaterial;
  }, []);
  return status;
}
