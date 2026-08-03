import {
  ArrowRight,
  BookOpen,
  Check,
  Clock3,
  FilePlus2,
  Link2,
  ListTodo,
  Plus,
  Tags,
} from "../lib/icons";
import {
  collectNoteTasks,
  type NoteTask,
} from "../lib/tasks";
import type { AppSnapshot, Note } from "../types";
import BorderGlow from "./BorderGlow";
import HomeAtmosphere from "./HomeAtmosphere";

interface HomeViewProps {
  snapshot: AppSnapshot;
  onOpenNote: (noteId: string) => void;
  onOpenConcept: (conceptId: string) => void;
  onNewNote: () => void;
  onImport: () => void;
  onOpenNotes: () => void;
  onToggleTask: (task: NoteTask, checked: boolean) => void;
}

function NoteCard({
  note,
  onOpen,
}: {
  note: Note;
  onOpen: (noteId: string) => void;
}) {
  return (
    <BorderGlow
      as="button"
      className="recent-note-card"
      type="button"
      glowColor={note.color ?? "#a8b3ff"}
      onClick={() => onOpen(note.id)}
    >
      <div className="recent-note-meta">
        <span
          className="note-kind-mark"
          style={{ "--note-color": note.color ?? "#8798ff" } as React.CSSProperties}
        >
          <BookOpen size={14} />
        </span>
        <span>{note.kind}</span>
        {note.status === "draft" && <em>Draft</em>}
      </div>
      <strong>{note.title}</strong>
      <p>{note.summary}</p>
      <div className="card-footer">
        <span>
          <Clock3 size={12} />
          {new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
          }).format(new Date(note.updatedAt))}
        </span>
        <ArrowRight size={14} />
      </div>
    </BorderGlow>
  );
}

