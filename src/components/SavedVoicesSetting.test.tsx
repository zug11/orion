// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { ELEVENLABS_SPEECH_VOICE_ID, resolveElevenLabsVoiceId } from "../lib/speech";
import { SavedVoicesSetting } from "./SavedVoicesSetting";

const reading = { name: "Reading", voiceId: "21m00Tcm4TlvDq8ikWAM" };
const story = { name: "Storyteller", voiceId: "JBFqnCBsd6RMkjVDRZzb" };

function Harness() {
  const [settings, setSettings] = useState({
    ...defaultSettings,
    elevenLabsVoices: [reading],
    elevenLabsVoiceId: reading.voiceId,
  });
  return (
    <>
      <SavedVoicesSetting
        settings={settings}
        onChange={(voices) => setSettings({ ...settings, ...voices })}
      />
      <output aria-label="Playback voice">{resolveElevenLabsVoiceId(settings)}</output>
    </>
  );
}

describe("saved ElevenLabs voices", () => {
  it("adds, selects, renames, and removes voices without changing playback controls", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add voice" }));
    expect(screen.getByLabelText("Voice name")).toHaveFocus();
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: ` ${story.name} ` } });
    fireEvent.change(screen.getByLabelText("ElevenLabs voice ID"), { target: { value: ` ${story.voiceId} ` } });
    fireEvent.keyDown(screen.getByLabelText("ElevenLabs voice ID"), { key: "Enter" });
    const picker = screen.getByRole("combobox", { name: "ElevenLabs voice" });
    expect(picker).toHaveValue(story.voiceId);
    expect(picker).toHaveFocus();
    expect(screen.getByLabelText("Playback voice")).toHaveTextContent(story.voiceId);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Evening reading" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(screen.getByRole("option", { name: "Evening reading" })).toHaveValue(story.voiceId);
    expect(screen.getByLabelText("Playback voice")).toHaveTextContent(story.voiceId);

    fireEvent.change(picker, { target: { value: reading.voiceId } });
    expect(screen.getByLabelText("Playback voice")).toHaveTextContent(reading.voiceId);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(picker).toHaveValue("");
    expect(screen.getByLabelText("Playback voice")).toHaveTextContent(ELEVENLABS_SPEECH_VOICE_ID);
    expect(screen.queryByRole("option", { name: "Reading" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Evening reading" })).toBeInTheDocument();
  });

  it("keeps invalid IDs and duplicate IDs or names out of saved settings", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add voice" }));
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Another voice" } });
    fireEvent.change(screen.getByLabelText("ElevenLabs voice ID"), { target: { value: "../voice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
    expect(screen.getByRole("alert")).toHaveTextContent("8–40");
    fireEvent.change(screen.getByLabelText("ElevenLabs voice ID"), { target: { value: reading.voiceId } });
    fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already saved");
    fireEvent.change(screen.getByLabelText("ElevenLabs voice ID"), { target: { value: story.voiceId } });
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "reading" } });
    fireEvent.click(screen.getByRole("button", { name: "Save voice" }));
    expect(screen.getByRole("alert")).toHaveTextContent("different name");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("keeps an unsaved legacy voice selectable and cancels edits with Escape", () => {
    const onChange = vi.fn();
    render(<SavedVoicesSetting settings={{ elevenLabsVoiceId: reading.voiceId, elevenLabsVoices: [] }} onChange={onChange} />);
    expect(screen.getByRole("option", { name: "Saved voice" })).toHaveValue(reading.voiceId);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Voice name"), { target: { value: "Uncommitted" } });
    fireEvent.keyDown(screen.getByLabelText("Voice name"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Voice name")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "ElevenLabs voice" })).toHaveFocus();
  });
});
