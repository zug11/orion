import { useLayoutEffect, useState, type RefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { paintNativeToolbar } from "./editor/nativeToolbarPaint";

let sequence = 0;
const nextSequence = () => sequence = Math.max(sequence + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
const queries = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"];

/** Paint-only native circle. The live DOM retains all input and accessibility. */
export function useNativeChatGlass(ref: RefObject<HTMLDivElement | null>, enabled: boolean, open: boolean, busy: boolean) {
  const [active, setActive] = useState(false);
  useLayoutEffect(() => {
    if (!isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    let mounted = true, frame = 0, last = "", revision = 0, failed = false;
    const media = queries.map(query => matchMedia(query));
    const send = (request: Record<string, unknown>) => {
      const key = JSON.stringify(request);
      if (key === last) return;
      last = key;
      const sent = revision = nextSequence();
      if (!request.visible) setActive(false);
      void invoke<{ active: boolean; available: boolean }>("set_ruler_glass", { request: { ...request, surface: "chat", sequence: sent } }).then(result => {
        if (mounted && revision === sent) setActive(Boolean(request.visible && result.active && result.available));
      }, () => {
        if (!mounted || revision !== sent) return;
        failed = true; setActive(false);
        if (request.visible) send({ visible: false });
      });
    };
    const update = () => {
      frame = 0;
      const root = ref.current;
      if (!enabled || failed || !root || root.hidden || document.hidden || media.some(query => query.matches)) { send({ visible: false }); return; }
      const rect = root.getBoundingClientRect();
      if (rect.width < 24 || rect.width > 64 || rect.width !== rect.height || rect.x < 0 || rect.y < 0 || rect.right > innerWidth || rect.bottom > innerHeight) { send({ visible: false }); return; }
      // The native surface must yield to DOM dialogs, menus and fullscreen UI.
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (!hit || !root.contains(hit)) { send({ visible: false }); return; }
      let paint;
      try { paint = paintNativeToolbar(root); } catch { paint = null; }
      if (!paint) { send({ visible: false }); return; }
      const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      send({ visible: true, frame: box, viewport: { width: innerWidth, height: innerHeight },
        left: 0, right: 0, leftPosition: 0, rightPosition: rect.width, activeSide: null, focusedSide: null,
        foreground: [0, 0, 0, 1], muted: [0, 0, 0, 1], accent: [0, 0, 0, 1],
        dark: root.closest<HTMLElement>("[data-theme]")?.dataset.theme === "dark", rulerVisible: false,
        toolbar: { frame: box, paint } });
    };
    const schedule = () => { if (!frame && mounted) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    if (ref.current) resize.observe(ref.current);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "data-theme"] });
    const events = ["pointerover", "pointerout", "focusin", "focusout", "visibilitychange", "scroll"];
    events.forEach(event => document.addEventListener(event, schedule, true));
    window.addEventListener("resize", schedule);
    media.forEach(query => query.addEventListener("change", schedule));
    schedule();
    return () => {
      mounted = false; cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      events.forEach(event => document.removeEventListener(event, schedule, true));
      window.removeEventListener("resize", schedule);
      media.forEach(query => query.removeEventListener("change", schedule));
      void invoke("set_ruler_glass", { request: { visible: false, surface: "chat", sequence: nextSequence() } }).catch(() => undefined);
    };
  }, [ref, enabled, open, busy]);
  return enabled && active;
}
