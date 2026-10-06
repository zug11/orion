import { describe, expect, it } from "vitest";
import { createBlockGeometry, type BlockExclusion, type BlockRect } from "./blockGeometry";

const block: BlockRect = { left: 100, top: 100, right: 700, bottom: 500 };
const leftImage: BlockExclusion = {
  rect: { left: 100, top: 200, right: 300, bottom: 350 }, side: "left", gap: 10,
};

describe("block outline geometry beside floating images", () => {
  it("keeps an ordinary paragraph at its full width", () => {
    const result = createBlockGeometry(block, []);
    expect(result.bands).toEqual([block]);
    expect(result.bounds).toEqual(block);
    expect(result.path).toBe("M100 107 Q100 100 107 100 L693 100 Q700 100 700 107 L700 493 Q700 500 693 500 L107 500 Q100 500 100 493 Z");
  });

  it("narrows beside a left image and widens above and below it without splitting the block", () => {
    const result = createBlockGeometry(block, [leftImage]);
    expect(result.bands).toEqual([
      { left: 100, top: 100, right: 700, bottom: 190 },
      { left: 310, top: 190, right: 700, bottom: 360 },
      { left: 100, top: 360, right: 700, bottom: 500 },
    ]);
    expect(result.polygons).toHaveLength(1);
    expect(result.path).toContain("L100 367 Q100 360 107 360 L303 360 Q310 360 310 353");
    expect(result.path).toContain("L310 197 Q310 190 303 190 L107 190 Q100 190 100 183");
  });

  it("narrows from the right for a right float", () => {
    const result = createBlockGeometry(block, [{
      rect: { left: 450, top: 80, right: 690, bottom: 520 }, side: "right", gap: 18,
    }]);
    expect(result.bands).toEqual([{ left: 100, top: 100, right: 432, bottom: 500 }]);
    expect(result.bounds?.right).toBe(432);
  });

  it("uses the float's roomier side for an image freely positioned away from the edge", () => {
    // This float excludes the small unused area to its left as well as itself.
    expect(createBlockGeometry(block, [{
      rect: { left: 180, top: 100, right: 380, bottom: 500 }, side: "left", gap: 20,
    }]).bands).toEqual([{ left: 400, top: 100, right: 700, bottom: 500 }]);
  });

  it("splits the visible outline across an above-and-below exclusion", () => {
    const result = createBlockGeometry(block, [{ ...leftImage, side: "both" }]);
    expect(result.bands).toEqual([
      { left: 100, top: 100, right: 700, bottom: 190 },
      { left: 100, top: 360, right: 700, bottom: 500 },
    ]);
    expect(result.polygons).toHaveLength(2);
  });

  it("combines overlapping image bands without drawing through either image", () => {
    const result = createBlockGeometry(block, [leftImage, {
      rect: { left: 600, top: 300, right: 700, bottom: 420 }, side: "right", gap: 10,
    }]);
    expect(result.bands).toEqual([
      { left: 100, top: 100, right: 700, bottom: 190 },
      { left: 310, top: 190, right: 700, bottom: 290 },
      { left: 310, top: 290, right: 590, bottom: 360 },
      { left: 100, top: 360, right: 590, bottom: 430 },
      { left: 100, top: 430, right: 700, bottom: 500 },
    ]);
    expect(result.polygons).toHaveLength(1);
  });

  it("merges adjacent equal-width lanes instead of adding seams", () => {
    const result = createBlockGeometry(block, [
      { rect: { left: 100, top: 100, right: 300, bottom: 300 }, side: "left" },
      { rect: { left: 100, top: 300, right: 300, bottom: 500 }, side: "left" },
    ]);
    expect(result.bands).toEqual([{ left: 300, top: 100, right: 700, bottom: 500 }]);
    expect(result.polygons[0]).toHaveLength(4);
  });

  it("does not join disconnected lanes through an image", () => {
    const result = createBlockGeometry(block, [
      { rect: { left: 100, top: 100, right: 500, bottom: 300 }, side: "left" },
      { rect: { left: 300, top: 300, right: 700, bottom: 500 }, side: "right" },
    ]);
    expect(result.polygons).toHaveLength(2);
  });

  it("ignores images outside the paragraph's vertical or horizontal band", () => {
    const result = createBlockGeometry(block, [
      { rect: { left: 100, top: 510, right: 300, bottom: 700 }, side: "left" },
      { rect: { left: 710, top: 100, right: 900, bottom: 400 }, side: "right" },
    ]);
    expect(result.bands).toEqual([block]);
  });

  it("omits an entirely obstructed paragraph frame", () => {
    expect(createBlockGeometry(block, [{ rect: block, side: "left" }])).toEqual({
      bands: [], polygons: [], path: "", bounds: null,
    });
  });

  it("clips partly intersecting images and honors a caller's minimum usable lane", () => {
    const exclusion: BlockExclusion = {
      rect: { left: 50, top: 0, right: 695, bottom: 700 }, side: "left",
    };
    expect(createBlockGeometry(block, [exclusion]).bands).toEqual([
      { left: 695, top: 100, right: 700, bottom: 500 },
    ]);
    expect(createBlockGeometry(block, [exclusion], { minimumWidth: 20 }).bands).toEqual([]);
  });

  it("retains subpixel geometry and emits a bounded-precision SVG path", () => {
    const result = createBlockGeometry({ left: 1.12345, top: 2.98765, right: 70.12345, bottom: 50.98765 }, []);
    expect(result.bands[0].left).toBe(1.12345);
    expect(result.path).toBe("M1.123 9.988 Q1.123 2.988 8.123 2.988 L63.123 2.988 Q70.123 2.988 70.123 9.988 L70.123 43.988 Q70.123 50.988 63.123 50.988 L8.123 50.988 Q1.123 50.988 1.123 43.988 Z");
  });

  it("keeps measurements local when the caller translates to an overlay origin", () => {
    const translate = (rect: BlockRect): BlockRect => ({
      left: rect.left - 100, right: rect.right - 100, top: rect.top - 100, bottom: rect.bottom - 100,
    });
    const result = createBlockGeometry(translate(block), [{ ...leftImage, rect: translate(leftImage.rect) }]);
    expect(result.bands[1]).toEqual({ left: 210, top: 90, right: 600, bottom: 260 });
  });

  it("rejects invalid rectangles and never emits nonfinite SVG coordinates", () => {
    expect(createBlockGeometry({ ...block, bottom: NaN }, []).path).toBe("");
    expect(createBlockGeometry({ ...block, right: block.left }, []).path).toBe("");
    expect(createBlockGeometry(block, [{ ...leftImage, rect: { ...leftImage.rect, right: Infinity } }]).bands).toEqual([block]);
    expect(createBlockGeometry(block, [{ ...leftImage, gap: NaN }]).path).not.toMatch(/NaN|Infinity/);
  });

  it("treats negative spacing as zero rather than drawing over the image", () => {
    expect(createBlockGeometry(block, [{ ...leftImage, gap: -20 }]).bands[1]).toEqual({
      left: 300, top: 200, right: 700, bottom: 350,
    });
  });

  it("clamps rounded corners to half of short edges without changing the layout bands", () => {
    const result = createBlockGeometry({ left: 0, top: 0, right: 8, bottom: 30 }, []);
    expect(result.path).toBe("M0 4 Q0 0 4 0 L4 0 Q8 0 8 4 L8 26 Q8 30 4 30 L4 30 Q0 30 0 26 Z");
    expect(result.bands).toEqual([{ left: 0, top: 0, right: 8, bottom: 30 }]);
  });

  it("rounds short steps beside an image without letting adjacent curves cross", () => {
    const result = createBlockGeometry(block, [{
      rect: { left: 100, top: 200, right: 104, bottom: 204 }, side: "left",
    }]);
    // The four-pixel notch limits all its corner radii to two pixels.
    expect(result.path).toContain("L100 206 Q100 204 102 204 L102 204 Q104 204 104 202");
    expect(result.path).toContain("L104 202 Q104 200 102 200 L102 200 Q100 200 100 198");
  });

  it("keeps rounded outlines independently closed across a full-width image band", () => {
    const result = createBlockGeometry(block, [{ ...leftImage, side: "both" }]);
    expect(result.path.match(/M/g)).toHaveLength(2);
    expect(result.path.match(/Z/g)).toHaveLength(2);
    expect(result.path.match(/Q/g)).toHaveLength(8);
    expect(result.path).toContain("Z M100 367 Q100 360 107 360");
  });

  it("supports square corners explicitly and bounds custom radii", () => {
    expect(createBlockGeometry(block, [], { cornerRadius: 0 }).path)
      .toBe("M100 100 L700 100 L700 500 L100 500 Z");
    expect(createBlockGeometry(block, [], { cornerRadius: 1_000 }).path)
      .toContain("M100 124 Q100 100 124 100");
    expect(createBlockGeometry(block, [], { cornerRadius: NaN }).path)
      .toBe(createBlockGeometry(block, []).path);
  });
});
