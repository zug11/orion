import { describe, expect, it } from "vitest";
import { VoiceOrbMotion, VOICE_ORB_UPDATE_FLIGHT_SECONDS, VOICE_ORB_VISIBLE_BUDGET, projectVoiceOrbs, separateVoiceOrbs, type OrbJob, type VoiceOrbFrame } from "./voiceOrbMotion";

const quiet = { inputActive: false, outputActive: false, measured: true, inputLevel: 0, outputLevel: 0, inputMeasured: true, outputMeasured: true, inputMuted: false };
const job = (id: string, state: OrbJob["state"] = "running", sequence = 0): OrbJob => ({ id, revision: 1, state, updates: sequence ? [{ sequence }] : [], ...(state === "completed" ? { result: { reply: "Verified result" } } : {}) });
const frame = (overrides: Partial<VoiceOrbFrame> = {}): VoiceOrbFrame => ({ status: "listening", activity: quiet, muted: false, jobs: [], ...overrides });
function run(motion: VoiceOrbMotion, input: VoiceOrbFrame, seconds = 2) { for (let step = 0; step < seconds * 30; step++) motion.advance(input, 1 / 30); return motion.snapshot(); }

describe("live voice constellation motion", () => {
  it("starts with the approved four unequal reserves and 23 mixed-size volume beads", () => {
    const scene = new VoiceOrbMotion().snapshot();
    expect(scene.workers).toHaveLength(0); expect(scene.companions).toHaveLength(27);
    const angles = [-2.5, -.55, 1.2, 2.5], orbits = [.42, .28, .36, .255];
    for (let slot = 0; slot < 4; slot++) {
      expect(scene.companions.find(body => body.slot === slot)).toMatchObject({
        x: Math.cos(angles[slot]) * orbits[slot], y: Math.sin(angles[slot]) * orbits[slot] * .79, radius: .011,
      });
    }
    const ambient = scene.companions.filter(body => body.slot >= 4);
    expect(new Set(ambient.map(body => body.radius))).toEqual(new Set([.0045, .0066, .0087, .0108]));
    const distances = ambient.map(body => Math.hypot(body.x, body.y));
    expect(Math.max(...distances) - Math.min(...distances)).toBeGreaterThan(.20);
  });
  it("grows real jobs from existing beads and places the first three across the centre", () => {
    const motion = new VoiceOrbMotion(), idle = motion.snapshot();
    let scene = motion.advance(frame({ jobs: [job("a"), job("b"), job("c")] }), 0);
    for (const worker of scene.workers) {
      const reserve = idle.companions.find(body => body.slot === worker.slot)!;
      expect(worker).toMatchObject({ x: reserve.x, y: reserve.y, radius: reserve.radius });
      expect(scene.companions.some(body => body.slot === worker.slot)).toBe(false);
    }
    const jobs = Array.from({ length: 6 }, (_, index) => job(String(index)));
    scene = new VoiceOrbMotion().advance(frame({ jobs, reducedMotion: true }), 0);
    expect(scene.workers.map(body => body.orbit)).toEqual([.205, .285, .25, .225, .315, .36]);
    expect(scene.workers.map(body => body.radius)).toEqual(Array(6).fill(.039));
    expect(scene.workers.slice(0, 3).map(body => [Math.sign(body.x), Math.sign(body.y)])).toEqual([[-1, -1], [1, -1], [1, 1]]);
    expect(scene.workers.length + scene.companions.length).toBe(27);
    expect(new Set([...scene.workers, ...scene.companions].map(body => body.slot)).size).toBe(27);
    const steady = new VoiceOrbMotion(); steady.advance(frame({ jobs, reducedMotion: true }), 0);
    scene = steady.advance(frame({ jobs: jobs.map(item => ({ ...item, state: "completed", result: { reply: "Ready" } })), reducedMotion: true }), 0);
    expect(scene.workers.map(body => body.orbit)).toEqual([.245, .325, .29, .21, .35, .39]);
    expect(scene.workers.map(body => body.radius)).toEqual(Array(6).fill(.045));
  });
  it.each([20, 46, 300])("matches the approved centre and bounded dormant density at %i px", size => {
    const scene = new VoiceOrbMotion().snapshot(), projected = projectVoiceOrbs(scene, size, size);
    expect(projected.centre.y).toBe(size * .48);
    expect(projected.centre.radius).toBeCloseTo(size * (size < 80 ? .155 : .104));
    expect(projected.companions).toHaveLength(size === 20 ? 8 : size === 46 ? 12 : 27);
  });
  it("uses actual output/input envelopes and returns to the resting pose during silence", () => {
    const motion = new VoiceOrbMotion();
    let scene = run(motion, frame());
    expect(scene.central.stretch).toBe(1); expect(scene.central.level).toBe(0);
    scene = motion.advance(frame({ activity: { ...quiet, outputLevel: .8, outputActive: true } }), 1 / 30);
    expect(scene.central.stretch).toBeGreaterThan(1); expect(scene.central.level).toBe(.8);
    scene = motion.advance(frame({ activity: { ...quiet, inputLevel: .6, inputActive: true } }), 1 / 30);
    expect(scene.central.stretch).toBeLessThan(1); expect(scene.central.level).toBeCloseTo(.27);
    scene = motion.advance(frame(), 1 / 30);
    expect(scene.central.stretch).toBe(1); expect(scene.central.level).toBe(0);
  });
  it("keeps muted input still while output can speak, and sends that speech to the focused completed worker", () => {
    const motion = new VoiceOrbMotion(), activity = { ...quiet, inputLevel: 1, outputLevel: .7, inputActive: true, outputActive: true };
    const jobs = [job("research", "completed")];
    let scene = motion.advance(frame({ jobs, activity, muted: true, focusedJobId: "research" }), 1 / 30);
    expect(scene.central.level).toBe(0); expect(scene.workers[0].level).toBe(.7); expect(scene.workers[0].stretch).toBeGreaterThan(1);
    scene = motion.advance(frame({ jobs, activity: { ...quiet, inputLevel: .7 }, focusedJobId: "research" }), 1 / 30);
    expect(scene.central.level).toBe(0); expect(scene.workers[0].level).toBeCloseTo(.315); expect(scene.workers[0].stretch).toBeLessThan(1);
    scene = motion.advance(frame({ jobs, activity, muted: true, status: "disconnected" }), 1 / 30);
    expect(scene.central.level).toBe(0); expect(scene.workers[0].level).toBe(0);
  });
  it("sends one bead per new finding, acknowledges arrival, and gives completion its own cue", () => {
    const motion = new VoiceOrbMotion();
    run(motion, frame({ jobs: [job("a")] }));
    const updated = frame({ jobs: [job("a", "running", 1)] });
    let scene = motion.advance(updated, .03);
    expect(scene.packets).toHaveLength(1); expect(scene.central.receiving).toBe(0); expect(scene.workers[0].canFocus).toBe(false);
    scene = run(motion, updated, VOICE_ORB_UPDATE_FLIGHT_SECONDS + .2);
    expect(scene.packets).toHaveLength(0); expect(scene.central.receiving).toBeGreaterThan(0); expect(scene.receivingSlot).toBe(0);
    scene = motion.advance(frame({ jobs: [job("a", "completed", 1)] }), .03);
    expect(scene.workers[0].finished).toBeGreaterThan(.9); expect(scene.workers[0].canFocus).toBe(true);
    expect(scene.central.level).toBe(0); // A finding or completed job never invents speech.
    scene = run(motion, frame({ jobs: [job("a", "completed", 1)] }), 4);
    expect(scene.workers[0].finished).toBeLessThan(.01); expect(scene.packets).toHaveLength(0);
  });
  it("acknowledges a real arriving finding with a finite dip and rebound, without inventing speech", () => {
    const motion = new VoiceOrbMotion(); run(motion, frame({ jobs: [job("a")] }));
    const update = frame({ jobs: [job("a", "running", 1)] });
    motion.advance(update, 1 / 30);
    for (let count = 0; count < 60 && motion.snapshot().packets.length; count++) motion.advance(update, 1 / 30);
    const dip = run(motion, update, .10).central;
    expect(dip.stretch).toBeLessThan(.85);
    expect(Math.hypot(dip.x, dip.y)).toBeGreaterThan(.01);
    expect(Math.abs(dip.angle)).toBeGreaterThan(0);
    expect(dip.level).toBe(0);
    const rebound = run(motion, update, .23).central;
    expect(rebound.stretch).toBeGreaterThan(1); expect(rebound.level).toBe(0);
    const settled = run(motion, update, 1).central;
    expect(settled).toMatchObject({ x: 0, y: 0, stretch: 1, angle: 0, level: 0, receiving: 0 });
  });
  it.each(["disconnected", "reduced motion"])("clears receipt motion on %s without replaying it", mode => {
    const motion = new VoiceOrbMotion(); motion.advance(frame({ jobs: [job("a")] }), .03);
    const updated = frame({ jobs: [job("a", "running", 1)] });
    motion.advance(updated, .03); run(motion, updated, 1.3);
    expect(motion.snapshot().central.receiving).toBeGreaterThan(0);
    const stopped = motion.advance({ ...updated, ...(mode === "disconnected" ? { status: "disconnected" as const } : { reducedMotion: true }) }, .03);
    expect(stopped.central).toMatchObject({ x: 0, y: 0, receiving: 0, angle: 0, stretch: 1 });
    expect(run(motion, updated, 1).central.receiving).toBe(0);
  });
  it("advances a shared field once per frame timestamp and bounds a hidden-view gap", () => {
    const motion = new VoiceOrbMotion(), reference = new VoiceOrbMotion(), input = frame({ jobs: [job("a")] });
    motion.advanceAt(input, 100); reference.advanceAt(input, 100);
    const first = motion.advanceAt(input, 133); reference.advanceAt(input, 133);
    expect(motion.advanceAt(input, 133)).toEqual(first);
    expect(motion.advanceAt(input, 50_000)).toEqual(reference.advance(input, .06));
  });
  it("keeps identities stable as jobs reorder and never replays old findings after mounting or revising", () => {
    const motion = new VoiceOrbMotion();
    let scene = motion.advance(frame({ jobs: [job("a", "running", 4), job("b")] }), .03);
    const slots = Object.fromEntries(scene.workers.map(body => [body.id, body.slot]));
    expect(scene.packets).toHaveLength(0);
    scene = motion.advance(frame({ jobs: [job("b"), job("a", "running", 4)] }), .03);
    expect(Object.fromEntries(scene.workers.map(body => [body.id, body.slot]))).toEqual(slots);
    scene = motion.advance(frame({ jobs: [job("b"), { ...job("a", "running", 8), revision: 2 }] }), .03);
    expect(scene.packets).toHaveLength(0); expect(scene.workers.find(body => body.id === "a")?.revision).toBe(2);
  });
  it("retains completed findings when the host dismisses a worker and restores the same identity on focus", () => {
    const motion = new VoiceOrbMotion(), jobs = [job("a", "completed")];
    let scene = run(motion, frame({ jobs, dismissedJobIds: ["a"] }));
    expect(scene.workers[0]).toMatchObject({ id: "a", state: "completed", returned: true, canFocus: false });
    expect(jobs[0].result?.reply).toBe("Verified result");
    scene = run(motion, frame({ jobs, dismissedJobIds: [], focusedJobId: "a" }));
    expect(scene.workers[0]).toMatchObject({ id: "a", state: "completed", returned: false, canFocus: true });
  });
  it("restores a host-dismissed worker when bring-back and return-to-main happen before the next frame", () => {
    const motion = new VoiceOrbMotion(), jobs = [job("a", "completed")];
    const dismissed = run(motion, frame({ jobs, dismissedJobIds: ["a"] }));
    const original = dismissed.workers[0];
    // The model never sees the brief focused state between these UI actions.
    const restored = motion.advance(frame({ jobs, dismissedJobIds: [] }), 1 / 30).workers[0];
    expect(restored).toMatchObject({ id: "a", slot: original.slot, returned: false, canFocus: true });
    expect(restored.radius).toBeGreaterThan(original.radius);
    expect(restored.radius).toBeLessThan(.046); // Grow back rather than pop in.
    expect(jobs[0].result?.reply).toBe("Verified result");
  });
  it("keeps explicit host dismissals and cancelled jobs returned despite a stale focused ID", () => {
    const motion = new VoiceOrbMotion();
    let scene = motion.advance(frame({ jobs: [job("a", "completed")], dismissedJobIds: ["a"], focusedJobId: "a" }), 1 / 30);
    expect(scene.workers[0]).toMatchObject({ returned: true, canFocus: false });
    scene = motion.advance(frame({ jobs: [job("a", "cancelled")], dismissedJobIds: [], focusedJobId: "a" }), 1 / 30);
    expect(scene.workers[0]).toMatchObject({ returned: true, canFocus: false });
  });
  it("retains every worker and keeps an explicitly focused older result in small projections", () => {
    const motion = new VoiceOrbMotion(), jobs = [job("older", "completed"), ...Array.from({ length: 9 }, (_, index) => job(`newer-${index}`, "completed"))];
    const scene = motion.advance(frame({ jobs, focusedJobId: "older", activity: { ...quiet, outputLevel: .6 } }), .03);
    expect(scene.workers).toHaveLength(10);
    expect(scene.workers.find(body => body.id === "older")).toMatchObject({ level: .6, canFocus: true });
    expect(projectVoiceOrbs(scene, 20, 20).workers.some(point => point.slot === scene.focusedSlot)).toBe(true);
  });
  it.each([12, 24, 60, 120])("retains %i worker identities with finite, distinct slots through reordering and focus", count => {
    const motion = new VoiceOrbMotion(), jobs = Array.from({ length: count }, (_, index) => job(`worker-${index}`, "completed"));
    const scene = motion.advance(frame({ jobs, reducedMotion: true }), 0);
    expect(scene.workers).toHaveLength(count);
    expect(new Set(scene.workers.map(body => body.slot)).size).toBe(count);
    const original = new Map(scene.workers.map(body => [body.id, body.slot]));
    const focused = jobs[count - 1].id;
    const reordered = motion.advance(frame({ jobs: jobs.slice().reverse(), focusedJobId: focused, reducedMotion: true }), 0);
    for (const body of reordered.workers) {
      expect(body.slot).toBe(original.get(body.id));
      expect([body.x, body.y, body.radius, body.orbit].every(Number.isFinite)).toBe(true);
    }
    for (const size of [20, 46, 84, 210, 300]) {
      const projection = projectVoiceOrbs(reordered, size, size);
      expect(projection.workers.length).toBeLessThanOrEqual(VOICE_ORB_VISIBLE_BUDGET);
      if (count <= 24 && size >= 84) expect(projection.workers).toHaveLength(count);
      expect(projection.workers.some(point => point.slot === original.get(focused))).toBe(true);
      const circles = [projection.centreBounds, ...projection.workerBounds, ...projection.companions];
      for (const circle of circles) {
        expect(circle.x - circle.radius).toBeGreaterThanOrEqual(-.001);
        expect(circle.y - circle.radius).toBeGreaterThanOrEqual(-.001);
        expect(circle.x + circle.radius).toBeLessThanOrEqual(size + .001);
        expect(circle.y + circle.radius).toBeLessThanOrEqual(size + .001);
      }
      for (let a = 0; a < circles.length; a++) for (let b = a + 1; b < circles.length; b++) {
        expect(Math.hypot(circles[a].x - circles[b].x, circles[a].y - circles[b].y)).toBeGreaterThanOrEqual(circles[a].radius + circles[b].radius - .002);
      }
    }
  });
  it("dismisses and restores a worker beyond the original reserves without losing its result", () => {
    const motion = new VoiceOrbMotion(), jobs = Array.from({ length: 40 }, (_, index) => job(String(index), "completed"));
    const initial = run(motion, frame({ jobs }), 1), original = initial.workers[35];
    expect(motion.beginDrag(original.id)).toBe(true);
    motion.moveDrag(.44, .08); motion.advance(frame({ jobs }), .03);
    expect(motion.releaseDrag()).toBe(original.id);
    const returned = run(motion, frame({ jobs, dismissedJobIds: [original.id] }), 2).workers[35];
    expect(returned.returned).toBe(true); expect(returned.radius).toBeLessThan(original.radius);
    const restored = run(motion, frame({ jobs, dismissedJobIds: [], focusedJobId: original.id }), 2);
    expect(restored.workers[35]).toMatchObject({ id: original.id, slot: original.slot, returned: false, canFocus: true });
    expect(jobs[35].result?.reply).toBe("Verified result");
  });
  it("shrinks a dismissed body visibly into the small companions and restores it for a completed conversation", () => {
    const motion = new VoiceOrbMotion(), input = frame({ jobs: [job("a", "completed"), job("b")] });
    const original = run(motion, input).workers.find(body => body.id === "a")!;
    expect(motion.beginDrag("a")).toBe(true); motion.moveDrag(.43, .06); motion.advance(input, .03);
    expect(motion.releaseDrag()).toBe("a");
    let scene = motion.advance(input, .03), body = scene.workers.find(body => body.id === "a")!;
    expect(body.returned).toBe(true); expect(body.radius).toBeLessThan(original.radius); expect(body.radius).toBeGreaterThan(.009);
    scene = run(motion, input, 4); body = scene.workers.find(body => body.id === "a")!;
    expect(body.radius).toBeCloseTo(.009, 3); expect(body.canFocus).toBe(false); expect(scene.workers).toHaveLength(2);
    scene = run(motion, { ...input, focusedJobId: "a" }, 2);
    expect(scene.workers.find(body => body.id === "a")?.radius).toBeGreaterThan(.04);
    expect(scene.workers.find(body => body.id === "a")?.canFocus).toBe(true);
  });
  it("keeps small bodies clear of the six larger bodies through sustained audio, growth and restoration", () => {
    const motion = new VoiceOrbMotion();
    for (let step = 0; step < 900; step++) {
      const jobs = Array.from({ length: 6 }, (_, index) => job(String(index), step > 120 ? "completed" : "running"));
      if (step === 180) motion.dismiss("1");
      const scene = motion.advance(frame({ jobs, activity: { ...quiet, outputLevel: step % 60 < 30 ? .75 : 0 }, focusedJobId: step > 300 ? "1" : undefined }), 1 / 30);
      for (const companion of scene.companions) {
        expect(Number.isFinite(companion.x + companion.y)).toBe(true);
        const centralOutline = scene.central.radius * Math.max(Math.sqrt(scene.central.stretch), 1 / Math.sqrt(scene.central.stretch));
        expect(Math.hypot(companion.x - scene.central.x, companion.y - scene.central.y)).toBeGreaterThanOrEqual(companion.radius + centralOutline + .01);
        for (const worker of scene.workers) expect(Math.hypot(companion.x - worker.x, companion.y - worker.y)).toBeGreaterThanOrEqual(companion.radius + worker.radius - .0001);
      }
    }
  });
  it("reserves a stable speaking envelope so syllables cannot kick the companions around", () => {
    const silent = new VoiceOrbMotion(), speaking = new VoiceOrbMotion(), jobs = [job("a", "completed"), job("b")];
    for (let step = 0; step < 300; step++) {
      const a = silent.advance(frame({ jobs }), 1 / 30);
      const b = speaking.advance(frame({ jobs, activity: { ...quiet, inputLevel: step % 8 / 8, outputLevel: step % 13 / 13 } }), 1 / 30);
      expect(b.companions).toEqual(a.companions);
      expect(b.workers.map(body => [body.x, body.y])).toEqual(a.workers.map(body => [body.x, body.y]));
    }
  });
  it("uses exact stable reduced-motion poses and caps offscreen elapsed time", () => {
    const motion = new VoiceOrbMotion(), input = frame({ jobs: [job("a"), job("b")], reducedMotion: true, activity: { ...quiet, outputLevel: .8 } });
    motion.advance(input, .03); const initial = motion.snapshot();
    expect(run(motion, input, 10)).toEqual(initial);
    const a = new VoiceOrbMotion(), b = new VoiceOrbMotion();
    a.advance(frame(), 600); b.advance(frame(), .06);
    expect(a.snapshot()).toEqual(b.snapshot());
  });
  it.each([20, 46, 300])("keeps visible silhouettes clear at %i pixels through speech and arrivals", size => {
    const motion = new VoiceOrbMotion();
    for (let step = 0; step < 180; step++) {
      const jobs = Array.from({ length: 6 }, (_, index) => job(String(index), step > 60 ? "completed" : "running", step > 30 ? 1 : 0));
      const scene = motion.advance(frame({ jobs, activity: { ...quiet, inputLevel: .7, outputLevel: step % 60 < 30 ? .8 : 0 } }), 1 / 30);
      const before = motion.snapshot(), projected = projectVoiceOrbs(scene, size, size);
      expect(motion.snapshot()).toEqual(before);
      for (const companion of projected.companions) {
        for (const large of [projected.centreBounds, ...projected.workerBounds]) expect(Math.hypot(companion.x - large.x, companion.y - large.y)).toBeGreaterThanOrEqual(companion.radius + large.radius - .001);
      }
    }
  });
  it("resolves pixel-sized collisions without changing source geometry", () => {
    const source = [{ x: 7, y: 7, radius: 2.2, slot: 0 }, { x: 7, y: 7, radius: 2.2, slot: 1 }];
    const projection = structuredClone(source), centre = { x: 10, y: 10, radius: 3, slot: -1 };
    separateVoiceOrbs(projection, [centre], .35);
    expect(Math.hypot(projection[0].x - projection[1].x, projection[0].y - projection[1].y)).toBeGreaterThanOrEqual(4.74);
    expect(source[0]).toEqual({ x: 7, y: 7, radius: 2.2, slot: 0 });
  });
});
