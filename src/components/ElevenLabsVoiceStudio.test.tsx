// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { defaultVoiceControls, type LibraryVoice, type VoiceModel } from "../lib/elevenLabsVoices";
import { ElevenLabsVoiceStudio } from "./ElevenLabsVoiceStudio";
const api=vi.hoisted(() => ({ invoke:vi.fn() }));
vi.mock("@tauri-apps/api/core",() => ({invoke:api.invoke,isTauri:()=>true}));
const voice: LibraryVoice={id:"abcdefgh12345678",name:"My clone",description:"",category:"cloned",requiresVerification:false,labels:{},samples:[],settings:defaultVoiceControls};
const configured = { ...defaultSettings, elevenLabsApiKeyConfigured: true };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mockLibrary(selected: LibraryVoice = voice, models: VoiceModel[] = []) {
  api.invoke.mockImplementation(async (command: string) => {
    if (command === "elevenlabs_list_voices") return { voices: [selected], nextPage: null };
    if (command === "elevenlabs_get_voice") return selected;
    if (command === "elevenlabs_voice_models") return models;
    if (command === "elevenlabs_preview_voice") return { audio: btoa("sample audio"), mime: "audio/mpeg" };
  });
}
async function openAndSelect() {
  fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Voice library" })).toBeEnabled());
  fireEvent.change(screen.getByRole("combobox", { name: "Voice library" }), { target: { value: voice.id } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save voice controls" })).toBeEnabled());
}
beforeEach(() => {
  api.invoke.mockReset(); Object.defineProperty(window,"__TAURI_INTERNALS__",{value:{},configurable:true});
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:voice-preview"), configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
});
describe("ElevenLabs voice studio",() => {
  it("stages audio and creates a clone only on explicit submission",async () => {
    api.invoke.mockImplementation(async (command:string) => {
      if(command==="elevenlabs_list_voices")return {voices:[],nextPage:null};
      if(command==="elevenlabs_voice_models")return [];
      if(command==="elevenlabs_pick_samples")return [{name:"recording.wav",bytes:1024}];
      if(command==="elevenlabs_clone_voice")return {id:voice.id,requiresVerification:false};
      if(command==="elevenlabs_get_voice")return voice;
    });
    const change=vi.fn();
    render(<ElevenLabsVoiceStudio settings={{...defaultSettings,elevenLabsApiKeyConfigured:true}} onChange={change}/>);
    fireEvent.click(screen.getByRole("button",{name:"Open voice studio"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Import audio samples"})).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Clone voice name"),{target:{value:"My clone"}});
    fireEvent.click(screen.getByRole("button",{name:"Import audio samples"}));
    expect(await screen.findByText("recording.wav")).toBeInTheDocument();
    expect(api.invoke.mock.calls.some(([name])=>name==="elevenlabs_clone_voice")).toBe(false);
    fireEvent.click(screen.getByRole("button",{name:"Create voice clone"}));
    await waitFor(()=>expect(api.invoke).toHaveBeenCalledWith("elevenlabs_clone_voice",{request:{name:"My clone",description:"",labels:{},removeBackgroundNoise:false,voiceId:null}}));
    await waitFor(()=>expect(change).toHaveBeenCalledWith(expect.objectContaining({elevenLabsVoiceId:voice.id,speechVoice:"elevenlabs",elevenLabsModelId:"eleven_multilingual_v2"})));
  });
  it("does not select a clone requiring provider verification",async () => {
    api.invoke.mockImplementation(async (command:string) => {
      if(command==="elevenlabs_list_voices")return {voices:[],nextPage:null};
      if(command==="elevenlabs_voice_models")return [];
      if(command==="elevenlabs_pick_samples")return [{name:"recording.wav",bytes:1024}];
      if(command==="elevenlabs_clone_voice")return {id:voice.id,requiresVerification:true};
      if(command==="elevenlabs_get_voice")return voice;
    });
    const change=vi.fn();render(<ElevenLabsVoiceStudio settings={{...defaultSettings,elevenLabsApiKeyConfigured:true}} onChange={change}/>);
    fireEvent.click(screen.getByRole("button",{name:"Open voice studio"}));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Import audio samples"})).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Clone voice name"),{target:{value:"My clone"}});
    fireEvent.click(screen.getByRole("button",{name:"Import audio samples"}));
    await screen.findByText("recording.wav");fireEvent.click(screen.getByRole("button",{name:"Create voice clone"}));
    expect(await screen.findByText(/ElevenLabs requires verification/)).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use this voice in Orion" })).toBeDisabled();
  });
  it("keeps library verification requirements through metadata saves and rechecks them on refresh", async () => {
    let requiresVerification = true;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "elevenlabs_list_voices") return { voices: [{ ...voice, requiresVerification }], nextPage: null };
      if (command === "elevenlabs_voice_models") return [];
      if (command === "elevenlabs_get_voice") return { ...voice, requiresVerification };
      // Metadata updates cannot prove that a clone has now been verified.
      if (command === "elevenlabs_clone_voice") return { id: voice.id, requiresVerification: false };
    });
    const change = vi.fn(); render(<ElevenLabsVoiceStudio settings={configured} onChange={change}/>);
    await openAndSelect();
    expect(screen.getByRole("button", { name: "Use this voice in Orion" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate preview" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save voice details and samples" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save voice details and samples" })).toBeEnabled());
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use this voice in Orion" })).toBeDisabled();
    requiresVerification = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh library" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Use this voice in Orion" })).toBeEnabled());
    expect(change).not.toHaveBeenCalled();
  });
  it("does not replay creation when follow-up loading fails", async () => {
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "elevenlabs_list_voices") return { voices: [], nextPage: null };
      if (command === "elevenlabs_voice_models") return [];
      if (command === "elevenlabs_pick_samples") return [{ name: "recording.wav", bytes: 1024 }];
      if (command === "elevenlabs_clone_voice") return { id: voice.id, requiresVerification: false };
      if (command === "elevenlabs_get_voice") throw new Error("Library unavailable");
    });
    render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import audio samples" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Clone voice name"), { target: { value: "A new voice" } });
    fireEvent.click(screen.getByRole("button", { name: "Import audio samples" }));
    await screen.findByText("recording.wav");
    fireEvent.click(screen.getByRole("button", { name: "Create voice clone" }));
    expect(await screen.findByText(/Do not create it again/)).toBeInTheDocument();
    expect(api.invoke.mock.calls.filter(([command]) => command === "elevenlabs_clone_voice")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Create voice clone" })).toBeDisabled();
    expect(screen.queryByText("recording.wav")).not.toBeInTheDocument();
  });
  it("discards a late library result after closing and reopening the studio", async () => {
    const old = deferred<{ voices: LibraryVoice[]; nextPage: string | null }>();
    let libraries = 0;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "elevenlabs_list_voices") return ++libraries === 1 ? old.promise : { voices: [voice], nextPage: null };
      if (command === "elevenlabs_voice_models") return [];
    });
    render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Close voice studio" }));
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    await screen.findByRole("option", { name: "My clone · cloned" });
    await act(async () => old.resolve({ voices: [{ ...voice, id: "staleVoice123456", name: "Old voice" }], nextPage: "old-page" }));
    expect(screen.queryByRole("option", { name: "Old voice · cloned" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more voices" })).not.toBeInTheDocument();
  });
  it("releases preview audio on edits, close, and component disposal", async () => {
    mockLibrary();
    const view = render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    await openAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await screen.findByLabelText("Cloned voice preview");
    fireEvent.change(screen.getByLabelText("Voice preview text"), { target: { value: "A different passage." } });
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(screen.queryByLabelText("Cloned voice preview")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await screen.findByLabelText("Cloned voice preview");
    fireEvent.click(screen.getByRole("button", { name: "Close voice studio" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate preview" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    await screen.findByLabelText("Cloned voice preview");
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(api.invoke).toHaveBeenCalledWith("elevenlabs_clear_samples", undefined);
  });
  it("does not create audio from a preview that finishes after closing", async () => {
    mockLibrary();
    const previous = api.invoke.getMockImplementation()!;
    const preview = deferred<{ audio: string; mime: string }>();
    api.invoke.mockImplementation((command: string, args?: unknown) => command === "elevenlabs_preview_voice" ? preview.promise : previous(command, args));
    render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    await openAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Generate preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Close voice studio" }));
    await act(async () => preview.resolve({ audio: btoa("late audio"), mime: "audio/mpeg" }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Cloned voice preview")).not.toBeInTheDocument();
  });
  it("does not update Orion settings when delivery saving finishes after unmount", async () => {
    mockLibrary();
    const previous = api.invoke.getMockImplementation()!;
    const save = deferred<void>();
    api.invoke.mockImplementation((command: string, args?: unknown) => command === "elevenlabs_save_voice_settings" ? save.promise : previous(command, args));
    const change = vi.fn(); const view = render(<ElevenLabsVoiceStudio settings={configured} onChange={change}/>);
    await openAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Save voice controls" }));
    view.unmount();
    await act(async () => save.resolve());
    expect(change).not.toHaveBeenCalled();
  });
  it("saves delivery defaults only on request and persists the chosen model when selecting the voice", async () => {
    const models = [{ id: "eleven_v4", name: "v4", supportsStyle: false, supportsSpeakerBoost: false }];
    mockLibrary(voice, models);
    const change = vi.fn(); render(<ElevenLabsVoiceStudio settings={configured} onChange={change}/>);
    await openAndSelect();
    fireEvent.change(screen.getByLabelText("Voice stability"), { target: { value: "0.82" } });
    expect(api.invoke.mock.calls.some(([command]) => command === "elevenlabs_save_voice_settings")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save voice controls" }));
    await screen.findByText(/Voice controls saved in ElevenLabs/);
    expect(api.invoke).toHaveBeenCalledWith("elevenlabs_save_voice_settings", { voiceId: voice.id, settings: { ...defaultVoiceControls, stability: 0.82 } });
    expect(change).toHaveBeenLastCalledWith({ elevenLabsVoiceRevision: expect.any(Number) });
    fireEvent.change(screen.getByLabelText("Voice preview model"), { target: { value: "eleven_v4" } });
    expect(change).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Use this voice in Orion" }));
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ elevenLabsVoiceId: voice.id, elevenLabsModelId: "eleven_v4", speechVoice: "elevenlabs" }));
  });
  it.each(["system", "openai"] as const)("keeps %s narration when selecting an ElevenLabs conversation voice", async speechVoice => {
    mockLibrary();
    const settings = { ...configured, liveVoiceProvider: "elevenlabs" as const, speechVoice };
    const change = vi.fn(); render(<ElevenLabsVoiceStudio settings={settings} onChange={change}/>);
    await openAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Use this voice in Orion" }));
    expect(change).toHaveBeenCalledOnce();
    const patch = change.mock.calls[0][0];
    expect(patch).toMatchObject({ elevenLabsVoiceId: voice.id });
    expect(patch).not.toHaveProperty("speechVoice");
    expect({ ...settings, ...patch }.speechVoice).toBe(speechVoice);
    expect(screen.getByText("Voice selected for Orion conversations and any ElevenLabs narration.")).toBeInTheDocument();
  });
  it.each([
    { before: "elevenlabs", after: "openai", speechVoice: "system" },
    { before: "openai", after: "elevenlabs", speechVoice: "system" },
    { before: "elevenlabs", after: "elevenlabs", speechVoice: "openai" },
  ] as const)("does not auto-select a late clone after provider or narration changes ($before/$after/$speechVoice)", async ({ before, after, speechVoice }) => {
    const clone = deferred<{ id: string; requiresVerification: boolean }>();
    mockLibrary();
    const previous = api.invoke.getMockImplementation()!;
    api.invoke.mockImplementation((command: string, args?: unknown) => command === "elevenlabs_clone_voice" ? clone.promise : previous(command, args));
    const change = vi.fn();
    const view = render(<ElevenLabsVoiceStudio settings={{ ...configured, liveVoiceProvider: before, speechVoice: "system" }} onChange={change}/>);
    await openAndSelect();
    fireEvent.click(screen.getByRole("button", { name: "Save voice details and samples" }));
    await waitFor(() => expect(api.invoke.mock.calls.some(([command]) => command === "elevenlabs_clone_voice")).toBe(true));
    view.rerender(<ElevenLabsVoiceStudio settings={{ ...configured, liveVoiceProvider: after, speechVoice }} onChange={change}/>);
    await act(async () => clone.resolve({ id: voice.id, requiresVerification: false }));
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByText("Voice saved to ElevenLabs. Choose Use this voice in Orion when you’re ready.")).toBeInTheDocument();
  });
  it("follows saved model changes and hides unsupported v3/v4 controls", async () => {
    mockLibrary({ ...voice, category: "professional", settings: { ...defaultVoiceControls, stability: 0.73 } }, [
      { id: "eleven_v3", name: "v3", supportsStyle: false, supportsSpeakerBoost: false },
      { id: "eleven_v4", name: "v4", supportsStyle: false, supportsSpeakerBoost: false },
    ]);
    const change = vi.fn(); const view = render(<ElevenLabsVoiceStudio settings={{ ...configured, elevenLabsModelId: "eleven_v3" }} onChange={change}/>);
    await openAndSelect();
    expect(screen.getByLabelText("Voice stability")).toHaveValue("0.5");
    expect(screen.getByLabelText("Voice similarity")).toBeDisabled();
    expect(screen.getByLabelText("Voice speed")).toBeDisabled();
    expect(screen.getByLabelText("Voice style exaggeration")).toBeDisabled();
    expect(screen.getByLabelText("Speaker boost")).toBeDisabled();
    expect(screen.queryByLabelText("Voice clone strength")).not.toBeInTheDocument();
    view.rerender(<ElevenLabsVoiceStudio settings={{ ...configured, elevenLabsModelId: "eleven_v4" }} onChange={change}/>);
    expect(screen.getByLabelText("Voice preview model")).toHaveValue("eleven_v4");
    expect(screen.getByLabelText("Voice similarity")).toBeEnabled();
    expect(screen.getByLabelText("Voice speed")).toBeDisabled();
    expect(screen.getByLabelText("Voice style exaggeration")).toBeDisabled();
    expect(screen.getByLabelText("Speaker boost")).toBeDisabled();
    expect(screen.getByLabelText("Voice clone strength")).toBeEnabled();
    expect(change).not.toHaveBeenCalled();
  });
  it("preserves samples when a replacement picker is cancelled and clears them explicitly", async () => {
    mockLibrary();
    const previous = api.invoke.getMockImplementation()!;
    let pickCount = 0;
    api.invoke.mockImplementation((command: string, args?: unknown) => command === "elevenlabs_pick_samples" ? Promise.resolve(++pickCount === 1 ? [{ name: "sample.wav", bytes: 1024 }] : []) : previous(command, args));
    render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import audio samples" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Import audio samples" }));
    await screen.findByText("sample.wav");
    fireEvent.click(screen.getByRole("button", { name: "Replace imported audio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Clear samples" })).toBeEnabled());
    expect(screen.getByText("sample.wav")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear samples" }));
    await waitFor(() => expect(screen.queryByText("sample.wav")).not.toBeInTheDocument());
    expect(api.invoke).toHaveBeenCalledWith("elevenlabs_clear_samples", undefined);
  });
  it("shows library failures and can recover with an explicit refresh", async () => {
    let fail = true;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "elevenlabs_list_voices") { if (fail) throw new Error("Library access denied"); return { voices: [voice], nextPage: null }; }
      if (command === "elevenlabs_voice_models") return [];
    });
    render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    expect(await screen.findByText("Library access denied")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Refresh library" }));
    await screen.findByRole("option", { name: "My clone · cloned" });
    expect(screen.queryByText("Library access denied")).not.toBeInTheDocument();
  });
  it("closes and invalidates pending work when its API key is removed", async () => {
    const pending = deferred<{ voices: LibraryVoice[]; nextPage: null }>();
    api.invoke.mockImplementation(async (command: string) => command === "elevenlabs_list_voices" ? pending.promise : command === "elevenlabs_voice_models" ? [] : undefined);
    const view = render(<ElevenLabsVoiceStudio settings={configured} onChange={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    view.rerender(<ElevenLabsVoiceStudio settings={defaultSettings} onChange={vi.fn()}/>);
    expect(screen.getByRole("button", { name: "Open voice studio" })).toBeDisabled();
    await act(async () => pending.resolve({ voices: [voice], nextPage: null }));
    expect(screen.queryByLabelText("Voice library")).not.toBeInTheDocument();
    expect(screen.queryByText("Working with ElevenLabs…")).not.toBeInTheDocument();
  });
  it("does not select a clone or fetch its controls after closing during creation", async () => {
    const clone = deferred<{ id: string; requiresVerification: boolean }>();
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "elevenlabs_list_voices") return { voices: [], nextPage: null };
      if (command === "elevenlabs_voice_models") return [];
      if (command === "elevenlabs_pick_samples") return [{ name: "recording.wav", bytes: 1024 }];
      if (command === "elevenlabs_clone_voice") return clone.promise;
    });
    const change = vi.fn(); render(<ElevenLabsVoiceStudio settings={configured} onChange={change}/>);
    fireEvent.click(screen.getByRole("button", { name: "Open voice studio" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Import audio samples" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Clone voice name"), { target: { value: "New voice" } });
    fireEvent.click(screen.getByRole("button", { name: "Import audio samples" }));
    await screen.findByText("recording.wav");
    fireEvent.click(screen.getByRole("button", { name: "Create voice clone" }));
    fireEvent.click(screen.getByRole("button", { name: "Close voice studio" }));
    await act(async () => clone.resolve({ id: voice.id, requiresVerification: false }));
    expect(change).not.toHaveBeenCalled();
    expect(api.invoke).not.toHaveBeenCalledWith("elevenlabs_get_voice", expect.anything());
    expect(api.invoke.mock.calls.filter(([command]) => command === "elevenlabs_clone_voice")).toHaveLength(1);
    expect(screen.queryByText(/Voice saved/)).not.toBeInTheDocument();
  });
});
