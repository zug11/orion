// @vitest-environment jsdom

import {
  fireEvent,
  act,
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
const isTauriMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock, isTauri: isTauriMock }));

afterEach(() => {
  invokeTauriMock.mockReset();
  isTauriMock.mockReturnValue(false);
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("SettingsView web research provider", () => {
  it("persists an explicit OpenAI preference without changing the Intelligence model or deleting either connection", () => {
    const props = voiceSettingsProps();
    const settings = { ...defaultSettings, model: "gpt-6.1-sol", apiKeyConfigured: true, perplexityApiKeyConfigured: true };
    render(<SettingsView {...props} settings={settings}/>);
    fireEvent.change(screen.getByRole("combobox", { name: "Web research provider" }), { target: { value: "openai" } });
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...settings, webResearchProvider: "openai" });
    expect(invokeTauriMock).not.toHaveBeenCalledWith("delete_perplexity_api_key", expect.anything());
  });
});

describe("SettingsView ElevenLabs account voices", () => {
  const accountVoice = (id: string, name: string, requiresVerification = false) => ({ id, name, requiresVerification });
  function desktop() {
    isTauriMock.mockReturnValue(true);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
  }
  function keyCard() { return within(screen.getByLabelText("ElevenLabs API key").closest(".setting-card") as HTMLElement); }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(yes => { resolve = yes; });
    return { promise, resolve };
  }
  it("loads account voices after saving a key without opening Studio, preserving labels and narration", async () => {
    desktop();
    const first = accountVoice("abcdefgh12345678", "Provider name"), second = accountVoice("ijklmnop12345678", "Another voice");
    invokeTauriMock.mockImplementation(async (command, args) => command === "elevenlabs_list_voices"
      ? args.nextPage ? { voices: [first, second], nextPage: null } : { voices: [first], nextPage: "next" } : undefined);
    const props = voiceSettingsProps();
    const settings = { ...defaultSettings, liveVoiceProvider: "elevenlabs" as const, speechVoice: "system" as const,
      elevenLabsVoiceId: first.id, elevenLabsVoices: [{ voiceId: first.id, name: "My reading voice" }] };
    const view = render(<SettingsView {...props} settings={settings}/>);
    expect(invokeTauriMock.mock.calls.filter(([command]) => command === "elevenlabs_list_voices")).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "test-key" } });
    fireEvent.click(keyCard().getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(props.onSaveElevenLabsApiKey).toHaveBeenCalledWith("test-key"));
    const connected = { ...settings, elevenLabsApiKeyConfigured: true };
    view.rerender(<SettingsView {...props} settings={connected}/>);
    const picker = screen.getByRole("combobox", { name: "ElevenLabs voice" });
    await waitFor(() => expect(picker).toBeEnabled());
    expect(within(picker).getAllByRole("option", { name: "My reading voice" })).toHaveLength(1);
    expect(within(picker).queryByRole("option", { name: "Provider name" })).not.toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: "Another voice" })).toBeInTheDocument();
    expect(props.onChange).not.toHaveBeenCalled();
    fireEvent.change(picker, { target: { value: second.id } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...connected, elevenLabsVoiceId: second.id,
      elevenLabsVoices: [...settings.elevenLabsVoices, { voiceId: second.id, name: second.name }] });
    expect(screen.getByRole("button", { name: "Open voice studio" })).toBeInTheDocument();
  });

  it("invalidates an old account load before replacing its key and explicitly resets an unavailable choice", async () => {
    desktop();
    const old = deferred<unknown>(), saved = deferred<void>(); let count = 0;
    invokeTauriMock.mockImplementation(async command => command === "elevenlabs_list_voices"
      ? ++count === 1 ? old.promise : { voices: [accountVoice("newvoice12345678", "New account voice")], nextPage: null } : undefined);
    const props = { ...voiceSettingsProps(), onSaveElevenLabsApiKey: vi.fn(() => saved.promise) };
    const settings = { ...defaultSettings, elevenLabsApiKeyConfigured: true, elevenLabsVoiceId: "oldvoice12345678",
      elevenLabsVoices: [{ voiceId: "oldvoice12345678", name: "My custom label" }] };
    render(<SettingsView {...props} settings={settings}/>);
    await waitFor(() => expect(count).toBe(1));
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "replacement-test-key" } });
    fireEvent.click(keyCard().getByRole("button", { name: "Save key" }));
    await act(async () => old.resolve({ voices: [accountVoice("oldvoice12345678", "Wrong old account")], nextPage: null }));
    expect(props.onChange).not.toHaveBeenCalled();
    await act(async () => saved.resolve());
    await screen.findByRole("option", { name: "New account voice" });
    expect(screen.queryByRole("option", { name: "Wrong old account" })).not.toBeInTheDocument();
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith({ ...settings, elevenLabsVoiceId: "" });
    expect(screen.getByText(/Using Orion default/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /My custom label/ })).toBeDisabled();
  });

  it("keeps saved choices on load failure, supports refresh and validation refresh, and disables unverified voices", async () => {
    desktop(); let fail = true;
    invokeTauriMock.mockImplementation(async command => {
      if (command !== "elevenlabs_list_voices") return;
      if (fail) throw new Error("Voice library access denied");
      return { voices: [accountVoice("savedvoice123456", "Available"), accountVoice("pendingvoice1234", "Pending clone", true)], nextPage: null };
    });
    const props = voiceSettingsProps(), settings = { ...defaultSettings, elevenLabsApiKeyConfigured: true, elevenLabsVoiceId: "savedvoice123456" };
    render(<SettingsView {...props} settings={settings}/>);
    await screen.findByText("Voice library access denied");
    expect(props.onChange).not.toHaveBeenCalled();
    fail = false; fireEvent.click(screen.getByRole("button", { name: "Refresh voices" }));
    expect(await screen.findByRole("option", { name: "Pending clone · Verification required" })).toBeDisabled();
    expect(props.onChange).not.toHaveBeenCalled();
    const calls = invokeTauriMock.mock.calls.filter(([command]) => command === "elevenlabs_list_voices").length;
    fireEvent.click(keyCard().getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(invokeTauriMock.mock.calls.filter(([command]) => command === "elevenlabs_list_voices")).toHaveLength(calls + 1));
  });

  it("ignores catalog completion after key removal or unmount", async () => {
    desktop(); const pending = deferred<unknown>();
    invokeTauriMock.mockImplementation(async command => command === "elevenlabs_list_voices" ? pending.promise : undefined);
    const props = voiceSettingsProps(), settings = { ...defaultSettings, elevenLabsApiKeyConfigured: true, elevenLabsVoiceId: "oldvoice12345678" };
    const view = render(<SettingsView {...props} settings={settings}/>);
    view.rerender(<SettingsView {...props} settings={{ ...settings, elevenLabsApiKeyConfigured: false }}/>);
    await act(async () => pending.resolve({ voices: [], nextPage: null }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Refresh voices" })).not.toBeInTheDocument();
    const late = deferred<unknown>(); invokeTauriMock.mockImplementation(async command => command === "elevenlabs_list_voices" ? late.promise : undefined);
    view.rerender(<SettingsView {...props} settings={settings}/>); view.unmount();
    await act(async () => late.resolve({ voices: [], nextPage: null }));
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("preserves a newer explicit voice selection while a previous catalog request finishes", async () => {
    desktop(); const pending = deferred<unknown>();
    invokeTauriMock.mockImplementation(async command => command === "elevenlabs_list_voices" ? pending.promise : undefined);
    const props = voiceSettingsProps(), settings = { ...defaultSettings, elevenLabsApiKeyConfigured: true, elevenLabsVoiceId: "oldvoice12345678" };
    const view = render(<SettingsView {...props} settings={settings}/>);
    view.rerender(<SettingsView {...props} settings={{ ...settings, elevenLabsVoiceId: "newvoice12345678" }}/>);
    await act(async () => pending.resolve({ voices: [], nextPage: null }));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "ElevenLabs voice" })).toHaveValue("newvoice12345678");
  });

  it("closes Studio and invalidates its pending account requests during a key replacement", async () => {
    desktop(); const models = deferred<unknown>(), save = deferred<void>();
    invokeTauriMock.mockImplementation(async command => command === "elevenlabs_list_voices" ? { voices: [], nextPage: null }
      : command === "elevenlabs_voice_models" ? models.promise : undefined);
    const props = { ...voiceSettingsProps(), onSaveElevenLabsApiKey: vi.fn(() => save.promise) };
    render(<SettingsView {...props} settings={{ ...defaultSettings, elevenLabsApiKeyConfigured: true }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    expect(screen.getByRole("button", { name: "Close voice studio" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("ElevenLabs API key"), { target: { value: "replacement-test-key" } });
    fireEvent.click(keyCard().getByRole("button", { name: "Save key" }));
    expect(screen.getByRole("button", { name: "Open voice studio" })).toBeDisabled();
    await act(async () => models.resolve([]));
    expect(screen.queryByRole("button", { name: "Close voice studio" })).not.toBeInTheDocument();
    await act(async () => save.resolve());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open voice studio" })).toBeEnabled());
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

function voiceSettingsProps(onChange = vi.fn()) {
  const action = vi.fn(async () => undefined);
  const testKey = vi.fn(async () => ({ valid: true, message: "Connected." }));
  return {
    onChange, onSaveApiKey: action, onDeleteApiKey: action, onTestApiKey: testKey,
    onSaveAnthropicApiKey: action, onDeleteAnthropicApiKey: action, onTestAnthropicApiKey: testKey,
    onSaveElevenLabsApiKey: action, onDeleteElevenLabsApiKey: action, onTestElevenLabsApiKey: testKey,
    onOpenDataLocation: vi.fn(), onEraseVault: vi.fn(),
  };
}

describe("SettingsView voice conversations", () => {
  it("keeps ElevenLabs conversation voice when choosing System narration", () => {
    const settings = { ...defaultSettings, liveVoiceProvider: "elevenlabs" as const,
      speechVoice: "elevenlabs" as const, elevenLabsApiKeyConfigured: true };
    const props = voiceSettingsProps();
    render(<SettingsView {...props} settings={settings}/>);
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Voice" })).getByRole("radio", { name: "System" }));
    expect(props.onChange).toHaveBeenLastCalledWith({ ...settings, speechVoice: "system" });
    expect(screen.getByText(/Choose how notes and decks are read aloud/)).toBeVisible();
    expect(screen.queryByText(/Play uses ElevenLabs whenever/)).not.toBeInTheDocument();
  });

  it("defaults legacy settings to OpenAI and changes conversation provider without changing narration or voice", () => {
    const settings = { ...defaultSettings, liveVoiceProvider: undefined, speechVoice: "openai" as const, elevenLabsVoiceId: "JBFqnCBsd6RMkjVDRZzb" };
    const props = voiceSettingsProps();
    const view = render(<SettingsView {...props} settings={settings}/>);
    const group = within(screen.getByRole("radiogroup", { name: "Voice conversation provider" }));
    expect(group.getByRole("radio", { name: "OpenAI" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(group.getByRole("radio", { name: "ElevenLabs" }));
    expect(props.onChange).toHaveBeenLastCalledWith({ ...settings, liveVoiceProvider: "elevenlabs" });
    view.rerender(<SettingsView {...props} settings={{ ...settings, liveVoiceProvider: "elevenlabs" }}/>);
    expect(group.getByRole("radio", { name: "ElevenLabs" })).toHaveAttribute("aria-checked", "true");
    expect(within(screen.getByRole("radiogroup", { name: "Voice" })).getByRole("radio", { name: "OpenAI" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(group.getByRole("radio", { name: "OpenAI" }));
    expect(props.onChange).toHaveBeenLastCalledWith({ ...settings, liveVoiceProvider: "openai" });
  });

  it("guides ElevenLabs conversation setup and keeps research on Intelligence", () => {
    const settings = { ...defaultSettings, liveVoiceProvider: "elevenlabs" as const, apiKeyConfigured: false, chatgptConfigured: true };
    const props = voiceSettingsProps();
    const view = render(<SettingsView {...props} settings={settings}/>);
    expect(screen.getByText(/Add your ElevenLabs API key below to start voice conversations/)).toBeVisible();
    expect(screen.getByText(/Research continues to use your Intelligence connection/)).toBeVisible();
    view.rerender(<SettingsView {...props} settings={{ ...settings, elevenLabsApiKeyConfigured: true }}/>);
    expect(screen.queryByText(/Add your ElevenLabs API key below to start voice conversations/)).not.toBeInTheDocument();
    expect(screen.getByText("Uses the ElevenLabs voice selected below.")).toBeVisible();
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("does not describe a ChatGPT plan connection as an OpenAI live voice key", () => {
    const props = voiceSettingsProps();
    const settings = { ...defaultSettings, liveVoiceProvider: "openai" as const, chatgptConfigured: true, apiKeyConfigured: false };
    const view = render(<SettingsView {...props} settings={settings}/>);
    expect(screen.getByText(/A ChatGPT plan connection does not include live voice/)).toBeVisible();
    view.rerender(<SettingsView {...props} settings={{ ...settings, apiKeyConfigured: true }}/>);
    expect(screen.getByText("Uses your OpenAI API key for live voice.")).toBeVisible();
    expect(props.onChange).not.toHaveBeenCalled();
  });
});

describe("SettingsView current OpenAI models", () => {
  it.each([
    ["GPT-6.1 Sol", "gpt-6.1-sol"],
    ["GPT-6.1 Terra", "gpt-6.1-terra"],
    ["GPT-6 Luna", "gpt-6-luna"],
  ])("selects %s without changing reasoning or voice preferences", (name, model) => {
    const props = voiceSettingsProps();
    const settings = { ...defaultSettings, reasoningEffort: "medium" as const, liveVoiceProvider: "elevenlabs" as const };
    render(<SettingsView {...props} settings={settings}/>);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) }));
    expect(props.onChange).toHaveBeenLastCalledWith({ ...settings, model });
  });

  it.each([
    ["GPT-5.6 Sol", "gpt-5.6-sol"],
    ["GPT-5.6 Terra", "gpt-5.6-terra"],
    ["GPT-5.6 Luna", "gpt-5.6-luna"],
  ])("preserves a saved %s choice without migrating it", (name, model) => {
    const props = voiceSettingsProps();
    render(<SettingsView {...props} settings={{ ...defaultSettings, model }}/>);
    expect(screen.getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Saved selection")).toHaveLength(1);
    expect(props.onChange).not.toHaveBeenCalled();
  });
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

    fireEvent.click(screen.getByRole("button", { name: /GPT-6\.1 Sol/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...settings, model: "gpt-6.1-sol", reasoningEffort: "high" });
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
