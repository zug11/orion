// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { ThemePalettePicker } from "./ThemePalettePicker";
import type { Settings } from "../types";
import { defaultThemePreferences } from "../lib/savedThemePalettes";

describe("personal palette authoring", () => {
  it("selects one saved or curated card in the same group even when their names and colours match", () => {
    const saved = { ...defaultThemePreferences("orion"), id: "palette-personal", name: "Orion" };
    let settings: Settings = { ...defaultSettings, theme: "light",
      themeSavedPalettes: [saved], themeActivePaletteId: saved.id };
    const onChange = vi.fn((patch: Partial<Settings>) => { settings = { ...settings, ...patch }; });
    const view = render(<ThemePalettePicker settings={settings} mode="light" onChange={onChange} />);
    const group = within(screen.getByRole("radiogroup", { name: "Color preset" }));
    expect(group.getAllByRole("radio")).toHaveLength(5);
    expect(group.getAllByRole("radio", { checked: true })).toEqual([group.getByRole("radio", { name: "Use Orion palette" })]);
    fireEvent.click(group.getByRole("radio", { name: /^Orion:/ }));
    view.rerender(<ThemePalettePicker settings={settings} mode="light" onChange={onChange} />);
    expect(settings.theme).toBe("light");
    expect(settings.themeActivePaletteId).toBe("");
    expect(settings.themeSavedPalettes).toEqual([saved]);
    expect(group.getAllByRole("radio", { checked: true })).toEqual([group.getByRole("radio", { name: /^Orion:/ })]);
  });

  it("saves, edits independently, overwrites, reselects and deletes without losing current colours", () => {
    const onChange = vi.fn();
    let settings: Settings = { ...defaultSettings, themeCanvasCustom: "#152E2A", themeSurfaceLift: "lifted" };
    const view = render(<ThemePalettePicker settings={settings} mode="dark" onChange={onChange} />);
    const refresh = () => { settings = { ...settings, ...onChange.mock.lastCall![0] }; view.rerender(<ThemePalettePicker settings={settings} mode="dark" onChange={onChange} />); };
    expect(screen.getByText("Custom")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Palette name" }), { target: { value: "My forest" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Palette name" }), { key: "Enter" });
    refresh();
    const saved = settings.themeSavedPalettes![0];
    expect(saved).toMatchObject({ name: "My forest", themeCanvasCustom: "#152E2A", themeSurfaceLift: "lifted" });
    expect(saved).not.toHaveProperty("theme");
    expect(screen.getByRole("radio", { name: "Use My forest palette" })).toHaveAttribute("aria-checked", "true");
    settings = { ...settings, themeCanvasTone: "deep" };
    view.rerender(<ThemePalettePicker settings={settings} mode="light" onChange={onChange} />);
    expect(screen.getByText("Unsaved changes to My forest")).toBeInTheDocument();
    expect(settings.themeSavedPalettes![0].themeCanvasTone).toBe("balanced");
    fireEvent.click(screen.getByRole("button", { name: "Overwrite My forest palette" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace palette" }));
    refresh();
    expect(settings.themeSavedPalettes![0].themeCanvasTone).toBe("deep");
    settings = { ...settings, themeCanvasTone: "airy" };
    view.rerender(<ThemePalettePicker settings={settings} mode="dark" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Use My forest palette" })); refresh();
    expect(settings.themeCanvasTone).toBe("deep");
    fireEvent.click(screen.getByRole("button", { name: "Delete My forest palette" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete palette" })); refresh();
    expect(settings.themeSavedPalettes).toEqual([]);
    expect(settings.themeCanvasCustom).toBe("#152E2A");
    expect(settings.themeCanvasTone).toBe("deep");
    expect(settings.themeActivePaletteId).toBe("");
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });
});
