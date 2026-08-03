import { describe, expect, it } from "vitest";
import { resetScrollPosition } from "./navigation";

describe("resetScrollPosition", () => {
  it("returns note navigation to the top-left of its scroll pane", () => {
    const pane = { scrollLeft: 18, scrollTop: 640 };

    resetScrollPosition(pane);

    expect(pane).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("accepts a missing pane while the layout is changing", () => {
    expect(() => resetScrollPosition(null)).not.toThrow();
  });
});