export function HomeView({
  snapshot,
  onOpenNote,
  onOpenConcept,
  onNewNote,
  onImport,
  onOpenNotes,
  onToggleTask,
}: HomeViewProps) {
  const recent = [...snapshot.notes]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 3);
  const featuredConcepts = snapshot.concepts
    .filter((concept) => concept.noteIds.length > 1)
    .sort((a, b) => b.noteIds.length - a.noteIds.length)
    .slice(0, 4);
  const isEmpty = snapshot.notes.length === 0;
  const openTasks = collectNoteTasks(
    snapshot.notes,
    snapshot.concepts,
  ).filter((task) => !task.checked);

  return (
    <div className="view home-view">
      <section className="home-hero">
        <HomeAtmosphere
          atmosphere={snapshot.settings.homeAtmosphere}
          tone={snapshot.settings.homeAtmosphereTone}
          motion={snapshot.settings.homeAtmosphereMotion}
        />
        <div className="home-hero-shade" />
        <div className="home-hero-content">
          <h1 aria-label="Everything you know, in context.">
            Everything you know,
            <br />
            in context.
          </h1>
          <p>
            Bring scattered material into one calm, connected wiki. Orion finds
            the concepts, preserves the sources, and leaves the final say to you.
          </p>
          <div className="hero-actions">
            <button className="button primary" type="button" onClick={onImport}>
              <FilePlus2 size={16} />
              Import knowledge
            </button>
            <button className="button ghost" type="button" onClick={onNewNote}>
              <Plus size={16} />
              Start writing
            </button>
          </div>
        </div>
        <div className="hero-stat-row">
          <span>
            <strong>{snapshot.notes.length}</strong>
            notes
          </span>
          <span>
            <strong>{snapshot.concepts.length}</strong>
            concepts
          </span>
          <span>
            <strong>{snapshot.relationships.length}</strong>
            connections
          </span>
        </div>
      </section>

      {isEmpty ? (
        <section className="home-empty-launch" aria-labelledby="start-orion">
          <div className="section-heading">
            <div>
              <span className="eyebrow neutral">A clean slate</span>
              <h2 id="start-orion">Start with your own material</h2>
            </div>
            <span className="home-empty-private">
              <Link2 size={13} /> Local by default
            </span>
          </div>
          <div className="home-empty-options">
            <BorderGlow
              as="button"
              type="button"
              glowColor="#a8b3ff"
              onClick={onImport}
            >
              <span className="home-empty-option-icon violet">
                <FilePlus2 size={20} />
              </span>
              <span>
                <strong>Import documents</strong>
                <small>Markdown, text, PDF, DOCX, JSON, CSV, or HTML</small>
              </span>
              <ArrowRight size={16} />
            </BorderGlow>
            <BorderGlow
              as="button"
              type="button"
              glowColor="#7bc9b0"
              onClick={onImport}
            >
              <span className="home-empty-option-icon mint">
                <BookOpen size={20} />
              </span>
              <span>
                <strong>Paste notes</strong>
                <small>Drop in research, transcripts, fragments, or ideas</small>
              </span>
              <ArrowRight size={16} />
            </BorderGlow>
            <BorderGlow
              as="button"
              type="button"
              glowColor="#d8b675"
              onClick={onNewNote}
            >
              <span className="home-empty-option-icon gold">
                <Plus size={20} />
              </span>
              <span>
                <strong>Write from scratch</strong>
                <small>Write naturally while Orion connects your ideas</small>
              </span>
              <ArrowRight size={16} />
            </BorderGlow>
          </div>
          <BorderGlow className="home-linking-promise">
            <span className="home-linking-promise__mark">
              <Link2 size={18} />
            </span>
            <span className="home-linking-promise__copy">
              <strong>Hyperlinks emerge intelligently</strong>
              <p>
                Orion identifies recurring names and concepts as it organizes
                your material. Each durable term gets a named article grounded
                in this Space, so “SQL” opens “SQL” directly. Only genuinely
                ambiguous terms ask you to choose in the connections canvas.
              </p>
            </span>
          </BorderGlow>
        </section>
      ) : (
        <>
          <section className="home-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow neutral">Continue exploring</span>
                <h2>Recent notes</h2>
              </div>
              <button className="text-button" type="button" onClick={onOpenNotes}>
                Browse all notes <ArrowRight size={14} />
              </button>
            </div>
            <div className="recent-grid">
              {recent.map((note) => (
                <NoteCard key={note.id} note={note} onOpen={onOpenNote} />
              ))}
            </div>
          </section>

          <section className="home-lower-grid">
            <BorderGlow className="connection-panel">
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow neutral">Emerging connections</span>
                  <h2>Concepts with gravity</h2>
                </div>
                <Tags size={18} />
              </div>
              <div className="concept-list">
                {featuredConcepts.map((concept) => (
                  <button
                    key={concept.id}
                    type="button"
                    className="concept-row"
                    onClick={() => onOpenConcept(concept.id)}
                  >
                    <span
                      className="concept-orbit"
                      style={
                        {
                          "--concept-color": concept.color,
                        } as React.CSSProperties
                      }
                    >
                      <i />
                    </span>
                    <span>
                      <strong>{concept.label}</strong>
                      <small>
                        Appears across {concept.noteIds.length} notes
                      </small>
                    </span>
                    <span className="concept-count">
                      {concept.noteIds.length}
                    </span>
                  </button>
                ))}
              </div>
            </BorderGlow>

            <BorderGlow
              className="task-panel"
              glowColor="#7bc9b0"
              secondaryColor="#a8b3ff"
            >
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow neutral">Across this Space</span>
                  <h2>To do</h2>
                </div>
                <span className="task-panel-count">
                  {openTasks.length}
                  <ListTodo size={15} />
                </span>
              </div>
              <div className="home-task-list" aria-label="Open tasks">
                {openTasks.length === 0 ? (
                  <div className="home-task-empty">
                    <span><Check size={15} /></span>
                    <strong>Nothing waiting</strong>
                    <p>
                      Add a to-do list inside any note and its open items will
                      gather here.
                    </p>
                  </div>
                ) : (
                  openTasks.map((task) => (
                    <div className="home-task-row" key={task.id}>
                      <input
                        type="checkbox"
                        checked={false}
                        aria-label={`Complete ${task.text}`}
                        onChange={() => onToggleTask(task, true)}
                      />
                      <button
                        type="button"
                        className="home-task-copy"
                        onClick={() => onOpenNote(task.noteId)}
                      >
                        <strong>{task.text}</strong>
                        <small>
                          <span>{task.noteTitle}</span>
                        </small>
                      </button>
                      {task.conceptId && task.conceptLabel && (
                        <button
                          type="button"
                          className="home-task-concept"
                          onClick={() => onOpenConcept(task.conceptId!)}
                        >
                          {task.conceptLabel}
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </BorderGlow>
          </section>
        </>
      )}
    </div>
  );
}
