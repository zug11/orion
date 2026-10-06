// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { paintNativeMenu, paintNativeToolbar } from "./nativeToolbarPaint";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("preserves button outlines without painting group dividers", () => {
  const fills: unknown[][] = [], strokes: string[] = [];
  const context = {
    fillStyle: "", strokeStyle: "", scale() {}, save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {},
    fillRect(...args: unknown[]) { fills.push([this.fillStyle, ...args]); },
    stroke() { strokes.push(this.strokeStyle); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,paint");
  const toolbar = document.createElement("div"); toolbar.style.setProperty("--line", "#445566");
  document.body.append(toolbar);
  vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 840, 48));
  for (let i = 0; i < 4; i++) {
    const button = document.createElement("button"); button.style.cssText = `visibility:visible;border:1px solid ${i === 0 ? "#8899dd" : "transparent"};`;
    toolbar.append(button);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue(new DOMRect(10 + i * 32, 8, 30, 30));
  }
  const group = document.createElement("div"); group.className = "editor-toolbar-history";
  group.style.cssText = "visibility:visible;border-left:1px solid transparent;"; toolbar.append(group);
  vi.spyOn(group, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 8, 70, 30));
  expect(paintNativeToolbar(toolbar)?.png).toBe("paint");
  expect(fills).toEqual([]);
  expect(strokes).toHaveLength(4);
  expect(strokes[0]).toBe("rgb(136, 153, 221)");
  expect(strokes.slice(1).every(color => color === "rgba(0, 0, 0, 0)")).toBe(true);
});

it("paints only the supported menu controls, including select labels, with separate height bounds", () => {
  const text: string[] = [];
  const context = {
    scale() {}, save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, fillText(value: string) { text.push(value); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,menu");
  const menu = document.createElement("div"); menu.className = "editor-more-menu"; menu.role = "menu";
  menu.innerHTML = '<label class="editor-style-select"><span>Text style</span><select><option selected>Text</option></select></label>';
  document.body.append(menu);
  vi.spyOn(menu, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 224, 360));
  for (const element of menu.querySelectorAll<HTMLElement>("span,select")) {
    element.style.visibility = "visible";
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(410, 110, 100, 30));
  }
  expect(paintNativeToolbar(menu)).toBeNull();
  expect(paintNativeMenu(menu)?.png).toBe("menu");
  expect(text).toEqual(["Text", "Text style"]);
  vi.mocked(menu.getBoundingClientRect).mockReturnValue(new DOMRect(400, 100, 224, 769));
  expect(paintNativeMenu(menu)).toBeNull();
  menu.className = "unrelated-menu";
  expect(paintNativeMenu(menu)).toBeNull();
});
