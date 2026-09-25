// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { defaultWindowGlass, requestedWindowMaterial } from "../lib/windowGlass";
import { WindowGlassSetting } from "./WindowGlassSetting";

function SettingsHarness() {
  const [value, onChange] = useState({ ...defaultWindowGlass });
  return <WindowGlassSetting value={value} onChange={onChange} status={{ material: requestedWindowMaterial(value), liquidAvailable: true, interactiveAvailable: true }} />;
}

describe("window glass controls", () => {
  it("preserves shared tint and blur through off/on and resets both together", () => {
    render(<SettingsHarness />);
    const tint = screen.getByRole("slider", { name: "Tint opacity" });
    const blur = screen.getByRole("slider", { name: "Background blur" });
    const enabled = screen.getByRole("checkbox", { name: "Liquid Glass" });

    fireEvent.change(tint, { target: { value: "63" } });
    fireEvent.change(blur, { target: { value: "80" } });
    fireEvent.click(enabled);
    expect(tint).toBeDisabled();
    expect(blur).toBeDisabled();
    fireEvent.click(enabled);
    expect(tint).toBeEnabled();
    expect(tint).toHaveValue("63");
    expect(blur).toHaveValue("80");

    fireEvent.click(screen.getByRole("button", { name: "Reset glass" }));
    expect(enabled).toBeChecked();
    expect(tint).toHaveValue("30");
    expect(blur).toHaveValue("50");
  });
});
