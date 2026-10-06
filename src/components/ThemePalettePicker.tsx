import { useState, type CSSProperties, type ReactNode } from "react";
import { nanoid } from "nanoid";
import type { Settings } from "../types";
import { Check, Plus, RefreshCw, Trash2 } from "../lib/icons";
import {
  defaultThemePreferences, MAX_SAVED_THEME_PALETTES, MAX_THEME_PALETTE_NAME,
  normalizeSavedThemePalettes, normalizeThemePaletteName, readThemePreferences, sameThemePreferences,
} from "../lib/savedThemePalettes";
import { resolveThemePalette, themePresetOptions, type ResolvedThemeMode } from "../lib/theme";

function PaletteCard({ name, description, label, preview, selected, onSelect, actions, confirmation }: {
  name: string;
  description: string;
  label: string;
  preview: ReturnType<typeof resolveThemePalette>;
  selected: boolean;
  onSelect: () => void;
  actions?: ReactNode;
  confirmation?: ReactNode;
}) {
  return <div className={`theme-preset-card${selected ? " active" : ""}`}>
    <button type="button" role="radio" className="theme-preset-choice"
      aria-checked={selected} aria-label={label} onClick={onSelect}>
      <span className="theme-preset-preview" aria-hidden="true" style={{
        "--preview-canvas": preview.canvas,
        "--preview-surface": preview.surface1,
        "--preview-raised": preview.surfaceRaised,
        "--preview-accent": preview.accent,
        "--preview-text": preview.text,
      } as CSSProperties}><i /><i /><i /></span>
      <span className="theme-preset-label"><strong>{name}</strong><small>{description}</small></span>
      <i className="theme-preset-selection" aria-hidden="true">{selected && <Check size={12} />}</i>
    </button>
    {actions && <div className="theme-preset-actions">{actions}</div>}
    {confirmation}
  </div>;
}

export function ThemePalettePicker({ settings, mode, onChange }: {
  settings: Settings;
  mode: ResolvedThemeMode;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState<{ id: string; action: "overwrite" | "delete" } | null>(null);
  const [message, setMessage] = useState("");
  const palettes = normalizeSavedThemePalettes(settings.themeSavedPalettes);
  const active = palettes.find((palette) => palette.id === settings.themeActivePaletteId);
  const isSaved = !!active && sameThemePreferences(settings, active);
  const isPreset = !active && sameThemePreferences(settings, defaultThemePreferences(settings.themePreset));
  const cleanName = normalizeThemePaletteName(name);
  const duplicate = palettes.some((palette) => palette.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
  const full = palettes.length >= MAX_SAVED_THEME_PALETTES;

  function save() {
    if (!cleanName || duplicate || full) return;
    const palette = { ...readThemePreferences(settings), id: `palette-${nanoid(12)}`, name: cleanName };
    onChange({ themeSavedPalettes: [...palettes, palette], themeActivePaletteId: palette.id });
    setName("");
    setMessage(`Saved ${cleanName}.`);
  }

  function confirm() {
    const palette = palettes.find((item) => item.id === pending?.id);
    if (!palette || !pending) { setPending(null); return; }
    if (pending.action === "overwrite") {
      onChange({
        themeSavedPalettes: palettes.map((item) => item.id === palette.id
          ? { ...readThemePreferences(settings), id: item.id, name: item.name } : item),
        themeActivePaletteId: palette.id,
      });
      setMessage(`Updated ${palette.name}.`);
    } else {
      onChange({
        themeSavedPalettes: palettes.filter((item) => item.id !== palette.id),
        themeActivePaletteId: settings.themeActivePaletteId === palette.id ? "" : settings.themeActivePaletteId,
      });
      setMessage(`Deleted ${palette.name}. Your current colours are unchanged.`);
    }
    setPending(null);
  }

  return <>
    <div className="theme-preset-grid" role="radiogroup" aria-label="Color preset">
      {themePresetOptions.map((preset) => {
        const preferences = defaultThemePreferences(preset.id);
        return <PaletteCard key={preset.id} name={preset.name} description={preset.description}
          label={`${preset.name}: ${preset.description}`} preview={resolveThemePalette(preferences, mode)}
          selected={!settings.themeActivePaletteId && sameThemePreferences(settings, preferences)}
          onSelect={() => {
            onChange({ ...preferences, themeActivePaletteId: "" });
            setPending(null); setMessage("");
          }} />;
      })}
      {palettes.map((palette) => <PaletteCard key={palette.id} name={palette.name}
        description="Saved palette" label={`Use ${palette.name} palette`}
        preview={resolveThemePalette(palette, mode)}
        selected={settings.themeActivePaletteId === palette.id && sameThemePreferences(settings, palette)}
        onSelect={() => {
          onChange({ ...readThemePreferences(palette), themeActivePaletteId: palette.id });
          setPending(null); setMessage("");
        }}
        actions={<>
          <button type="button" className="saved-theme-action" aria-label={`Overwrite ${palette.name} palette`}
            title="Replace with current colours" onClick={() => setPending({ id: palette.id, action: "overwrite" })}>
            <RefreshCw size={14} /></button>
          <button type="button" className="saved-theme-action" aria-label={`Delete ${palette.name} palette`}
            title="Delete saved palette" onClick={() => setPending({ id: palette.id, action: "delete" })}>
            <Trash2 size={14} /></button>
        </>}
        confirmation={pending?.id === palette.id && <div className="saved-theme-confirm">
          <span>{pending.action === "overwrite" ? `Replace ${palette.name} with your current colours?` : `Delete ${palette.name}? Your current colours will stay.`}</span>
          <button type="button" onClick={confirm}>{pending.action === "overwrite" ? "Replace palette" : "Delete palette"}</button>
          <button type="button" onClick={() => setPending(null)}>Cancel</button>
        </div>} />)}
    </div>
    <div className="saved-theme-palettes" aria-label="Personal palettes">
      {!isPreset && !isSaved && <div className="saved-theme-heading">
        <span><strong>Custom</strong><small>{active ? `Unsaved changes to ${active.name}` : "Unsaved palette"}</small></span>
        <button type="button" className="quiet-button" onClick={() => {
          onChange(active
            ? { ...readThemePreferences(active) }
            : { ...defaultThemePreferences(settings.themePreset), themeActivePaletteId: "" });
          setMessage(active ? `Restored ${active.name}.` : "Restored the curated palette.");
        }}><RefreshCw size={13} />{active ? "Revert changes" : "Reset palette"}</button>
      </div>}
      <div className="save-theme-form">
        <input type="text" aria-label="Palette name" placeholder="Name your palette" value={name}
          maxLength={MAX_THEME_PALETTE_NAME} aria-invalid={duplicate || undefined}
          onChange={(event) => { setName(event.target.value); setMessage(""); }}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }} />
        <button type="button" disabled={!cleanName || duplicate || full} onClick={save}>
          <Plus size={14} />Save palette</button>
      </div>
      <small className="saved-theme-status" role="status">{duplicate ? "A palette with this name already exists. Choose another name or overwrite it above." :
        full ? `You have ${MAX_SAVED_THEME_PALETTES} saved palettes. Overwrite or delete one to make room.` : message || "Save the colours and tuning you like. Mode stays independent."}</small>
    </div>
  </>;
}
