import type { VoiceActivity, VoiceStatus } from "./liveVoice";
import type { VoiceWorkOrder } from "./voiceResearch";

export type OrbJob = Pick<VoiceWorkOrder, "id" | "revision" | "state" | "result"> & { updates?: readonly { sequence: number }[] };
export interface OrbCircle { x: number; y: number; radius: number; slot: number }
export interface VoiceOrbBody extends OrbCircle {
  id: string; revision: number; state: VoiceWorkOrder["state"]; returned: boolean;
  angle: number; orbit: number; sequence: number; finished: number; level: number; stretch: number;
  canFocus: boolean;
}
interface Companion extends OrbCircle { vx: number; vy: number; ax: number; ay: number; rest: number }
export interface VoiceOrbPacket { slot: number; age: number }
export interface VoiceOrbSnapshot {
  phase: number; central: OrbCircle & { level: number; stretch: number; receiving: number; angle: number };
  workers: VoiceOrbBody[]; companions: OrbCircle[]; packets: VoiceOrbPacket[];
  receivingSlot: number;
  focusedSlot?: number;
}
export interface VoiceOrbFrame {
  status: VoiceStatus; activity: VoiceActivity; muted: boolean; jobs: readonly OrbJob[];
  focusedJobId?: string; dismissedJobIds?: readonly string[]; reducedMotion?: boolean; thinking?: boolean;
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const settle = (value: number, target: number, delta: number, rate = 5) => value + (target - value) * (1 - Math.exp(-delta * rate));
// First four positions, relative sizes and depth match the approved gravity
// study. Extra work orders take two ambient beads, not a denser resting field.
const START_ANGLES = [-2.5, -.55, 1.2, 2.5, -1.5, .35];
const IDLE_ORBITS = [.42, .28, .36, .255, .34, .38];
const WORKING_ORBITS = [.205, .285, .25, .225, .315, .36];
const READY_ORBITS = [.245, .325, .29, .21, .35, .39];
const RETURNED_ORBITS = [.285, .405, .345, .43, .37, .32];
const FLATTEN = .79;
const GRAVITY = .00003;
export const VOICE_ORB_UPDATE_FLIGHT_SECONDS = 1.2;
/** A paint/physics budget, never a limit on admitted jobs or retained identities. */
export const VOICE_ORB_VISIBLE_BUDGET = 48;
const fract = (value: number) => value - Math.floor(value);
const startAngle = (slot: number) => START_ANGLES[slot] ?? slot * 2.39996 - 2.5;
const orbitFor = (values: readonly number[], slot: number) => values[slot] ?? .25 + fract(slot * .618034) * .17;
function displayedWorkers(workers: readonly VoiceOrbBody[], count: number, focusedSlot?: number) {
  if (workers.length <= count) return [...workers];
  const focused = workers.find(body => body.slot === focusedSlot);
  return [...(focused ? [focused] : []), ...workers.filter(body => body !== focused && !body.returned && body.state === "running"),
    ...workers.filter(body => body !== focused && !body.returned && body.state !== "running"),
    ...workers.filter(body => body !== focused && body.returned)].slice(0, count);
}
const ease = (value: number) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
function receiptGesture(age: number) {
  if (age < 0 || age >= .9) return 0;
  if (age < .10) return ease(age / .10);
  if (age < .30) return 1 - 1.24 * ease((age - .10) / .20);
  return -.24 * Math.cos((age - .30) * Math.PI * 3) * Math.pow(1 - (age - .30) / .6, 2);
}
function companion(x: number, y: number, radius: number, slot: number): Companion {
  const rest = Math.max(.16, Math.hypot(x, y)), speed = Math.sqrt(GRAVITY / rest);
  return { x, y, radius, slot, rest, vx: -y / rest * speed, vy: x / rest * speed, ax: 0, ay: 0 };
}

/** Circle contact is also applied to each pixel-sized projection, where minimum
 * readable radii differ. Larger bodies never make small ones disappear. */
export function separateVoiceOrbs(circles: OrbCircle[], fixed: readonly OrbCircle[], gap: number, heldSlot?: number) {
  for (let pass = 0; pass < 20; pass++) {
    for (let i = 0; i < circles.length; i++) for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i], b = circles[j], dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
      const minimum = a.radius + b.radius + gap;
      if (distance >= minimum) continue;
      const angle = (a.slot + b.slot) * 2.39996, nx = distance ? dx / distance : Math.cos(angle), ny = distance ? dy / distance : Math.sin(angle);
      const share = a.slot === heldSlot ? 0 : b.slot === heldSlot ? 1 : .5;
      a.x -= nx * (minimum - distance) * share; a.y -= ny * (minimum - distance) * share;
      b.x += nx * (minimum - distance) * (1 - share); b.y += ny * (minimum - distance) * (1 - share);
    }
    for (const circle of circles) for (const obstacle of fixed) {
      if (circle.slot === heldSlot) continue;
      const dx = circle.x - obstacle.x, dy = circle.y - obstacle.y, distance = Math.hypot(dx, dy), minimum = circle.radius + obstacle.radius + gap;
      if (distance >= minimum) continue;
      const angle = circle.slot * 2.39996;
      circle.x = obstacle.x + (distance ? dx / distance : Math.cos(angle)) * minimum;
      circle.y = obstacle.y + (distance ? dy / distance : Math.sin(angle)) * minimum;
    }
  }
}

