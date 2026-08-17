import {
  Check,
  ChevronDown,
  Layers3,
  Plus,
  Trash2,
  X,
} from "../lib/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type { AppSnapshot } from "../types";

interface SpaceSwitcherProps {
  spaces: readonly AppSnapshot[];
  activeSpaceId: string;
  onCreateSpace: (name: string) => void;
  onDeleteSpace: (spaceId: string) => boolean;
  onSwitchSpace: (spaceId: string) => void;
}

const SPACE_COLORS = [
  "#9baaff",
  "#7bc9b0",
  "#d8b675",
  "#d792a6",
  "#79b9d5",
  "#aa9ce3",
] as const;

function spaceColor(spaceId: string): string {
  let hash = 0;
  for (const character of spaceId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return SPACE_COLORS[hash % SPACE_COLORS.length];
}

export function SpaceSwitcher({
  spaces,
  activeSpaceId,
  onCreateSpace,
  onDeleteSpace,
  onSwitchSpace,
}: SpaceSwitcherProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const activeSpace =
    spaces.find((space) => space.workspace.id === activeSpaceId) ??
    spaces[0];
  const normalizedName = name.trim().replace(/\s+/g, " ");
  const duplicateName = useMemo(
    () =>
      spaces.some(
        (space) =>
          space.workspace.name.toLocaleLowerCase() ===
          normalizedName.toLocaleLowerCase(),
      ),
    [normalizedName, spaces],
  );

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        closeCreator();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (!creating) {
      return;
    }
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [creating]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalizedName || duplicateName) {
      return;
    }
    onCreateSpace(normalizedName);
    closePopover(true);
  }

  function closeCreator() {
    setCreating(false);
    setName("");
  }

  function closePopover(restoreFocus = false) {
    setOpen(false);
    closeCreator();
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }

  return (
    <div
      className="space-switcher"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          closePopover(true);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={open ? "space-switcher-trigger open" : "space-switcher-trigger"}
        aria-label={`${activeSpace.workspace.name} space, ${activeSpace.notes.length} ${
          activeSpace.notes.length === 1 ? "note" : "notes"
        }. ${open ? "Close" : "Open"} space switcher`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (open) {
            closeCreator();
          }
        }}
      >
        <span
          className="space-switcher-mark"
          style={{ "--space-color": spaceColor(activeSpace.workspace.id) } as CSSProperties}
        >
          <img src="/orion-mark.svg" alt="" />
        </span>
        <span className="space-switcher-copy">
          <strong>{activeSpace.workspace.name}</strong>
          <small>
            {activeSpace.notes.length}{" "}
            {activeSpace.notes.length === 1 ? "note" : "notes"} · Orion space
          </small>
        </span>
        <ChevronDown
          className="space-switcher-chevron"
          size={14}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          className="space-switcher-popover"
          role="dialog"
          aria-label="Switch space"
        >
          <div className="space-switcher-heading">
            <span>
              <Layers3 size={13} />
              Spaces
            </span>
            <em>{spaces.length}</em>
          </div>

          <div className="space-switcher-list">
            {spaces.map((space) => {
              const active = space.workspace.id === activeSpaceId;
              return (
                <div
                  key={space.workspace.id}
                  className="space-option-row"
                >
                  <button
                    type="button"
                    className={active ? "space-option active" : "space-option"}
                    aria-current={active ? "true" : undefined}
                    aria-label={
                      space.workspace.name +
                      ", " +
                      space.notes.length +
                      " " +
                      (space.notes.length === 1 ? "note" : "notes")
                    }
                    onClick={() => {
                      if (!active) {
                        onSwitchSpace(space.workspace.id);
                      }
                      closePopover(true);
                    }}
                  >
                    <span
                      className="space-option-orbit"
                      style={
                        {
                          "--space-color": spaceColor(space.workspace.id),
                        } as CSSProperties
                      }
                    >
                      <i />
                    </span>
                    <span>
                      <strong>{space.workspace.name}</strong>
                      <small>
                        {space.notes.length}{" "}
                        {space.notes.length === 1 ? "note" : "notes"}
                        {space.sources.length > 0
                          ? " · " + space.sources.length + " sources"
                          : ""}
                      </small>
                    </span>
                    {active && <Check size={14} aria-hidden="true" />}
                  </button>
                  {spaces.length > 1 ? (
                    <button
                      type="button"
                      className="space-option-delete"
                      aria-label={"Delete " + space.workspace.name + " space"}
                      title={"Delete " + space.workspace.name}
                      onClick={() => {
                        if (!onDeleteSpace(space.workspace.id)) return;
                        closePopover(true);
                      }}
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          {creating ? (
            <form className="space-creator" onSubmit={submit}>
              <div className="space-creator-title">
                <span>New blank space</span>
                <button
                  type="button"
                  onClick={closeCreator}
                  aria-label="Cancel new space"
                >
                  <X size={13} />
                </button>
              </div>
              <label>
                <span className="sr-only">Space name</span>
                <input
                  ref={inputRef}
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Project or area name…"
                  aria-invalid={duplicateName}
                />
              </label>
              <div className="space-creator-footer">
                <small>
                  {duplicateName
                    ? "That name is already in use."
                    : "Starts completely empty."}
                </small>
                <button
                  type="submit"
                  disabled={!normalizedName || duplicateName}
                >
                  Create
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className="space-create-button"
              onClick={() => setCreating(true)}
            >
              <span>
                <Plus size={14} />
              </span>
              <span>
                <strong>New blank space</strong>
                <small>Keep another project completely separate</small>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
