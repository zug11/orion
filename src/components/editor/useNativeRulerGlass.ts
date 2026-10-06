import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { paintNativeMenu, paintNativeToolbar, type ToolbarPaint } from "./nativeToolbarPaint";

type Side = "left" | "right" | null;
type Color = [number, number, number, number];
export interface NativeRulerOptions {
  enabled: boolean;
  left: number | null;
  right: number | null;
  leftPosition: number;
  rightPosition: number;
  activeSide: Side;
  focusedSide: Side;
  disabled: boolean;
}
interface VisibleRequest extends Omit<NativeRulerOptions, "enabled"> {
  visible: true;
  frame: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
  foreground: Color;
  muted: Color;
  accent: Color;
  compact: boolean;
  dark: boolean;
  rulerVisible?: boolean;
  toolbar?: { frame: VisibleRequest["frame"]; paint: ToolbarPaint };
  menu?: { frame: VisibleRequest["frame"]; paint: ToolbarPaint };
}
type Request = VisibleRequest | { visible: false };
type Response = { active: boolean; available: boolean };
type Owner = { deactivate: () => void };
type Job = { owner: Owner; request: Request; complete: (response: Response | null) => void };

// Never make scroll geometry wait for a round trip through IPC. Each request
// has a monotonic revision (also across renderer reloads); AppKit rejects late
// arrivals and React ignores acknowledgements for superseded requests.
let owner: Owner | null = null;
let revision = 0;
let painted: { owner: Owner; request: VisibleRequest; sequence: number } | null = null;

function sameArtwork(a: VisibleRequest, b: VisibleRequest): boolean {
  const { frame: af, viewport: av, toolbar: at, menu: am, ...ap } = a;
  const { frame: bf, viewport: bv, toolbar: bt, menu: bm, ...bp } = b;
  const sameSize = (left?: VisibleRequest["frame"], right?: VisibleRequest["frame"]) =>
    left?.width === right?.width && left?.height === right?.height;
  const samePaint = (left?: ToolbarPaint, right?: ToolbarPaint) =>
    left?.width === right?.width && left?.height === right?.height && left?.png === right?.png;
  return av.width === bv.width && av.height === bv.height && sameSize(af, bf)
    && sameSize(at?.frame, bt?.frame) && samePaint(at?.paint, bt?.paint)
    && sameSize(am?.frame, bm?.frame) && samePaint(am?.paint, bm?.paint)
    && JSON.stringify(ap) === JSON.stringify(bp);
}

function enqueue(job: Job) {
  if (job.owner !== owner) return;
  const sequence = revision = Math.max(revision + 1, Math.floor((performance.timeOrigin + performance.now()) * 1000));
  const base = painted;
  const motion = job.request.visible && base?.owner === job.owner && sameArtwork(base.request, job.request);
  const request = motion && job.request.visible ? {
    sequence, baseSequence: base.sequence, viewport: job.request.viewport,
    frame: job.request.frame, rulerVisible: job.request.rulerVisible ?? true,
    toolbar: job.request.toolbar?.frame, menu: job.request.menu?.frame,
  } : { ...job.request, sequence };
  if (!motion) painted = null;
  void invoke<Response>(motion ? "move_ruler_glass" : "set_ruler_glass", { request }).then(
    result => {
      if (job.owner !== owner || sequence !== revision) return;
      if (motion && !result.active && result.available) { painted = null; enqueue(job); return; }
      if (!motion && job.request.visible && result.active && result.available) painted = { owner: job.owner, request: job.request, sequence };
      job.complete(result);
    },
    () => {
      if (job.owner !== owner || sequence !== revision) return;
      painted = null;
      // A resize can overtake scroll motion. Re-establish the full surface once
      // before falling back, rather than permanently losing glass for the note.
      if (motion) enqueue(job); else job.complete(null);
    },
  );
}

