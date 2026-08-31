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
import { SettingsView } from "./SettingsView";

const invokeTauriMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock }));

afterEach(() => {
  invokeTauriMock.mockReset();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("SettingsView appearance", () => {
  it("offers the three curated home atmospheres with Line Waves first", () => {
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
    expect(atmosphereRadios).toHaveLength(3);
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