/** All actual sizes use the same motion snapshot. Pixel floors are followed by
 * contact projection so the legible small circles cannot overlap larger ones. */
export function projectVoiceOrbs(scene: VoiceOrbSnapshot, width: number, height: number) {
  const scale = Math.min(width, height), small = scale < 80, sidebar = scale < 30;
  const outline = (stretch: number) => Math.max(Math.sqrt(stretch), 1 / Math.sqrt(stretch));
  const originX = width / 2, originY = height * .48;
  const project = (body: OrbCircle, minimum: number, ambient = false): OrbCircle => {
    const distance = Math.max(.001, Math.hypot(body.x, body.y));
    const spread = small ? ((ambient ? .245 : .255) + Math.max(0, distance - (ambient ? .14 : .16)) * .65) / distance : 1;
    return { slot: body.slot, x: originX + body.x * spread * scale, y: originY + body.y * spread * scale, radius: Math.max(minimum, body.radius * scale) };
  };
  const centre = { x: originX + scene.central.x * scale, y: originY + scene.central.y * scale, radius: scale * (small ? .155 : .104) * (1 + scene.central.receiving * .055), slot: -1 };
  const budget = sidebar ? 6 : small ? 10 : Math.min(VOICE_ORB_VISIBLE_BUDGET, Math.max(8, Math.floor(scale / 14) ** 2));
  const bodies = displayedWorkers(scene.workers, budget, scene.focusedSlot);
  const workers = bodies.map(body => {
    const depth = 1 + Math.sin(body.angle) * .12;
    const point = project({ ...body, radius: body.radius * depth }, body.returned ? (sidebar ? .65 : small ? .8 : .9) : sidebar ? 1.3 : small ? 2.5 : 0);
    point.radius *= 1 + body.finished * .1 + body.level * .035; return point;
  });
  const workerBounds = workers.map((point, index) => ({ ...point, radius: point.radius * outline(bodies[index].stretch) }));
  const centreBounds = { ...centre, radius: centre.radius * outline(scene.central.stretch) };
  separateVoiceOrbs(workerBounds, [centreBounds], Math.max(.45, scale * .008));
  workerBounds.forEach((point, index) => { workers[index].x = point.x; workers[index].y = point.y; });
  const reserves = scene.companions.filter(body => body.slot < 4);
  const ambientLimit = small ? Math.max(0, (sidebar ? 8 : 12) - reserves.length - workers.length) : Infinity;
  const ambient = scene.companions.filter(body => body.slot >= 4).slice(0, ambientLimit);
  const companions = [...reserves, ...ambient].map(body => project(body,
    body.slot < 4 ? (sidebar ? .7 : small ? 1 : 0) : sidebar ? .65 : small ? .8 : 0, body.slot >= 4));
  separateVoiceOrbs(companions, [centreBounds, ...workerBounds], small ? .3 : scale * .007);
  let fit = 1;
  if (scene.workers.length > 6) {
    // Contact resolution may expand a crowded projection. Fit the complete
    // silhouettes together instead of clipping workers at the canvas edge.
    const circles = [centreBounds, ...workerBounds, ...companions];
    const extent = Math.max(...circles.map(point => Math.max(Math.abs(point.x - originX) + point.radius, Math.abs(point.y - originY) + point.radius)));
    fit = Math.min(1, scale * .46 / Math.max(.001, extent));
    for (const point of [centre, ...workers, ...companions, centreBounds, ...workerBounds]) {
      point.x = originX + (point.x - originX) * fit; point.y = originY + (point.y - originY) * fit; point.radius *= fit;
    }
  }
  return { centre, workers, companions, centreBounds, workerBounds, fit };
}