const accessibilityQueries = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"];
const overlaySelector = '[role="dialog"],[role="menu"],[role="listbox"],.editor-floating-menu,.modal-backdrop,.excerpt-picker-backdrop,.export-dialog-backdrop,.import-studio__backdrop,.import-studio__nested-backdrop,.source-viewer-backdrop';
const cap = 8;
const precision = (value: number) => Math.round(value * 100) / 100;
const intersects = (a: DOMRect, b: { left: number; top: number; right: number; bottom: number }) =>
  a.width > 0 && a.height > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function color(value: string): Color | null {
  const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? Array.from(hex, part => part + part).join("") : hex;
    return [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16) / 255).concat(full.length === 8 ? parseInt(full.slice(6), 16) / 255 : 1) as Color;
  }
  const rgb = value.trim().match(/^rgba?\((.+)\)$/i)?.[1];
  if (!rgb) return null;
  const parts = rgb.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const channels = parts.map((part, index) => parseFloat(part) / (part.endsWith("%") ? 100 : index < 3 ? 255 : 1));
  if (channels.some(channel => !Number.isFinite(channel) || channel < 0 || channel > 1)) return null;
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
}

function visible(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && style.opacity !== "0";
}

function measure(track: HTMLDivElement, options: NativeRulerOptions, opaque: boolean, nativeMenu: HTMLDivElement | null = null): Request {
  if (!options.enabled || opaque || !track.isConnected || document.hidden) return { visible: false };
  const rect = track.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const isMenu = track === nativeMenu;
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, options.leftPosition, options.rightPosition].every(Number.isFinite)
    || rect.width < 24 || rect.height < 24 || rect.height > (isMenu ? 768 : 80) || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 32768 || viewport.height > 32768) return { visible: false };
  // A selection/layout transition can briefly report old marker geometry. Keep
  // that transient state local instead of tripping native request validation.
  if (options.leftPosition < 0 || options.rightPosition > rect.width || options.leftPosition > options.rightPosition) return { visible: false };
  if ([options.left, options.right].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 25))) return { visible: false };
  const padding = isMenu ? 0 : cap;
  const bounds = { left: rect.left - padding, right: rect.right + padding, top: rect.top, bottom: rect.bottom };
  if (bounds.left < 0 || bounds.top < 0 || bounds.right > viewport.width || bounds.bottom > viewport.height) return { visible: false };
  // Native content does not participate in DOM overflow clipping.
  for (let ancestor: Element | null = track; ancestor; ancestor = ancestor.parentElement) {
    if (!visible(ancestor)) return { visible: false };
    if (ancestor === track || ancestor === document.body || ancestor === document.documentElement) continue;
    const style = getComputedStyle(ancestor);
    const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX || style.overflow);
    const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY || style.overflow);
    if (!clipsX && !clipsY) continue;
    const clip = ancestor.getBoundingClientRect();
    if ((clipsX && (bounds.left < clip.left || bounds.right > clip.right)) || (clipsY && (bounds.top < clip.top || bounds.bottom > clip.bottom))) return { visible: false };
  }
  // The supported More menu has its own native surface above the ruler.
  // Unrelated HTML overlays still need the ordinary fallback to stay on top.
  for (const overlay of document.querySelectorAll(overlaySelector)) {
    if (overlay === nativeMenu || overlay.contains(track) || track.contains(overlay) || !visible(overlay)) continue;
    if (intersects(overlay.getBoundingClientRect(), bounds)) return { visible: false };
  }
  if (typeof document.elementsFromPoint === "function") {
    // A menu's rounded corners intentionally reveal other DOM content. Probe
    // inside the curve instead of treating that exposed content as occlusion.
    const inset = isMenu ? 12 : 1;
    for (const x of [bounds.left + inset, rect.left + rect.width / 2, bounds.right - inset]) {
      for (const y of [bounds.top + inset, rect.top + rect.height / 2, bounds.bottom - inset]) {
        const hit = document.elementsFromPoint(x, y).find(element => visible(element) && (isMenu || !nativeMenu?.contains(element)));
        if (hit && !hit.contains(track) && !track.contains(hit)) return { visible: false };
      }
    }
  }
  const style = getComputedStyle(track);
  const foreground = color(style.getPropertyValue("--text-soft"));
  const muted = color(style.getPropertyValue("--muted"));
  const accent = color(style.getPropertyValue("--periwinkle-strong"));
  if (!foreground || !muted || !accent) return { visible: false };
  const theme = track.closest<HTMLElement>("[data-theme]")?.dataset.theme;
  const { enabled: _enabled, ...state } = options;
  return {
    ...state, visible: true,
    frame: { x: precision(rect.x), y: precision(rect.y), width: precision(rect.width), height: precision(rect.height) },
    viewport, leftPosition: precision(options.leftPosition), rightPosition: precision(options.rightPosition),
    foreground, muted, accent, compact: rect.width <= 420,
    dark: theme === "dark" || (theme !== "light" && !window.matchMedia?.("(prefers-color-scheme: light)").matches),
  };
}

