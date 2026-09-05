import { useState } from "react";

function parseHex(value: string): string {
  const hex = value.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : "";
}

export function AtmosphereColorPicker({
  value,
  fallback,
  onChange,
  label = "Custom",
  colorName = "Shader color",
  showReset = true,
}: {
  value: string;
  fallback: string;
  onChange: (color: string) => void;
  label?: string;
  colorName?: string;
  showReset?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const selected = value || fallback;

  return (
    <div className={`atmosphere-custom-color${value ? " active" : ""}`}>
      <label>
        <input
          type="color"
          aria-label={`Custom ${colorName.toLowerCase()}`}
          value={selected}
          onChange={(event) => {
            setDraft(null);
            onChange(event.target.value.toUpperCase());
          }}
        />
        <span>{label}</span>
      </label>
      <input
        type="text"
        className="atmosphere-color-hex"
        aria-label={`${colorName} hex`}
        aria-invalid={draft !== null && draft !== "" && !parseHex(draft)}
        title="Six hexadecimal digits, for example #FF6600"
        value={draft ?? selected}
        maxLength={7}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          const color = parseHex(event.target.value);
          if (color) onChange(color);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {value && showReset ? (
        <button
          type="button"
          aria-label={`Reset custom ${colorName.toLowerCase()}`}
          onClick={() => {
            setDraft(null);
            onChange("");
          }}
        >
          Reset
        </button>
      ) : null}
    </div>
  );
}
