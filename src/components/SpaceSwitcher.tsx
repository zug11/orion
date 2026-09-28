import {
  Check,
  ChevronDown,
  Edit3,
  Layers3,
  Plus,
  Trash2,
  X,
} from "../lib/icons";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type { AppSnapshot } from "../types";
import { MAX_SPACE_NAME_LENGTH, normalizeSpaceName, spaceNameError } from "../lib/spaceNames";
import "./SpaceSwitcher.css";

interface SpaceSwitcherProps {
  brandMarkSrc?: string;
  spaces: readonly AppSnapshot[];
  activeSpaceId: string;
  onCreateSpace: (name: string) => void;
  onRenameSpace?: (spaceId: string, name: string, expectedName: string) => boolean;
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
  brandMarkSrc = "/orion-symbol.png",
  spaces,
  activeSpaceId,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
  onSwitchSpace,
}: SpaceSwitcherProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null);
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; originalName: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const activeSpace =
    spaces.find((space) => space.workspace.id === activeSpaceId) ??
    spaces[0];
  const normalizedName = normalizeSpaceName(name);
  const duplicateName = useMemo(
    () =>
      spaces.some(
        (space) =>
          space.workspace.id !== renaming?.id &&
          space.workspace.name.toLocaleLowerCase() ===
          normalizedName.toLocaleLowerCase(),
      ),
    [normalizedName, spaces, renaming?.id],
  );
  const renameTarget = renaming ? spaces.find((space) => space.workspace.id === renaming.id) : null;
  const renameValidation = renaming
    ? !renameTarget ? "This Space is no longer available."
      : renameTarget.workspace.name !== renaming.originalName
        ? "This Space was renamed elsewhere. Reopen Rename to use its current name."
        : spaceNameError(name, spaces, renaming.id)
    : null;

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
    if (!creating && !renaming) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (renaming) inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [creating, renaming]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (renaming) {
      if (renameValidation || !onRenameSpace) return;
      if (!onRenameSpace(renaming.id, normalizedName, renaming.originalName)) {
        setRenameError("The name could not be saved. Reopen Rename to try again.");
        return;
      }
      closePopover(true);
      return;
    }
    if (spaceNameError(name, spaces)) {
      return;
    }
    onCreateSpace(normalizedName);
    closePopover(true);
  }

  function closeCreator() {
    setCreating(false);
    setRenaming(null);
    setRenameError(null);
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
          event.preventDefault();
          event.stopPropagation();
          if (renaming) {
            closeCreator();
            renameTriggerRef.current?.focus();
            return;
          }
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
          <img src={brandMarkSrc} alt="" />
        </span>
        <span className="space-switcher-copy">
          <strong>{activeSpace.workspace.name}</strong>
          <small>
            {activeSpace.notes.length}{" "}
            {activeSpace.notes.length === 1 ? "note" : "notes"}
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
                  {onRenameSpace && (
                    <button
                      type="button"
                      className="space-option-rename"
                      aria-label={`Rename ${space.workspace.name} space`}
                      title={`Rename ${space.workspace.name}`}
                      aria-expanded={renaming?.id === space.workspace.id}
                      onClick={(event) => {
                        renameTriggerRef.current = event.currentTarget;
                        setCreating(false);
                        setRenaming({ id: space.workspace.id, originalName: space.workspace.name });
                        setRenameError(null);
                        setName(space.workspace.name);
                      }}
                    >
                      <Edit3 size={13} aria-hidden="true" />
                    </button>
                  )}
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

          {creating || renaming ? (
            <form className={`space-creator${renaming ? " space-renamer" : ""}`} aria-label={renaming ? "Rename space" : "New space"} onSubmit={submit}>
              <div className="space-creator-title">
                <span>{renaming ? "Rename space" : "New blank space"}</span>
                <button
                  type="button"
                  onClick={() => {
                    closeCreator();
                    if (renaming) renameTriggerRef.current?.focus();
                  }}
                  aria-label={renaming ? "Cancel rename" : "Cancel new space"}
                >
                  <X size={13} />
                </button>
              </div>
              <label>
                <span className="sr-only">Space name</span>
                <input
                  ref={inputRef}
                  value={name}
                  maxLength={MAX_SPACE_NAME_LENGTH}
                  onChange={(event) => { setName(event.target.value); setRenameError(null); }}
                  placeholder="Project or area name…"
                  aria-invalid={renaming ? Boolean(renameValidation || renameError) : duplicateName}
                  aria-describedby={helpId}
                />
              </label>
              <div className="space-creator-footer">
                <small id={helpId} aria-live="polite">
                  {renaming ? renameError ?? renameValidation ?? "Change this Space’s name." : duplicateName
                    ? "That name is already in use."
                    : "Starts completely empty."}
                </small>
                <button
                  type="submit"
                  disabled={renaming ? Boolean(renameValidation) || normalizedName === renaming.originalName : Boolean(spaceNameError(name, spaces))}
                >
                  {renaming ? "Save" : "Create"}
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
