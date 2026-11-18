import { Mat3, Quat, Vec3 } from "ogl";

const DAMPING = 3;
const MAX_SPEED = 6;
const POINTER_GAIN = .85;
const INTERIOR_SPEED = .55;

/** Transforms from view space to the two independently rotating materials. */
export class VoiceOrbRotation {
  readonly shell = new Mat3();
  readonly interior = new Mat3();
  private readonly shellOrientation = new Quat();
  private readonly interiorOrientation = new Quat();
  private readonly axis = new Vec3();
  private readonly step = new Quat();
  private pointer?: { x: number; y: number; at: number };
  private pitchSpeed = 0;
  private yawSpeed = 0;

  point(x: number, y: number, at: number, radius: number) {
    const previous = this.pointer;
    this.pointer = { x, y, at };
    if (!previous) return;
    const elapsed = (at - previous.at) / 1000;
    const dx = x - previous.x;
    const dy = y - previous.y;
    const distance = Math.hypot(dx, dy);
    if (!distance || elapsed <= 0 || elapsed >= .18) return;

    const speed = Math.min(MAX_SPEED, distance * POINTER_GAIN / (radius * Math.max(.008, elapsed)));
    this.pitchSpeed = dy / distance * speed;
    this.yawSpeed = dx / distance * speed;
  }

  leave() {
    this.pointer = undefined;
  }

  stop() {
    this.leave();
    this.pitchSpeed = 0;
    this.yawSpeed = 0;
  }

  advance(elapsed: number) {
    const speed = Math.hypot(this.pitchSpeed, this.yawSpeed);
    if (speed < .001 || elapsed <= 0) return;

    const decay = Math.exp(-DAMPING * elapsed);
    const angle = speed * (1 - decay) / DAMPING;
    // The shader's view has +Y up. Rotating around +X moves the front down.
    this.axis.set(this.pitchSpeed / speed, this.yawSpeed / speed, 0);
    // Applying opposite increments in view space keeps both layers on the
    // same gesture axis, even after earlier sweeps have reoriented them.
    this.shellOrientation.multiply(this.step.fromAxisAngle(this.axis, -angle)).normalize();
    this.interiorOrientation.multiply(this.step.fromAxisAngle(this.axis, angle * INTERIOR_SPEED)).normalize();
    this.shell.fromQuaternion(this.shellOrientation);
    this.interior.fromQuaternion(this.interiorOrientation);
    this.pitchSpeed *= decay;
    this.yawSpeed *= decay;
  }
}
