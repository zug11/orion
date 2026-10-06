import {
  ArrowRight,
  BookOpen,
  CornerDownLeft,
  FilePlus2,
  FileText,
  Plus,
  Search,
  Settings,
  Tags,
  Square,
  X,
} from "../lib/icons";
import Sparkles from "lucide-react/dist/esm/icons/sparkles.mjs";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { AppSnapshot, ChatResult } from "../types";
import { localSearchPassage, localSearchTerms, searchLocalSpace } from "../lib/localSearch";
import { requestNoteExcerptNavigation } from "../lib/noteExcerptNavigation";
import { requestSourcePassageNavigation } from "../lib/sourcePassageNavigation";
import { isSelectedAIConfigured, selectedAIProviderName } from "../lib/ai";
import { ChatReply } from "./ChatReply";
import type { WorkspaceView } from "./Sidebar";
import "./LocalSearch.css";

interface CommandPaletteProps {
  open: boolean;
  snapshot: AppSnapshot;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
  onOpenSource: (sourceId: string) => void;
  onOpenView: (view: WorkspaceView) => void;
  onOpenConcept: (conceptId: string) => void;
  onNewNote: () => void;
  onImport: () => void;
  onAskSpace?: (query: string, signal: AbortSignal, onProgress: (message: string) => void) => Promise<ChatResult>;
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

function HighlightedText({ text, query }: { text: string; query: string }) {
  const literal = query.trim().replace(/^"([\s\S]*)"$/u, "$1");
  const terms = localSearchTerms(query);
  const needles = [...new Set([literal, ...terms].filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!needles.length) return <>{text}</>;
  const pattern = new RegExp(`(${needles.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+")).join("|")})`, "giu");
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

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
  ).filter((element) => element.tabIndex >= 0);
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
  onOpenSource,
  onOpenView,
  onOpenConcept,
  onNewNote,
  onImport,
  onAskSpace,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [kind, setKind] = useState<"all" | "note" | "source" | "concept">("all");
  const [answer, setAnswer] = useState<ChatResult | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState<"matches" | "answer">("matches");
  const [stopped, setStopped] = useState(false);
  const resultsId = useId();
  const hasAIResult = Boolean(answer || progress || error || stopped);
  const aiConfigured = isSelectedAIConfigured(snapshot.settings);
  const searchController = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const results = useMemo<PaletteResult[]>(() => {
    if (!open) return [];
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

    const knowledge: PaletteResult[] = searchLocalSpace(snapshot, query, 40, kind).map((match) => ({
      id: match.item.id,
      title: match.type === "concept" ? match.item.label : match.item.title,
      subtitle: match.type === "source"
        ? `${match.item.kind.toUpperCase()} · ${match.snippet}`
        : match.type === "concept"
          ? `${match.item.noteIds.length} linked notes · ${match.snippet}`
          : match.snippet,
      type: match.type,
      action: () => {
        const passage = localSearchPassage(match, query);
        if (match.type === "source") {
          if (passage) requestSourcePassageNavigation(match.item, passage);
          onOpenSource(match.item.id);
        }
        else if (match.type === "concept") onOpenConcept(match.item.id);
        else {
          if (passage) requestNoteExcerptNavigation(match.item.id, [passage]);
          onOpenNote(match.item.id);
        }
      },
    }));
    return [...knowledge, ...(kind === "all" ? actions : []).filter((action) =>
      `${action.title} ${action.subtitle}`.toLocaleLowerCase().includes(needle),
    )];
  }, [
    open,
    onImport,
    onNewNote,
    onOpenConcept,
    onOpenNote,
    onOpenSource,
    onOpenView,
    query,
    kind,
    snapshot.concepts,
    snapshot.notes,
    snapshot.sources,
  ]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setQuery("");
    setKind("all");
    setSelected(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => {
      window.clearTimeout(timer);
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    setSelected(0);
  }, [query, kind]);
  useEffect(() => {
    setSelected((value) => Math.min(value, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    searchController.current?.abort();
    searchController.current = null;
    setAnswer(null);
    setProgress("");
    setError("");
    setStopped(false);
    setView("matches");
    return () => { searchController.current?.abort(); searchController.current = null; };
  }, [open, query, snapshot.workspace.id, snapshot.notes, snapshot.sources, snapshot.concepts,
    snapshot.relationships, snapshot.settings.model, snapshot.settings.reasoningEffort,
    snapshot.settings.apiKeyConfigured, snapshot.settings.anthropicApiKeyConfigured]);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(`[data-search-result="${selected}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [selected, view]);

  async function askSpace() {
    if (!query.trim() || !onAskSpace || !aiConfigured) return;
    setView("answer");
    inputRef.current?.focus({ preventScroll: true });
    if (answer || searchController.current) return;
    const controller = new AbortController();
    searchController.current = controller;
    setStopped(false);
    setError("");
    setProgress("Finding relevant material");
    try {
      const result = await onAskSpace(query, controller.signal, (message) => {
        if (searchController.current === controller && !controller.signal.aborted) setProgress(message || "Finding relevant material");
      });
      if (searchController.current === controller && !controller.signal.aborted) setAnswer(result);
    } catch (reason) {
      if (searchController.current === controller && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "The AI search could not finish. Try again.");
    } finally {
      if (searchController.current === controller) { searchController.current = null; setProgress(""); }
    }
  }

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
        <div className="command-input">
          <Search size={19} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            maxLength={600}
            role="combobox"
            aria-label={`Search ${snapshot.workspace.name}`}
            aria-autocomplete="list"
            aria-expanded={view === "matches"}
            aria-controls={view === "matches" ? resultsId : undefined}
            aria-activedescendant={view === "matches" && results[selected] ? `${resultsId}-${selected}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or ask a question…"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (view === "matches" && event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((value) => Math.max(0, Math.min(results.length - 1, value + 1)));
              }
              if (view === "matches" && event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((value) => Math.max(0, value - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.metaKey || event.ctrlKey) void askSpace();
                else if (view === "matches") run(results[selected]);
              }
            }}
          />
          {onAskSpace && <button
            className="space-search-ask"
            type="button"
            disabled={!query.trim() || !aiConfigured}
            aria-label="Ask AI"
            title={aiConfigured ? `Ask about this Space with ${selectedAIProviderName(snapshot.settings)} (⌘/Ctrl + Enter)` : `Add your ${selectedAIProviderName(snapshot.settings)} key in Settings to use AI search`}
            onClick={() => void askSpace()}
          ><Sparkles size={14} aria-hidden="true" /><span>Ask AI</span></button>}
          <button className="space-search-close" type="button" aria-label="Close search" title="Close (Esc)" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="space-search-controls">
          {hasAIResult ? <div className="space-search-views" role="group" aria-label="Search view">
            <button type="button" aria-pressed={view === "matches"} onClick={() => setView("matches")}>Matches <span>{results.length}{results.length >= 40 ? "+" : ""}</span></button>
            <button type="button" aria-pressed={view === "answer"} onClick={() => setView("answer")}>
              <Sparkles size={13} aria-hidden="true" /> Answer{progress && <span className="space-search-busy-dot" aria-label="Searching" />}
            </button>
          </div> : <SearchFilters kind={kind} onChange={setKind} />}
          <span className="space-search-scope" title={`Searching only ${snapshot.workspace.name}`}>{snapshot.workspace.name}</span>
        </div>

        {view === "answer" ? <div className="space-search-reading" key="answer">
          {progress && <div className="space-search-pending">
            <div><span className="space-search-pulse" aria-hidden="true" /><p role="status">{progress}…</p></div>
            <button type="button" onClick={() => { searchController.current?.abort(); searchController.current = null; setProgress(""); setStopped(true); inputRef.current?.focus({ preventScroll: true }); }}><Square size={12} aria-hidden="true" /> Stop</button>
          </div>}
          {(error || stopped) && <div className="space-search-feedback">
            <p role={error ? "alert" : "status"}>{error || "Search stopped"}</p>
            <button type="button" onClick={() => void askSpace()}>Try again <ArrowRight size={14} aria-hidden="true" /></button>
          </div>}
          {answer && <section className="space-search-answer" aria-label="AI search answer">
            <ChatReply context="search" snapshot={snapshot} message={{ id: "space-search", role: "assistant", content: answer.reply, evidence: answer.evidence,
              coverage: answer.coverage, cardIds: [], contextCardIds: [], createdAt: "" }}
              onOpenNote={(id) => { onOpenNote(id); onClose(); }} onOpenSource={(id) => { onOpenSource(id); onClose(); }} />
          </section>}
        </div> : <div className="space-search-matches" key="matches">
          {hasAIResult && <div className="space-search-match-filters"><SearchFilters kind={kind} onChange={setKind} /></div>}
          {!query.trim() && <span className="command-group-title">Quick actions</span>}
          <div className="command-results" id={resultsId} role="listbox" aria-label="Search results">
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
                data-search-result={index}
                id={`${resultsId}-${index}`}
                role="option"
                aria-selected={selected === index}
                tabIndex={-1}
                className={selected === index ? "active" : ""}
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => run(result)}
              >
                <i>
                  <Icon size={16} />
                </i>
                <span>
                  <strong><HighlightedText text={result.title} query={query} /></strong>
                  <small className={result.type !== "action" ? "local-search-excerpt" : undefined}>
                    <HighlightedText text={result.subtitle} query={query} />
                  </small>
                </span>
                {selected === index && <CornerDownLeft size={14} />}
              </button>
            );
          })}
          </div>
          {results.length === 0 && (
            <div className="command-empty">
              <Search size={22} />
              <strong>No local matches</strong>
              <span>Try a few distinctive words, or put an exact phrase in quotes.</span>
            </div>
          )}
        </div>}

        <footer className="command-footer">
          {view === "matches" ? <>
            <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
          </> : <span>Answers use this Space only</span>}
          {onAskSpace && aiConfigured && <span className="space-search-shortcut"><kbd>⌘ / Ctrl ↵</kbd> ask AI</span>}
          <span className="space-search-escape"><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}

function SearchFilters({ kind, onChange }: {
  kind: "all" | "note" | "source" | "concept";
  onChange: (kind: "all" | "note" | "source" | "concept") => void;
}) {
  return <div role="group" aria-label="Search result type" className="space-search-filters">
    {([["all", "All"], ["note", "Notes"], ["source", "Sources"], ["concept", "Concepts"]] as const).map(([value, label]) =>
      <button type="button" key={value} aria-pressed={kind === value} onClick={() => onChange(value)}>{label}</button>)}
  </div>;
}
