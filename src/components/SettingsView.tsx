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
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "../lib/icons";
import { useEffect, useState, type CSSProperties } from "react";
import {
  atmosphereMotionOptions,
  atmosphereToneOptions,
  resolveAtmospherePalette,
} from "../lib/homeAtmosphere";
import {
  checkTranscriptionSetup,
  isTauriRuntime,
  openClaudeConnector,
} from "../lib/storage";
import type {
  HomeAtmosphere,
  ReasoningEffort,
  Settings,
} from "../types";

interface SettingsViewProps {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onDeleteApiKey: () => Promise<void>;
  onTestApiKey: () => Promise<{ valid: boolean; message: string }>;
  onSaveAnthropicApiKey: (apiKey: string) => Promise<void>;
  onDeleteAnthropicApiKey: () => Promise<void>;
  onTestAnthropicApiKey: () => Promise<{ valid: boolean; message: string }>;
  onOpenDataLocation: () => void;
  onEraseVault: () => void;
}

const models = [
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
];

export function SettingsView({
  settings,
  onChange,
  onSaveApiKey,
  onDeleteApiKey,
  onTestApiKey,
  onSaveAnthropicApiKey,
  onDeleteAnthropicApiKey,
  onTestAnthropicApiKey,
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
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [connectorBusy, setConnectorBusy] = useState(false);
  const [connectorMessage, setConnectorMessage] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<
    | "intelligence"
    | "claude"
    | "transcription"
    | "linking"
    | "appearance"
    | "data"
  >("intelligence");
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    setKeyMessage(null);
  }, [settings.apiKeyConfigured]);

  useEffect(() => {
    setAnthropicKeyMessage(null);
  }, [settings.anthropicApiKeyConfigured]);

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
    setConnectorBusy(true);
    setConnectorMessage(null);
    try {
      await openClaudeConnector();
      setConnectorMessage(
        "Claude Desktop should now ask you to install the Orion extension.",
      );
    } catch (error) {
      setConnectorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setConnectorBusy(false);
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
            href="#claude"
            className={activeSection === "claude" ? "active" : ""}
            onClick={() => setActiveSection("claude")}
          >
            <Cable size={15} /> Claude
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
                <p>Used for AI organisation during import and for Chat.</p>
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
                      onClick={() => patch({ model: model.id })}
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
                  value={settings.reasoningEffort}
                  onChange={(event) =>
                    patch({
                      reasoningEffort: event.target.value as ReasoningEffort,
                    })
                  }
                >
                  <option value="none">None</option>
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
                    Send a compact manifest of titles, aliases, and summaries so
                    imports can reuse your established vocabulary.
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

          <section className="settings-section" id="claude">
            <div className="settings-section-title">
              <span className="settings-icon indigo">
                <Cable size={18} />
              </span>
              <span>
                <h2>Claude connector</h2>
                <p>Let Claude read and write directly in your Orion Spaces.</p>
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
                  <strong>Your atlas, available in conversation</strong>
                  <small>
                    Claude can find Spaces, search concepts, and read the notes
                    or source passages you ask about. It can also create, edit,
                    and delete notes directly in the Space you choose.
                  </small>
                </span>
                <span className="status-pill success">
                  <ShieldCheck size={12} /> Full access
                </span>
              </div>

              <div className="claude-connector-capabilities">
                <span>Space-aware search</span>
                <span>Direct note editing</span>
                <span>Clickable citations</span>
                <span>Bounded source evidence</span>
              </div>

              <div className="claude-connector-actions">
                <small>
                  Installs as a local Claude Desktop extension. Search stays in
                  the active Space unless you explicitly choose another one.
                </small>
                <button
                  className="button primary compact"
                  type="button"
                  disabled={!desktopRuntime || connectorBusy}
                  onClick={installClaudeConnector}
                >
                  {connectorBusy ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : (
                    <ExternalLink size={14} />
                  )}
                  Install in Claude
                </button>
              </div>
              {!desktopRuntime && (
                <p className="setting-message">
                  Connector installation is available in the Orion desktop app.
                </p>
              )}
              {connectorMessage && (
                <p className="setting-message">{connectorMessage}</p>
              )}
            </div>
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
                  <strong>Whisper base · multilingual</strong>
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
            <div className="setting-card theme-row">
              {(["dark", "light", "system"] as const).map((theme) => (
                <button
                  key={theme}
                  type="button"
                  className={settings.theme === theme ? "active" : ""}
                  onClick={() => patch({ theme })}
                >
                  <span className={`theme-swatch ${theme}`}>
                    <i />
                    <i />
                  </span>
                  <strong>{theme[0].toUpperCase() + theme.slice(1)}</strong>
                  {settings.theme === theme && <Check size={13} />}
                </button>
              ))}
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
                  {atmosphereOptions.map((option) => (
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
                  ))}
                </div>
                <div
                  className="atmosphere-tuner"
                  aria-label="Atmosphere tuning"
                >
                  <div className="atmosphere-tuner-row">
                    <span>
                      <strong>Accent</strong>
                      <small>
                        {
                          resolveAtmospherePalette(
                            settings.homeAtmosphere,
                            settings.homeAtmosphereTone,
                          ).primary
                        }
                      </small>
                    </span>
                    <div
                      className="atmosphere-tone-options"
                      aria-label="Atmosphere accent"
                    >
                      {atmosphereToneOptions.map((option) => {
                        const color = resolveAtmospherePalette(
                          settings.homeAtmosphere,
                          option.id,
                        ).primary;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            aria-label={`${option.name} accent, ${color}`}
                            aria-pressed={
                              settings.homeAtmosphereTone === option.id
                            }
                            title={`${option.name} · ${color}`}
                            style={
                              {
                                "--atmosphere-tone": color,
                              } as CSSProperties
                            }
                            onClick={() =>
                              patch({ homeAtmosphereTone: option.id })
                            }
                          >
                            <i aria-hidden="true" />
                          </button>
                        );
                      })}
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
                    data folder. AI Import sends selected material; Chat sends
                    bounded context from the current Space through only the AI
                    provider and model you select.
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
