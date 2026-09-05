import {
  Bot,
  Cable,
  Check,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Mic2,
  Palette,
  Volume2,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "../lib/icons";
import { useEffect, useState, type CSSProperties } from "react";
import { SavedVoicesSetting } from "./SavedVoicesSetting";
import { AssistantConnections } from "./AssistantConnections";
import type { AssistantJob } from "../lib/assistant/types";
import type { WorkspaceInfo } from "../types";
import { AtmosphereColorPicker } from "./AtmosphereColorPicker";
import {
  atmosphereMotionOptions,
  atmosphereToneOptions,
  resolveAtmospherePalette,
} from "../lib/homeAtmosphere";
import {
  resolveThemeMode,
  resolveThemePalette,
  themeAccentOptions,
  themeCanvasOptions,
  themeContrastOptions,
  themePresetOptions,
  themeSurfaceOptions,
  themeWarmthOptions,
  type ThemePalette,
} from "../lib/theme";
import {
  checkTranscriptionSetup,
  isTauriRuntime,
  openClaudeConnector,
  openCodexPlugin,
} from "../lib/storage";
import type {
  HomeAtmosphere,
  ReasoningEffort,
  Settings,
} from "../types";

interface ThemeChoiceOption<T extends string> {
  id: T;
  name: string;
}

function ThemeChoiceGroup<T extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: ReadonlyArray<ThemeChoiceOption<T>>;
  value: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="theme-choice-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          className={option.id === value ? "active" : ""}
          onClick={() => onSelect(option.id)}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

function ThemeColorOverride({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  const selected = value || fallback;
  return (
    <div className={`theme-color-override${value ? " active" : ""}`}>
      <label>
        <input
          type="color"
          aria-label={`Custom ${label} color`}
          value={selected}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
        <span>
          <strong>Custom</strong>
          <small>{value || "Preset"}</small>
        </span>
      </label>
      {value ? (
        <button
          type="button"
          aria-label={`Reset custom ${label} color`}
          onClick={() => onChange("")}
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}

interface SettingsViewProps {
  settings: Settings;
  spaces?: WorkspaceInfo[];
  assistantJobs?: AssistantJob[];
  onCancelAssistantJob?: (job: AssistantJob) => Promise<void>;
  themePalette?: ThemePalette;
  onChange: (settings: Settings) => void;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onDeleteApiKey: () => Promise<void>;
  onTestApiKey: () => Promise<{ valid: boolean; message: string }>;
  onSaveAnthropicApiKey: (apiKey: string) => Promise<void>;
  onDeleteAnthropicApiKey: () => Promise<void>;
  onTestAnthropicApiKey: () => Promise<{ valid: boolean; message: string }>;
  onSaveElevenLabsApiKey: (apiKey: string) => Promise<void>;
  onDeleteElevenLabsApiKey: () => Promise<void>;
  onTestElevenLabsApiKey: () => Promise<{ valid: boolean; message: string }>;
  onOpenDataLocation: () => void;
  onEraseVault: () => void;
}

const models = [
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "OpenAI",
    description: "Advanced reasoning for complex research and synthesis.",
    badge: "Most capable",
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "OpenAI",
    description: "Frontier quality for the most nuanced source material.",
    badge: "Best quality",
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "OpenAI",
    description: "A strong balance of intelligence, speed, and cost.",
    badge: "Balanced",
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "OpenAI",
    description: "Efficient for large, straightforward collections.",
    badge: "Efficient",
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "Anthropic",
    description: "Highest capability for long-running synthesis and research.",
    badge: "Most capable",
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "Anthropic",
    description: "Deep reasoning for complex projects and difficult material.",
    badge: "Deep work",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "Anthropic",
    description: "Fast frontier intelligence with a balanced cost profile.",
    badge: "Balanced",
  },
];

const atmosphereOptions: Array<{
  id: HomeAtmosphere;
  name: string;
  description: string;
}> = [
  {
    id: "line-waves",
    name: "Line Waves",
    description: "Fine contours flow through a quiet warped field.",
  },
  {
    id: "signal-decay",
    name: "Signal Decay",
    description: "Clean harmonics loosen into warm, responsive noise.",
  },
  {
    id: "field",
    name: "Field",
    description: "A precise dot matrix that responds to movement.",
  },
  {
    id: "quiet-loom",
    name: "Quiet Loom",
    description: "Woven light folds into a softly moving veil.",
  },
  {
    id: "nova",
    name: "Nova",
    description: "A living plasma core, spiralling light, and streaming sparks.",
  },
  {
    id: "flux",
    name: "Flux",
    description: "Luminous currents sweep from edge to edge.",
  },
  {
    id: "tidal-glass",
    name: "Tidal Glass",
    description: "Liquid light refracts into a shifting web of caustics.",
  },
  {
    id: "prism-drift",
    name: "Prism Drift",
    description: "A rolling landscape of iridescent crystal facets.",
  },
  {
    id: "nebula",
    name: "Nebula",
    description: "Layered clouds of light drift through a field of stars.",
  },
  {
    id: "emberwake",
    name: "Emberwake",
    description: "Streams of glowing sparks ride a sweeping wind.",
  },
  {
    id: "gravity-silk",
    name: "Gravity Silk",
    description: "Glossy fabric billows through luminous folds.",
  },
  {
    id: "mirage",
    name: "Mirage",
    description: "Drifting glass lenses bend a travelling sheet of light.",
  },
];

export function SettingsView({
  settings,
  spaces = [],
  assistantJobs = [],
  onCancelAssistantJob,
  themePalette,
  onChange,
  onSaveApiKey,
  onDeleteApiKey,
  onTestApiKey,
  onSaveAnthropicApiKey,
  onDeleteAnthropicApiKey,
  onTestAnthropicApiKey,
  onSaveElevenLabsApiKey,
  onDeleteElevenLabsApiKey,
  onTestElevenLabsApiKey,
  onOpenDataLocation,
  onEraseVault,
}: SettingsViewProps) {
  const [apiKey, setApiKey] = useState("");
  const [revealKey, setRevealKey] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [revealAnthropicKey, setRevealAnthropicKey] = useState(false);
  const [anthropicKeyBusy, setAnthropicKeyBusy] = useState(false);
  const [anthropicKeyMessage, setAnthropicKeyMessage] = useState<string | null>(
    null,
  );
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState("");
  const [revealElevenLabsKey, setRevealElevenLabsKey] = useState(false);
  const [elevenLabsKeyBusy, setElevenLabsKeyBusy] = useState(false);
  const [elevenLabsKeyMessage, setElevenLabsKeyMessage] = useState<
    string | null
  >(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [claudeConnectorBusy, setClaudeConnectorBusy] = useState(false);
  const [claudeConnectorMessage, setClaudeConnectorMessage] = useState<
    string | null
  >(null);
  const [codexPluginBusy, setCodexPluginBusy] = useState(false);
  const [codexPluginMessage, setCodexPluginMessage] = useState<string | null>(
    null,
  );
  const [activeSection, setActiveSection] = useState<
    | "intelligence"
    | "voice"
    | "claude"
    | "transcription"
    | "linking"
    | "appearance"
    | "data"
  >("intelligence");
  const desktopRuntime = isTauriRuntime();
  const prefersLight =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const previewMode = resolveThemeMode(
    settings.theme,
    prefersLight,
  );
  const activeThemePalette =
    themePalette ?? resolveThemePalette(settings, previewMode);
  const activeAtmospherePalette = resolveAtmospherePalette(
    settings.homeAtmosphere,
    settings.homeAtmosphereTone,
    activeThemePalette,
    settings.homeAtmosphereCustomColor,
    settings.homeAtmosphereCustomSecondaryColor,
  );

  useEffect(() => {
    setKeyMessage(null);
  }, [settings.apiKeyConfigured]);

  useEffect(() => {
    setAnthropicKeyMessage(null);
  }, [settings.anthropicApiKeyConfigured]);

  useEffect(() => {
    setElevenLabsKeyMessage(null);
  }, [settings.elevenLabsApiKeyConfigured]);

  function patch(patchValue: Partial<Settings>) {
    onChange({ ...settings, ...patchValue });
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      await onSaveApiKey(apiKey.trim());
      setApiKey("");
      setKeyMessage(
        desktopRuntime
          ? "Saved securely in your system keychain."
          : "Available for this browser tab only; reload clears it.",
      );
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  }

  async function testKey() {
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      const result = await onTestApiKey();
      setKeyMessage(result.message);
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setKeyBusy(false);
    }
  }

  async function saveClaudeKey() {
    if (!anthropicApiKey.trim()) return;
    setAnthropicKeyBusy(true);
    setAnthropicKeyMessage(null);
    try {
      await onSaveAnthropicApiKey(anthropicApiKey.trim());
      setAnthropicApiKey("");
      setAnthropicKeyMessage(
        desktopRuntime
          ? "Saved securely in your system keychain."
          : "Available for this browser tab only; reload clears it.",
      );
    } catch (error) {
      setAnthropicKeyMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setAnthropicKeyBusy(false);
    }
  }

  async function testClaudeKey() {
    setAnthropicKeyBusy(true);
    setAnthropicKeyMessage(null);
    try {
      const result = await onTestAnthropicApiKey();
      setAnthropicKeyMessage(result.message);
    } catch (error) {
      setAnthropicKeyMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setAnthropicKeyBusy(false);
    }
  }

  async function saveElevenLabsKey() {
    if (!elevenLabsApiKey.trim()) return;
    setElevenLabsKeyBusy(true);
    setElevenLabsKeyMessage(null);
    try {
      await onSaveElevenLabsApiKey(elevenLabsApiKey.trim());
      setElevenLabsApiKey("");
      setElevenLabsKeyMessage(
        desktopRuntime
          ? "Saved securely in your system keychain."
          : "Available for this browser tab only; reload clears it.",
      );
    } catch (error) {
      setElevenLabsKeyMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setElevenLabsKeyBusy(false);
    }
  }

  async function testElevenLabsKey() {
    setElevenLabsKeyBusy(true);
    setElevenLabsKeyMessage(null);
    try {
      const result = await onTestElevenLabsApiKey();
      setElevenLabsKeyMessage(result.message);
    } catch (error) {
      setElevenLabsKeyMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setElevenLabsKeyBusy(false);
    }
  }

  async function checkLocalTools() {
    setSetupBusy(true);
    setSetupMessage(null);
    try {
      const status = await checkTranscriptionSetup();
      setSetupMessage(status.message);
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSetupBusy(false);
    }
  }

  async function installClaudeConnector() {
    setClaudeConnectorBusy(true);
    setClaudeConnectorMessage(null);
    try {
      await openClaudeConnector();
      setClaudeConnectorMessage(
        "Claude Desktop should now ask you to install the Orion extension.",
      );
    } catch (error) {
      setClaudeConnectorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setClaudeConnectorBusy(false);
    }
  }

  async function installCodexPlugin() {
    setCodexPluginBusy(true);
    setCodexPluginMessage(null);
    try {
      await openCodexPlugin();
      setCodexPluginMessage(
        "Codex should now show Orion’s plugin page. Choose Install to connect your atlas.",
      );
    } catch (error) {
      setCodexPluginMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setCodexPluginBusy(false);
    }
  }

  return (
    <div className="view settings-view">
      <div className="view-title-row">
        <div>
          <span className="eyebrow neutral">Preferences</span>
          <h1>Settings</h1>
          <p>Make Orion feel like your own observatory.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <a
            href="#intelligence"
            className={activeSection === "intelligence" ? "active" : ""}
            onClick={() => setActiveSection("intelligence")}
          >
            <Bot size={15} /> Intelligence
          </a>
          <a
            href="#voice"
            className={activeSection === "voice" ? "active" : ""}
            onClick={() => setActiveSection("voice")}
          >
            <Volume2 size={15} /> Voice
          </a>
          <a
            href="#claude"
            className={activeSection === "claude" ? "active" : ""}
            onClick={() => setActiveSection("claude")}
          >
            <Cable size={15} /> Connections
          </a>
          <a
            href="#transcription"
            className={activeSection === "transcription" ? "active" : ""}
            onClick={() => setActiveSection("transcription")}
          >
            <Mic2 size={15} /> Transcription
          </a>
          <a
            href="#linking"
            className={activeSection === "linking" ? "active" : ""}
            onClick={() => setActiveSection("linking")}
          >
            <Link2 size={15} /> Linking
          </a>
          <a
            href="#appearance"
            className={activeSection === "appearance" ? "active" : ""}
            onClick={() => setActiveSection("appearance")}
          >
            <Palette size={15} /> Appearance
          </a>
          <a
            href="#data"
            className={activeSection === "data" ? "active" : ""}
            onClick={() => setActiveSection("data")}
          >
            <Database size={15} /> Data & privacy
          </a>
        </nav>

        <div className="settings-content">
          <section className="settings-section" id="intelligence">
            <div className="settings-section-title">
              <span className="settings-icon violet">
                <Bot size={18} />
              </span>
              <span>
                <h2>OpenAI connection</h2>
                <p>Used for AI organisation, inline writing, and Chat.</p>
              </span>
            </div>

            <div className="setting-card api-key-card">
              <div className="setting-row">
                <span>
                  <strong>API key</strong>
                  <small>
                    {settings.apiKeyConfigured
                      ? "A key is configured in your OS keychain."
                      : "No key configured. Manual notes and imports still work."}
                  </small>
                </span>
                <span
                  className={
                    settings.apiKeyConfigured
                      ? "status-pill success"
                      : "status-pill"
                  }
                >
                  {settings.apiKeyConfigured ? (
                    <>
                      <Check size={12} /> Connected
                    </>
                  ) : (
                    "Not configured"
                  )}
                </span>
              </div>
              <div className="api-key-input-row">
                <label>
                  <KeyRound size={15} />
                  <input
                    type={revealKey ? "text" : "password"}
                    aria-label="OpenAI API key"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={
                      settings.apiKeyConfigured
                        ? "Enter a new key to replace it"
                        : "sk-proj-…"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setRevealKey((value) => !value)}
                    aria-label={revealKey ? "Hide API key" : "Show API key"}
                  >
                    {revealKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </label>
                <button
                  className="button primary compact"
                  type="button"
                  onClick={saveKey}
                  disabled={!apiKey.trim() || keyBusy}
                >
                  {keyBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <LockKeyhole size={14} />
                  )}
                  Save key
                </button>
              </div>
              <div className="api-key-actions">
                <span>
                  <ShieldCheck size={13} />
                  {desktopRuntime
                    ? "Orion never writes the key to your vault or logs."
                    : "Browser preview keeps the key in memory only, until reload."}
                </span>
                {settings.apiKeyConfigured && (
                  <span>
                    <button type="button" onClick={testKey} disabled={keyBusy}>
                      Test connection
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={async () => {
                        setKeyBusy(true);
                        setKeyMessage(null);
                        try {
                          await onDeleteApiKey();
                          setKeyMessage("The saved API key was removed.");
                        } catch (error) {
                          setKeyMessage(
                            error instanceof Error
                              ? error.message
                              : String(error),
                          );
                        } finally {
                          setKeyBusy(false);
                        }
                      }}
                      disabled={keyBusy}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
              {keyMessage && <p className="setting-message">{keyMessage}</p>}
            </div>

            <div className="setting-card">
              <div className="setting-row vertical">
                <span>
                  <strong>Intelligence model</strong>
                  <small>
                    Choose the trade-off you prefer. You can change this any time.
                  </small>
                </span>
                <div className="model-options">
                  {models.map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={settings.model === model.id ? "active" : ""}
                      aria-pressed={settings.model === model.id}
                      onClick={() =>
                        patch({
                          model: model.id,
                          reasoningEffort:
                            model.id === "gpt-6-astra" &&
                            settings.reasoningEffort === "none"
                              ? "low"
                              : settings.reasoningEffort,
                        })
                      }
                    >
                      <i>
                        {settings.model === model.id && <Check size={13} />}
                      </i>
                      <span>
                        <strong>{model.name}</strong>
                        <small>
                          {model.provider} · {model.description}
                        </small>
                      </span>
                      <em>{model.badge}</em>
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row divided">
                <span>
                  <strong>Reasoning depth</strong>
                  <small>Low is a good baseline for structured imports.</small>
                </span>
                <select
                  aria-label="Reasoning depth"
                  value={settings.reasoningEffort}
                  onChange={(event) =>
                    patch({
                      reasoningEffort: event.target.value as ReasoningEffort,
                    })
                  }
                >
                  <option value="none" disabled={settings.model === "gpt-6-astra"}>
                    None
                  </option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra high</option>
                </select>
              </div>
              <label className="setting-row divided">
                <span>
                  <strong>Use existing note context</strong>
                  <small>
                    Let Orion locally find relevant note digests, then open only
                    the exact notes its router selects. Turn this off to send no
                    existing Space context during imports or enrichment.
                  </small>
                </span>
                <input
                  className="switch"
                  type="checkbox"
                  checked={settings.includeExistingNotesInAIContext}
                  onChange={(event) =>
                    patch({
                      includeExistingNotesInAIContext: event.target.checked,
                    })
                  }
                />
              </label>
              <label className="setting-row divided">
                <span>
                  <strong>Fall back to your other provider</strong>
                  <small>
                    Use your other configured provider automatically when one
                    fails mid-import.
                  </small>
                </span>
                <input
                  className="switch"
                  type="checkbox"
                  checked={settings.providerFailoverEnabled}
                  onChange={(event) =>
                    patch({
                      providerFailoverEnabled: event.target.checked,
                    })
                  }
                />
              </label>
            </div>

            <label className="setting-card prompt-setting">
              <span>
                <strong>Organisation guidance</strong>
                <small>
                  A light touch works best. Orion already asks for sourced,
                  durable wiki notes.
                </small>
              </span>
              <textarea
                value={settings.organizationInstructions}
                onChange={(event) =>
                  patch({ organizationInstructions: event.target.value })
                }
                rows={4}
              />
            </label>
          </section>

          <section className="settings-section" id="voice">
            <div className="settings-section-title">
              <span className="settings-icon violet">
                <Volume2 size={18} />
              </span>
              <span>
                <h2>Voice</h2>
                <p>
                  Used only to speak notes and narrated slide decks. Writing,
                  import, and Chat never use this key.
                </p>
              </span>
            </div>

            <div className="setting-card">
              <div className="setting-row">
                <span>
                  <strong>Who speaks</strong>
                  <small>
                    Play uses ElevenLabs whenever that key is saved. OpenAI
                    remains an explicit choice.
                  </small>
                </span>
              </div>
              <div
                className="segmented-control labelled"
                role="radiogroup"
                aria-label="Voice"
              >
                {(
                  [
                    ["system", "System"],
                    ["openai", "OpenAI"],
                    ["elevenlabs", "ElevenLabs"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={settings.speechVoice === id}
                    className={settings.speechVoice === id ? "active" : ""}
                    onClick={() => patch({ speechVoice: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <SavedVoicesSetting settings={settings} onChange={patch} />

            <div className="setting-card api-key-card">
              <div className="setting-row">
                <span>
                  <strong>ElevenLabs API key</strong>
                  <small>
                    {settings.elevenLabsApiKeyConfigured
                      ? "A key is configured in your OS keychain."
                      : "Optional. Improves narration when you generate a spoken deck."}
                  </small>
                </span>
                <span
                  className={
                    settings.elevenLabsApiKeyConfigured
                      ? "status-pill success"
                      : "status-pill"
                  }
                >
                  {settings.elevenLabsApiKeyConfigured ? (
                    <>
                      <Check size={12} /> Connected
                    </>
                  ) : (
                    "Not configured"
                  )}
                </span>
              </div>
              <div className="api-key-input-row">
                <label>
                  <KeyRound size={15} />
                  <input
                    type={revealElevenLabsKey ? "text" : "password"}
                    aria-label="ElevenLabs API key"
                    value={elevenLabsApiKey}
                    onChange={(event) =>
                      setElevenLabsApiKey(event.target.value)
                    }
                    placeholder={
                      settings.elevenLabsApiKeyConfigured
                        ? "Enter a new key to replace it"
                        : "sk_…"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setRevealElevenLabsKey((value) => !value)
                    }
                    aria-label={
                      revealElevenLabsKey
                        ? "Hide ElevenLabs API key"
                        : "Show ElevenLabs API key"
                    }
                  >
                    {revealElevenLabsKey ? (
                      <EyeOff size={15} />
                    ) : (
                      <Eye size={15} />
                    )}
                  </button>
                </label>
                <button
                  className="button primary compact"
                  type="button"
                  onClick={() => void saveElevenLabsKey()}
                  disabled={!elevenLabsApiKey.trim() || elevenLabsKeyBusy}
                >
                  {elevenLabsKeyBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <LockKeyhole size={14} />
                  )}
                  Save key
                </button>
              </div>
              <div className="api-key-actions">
                <span>
                  <ShieldCheck size={13} />
                  {desktopRuntime
                    ? "Stored separately from your writing keys in macOS Keychain."
                    : "Browser preview keeps the key in memory only, until reload."}
                </span>
                {settings.elevenLabsApiKeyConfigured && (
                  <span>
                    <button
                      type="button"
                      onClick={() => void testElevenLabsKey()}
                      disabled={elevenLabsKeyBusy}
                    >
                      Test connection
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={async () => {
                        setElevenLabsKeyBusy(true);
                        setElevenLabsKeyMessage(null);
                        try {
                          await onDeleteElevenLabsApiKey();
                          setElevenLabsKeyMessage(
                            "The saved ElevenLabs key was removed.",
                          );
                        } catch (error) {
                          setElevenLabsKeyMessage(
                            error instanceof Error
                              ? error.message
                              : String(error),
                          );
                        } finally {
                          setElevenLabsKeyBusy(false);
                        }
                      }}
                      disabled={elevenLabsKeyBusy}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
              {elevenLabsKeyMessage ? (
                <p className="setting-message">{elevenLabsKeyMessage}</p>
              ) : null}
            </div>
          </section>

          <section className="settings-section" id="claude">
            <div className="settings-section-title">
              <span className="settings-icon indigo">
                <Cable size={18} />
              </span>
              <span>
                <h2>Claude &amp; Codex</h2>
                <p>Bring your Orion Spaces into either assistant.</p>
              </span>
            </div>

            <div className="setting-card api-key-card">
              <div className="setting-row">
                <span>
                  <strong>Anthropic API key</strong>
                  <small>
                    {settings.anthropicApiKeyConfigured
                      ? "One saved key can use Fable 5, Opus 5, or Sonnet 5."
                      : "Add one key to use Orion’s Claude 5 model choices."}
                  </small>
                </span>
                <span
                  className={
                    settings.anthropicApiKeyConfigured
                      ? "status-pill success"
                      : "status-pill"
                  }
                >
                  {settings.anthropicApiKeyConfigured ? (
                    <>
                      <Check size={12} /> Connected
                    </>
                  ) : (
                    "Not configured"
                  )}
                </span>
              </div>
              <div className="api-key-input-row">
                <label>
                  <KeyRound size={15} />
                  <input
                    type={revealAnthropicKey ? "text" : "password"}
                    aria-label="Anthropic API key"
                    value={anthropicApiKey}
                    onChange={(event) =>
                      setAnthropicApiKey(event.target.value)
                    }
                    placeholder={
                      settings.anthropicApiKeyConfigured
                        ? "Enter a new key to replace it"
                        : "sk-ant-api03-…"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setRevealAnthropicKey((value) => !value)
                    }
                    aria-label={
                      revealAnthropicKey
                        ? "Hide Anthropic API key"
                        : "Show Anthropic API key"
                    }
                  >
                    {revealAnthropicKey ? (
                      <EyeOff size={15} />
                    ) : (
                      <Eye size={15} />
                    )}
                  </button>
                </label>
                <button
                  className="button primary compact"
                  type="button"
                  onClick={saveClaudeKey}
                  disabled={!anthropicApiKey.trim() || anthropicKeyBusy}
                >
                  {anthropicKeyBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <LockKeyhole size={14} />
                  )}
                  Save key
                </button>
              </div>
              <div className="api-key-actions">
                <span>
                  <ShieldCheck size={13} />
                  {desktopRuntime
                    ? "Stored separately from your OpenAI key in macOS Keychain."
                    : "Browser preview keeps the key in memory only, until reload."}
                </span>
                {settings.anthropicApiKeyConfigured && (
                  <span>
                    <button
                      type="button"
                      onClick={testClaudeKey}
                      disabled={anthropicKeyBusy}
                    >
                      Test connection
                    </button>
                    <button
                      type="button"
                      className="danger-text"
                      onClick={async () => {
                        setAnthropicKeyBusy(true);
                        setAnthropicKeyMessage(null);
                        try {
                          await onDeleteAnthropicApiKey();
                          setAnthropicKeyMessage(
                            "The saved Anthropic API key was removed.",
                          );
                        } catch (error) {
                          setAnthropicKeyMessage(
                            error instanceof Error
                              ? error.message
                              : String(error),
                          );
                        } finally {
                          setAnthropicKeyBusy(false);
                        }
                      }}
                      disabled={anthropicKeyBusy}
                    >
                      Remove
                    </button>
                  </span>
                )}
              </div>
              {anthropicKeyMessage && (
                <p className="setting-message">{anthropicKeyMessage}</p>
              )}
            </div>

            <div className="setting-card claude-connector-card">
              <div className="claude-connector-intro">
                <span>
                  <strong>Your atlas, available where you think</strong>
                  <small>
                    Claude and Codex can find Spaces, search concepts, and read
                    the notes or source passages you ask about. They can also
                    create, edit, and delete notes directly in the Space you
                    choose. These local tools work without an Orion API key.
                  </small>
                </span>
                <span className="status-pill success">
                  <ShieldCheck size={12} /> Local library
                </span>
              </div>

              <div className="claude-connector-capabilities">
                <span>Space-aware search</span>
                <span>Direct note editing</span>
                <span>Clickable citations</span>
                <span>Bounded source evidence</span>
              </div>

              <div className="connector-install-options">
                <div className="connector-install-option">
                  <span>
                    <strong>Claude Desktop</strong>
                    <small>
                      Add Orion as a local extension. Open Orion once and your
                      atlas is ready—there are no folders or paths to configure.
                    </small>
                  </span>
                  <button
                    className="button primary compact"
                    type="button"
                    aria-busy={claudeConnectorBusy}
                    disabled={!desktopRuntime || claudeConnectorBusy}
                    onClick={installClaudeConnector}
                  >
                    {claudeConnectorBusy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <ExternalLink size={14} />
                    )}
                    Install in Claude
                  </button>
                  {claudeConnectorMessage && (
                    <p className="setting-message" role="status">
                      {claudeConnectorMessage}
                    </p>
                  )}
                </div>

                <div className="connector-install-option">
                  <span>
                    <strong>Codex</strong>
                    <small>
                      Open Orion’s bundled plugin in Codex, then choose Install.
                      It connects to the same local atlas automatically.
                    </small>
                  </span>
                  <button
                    className="button primary compact"
                    type="button"
                    aria-busy={codexPluginBusy}
                    disabled={!desktopRuntime || codexPluginBusy}
                    onClick={installCodexPlugin}
                  >
                    {codexPluginBusy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <ExternalLink size={14} />
                    )}
                    Install in Codex
                  </button>
                  {codexPluginMessage && (
                    <p className="setting-message" role="status">
                      {codexPluginMessage}
                    </p>
                  )}
                </div>
              </div>
              {!desktopRuntime && (
                <p className="setting-message">
                  Claude and Codex installation is available in the installed
                  Orion desktop app.
                </p>
              )}
            </div>
            <AssistantConnections access={settings.assistantAccess} spaces={spaces} jobs={assistantJobs} desktop={desktopRuntime}
              onChange={(assistantAccess) => onChange({ ...settings, assistantAccess })} onCancel={onCancelAssistantJob} />
          </section>

          <section className="settings-section" id="transcription">
            <div className="settings-section-title">
              <span className="settings-icon coral">
                <Mic2 size={18} />
              </span>
              <span>
                <h2>Local transcription</h2>
                <p>Turn recordings and YouTube videos into source notes.</p>
              </span>
            </div>

            <div className="setting-card transcription-card">
              <div className="transcription-callout">
                <span>
                  <Mic2 size={18} />
                </span>
                <div>
                  <strong>Private, bundled, and on-device</strong>
                  <small>
                    Orion includes its own Whisper engine and multilingual
                    model. Local recordings work without internet and never
                    leave this Mac. There is no server, API key, Homebrew
                    package, or Python setup.
                  </small>
                </div>
              </div>
              <div className="transcription-fields">
                <div className="transcription-field transcription-field--wide">
                  <span>On-device engine</span>
                  <strong>Whisper small · multilingual</strong>
                  <small className="transcription-field-hint">
                    Metal-accelerated through whisper.cpp and packaged inside
                    Orion.
                  </small>
                </div>
                <label className="transcription-field">
                  <span>Language · optional</span>
                  <input
                    type="text"
                    value={settings.whisperLanguage}
                    spellCheck={false}
                    placeholder="Auto-detect"
                    onChange={(event) => {
                      patch({ whisperLanguage: event.target.value });
                      setSetupMessage(null);
                    }}
                  />
                </label>
                <div className="transcription-field">
                  <span>YouTube toolkit</span>
                  <strong>yt-dlp + Deno · included</strong>
                  <small className="transcription-field-hint">
                    Orion supplies both executables and uses no shell PATH.
                    YouTube needs internet only to fetch the selected video.
                  </small>
                </div>
              </div>
              <div className="transcription-actions">
                <span>
                  <ShieldCheck size={13} />
                  Transcription stays local. Temporary YouTube downloads are
                  deleted after transcription, including on errors.
                </span>
                <button
                  className="button soft compact"
                  type="button"
                  disabled={setupBusy}
                  onClick={checkLocalTools}
                >
                  {setupBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Check setup
                </button>
              </div>
              {setupMessage && (
                <p className="setting-message transcription-message">
                  {setupMessage}
                </p>
              )}
            </div>
          </section>

          <section className="settings-section" id="linking">
            <div className="settings-section-title">
              <span className="settings-icon mint">
                <Link2 size={18} />
              </span>
              <span>
                <h2>Link behaviour</h2>
                <p>Known concepts stay connected while writing and reading.</p>
              </span>
            </div>
            <div className="setting-card">
              <div className="setting-row">
                <span>
                  <strong>Canonical wiki articles</strong>
                  <small>
                    Known terms become links without changing what you wrote and
                    open their named Space article directly. Unlink any phrase
                    from the editor when it should remain plain text.
                  </small>
                </span>
              </div>
            </div>
          </section>

          <section className="settings-section" id="appearance">
            <div className="settings-section-title">
              <span className="settings-icon gold">
                <Palette size={18} />
              </span>
              <span>
                <h2>Appearance</h2>
                <p>A reading room should get out of the way.</p>
              </span>
            </div>
            <div className="setting-card theme-system-setting">
              <div className="theme-setting-intro">
                <span>
                  <strong>Reading-room palette</strong>
                  <small>
                    Start with a curated room, then tune only its essential
                    materials. Orion keeps text and controls contrast-safe.
                  </small>
                </span>
                <span className="theme-safety-note">Accessible foregrounds</span>
              </div>
              <div
                className="theme-preset-grid"
                role="radiogroup"
                aria-label="Color preset"
              >
                {themePresetOptions.map((preset) => {
                  const preview = resolveThemePalette(
                    {
                      ...settings,
                      themePreset: preset.id,
                      themeAccent: "preset",
                      themeAccentCustom: "",
                      themeCanvasCustom: "",
                      themeSurfaceCustom: "",
                    },
                    previewMode,
                  );
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={settings.themePreset === preset.id}
                      className={
                        settings.themePreset === preset.id ? "active" : ""
                      }
                      aria-label={`${preset.name}: ${preset.description}`}
                      onClick={() =>
                        patch({
                          themePreset: preset.id,
                          themeAccent: "preset",
                          themeAccentCustom: "",
                          themeCanvasCustom: "",
                          themeSurfaceCustom: "",
                        })
                      }
                    >
                      <span
                        className="theme-preset-preview"
                        aria-hidden="true"
                        style={
                          {
                            "--preview-canvas": preview.canvas,
                            "--preview-surface": preview.surface1,
                            "--preview-raised": preview.surfaceRaised,
                            "--preview-accent": preview.accent,
                            "--preview-text": preview.text,
                          } as CSSProperties
                        }
                      >
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>
                        <strong>{preset.name}</strong>
                        <small>{preset.description}</small>
                      </span>
                      <i className="theme-preset-selection">
                        {settings.themePreset === preset.id ? (
                          <Check size={12} />
                        ) : null}
                      </i>
                    </button>
                  );
                })}
              </div>
              <div className="theme-mode-setting">
                <span>
                  <strong>Mode</strong>
                  <small>System follows this Mac automatically.</small>
                </span>
                <div
                  className="theme-row"
                  role="radiogroup"
                  aria-label="Theme mode"
                >
                  {(["dark", "light", "system"] as const).map((theme) => (
                    <button
                      key={theme}
                      type="button"
                      role="radio"
                      aria-checked={settings.theme === theme}
                      className={settings.theme === theme ? "active" : ""}
                      onClick={() => patch({ theme })}
                    >
                      <span className={`theme-swatch ${theme}`}>
                        <i />
                        <i />
                      </span>
                      <strong>{theme[0].toUpperCase() + theme.slice(1)}</strong>
                      {settings.theme === theme ? <Check size={13} /> : null}
                    </button>
                  ))}
                </div>
              </div>
              <div className="theme-tuning" aria-label="Palette tuning">
                <div className="theme-tuning-row theme-tuning-row--accent">
                  <span>
                    <strong>Accent</strong>
                    <small>Links, focus, and primary actions</small>
                  </span>
                  <div
                    className="theme-accent-options"
                    role="radiogroup"
                    aria-label="Theme accent"
                  >
                    {themeAccentOptions.map((option) => {
                      const preview = resolveThemePalette(
                        {
                          ...settings,
                          themeAccent: option.id,
                          themeAccentCustom: "",
                        },
                        previewMode,
                      );
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="radio"
                          aria-checked={
                            !settings.themeAccentCustom &&
                            settings.themeAccent === option.id
                          }
                          aria-label={`${option.name} theme accent`}
                          title={option.name}
                          className={
                            !settings.themeAccentCustom &&
                            settings.themeAccent === option.id
                              ? "active"
                              : ""
                          }
                          style={
                            {
                              "--theme-choice-color": preview.accent,
                            } as CSSProperties
                          }
                          onClick={() =>
                            patch({
                              themeAccent: option.id,
                              themeAccentCustom: "",
                            })
                          }
                        >
                          <i aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                  <ThemeColorOverride
                    label="accent"
                    value={settings.themeAccentCustom}
                    fallback={activeThemePalette.accent}
                    onChange={(themeAccentCustom) =>
                      patch({ themeAccentCustom })
                    }
                  />
                </div>
                <div className="theme-tuning-row">
                  <span>
                    <strong>Canvas</strong>
                    <small>The room behind every view</small>
                  </span>
                  <ThemeChoiceGroup
                    label="Canvas depth"
                    options={themeCanvasOptions}
                    value={settings.themeCanvasTone}
                    onSelect={(themeCanvasTone) =>
                      patch({ themeCanvasTone, themeCanvasCustom: "" })
                    }
                  />
                  <ThemeColorOverride
                    label="canvas"
                    value={settings.themeCanvasCustom}
                    fallback={activeThemePalette.canvas}
                    onChange={(themeCanvasCustom) =>
                      patch({ themeCanvasCustom })
                    }
                  />
                </div>
                <div className="theme-tuning-row">
                  <span>
                    <strong>Surfaces</strong>
                    <small>Cards, panels, and the editor</small>
                  </span>
                  <ThemeChoiceGroup
                    label="Surface lift"
                    options={themeSurfaceOptions}
                    value={settings.themeSurfaceLift}
                    onSelect={(themeSurfaceLift) =>
                      patch({ themeSurfaceLift, themeSurfaceCustom: "" })
                    }
                  />
                  <ThemeColorOverride
                    label="surface"
                    value={settings.themeSurfaceCustom}
                    fallback={activeThemePalette.surface1}
                    onChange={(themeSurfaceCustom) =>
                      patch({ themeSurfaceCustom })
                    }
                  />
                </div>
                <div className="theme-tuning-row">
                  <span>
                    <strong>Text warmth</strong>
                    <small>Cool clarity through warm paper</small>
                  </span>
                  <ThemeChoiceGroup
                    label="Text warmth"
                    options={themeWarmthOptions}
                    value={settings.themeTextWarmth}
                    onSelect={(themeTextWarmth) => patch({ themeTextWarmth })}
                  />
                </div>
                <div className="theme-tuning-row">
                  <span>
                    <strong>Contrast</strong>
                    <small>All options keep body copy accessible</small>
                  </span>
                  <ThemeChoiceGroup
                    label="Theme contrast"
                    options={themeContrastOptions}
                    value={settings.themeContrast}
                    onSelect={(themeContrast) => patch({ themeContrast })}
                  />
                </div>
              </div>
            </div>
            <div className="setting-card atmosphere-setting">
              <div className="setting-row vertical">
                <span>
                  <strong>Home atmosphere</strong>
                  <small>
                    Choose the living backdrop for Orion’s opening view.
                  </small>
                </span>
                <div
                  className="atmosphere-options"
                  role="radiogroup"
                  aria-label="Home atmosphere"
                >
                  {atmosphereOptions.map((option) => {
                    const previewPalette = resolveAtmospherePalette(
                      option.id,
                      settings.homeAtmosphereTone,
                      activeThemePalette,
                      settings.homeAtmosphereCustomColor,
                      settings.homeAtmosphereCustomSecondaryColor,
                    );
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={settings.homeAtmosphere === option.id}
                        aria-label={`${option.name}: ${option.description}`}
                        className={
                          settings.homeAtmosphere === option.id ? "active" : ""
                        }
                        onClick={() =>
                          patch({ homeAtmosphere: option.id })
                        }
                      >
                        <span
                          className={`atmosphere-preview ${option.id}`}
                          style={
                            {
                              "--atmosphere-background":
                                previewPalette.background,
                              "--atmosphere-background-secondary":
                                previewPalette.backgroundSecondary,
                              "--atmosphere-primary": previewPalette.primary,
                              "--atmosphere-secondary":
                                previewPalette.secondary,
                              "--atmosphere-tertiary": previewPalette.tertiary,
                              "--atmosphere-bright": previewPalette.bright,
                              "--atmosphere-muted": previewPalette.muted,
                            } as CSSProperties
                          }
                          aria-hidden="true"
                        >
                          <i />
                          <i />
                          <i />
                        </span>
                        <span>
                          <strong>{option.name}</strong>
                          <small>{option.description}</small>
                        </span>
                        <i className="atmosphere-selection">
                          {settings.homeAtmosphere === option.id && (
                            <Check size={12} />
                          )}
                        </i>
                      </button>
                    );
                  })}
                </div>
                <div
                  className="atmosphere-tuner"
                  aria-label="Atmosphere tuning"
                >
                  <div className="atmosphere-tuner-row atmosphere-tuner-row--accent">
                    <span>
                      <strong>Colours</strong>
                      <small>Two-tone accents</small>
                    </span>
                    <div className="atmosphere-accent-controls">
                      <div
                        className="atmosphere-tone-options"
                        aria-label="Atmosphere accent"
                      >
                        {atmosphereToneOptions.map((option) => {
                          const color = resolveAtmospherePalette(
                            settings.homeAtmosphere,
                            option.id,
                            activeThemePalette,
                          ).primary;
                          return (
                            <button
                              key={option.id}
                              type="button"
                              aria-label={`${option.name} accent, ${color}`}
                              aria-pressed={
                                !settings.homeAtmosphereCustomColor &&
                                !settings.homeAtmosphereCustomSecondaryColor &&
                                settings.homeAtmosphereTone === option.id
                              }
                              title={`${option.name} · ${color}`}
                              style={
                                {
                                  "--atmosphere-tone": color,
                                } as CSSProperties
                              }
                              onClick={() =>
                                patch({
                                  homeAtmosphereTone: option.id,
                                  homeAtmosphereCustomColor: "",
                                  homeAtmosphereCustomSecondaryColor: "",
                                })
                              }
                            >
                              <i aria-hidden="true" />
                            </button>
                          );
                        })}
                      </div>
                      <div
                        className="atmosphere-duotone-controls"
                        role="group"
                        aria-label="Shader colours"
                      >
                        <AtmosphereColorPicker
                          label="Colour 1"
                          value={settings.homeAtmosphereCustomColor}
                          fallback={activeAtmospherePalette.primary}
                          showReset={false}
                          onChange={(homeAtmosphereCustomColor) =>
                            patch({
                              homeAtmosphereCustomColor,
                              // Capture the other visible colour the first time
                              // a pair is edited, then leave that choice intact.
                              homeAtmosphereCustomSecondaryColor:
                                settings.homeAtmosphereCustomSecondaryColor ||
                                activeAtmospherePalette.secondary,
                            })
                          }
                        />
                        <AtmosphereColorPicker
                          label="Colour 2"
                          colorName="Shader secondary color"
                          value={settings.homeAtmosphereCustomSecondaryColor}
                          fallback={activeAtmospherePalette.secondary}
                          showReset={false}
                          onChange={(homeAtmosphereCustomSecondaryColor) =>
                            patch({
                              homeAtmosphereCustomColor:
                                settings.homeAtmosphereCustomColor ||
                                activeAtmospherePalette.primary,
                              homeAtmosphereCustomSecondaryColor,
                            })
                          }
                        />
                        {settings.homeAtmosphereCustomColor ||
                        settings.homeAtmosphereCustomSecondaryColor ? (
                          <button
                            type="button"
                            aria-label="Reset shader colours"
                            onClick={() =>
                              patch({
                                homeAtmosphereCustomColor: "",
                                homeAtmosphereCustomSecondaryColor: "",
                              })
                            }
                          >
                            Reset colours
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="atmosphere-tuner-row">
                    <span>
                      <strong>Motion</strong>
                      <small>Pointer response stays on</small>
                    </span>
                    <div
                      className="atmosphere-motion-options"
                      aria-label="Atmosphere motion"
                    >
                      {atmosphereMotionOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={
                            settings.homeAtmosphereMotion === option.id
                          }
                          onClick={() =>
                            patch({ homeAtmosphereMotion: option.id })
                          }
                        >
                          {option.name}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section" id="data">
            <div className="settings-section-title">
              <span className="settings-icon blue">
                <Database size={18} />
              </span>
              <span>
                <h2>Data & privacy</h2>
                <p>Your atlas stays on this device unless you export it.</p>
              </span>
            </div>
            <div className="setting-card">
              <div className="privacy-callout">
                <ShieldCheck size={20} />
                <span>
                  <strong>Local-first by design</strong>
                  <small>
                    Notes, relationships, and sources stay in Orion’s application
                    data folder. AI Import sends selected material; inline
                    writing sends only its editor context and, for Enrich,
                    relevant active-Space knowledge; Chat sends bounded Space
                    context. Every request uses only the provider and model you
                    select.
                  </small>
                </span>
              </div>
              <button
                className="setting-action-row"
                type="button"
                onClick={onOpenDataLocation}
              >
                <span>
                  <Database size={15} />
                  <span>
                    <strong>Open data location</strong>
                    <small>View Orion’s local application data.</small>
                  </span>
                </span>
                <ChevronRight size={15} />
              </button>
              <button
                className="setting-action-row danger-row"
                type="button"
                onClick={onEraseVault}
              >
                <span>
                  <Trash2 size={15} />
                  <span>
                    <strong>Erase current space</strong>
                    <small>
                      Clear this space without touching your other projects.
                    </small>
                  </span>
                </span>
                <ChevronRight size={15} />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
