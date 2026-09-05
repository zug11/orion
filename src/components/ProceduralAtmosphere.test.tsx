// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAtmospherePalette } from "../lib/homeAtmosphere";
import ProceduralAtmosphere from "./ProceduralAtmosphere";

const palette = resolveAtmospherePalette("nova", "signature");
const fragmentSource = "void main() { gl_FragColor = vec4(1.0); }";
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let setIntersection: (visible: boolean) => void;
let setMotion: (reduced: boolean) => void;
let gl: ReturnType<typeof mockGl>;

function mockGl() {
  return {
    createShader: vi.fn(() => ({})),
    createProgram: vi.fn(() => ({})),
    createBuffer: vi.fn(() => ({})),
    getShaderParameter: vi.fn(() => true),
    getProgramParameter: vi.fn(() => true),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn((_program, name) => name),
    getExtension: vi.fn(() => ({ loseContext: vi.fn() })),
    shaderSource: vi.fn(), compileShader: vi.fn(), attachShader: vi.fn(),
    linkProgram: vi.fn(), useProgram: vi.fn(), bindBuffer: vi.fn(),
    bufferData: vi.fn(), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    uniform3f: vi.fn(), uniform2f: vi.fn(), uniform1f: vi.fn(), viewport: vi.fn(),
    deleteShader: vi.fn(), deleteBuffer: vi.fn(), deleteProgram: vi.fn(), drawArrays: vi.fn(),
  };
}

function advance(time: number) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(time));
  });
}

beforeEach(() => {
  gl = mockGl();
  frames = new Map();
  frameId = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(gl as unknown as WebGLRenderingContext);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 1600, bottom: 600,
    width: 1600, height: 600, toJSON: () => ({}),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const motionListeners = new Set<() => void>();
  const query = {
    matches: false,
    addEventListener: (_event: string, listener: () => void) => motionListeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => motionListeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  setMotion = (reduced) => {
    query.matches = reduced;
    motionListeners.forEach((listener) => listener());
  };
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
      setIntersection = (visible) => callback([{ isIntersecting: visible }]);
    }
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("procedural atmosphere resource boundaries", () => {
  it("caps pixels and drawing cadence, suspends offscreen, and releases resources", () => {
    const view = render(<ProceduralAtmosphere palette={palette} motion="alive" fragmentSource={fragmentSource} className="nova" />);
    const canvas = view.container.querySelector("canvas")!;
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(600_000);
    const initialDraws = gl.drawArrays.mock.calls.length;
    advance(10);
    advance(26);
    advance(44);
    advance(60);
    expect(gl.drawArrays.mock.calls.length - initialDraws).toBe(2);
    act(() => setIntersection(false));
    expect(frames.size).toBe(0);
    const suspendedDraws = gl.drawArrays.mock.calls.length;
    advance(8000);
    expect(gl.drawArrays).toHaveBeenCalledTimes(suspendedDraws);
    act(() => setIntersection(true));
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
    expect(gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(gl.deleteShader).toHaveBeenCalledTimes(2);
  });

  it("draws Still once, with no background animation loop", () => {
    render(<ProceduralAtmosphere palette={palette} motion="still" fragmentSource={fragmentSource} className="flux" />);
    expect(gl.drawArrays).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    advance(1000);
    expect(gl.drawArrays).toHaveBeenCalledOnce();
  });

  it("honours reduced motion at mount and when the system preference changes", () => {
    setMotion(true);
    render(<ProceduralAtmosphere palette={palette} motion="alive" fragmentSource={fragmentSource} className="nebula" />);
    expect(frames.size).toBe(0);
    act(() => setMotion(false));
    expect(frames.size).toBe(1);
    advance(10);
    advance(50);
    act(() => setMotion(true));
    expect(frames.size).toBe(0);
    const draws = gl.drawArrays.mock.calls.length;
    advance(2000);
    expect(gl.drawArrays).toHaveBeenCalledTimes(draws);
  });

  it("uses the static fallback during context loss and rebuilds after restoration", () => {
    const view = render(<ProceduralAtmosphere palette={palette} motion="calm" fragmentSource={fragmentSource} className="nova" />);
    const canvas = view.container.querySelector("canvas")!;
    act(() => { canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true })); });
    expect(view.container.firstChild).toHaveAttribute("data-atmosphere-state", "fallback");
    expect(frames.size).toBe(0);
    act(() => { canvas.dispatchEvent(new Event("webglcontextrestored")); });
    expect(view.container.firstChild).toHaveAttribute("data-atmosphere-state", "ready");
    expect(view.container.querySelectorAll("canvas")).toHaveLength(1);
    expect(view.container.querySelector("canvas")).not.toBe(canvas);
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });

  it("keeps a static backdrop and starts no animation if a shader cannot compile", () => {
    gl.getShaderParameter.mockReturnValue(false);
    const view = render(<ProceduralAtmosphere palette={palette} motion="alive" fragmentSource={fragmentSource} className="flux" />);
    expect(view.container.firstChild).toHaveAttribute("data-atmosphere-state", "fallback");
    expect(view.container.querySelector("canvas")).toBeNull();
    expect(frames.size).toBe(0);
    expect(gl.deleteProgram).toHaveBeenCalledOnce();
  });
});
