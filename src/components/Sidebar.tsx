import {
  BookOpen,
  GalleryVerticalEnd,
  Home,
  MessageCircle,
  Plus,
  Settings,
  Star,
  Trash2,
} from "../lib/icons";
import type { AppSnapshot, Note } from "../types";
import {
  linkedArticleStageLabel,
  type LinkedArticleJob,
} from "../lib/linkedArticle";
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
  onCreateSpace: (name: string) => void;
  onSwitchSpace: (spaceId: string) => void;
  onRestartLinkedArticle: (job: LinkedArticleJob) => void;
  onDeleteLinkedArticle: (job: LinkedArticleJob) => void;
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
          <Star
            className="note-nav-favorite"
            size={11}
            fill="currentColor"
            aria-label="Favorite"
          />
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
  onCreateSpace,
  onSwitchSpace,
  onRestartLinkedArticle,
  onDeleteLinkedArticle,
}: SidebarProps) {
  const favorites = notes.filter((note) => note.pinned);
  const visibleLinkedArticleJobs = [
    ...linkedArticleJobs.filter((job) => job.stage === "error"),
    ...linkedArticleJobs.filter((job) => job.stage !== "error"),
  ].slice(0, 3);

  return (
    <aside className="sidebar">
      <SpaceSwitcher
        spaces={spaces}
        activeSpaceId={activeSpaceId}
        onCreateSpace={onCreateSpace}
        onSwitchSpace={onSwitchSpace}
      />

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
              <Star size={12} />
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
