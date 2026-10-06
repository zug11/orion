// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { resolveAtmospherePalette } from "../lib/homeAtmosphere";
import { resolveThemePalette } from "../lib/theme";
import { SettingsView } from "./SettingsView";

const invokeTauriMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock }));

afterEach(() => {
  invokeTauriMock.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("SettingsView appearance", () => {
  it("can restore original icons and keep the atmosphere dark independently of the app", () => {
    const action = vi.fn(async () => undefined);
    const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
    const onChange = vi.fn();
    const props = { onChange, onSaveApiKey: action, onDeleteApiKey: action, onTestApiKey: testKey,
      onSaveAnthropicApiKey: action, onDeleteAnthropicApiKey: action, onTestAnthropicApiKey: testKey,
      onSaveElevenLabsApiKey: action, onDeleteElevenLabsApiKey: action, onTestElevenLabsApiKey: testKey,
      onOpenDataLocation: vi.fn(), onEraseVault: vi.fn() };
    const settings = { ...defaultSettings, theme: "light" as const, homeAtmosphere: "mirage" as const };
    const { rerender } = render(<SettingsView {...props} settings={settings} />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Icon colours" })).getByRole("radio", { name: "Original" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, themeIcon: false });
    fireEvent.click(screen.getByRole("radio", { name: "Always dark" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereAppearance: "dark" });
    const changed = { ...settings, homeAtmosphereAppearance: "dark" as const };
    rerender(<SettingsView {...props} settings={changed} />);
    const dark = resolveThemePalette(changed, "dark");
    expect(document.querySelector<HTMLElement>(".atmosphere-preview.mirage")?.style.getPropertyValue("--atmosphere-background")).toBe(dark.canvasDeep);
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Match theme" }));
    expect(onChange).toHaveBeenLastCalledWith(settings);
  });

  it("keeps note font selection out of Settings", () => {
    const onChange = vi.fn();
    const action = vi.fn(async () => undefined);
    const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
    const props = {
      onChange,
      onSaveApiKey: action,
      onDeleteApiKey: action,
      onTestApiKey: testKey,
      onSaveAnthropicApiKey: action,
      onDeleteAnthropicApiKey: action,
      onTestAnthropicApiKey: testKey,
      onSaveElevenLabsApiKey: action,
      onDeleteElevenLabsApiKey: action,
      onTestElevenLabsApiKey: testKey,
      onOpenDataLocation: vi.fn(),
      onEraseVault: vi.fn(),
    };
    const settings = { ...defaultSettings, themePreset: "grove" as const };
    render(<SettingsView {...props} settings={settings} />);
    expect(screen.queryByRole("group", { name: "Note text" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Note font" })).not.toBeInTheDocument();

  });

  it("selects GPT-6 Astra with a supported reasoning depth", () => {
    const onChange = vi.fn();
    const action = vi.fn(async () => undefined);
    const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
    const settings = { ...defaultSettings, reasoningEffort: "none" as const };
    const props = {
      onChange,
      onSaveApiKey: action,
      onDeleteApiKey: action,
      onTestApiKey: testKey,
      onSaveAnthropicApiKey: action,
      onDeleteAnthropicApiKey: action,
      onTestAnthropicApiKey: testKey,
      onSaveElevenLabsApiKey: action,
      onDeleteElevenLabsApiKey: action,
      onTestElevenLabsApiKey: testKey,
      onOpenDataLocation: vi.fn(),
      onEraseVault: vi.fn(),
    };
    const { rerender } = render(<SettingsView {...props} settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: /GPT-6 Astra/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...settings,
      model: "gpt-6-astra",
      reasoningEffort: "low",
    });
    rerender(<SettingsView {...props} settings={{ ...settings, model: "gpt-6-astra", reasoningEffort: "high" }} />);
    expect(screen.getByRole("button", { name: /GPT-6 Astra/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Reasoning depth" })).toHaveValue("high");
    expect(screen.getByRole("option", { name: "None" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /GPT-5\.6 Sol/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, reasoningEffort: "high" });
  });

  it("offers twelve curated home atmospheres with Line Waves first", () => {
    const onChange = vi.fn();

    render(
      <SettingsView
        settings={{ ...defaultSettings }}
        onChange={onChange}
        onSaveApiKey={vi.fn(async () => undefined)}
        onDeleteApiKey={vi.fn(async () => undefined)}
        onTestApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveAnthropicApiKey={vi.fn(async () => undefined)}
        onDeleteAnthropicApiKey={vi.fn(async () => undefined)}
        onTestAnthropicApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveElevenLabsApiKey={vi.fn(async () => undefined)}
        onDeleteElevenLabsApiKey={vi.fn(async () => undefined)}
        onTestElevenLabsApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onOpenDataLocation={vi.fn()}
        onEraseVault={vi.fn()}
      />,
    );

    const atmosphereGroup = screen.getByRole("radiogroup", {
      name: "Home atmosphere",
    });

    expect(
      within(atmosphereGroup).getByRole("radio", {
        name: "Field: A precise dot matrix that responds to movement.",
      }),
    ).toHaveAttribute("aria-checked", "true");

    const atmosphereRadios = within(atmosphereGroup).getAllByRole("radio");
    expect(atmosphereRadios[0]).toHaveAccessibleName(
      "Line Waves: Fine contours flow through a quiet warped field.",
    );
    expect(atmosphereRadios[1]).toHaveAccessibleName(
      "Signal Decay: Clean harmonics loosen into warm, responsive noise.",
    );

    fireEvent.click(atmosphereRadios[0]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Gold accent, #D8B675",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Alive",
      }),
    );

    expect(onChange).toHaveBeenNthCalledWith(1, {
      ...defaultSettings,
      homeAtmosphere: "line-waves",
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      ...defaultSettings,
      homeAtmosphereTone: "gold",
    });
    expect(onChange).toHaveBeenNthCalledWith(3, {
      ...defaultSettings,
      homeAtmosphereMotion: "alive",
    });
    expect(atmosphereRadios).toHaveLength(6);
    expect(within(atmosphereGroup).queryByRole("radio", { name: /Nova:/ })).not.toBeInTheDocument();
    for (const [id, name] of [
      ["mirage", "Mirage: Drifting glass lenses bend a travelling sheet of light."],
      ["opal", "Opal: Pearlescent glass ribbons catch slow-moving iridescent light."],
      ["ripple-glass", "Ripple Glass: Overlapping optical ripples bend coloured reflections."],
    ]) {
      fireEvent.click(within(atmosphereGroup).getByRole("radio", { name }));
      expect(onChange).toHaveBeenLastCalledWith({ ...defaultSettings, homeAtmosphere: id });
    }
    fireEvent.change(screen.getByLabelText("Custom shader color"), {
      target: { value: "#ff4c80" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      ...defaultSettings,
      homeAtmosphereCustomColor: "#FF4C80",
      homeAtmosphereCustomSecondaryColor: resolveAtmospherePalette(
        defaultSettings.homeAtmosphere,
        defaultSettings.homeAtmosphereTone,
        resolveThemePalette(defaultSettings, "dark"),
      ).secondary,
    });
  });

  it("edits either shader colour independently, updates every preview, and resets both together", () => {
    const onChange = vi.fn();
    const action = vi.fn(async () => undefined);
    const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
    const props = {
      onChange, onSaveApiKey: action, onDeleteApiKey: action, onTestApiKey: testKey,
      onSaveAnthropicApiKey: action, onDeleteAnthropicApiKey: action, onTestAnthropicApiKey: testKey,
      onSaveElevenLabsApiKey: action, onDeleteElevenLabsApiKey: action, onTestElevenLabsApiKey: testKey,
      onOpenDataLocation: vi.fn(), onEraseVault: vi.fn(),
    };
    let settings = { ...defaultSettings, homeAtmosphereCustomColor: "#E94F8A" };
    const { rerender } = render(<SettingsView {...props} settings={settings} />);
    const refresh = () => {
      settings = onChange.mock.lastCall![0];
      rerender(<SettingsView {...props} settings={settings} />);
    };

    fireEvent.change(screen.getByRole("textbox", { name: "Shader secondary color hex" }), {
      target: { value: "#08aaee" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereCustomSecondaryColor: "#08AAEE" });
    refresh();
    const group = screen.getByRole("radiogroup", { name: "Home atmosphere" });
    for (const preview of group.querySelectorAll<HTMLElement>(".atmosphere-preview")) {
      expect(preview.style.getPropertyValue("--atmosphere-primary")).toBe("#E94F8A");
      expect(preview.style.getPropertyValue("--atmosphere-secondary")).toBe("#08AAEE");
    }
    fireEvent.change(screen.getByLabelText("Custom shader color"), { target: { value: "#aa66ff" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereCustomColor: "#AA66FF" });
    refresh();
    fireEvent.click(within(group).getByRole("radio", { name: /Opal:/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphere: "opal" });
    refresh();
    fireEvent.click(screen.getByRole("button", { name: "Reset shader colours" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereCustomColor: "", homeAtmosphereCustomSecondaryColor: "" });
    refresh();
    expect(screen.queryByRole("button", { name: "Reset shader colours" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Custom shader secondary color"), { target: { value: "#ff6699" } });
    const preset = resolveAtmospherePalette("opal", settings.homeAtmosphereTone, resolveThemePalette(settings, "dark"));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereCustomColor: preset.primary, homeAtmosphereCustomSecondaryColor: "#FF6699" });
    refresh();
    expect(screen.getByRole("button", { name: /Theme accent,/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /Gold accent,/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, homeAtmosphereTone: "gold", homeAtmosphereCustomColor: "", homeAtmosphereCustomSecondaryColor: "" });
  });

  it("offers curated rooms with restrained, resettable color overrides", () => {
    const onChange = vi.fn();
    const settings = {
      ...defaultSettings,
      themeAccentCustom: "#112233",
    };

    render(
      <SettingsView
        settings={settings}
        onChange={onChange}
        onSaveApiKey={vi.fn(async () => undefined)}
        onDeleteApiKey={vi.fn(async () => undefined)}
        onTestApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveAnthropicApiKey={vi.fn(async () => undefined)}
        onDeleteAnthropicApiKey={vi.fn(async () => undefined)}
        onTestAnthropicApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveElevenLabsApiKey={vi.fn(async () => undefined)}
        onDeleteElevenLabsApiKey={vi.fn(async () => undefined)}
        onTestElevenLabsApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onOpenDataLocation={vi.fn()}
        onEraseVault={vi.fn()}
      />,
    );

    const presetGroup = screen.getByRole("radiogroup", {
      name: "Color preset",
    });
    expect(within(presetGroup).getAllByRole("radio")).toHaveLength(4);

    fireEvent.click(
      within(presetGroup).getByRole("radio", {
        name: /Tide: Cool marine depth/,
      }),
    );
    expect(onChange).toHaveBeenNthCalledWith(1, {
      ...settings,
      themePreset: "tide",
      themeActivePaletteId: "",
      themeAccent: "preset",
      themeAccentCustom: "",
      themeCanvasCustom: "",
      themeSurfaceCustom: "",
    });

    fireEvent.change(screen.getByLabelText("Custom accent color"), {
      target: { value: "#345678" },
    });
    expect(onChange).toHaveBeenNthCalledWith(2, {
      ...settings,
      themeAccentCustom: "#345678",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Reset custom accent color" }),
    );
    expect(onChange).toHaveBeenNthCalledWith(3, {
      ...settings,
      themeAccentCustom: "",
    });

    expect(
      within(
        screen.getByRole("radiogroup", { name: "Canvas depth" }),
      ).getByRole("radio", { name: "Deep" }),
    ).toBeVisible();
  });

  it("preserves chosen custom colours while changing canvas depth and surface lift", () => {
    const onChange = vi.fn();
    const action = vi.fn(async () => undefined);
    const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
    const settings = { ...defaultSettings, themeCanvasCustom: "#142B28", themeSurfaceCustom: "#28443D" };
    render(<SettingsView settings={settings} onChange={onChange}
      onSaveApiKey={action} onDeleteApiKey={action} onTestApiKey={testKey}
      onSaveAnthropicApiKey={action} onDeleteAnthropicApiKey={action} onTestAnthropicApiKey={testKey}
      onSaveElevenLabsApiKey={action} onDeleteElevenLabsApiKey={action} onTestElevenLabsApiKey={testKey}
      onOpenDataLocation={action} onEraseVault={action} />);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Canvas depth" })).getByRole("radio", { name: "Deep" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, themeCanvasTone: "deep" });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Surface lift" })).getByRole("radio", { name: "Lifted" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, themeSurfaceLift: "lifted" });
    const curated = screen.getByRole("radiogroup", { name: "Color preset" });
    expect(within(curated).getAllByRole("radio").every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
    expect(screen.getByText("Unsaved palette")).toBeInTheDocument();
  });

  it("offers Claude 5 models and saves one shared Anthropic key", async () => {
    const onChange = vi.fn();
    const onSaveAnthropicApiKey = vi.fn(async () => undefined);

    render(
      <SettingsView
        settings={{ ...defaultSettings }}
        onChange={onChange}
        onSaveApiKey={vi.fn(async () => undefined)}
        onDeleteApiKey={vi.fn(async () => undefined)}
        onTestApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveAnthropicApiKey={onSaveAnthropicApiKey}
        onDeleteAnthropicApiKey={vi.fn(async () => undefined)}
        onTestAnthropicApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveElevenLabsApiKey={vi.fn(async () => undefined)}
        onDeleteElevenLabsApiKey={vi.fn(async () => undefined)}
        onTestElevenLabsApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onOpenDataLocation={vi.fn()}
        onEraseVault={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5/ }));
    expect(onChange).toHaveBeenCalledWith({
      ...defaultSettings,
      model: "claude-opus-5",
    });
    expect(screen.getByRole("button", { name: /Claude Fable 5/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Claude Sonnet 5/ })).toBeVisible();

    const keyInput = screen.getByLabelText("Anthropic API key");
    fireEvent.change(keyInput, { target: { value: "sk-ant-api03-test" } });
    const keyCard = keyInput.closest(".api-key-card");
    expect(keyCard).not.toBeNull();
    fireEvent.click(
      within(keyCard as HTMLElement).getByRole("button", { name: "Save key" }),
    );
    await waitFor(() =>
      expect(onSaveAnthropicApiKey).toHaveBeenCalledWith("sk-ant-api03-test"),
    );
  });

  it("offers independent zero-configuration Claude and Codex installs on desktop", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    let finishClaudeInstall: ((value: string) => void) | undefined;
    invokeTauriMock.mockImplementation((command: string) => {
      if (command === "open_claude_connector") {
        return new Promise<string>((resolve) => {
          finishClaudeInstall = resolve;
        });
      }
      if (command === "open_codex_plugin") {
        return Promise.resolve(
          "codex://plugins/orion?marketplacePath=%2FApplications%2FOrion.app",
        );
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });

    render(
      <SettingsView
        settings={{ ...defaultSettings }}
        onChange={vi.fn()}
        onSaveApiKey={vi.fn(async () => undefined)}
        onDeleteApiKey={vi.fn(async () => undefined)}
        onTestApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveAnthropicApiKey={vi.fn(async () => undefined)}
        onDeleteAnthropicApiKey={vi.fn(async () => undefined)}
        onTestAnthropicApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveElevenLabsApiKey={vi.fn(async () => undefined)}
        onDeleteElevenLabsApiKey={vi.fn(async () => undefined)}
        onTestElevenLabsApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onOpenDataLocation={vi.fn()}
        onEraseVault={vi.fn()}
      />,
    );

    const claudeButton = screen.getByRole("button", {
      name: "Install in Claude",
    });
    const codexButton = screen.getByRole("button", {
      name: "Install in Codex",
    });
    fireEvent.click(claudeButton);

    await waitFor(() => expect(claudeButton).toBeDisabled());
    expect(codexButton).toBeEnabled();
    fireEvent.click(codexButton);

    await waitFor(() => {
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "open_codex_plugin",
        undefined,
      );
      expect(
        screen.getByText(/Codex should now show Orion’s plugin page/i),
      ).toBeVisible();
    });

    finishClaudeInstall?.("/Applications/Orion-Claude-Connector.mcpb");
    await waitFor(() => {
      expect(
        screen.getByText(/Claude Desktop should now ask you to install/i),
      ).toBeVisible();
    });
  });

  it("keeps connector installation desktop-only in browser preview", () => {
    render(
      <SettingsView
        settings={{ ...defaultSettings }}
        onChange={vi.fn()}
        onSaveApiKey={vi.fn(async () => undefined)}
        onDeleteApiKey={vi.fn(async () => undefined)}
        onTestApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveAnthropicApiKey={vi.fn(async () => undefined)}
        onDeleteAnthropicApiKey={vi.fn(async () => undefined)}
        onTestAnthropicApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onSaveElevenLabsApiKey={vi.fn(async () => undefined)}
        onDeleteElevenLabsApiKey={vi.fn(async () => undefined)}
        onTestElevenLabsApiKey={vi.fn(async () => ({
          valid: true,
          message: "Connected.",
        }))}
        onOpenDataLocation={vi.fn()}
        onEraseVault={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Install in Claude" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Install in Codex" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/installation is available in the installed Orion desktop app/i),
    ).toBeVisible();
  });
});
