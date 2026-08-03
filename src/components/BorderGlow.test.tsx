// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BorderGlow from "./BorderGlow";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BorderGlow", () => {
  it("preserves button semantics and updates the glow without React state", () => {
    const onClick = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(16);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(
      <BorderGlow as="button" type="button" onClick={onClick}>
        Open note
      </BorderGlow>,
    );

    const card = screen.getByRole("button", { name: "Open note" });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.click(card);
    fireEvent.pointerMove(card, {
      clientX: 196,
      clientY: 50,
      pointerType: "mouse",
    });

    expect(onClick).toHaveBeenCalledOnce();
    expect(card).toHaveClass("border-glow");
    expect(card.style.borderColor).toBe("transparent");
    expect(card.style.getPropertyValue("--border-glow-angle")).not.toBe("");
    expect(
      Number(card.style.getPropertyValue("--border-glow-strength")),
    ).toBeGreaterThan(0.5);
    expect(card.querySelector(".border-glow__aura")).toBeInTheDocument();
    expect(card.querySelector(".border-glow__edge")).toBeInTheDocument();
    expect(card.style.getPropertyValue("--border-glow-x")).toBe("");
    expect(card.style.getPropertyValue("--border-glow-y")).toBe("");
  });
});
