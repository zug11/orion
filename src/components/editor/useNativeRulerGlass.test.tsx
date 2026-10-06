// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNativeRulerGlass, type NativeRulerOptions } from "./useNativeRulerGlass";

const native = vi.hoisted(() => ({ isTauri: vi.fn(), invoke: vi.fn() }));
const paint = vi.hoisted(() => ({ paintNativeToolbar: vi.fn(), paintNativeMenu: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
vi.mock("./nativeToolbarPaint", () => paint);
const state: NativeRulerOptions = { enabled: true, left: 0, right: 0, leftPosition: 0, rightPosition: 680, activeSide: null, focusedSide: null, disabled: false };
let track: HTMLDivElement;
let rect: DOMRect;
let ref: { current: HTMLDivElement | null };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let media: Map<string, { matches: boolean; listeners: Set<() => void> }>;

function box(x = 100, y = 120, width = 680, height = 44) { return new DOMRect(x, y, width, height); }
async function flush() {
  await act(async () => {
    await Promise.resolve();
    for (let pass = 0; pass < 5 && frames.size; pass++) {
      const current = [...frames.values()]; frames.clear();
      current.forEach(callback => callback(pass * 16));
      await Promise.resolve();
    }
  });
}
function lastRequest() {
  const { sequence: _sequence, ...request } = native.invoke.mock.calls[native.invoke.mock.calls.length - 1]?.[1].request ?? {};
  return request;
}

beforeEach(() => {
  native.isTauri.mockReturnValue(true);
  paint.paintNativeToolbar.mockReset().mockReturnValue({ png: "bounded-toolbar-paint", width: 1360, height: 88 });
  paint.paintNativeMenu.mockReset().mockReturnValue({ png: "bounded-menu-paint", width: 448, height: 720 });
  native.invoke.mockImplementation(async (command, { request }) => ({ active: command === "move_ruler_glass" || request.visible, available: true }));
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  frames = new Map(); nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  media = new Map();
  vi.stubGlobal("matchMedia", (query: string) => {
    if (!media.has(query)) media.set(query, { matches: false, listeners: new Set() });
    const item = media.get(query)!;
    return { get matches() { return item.matches; }, addEventListener: (_name: string, callback: () => void) => item.listeners.add(callback), removeEventListener: (_name: string, callback: () => void) => item.listeners.delete(callback) };
  });
  track = document.createElement("div");
  track.style.setProperty("--text-soft", "#aabbcc");
  track.style.setProperty("--muted", "#334455");
  track.style.setProperty("--periwinkle-strong", "#4488dd");
  document.body.append(track);
  rect = box();
  vi.spyOn(track, "getBoundingClientRect").mockImplementation(() => rect);
  ref = { current: track };
  document.documentElement.dataset.theme = "light";
});
afterEach(async () => {
  cleanup();
  await flush();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  Reflect.deleteProperty(document, "elementsFromPoint");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); native.invoke.mockReset();
});

describe("native ruler glass bridge", () => {
  it("keeps the toolbar and ruler glass active beneath More, repaints menu scrolling, and removes only the menu on close", async () => {
    const dock = document.createElement("div"); document.body.append(dock); dock.append(track);
    track.className = "editor-toolbar-shell";
    const ruler = document.createElement("div"); ruler.className = "editor-margins-track";
    ruler.style.cssText = track.style.cssText;
    Object.assign(ruler.dataset, { ready: "true", left: "0", right: "0", leftPosition: "0", rightPosition: "680", disabled: "false" });
    vi.spyOn(ruler, "getBoundingClientRect").mockReturnValue(box(100, 169));
    dock.append(ruler);
    const { result } = renderHook(() => useNativeRulerGlass({ current: dock })); await flush();
    const menu = document.createElement("div"); menu.role = "menu"; menu.className = "editor-more-menu editor-floating-menu";
    menu.style.cssText = track.style.cssText;
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(box(540, 170, 224, 360));
    // At the rounded menu's corners the browser hits the ruler/prose behind it.
    // Neither is an obstruction to the menu's native surface.
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (x: number, y: number) => {
      if (menu.isConnected && x >= 540 && x <= 764 && y >= 170 && y <= 530) {
        if ((x < 552 || x > 752) && (y < 182 || y > 518)) return [ruler, document.body];
        return [menu, ruler, document.body];
      }
      return y < 169 ? [track, document.body] : [ruler, document.body];
    } });
    track.append(menu); await flush();
    expect(result.current).toBe(true);
    expect(lastRequest()).toMatchObject({ visible: true, rulerVisible: true, toolbar: { frame: { y: 120 } }, menu: { frame: { x: 540, y: 170, height: 360 }, paint: { png: "bounded-menu-paint" } } });
    const count = paint.paintNativeMenu.mock.calls.length;
    menu.dispatchEvent(new Event("scroll")); await flush();
    expect(paint.paintNativeMenu).toHaveBeenCalledTimes(count + 1);
    menu.remove(); await flush();
    expect(lastRequest().visible).toBe(true);
    expect(lastRequest().menu).toBeUndefined();
    expect(result.current).toBe(true);
    Reflect.deleteProperty(document, "elementsFromPoint");
  });

  it("falls back safely when More cannot be painted or another dialog overlaps it", async () => {
    const dock = document.createElement("div"); document.body.append(dock); dock.append(track);
    track.className = "editor-toolbar-shell";
    const menu = document.createElement("div"); menu.role = "menu"; menu.className = "editor-more-menu";
    menu.style.cssText = track.style.cssText;
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(box(540, 170, 224, 360));
    track.append(menu);
    paint.paintNativeMenu.mockReturnValue(null);
    const { result } = renderHook(() => useNativeRulerGlass({ current: dock })); await flush();
    expect(result.current).toBe(false);
    expect(lastRequest()).toEqual({ visible: false });
    paint.paintNativeMenu.mockReturnValue({ png: "menu", width: 448, height: 720 });
    menu.dispatchEvent(new Event("pointerover", { bubbles: true })); await flush();
    expect(result.current).toBe(true);
    const dialog = document.createElement("div"); dialog.role = "dialog";
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(box(530, 200, 300, 300));
    document.body.append(dialog); await flush();
    expect(result.current).toBe(false);
    expect(lastRequest()).toEqual({ visible: false });
  });

  it("keeps native toolbar available with the ruler closed and moves both in one request without repainting during scroll", async () => {
    const dock = document.createElement("div"); dock.className = "editor-formatting-dock";
    document.body.append(dock); dock.append(track); track.className = "editor-toolbar-shell";
    const dockRef = { current: dock };
    const { result } = renderHook(() => useNativeRulerGlass(dockRef)); await flush();
    expect(result.current).toBe(true);
    expect(lastRequest()).toMatchObject({ visible: true, rulerVisible: false, toolbar: { frame: { y: 120 }, paint: { png: "bounded-toolbar-paint" } } });
    const ruler = document.createElement("div"); ruler.className = "editor-margins-track";
    ruler.style.cssText = track.style.cssText;
    Object.assign(ruler.dataset, { ready: "true", left: "mixed", right: "0", leftPosition: "20", rightPosition: "680", disabled: "false" });
    vi.spyOn(ruler, "getBoundingClientRect").mockImplementation(() => box(100, rect.y + 49));
    dock.append(ruler); await flush();
    expect(lastRequest()).toMatchObject({ rulerVisible: true, frame: { y: 169 }, left: null, toolbar: { frame: { y: 120 } } });
    const count = paint.paintNativeToolbar.mock.calls.length;
    rect = box(100, 70); document.dispatchEvent(new Event("scroll")); await flush();
    expect(lastRequest()).toMatchObject({ frame: { y: 119 }, toolbar: { y: 70 } });
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 1]?.[0]).toBe("move_ruler_glass");
    expect(JSON.stringify(lastRequest())).not.toContain("png");
    expect(paint.paintNativeToolbar).toHaveBeenCalledTimes(count);
    ruler.remove(); await flush();
    expect(lastRequest()).toMatchObject({ visible: true, rulerVisible: false });
    expect(result.current).toBe(true);
  });

  it("keeps all DOM controls visible when toolbar painting fails and restores native paint after recovery", async () => {
    const dock = document.createElement("div"); document.body.append(dock); dock.append(track);
    track.className = "editor-toolbar-shell";
    paint.paintNativeToolbar.mockReturnValue(null);
    const { result } = renderHook(() => useNativeRulerGlass({ current: dock })); await flush();
    expect(result.current).toBe(false); expect(lastRequest()).toEqual({ visible: false });
    paint.paintNativeToolbar.mockReturnValue({ png: "valid", width: 1360, height: 88 });
    track.dispatchEvent(new Event("pointerover", { bubbles: true })); await flush();
    expect(result.current).toBe(true);
  });
  it("leaves browser and non-Mac runtimes on the usable HTML surface", async () => {
    native.isTauri.mockReturnValue(false);
    const first = renderHook(() => useNativeRulerGlass(ref, state));
    await flush();
    expect(first.result.current).toBe(false);
    expect(native.invoke).not.toHaveBeenCalled();
    first.unmount();
    native.isTauri.mockReturnValue(true);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows NT");
    renderHook(() => useNativeRulerGlass(ref, state));
    await flush();
    expect(native.invoke).not.toHaveBeenCalled();
  });

  it("only enables native paint after acknowledgement, using actual geometry and palette", async () => {
    let resolve: (value: { active: boolean; available: boolean }) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useNativeRulerGlass(ref, state));
    await flush();
    expect(result.current).toBe(false);
    expect(lastRequest()).toMatchObject({ visible: true, frame: { x: 100, y: 120, width: 680, height: 44 }, viewport: { width: 1024, height: 768 }, left: 0, right: 0, leftPosition: 0, rightPosition: 680, activeSide: null, focusedSide: null, compact: false, dark: false });
    expect(lastRequest().foreground).toEqual([170 / 255, 187 / 255, 204 / 255, 1]);
    expect(lastRequest().accent).toEqual([68 / 255, 136 / 255, 221 / 255, 1]);
    await act(async () => resolve({ active: true, available: true }));
    expect(result.current).toBe(true);
  });

  it("sends selection and hide changes without waiting for old responses to reactivate hidden glass", async () => {
    let resolve: (value: { active: boolean; available: boolean }) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { result, rerender } = renderHook(({ options }) => useNativeRulerGlass(ref, options), { initialProps: { options: state } });
    await flush();
    rerender({ options: { ...state, left: 10, leftPosition: 68, activeSide: "left", focusedSide: "left" } }); await flush();
    rerender({ options: { ...state, enabled: false } }); await flush();
    expect(native.invoke).toHaveBeenCalledTimes(3);
    await act(async () => resolve({ active: true, available: true }));
    expect(native.invoke).toHaveBeenCalledTimes(3);
    expect(lastRequest()).toEqual({ visible: false });
    expect(result.current).toBe(false);
    rerender({ options: { ...state, left: null, right: 5, rightPosition: 646, focusedSide: "right" } }); await flush();
    expect(lastRequest()).toMatchObject({ visible: true, left: null, right: 5, focusedSide: "right", activeSide: null });
    expect(result.current).toBe(true);
  });

  it("hides for overlapping menus and restores after removal, with no idle polling or duplicate IPC", async () => {
    const { result } = renderHook(() => useNativeRulerGlass(ref, state));
    await flush();
    const calls = native.invoke.mock.calls.length;
    window.dispatchEvent(new Event("resize")); await flush();
    expect(native.invoke).toHaveBeenCalledTimes(calls);
    expect(frames.size).toBe(0);
    const menu = document.createElement("div"); menu.role = "menu";
    vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(box(300, 80, 180, 300));
    document.body.append(menu); await flush();
    expect(lastRequest()).toEqual({ visible: false });
    expect(result.current).toBe(false);
    menu.remove(); await flush();
    expect(lastRequest().visible).toBe(true);
    expect(result.current).toBe(true);
    expect(frames.size).toBe(0);
  });

  it("follows scroll and theme changes and falls back when viewport or ancestor clipping cuts the glass", async () => {
    const { result, rerender } = renderHook(({ options }) => useNativeRulerGlass(ref, options), { initialProps: { options: state } }); await flush();
    rect = box(110, 80, 400);
    rerender({ options: { ...state, rightPosition: 400 } });
    document.dispatchEvent(new Event("scroll")); await flush();
    expect(lastRequest()).toMatchObject({ frame: { x: 110, y: 80, width: 400 }, compact: true });
    document.documentElement.dataset.theme = "dark";
    track.style.setProperty("--periwinkle-strong", "rgb(12, 24, 48)"); await flush();
    expect(lastRequest()).toMatchObject({ dark: true, accent: [12 / 255, 24 / 255, 48 / 255, 1] });
    rect = box(4, 80, 400); window.dispatchEvent(new Event("resize")); await flush();
    expect(result.current).toBe(false);
    expect(lastRequest()).toEqual({ visible: false });
    rect = box(100, 80, 400);
    const clipped = document.createElement("div"); clipped.style.overflowX = "hidden";
    vi.spyOn(clipped, "getBoundingClientRect").mockReturnValue(box(110, 0, 600, 600));
    document.body.append(clipped); clipped.append(track); await flush();
    expect(result.current).toBe(false);
    clipped.style.overflowX = "visible"; await flush();
    expect(result.current).toBe(true);
  });

  it("sends scroll geometry immediately, cancels a scheduled frame, and remains idle after settling", async () => {
    renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    const calls = native.invoke.mock.calls.length;
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    rect = box(100, 210);
    document.dispatchEvent(new Event("scroll"));
    // No RAF or promise flush is needed to dispatch the corrected native frame.
    expect(native.invoke).toHaveBeenCalledTimes(calls + 1);
    expect(lastRequest()).toMatchObject({ frame: { y: 210 } });
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 1]?.[0]).toBe("move_ruler_glass");
    expect(frames.size).toBe(0);
    await flush();
    document.dispatchEvent(new Event("scrollend"));
    await flush();
    expect(native.invoke).toHaveBeenCalledTimes(calls + 1);
    expect(frames.size).toBe(0);
  });

  it("sends every changed scroll position while acknowledgement is delayed, ignoring stale replies", async () => {
    const { result } = renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    let resolve: (value: { active: boolean; available: boolean }) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const calls = native.invoke.mock.calls.length;
    rect = box(100, 170); document.dispatchEvent(new Event("scroll"));
    rect = box(100, 230); document.dispatchEvent(new Event("scroll"));
    rect = box(100, 290); document.dispatchEvent(new Event("scroll"));
    expect(native.invoke).toHaveBeenCalledTimes(calls + 3);
    expect(lastRequest()).toMatchObject({ frame: { y: 290 } });
    const revisions = native.invoke.mock.calls.slice(calls).map(call => call[1].request.sequence);
    expect(revisions.every(Number.isSafeInteger)).toBe(true);
    expect(revisions[0]).toBeLessThan(revisions[1]);
    expect(revisions[1]).toBeLessThan(revisions[2]);
    await flush();
    await act(async () => resolve({ active: false, available: false }));
    expect(result.current).toBe(true);
    expect(native.invoke).toHaveBeenCalledTimes(calls + 3);
    expect(frames.size).toBe(0);
  });

  it("restores full artwork once when a resize invalidates the native motion cache", async () => {
    const { result } = renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    native.invoke.mockRejectedValueOnce(new Error("The editor scroll surface must not resize."));
    rect = box(100, 210); document.dispatchEvent(new Event("scroll")); await flush();
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 2]?.[0]).toBe("move_ruler_glass");
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 1]?.[0]).toBe("set_ruler_glass");
    expect(result.current).toBe(true);
    rect = box(100, 215); document.dispatchEvent(new Event("scroll")); await flush();
    expect(native.invoke.mock.calls[native.invoke.mock.calls.length - 1]?.[0]).toBe("move_ruler_glass");
    expect(result.current).toBe(true);
  });

  it("honors live accessibility preferences and unavailable native support", async () => {
    const { result } = renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    const reduced = media.get("(prefers-reduced-transparency: reduce)")!;
    act(() => { reduced.matches = true; reduced.listeners.forEach(listener => listener()); }); await flush();
    expect(result.current).toBe(false);
    expect(lastRequest()).toEqual({ visible: false });
    act(() => { reduced.matches = false; reduced.listeners.forEach(listener => listener()); }); await flush();
    expect(result.current).toBe(true);
    const forced = media.get("(forced-colors: active)")!;
    act(() => { forced.matches = true; forced.listeners.forEach(listener => listener()); }); await flush();
    expect(result.current).toBe(false);
    act(() => { forced.matches = false; forced.listeners.forEach(listener => listener()); }); await flush();
    expect(result.current).toBe(true);
    native.invoke.mockResolvedValue({ active: false, available: false });
    rect = box(100, 130); document.dispatchEvent(new Event("scroll")); await flush();
    expect(result.current).toBe(false);
    rect = box(100, 140); document.dispatchEvent(new Event("scroll")); await flush();
    expect(lastRequest()).toEqual({ visible: false });
  });

  it("recovers from transient invalid marker geometry without issuing an invalid native request", async () => {
    const { result, rerender } = renderHook(({ options }) => useNativeRulerGlass(ref, options), { initialProps: { options: state } }); await flush();
    rerender({ options: { ...state, rightPosition: 700 } }); await flush();
    expect(lastRequest()).toEqual({ visible: false });
    expect(result.current).toBe(false);
    rerender({ options: { ...state, rightPosition: 650, leftPosition: 700 } }); await flush();
    expect(lastRequest()).toEqual({ visible: false });
    rerender({ options: { ...state, rightPosition: 650, leftPosition: 100 } }); await flush();
    expect(lastRequest()).toMatchObject({ visible: true, rightPosition: 650, leftPosition: 100 });
    expect(result.current).toBe(true);
    rect = box(100, 120, 680, 20); window.dispatchEvent(new Event("resize")); await flush();
    expect(lastRequest()).toEqual({ visible: false });
    rect = box(); window.dispatchEvent(new Event("resize")); await flush();
    expect(result.current).toBe(true);
  });

  it("tries one cleanup hide after uncertain IPC failure and stays on HTML thereafter", async () => {
    native.invoke.mockRejectedValue(new Error("transport failed"));
    const { result } = renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    expect(result.current).toBe(false);
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toEqual({ visible: false });
    window.dispatchEvent(new Event("resize")); await flush();
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it("does not allow an old unmount hide to win over a replacement ruler", async () => {
    let resolve: (value: { active: boolean; available: boolean }) => void = () => undefined;
    native.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = renderHook(() => useNativeRulerGlass(ref, state)); await flush();
    first.unmount();
    const second = renderHook(() => useNativeRulerGlass(ref, { ...state, left: 12, leftPosition: 81.6 })); await flush();
    await act(async () => resolve({ active: true, available: true }));
    expect(native.invoke).toHaveBeenCalledTimes(3);
    expect(lastRequest()).toMatchObject({ visible: true, left: 12 });
    expect(second.result.current).toBe(true);
    second.unmount(); await flush();
    expect(lastRequest()).toEqual({ visible: false });
    expect(frames.size).toBe(0);
  });
});
