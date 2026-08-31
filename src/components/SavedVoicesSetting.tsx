import { useRef, useState, type FormEvent } from "react";
import {
  isSavedElevenLabsVoice,
  MAX_VOICE_NAME_LENGTH,
  normalizeElevenLabsVoiceId,
  normalizeElevenLabsVoices,
} from "../data/defaults";
import type { Settings } from "../types";

type VoiceSettings = Pick<Settings, "elevenLabsVoiceId" | "elevenLabsVoices">;

export function SavedVoicesSetting({
  settings,
  onChange,
}: {
  settings: VoiceSettings;
  onChange: (settings: VoiceSettings) => void;
}) {
  const voices = normalizeElevenLabsVoices(
    settings.elevenLabsVoices,
    settings.elevenLabsVoiceId,
  );
  const activeId = normalizeElevenLabsVoiceId(settings.elevenLabsVoiceId);
  const selected = voices.find((voice) => voice.voiceId === activeId);
  const [editor, setEditor] = useState<{ voiceId: string } | null>(null);
  const [name, setName] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [error, setError] = useState("");
  const selector = useRef<HTMLSelectElement>(null);

  function closeEditor() {
    setEditor(null);
    setError("");
    selector.current?.focus();
  }

  function saveVoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const voice = { name: name.trim(), voiceId: voiceId.trim() };
    if (!isSavedElevenLabsVoice(voice)) {
      setError(
        "Enter a name and a voice ID with 8–40 letters or numbers. Names must be 80 characters or fewer, with no control characters.",
      );
      return;
    }
    const others = voices.filter((entry) => entry.voiceId !== editor?.voiceId);
    const duplicate = others.find((entry) => entry.voiceId === voice.voiceId);
    if (duplicate) {
      setError(
        `This voice is already saved as “${duplicate.name}”. Choose it above.`,
      );
      return;
    }
    if (
      others.some((entry) => entry.name.toLowerCase() === voice.name.toLowerCase())
    ) {
      setError("Give this voice a different name so it is easy to distinguish.");
      return;
    }
    const renamed = Boolean(editor?.voiceId);
    onChange({
      elevenLabsVoiceId: renamed ? activeId : voice.voiceId,
      elevenLabsVoices: renamed
        ? voices.map((entry) =>
            entry.voiceId === editor?.voiceId ? voice : entry,
          )
        : [...voices, voice],
    });
    closeEditor();
  }

  return (
    <div className="setting-card saved-voices-setting">
      <label className="setting-row vertical">
        <span>
          <strong>ElevenLabs voice</strong>
          <small>
            Save voices by name, then choose one for Play on every note and
            narrated deck.
          </small>
        </span>
        <select
          ref={selector}
          aria-label="ElevenLabs voice"
          value={activeId}
          onChange={(event) => {
            onChange({
              elevenLabsVoiceId: event.target.value,
              elevenLabsVoices: voices,
            });
            closeEditor();
          }}
        >
          <option value="">Orion default</option>
          {voices.map((voice) => (
            <option key={voice.voiceId} value={voice.voiceId}>
              {voice.name}
            </option>
          ))}
        </select>
      </label>
      <div className="saved-voice-actions">
        <button
          type="button"
          className="button secondary small"
          onClick={() => {
            setEditor({ voiceId: "" });
            setName("");
            setVoiceId("");
            setError("");
          }}
        >
          Add voice
        </button>
        {selected ? (
          <>
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                setEditor({ voiceId: selected.voiceId });
                setName(selected.name);
                setVoiceId(selected.voiceId);
                setError("");
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className="button ghost small"
              onClick={() => {
                onChange({
                  elevenLabsVoiceId: "",
                  elevenLabsVoices: voices.filter(
                    (voice) => voice.voiceId !== activeId,
                  ),
                });
                closeEditor();
              }}
            >
              Remove
            </button>
          </>
        ) : null}
      </div>
      {editor ? (
        <form
          key={editor.voiceId}
          className="saved-voice-editor"
          onSubmit={saveVoice}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.target instanceof HTMLInputElement
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeEditor();
            }
          }}
        >
          <label>
            <span>Voice name</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
              maxLength={MAX_VOICE_NAME_LENGTH}
              placeholder="e.g. Everyday reading"
              autoComplete="off"
            />
          </label>
          {editor.voiceId ? null : (
            <label>
              <span>ElevenLabs voice ID</span>
              <input
                value={voiceId}
                onChange={(event) => {
                  setVoiceId(event.target.value);
                  setError("");
                }}
                placeholder="Paste the voice ID from ElevenLabs"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {error ? (
            <p className="setting-message" role="alert">{error}</p>
          ) : null}
          <div className="saved-voice-actions">
            <button className="button secondary small" type="submit">
              {editor.voiceId ? "Save name" : "Save voice"}
            </button>
            <button
              className="button ghost small"
              type="button"
              onClick={closeEditor}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <p className="saved-voice-hint">
        Removing a saved voice only removes its shortcut in Orion.
      </p>
    </div>
  );
}