/** Stateful, deterministic geometry. Only real local audio energy drives the
 * speaking pose; progress/receipts animate independently and never invent speech. */
export class VoiceOrbMotion {
  private phase = 0;
  private central = { x: 0, y: 0, radius: .104, slot: -1, level: 0, stretch: 1, receiving: 0, angle: 0 };
  private centralRest = { x: 0, y: 0 };
  private workers: VoiceOrbBody[] = [];
  private packets: VoiceOrbPacket[] = [];
  private receipts: Array<{ slot: number; age: number; dx: number; dy: number }> = [];
  private receivingSlot = -1;
  private focusedSlot?: number;
  private frameAt?: number;
  private pointer = { x: 0, y: 0, inside: false };
  private drag?: { id: string; x: number; y: number; startX: number; startY: number };
  private companions: Companion[] = [
    ...START_ANGLES.slice(0, 4).map((angle, slot) => companion(Math.cos(angle) * IDLE_ORBITS[slot], Math.sin(angle) * IDLE_ORBITS[slot] * FLATTEN, .011, slot)),
    ...Array.from({ length: 23 }, (_, index) => {
      const angle = index * 2.39996 + .24 * Math.sin(index * 1.7), orbit = .19 + fract(index * .618034 + .37) * .245;
      const flatten = .74 + fract(index * .41421) * .15;
      return companion(Math.cos(angle) * orbit, Math.sin(angle) * orbit * flatten, .0045 + index % 4 * .0021, index + 4);
    }),
  ];
  private companionSlots = new Map(this.companions.map(body => [body.slot, body]));
  private freeCompanions() {
    const occupied = new Set(this.workers.map(worker => worker.slot));
    return this.companions.filter(body => !occupied.has(body.slot));
  }

  private reserve(slot: number) {
    let body = this.companionSlots.get(slot);
    if (!body) {
      const angle = startAngle(slot), orbit = orbitFor(IDLE_ORBITS, slot);
      body = companion(Math.cos(angle) * orbit, Math.sin(angle) * orbit * FLATTEN, .009, slot);
      this.companions.push(body);
      this.companionSlots.set(slot, body);
    }
    return body;
  }