/** Native draws only; the DOM sliders retain pointer, keyboard and AX ownership. */
export function useNativeRulerGlass(trackRef: RefObject<HTMLDivElement | null>, options?: NativeRulerOptions): boolean {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const scheduleRef = useRef<() => void>(() => undefined);
  const [active, setActive] = useState(false);

  useLayoutEffect(() => {
    if (!isTauri() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return;
    let mounted = true;
    let frame = 0;
    let lastRequest = "";
    let failed = false;
    let unavailable = false;
    let toolbarPaint: ToolbarPaint | null = null;
    let menuPaint: ToolbarPaint | null = null;
    let paintedMenu: HTMLDivElement | null = null;
    const identity: Owner = { deactivate: () => { if (mounted) setActive(false); } };
    owner?.deactivate();
    owner = identity;
    const queries = typeof window.matchMedia === "function" ? accessibilityQueries.map(query => window.matchMedia(query)) : [];
    const systemTheme = window.matchMedia?.("(prefers-color-scheme: light)");
    const send = (request: Request) => {
      const key = JSON.stringify(request);
      if (key === lastRequest || owner !== identity) return;
      lastRequest = key;
      // A moved/occluded native surface is no longer the current HTML surface.
      if (!request.visible) setActive(false);
      enqueue({ owner: identity, request, complete: result => {
        if (!mounted) return;
        setActive(Boolean(request.visible && result?.active && result.available));
        if (!result) {
          failed = true;
          // An IPC error can be an uncertain delivery; try one bounded hide.
          if (request.visible) send({ visible: false });
        } else if (!result.available) unavailable = true;
      } });
    };
    const update = (paint = true) => {
      frame = 0;
      if (!mounted || owner !== identity) return;
      const track = trackRef.current;
      const opaque = queries.some(query => query.matches);
      if (failed || unavailable || !track) { send({ visible: false }); return; }
      if (optionsRef.current) { send(measure(track, optionsRef.current, opaque)); return; }
      const toolbar = track.querySelector<HTMLDivElement>(".editor-toolbar-shell");
      if (!toolbar) { send({ visible: false }); return; }
      const menu = toolbar.querySelector<HTMLDivElement>('.editor-more-menu[role="menu"]');
      // Editing a numeric field needs its live DOM caret and text selection.
      if (document.activeElement instanceof HTMLInputElement && toolbar.contains(document.activeElement)) { send({ visible: false }); return; }
      if (paint || !toolbarPaint) {
        try { toolbarPaint = paintNativeToolbar(toolbar); } catch { toolbarPaint = null; }
      }
      if (!menu) { menuPaint = null; paintedMenu = null; }
      else if (paint || menu !== paintedMenu || !menuPaint) {
        try { menuPaint = paintNativeMenu(menu); } catch { menuPaint = null; }
        paintedMenu = menu;
      }
      let menuVisual: VisibleRequest["menu"];
      if (menu) {
        const width = menu.getBoundingClientRect().width;
        const measured = measure(menu, { enabled: true, left: 0, right: 0, leftPosition: 0, rightPosition: width, activeSide: null, focusedSide: null, disabled: false }, opaque, menu);
        if (!measured.visible || !menuPaint) { send({ visible: false }); return; }
        menuVisual = { frame: measured.frame, paint: menuPaint };
      }
      const width = toolbar.getBoundingClientRect().width;
      const toolbarRequest = measure(toolbar, { enabled: true, left: 0, right: 0, leftPosition: 0, rightPosition: width, activeSide: null, focusedSide: null, disabled: false }, opaque, menu);
      if (!toolbarRequest.visible || !toolbarPaint) { send({ visible: false }); return; }
      const ruler = track.querySelector<HTMLDivElement>(".editor-margins-track");
      let request = toolbarRequest;
      if (ruler) {
        const value = (name: string) => ruler.getAttribute(`data-${name}`);
        const nullableNumber = (name: string) => value(name) === "mixed" ? null : Number(value(name));
        const side = (name: string): Side => value(name) === "left" ? "left" : value(name) === "right" ? "right" : null;
        const rulerRequest = measure(ruler, { enabled: value("ready") === "true", left: nullableNumber("left"), right: nullableNumber("right"), leftPosition: Number(value("left-position")), rightPosition: Number(value("right-position")), activeSide: side("active-side"), focusedSide: side("focused-side"), disabled: value("disabled") === "true" }, opaque, menu);
        if (!rulerRequest.visible) { send({ visible: false }); return; }
        request = rulerRequest;
      }
      send({ ...request, rulerVisible: Boolean(ruler), toolbar: { frame: toolbarRequest.frame, paint: toolbarPaint }, menu: menuVisual });
    };
    const schedule = () => { if (mounted && !frame) frame = requestAnimationFrame(() => update()); };
    const scroll = (event?: Event) => {
      // WebKit has already moved the sticky HTML dock when scroll is delivered.
      // Waiting for another animation frame makes the native ruler trail it,
      // particularly when the dock leaves its pinned position near note top.
      cancelAnimationFrame(frame);
      frame = 0;
      update(event?.target === paintedMenu);
    };
    scheduleRef.current = schedule;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    if (trackRef.current) resize?.observe(trackRef.current);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open", "disabled", "inert", "aria-pressed", "aria-expanded", "aria-disabled", "data-theme", "data-native-glass", "data-window-material", "data-ready", "data-left", "data-right", "data-left-position", "data-right-position", "data-active-side", "data-focused-side", "data-disabled"] });
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    document.addEventListener("scrollend", scroll, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("transitionend", schedule, true);
    document.addEventListener("animationend", schedule, true);
    const chromeChanged = (event: Event) => { if (event.target instanceof Node && trackRef.current?.contains(event.target)) schedule(); };
    const chromeEvents = ["pointerover", "pointerout", "pointerdown", "pointerup", "focusin", "focusout", "change"];
    chromeEvents.forEach(name => document.addEventListener(name, chromeChanged, true));
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", scroll);
    queries.forEach(query => query.addEventListener("change", schedule));
    systemTheme?.addEventListener("change", schedule);
    schedule();
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
      scheduleRef.current = () => undefined;
      resize?.disconnect(); mutation.disconnect();
      document.removeEventListener("scroll", scroll, true);
      document.removeEventListener("scrollend", scroll, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("transitionend", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      chromeEvents.forEach(name => document.removeEventListener(name, chromeChanged, true));
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", scroll);
      queries.forEach(query => query.removeEventListener("change", schedule));
      systemTheme?.removeEventListener("change", schedule);
      if (owner === identity) enqueue({ owner: identity, request: { visible: false }, complete: () => undefined });
    };
  }, [trackRef]);
  useLayoutEffect(() => { scheduleRef.current(); }, [options?.enabled, options?.left, options?.right, options?.leftPosition, options?.rightPosition, options?.activeSide, options?.focusedSide, options?.disabled]);
  return (options?.enabled ?? true) && active;
}
