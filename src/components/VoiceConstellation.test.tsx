import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceConstellation, type VoiceConstellationProps } from "./VoiceConstellation";
import { VoiceOrbMotion } from "../lib/voiceOrbMotion";

let nextFrame: FrameRequestCallback | undefined;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(callback => { nextFrame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  const noop = () => undefined;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: noop, clearRect: noop, save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
    beginPath: noop, arc: noop, ellipse: noop, fill: noop, createRadialGradient: () => ({ addColorStop: noop }),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); nextFrame = undefined; });
function tick(time: number) { act(() => nextFrame?.(time)); }
function props(): VoiceConstellationProps {
  return { status: "listening", muted: false, activity: { inputActive: false, outputActive: false, measured: true, inputLevel: 0, outputLevel: 0, inputMeasured: true, outputMeasured: true, inputMuted: false },
    size: "expanded", onFocus: vi.fn(), onDismiss: vi.fn(), jobs: [
      { id: "working", revision: 1, subject: "Read the draft", prompt: "Read the draft", state: "running", progress: "Reading" },
      { id: "ready", revision: 1, subject: "Compare the notes", prompt: "Compare the notes", state: "completed", progress: "Ready", result: { reply: "A supported comparison." } },
    ] };
}
describe("live constellation controls", () => {
  it("announces queued, routing and clarification states without claiming research or opening a conversation", () => {
    const input = props(); input.jobs = [input.jobs[0]];
    const { rerender } = render(<VoiceConstellation {...input} />); tick(100);
    for (const [index, phase] of (["queued", "routing", "clarifying"] as const).entries()) {
      input.jobs = [{ ...input.jobs[0], phase }];
      rerender(<VoiceConstellation {...input} />); tick(150 + index * 50);
      const target = screen.getByRole("button", { name: /Read the draft\./ });
      expect(target).toHaveAccessibleName(phase === "queued" ? "Read the draft. Queued; waiting to begin research; drag out or press Delete to cancel" : phase === "routing" ? "Read the draft. Understanding request; research has not started; drag out or press Delete to cancel" : "Read the draft. Waiting for details; research has not started; drag out or press Delete to cancel");
      expect(target).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(target, { detail: 0 });
    }
    expect(input.onFocus).not.toHaveBeenCalled(); expect(input.onDismiss).not.toHaveBeenCalled();
    input.jobs = [{ ...input.jobs[0], phase: undefined }];
    rerender(<VoiceConstellation {...input} />); tick(350);
    expect(screen.getByRole("button", { name: /Read the draft\./ })).toHaveAccessibleName("Read the draft. Researching; drag out or press Delete to cancel");
  });
  it("releases a drag and hover when moving a retained scene between Chat and the floating pill", () => {
    const motion = new VoiceOrbMotion(), input = props();
    const release = vi.spyOn(motion, "releaseDrag"), point = vi.spyOn(motion, "point");
    const { unmount } = render(<VoiceConstellation {...input} motion={motion} />); tick(100);
    expect(motion.beginDrag("ready")).toBe(true);
    motion.point(.2, .15, true);
    unmount();
    expect(release).toHaveBeenLastCalledWith(true);
    expect(point).toHaveBeenLastCalledWith(0, 0, false);
    expect(input.onDismiss).not.toHaveBeenCalled();
    render(<VoiceConstellation {...input} motion={motion} />); tick(150);
    expect(screen.getByRole("button", { name: /Compare the notes/ })).toBeVisible();
    expect(input.onFocus).not.toHaveBeenCalled();
  });
  it("opens only completed worker conversations and provides a keyboard return to the centre", () => {
    const input = props(); render(<VoiceConstellation {...input} />); tick(100);
    const working = screen.getByRole("button", { name: /Read the draft/ });
    expect(working).toHaveAttribute("aria-disabled", "true"); fireEvent.click(working, { detail: 0 });
    expect(input.onFocus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Compare the notes/ }), { detail: 0 });
    expect(input.onFocus).toHaveBeenLastCalledWith("ready");
    fireEvent.click(screen.getByRole("button", { name: "Return to main voice conversation" }));
    expect(input.onFocus).toHaveBeenLastCalledWith(undefined);
  });
  it("delegates one keyboard dismissal without erasing results and makes the host dismissal visible", () => {
    const input = props(); const { rerender } = render(<VoiceConstellation {...input} />); tick(100);
    fireEvent.keyDown(screen.getByRole("button", { name: /Compare the notes/ }), { key: "Delete" });
    expect(input.onDismiss).toHaveBeenCalledExactlyOnceWith("ready");
    expect(input.jobs[1].result?.reply).toBe("A supported comparison.");
    rerender(<VoiceConstellation {...input} dismissedJobIds={["ready"]} />); tick(150);
    expect(screen.queryByRole("button", { name: /Compare the notes/ })).toBeNull();
    rerender(<VoiceConstellation {...input} dismissedJobIds={[]} focusedJobId="ready" />); tick(200);
    expect(screen.getByRole("button", { name: /Compare the notes/ })).toHaveAttribute("aria-pressed", "true");
  });
  it("keeps the sidebar decorative and exposes actual activity for runtime verification", () => {
    const input = props(); const { container, rerender, unmount } = render(<VoiceConstellation {...input} size="sidebar" />); tick(100);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img")).toHaveAccessibleName("Voice conversation");
    rerender(<VoiceConstellation {...input} size="sidebar" muted activity={{ ...input.activity, outputLevel: .67, outputActive: true, inputMuted: true }} />); tick(150);
    expect(container.firstElementChild).toHaveAttribute("data-output-level", "0.670");
    expect(screen.getByRole("img")).toHaveAccessibleName("Voice on, microphone muted");
    unmount(); expect(cancelAnimationFrame).toHaveBeenCalled();
  });
  it("renders ordinary larger groups and opens the named work list when targets become crowded", () => {
    const input = props(), onShowWorkers = vi.fn();
    input.jobs = Array.from({ length: 24 }, (_, index) => ({ ...input.jobs[0], id: `worker-${index}`, subject: `Research ${index}` }));
    const { container } = render(<VoiceConstellation {...input} onShowWorkers={onShowWorkers} />); tick(100);
    expect(container.firstElementChild).toHaveAttribute("data-worker-count", "24");
    expect(container.firstElementChild).toHaveAttribute("data-visible-worker-count", "24");
    expect(screen.getByRole("button", { name: /Research 23\./ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(screen.getByRole("button", { name: /Research 23\./ }), { detail: 0 });
    expect(input.onFocus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show all 24 workers" }));
    expect(onShowWorkers).toHaveBeenCalledOnce(); expect(input.onDismiss).not.toHaveBeenCalled();
  });
  it("bounds crowded targets while bringing any completed identity into view", () => {
    const input = props(), onShowWorkers = vi.fn();
    input.jobs = Array.from({ length: 120 }, (_, index) => ({ ...input.jobs[1], id: `worker-${index}`, subject: `Finished ${index}` }));
    const { container, rerender } = render(<VoiceConstellation {...input} onShowWorkers={onShowWorkers} />); tick(100);
    expect(container.firstElementChild).toHaveAttribute("data-worker-count", "120");
    expect(container.firstElementChild).toHaveAttribute("data-visible-worker-count", "48");
    expect(screen.queryByRole("button", { name: /Finished 119\./ })).toBeNull();
    expect(screen.getByRole("button", { name: "Show all 120 workers" })).toBeVisible();
    rerender(<VoiceConstellation {...input} focusedJobId="worker-119" onShowWorkers={onShowWorkers} />); tick(150);
    const late = screen.getByRole("button", { name: /Finished 119\./ });
    expect(late).toHaveAttribute("aria-pressed", "true");
    expect(late).toHaveAttribute("aria-disabled", "false");
    expect(late.style.transform).not.toMatch(/NaN|undefined/);
    fireEvent.keyDown(late, { key: "Delete" });
    expect(input.onDismiss).toHaveBeenCalledExactlyOnceWith("worker-119");
    expect(input.jobs[119].result?.reply).toBe("A supported comparison.");
  });
});
