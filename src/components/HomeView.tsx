import { HomeTickets, type HomeWorkPreferences } from "./HomeTickets";
import type { TicketWorkspace, CreateWorkItem } from "./Tickets";
import { collectWork } from "../lib/tickets";
import {
  ArrowRight,
  BookOpen,
  Clock3,
  FilePlus2,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "../lib/icons";
import { buildLocalSpaceOverview } from "../lib/spaceOverview";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";
import { decorateAutoLinks } from "../lib/wiki";
import {
  resolveThemeMode,
  resolveThemePalette,
  themePaletteCssVariables,
  type ThemePalette,
} from "../lib/theme";
import type { AppSnapshot, Note } from "../types";
import { displayNoteTitle, editableNoteSubtitle } from "../lib/noteMetadata";
import BorderGlow from "./BorderGlow";
import HomeAtmosphere from "./HomeAtmosphere";
import { resolveAtmosphereTheme } from "../lib/homeAtmosphere";
import { useMemo, type CSSProperties } from "react";

interface HomeViewProps {
  snapshot: AppSnapshot;
  onOpenNote: (noteId: string) => void;
  onOpenConcept: (conceptId: string) => void;
  onNewNote: () => void;
  onImport: () => void;
  onOpenNotes: () => void;
  onChangeBoard?: TicketWorkspace["onChangeBoard"];
  onPatchTicket?: TicketWorkspace["onPatch"];
  onDeleteTicket?: TicketWorkspace["onDelete"];
  onDismissCalendarMention?: import('../lib/calendarDismissal').DismissCalendarMention;
  onCreateWork?: CreateWorkItem;
  workPreferences?: Map<string, HomeWorkPreferences>;
  ticketInference?: TicketWorkspace["inference"];
  overviewBusy?: boolean;
  overviewError?: string | null;
  onRefreshOverview: () => void;
  themePalette?: ThemePalette;
}

function formatOverviewDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "Updated recently";
  }
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date)}`;
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
      aria-label={displayNoteTitle(note)}
      glowColor={note.color ?? "#a8b3ff"}
      onClick={() => onOpen(note.id)}
    >
      <strong>{displayNoteTitle(note)}</strong>
      <p>{editableNoteSubtitle(note)}</p>
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
  onChangeBoard,
  onPatchTicket,
  onDeleteTicket,
  onDismissCalendarMention,
  onCreateWork,
  workPreferences,
  ticketInference,
  overviewBusy = false,
  overviewError,
  onRefreshOverview,
  themePalette,
}: HomeViewProps) {
  const exploringNotes = useMemo(() => [...snapshot.notes]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [snapshot.notes]);
  const isEmpty = snapshot.notes.length === 0;
  const work = useMemo(() => collectWork(snapshot.notes), [snapshot.notes]);
  const hasWork = Boolean(work.tickets.length || work.boards.length);
  const localOverview = buildLocalSpaceOverview(snapshot);
  const aiConfigured = isSelectedAIConfigured(snapshot.settings);
  const usingLocalOverview = !snapshot.spaceOverview;
  const overview = usingLocalOverview
    ? localOverview
    : snapshot.spaceOverview!;
  const overviewConcepts = snapshot.concepts.filter(
    (concept) => concept.noteIds.length > 0,
  );
  const activeThemePalette =
    themePalette ??
    resolveThemePalette(
      snapshot.settings,
      resolveThemeMode(
        snapshot.settings.theme,
        typeof window !== "undefined" &&
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-color-scheme: light)").matches,
      ),
    );

  const atmosphereTheme = resolveAtmosphereTheme(snapshot.settings, activeThemePalette);

  const overviewPanel = (
            <BorderGlow
              className="space-overview-panel"
              glowColor="#8f9cff"
              secondaryColor="#70b7d9"
            >
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow neutral">Across this Space</span>
                  <h2>{overview.title}</h2>
                </div>
                <button
                  type="button"
                  className="space-overview-refresh"
                  onClick={onRefreshOverview}
                  disabled={overviewBusy}
                  aria-label="Refresh Space overview"
                  title="Refresh Space overview"
                >
                  {overviewBusy ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
              </div>
              <div className="space-overview-body">
                {overview.body
                  .split(/\n\s*\n/)
                  .filter(Boolean)
                  .map((paragraph, paragraphIndex) => (
                    <p key={`${paragraph.slice(0, 24)}-${paragraphIndex}`}>
                      {decorateAutoLinks(paragraph, overviewConcepts).map(
                        (segment, segmentIndex) =>
                          segment.type === "text" ? (
                            segment.text
                          ) : (
                            <button
                              type="button"
                              className="wiki-link"
                              key={`${segment.conceptId}-${segmentIndex}`}
                              onClick={() =>
                                onOpenConcept(segment.conceptId)
                              }
                            >
                              {segment.text}
                            </button>
                          ),
                      )}
                    </p>
                  ))}
              </div>
              <footer
                className="space-overview-footer"
                role="status"
                aria-live="polite"
              >
                <span>
                  {overviewBusy
                    ? "Revising with the latest context…"
                    : overviewError
                      ? overviewError
                      : usingLocalOverview
                        ? localOverview.relatedNoteIds.length
                          ? "Based on your notes · Updated locally"
                          : "Add text to a note to begin your Space summary"
                        : snapshot.spaceOverview?.stale
                          ? aiConfigured
                            ? "New context is waiting to be integrated"
                            : `New context awaits an ${selectedAIProviderName(snapshot.settings)} key`
                          : snapshot.spaceOverview
                            ? formatOverviewDate(
                                snapshot.spaceOverview.generatedAt,
                              )
                            : "A local orientation while Orion prepares the living overview"}
                </span>
              </footer>
            </BorderGlow>
  );

  return (
    <div className={`view home-view${hasWork ? " has-work" : ""}`}>
      <section className={`home-hero${hasWork ? " home-hero-compact" : ""}`} data-atmosphere-mode={atmosphereTheme.mode}
        style={themePaletteCssVariables(atmosphereTheme) as CSSProperties}>
        <HomeAtmosphere
          atmosphere={snapshot.settings.homeAtmosphere}
          tone={snapshot.settings.homeAtmosphereTone}
          customColor={snapshot.settings.homeAtmosphereCustomColor}
          customSecondaryColor={snapshot.settings.homeAtmosphereCustomSecondaryColor}
          motion={snapshot.settings.homeAtmosphereMotion}
          themePalette={atmosphereTheme}
        />
        <div className="home-hero-shade" />
        <div className="home-hero-content">
          {hasWork ? <h1>{snapshot.workspace.name}</h1> : <h1 aria-label="Everything you care about, in context.">
            Everything you care about,
            <br />
            in context.
          </h1>}
          {!hasWork && <p>
            Bring scattered material into one calm, connected wiki. Orion finds
            the concepts, preserves the sources, and leaves the final say to you.
          </p>}
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
          <HomeTickets key={snapshot.workspace.id} spaceId={snapshot.workspace.id} preferences={workPreferences} notes={snapshot.notes} work={work} concepts={snapshot.concepts} onOpenConcept={onOpenConcept} onOpenNote={onOpenNote} onChangeBoard={onChangeBoard} onPatch={onPatchTicket} onDelete={onDeleteTicket} onCreate={onCreateWork} inference={ticketInference} overview={overviewPanel} onDismissCalendarMention={onDismissCalendarMention}/>
          <section className="home-section home-explore" aria-label="Continue exploring">
            <div className="section-heading">
              <div>
                <span className="eyebrow neutral">Continue exploring</span>
              </div>
              <button className="text-button" type="button" onClick={onOpenNotes}>
                Browse all notes <ArrowRight size={14} />
              </button>
            </div>
            <div className="recent-grid home-note-strip" tabIndex={0} aria-label="All notes, scroll horizontally">
              {exploringNotes.map((note) => (
                <NoteCard key={note.id} note={note} onOpen={onOpenNote} />
              ))}
            </div>
          </section>

        </>
      )}
    </div>
  );
}
