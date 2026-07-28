import {
  BookOpen,
  FileText,
  GalleryVerticalEnd,
  Home,
  MessageCircle,
  Plus,
  Settings,
  Sparkles,
  Star,
} from "lucide-react";
import type { AppSnapshot, Note } from "../types";
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
  onViewChange: (view: WorkspaceView) => void;
  onOpenNote: (noteId: string) => void;
  onNewNote: () => void;
  onCreateSpace: (name: string) => void;
  onSwitchSpace: (spaceId: string) => void;
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

export function Sidebar({
  view,
  notes,
  spaces,
  activeSpaceId,
  activeNoteId,
  onViewChange,
  onOpenNote,
  onNewNote,
  onCreateSpace,
  onSwitchSpace,
}: SidebarProps) {
  const favorites = notes.filter((note) => note.pinned).slice(0, 4);
  const recents = [...notes]
    .filter((note) => !note.pinned)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);

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

      <div className="sidebar-scroll">
        {favorites.length > 0 && (
          <section className="sidebar-section">
            <div className="sidebar-heading">
              <span>Favorites</span>
              <Star size={12} />
            </div>
            {favorites.map((note) => (
              <button
                key={note.id}
                type="button"
                className={
                  activeNoteId === note.id
                    ? "note-nav-item active"
                    : "note-nav-item"
                }
                onClick={() => onOpenNote(note.id)}
              >
                <span
                  className="note-nav-dot"
                  style={{ background: note.color ?? "#8798ff" }}
                />
                <span>{note.title}</span>
              </button>
            ))}
          </section>
        )}

        <section className="sidebar-section">
          <div className="sidebar-heading">
            <span>Recently opened</span>
            <FileText size={12} />
          </div>
          {recents.map((note) => (
            <button
              key={note.id}
              type="button"
              className={
                activeNoteId === note.id
                  ? "note-nav-item active"
                  : "note-nav-item"
              }
              onClick={() => onOpenNote(note.id)}
            >
              <span
                className="note-nav-dot"
                style={{ background: note.color ?? "#8798ff" }}
              />
              <span>{note.title}</span>
            </button>
          ))}
        </section>
      </div>

      <div className="sidebar-footer">
        <div className="ai-status">
          <span className="ai-status-icon">
            <Sparkles size={13} />
          </span>
          <span>
            <strong>AI organiser</strong>
            <small>Ready when you are</small>
          </span>
        </div>
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
