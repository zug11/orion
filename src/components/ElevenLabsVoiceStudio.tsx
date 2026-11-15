import { useEffect, useRef, useState } from "react";
import type { Settings } from "../types";
import { normalizeElevenLabsVoices } from "../data/defaults";
import { isTauriRuntime } from "../lib/storage";
import { defaultVoiceControls, voiceCommand, type LibraryVoice, type PickedSample, type VoiceControls, type VoiceModel } from "../lib/elevenLabsVoices";
import "./ElevenLabsVoiceStudio.css";

type IsCurrent = () => boolean;
const controlsForModel = (controls: VoiceControls, modelId: string): VoiceControls => modelId.startsWith("eleven_v3")
  ? { ...controls, stability: Math.round(controls.stability * 2) / 2 }
  : { ...controls };

export function ElevenLabsVoiceStudio({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const [open, setOpen] = useState(false);
  const [voices, setVoices] = useState<LibraryVoice[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [selected, setSelected] = useState<LibraryVoice>();
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<Record<string,string>>({});
  const [samples, setSamples] = useState<PickedSample[]>([]);
  const [noise, setNoise] = useState(false);
  const [controls, setControls] = useState<VoiceControls>({ ...defaultVoiceControls });
  const [models, setModels] = useState<VoiceModel[]>([]);
  const [modelId, setModelId] = useState(settings.elevenLabsModelId ?? "eleven_multilingual_v2");
  const [previewText, setPreviewText] = useState("Here is a thought worth keeping. Let’s take a moment to explore it together.");
  const [audioUrl, setAudioUrl] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const live = useRef(true); const epoch = useRef(0);
  const busyRef = useRef(false);
  const audioEpoch = useRef(0);
  const modelRef = useRef(modelId); modelRef.current = modelId;
  const current = useRef({ settings, onChange }); current.current = { settings, onChange };
  const urlRef = useRef("");
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++; busyRef.current = false; disposeAudio(); if (isTauriRuntime()) void voiceCommand("elevenlabs_clear_samples").catch(() => undefined); }; }, []);
  useEffect(() => {
    const next = settings.elevenLabsModelId ?? "eleven_multilingual_v2";
    modelRef.current = next; setModelId(next); setControls(old => controlsForModel(old, next)); clearAudio();
  }, [settings.elevenLabsModelId]);
  useEffect(() => { if (!settings.elevenLabsApiKeyConfigured && open) closeStudio(); }, [settings.elevenLabsApiKeyConfigured, open]);
  function disposeAudio() { audioEpoch.current++; audioRef.current?.pause(); if (urlRef.current) URL.revokeObjectURL(urlRef.current); urlRef.current = ""; }
  function clearAudio() { disposeAudio(); setAudioUrl(""); }
  function closeStudio() {
    epoch.current++; busyRef.current = false; setBusy(false); setOpen(false); setSamples([]); clearAudio();
    void voiceCommand("elevenlabs_clear_samples").catch(() => undefined);
  }
  async function run(action: (active: IsCurrent) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const seq = ++epoch.current;
    const active = () => live.current && seq === epoch.current && current.current.settings.elevenLabsApiKeyConfigured;
    setBusy(true); setMessage("");
    try { await action(active); } catch (e) { if (active()) setMessage(e instanceof Error ? e.message : String(e)); }
    finally { if (active()) { busyRef.current = false; setBusy(false); } }
  }
  async function library(active: IsCurrent, page?: string) {
    const result = await voiceCommand<{ voices: LibraryVoice[]; nextPage: string | null }>("elevenlabs_list_voices", { nextPage: page ?? null });
    if (!active()) return;
    setVoices(old => page ? [...old.filter(v => !result.voices.some(n => n.id === v.id)), ...result.voices] : result.voices); setNextPage(result.nextPage);
  }
  async function refreshVerification(active: IsCurrent) {
    if (!selected) return;
    const voice = await voiceCommand<LibraryVoice>("elevenlabs_get_voice", { voiceId: selected.id });
    if (!active()) return;
    setVerificationRequired(voice.requiresVerification);
    setSelected(old => old?.id === voice.id ? { ...old, requiresVerification: voice.requiresVerification } : old);
  }
  function useVoice(id: string, voiceName: string) {
    const { settings: s, onChange: change } = current.current;
    const saved = normalizeElevenLabsVoices(s.elevenLabsVoices, s.elevenLabsVoiceId);
    const existing = saved.find(v => v.voiceId === id);
    const baseName = (voiceName || "Cloned voice").slice(0, 72);
    let label = baseName, suffix = 2;
    while (saved.some(v => v.voiceId !== id && v.name.toLowerCase() === label.toLowerCase())) label = `${baseName} ${suffix++}`;
    change({ elevenLabsVoiceId: id, elevenLabsVoices: existing ? saved.map(v => v.voiceId === id ? { ...v, name: label } : v) : [...saved, { voiceId: id, name: label }], ...(s.liveVoiceProvider === "elevenlabs" ? {} : { speechVoice: "elevenlabs" as const }), elevenLabsModelId: modelRef.current, elevenLabsVoiceRevision: Date.now() });
  }
  async function choose(active: IsCurrent, id: string, requiresVerification = false) {
    clearAudio();
    await voiceCommand("elevenlabs_clear_samples");
    if (!active()) return;
    setSamples([]);
    const voice = await voiceCommand<LibraryVoice>("elevenlabs_get_voice", { voiceId: id });
    if (!active()) return;
    const needsVerification = requiresVerification || voice.requiresVerification;
    setVerificationRequired(needsVerification); setSelected({ ...voice, requiresVerification: needsVerification }); setName(voice.name); setDescription(voice.description); setLabels(voice.labels); setControls(controlsForModel(voice.settings, modelRef.current));
  }
  async function startClone(active: IsCurrent) {
    await voiceCommand("elevenlabs_clear_samples");
    if (!active()) return;
    clearAudio(); setVerificationRequired(false); setSelected(undefined); setName(""); setDescription(""); setLabels({}); setSamples([]); setControls({ ...defaultVoiceControls }); setNoise(false);
  }
  async function saveClone(active: IsCurrent) {
    const previousSettings = current.current.settings;
    const result = await voiceCommand<{ id: string; requiresVerification: boolean }>("elevenlabs_clone_voice", { request: { name, description, labels: Object.fromEntries(Object.entries(labels).filter(([,v]) => v.trim())), removeBackgroundNoise: noise, voiceId: selected?.id ?? null } });
    if (!active()) return;
    setSamples([]);
    const requiresVerification = result.requiresVerification || verificationRequired;
    const latest = current.current.settings;
    const canSelect = !requiresVerification && latest.elevenLabsVoiceId === previousSettings.elevenLabsVoiceId && latest.speechVoice === previousSettings.speechVoice && latest.liveVoiceProvider === previousSettings.liveVoiceProvider && latest.elevenLabsModelId === previousSettings.elevenLabsModelId;
    if (canSelect) useVoice(result.id, name.trim());
    setMessage(requiresVerification ? "Voice saved. ElevenLabs requires verification before it can be used. Complete verification in your ElevenLabs voice library, then select it again here." : canSelect ? "Voice saved to ElevenLabs and selected in Orion." : "Voice saved to ElevenLabs. Choose Use this voice in Orion when you’re ready.");
    // Creation succeeded even if a following library refresh fails; retain its ID and do not repeat the POST.
    try { await choose(active, result.id, requiresVerification); if (active()) await library(active); } catch { if (active()) setMessage(`Voice saved (${result.id}). Refresh your library to load its controls. Do not create it again.`); }
  }
  async function preview(active: IsCurrent) {
    if (!selected || verificationRequired) return;
    clearAudio();
    const seq = audioEpoch.current;
    const result = await voiceCommand<{ audio: string; mime: string }>("elevenlabs_preview_voice", { voiceId: selected.id, modelId, text: previewText, settings: controls });
    if (!active() || seq !== audioEpoch.current) return;
    const bytes = Uint8Array.from(atob(result.audio), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mime })); urlRef.current = url; setAudioUrl(url);
  }
  const model = models.find(m => m.id === modelId);
  const isV3 = modelId.startsWith("eleven_v3"), isV4 = modelId.startsWith("eleven_v4");
  const editable = !selected || ["cloned", "generated"].includes(selected.category);
  const sliders: { key: "stability" | "similarity_boost" | "style" | "speed" | "clone_strength"; title: string; hint: string; min: number; max: number; disabled?: boolean }[] = [
    { key:"stability", title:"Stability", hint:"Lower adds emotional variation; higher keeps delivery consistent.", min:0, max:1 },
    { key:"similarity_boost", title:"Similarity", hint:"How closely the output follows the original voice.", min:0, max:1, disabled:modelId.startsWith("eleven_v3") },
    { key:"style", title:"Style exaggeration", hint:"Emphasises the speaker’s style; higher values may add latency.", min:0, max:1, disabled:isV3 || isV4 || (model ? !model.supportsStyle : false) },
    { key:"speed", title:"Speed", hint:"0.7× is slower; 1.2× is faster.", min:0.7, max:1.2, disabled:isV3 || isV4 },
    ...(selected?.category === "professional" && modelId.startsWith("eleven_v4") ? [{ key:"clone_strength" as const, title:"Clone strength", hint:"Preserves more of a professional v4 clone’s original characteristics.", min:0, max:1 }] : []),
  ];
  return <div className="setting-card voice-studio">
    <div className="setting-row"><span><strong>Create and tune voices</strong><small>Clone a voice from audio, browse your ElevenLabs library, and preview its delivery.</small></span>
      <button type="button" className="button secondary small" disabled={!open && (!settings.elevenLabsApiKeyConfigured || !isTauriRuntime())} onClick={() => {
        if (open) { closeStudio(); return; }
        setOpen(true); void run(async active => { const results = await Promise.allSettled([library(active), voiceCommand<VoiceModel[]>("elevenlabs_voice_models"), refreshVerification(active)]); if (!active()) return; if (results[1].status === "fulfilled") setModels(results[1].value); const failed = results.find(r => r.status === "rejected"); if (failed?.status === "rejected") throw failed.reason; });
      }}>{open ? "Close voice studio" : "Open voice studio"}</button>
    </div>
    {open && <div className="voice-studio__body">
      <div className="voice-studio__library"><label>Voice library<select aria-label="Voice library" disabled={busy} value={selected?.id ?? ""} onChange={e => { const id = e.target.value; void run(active => id ? choose(active, id) : startClone(active)); }}><option value="">Create an audio clone</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.category}</option>)}</select></label>
        <button type="button" className="button ghost small" disabled={busy} onClick={() => void run(active => Promise.all([library(active), refreshVerification(active)]).then(() => undefined))}>Refresh library</button>{nextPage && <button type="button" className="button ghost small" disabled={busy} onClick={() => void run(active => library(active, nextPage))}>Load more voices</button>}
      </div>
      <div className="voice-studio__columns"><fieldset disabled={busy || !editable}><legend>{selected ? "Voice details" : "Instant voice clone"}</legend>
        <label>Voice name<input aria-label="Clone voice name" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></label>
        <label>Description<textarea aria-label="Voice description" value={description} maxLength={1000} rows={3} onChange={e => setDescription(e.target.value)} /></label>
        <div className="voice-studio__labels">{["language","accent","gender","age"].map(key => <label key={key}>{key[0].toUpperCase()+key.slice(1)}<input aria-label={`Voice ${key}`} maxLength={80} value={labels[key] ?? ""} onChange={e => setLabels(old => ({ ...old, [key]: e.target.value }))} /></label>)}</div>
        <div className="saved-voice-actions"><button type="button" className="button secondary small" onClick={() => void run(async active => { const picked = await voiceCommand<PickedSample[]>("elevenlabs_pick_samples"); if (active() && picked.length) setSamples(picked); })}>{samples.length ? "Replace imported audio" : "Import audio samples"}</button>
        {!!samples.length && <button type="button" className="button ghost small" onClick={() => void run(async active => { await voiceCommand("elevenlabs_clear_samples"); if (active()) setSamples([]); })}>Clear samples</button>}</div>
        {!!samples.length && <ul className="voice-studio__samples">{samples.map((sample,i) => <li key={`${i}:${sample.name}`}>{sample.name}<small>{(sample.bytes/1024/1024).toFixed(1)} MB</small></li>)}</ul>}
        {selected?.samples.length ? <p className="saved-voice-hint">{selected.samples.length} sample{selected.samples.length === 1 ? "" : "s"} already stored with this voice. Imported samples are added when you save.</p> : null}
        <label className="voice-studio__toggle"><input type="checkbox" checked={noise} onChange={e => setNoise(e.target.checked)} />Remove background noise from imported samples</label>
        <p className="saved-voice-hint">Use recordings you have permission to clone. Aim for 1–2 minutes of clear, consistent speech from one speaker. Up to 20 files, 50 MB total. Samples upload to your ElevenLabs account when you create or update the voice.</p>
        <button type="button" className="button primary small" disabled={!name.trim() || (!selected && !samples.length)} onClick={() => void run(saveClone)}>{selected ? "Save voice details and samples" : "Create voice clone"}</button>
      </fieldset>
      {selected && <fieldset disabled={busy}><legend>Voice delivery</legend>
        <label>Speech model<select aria-label="Voice preview model" value={modelId} onChange={e => { modelRef.current = e.target.value; setModelId(e.target.value); clearAudio(); setControls(c => controlsForModel(c, e.target.value)); }}><option value="eleven_multilingual_v2">Eleven Multilingual v2</option>{!models.some(m => m.id === modelId) && modelId !== "eleven_multilingual_v2" && <option value={modelId}>{modelId} (saved model)</option>}{models.filter(m => m.id !== "eleven_multilingual_v2").map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        {sliders.map(slider => <label key={slider.key} className="voice-studio__slider"><span>{slider.title}<output>{(controls[slider.key] ?? 0).toFixed(2)}{slider.key === "speed" ? "×" : ""}</output></span><input aria-label={`Voice ${slider.title.toLowerCase()}`} type="range" min={slider.min} max={slider.max} step={slider.key === "stability" && modelId.startsWith("eleven_v3") ? 0.5 : 0.01} disabled={slider.disabled} value={controls[slider.key] ?? 0} onChange={e => { setControls(old => ({ ...old, [slider.key]: Number(e.target.value) })); clearAudio(); }} /><small>{slider.disabled ? "Unavailable for the selected model." : slider.hint}</small></label>)}
        <label className="voice-studio__toggle"><input type="checkbox" checked={controls.use_speaker_boost} disabled={isV3 || isV4 || (model ? !model.supportsSpeakerBoost : false)} onChange={e => { setControls(old => ({ ...old, use_speaker_boost:e.target.checked })); clearAudio(); }} />Speaker boost</label>
        <label>Preview text<textarea aria-label="Voice preview text" rows={3} maxLength={1000} value={previewText} onChange={e => { setPreviewText(e.target.value); clearAudio(); }} /></label>
        <div className="saved-voice-actions"><button type="button" className="button secondary small" disabled={!previewText.trim() || verificationRequired} onClick={() => void run(preview)}>Generate preview</button><button type="button" className="button secondary small" onClick={() => void run(async active => { await voiceCommand("elevenlabs_save_voice_settings", { voiceId:selected.id, settings:controls }); if (!active()) return; current.current.onChange({ elevenLabsVoiceRevision: Date.now() }); setMessage("Voice controls saved in ElevenLabs. New narration uses this voice’s saved defaults."); })}>Save voice controls</button><button type="button" className="button ghost small" onClick={() => { setControls({ ...defaultVoiceControls, ...(selected.category === "professional" && modelId.startsWith("eleven_v4") ? { clone_strength: 0 } : {}) }); clearAudio(); }}>Reset controls</button></div>
        {audioUrl && <audio ref={audioRef} controls src={audioUrl} aria-label="Cloned voice preview" />}
        <p className="saved-voice-hint">Previews use ElevenLabs credits. Saving controls changes this voice’s defaults in your ElevenLabs account. {settings.liveVoiceProvider === "elevenlabs" ? "Choose Use this voice in Orion to select it for conversations and any ElevenLabs narration. Conversations use a compatible speech model." : "Choose Use this voice in Orion to use the selected voice and speech model for narration."}</p>
        <button type="button" className="button primary small" disabled={verificationRequired} onClick={() => { useVoice(selected.id, selected.name); setMessage(current.current.settings.liveVoiceProvider === "elevenlabs" ? "Voice selected for Orion conversations and any ElevenLabs narration." : "Voice selected for Orion narration."); }}>Use this voice in Orion</button>
        {verificationRequired && <p className="saved-voice-hint">Complete verification in your ElevenLabs voice library, then refresh the library here to check its status.</p>}
      </fieldset>}</div>
      {selected && !editable && <p className="saved-voice-hint">Sample and identity editing is available for your instant clones. Professional voice training and verification are managed in ElevenLabs.</p>}
    </div>}
    {busy && <p className="setting-message" role="status">Working with ElevenLabs…</p>}
    {message && <p className="setting-message" role="status">{message}</p>}
  </div>;
}
