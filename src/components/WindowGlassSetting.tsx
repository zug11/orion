import type { WindowGlassSettings } from "../types";
import { defaultWindowGlass, normalizeWindowGlass, type WindowGlassStatus } from "../lib/windowGlass";

interface Props {
  value: WindowGlassSettings;
  status?: WindowGlassStatus | null;
  onChange: (value: WindowGlassSettings) => void;
}

export function WindowGlassSetting({ value, status, onChange }: Props) {
  const glass = normalizeWindowGlass(value);
  const patch = (change: Partial<WindowGlassSettings>) => onChange({ ...glass, ...change });
  const statusText = !glass.enabled
    ? "Glass is off. Your tint opacity and blur settings are saved."
    : status?.error
      ? "Glass could not start. Turn it off and on to try again."
      : !status
        ? "Glass appears in the Mac app."
        : glass.tintOpacity === 100
          ? "Lower tint opacity to reveal the glass."
          : status.material === "solid"
            ? "macOS is using solid surfaces for accessibility."
            : !status.liquidAvailable
              ? "This Mac uses native frosted glass."
              : "Regular glass adapts to your Mac’s appearance.";

  return (
    <div className="setting-card window-glass-setting">
      <div className="window-glass-heading">
        <label className="window-glass-toggle">
          <input
            type="checkbox"
            aria-label="Liquid Glass"
            checked={glass.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span>
            <strong>Liquid Glass</strong>
            <small>One continuous surface for the sidebar and top bar.</small>
          </span>
        </label>
        <button type="button" className="text-button" onClick={() => onChange({ ...defaultWindowGlass })}>
          Reset glass
        </button>
      </div>
      <fieldset className="window-glass-options" aria-label="Glass appearance" disabled={!glass.enabled}>
        <label className="window-glass-slider">
          <span>Tint opacity <output>{glass.tintOpacity}%</output></span>
          <input
            type="range"
            aria-label="Tint opacity"
            min="0"
            max="100"
            step="1"
            value={glass.tintOpacity}
            onChange={(event) => patch({ tintOpacity: Number(event.target.value) })}
          />
        </label>
        <label className="window-glass-slider">
          <span>Background blur <output>{glass.blur}%</output></span>
          <input
            type="range"
            aria-label="Background blur"
            min="0"
            max="100"
            step="5"
            value={glass.blur}
            onChange={(event) => patch({ blur: Number(event.target.value) })}
          />
        </label>
      </fieldset>
      <p className="window-glass-help">Lower tint reveals more of the desktop; at 100%, the frame is solid. Blur adds softness, while the glass keeps its own blur at zero.</p>
      <p className="window-glass-status" role="status">{statusText}</p>
    </div>
  );
}
