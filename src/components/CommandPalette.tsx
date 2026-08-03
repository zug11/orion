import {
  ArrowRight,
  BookOpen,
  Command,
  CornerDownLeft,
  FilePlus2,
  FileText,
  Plus,
  Search,
  Settings,
  Tags,
} from "../lib/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AppSnapshot } from "../types";
import type { WorkspaceView } from "./Sidebar";

interface CommandPaletteProps {
  open: boolean;
  snapshot: AppSnapshot;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
  onOpenView: (view: WorkspaceView) => void;
  onOpenConcept: (conceptId: string) => void;
  onNewNote: () => void;
  onImport: () => void;
}

type PaletteResult = {
  id: string;
  title: string;
  subtitle: string;
  type: "note" | "concept" | "source" | "action";
  action: () => void;
};

const typeIcons = {
  note: BookOpen,
  concept: Tags,
  source: FileText,
  action: ArrowRight,
};

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapDialogFocus(
  event: KeyboardEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
) {
  if (event.key !== "Tab" || !container) {
    return;
  }
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function CommandPalette({
  open,
  snapshot,
  onClose,
  onOpenNote,
  onOpenView,
  onOpenConcept,
  onNewNote,
  onImport,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const results = useMemo<PaletteResult[]>(() => {
    const actions: PaletteResult[] = [
      {
        id: "action-new",
        title: "Create a new note",
        subtitle: "Start with a blank page",
        type: "action",
        action: onNewNote,
      },
      {
        id: "action-import",
        title: "Open Import Studio",
        subtitle: "Bring in files or pasted material",
        type: "action",
        action: onImport,
      },
      {
        id: "action-chat",
        title: "Open Chat",
        subtitle: "Ask questions across everything in this Space",
        type: "action",
        action: () => onOpenView("chat"),
      },
      {
        id: "action-settings",
        title: "Open settings",
        subtitle: "Models, key, links, and privacy",
        type: "action",
        action: () => onOpenView("settings"),
      },
    ];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return actions;

    const notes: PaletteResult[] = snapshot.notes
      .filter((note) =>
        [note.title, note.summary, ...note.tags, ...note.aliases]
          .join(" ")
          .toLocaleLowerCase()
          .includes(needle),
      )
      .map((note) => ({
        id: note.id,
        title: note.title,
        subtitle: note.summary,
        type: "note",
        action: () => onOpenNote(note.id),
      }));
    const concepts: PaletteResult[] = snapshot.concepts
      .filter((concept) =>
        `${concept.label} ${concept.aliases.join(" ")} ${concept.description}`
          .toLocaleLowerCase()
          .includes(needle),
      )
      .map((concept) => ({
        id: concept.id,
        title: concept.label,
        subtitle: `${concept.noteIds.length} linked notes · ${concept.description}`,
        type: "concept",
        action: () => onOpenConcept(concept.id),
      }));
    const sources: PaletteResult[] = snapshot.sources
      .filter((source) =>
        source.title.toLocaleLowerCase().includes(needle),
      )
      .map((source) => ({
        id: source.id,
        title: source.title,
        subtitle: `${source.kind.toUpperCase()} · ${source.noteIds.length} connected notes`,
        type: "source",
        action: () => onOpenView("sources"),
      }));
    return [...notes, ...concepts, ...sources, ...actions.filter((action) =>
      `${action.title} ${action.subtitle}`.toLocaleLowerCase().includes(needle),
    )].slice(0, 12);
  }, [
    onImport,
    onNewNote,
    onOpenConcept,
    onOpenNote,
    onOpenView,
    query,
    snapshot.concepts,
    snapshot.notes,
    snapshot.sources,
  ]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery("");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => {
      window.clearTimeout(timer);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  if (!open) return null;

  function run(result: PaletteResult | undefined) {
    if (!result) return;
    result.action();
    onClose();
  }

  return (
    <div className="modal-backdrop command-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          trapDialogFocus(event, dialogRef.current);
        }}
      >
        <label className="command-input">
          <Search size={19} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a note, concept, source, or action…"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) =>
                  Math.min(results.length - 1, value + 1),
                );
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                run(results[selected]);
              }
              if (event.key === "Escape") onClose();
            }}
          />
          <kbd>ESC</kbd>
        </label>

        <div className="command-results">
          <span className="command-group-title">
            {query ? "Best matches" : "Quick actions"}
          </span>
          {results.map((result, index) => {
            const Icon =
              result.id === "action-new"
                ? Plus
                : result.id === "action-import"
                  ? FilePlus2
                  : result.id === "action-settings"
                      ? Settings
                      : typeIcons[result.type];
            return (
              <button
                key={`${result.type}-${result.id}`}
                className={selected === index ? "active" : ""}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(result)}
              >
                <i>
                  <Icon size={16} />
                </i>
                <span>
                  <strong>{result.title}</strong>
                  <small>{result.subtitle}</small>
                </span>
                {selected === index && <CornerDownLeft size={14} />}
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="command-empty">
              <Search size={22} />
              <strong>No star in that direction</strong>
              <span>Try a title, alias, tag, or source name.</span>
            </div>
          )}
        </div>

        <footer className="command-footer">
          <span>
            <kbd>↑</kbd><kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span className="command-brand">
            <Command size={11} />
            Orion
          </span>
        </footer>
      </div>
    </div>
  );
}
