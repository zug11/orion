import { describe, expect, it } from "vitest";
import { resolveAIWritingSelectionPosition } from "./aiWritingPosition";

const workspace = { top: 58, bottom: 720, left: 71, right: 900 };

describe("AI writing selection positioning", () => {
  it("flips beneath a selection that would collide with the sticky toolbar", () => {
    expect(
      resolveAIWritingSelectionPosition({
        workspace,
        toolbarBottom: 194,
        start: { top: 221, bottom: 239, left: 170, right: 170 },
        end: { top: 285, bottom: 303, left: 170, right: 384 },
      }),
    ).toEqual({
      left: 247,
      top: 312,
      visible: true,
      placement: "below",
    });
  });

  it("stays above when there is room and keeps an open menu inside the workspace", () => {
    expect(
      resolveAIWritingSelectionPosition({
        workspace,
        toolbarBottom: 110,
        start: { top: 430, bottom: 448, left: 880, right: 880 },
        end: { top: 448, bottom: 466, left: 880, right: 880 },
      }),
    ).toEqual({
      left: 724,
      top: 421,
      visible: true,
      placement: "above",
    });
  });
});
