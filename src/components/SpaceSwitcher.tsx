import {
  Check,
  ChevronDown,
  Edit3,
  FileText,
  Layers3,
  Plus,
  Search,
  Trash2,
  X,
} from "../lib/icons";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import type { AppSnapshot } from "../types";
import { MAX_SPACE_NAME_LENGTH, normalizeSpaceName, spaceNameError } from "../lib/spaceNames";
import { useSpacePickerSearch } from "./useSpacePickerSearch";
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
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const unfilteredScrollTop = useRef<number | null>(null);
  const filtered = Boolean(query.trim());
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    const previous = filtered ? 0 : unfilteredScrollTop.current;
    if (previous !== null) {
      list.scrollTop = previous;
      return;
    }
    const active = list.querySelector<HTMLButtonElement>('.space-option[aria-current="true"]');
    if (active && active.getBoundingClientRect().bottom > list.getBoundingClientRect().bottom) {
      list.scrollTop = active.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - active.offsetHeight) / 2;
    }
  }, [open, query, filtered]);
  useEffect(() => { if (open) searchRef.current?.focus({ preventScroll: true }); }, [open]);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; originalName: string } | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const activeSpace =
    spaces.find((space) => space.workspace.id === activeSpaceId) ??
    spaces[0];
  const discovery = useSpacePickerSearch(open, query, spaces, activeSpace);
  const needle = query.trim().toLocaleLowerCase();
  const visibleSpaces = useMemo(() => {
    const named = spaces.filter(space => space.workspace.name.toLocaleLowerCase().includes(needle));
    if (needle) named.sort((a, b) => Number(b.workspace.name.toLocaleLowerCase() === needle) - Number(a.workspace.name.toLocaleLowerCase() === needle));
    if (!discovery.matches.length) return named;
    const byId = new Map(spaces.map(space => [space.workspace.id, space]));
    for (const space of named) byId.delete(space.workspace.id);
    for (const match of discovery.matches) {
      const space = byId.get(match.spaceId);
      if (space) { named.push(space); byId.delete(match.spaceId); }
    }
    return named;
  }, [spaces, needle, discovery.matches]);
  const evidence = useMemo(() => new Map(discovery.matches.map(match => [match.spaceId, match])), [discovery.matches]);
  const expanding = discovery.meaningState === 'loading';
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

  const rememberListPosition = useCallback(() => {
    // A click or keystroke can arrive before the browser dispatches scroll.
    if (!filtered && listRef.current) unfilteredScrollTop.current = listRef.current.scrollTop;
  }, [filtered]);

  const closePopover = useCallback((restoreFocus = false) => {
    rememberListPosition();
    setOpen(false);
    setQuery("");
    closeCreator();
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  }, [rememberListPosition]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open, closePopover]);

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

  function selectSpace(spaceId: string) {
    closePopover(true);
    if (spaceId !== activeSpaceId) onSwitchSpace(spaceId);
  }

  function focusVisibleOption() {
    const list = listRef.current;
    if (!list) return;
    const options = Array.from(list.querySelectorAll<HTMLButtonElement>(".space-option"));
    const top = list.getBoundingClientRect().top;
    const firstVisible = options.find(option => option.getBoundingClientRect().top >= top);
    (firstVisible ?? options[0])?.focus();
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
          if (open) closePopover();
          else setOpen(true);
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
          className={filtered ? "space-switcher-popover searching" : "space-switcher-popover"}
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

          <label className="space-search"><Search size={14} aria-hidden="true"/>
            <input ref={searchRef} type="search" aria-label="Search spaces" placeholder="Search spaces" value={query} maxLength={600} onChange={event => {
              rememberListPosition();
              setQuery(event.target.value);
            }} onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'ArrowDown') { event.preventDefault(); focusVisibleOption(); }
              if (event.key === 'Enter' && visibleSpaces.length === 1) { event.preventDefault(); selectSpace(visibleSpaces[0].workspace.id); }
            }}/>
          </label>
          {filtered && discovery.hasNotes && <div className="space-discovery-action">
            <button type="button" className="space-search-meaning"
              disabled={!discovery.configured || expanding || discovery.meaningState === 'ready'}
              title={discovery.configured ? 'Find related wording with your AI connection. Your notes are searched locally.' : 'Connect AI in Settings to search by meaning.'}
              onClick={discovery.searchByMeaning}>
              <Search size={13} aria-hidden="true"/>
              {expanding ? 'Searching by meaning…' : discovery.meaningState === 'ready' ? 'Searched by meaning' : 'Search by meaning'}
            </button>
            {!discovery.configured && <small>Connect AI in Settings</small>}
          </div>}
          {discovery.meaningState === 'failed' && <p className="space-discovery-status" role="status">Meaning search couldn’t finish. You can retry or choose a local match.</p>}
          <div className="space-switcher-list" ref={listRef}>
            {visibleSpaces.length === 0 && <p className="space-search-empty" role="status">
              {discovery.localPending ? 'Searching notes…' : expanding ? 'Looking for related wording…' : discovery.localFailed ? 'Couldn’t search the notes.' : 'No matching spaces'}
            </p>}
            {visibleSpaces.map((space, index) => {
              const active = space.workspace.id === activeSpaceId;
              const match = evidence.get(space.workspace.id);
              const evidenceId = `${helpId}-evidence-${index}`;
              return (
                <div
                  key={space.workspace.id}
                  className="space-option-row"
                >
                  <button
                    type="button"
                    className={active ? "space-option active" : "space-option"}
                    aria-current={active ? "true" : undefined}
                    aria-describedby={match ? evidenceId : undefined}
                    aria-label={
                      space.workspace.name +
                      ", " +
                      space.notes.length +
                      " " +
                      (space.notes.length === 1 ? "note" : "notes")
                    }
                    onClick={() => selectSpace(space.workspace.id)}
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
                      {match ? <span className="space-discovery-evidence" id={evidenceId}>
                        <span className="space-discovery-note" title={match.noteTitle}><FileText size={12} aria-hidden="true"/><span className="sr-only">Matching note: </span><span>{match.noteTitle}</span></span>
                        {match.snippet && match.snippet !== match.noteTitle && <span className="space-discovery-excerpt" title={match.snippet}>{match.snippet}</span>}
                      </span> : <small>
                        {space.notes.length}{" "}
                        {space.notes.length === 1 ? "note" : "notes"}
                        {space.sources.length > 0
                          ? " · " + space.sources.length + " sources"
                          : ""}
                      </small>}
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