  point(x: number, y: number, inside: boolean) { this.pointer = { x, y, inside }; }
  beginDrag(id: string) {
    const body = this.workers.find(worker => worker.id === id && !worker.returned);
    if (!body) return false;
    this.drag = { id, x: body.x, y: body.y, startX: body.x, startY: body.y }; return true;
  }
  moveDrag(x: number, y: number) { if (this.drag) { this.drag.x = clamp(x, -.47, .47); this.drag.y = clamp(y, -.47, .47); } }
  releaseDrag(cancel = false) {
    const drag = this.drag; this.drag = undefined;
    if (!drag || cancel) return undefined;
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < .045 || Math.hypot(drag.x, drag.y / .8) < .335) return undefined;
    this.dismiss(drag.id); return drag.id;
  }
  dismiss(id: string) {
    const body = this.workers.find(worker => worker.id === id);
    if (body) { body.returned = true; body.canFocus = false; body.orbit = orbitFor(RETURNED_ORBITS, body.slot); }
    this.packets = this.packets.filter(packet => this.workers.find(worker => worker.slot === packet.slot)?.id !== id);
  }

  /** Visible projections sharing one field get exactly one step per RAF stamp. */
  advanceAt(frame: VoiceOrbFrame, timestamp: number): VoiceOrbSnapshot {
    if (!Number.isFinite(timestamp) || timestamp === this.frameAt) return this.snapshot();
    const delta = this.frameAt === undefined ? 0 : Math.max(0, (timestamp - this.frameAt) / 1000);
    this.frameAt = timestamp;
    return this.advance(frame, delta);
  }

  advance(frame: VoiceOrbFrame, elapsed: number): VoiceOrbSnapshot {
    const delta = clamp(elapsed, 0, .06), reduced = frame.reducedMotion === true;
    const talking = frame.status === "listening";
    const moving = !reduced && (talking || frame.status === "connecting" || frame.thinking || frame.jobs.some(job => job.state === "running"));
    if (moving) this.phase += delta;
    // Admission is independent of rendering density. Existing slots survive
    // reordering, queuing, completion and focus; every admitted ID stays here.
    const wanted = [...new Map(frame.jobs.map(job => [job.id, job])).values()];
    const present = new Set(wanted.map(job => job.id));
    for (const removed of this.workers.filter(worker => !present.has(worker.id))) {
      // Release its physical place back to the reserve field, never duplicate it.
      const reserve = this.reserve(removed.slot);
      reserve.x = removed.x; reserve.y = removed.y; reserve.rest = Math.max(.16, Math.hypot(removed.x, removed.y));
    }
    this.workers = this.workers.filter(worker => present.has(worker.id));
    const occupied = new Set(this.workers.map(worker => worker.slot));
    this.companions = this.companions.filter(body => body.slot < 27 || occupied.has(body.slot));
    this.companionSlots = new Map(this.companions.map(body => [body.slot, body]));
    const byId = new Map(this.workers.map(body => [body.id, body]));
    const density = Math.sqrt(6 / Math.max(6, Math.min(VOICE_ORB_VISIBLE_BUDGET, wanted.length)));
    let nextSlot = 0;
    for (const job of wanted) {
      let body = byId.get(job.id);
      const sequence = Math.max(0, ...(job.updates?.map(update => update.sequence) ?? []));
      if (!body) {
        while (occupied.has(nextSlot)) nextSlot++;
        const slot = nextSlot++; occupied.add(slot);
        const reserve = this.reserve(slot);
        const angle = slot < 4 ? Math.atan2(reserve.y / FLATTEN, reserve.x) : startAngle(slot);
        const orbit = Math.hypot(reserve.x, reserve.y / FLATTEN);
        body = { id: job.id, revision: job.revision, state: job.state, returned: false, angle, orbit, slot,
          x: reserve.x, y: reserve.y, radius: reserve.radius, sequence,
          finished: 0, level: 0, stretch: 1, canFocus: false };
        this.workers.push(body);
        byId.set(job.id, body);
      } else if (body.revision !== job.revision) {
        body.revision = job.revision; body.returned = false; body.sequence = sequence; body.finished = 0;
        this.packets = this.packets.filter(packet => packet.slot !== body!.slot);
      } else if (sequence > body.sequence) {
        if (!body.returned && talking && !reduced) this.packets.push({ slot: body.slot, age: 0 });
        body.sequence = sequence;
      }
      if (body.state !== "completed" && job.state === "completed") body.finished = 1;
      if (job.state === "cancelled" || frame.dismissedJobIds?.includes(job.id)) {
        if (!body.returned) this.dismiss(body.id);
      } else if (frame.dismissedJobIds !== undefined || frame.focusedJobId === job.id && job.state === "completed") {
        // Host-owned dismissal is authoritative even when focus changes twice
        // between frames. Without it, retain direct model/drag dismissals.
        body.returned = false;
      }
      body.state = job.state;
      body.canFocus = job.state === "completed" && Boolean(job.result) && !body.returned;
      const orbit = orbitFor(body.returned ? RETURNED_ORBITS : job.state === "running" ? WORKING_ORBITS : job.state === "completed" ? READY_ORBITS : IDLE_ORBITS, body.slot);
      const radius = (body.returned ? .009 : job.state === "running" ? .039 : job.state === "completed" ? .045 : .024) * density;
      if (reduced) body.angle = startAngle(body.slot);
      else if (moving && !this.pointer.inside && this.drag?.id !== body.id) body.angle += delta * (body.returned ? .032 : .085);
      body.orbit = reduced ? orbit : settle(body.orbit, orbit, delta, 1.5);
      body.radius = reduced ? radius : settle(body.radius, radius, delta, 2);
      const drift = moving ? Math.sin(this.phase * .75 + body.slot * 2) * .003 : 0;
      const targetX = Math.cos(body.angle) * body.orbit, targetY = Math.sin(body.angle) * body.orbit * FLATTEN + drift;
      body.x = reduced ? targetX : settle(body.x, targetX, delta, 6);
      body.y = reduced ? targetY : settle(body.y, targetY, delta, 6);
      if (this.drag?.id === body.id) { body.x = this.drag.x; body.y = this.drag.y; body.angle = Math.atan2(body.y / FLATTEN, body.x); }
      body.finished = reduced ? 0 : settle(body.finished, 0, delta, 1.8);
      const workerOutput = talking && frame.focusedJobId === body.id ? frame.activity.outputLevel ?? 0 : 0;
      const workerInput = talking && frame.focusedJobId === body.id && !frame.muted ? frame.activity.inputLevel ?? 0 : 0;
      body.level = Math.max(workerOutput, workerInput * .45);
      body.stretch = reduced ? 1 : 1 + workerOutput * .14 - workerInput * .035;
    }
    this.focusedSlot = this.workers.find(body => body.id === frame.focusedJobId)?.slot;
    // Never restart a phrase on palette changes, job updates, or input activity.
    const input = talking && !frame.muted && !frame.focusedJobId ? frame.activity.inputLevel ?? 0 : 0;
    const output = talking && !frame.focusedJobId ? frame.activity.outputLevel ?? 0 : 0;
    this.central.level = clamp(Math.max(input * .45, output), 0, 1);
    this.central.stretch = reduced ? 1 : 1 + output * .14 - input * .035;
    this.centralRest.x = reduced ? 0 : settle(this.centralRest.x, this.pointer.inside ? this.pointer.x * .011 : 0, delta);
    this.centralRest.y = reduced ? 0 : settle(this.centralRest.y, (this.pointer.inside ? this.pointer.y * .009 : 0) - output * .009, delta);
    this.central.x = this.centralRest.x; this.central.y = this.centralRest.y;
    this.central.receiving = 0; this.central.angle = 0; this.receivingSlot = -1;
    if (!talking || reduced) { this.packets = []; this.receipts = []; }
    else {
      this.receipts = this.receipts.map(receipt => ({ ...receipt, age: receipt.age + delta })).filter(receipt => receipt.age < .9);
      this.packets = this.packets.filter(packet => {
        packet.age += delta;
        if (packet.age < VOICE_ORB_UPDATE_FLIGHT_SECONDS) return true;
        const worker = this.workers.find(body => body.slot === packet.slot);
        if (worker) this.receipts.push({ slot: packet.slot, age: 0, dx: Math.cos(worker.angle), dy: Math.sin(worker.angle) });
        return false;
      });
      this.receipts = this.receipts.slice(-4);
      for (const receipt of this.receipts) {
        const gesture = receiptGesture(receipt.age);
        this.central.x += receipt.dx * gesture * .013; this.central.y += receipt.dy * gesture * .013;
        this.central.stretch -= gesture * .23; this.central.angle += receipt.dx * gesture * .12;
        const glow = receipt.age < .16 ? ease(receipt.age / .16) : 1 - ease((receipt.age - .16) / .74);
        this.central.receiving = Math.max(this.central.receiving, glow); this.receivingSlot = receipt.slot;
      }
      this.central.x = clamp(this.central.x, -.018, .018); this.central.y = clamp(this.central.y, -.024, .024);
      this.central.stretch = clamp(this.central.stretch, .76, 1.25); this.central.angle = clamp(this.central.angle, -.22, .22);
    }
    // Reserve each whole gesture's envelope. Syllable-level deformation must not
    // repeatedly kick surrounding companions or change worker orbit positions.
    const visible = displayedWorkers(this.workers, VOICE_ORB_VISIBLE_BUDGET, this.focusedSlot);
    const active = visible.map(body => ({ ...body, radius: body.radius * 1.5 + .009 * density }));
    const centreEnvelope = { x: 0, y: 0, radius: .132, slot: -1 };
    separateVoiceOrbs(active, [centreEnvelope], .012 * density, this.workers.find(worker => worker.id === this.drag?.id)?.slot);
    for (const circle of active) {
      const body = byId.get(circle.id)!;
      if (Math.hypot(body.x - circle.x, body.y - circle.y) > .000001 && !reduced && this.drag?.id !== body.id) body.angle = Math.atan2(circle.y / FLATTEN, circle.x);
      body.x = circle.x; body.y = circle.y;
    }
    if (moving) this.advanceCompanions(delta, visible.map(body => ({ ...body, radius: body.radius * 1.12 * 1.22 * 1.25 + .024 * density })));
    return this.snapshot();
  }

  private advanceCompanions(delta: number, workers: OrbCircle[]) {
    const particles = this.freeCompanions();
    const obstacles = [{ x: 0, y: 0, radius: .15, slot: -1 }, ...workers];
    // Same bounded substeps and force inertia as the approved calm swarm.
    const steps = Math.max(1, Math.ceil(delta / (1 / 60))), stepDelta = delta / steps;
    for (let step = 0; step < steps; step++) {
      for (const body of particles) {
        const distance = Math.max(.05, Math.hypot(body.x, body.y)), nx = body.x / distance, ny = body.y / distance;
        const speed = Math.sqrt(GRAVITY / distance), radialVelocity = body.vx * nx + body.vy * ny;
        const radial = GRAVITY / (distance * distance + .0016) + (distance - body.rest) * .035 + radialVelocity * .8;
        let ax = -nx * radial + (-ny * speed - body.vx) * .85;
        let ay = -ny * radial + (nx * speed - body.vy) * .85;
        for (const worker of workers) {
          const dx = worker.x - body.x, dy = worker.y - body.y, d = Math.max(.001, Math.hypot(dx, dy));
          const clearance = worker.radius + body.radius + .009;
          const pressure = Math.max(0, (clearance + .080 - d) / .080);
          const force = .000025 * Math.min(1, worker.radius / .05) / (d * d + .0064) - .022 * pressure * pressure;
          ax += dx / d * force; ay += dy / d * force;
        }
        for (const other of particles) {
          if (body === other) continue;
          const dx = body.x - other.x, dy = body.y - other.y, d = Math.max(.001, Math.hypot(dx, dy));
          const pressure = Math.max(0, 1 - (d - body.radius - other.radius - .007) / .028);
          ax += dx / d * .012 * pressure * pressure; ay += dy / d * .012 * pressure * pressure;
        }
        const response = 1 - Math.exp(-stepDelta / .45);
        body.ax += (ax - body.ax) * response; body.ay += (ay - body.ay) * response;
        body.vx += body.ax * stepDelta; body.vy += body.ay * stepDelta;
        const velocity = Math.hypot(body.vx, body.vy);
        if (velocity > .045) { body.vx *= .045 / velocity; body.vy *= .045 / velocity; }
        body.x += body.vx * stepDelta; body.y += body.vy * stepDelta;
      }
      separateVoiceOrbs(particles, obstacles, .007);
      for (const body of particles) {
        for (const obstacle of obstacles) {
          const dx = body.x - obstacle.x, dy = body.y - obstacle.y, distance = Math.max(.001, Math.hypot(dx, dy));
          if (distance > body.radius + obstacle.radius + .009) continue;
          const inward = (body.vx * dx + body.vy * dy) / distance;
          if (inward < 0) { body.vx -= dx / distance * inward; body.vy -= dy / distance * inward; }
        }
        const distance = Math.hypot(body.x, body.y);
        if (distance > .46) {
          const nx = body.x / distance, ny = body.y / distance, outward = body.vx * nx + body.vy * ny;
          body.x = nx * .46; body.y = ny * .46;
          if (outward > 0) { body.vx -= nx * outward; body.vy -= ny * outward; }
        }
      }
      separateVoiceOrbs(particles, obstacles, .007);
    }
  }

  snapshot(): VoiceOrbSnapshot {
    return { phase: this.phase, central: { ...this.central }, workers: this.workers.map(body => ({ ...body })),
      companions: this.freeCompanions().map(({ x, y, radius, slot }) => ({ x, y, radius, slot })), packets: this.packets.map(packet => ({ ...packet })), receivingSlot: this.receivingSlot, focusedSlot: this.focusedSlot };
  }
}
