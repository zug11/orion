import { describe, expect, it } from "vitest";
import { VoiceOrbRotation } from "./rotation";

function swipe(dx: number, dy: number) {
  const rotation = new VoiceOrbRotation();
  rotation.point(80, 80, 0, 80);
  rotation.point(80 + dx, 80 + dy, 40, 80);
  rotation.advance(.04);
  return rotation;
}

// A point initially facing the viewer, transformed back into view space.
function front(rotation: readonly number[]) {
  return [rotation[2], rotation[5]] as const;
}

describe("voice orb hover rotation", () => {
  it.each([
    ["right", 40, 0, 1, 0],
    ["left", -40, 0, -1, 0],
    ["up", 0, -40, 0, 1],
    ["down", 0, 40, 0, -1],
    ["down-right", 30, 30, 1, -1],
    ["up-right", 30, -30, 1, 1],
  ])("turns both layers in opposite directions on a %s sweep", (_direction, dx, dy, x, y) => {
    const rotation = swipe(dx, dy);
    const shell = front(rotation.shell);
    const interior = front(rotation.interior);

    [x, y].forEach((direction, axis) => {
      if (direction === 0) {
        expect(shell[axis]).toBeCloseTo(0, 8);
        expect(interior[axis]).toBeCloseTo(0, 8);
      } else {
        expect(shell[axis] * direction).toBeGreaterThan(.1);
        expect(interior[axis] * direction).toBeLessThan(-.05);
        expect(Math.abs(interior[axis])).toBeLessThan(Math.abs(shell[axis]));
      }
    });
  });

  it("coasts on the same diagonal after leaving and slows over time", () => {
    const rotation = swipe(30, 30);
    const [startX] = front(rotation.shell);
    rotation.leave();
    rotation.advance(.04);
    const [firstX, firstY] = front(rotation.shell);
    rotation.advance(.04);
    const [secondX, secondY] = front(rotation.shell);

    expect(firstX).toBeGreaterThan(startX);
    expect(secondX).toBeGreaterThan(firstX);
    expect(secondX - firstX).toBeLessThan(firstX - startX);
    expect(firstY).toBeCloseTo(-firstX, 8);
    expect(secondY).toBeCloseTo(-secondX, 8);
    const [innerX, innerY] = front(rotation.interior);
    expect(innerX).toBeLessThan(0);
    expect(innerY).toBeCloseTo(-innerX, 8);
  });

  it("tips on the screen's horizontal axis after an earlier sideways sweep", () => {
    const rotation = swipe(40, 0);
    const [shellX] = front(rotation.shell);
    const [interiorX] = front(rotation.interior);
    rotation.point(120, 40, 80, 80);
    rotation.advance(.04);

    expect(front(rotation.shell)[0]).toBeCloseTo(shellX, 8);
    expect(front(rotation.interior)[0]).toBeCloseTo(interiorX, 8);
    expect(front(rotation.shell)[1]).toBeGreaterThan(.1);
    expect(front(rotation.interior)[1]).toBeLessThan(-.05);
  });

  it("stops at the current angle and starts a fresh pointer sample", () => {
    const rotation = swipe(40, 0);
    const shell = Array.from(rotation.shell);
    const interior = Array.from(rotation.interior);
    rotation.stop();
    rotation.point(80, 120, 80, 80);
    rotation.advance(.04);

    expect(Array.from(rotation.shell)).toEqual(shell);
    expect(Array.from(rotation.interior)).toEqual(interior);
  });
});
