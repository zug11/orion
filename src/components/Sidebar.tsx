import {
  BookOpen,
  ChevronDown,
  GalleryVerticalEnd,
  Home,
  MessageCircle,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings,
  Trash2,
} from "../lib/icons";
import { useEffect, useRef, useState } from "react";
import type { AppSnapshot, Note } from "../types";
import {
  GENERATE_KINDS,
  generateKindLabel,
  generateStageLabel,
  truncateGenerateInstruction,
  type GenerateJob,
  type GenerateKind,
} from "../lib/generate";
import {
  linkedArticleStageLabel,
  type LinkedArticleJob,
} from "../lib/linkedArticle";
import { FavoriteMark } from "./icons/FavoriteMark";
import { SpaceSwitcher } from "./SpaceSwitcher";

export type WorkspaceView =
  | "home"
  | "notes"
  | "sources"
  | "chat"
  | "settings";

interface SidebarProps {
  view: WorkspaceView;
  notes: Note[];
  spaces: readonly AppSnapshot[];
  activeSpaceId: string;
  activeNoteId: string | null;
  linkedArticleJobs: readonly LinkedArticleJob[];
  onViewChange: (view: WorkspaceView) => void;
  onOpenNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  onNewNote: () => void;
  generateEnabled?: boolean;
  generateJobs?: readonly GenerateJob[];
  onGenerate?: (input: { kind: GenerateKind; instruction: string; useSpaceNotes?: boolean }) => void;
  onRestartGenerate?: (job: GenerateJob) => void;
  onDeleteGenerate?: (job: GenerateJob) => void;
  onCreateSpace: (name: string) => void;
  onDeleteSpace: (spaceId: string) => boolean;
  onSwitchSpace: (spaceId: string) => void;
  onRestartLinkedArticle: (job: LinkedArticleJob) => void;
  onDeleteLinkedArticle: (job: LinkedArticleJob) => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const navigation = [
  { id: "home", label: "Home", icon: Home },
  { id: "notes", label: "Notes", icon: BookOpen },
  { id: "sources", label: "Sources", icon: GalleryVerticalEnd },
  { id: "chat", label: "Chat", icon: MessageCircle },
] satisfies Array<{
  id: WorkspaceView;
  label: string;
  icon: typeof Home;
}>;

interface SidebarNoteRowProps {
  note: Note;
  active: boolean;
  onOpenNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
}

function SidebarNoteRow({
  note,
  active,
  onOpenNote,
  onDeleteNote,
}: SidebarNoteRowProps) {
  return (
    <div className={active ? "sidebar-note-row active" : "sidebar-note-row"}>
      <button
        type="button"
        className="note-nav-item"
        aria-label={`Open ${note.title}`}
        onClick={() => onOpenNote(note.id)}
      >
        <span className="note-nav-title">{note.title}</span>
        {note.pinned ? (
          <FavoriteMark className="note-nav-favorite" size={11} />
        ) : null}
      </button>
      <button
        type="button"
        className="sidebar-note-delete"
        aria-label={`Delete ${note.title}`}
        title={`Delete ${note.title}`}
        onClick={() => onDeleteNote(note.id)}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

export function Sidebar({
  view,
  notes,
  spaces,
  activeSpaceId,
  activeNoteId,
  linkedArticleJobs,
  onViewChange,
  onOpenNote,
  onDeleteNote,
  onNewNote,
  generateEnabled = false,
  generateJobs = [],
  onGenerate,
  onRestartGenerate,
  onDeleteGenerate,
  onCreateSpace,
  onDeleteSpace,
  onSwitchSpace,
  onRestartLinkedArticle,
  onDeleteLinkedArticle,
  collapsed = false,
  onToggleCollapsed,
}: SidebarProps) {
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateKind, setGenerateKind] = useState<GenerateKind>("note");
  const [generateUseSpaceNotes, setGenerateUseSpaceNotes] = useState(true);
  const [generateInstruction, setGenerateInstruction] = useState("");
  const generatePanelRef = useRef<HTMLDivElement>(null);
  const favorites = notes.filter((note) => note.pinned);
  const visibleLinkedArticleJobs = [
    ...linkedArticleJobs.filter((job) => job.stage === "error"),
    ...linkedArticleJobs.filter((job) => job.stage !== "error"),
  ].slice(0, 3);
  const visibleGenerateJobs = [
    ...generateJobs.filter((job) => job.stage === "error"),
    ...generateJobs.filter((job) => job.stage !== "error"),
  ].slice(0, 3);

  useEffect(() => {
    if (!generateOpen) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!generatePanelRef.current?.contains(event.target as Node)) {
        setGenerateOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setGenerateOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [generateOpen]);

  return (
    <aside className={collapsed ? "sidebar is-collapsed" : "sidebar"}>
      <SpaceSwitcher
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onCreateSpace={onCreateSpace}
        onDeleteSpace={onDeleteSpace}
        onSwitchSpace={onSwitchSpace}
      />

      <div className="new-note-split" ref={generatePanelRef}>
        <button
          className="new-note-button"
          type="button"
          aria-label="New note"
          onClick={onNewNote}
        >
          <Plus size={16} strokeWidth={2} />
          <span>New note</span>
          <kbd>⌘N</kbd>
        </button>
        {generateEnabled && onGenerate ? (
          <button
            type="button"
            className={
              generateOpen
                ? "new-note-generate-toggle is-open"
                : "new-note-generate-toggle"
            }
            aria-label="Generate options"
            aria-expanded={generateOpen}
            aria-haspopup="dialog"
            onClick={() => {
              if (!generateOpen) setGenerateUseSpaceNotes(
                spaces.find((space) => space.workspace.id === activeSpaceId)?.settings.includeExistingNotesInAIContext ?? false,
              );
              setGenerateOpen((open) => !open);
            }}
          >
            <ChevronDown size={14} />
          </button>
        ) : null}
        {generateOpen && onGenerate ? (
          <form
            className="new-note-generate-composer"
            role="dialog"
            aria-label="Generate"
            onSubmit={(event) => {
              event.preventDefault();
              onGenerate({
                kind: generateKind,
                instruction: truncateGenerateInstruction(generateInstruction),
                useSpaceNotes: generateUseSpaceNotes,
              });
              setGenerateInstruction("");
              setGenerateOpen(false);
            }}
          >
            <span className="new-note-generate-kinds" role="radiogroup" aria-label="Generate kind">
              {GENERATE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={generateKind === kind}
                  className={generateKind === kind ? "active" : ""}
                  onClick={() => setGenerateKind(kind)}
                >
                  {generateKindLabel(kind)}
                </button>
              ))}
            </span>
            <label htmlFor="orion-generate-instruction">
              <span>Instructions</span>
              <small>{generateUseSpaceNotes ? "Optional" : "Required"}</small>
            </label>
            <textarea
              id="orion-generate-instruction"
              value={generateInstruction}
              maxLength={1_250}
              rows={3}
              placeholder={generateUseSpaceNotes ? "Leave blank for Orion’s best page from this Space…" : "Describe what you want to create…"}
              onChange={(event) => setGenerateInstruction(event.target.value)}
            />
            <label className="generate-space-context">
              <input type="checkbox" checked={generateUseSpaceNotes}
                onChange={(event) => setGenerateUseSpaceNotes(event.target.checked)} />
              <span>Use notes from this Space</span>
            </label>
            <p className="generate-context-hint">
              {generateUseSpaceNotes
                ? `Uses relevant text from ${notes.length} notes for this generation. Imported sources are not required.`
                : "Space context is off. Only your instructions will be used; Orion cannot describe your saved project."}
            </p>
            <button type="submit" className="button primary compact"
              disabled={!generateUseSpaceNotes && !generateInstruction.trim()}>
              Generate
            </button>
          </form>
        ) : null}
      </div>

      <nav className="primary-nav" aria-label="Workspace">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={view === id ? "nav-item active" : "nav-item"}
            type="button"
            aria-label={label}
            onClick={() => onViewChange(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
            {id === "notes" && <em>{notes.length}</em>}
          </button>
        ))}
      </nav>

      {generateJobs.length > 0 && (
        <section
          className="sidebar-generation-queue"
          aria-label="Generated pages"
        >
          <div className="sidebar-generation-queue__heading">
            <span>Generating</span>
            <em>{generateJobs.length}</em>
          </div>
          {visibleGenerateJobs.map((job) => (
            <article
              key={job.id}
              className={
                job.stage === "error"
                  ? "sidebar-generation-job is-error"
                  : job.stage === "complete"
                    ? "sidebar-generation-job is-complete"
                    : "sidebar-generation-job"
              }
              title={job.error}
            >
              <button
                type="button"
                className="sidebar-generation-job__open"
                aria-label={`${job.title}. ${generateStageLabel(job.stage)}. Open note.`}
                onClick={() => onOpenNote(job.noteId)}
              >
                <span className="sidebar-generation-job__copy">
                  <strong>{job.title}</strong>
                  <small>
                    {generateStageLabel(job.stage)} · {generateKindLabel(job.kind)}
                    {job.error ? ` · ${job.error}` : ""}
                  </small>
                </span>
                <span
                  className="sidebar-generation-job__progress"
                  role="progressbar"
                  aria-label={`Creating ${job.title}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(job.progress)}
                >
                  <i style={{ width: `${job.progress}%` }} />
                </span>
              </button>
              {job.stage === "error" && onRestartGenerate && onDeleteGenerate ? (
                <div
                  className="sidebar-generation-job__actions"
                  role="group"
                  aria-label={`${job.title} generate actions`}
                >
                  <button type="button" onClick={() => onRestartGenerate(job)}>
                    Restart
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => onDeleteGenerate(job)}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      )}

      {linkedArticleJobs.length > 0 && (
        <section
          className="sidebar-generation-queue"
          aria-label="Linked article generation"
        >
          <div className="sidebar-generation-queue__heading">
            <span>Writing articles</span>
            <em>{linkedArticleJobs.length}</em>
          </div>
          {visibleLinkedArticleJobs.map((job) => (
            <article
              key={job.id}
              className={
                job.stage === "error"
                  ? "sidebar-generation-job is-error"
                  : job.stage === "complete"
                    ? "sidebar-generation-job is-complete"
                    : "sidebar-generation-job"
              }
              title={job.error}
            >
              <button
                type="button"
                className="sidebar-generation-job__open"
                aria-label={`${job.title}. ${linkedArticleStageLabel(job.stage)} from ${job.originTitle}. Open article.`}
                onClick={() => onOpenNote(job.noteId)}
              >
                <span className="sidebar-generation-job__copy">
                  <strong>{job.title}</strong>
                  <small>
                    {linkedArticleStageLabel(job.stage)} · from {job.originTitle}
                  </small>
                </span>
                <span
                  className="sidebar-generation-job__progress"
                  role="progressbar"
                  aria-label={`Creating ${job.title}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(job.progress)}
                >
                  <i style={{ width: `${job.progress}%` }} />
                </span>
              </button>
              {job.stage === "error" ? (
                <div
                  className="sidebar-generation-job__actions"
                  role="group"
                  aria-label={`${job.title} article actions`}
                >
                  <button
                    type="button"
                    onClick={() => onRestartLinkedArticle(job)}
                  >
                    Restart
                  </button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => onDeleteLinkedArticle(job)}
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </section>
      )}

      <div className="sidebar-scroll">
        {favorites.length > 0 ? (
          <section className="sidebar-section" aria-label="Favorites">
            <div className="sidebar-heading">
              <span>Favorites</span>
              <FavoriteMark size={12} />
            </div>
            {favorites.map((note) => (
              <SidebarNoteRow
                key={note.id}
                note={note}
                active={activeNoteId === note.id}
                onOpenNote={onOpenNote}
                onDeleteNote={onDeleteNote}
              />
            ))}
          </section>
        ) : null}

        <section className="sidebar-section" aria-label="All notes">
          <div className="sidebar-heading">
            <span>All notes</span>
            <em>{notes.length}</em>
          </div>
          {notes.map((note) => (
            <SidebarNoteRow
              key={note.id}
              note={note}
              active={activeNoteId === note.id}
              onOpenNote={onOpenNote}
              onDeleteNote={onDeleteNote}
            />
          ))}
          {notes.length === 0 ? (
            <p className="sidebar-notes-empty">No notes yet</p>
          ) : null}
        </section>
      </div>

      <div className="sidebar-footer">
        {onToggleCollapsed ? (
          <button
            type="button"
            className="icon-button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleCollapsed}
          >
            {collapsed ? (
              <PanelLeft size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className={view === "settings" ? "icon-button active" : "icon-button"}
          onClick={() => onViewChange("settings")}
          aria-label="Settings"
        >
          <Settings size={17} />
        </button>
      </div>
    </aside>
  );
}
