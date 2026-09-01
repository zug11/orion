import { generateFromSpace } from "./lib/generatePipeline";
import { CheckCircle2, X } from "./lib/icons";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import "./App.css";
import { ChatView } from "./components/ChatView";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionCanvas } from "./components/ConnectionCanvas";
import { ContextPanel } from "./components/ContextPanel";
import { ExportDialog, type ExportRequest } from "./components/ExportDialog";
import { HomeView } from "./components/HomeView";
import {
  ImportStudio,
  type ImportStudioApplyPayload,
} from "./components/ImportStudio";
import { NoteView } from "./components/NoteView";
import { NotesIndex } from "./components/NotesIndex";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type WorkspaceView } from "./components/Sidebar";
import { SourceViewer } from "./components/SourceViewer";
import { SourcesView } from "./components/SourcesView";
import { Topbar } from "./components/Topbar";
import {
  activeSpace,
  createEmptySnapshot,
  createEmptyVault,
  defaultSettings,
  normalizeHomeAtmosphere,
  normalizeHomeAtmosphereMotion,
  normalizeHomeAtmosphereTone,
  normalizeElevenLabsVoiceId,
  normalizeElevenLabsVoices,
  normalizeSpeechVoice,
  normalizeThemeAccent,
  normalizeThemeCanvasTone,
  normalizeThemeColor,
  normalizeThemeContrast,
  normalizeThemePreset,
  normalizeThemeSurfaceLift,
  normalizeThemeTextWarmth,
  slugifyTitle,
} from "./data/defaults";
import {
  ensureCanonicalConceptPhrase,
  reconcileConceptVocabulary,
  reconcileSnapshotConceptVocabulary,
  registerConceptPhrase,
  type RegisterWikiLinkInput,
} from "./lib/concepts";
import {
  chatWithOrion,
  deleteAnthropicApiKey,
  deleteApiKey,
  deleteElevenLabsApiKey,
  exportMarkdown,
  exportWebPage,
  generateNoteImage,
  saveNoteImage,
  clearBrowserSnapshot,
  isTauriRuntime,
  loadSnapshot,
  openDataDirectory,
  organizeWithAI,
  runKnowledgeAssignment,
  saveAnthropicApiKey,
  saveApiKey,
  saveElevenLabsApiKey,
  saveSnapshot,
  testAnthropicKey,
  testElevenLabsKey,
  testOpenAIKey,
  generateSpeech,
} from "./lib/storage";
import {
  applyChatResult,
  buildChatRequest,
  ChatRequestRegistry,
  saveChatReplyAsNote,
} from "./lib/chat";
import {
  applyLinkedArticleResult,
  buildLinkedArticleRequest,
  deleteLinkedArticleDraft,
  isLinkedArticlePlaceholder,
  LinkedArticleRequestRegistry,
  linkedArticleProgressForElapsed,
  linkedArticleStageForProgress,
  waitForLinkedArticle,
  type LinkedArticleJob,
} from "./lib/linkedArticle";
import {
  createGeneratePlaceholderNote,
  GenerateRequestRegistry,
  insertImageForSlide,
  titleFromGenerateInstruction,
  truncateGenerateInstruction,
  type GenerateJob,
  type GenerateKind,
} from "./lib/generate";
import {
  buildSlideImagePrompt,
  MAX_DECK_SLIDE_IMAGES,
  parseDeckSlides,
  SLIDE_DECK_TAG,
} from "./lib/slideDeck";
import { runPresentationWaves } from "./lib/knowledgeOrchestration/waves";
import {
  chunkSpeechText,
  cloudSpeechCacheKey,
  decodeBase64Audio,
  openSpeechPlaybackContext,
  playDecodedSpeech,
  PreparedSpeechCache,
  resolveElevenLabsVoiceId,
  resolveSpeechEngine,
  speechChunkLimit,
  speakWithSystemVoice,
  type GeneratedSpeech,
  type SpeechPlaybackProgress,
} from "./lib/speech";
import {
  buildLinkTitleRequest,
  normalizeGeneratedLinkTitle,
} from "./lib/linkTitle";
import {
  buildAIWritingRequest,
  normalizeAIWritingReply,
  type AIWritingRequestInput,
} from "./lib/aiWriting";
import {
  buildAIImagePrompt,
  type AIImageRequestInput,
} from "./lib/aiImages";
import {
  applyWikiEnrichmentResult,
  buildWikiEnrichmentRequest,
  hasSubstantiveKnowledgeNote,
} from "./lib/wikiEnrichment";
import { runKnowledgeEnrichment } from "./lib/knowledgeOrchestration/enrichment";
import {
  noteVersion,
  stableSnapshotVersion,
} from "./lib/knowledgeOrchestration/context";
import { setTaskChecked, type NoteTask } from "./lib/tasks";
import {
  getConceptReferences,
  resolveConceptDestination,
} from "./lib/wiki";
import { deleteNoteFromSnapshot } from "./lib/noteDeletion";
import { deleteSpaceFromVault } from "./lib/spaceDeletion";
import {
  attachSourceToNoteInSnapshot,
  deleteSourceFromSnapshot,
} from "./lib/sourceDeletion";
import { parseOrionNoteLink } from "./lib/orionLinks";
import { normalizeStudio } from "./lib/studio";
import {
  applySpaceOverviewResult,
  hasSubstantiveOverviewNote,
  markSpaceOverviewStale,
  spaceKnowledgeFingerprint,
} from "./lib/spaceOverview";
import {
  applySpaceBlueprintResult,
  applySpaceRootResult,
  buildSpaceBlueprintRequest,
  buildSpaceRootRequest,
  pendingSpaceBlueprints,
  prepareSpaceKnowledgeIndex,
} from "./lib/spaceKnowledge";
import {
  createNavigationEntry,
  moveNavigationHistory,
  pushNavigationHistory,
  readScrollPosition,
  resetScrollPosition,
  restoreScrollPosition,
  routesMatch,
  type NavigationEntry,
  type NavigationRoute,
  type ScrollPosition,
} from "./lib/navigation";
import { useResolvedTheme } from "./lib/useResolvedTheme";
import {
  buildWebExportDocument,
  notesForExportScope,
} from "./lib/webExport";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "./lib/ai";
import {
  shouldAcceptExternalVault,
  spacesNeedingOverviewRefresh,
} from "./lib/externalVault";
import type {
  AppSnapshot,
  ChatResult,
  EntityId,
  Note,
  OrganizeContentResult,
  OrionVault,
  Settings,
} from "./types";

type AppScreen = WorkspaceView | "note";

function routeForScreen(
  screen: AppScreen,
  activeNoteId: EntityId | null,
): NavigationRoute {
  return screen === "note" && activeNoteId
    ? { screen: "note", noteId: activeNoteId }
    : { screen: screen === "note" ? "notes" : screen };
}

interface ToastState {
  id: string;
  title: string;
  message: string;
  action?: {
    label: string;
    run: () => void;
  };
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isRetiredStarterVault(snapshot: AppSnapshot): boolean {
  return (
    snapshot.workspace.id === "workspace-orion" &&
    snapshot.workspace.createdAt === "2026-07-27T09:00:00.000Z" &&
    snapshot.notes.length === 12 &&
    snapshot.sources.length === 3 &&
    snapshot.concepts.length === 9 &&
    snapshot.relationships.length === 7
  );
}

function App() {
  const [vault, setVault] = useState<OrionVault>(() =>
    createEmptyVault(),
  );
  const snapshot = useMemo(() => activeSpace(vault), [vault]);
  const { palette: resolvedThemePalette } = useResolvedTheme(
    snapshot.settings,
  );
  const setSnapshot = useCallback(
    (action: SetStateAction<AppSnapshot>) => {
      setVault((currentVault) => {
        const currentSpace = activeSpace(currentVault);
        const nextSpace =
          typeof action === "function"
            ? action(currentSpace)
            : action;
        return {
          ...currentVault,
          spaces: currentVault.spaces.map((space) =>
            space.workspace.id === currentSpace.workspace.id
              ? nextSpace
              : space,
          ),
          updatedAt: nextSpace.updatedAt,
        };
      });
    },
    [],
  );
  const [screen, setScreen] = useState<AppScreen>("home");
  const [hydrated, setHydrated] = useState(false);
  const [closing, setClosing] = useState(false);
  const [persistenceEnabled, setPersistenceEnabled] = useState(false);
  const [vaultLoadError, setVaultLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [connectionConceptId, setConnectionConceptId] = useState<string | null>(
    null,
  );
  const [connectionOriginNoteId, setConnectionOriginNoteId] = useState<
    string | null
  >(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [chatBusySpaceIds, setChatBusySpaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [overviewBusySpaceIds, setOverviewBusySpaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [overviewErrors, setOverviewErrors] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [linkedArticleJobs, setLinkedArticleJobs] = useState<
    LinkedArticleJob[]
  >([]);
  const [generateJobs, setGenerateJobs] = useState<GenerateJob[]>([]);
  const generateRequests = useRef(new GenerateRequestRegistry());
  const preparedSpeech = useRef(new PreparedSpeechCache());
  const speechPlaybackContext = useRef<AudioContext | null>(null);
  const [history, setHistory] = useState<NavigationEntry[]>(() => [
    createNavigationEntry({ screen: "home" }),
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const saveTimer = useRef<number | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingSaveCount = useRef(0);
  const persistedVaultUpdatedAt = useRef<string | null>(null);
  const skipAutosaveVault = useRef<OrionVault | null>(null);
  const closingRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const chatRequests = useRef(new ChatRequestRegistry());
  const pendingChatNoteSaveNotices = useRef(
    new Map<
      string,
      { workspaceId: string; messageId: string; noteId: string }
    >(),
  );
  const linkedArticleRequests = useRef(new LinkedArticleRequestRegistry());
  const wikiEnrichmentRequests = useRef(new Set<string>());
  const overviewRequests = useRef(new Map<string, string>());
  const overviewTimers = useRef(new Map<string, number>());
  const refreshSpaceOverviewRef = useRef<
    (spaceId: string, manual?: boolean) => Promise<void>
  >(async () => undefined);
  const snapshotBeforeImport = useRef<AppSnapshot | null>(null);
  const workspaceContentRef = useRef<HTMLElement | null>(null);
  const historyRef = useRef<NavigationEntry[]>(history);
  const historyIndexRef = useRef(0);
  const pendingScrollRestore = useRef<{
    route: NavigationRoute;
    position: ScrollPosition;
  } | null>(null);
  const screenRef = useRef(screen);
  const snapshotRef = useRef(snapshot);
  const vaultRef = useRef(vault);
  const persistenceEnabledRef = useRef(persistenceEnabled);
  snapshotRef.current = snapshot;
  vaultRef.current = vault;
  persistenceEnabledRef.current = persistenceEnabled;
  historyRef.current = history;
  historyIndexRef.current = historyIndex;
  screenRef.current = screen;

  const replaceHistory = useCallback(
    (entries: NavigationEntry[], index: number) => {
      historyRef.current = entries;
      historyIndexRef.current = index;
      setHistory(entries);
      setHistoryIndex(index);
    },
    [],
  );

  const activeNote = useMemo(
    () =>
      snapshot.notes.find((note) => note.id === snapshot.activeNoteId) ?? null,
    [snapshot.activeNoteId, snapshot.notes],
  );
  const selectedSource = useMemo(
    () =>
      snapshot.sources.find((source) => source.id === selectedSourceId) ?? null,
    [selectedSourceId, snapshot.sources],
  );
  const connectionConcept = useMemo(
    () =>
      snapshot.concepts.find(
        (concept) => concept.id === connectionConceptId,
      ) ?? null,
    [connectionConceptId, snapshot.concepts],
  );
  const connectionReferences = useMemo(
    () =>
      connectionConcept
        ? getConceptReferences(connectionConcept.id, snapshot)
        : [],
    [connectionConcept, snapshot],
  );
  const connectionOriginNote = useMemo(
    () =>
      snapshot.notes.find((note) => note.id === connectionOriginNoteId) ?? null,
    [connectionOriginNoteId, snapshot.notes],
  );

  useLayoutEffect(() => {
    const route = routeForScreen(screen, snapshot.activeNoteId);
    const restoration = pendingScrollRestore.current;
    pendingScrollRestore.current = null;
    if (restoration && routesMatch(restoration.route, route)) {
      restoreScrollPosition(
        workspaceContentRef.current,
        restoration.position,
      );
      return;
    }
    resetScrollPosition(workspaceContentRef.current);
  }, [screen, snapshot.activeNoteId]);

  const showToast = useCallback(
    (
      title: string,
      message: string,
      action?: ToastState["action"],
    ) => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast({ id: nanoid(), title, message, action });
      toastTimer.current = window.setTimeout(() => setToast(null), 6200);
    },
    [],
  );

  const scheduleSpaceOverviewRefresh = useCallback(
    (spaceId: string, delayMs = 1_400) => {
      const pending = overviewTimers.current.get(spaceId);
      if (pending !== undefined) {
        window.clearTimeout(pending);
      }
      const timer = window.setTimeout(() => {
        overviewTimers.current.delete(spaceId);
        void refreshSpaceOverviewRef.current(spaceId);
      }, delayMs);
      overviewTimers.current.set(spaceId, timer);
    },
    [],
  );

  const cancelSpaceOverviewRefresh = useCallback((spaceId: string) => {
    const pending = overviewTimers.current.get(spaceId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      overviewTimers.current.delete(spaceId);
    }
    overviewRequests.current.delete(spaceId);
    setOverviewBusySpaceIds((current) => {
      if (!current.has(spaceId)) return current;
      const next = new Set(current);
      next.delete(spaceId);
      return next;
    });
  }, []);

  const refreshSpaceOverview = useCallback(
    async (spaceId: string, manual = false) => {
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === spaceId,
      );
      if (!workspace || overviewRequests.current.has(spaceId)) {
        return;
      }
      if (!workspace.notes.some(hasSubstantiveOverviewNote)) {
        if (!workspace.spaceOverview && !workspace.spaceKnowledge) return;
        const now = new Date().toISOString();
        setVault((current) => ({
          ...current,
          spaces: current.spaces.map((space) =>
            space.workspace.id === spaceId &&
            !space.notes.some(hasSubstantiveOverviewNote)
              ? {
                  ...space,
                  spaceOverview: undefined,
                  spaceKnowledge: undefined,
                  updatedAt: now,
                }
              : space,
          ),
          updatedAt: now,
        }));
        return;
      }
      const preparedAt = new Date().toISOString();
      const preparedKnowledge = prepareSpaceKnowledgeIndex(workspace, preparedAt);
      if (
        !workspace.settings.includeExistingNotesInAIContext ||
        !isSelectedAIConfigured(workspace.settings)
      ) {
        const localKnowledge = { ...preparedKnowledge, stale: false };
        setVault((current) => {
          const currentSpace = current.spaces.find(
            (space) => space.workspace.id === spaceId,
          );
          if (!currentSpace) return current;
          const now = new Date().toISOString();
          return {
            ...current,
            spaces: current.spaces.map((space) =>
              space.workspace.id === spaceId
                ? { ...space, spaceKnowledge: localKnowledge, updatedAt: now }
                : space,
            ),
            updatedAt: now,
          };
        });
        if (manual) {
          showToast(
            "Local Space overview",
            workspace.settings.includeExistingNotesInAIContext
              ? `Add an ${selectedAIProviderName(workspace.settings)} key in Settings when you want Orion to write a richer living overview.`
              : "Existing-note AI context is off. Orion refreshed the private local Space index without sending note-derived material to a provider.",
          );
        }
        return;
      }

      const requestId = `space-overview-${nanoid(10)}`;
      const fingerprint = spaceKnowledgeFingerprint(workspace);
      overviewRequests.current.set(spaceId, requestId);
      setOverviewBusySpaceIds((current) => {
        const next = new Set(current);
        next.add(spaceId);
        return next;
      });
      setOverviewErrors((current) => {
        const next = new Map(current);
        next.delete(spaceId);
        return next;
      });

      try {
        let knowledge = preparedKnowledge;
        for (const blueprint of pendingSpaceBlueprints(knowledge)) {
          const clusterResult = await organizeWithAI(
            buildSpaceBlueprintRequest(workspace, knowledge, blueprint.id),
          );
          if (overviewRequests.current.get(spaceId) !== requestId) return;
          const liveSpace = vaultRef.current.spaces.find(
            (space) => space.workspace.id === spaceId,
          );
          if (
            !liveSpace ||
            spaceKnowledgeFingerprint(liveSpace) !== fingerprint
          ) {
            scheduleSpaceOverviewRefresh(spaceId, 900);
            return;
          }
          knowledge = applySpaceBlueprintResult(
            knowledge,
            blueprint.id,
            clusterResult,
            new Date().toISOString(),
          );
        }
        const result = await organizeWithAI(
          buildSpaceRootRequest(workspace, knowledge),
        );
        if (overviewRequests.current.get(spaceId) !== requestId) {
          return;
        }
        const liveSpace = vaultRef.current.spaces.find(
          (space) => space.workspace.id === spaceId,
        );
        if (
          !liveSpace ||
          spaceKnowledgeFingerprint(liveSpace) !== fingerprint
        ) {
          scheduleSpaceOverviewRefresh(spaceId, 900);
          return;
        }

        const now = new Date().toISOString();
        const overview = applySpaceOverviewResult(liveSpace, result, now);
        const completedKnowledge = applySpaceRootResult(
          knowledge,
          result,
          now,
        );
        setVault((current) => {
          const currentSpace = current.spaces.find(
            (space) => space.workspace.id === spaceId,
          );
          if (
            !currentSpace ||
            spaceKnowledgeFingerprint(currentSpace) !== fingerprint
          ) {
            return current;
          }
          return {
            ...current,
            spaces: current.spaces.map((space) =>
              space.workspace.id === spaceId
                ? {
                    ...space,
                    spaceOverview: overview,
                    spaceKnowledge: completedKnowledge,
                    updatedAt: now,
                  }
                : space,
            ),
            updatedAt: now,
          };
        });
      } catch (error) {
        if (overviewRequests.current.get(spaceId) !== requestId) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setOverviewErrors((current) => {
          const next = new Map(current);
          next.set(spaceId, message);
          return next;
        });
      } finally {
        if (overviewRequests.current.get(spaceId) === requestId) {
          overviewRequests.current.delete(spaceId);
          setOverviewBusySpaceIds((current) => {
            const next = new Set(current);
            next.delete(spaceId);
            return next;
          });
        }
      }
    },
    [scheduleSpaceOverviewRefresh, showToast],
  );
  refreshSpaceOverviewRef.current = refreshSpaceOverview;

  useEffect(
    () => () => {
      for (const timer of overviewTimers.current.values()) {
        window.clearTimeout(timer);
      }
      overviewTimers.current.clear();
      overviewRequests.current.clear();
    },
    [],
  );

  useEffect(() => {
    const localKnowledgeIsCurrent =
      Boolean(snapshot.spaceKnowledge) && !snapshot.spaceKnowledge?.stale;
    const providerKnowledgeIsCurrent =
      localKnowledgeIsCurrent &&
      Boolean(snapshot.spaceKnowledge?.blueprints.length) &&
      snapshot.spaceKnowledge?.blueprints.every(
        ({ origin }) => origin === "provider",
      );
    const providerOverviewIsCurrent =
      Boolean(snapshot.spaceOverview) && !snapshot.spaceOverview?.stale;
    if (
      !hydrated ||
      !snapshot.notes.some(hasSubstantiveOverviewNote) ||
      (localKnowledgeIsCurrent &&
        (!snapshot.settings.includeExistingNotesInAIContext ||
          !isSelectedAIConfigured(snapshot.settings) ||
          (providerKnowledgeIsCurrent && providerOverviewIsCurrent)))
    ) {
      return;
    }
    scheduleSpaceOverviewRefresh(snapshot.workspace.id, 1_800);
  }, [
    hydrated,
    scheduleSpaceOverviewRefresh,
    snapshot.notes.length,
    snapshot.settings.anthropicApiKeyConfigured,
    snapshot.settings.apiKeyConfigured,
    snapshot.settings.includeExistingNotesInAIContext,
    snapshot.settings.model,
    snapshot.spaceKnowledge,
    snapshot.spaceOverview,
    snapshot.workspace.id,
  ]);

  const queueSnapshotSave = useCallback((nextVault: OrionVault) => {
    pendingSaveCount.current += 1;
    const queued = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        await saveSnapshot(nextVault, persistedVaultUpdatedAt.current);
        persistedVaultUpdatedAt.current = nextVault.updatedAt;
      })
      .finally(() => {
        pendingSaveCount.current = Math.max(0, pendingSaveCount.current - 1);
      });
    saveQueue.current = queued;
    return queued;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setPersistenceEnabled(false);
    setVaultLoadError(null);
    loadSnapshot()
      .then((saved) => {
        if (cancelled) return;
        persistedVaultUpdatedAt.current = saved?.updatedAt ?? null;
        const baseVault = saved ?? createEmptyVault();
        const spaces = baseVault.spaces.map((savedSpace) => {
          const base = isRetiredStarterVault(savedSpace)
            ? {
                ...createEmptySnapshot(
                  savedSpace.workspace.name,
                  new Date().toISOString(),
                  savedSpace.workspace.id,
                ),
                settings: { ...savedSpace.settings },
              }
            : savedSpace;
          const reconciled = reconcileSnapshotConceptVocabulary(base);
          return {
            ...reconciled,
            studio: normalizeStudio(base.studio),
            settings: {
              ...defaultSettings,
              ...base.settings,
              // The desktop app deliberately trusts this non-secret status
              // flag at launch. Reading the API key itself here makes macOS
              // show a Keychain password prompt before the user invokes any
              // AI feature, especially when upgrading from an ad-hoc build.
              apiKeyConfigured: isTauriRuntime()
                ? base.settings.apiKeyConfigured
                : false,
              anthropicApiKeyConfigured: isTauriRuntime()
                ? (base.settings.anthropicApiKeyConfigured ?? false)
                : false,
              elevenLabsApiKeyConfigured: isTauriRuntime()
                ? (base.settings.elevenLabsApiKeyConfigured ?? false)
                : false,
              speechVoice: normalizeSpeechVoice(base.settings.speechVoice),
              sidebarCollapsed: base.settings.sidebarCollapsed === true,
              elevenLabsVoiceId: normalizeElevenLabsVoiceId(
                base.settings.elevenLabsVoiceId,
              ),
              elevenLabsVoices: normalizeElevenLabsVoices(
                base.settings.elevenLabsVoices,
                base.settings.elevenLabsVoiceId,
              ),
              themePreset: normalizeThemePreset(base.settings.themePreset),
              themeAccent: normalizeThemeAccent(base.settings.themeAccent),
              themeAccentCustom: normalizeThemeColor(
                base.settings.themeAccentCustom,
              ),
              themeCanvasTone: normalizeThemeCanvasTone(
                base.settings.themeCanvasTone,
              ),
              themeCanvasCustom: normalizeThemeColor(
                base.settings.themeCanvasCustom,
              ),
              themeSurfaceLift: normalizeThemeSurfaceLift(
                base.settings.themeSurfaceLift,
              ),
              themeSurfaceCustom: normalizeThemeColor(
                base.settings.themeSurfaceCustom,
              ),
              themeTextWarmth: normalizeThemeTextWarmth(
                base.settings.themeTextWarmth,
              ),
              themeContrast: normalizeThemeContrast(
                base.settings.themeContrast,
              ),
              homeAtmosphere: normalizeHomeAtmosphere(
                base.settings.homeAtmosphere,
              ),
              homeAtmosphereTone: normalizeHomeAtmosphereTone(
                base.settings.homeAtmosphereTone,
              ),
              homeAtmosphereMotion: normalizeHomeAtmosphereMotion(
                base.settings.homeAtmosphereMotion,
              ),
            },
          };
        });
        const nextVault: OrionVault = {
          ...baseVault,
          spaces,
          activeSpaceId: spaces.some(
            (space) =>
              space.workspace.id === baseVault.activeSpaceId,
          )
            ? baseVault.activeSpaceId
            : spaces[0].workspace.id,
        };
        setVault(nextVault);
        replaceHistory(
          [createNavigationEntry({ screen: "home" })],
          0,
        );
        setPersistenceEnabled(true);
        setHydrated(true);
      })
      .catch((error) => {
        if (cancelled) return;
        setPersistenceEnabled(false);
        setVaultLoadError(
          error instanceof Error ? error.message : String(error),
        );
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt, replaceHistory]);

  useEffect(() => {
    if (!hydrated || !persistenceEnabled || closing) return;
    if (skipAutosaveVault.current === vault) {
      skipAutosaveVault.current = null;
      return;
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const timer = window.setTimeout(() => {
      if (saveTimer.current === timer) {
        saveTimer.current = null;
      }
      void queueSnapshotSave(vault).catch((error) =>
        showToast(
          "Couldn’t save",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }, 420);
    saveTimer.current = timer;
    return () => {
      if (saveTimer.current === timer) {
        window.clearTimeout(timer);
        saveTimer.current = null;
      }
    };
  }, [
    hydrated,
    closing,
    persistenceEnabled,
    queueSnapshotSave,
    showToast,
    vault,
  ]);

  useEffect(() => {
    const cache = preparedSpeech.current;
    return () => {
      cache.clear();
      const context = speechPlaybackContext.current;
      speechPlaybackContext.current = null;
      if (context && context.state !== "closed") void context.close();
    };
  }, []);

  useEffect(() => {
    if (
      isTauriRuntime() ||
      !hydrated ||
      !persistenceEnabled
    ) {
      return undefined;
    }

    const flushBrowserVault = () => {
      void saveSnapshot(vaultRef.current);
    };
    window.addEventListener("beforeunload", flushBrowserVault);
    window.addEventListener("pagehide", flushBrowserVault);
    return () => {
      window.removeEventListener("beforeunload", flushBrowserVault);
      window.removeEventListener("pagehide", flushBrowserVault);
    };
  }, [hydrated, persistenceEnabled]);

  useEffect(() => {
    if (!hydrated || !persistenceEnabled || !isTauriRuntime()) {
      return undefined;
    }
    let disposed = false;
    let refreshing = false;

    const refreshExternalVault = async () => {
      if (
        disposed ||
        refreshing ||
        closingRef.current ||
        saveTimer.current !== null ||
        pendingSaveCount.current > 0
      ) {
        return;
      }
      refreshing = true;
      try {
        const latest = await loadSnapshot();
        if (disposed || !latest) return;
        const previousVault = vaultRef.current;
        if (shouldAcceptExternalVault(previousVault.updatedAt, latest.updatedAt)) {
          const reconciledLatest: OrionVault = {
            ...latest,
            spaces: latest.spaces.map(reconcileSnapshotConceptVocabulary),
          };
          const overviewSpaceIds = spacesNeedingOverviewRefresh(
            previousVault,
            reconciledLatest,
          );
          persistedVaultUpdatedAt.current = latest.updatedAt;
          skipAutosaveVault.current = reconciledLatest;
          vaultRef.current = reconciledLatest;
          setVault(reconciledLatest);
          for (const spaceId of overviewSpaceIds) {
            scheduleSpaceOverviewRefresh(spaceId, 800);
          }
        }
      } catch {
        // A foreground refresh is opportunistic. Normal saves and explicit
        // citation opens still surface actionable persistence errors.
      } finally {
        refreshing = false;
      }
    };

    window.addEventListener("focus", refreshExternalVault);
    document.addEventListener("visibilitychange", refreshExternalVault);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshExternalVault);
      document.removeEventListener("visibilitychange", refreshExternalVault);
    };
  }, [hydrated, persistenceEnabled, scheduleSpaceOverviewRefresh]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;

    let disposed = false;
    let unlistenClose: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    let unregisterExitGuard: (() => void) | undefined;

    const lockAndSaveLatest = async () => {
      if (closingRef.current) return false;
      closingRef.current = true;
      setClosing(true);
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      try {
        if (persistenceEnabledRef.current) {
          await queueSnapshotSave(vaultRef.current);
        }
        return true;
      } catch (error) {
        closingRef.current = false;
        setClosing(false);
        showToast(
          "Quit paused — vault not saved",
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    };

    void (async () => {
      const [{ invoke }, { listen }, { getCurrentWindow }] = await Promise.all([
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/event"),
        import("@tauri-apps/api/window"),
      ]);
      if (disposed) return;

      const appWindow = getCurrentWindow();
      const stopClose = await appWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (!(await lockAndSaveLatest())) return;
        try {
          await invoke("complete_app_exit");
        } catch (error) {
          closingRef.current = false;
          setClosing(false);
          showToast(
            "Close paused",
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      const stopQuit = await listen<number>(
        "orion-quit-requested",
        async (event) => {
          const attempt = event.payload;
          try {
            await invoke("acknowledge_app_exit", { attempt });
            if (closingRef.current) return;
            if (!(await lockAndSaveLatest())) {
              await invoke("cancel_app_exit", { attempt });
              return;
            }
            await invoke("complete_app_exit");
          } catch (error) {
            void invoke("cancel_app_exit", { attempt });
            closingRef.current = false;
            setClosing(false);
            showToast(
              "Quit paused",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );

      if (disposed) {
        stopClose();
        stopQuit();
      } else {
        unlistenClose = stopClose;
        unlistenQuit = stopQuit;
        await invoke("set_exit_guard_ready", { ready: true });
        unregisterExitGuard = () => {
          void invoke("set_exit_guard_ready", { ready: false });
        };
      }
    })().catch((error) => {
      closingRef.current = false;
      setClosing(false);
      showToast(
        "Quit protection unavailable",
        error instanceof Error ? error.message : String(error),
      );
    });

    return () => {
      disposed = true;
      unregisterExitGuard?.();
      unlistenClose?.();
      unlistenQuit?.();
    };
  }, [queueSnapshotSave, showToast]);

  const closeConnections = useCallback(() => {
    setConnectionConceptId(null);
    setConnectionOriginNoteId(null);
  }, []);

  const resetSpaceNavigation = useCallback(
    () => {
      setScreen("home");
      setCommandOpen(false);
      setImportOpen(false);
      setSelectedSourceId(null);
      setContextOpen(false);
      closeConnections();
      snapshotBeforeImport.current = null;
      replaceHistory(
        [createNavigationEntry({ screen: "home" })],
        0,
      );
    },
    [closeConnections, replaceHistory],
  );

  const switchSpace = useCallback(
    (spaceId: string) => {
      const target = vaultRef.current.spaces.find(
        (space) => space.workspace.id === spaceId,
      );
      if (!target || spaceId === vaultRef.current.activeSpaceId) {
        return;
      }
      setVault((current) => ({
        ...current,
        activeSpaceId: spaceId,
        updatedAt: new Date().toISOString(),
      }));
      resetSpaceNavigation();
      showToast(
        target.workspace.name,
        "Space switched. Its links and concepts stay independent.",
      );
    },
    [resetSpaceNavigation, showToast],
  );

  const createSpace = useCallback(
    (name: string) => {
      const normalizedName = name.trim().replace(/\s+/g, " ");
      if (
        !normalizedName ||
        vaultRef.current.spaces.some(
          (space) =>
            space.workspace.name.toLocaleLowerCase() ===
            normalizedName.toLocaleLowerCase(),
        )
      ) {
        return;
      }
      const now = new Date().toISOString();
      const space = createEmptySnapshot(
        normalizedName,
        now,
        `space-${nanoid(10)}`,
      );
      space.settings = { ...snapshotRef.current.settings };
      setVault((current) => ({
        ...current,
        spaces: [...current.spaces, space],
        activeSpaceId: space.workspace.id,
        updatedAt: now,
      }));
      resetSpaceNavigation();
      showToast(
        "Blank space created",
        `${normalizedName} is completely separate from your other projects.`,
      );
    },
    [resetSpaceNavigation, showToast],
  );

  const deleteSpace = useCallback(
    (spaceId: string): boolean => {
      const currentVault = vaultRef.current;
      const space = currentVault.spaces.find(
        (candidate) => candidate.workspace.id === spaceId,
      );
      if (!space) return false;
      if (currentVault.spaces.length <= 1) {
        showToast(
          "Keep one Space",
          "Create another Space before deleting Orion's final one.",
        );
        return false;
      }
      if (
        !window.confirm(
          `Delete “${space.workspace.name}” and its ${space.notes.length} ${space.notes.length === 1 ? "note" : "notes"}, ${space.sources.length} ${space.sources.length === 1 ? "source" : "sources"}, concepts, links, tasks, and Chat? This cannot be undone.`,
        )
      ) {
        return false;
      }

      const now = new Date().toISOString();
      const deletion = deleteSpaceFromVault(currentVault, spaceId, now);
      if (!deletion.deleted) return false;
      const nextSpace = deletion.vault.spaces.find(
        (candidate) =>
          candidate.workspace.id === deletion.nextActiveSpaceId,
      );

      chatRequests.current.invalidate(spaceId);
      setChatBusySpaceIds((current) => {
        if (!current.has(spaceId)) return current;
        const next = new Set(current);
        next.delete(spaceId);
        return next;
      });
      cancelSpaceOverviewRefresh(spaceId);
      setOverviewErrors((current) => {
        if (!current.has(spaceId)) return current;
        const next = new Map(current);
        next.delete(spaceId);
        return next;
      });
      for (const requestKey of wikiEnrichmentRequests.current) {
        if (requestKey.startsWith(`${spaceId}:`)) {
          wikiEnrichmentRequests.current.delete(requestKey);
        }
      }
      setLinkedArticleJobs((current) => {
        for (const job of current) {
          if (job.workspaceId === spaceId) {
            linkedArticleRequests.current.cancel(
              `${job.workspaceId}:${job.noteId}`,
            );
          }
        }
        return current.filter((job) => job.workspaceId !== spaceId);
      });
      setVault((current) => deleteSpaceFromVault(current, spaceId, now).vault);

      if (deletion.activeSpaceChanged) {
        resetSpaceNavigation();
      }
      showToast(
        "Space deleted",
        deletion.activeSpaceChanged && nextSpace
          ? `“${space.workspace.name}” was removed. ${nextSpace.workspace.name} is now open.`
          : `“${space.workspace.name}” was removed.`,
      );
      return true;
    },
    [
      cancelSpaceOverviewRefresh,
      resetSpaceNavigation,
      showToast,
    ],
  );

  const openConnections = useCallback(
    (conceptId: string, originNoteId: string | null = null) => {
      setConnectionConceptId(conceptId);
      setConnectionOriginNoteId(originNoteId);
      setContextOpen(false);
    },
    [],
  );

  const openNote = useCallback(
    (
      noteId: string,
      trackHistory = true,
      preserveConnections = false,
      restorePosition?: ScrollPosition,
    ) => {
      const now = new Date().toISOString();
      const route: NavigationRoute = { screen: "note", noteId };
      pendingScrollRestore.current = restorePosition
        ? { route, position: restorePosition }
        : null;
      setSnapshot((current) => ({
        ...current,
        notes: current.notes.map((note) =>
          note.id === noteId ? { ...note, lastOpenedAt: now } : note,
        ),
        activeNoteId: noteId,
        updatedAt: now,
      }));
      setScreen("note");
      setSelectedSourceId(null);
      if (!preserveConnections) {
        closeConnections();
        setContextOpen(false);
      }
      if (trackHistory) {
        const next = pushNavigationHistory(
          historyRef.current,
          historyIndexRef.current,
          route,
          readScrollPosition(workspaceContentRef.current),
        );
        replaceHistory(next.entries, next.index);
      }
    },
    [closeConnections, replaceHistory],
  );

  const openOrionCitation = useCallback(
    async (rawUrl: string) => {
      const link = parseOrionNoteLink(rawUrl);
      if (!link) return;
      const { spaceId, noteId } = link;

      const latest = await loadSnapshot();
      const reconciledLatest = latest
        ? {
            ...latest,
            spaces: latest.spaces.map(reconcileSnapshotConceptVocabulary),
          }
        : null;
      const space = reconciledLatest?.spaces.find(
        (candidate) => candidate.workspace.id === spaceId,
      );
      const note = space?.notes.find((candidate) => candidate.id === noteId);
      if (!latest || !reconciledLatest || !space || !note) {
        showToast(
          "Note unavailable",
          "That Orion citation no longer resolves in its original Space.",
        );
        return;
      }

      const now = new Date().toISOString();
      const nextVault: OrionVault = {
        ...reconciledLatest,
        activeSpaceId: spaceId,
        spaces: reconciledLatest.spaces.map((candidate) =>
          candidate.workspace.id === spaceId
            ? {
                ...candidate,
                notes: candidate.notes.map((candidateNote) =>
                  candidateNote.id === noteId
                    ? { ...candidateNote, lastOpenedAt: now }
                    : candidateNote,
                ),
                activeNoteId: noteId,
                updatedAt: now,
              }
            : candidate,
        ),
        updatedAt: now,
      };
      persistedVaultUpdatedAt.current = latest.updatedAt;
      vaultRef.current = nextVault;
      setVault(nextVault);
      setScreen("note");
      closeConnections();
      setSelectedSourceId(null);
      setContextOpen(false);
      replaceHistory(
        [createNavigationEntry({ screen: "note", noteId })],
        0,
      );
    },
    [closeConnections, replaceHistory, showToast],
  );

  useEffect(() => {
    if (!hydrated || !isTauriRuntime()) {
      return undefined;
    }
    let disposed = false;
    let stopListening: (() => void) | undefined;
    const seen = new Set<string>();
    const openUrls = (urls: readonly string[]) => {
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        void openOrionCitation(url).catch((error) => {
          showToast(
            "Couldn’t open citation",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    };

    void import("@tauri-apps/plugin-deep-link")
      .then(async ({ getCurrent, onOpenUrl }) => {
        const current = await getCurrent();
        if (!disposed && current) {
          openUrls(current);
        }
        const unlisten = await onOpenUrl((urls) => {
          if (!disposed) openUrls(urls);
        });
        if (disposed) {
          unlisten();
        } else {
          stopListening = unlisten;
        }
      })
      .catch((error) => {
        showToast(
          "Citation links unavailable",
          error instanceof Error ? error.message : String(error),
        );
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [hydrated, openOrionCitation, showToast]);

  const followConcept = useCallback(
    (conceptId: string, originNoteId: string | null = null) => {
      const current = snapshotRef.current;
      const concept = current.concepts.find(
        (candidate) => candidate.id === conceptId,
      );
      if (!concept) {
        return;
      }
      const destination = resolveConceptDestination(concept, current.notes);
      if (destination.kind === "note") {
        openNote(destination.noteId);
      } else if (destination.kind === "connections") {
        openConnections(conceptId, originNoteId);
      }
    },
    [openConnections, openNote],
  );

  const navigateHistory = useCallback(
    (direction: -1 | 1) => {
      const next = moveNavigationHistory(
        historyRef.current,
        historyIndexRef.current,
        direction,
        readScrollPosition(workspaceContentRef.current),
      );
      if (!next) return;
      const entry = next.entries[next.index];
      replaceHistory(next.entries, next.index);
      pendingScrollRestore.current = {
        route: entry.route,
        position: {
          scrollLeft: entry.scrollLeft,
          scrollTop: entry.scrollTop,
        },
      };
      closeConnections();
      setContextOpen(false);
      setSelectedSourceId(null);
      if (entry.route.screen === "note") {
        const noteId = entry.route.noteId;
        const now = new Date().toISOString();
        setSnapshot((current) => ({
          ...current,
          notes: current.notes.map((note) =>
            note.id === noteId ? { ...note, lastOpenedAt: now } : note,
          ),
          activeNoteId: noteId,
          updatedAt: now,
        }));
        setScreen("note");
      } else {
        setScreen(entry.route.screen);
      }
    },
    [closeConnections, replaceHistory],
  );

  const createNote = useCallback(() => {
    const now = new Date().toISOString();
    const id = `note-${nanoid(10)}`;
    const note: Note = {
      id,
      title: "Untitled note",
      slug: `untitled-${nanoid(5).toLocaleLowerCase()}`,
      summary: "A new thread in your atlas.",
      body: "",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      color: "#8798ff",
    };
    setSnapshot((current) => ({
      ...current,
      notes: [note, ...current.notes],
      activeNoteId: id,
      updatedAt: now,
    }));
    openNote(id);
    window.setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>(".note-title-input");
      input?.select();
    }, 80);
  }, [openNote]);

  const startGenerate = useCallback(
    (input: { kind: GenerateKind; instruction: string; useSpaceNotes?: boolean }) => {
      if (!isSelectedAIConfigured(snapshotRef.current.settings)) return;
      const instruction = truncateGenerateInstruction(input.instruction);
      const now = new Date().toISOString();
      const noteId = `note-${nanoid(10)}`;
      const jobId = `generate-${nanoid(10)}`;
      const title = titleFromGenerateInstruction(instruction, input.kind);
      const note = createGeneratePlaceholderNote({
        id: noteId,
        title,
        kind: input.kind,
        now,
      });
      const job: GenerateJob = {
        id: jobId,
        workspaceId: snapshotRef.current.workspace.id,
        noteId,
        kind: input.kind,
        title,
        instruction,
        useSpaceNotes: input.useSpaceNotes ?? snapshotRef.current.settings.includeExistingNotesInAIContext,
        progress: 12,
        stage: "preparing",
      };
      const requestKey = `${job.workspaceId}:${noteId}`;
      if (!generateRequests.current.begin(requestKey, jobId)) return;
      const snapshotWithNote = {
        ...snapshotRef.current,
        notes: [note, ...snapshotRef.current.notes],
        activeNoteId: noteId,
        updatedAt: now,
      };
      snapshotRef.current = snapshotWithNote;
      setSnapshot(snapshotWithNote);
      setGenerateJobs((current) => [job, ...current]);
      openNote(noteId);

      const patchJob = (patch: Partial<GenerateJob>) => {
        setGenerateJobs((current) =>
          current.map((candidate) =>
            candidate.id === jobId ? { ...candidate, ...patch } : candidate,
          ),
        );
      };

      void (async () => {
        try {
          let body = await generateFromSpace(snapshotWithNote, {
            originNoteId: noteId, kind: input.kind, instruction,
            useSpaceNotes: job.useSpaceNotes,
          }, chatWithOrion, {
            signal: generateRequests.current.signal(requestKey),
            onProgress: (stage, completed, total) => patchJob({
              stage, progress: stage === "preparing" ? 16 : 28 + Math.round(30 * completed / Math.max(1, total)),
            }),
          });
          if (!generateRequests.current.owns(requestKey, jobId)) return;
          if (snapshotRef.current.workspace.id !== job.workspaceId) return;
          const wantsPlates =
            (input.kind === "slide-deck" ||
              input.kind === "slide-deck-narrated") &&
            snapshotWithNote.settings.apiKeyConfigured;
          if (wantsPlates) {
            patchJob({ stage: "illustrating", progress: 62 });
            const pendingSlides = parseDeckSlides(body)
              .map((slide, index) => ({ slide, index }))
              .filter(({ slide }) => !slide.imageSrc)
              .slice(0, MAX_DECK_SLIDE_IMAGES);
            const illustrated = await runPresentationWaves({
              signal: generateRequests.current.signal(requestKey),
              jobs: pendingSlides.map(({ slide, index }) => ({
                id: `slide-${index}`,
                kind: "image" as const,
                heading: slide.title,
                index,
                bullets: slide.bullets,
                brief: slide.visualBrief ?? "",
              })),
              execute: async (imageJob) => {
                const prompt = buildSlideImagePrompt({
                  deckTitle: title,
                  slideTitle: imageJob.heading,
                  bullets: imageJob.bullets,
                  visualBrief: imageJob.brief,
                });
                const image = await generateNoteImage(prompt.prompt);
                const bytes = Uint8Array.from(atob(image.base64Data), (ch) =>
                  ch.charCodeAt(0),
                );
                const file = new File(
                  [bytes],
                  `${imageJob.heading.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "slide"}.jpg`,
                  { type: "image/jpeg" },
                );
                const saved = await saveNoteImage(
                  file,
                  `image_${nanoid(16)}`,
                );
                return { index: imageJob.index, saved, alt: prompt.alt };
              },
            });
            const plates = [...illustrated.results].sort(
              (left, right) => left.result.index - right.result.index,
            );
            for (const { result: plate } of plates) {
              body = insertImageForSlide(
                body,
                plate.index,
                `![${plate.alt}](${plate.saved.src})`,
              );
            }
          }
          if (!generateRequests.current.owns(requestKey, jobId)) return;
          if (snapshotRef.current.workspace.id !== job.workspaceId) return;
          const finishedAt = new Date().toISOString();
          setSnapshot((current) => ({
            ...current,
            notes: current.notes.map((candidate) =>
              candidate.id === noteId
                ? {
                    ...candidate,
                    body,
                    summary: candidate.summary,
                    tags: [
                      ...new Set([
                        ...candidate.tags.filter(
                          (tag) => tag !== "orion-generate-pending",
                        ),
                        ...(input.kind === "slide-deck" ||
                        input.kind === "slide-deck-narrated"
                          ? [SLIDE_DECK_TAG]
                          : []),
                      ]),
                    ],
                    updatedAt: finishedAt,
                  }
                : candidate,
            ),
            updatedAt: finishedAt,
          }));
          patchJob({ stage: "complete", progress: 100 });
          window.setTimeout(() => {
            setGenerateJobs((current) =>
              current.filter((candidate) => candidate.id !== jobId),
            );
          }, 2_400);
        } catch (error) {
          if (!generateRequests.current.owns(requestKey, jobId)) return;
          patchJob({
            stage: "error",
            progress: 100,
            error:
              error instanceof Error ? error.message : String(error),
          });
        } finally {
          generateRequests.current.finish(requestKey, jobId);
        }
      })();
    },
    [openNote],
  );

  const restartGenerate = useCallback(
    (job: GenerateJob) => {
      generateRequests.current.cancel(`${job.workspaceId}:${job.noteId}`);
      setGenerateJobs((current) =>
        current.filter((candidate) => candidate.id !== job.id),
      );
      const now = new Date().toISOString();
      setSnapshot((current) => {
        if (current.workspace.id !== job.workspaceId) return current;
        return deleteNoteFromSnapshot(current, job.noteId, now).snapshot;
      });
      startGenerate({ kind: job.kind, instruction: job.instruction, useSpaceNotes: job.useSpaceNotes });
    },
    [startGenerate],
  );

  const deleteGenerate = useCallback(
    (job: GenerateJob) => {
      generateRequests.current.cancel(`${job.workspaceId}:${job.noteId}`);
      setGenerateJobs((current) =>
        current.filter((candidate) => candidate.id !== job.id),
      );
      const now = new Date().toISOString();
      setSnapshot((current) => {
        if (current.workspace.id !== job.workspaceId) return current;
        return deleteNoteFromSnapshot(current, job.noteId, now).snapshot;
      });
    },
    [],
  );

  const updateNote = useCallback((nextNote: Note) => {
    const normalized: Note = {
      ...nextNote,
      slug:
        nextNote.title === "Untitled note"
          ? nextNote.slug
          : slugifyTitle(nextNote.title) || nextNote.slug,
    };
    setSnapshot((current) => {
      const previous = current.notes.find((note) => note.id === normalized.id);
      const merged: Note = previous
        ? {
            ...normalized,
            conceptIds: [
              ...new Set([
                ...previous.conceptIds,
                ...normalized.conceptIds,
              ]),
            ],
          }
        : normalized;
      const notes = current.notes.map((note) =>
        note.id === merged.id ? merged : note,
      );
      const vocabularyChanged =
        !previous ||
        previous.title !== merged.title ||
        previous.summary !== merged.summary ||
        previous.color !== merged.color ||
        previous.aliases.join("\u0000") !== merged.aliases.join("\u0000") ||
        previous.tags.join("\u0000") !== merged.tags.join("\u0000");
      if (!vocabularyChanged) {
        return {
          ...current,
          notes,
          updatedAt: new Date().toISOString(),
        };
      }
      const vocabulary = reconcileConceptVocabulary(notes, current.concepts);
      return {
        ...current,
        notes: vocabulary.notes,
        concepts: vocabulary.concepts,
        updatedAt: new Date().toISOString(),
      };
    });
  }, []);

  const attachSourceToNote = useCallback(
    (noteId: EntityId, sourceId: EntityId) => {
      setSnapshot((current) =>
        attachSourceToNoteInSnapshot(
          current,
          noteId,
          sourceId,
          new Date().toISOString(),
        ),
      );
    },
    [],
  );

  const toggleHomeTask = useCallback(
    (task: NoteTask, checked: boolean) => {
      const note = snapshotRef.current.notes.find(
        (candidate) => candidate.id === task.noteId,
      );
      if (!note) return;
      const body = setTaskChecked(note.body, task.lineIndex, checked);
      if (body === note.body) return;
      updateNote({
        ...note,
        body,
        updatedAt: new Date().toISOString(),
      });
    },
    [updateNote],
  );

  const refreshWikiFromNote = useCallback(
    async (noteId: EntityId) => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === workspaceId,
      );
      const originNote = workspace?.notes.find(
        (note) => note.id === noteId,
      );
      if (
        !workspace ||
        !originNote ||
        !isSelectedAIConfigured(workspace.settings) ||
        !hasSubstantiveKnowledgeNote(originNote)
      ) {
        return;
      }

      const requestKey = `${workspaceId}:${noteId}`;
      if (wikiEnrichmentRequests.current.has(requestKey)) {
        return;
      }
      wikiEnrichmentRequests.current.add(requestKey);
      showToast(
        "Updating Space wiki",
        `Looking for articles that “${originNote.title}” can enrich.`,
      );

      try {
        let result: OrganizeContentResult;
        let baseOriginVersion = noteVersion(originNote);
        let destinationBaseVersions: Array<{
          noteId: EntityId;
          version: string;
        }> = [];
        if (isTauriRuntime()) {
          const enrichment = await runKnowledgeEnrichment({
            snapshot: workspace,
            originNote,
            model: workspace.settings.model,
            effort: workspace.settings.reasoningEffort,
            driver: runKnowledgeAssignment,
          });
          result = enrichment.result;
          baseOriginVersion = enrichment.baseOriginVersion;
          destinationBaseVersions = enrichment.destinationBaseVersions;
        } else {
          result = await organizeWithAI(
            buildWikiEnrichmentRequest(workspace, originNote),
          );
        }
        const liveSpace = vaultRef.current.spaces.find(
          (space) => space.workspace.id === workspaceId,
        );
        const liveOrigin = liveSpace?.notes.find(
          (note) => note.id === noteId,
        );
        if (
          !liveSpace ||
          !liveOrigin ||
          noteVersion(liveOrigin) !== baseOriginVersion ||
          destinationBaseVersions.some(({ noteId, version }) => {
            const destination = liveSpace.notes.find(
              (note) => note.id === noteId,
            );
            return !destination || noteVersion(destination) !== version;
          })
        ) {
          throw new Error(
            "This Space changed while Orion was reading it, so the stale refresh was skipped.",
          );
        }

        if (result.wikiArticles.length === 0) {
          showToast(
            "Space wiki is current",
            `“${originNote.title}” did not add reliable context to another article.`,
          );
          return;
        }

        const now = new Date().toISOString();
        const applied = applyWikiEnrichmentResult(
          liveSpace,
          liveOrigin,
          result,
          now,
        );
        const changedCount =
          applied.updatedNoteIds.length + applied.createdNoteIds.length;
        const appliedSnapshot =
          changedCount > 0
            ? markSpaceOverviewStale(applied.snapshot)
            : applied.snapshot;
        setVault((current) => {
          const currentSpace = current.spaces.find(
            (space) => space.workspace.id === workspaceId,
          );
          const currentOrigin = currentSpace?.notes.find(
            (note) => note.id === noteId,
          );
          if (
            !currentSpace ||
            !currentOrigin ||
            currentOrigin.updatedAt !== originNote.updatedAt
          ) {
            return current;
          }
          return {
            ...current,
            spaces: current.spaces.map((space) =>
              space.workspace.id === workspaceId
                ? appliedSnapshot
                : space,
            ),
            updatedAt: now,
          };
        });
        if (changedCount > 0) {
          scheduleSpaceOverviewRefresh(workspaceId);
        }
        showToast(
          changedCount > 0 ? "Space wiki updated" : "Space wiki is current",
          changedCount > 0
            ? `${changedCount} ${
                changedCount === 1 ? "article was" : "articles were"
              } revised with ideas from “${originNote.title}”.`
            : `“${originNote.title}” did not add reliable context to another article.`,
        );
      } catch (error) {
        if (
          !vaultRef.current.spaces.some(
            (space) => space.workspace.id === workspaceId,
          )
        ) {
          return;
        }
        showToast(
          "Wiki refresh paused",
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        wikiEnrichmentRequests.current.delete(requestKey);
      }
    },
    [scheduleSpaceOverviewRefresh, showToast],
  );

  const finishNoteEditing = useCallback(
    (noteId: EntityId) => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === workspaceId,
      );
      const note = workspace?.notes.find((candidate) => candidate.id === noteId);
      if (!workspace || !note) {
        return;
      }
      const hasOverviewKnowledge = workspace.notes.some(
        hasSubstantiveOverviewNote,
      );
      const now = new Date().toISOString();
      setVault((current) => ({
        ...current,
        spaces: current.spaces.map((space) =>
          space.workspace.id === workspaceId
            ? {
                ...(hasOverviewKnowledge
                  ? markSpaceOverviewStale(space)
                  : { ...space, spaceOverview: undefined }),
                updatedAt: now,
              }
            : space,
        ),
        updatedAt: now,
      }));
      if (hasOverviewKnowledge) {
        scheduleSpaceOverviewRefresh(workspaceId);
      } else {
        cancelSpaceOverviewRefresh(workspaceId);
      }
      if (hasSubstantiveKnowledgeNote(note)) {
        void refreshWikiFromNote(noteId);
      }
    },
    [
      cancelSpaceOverviewRefresh,
      refreshWikiFromNote,
      scheduleSpaceOverviewRefresh,
    ],
  );

  const generateLinkedArticle = useCallback(
    async (
      workspace: AppSnapshot,
      articleId: EntityId,
      originNoteId: EntityId,
      phrase: string,
      instructions = "",
      selectedContext = "",
    ) => {
      const requestKey = `${workspace.workspace.id}:${articleId}`;
      const article = workspace.notes.find((note) => note.id === articleId);
      const originNote = workspace.notes.find(
        (note) => note.id === originNoteId,
      );
      if (!article || !originNote) {
        console.warn("[linked-article] request skipped", {
          requestKey,
          reason: !article ? "missing-article" : "missing-origin",
        });
        return;
      }
      if (!isLinkedArticlePlaceholder(article, phrase)) {
        console.warn("[linked-article] request skipped", {
          requestKey,
          reason: "article-is-not-an-empty-placeholder",
        });
        return;
      }
      if (linkedArticleRequests.current.has(requestKey)) {
        console.info("[linked-article] request already active", {
          requestKey,
        });
        return;
      }
      const revealArticle = () => {
        if (vaultRef.current.activeSpaceId === workspace.workspace.id) {
          openNote(articleId);
          return;
        }
        switchSpace(workspace.workspace.id);
        window.setTimeout(() => openNote(articleId), 0);
      };

      const jobId = `linked-article-${nanoid(10)}`;
      const initialJob: LinkedArticleJob = {
        id: jobId,
        workspaceId: workspace.workspace.id,
        noteId: articleId,
        originNoteId,
        title: phrase,
        originTitle: originNote.title,
        progress: isSelectedAIConfigured(workspace.settings) ? 12 : 0,
        stage: isSelectedAIConfigured(workspace.settings)
          ? "gathering"
          : "error",
        ...(instructions.trim()
          ? { instructions: instructions.trim().slice(0, 1_250) }
          : {}),
        ...(selectedContext.trim()
          ? { selectedContext: selectedContext.trim().slice(0, 12_000) }
          : {}),
        ...(!isSelectedAIConfigured(workspace.settings)
          ? {
              error: `Add an ${selectedAIProviderName(workspace.settings)} key in Settings to write this article.`,
            }
          : {}),
      };
      setLinkedArticleJobs((current) => [
        initialJob,
        ...current.filter(
          (job) =>
            !(
              job.workspaceId === workspace.workspace.id &&
              job.noteId === articleId
            ),
        ),
      ]);

      if (!isSelectedAIConfigured(workspace.settings)) {
        console.info("[linked-article] request paused", {
          requestKey,
          reason: "missing-api-key",
        });
        showToast(
          "Article link created",
          `Add an ${selectedAIProviderName(workspace.settings)} key in Settings to populate “${phrase}”.`,
          {
            label: "Open article",
            run: revealArticle,
          },
        );
        return;
      }

      if (!linkedArticleRequests.current.begin(requestKey, jobId)) {
        console.info("[linked-article] request already active", {
          requestKey,
        });
        return;
      }
      console.info("[linked-article] request started", {
        requestKey,
        attemptId: jobId,
        originNoteId,
      });
      const startedAt = Date.now();
      const progressTimer = window.setInterval(() => {
        setLinkedArticleJobs((current) =>
          current.map((job) => {
            if (job.id !== jobId || job.stage === "error") {
              return job;
            }
            const progress = linkedArticleProgressForElapsed(
              Date.now() - startedAt,
            );
            return {
              ...job,
              progress,
              stage: linkedArticleStageForProgress(progress),
            };
          }),
        );
      }, 700);

      try {
        const result = await waitForLinkedArticle(
          organizeWithAI(
            buildLinkedArticleRequest(
              workspace,
              originNote,
              phrase,
              instructions,
              selectedContext,
            ),
          ),
        );
        if (!linkedArticleRequests.current.owns(requestKey, jobId)) {
          return;
        }
        const liveSpace = vaultRef.current.spaces.find(
          (space) => space.workspace.id === workspace.workspace.id,
        );
        const liveArticle = liveSpace?.notes.find(
          (note) => note.id === articleId,
        );
        if (
          !liveArticle ||
          !isLinkedArticlePlaceholder(liveArticle, phrase)
        ) {
          throw new Error(
            "This article changed while Orion was writing. Your edits were kept.",
          );
        }
        const now = new Date().toISOString();
        const generatedArticle = applyLinkedArticleResult(
          article,
          result,
          phrase,
          workspace.workspace.name,
          now,
        );
        setVault((current) => {
          const spaces = current.spaces.map((space) => {
            if (space.workspace.id !== workspace.workspace.id) {
              return space;
            }
            const currentArticle = space.notes.find(
              (note) => note.id === articleId,
            );
            if (
              !currentArticle ||
              !isLinkedArticlePlaceholder(currentArticle, phrase)
            ) {
              return space;
            }
            const validSourceIds = new Set(
              space.sources.map((source) => source.id),
            );
            const notes = space.notes.map((note) =>
              note.id === articleId
                ? {
                    ...generatedArticle,
                    conceptIds: [...currentArticle.conceptIds],
                    sourceIds: [
                      ...new Set([
                        ...currentArticle.sourceIds,
                        ...generatedArticle.sourceIds,
                      ]),
                    ].filter((sourceId) => validSourceIds.has(sourceId)),
                  }
                : note,
            );
            const vocabulary = reconcileConceptVocabulary(
              notes,
              space.concepts,
            );
            return markSpaceOverviewStale({
              ...space,
              notes: vocabulary.notes,
              concepts: vocabulary.concepts,
              updatedAt: now,
            });
          });
          return {
            ...current,
            spaces,
            updatedAt: now,
          };
        });
        scheduleSpaceOverviewRefresh(workspace.workspace.id);
        setLinkedArticleJobs((current) =>
          current.map((job) =>
            job.id === jobId
              ? { ...job, progress: 100, stage: "complete", error: undefined }
              : job,
          ),
        );
        console.info("[linked-article] request completed", {
          requestKey,
          attemptId: jobId,
        });
        window.setTimeout(() => {
          setLinkedArticleJobs((current) =>
            current.filter((job) => job.id !== jobId),
          );
        }, 1_800);
        showToast(
          "Wiki article ready",
          `“${phrase}” was written from ${originNote.title} and its Space context.`,
          {
            label: "Open article",
            run: revealArticle,
          },
        );
      } catch (error) {
        if (!linkedArticleRequests.current.owns(requestKey, jobId)) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn("[linked-article] request paused", {
          requestKey,
          attemptId: jobId,
          reason: message,
        });
        setLinkedArticleJobs((current) =>
          current.map((job) =>
            job.id === jobId
              ? {
                  ...job,
                  progress: Math.max(job.progress, 12),
                  stage: "error",
                  error: message,
                }
              : job,
          ),
        );
        showToast("Article generation paused", message, {
          label: "Open article",
          run: revealArticle,
        });
      } finally {
        window.clearInterval(progressTimer);
        linkedArticleRequests.current.finish(requestKey, jobId);
      }
    },
    [openNote, scheduleSpaceOverviewRefresh, showToast, switchSpace],
  );

  const restartLinkedArticle = useCallback(
    (job: LinkedArticleJob) => {
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === job.workspaceId,
      );
      const article = workspace?.notes.find(
        (note) => note.id === job.noteId,
      );
      const originNote = workspace?.notes.find(
        (note) => note.id === job.originNoteId,
      );
      if (
        !workspace ||
        !article ||
        !originNote ||
        !isLinkedArticlePlaceholder(article, job.title)
      ) {
        const message =
          "This unfinished article or its source note changed, so Orion cannot safely restart it.";
        setLinkedArticleJobs((current) =>
          current.map((candidate) =>
            candidate.id === job.id
              ? { ...candidate, stage: "error", error: message }
              : candidate,
          ),
        );
        showToast("Article could not restart", message);
        return;
      }

      linkedArticleRequests.current.cancel(
        `${job.workspaceId}:${job.noteId}`,
      );
      console.info("[linked-article] restart requested", {
        requestKey: `${job.workspaceId}:${job.noteId}`,
        previousAttemptId: job.id,
      });
      void generateLinkedArticle(
        workspace,
        job.noteId,
        job.originNoteId,
        job.title,
        job.instructions,
        job.selectedContext,
      );
    },
    [generateLinkedArticle, showToast],
  );

  const deletePausedLinkedArticle = useCallback(
    (job: LinkedArticleJob) => {
      if (
        !window.confirm(
          `Delete the unfinished “${job.title}” article? The link phrase will stop auto-linking until you create it again.`,
        )
      ) {
        return;
      }

      const now = new Date().toISOString();
      const requestKey = `${job.workspaceId}:${job.noteId}`;
      const liveSpace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === job.workspaceId,
      );
      const preview = liveSpace
        ? deleteLinkedArticleDraft(liveSpace, job, now)
        : null;
      linkedArticleRequests.current.cancel(requestKey);
      console.info("[linked-article] unfinished page deleted", {
        requestKey,
        jobId: job.id,
      });
      setVault((current) => ({
        ...current,
        spaces: current.spaces.map((space) => {
          if (space.workspace.id !== job.workspaceId) return space;
          const deletion = deleteLinkedArticleDraft(space, job, now);
          return deletion.deleted
            ? markSpaceOverviewStale(deletion.snapshot)
            : deletion.snapshot;
        }),
        updatedAt: now,
      }));
      if (preview?.deleted) {
        scheduleSpaceOverviewRefresh(job.workspaceId);
      }
      setLinkedArticleJobs((current) =>
        current.filter(
          (candidate) =>
            candidate.workspaceId !== job.workspaceId ||
            candidate.noteId !== job.noteId,
        ),
      );
      if (
        preview?.deleted &&
        vaultRef.current.activeSpaceId === job.workspaceId
      ) {
        const fallbackNoteId = preview.snapshot.activeNoteId;
        replaceHistory(
          [
            fallbackNoteId && screenRef.current === "note"
              ? createNavigationEntry({
                  screen: "note",
                  noteId: fallbackNoteId,
                })
              : createNavigationEntry({
                  screen:
                    screenRef.current === "note"
                      ? "notes"
                      : screenRef.current,
                }),
          ],
          0,
        );
      }
      showToast(
        "Article deleted",
        `“${job.title}” and its unfinished automatic link were removed.`,
      );
    },
    [replaceHistory, scheduleSpaceOverviewRefresh, showToast],
  );

  const deleteNote = useCallback(
    (noteId: EntityId) => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === workspaceId,
      );
      const note = workspace?.notes.find(
        (candidate) => candidate.id === noteId,
      );
      if (!workspace || !note) {
        return;
      }
      const deletingOpenNote =
        screenRef.current === "note" && workspace.activeNoteId === noteId;
      if (
        !window.confirm(
          `Delete “${note.title}”? Its links, backlinks, and source references will be cleaned up. This cannot be undone.`,
        )
      ) {
        return;
      }

      const now = new Date().toISOString();
      for (const job of linkedArticleJobs) {
        if (
          job.workspaceId === workspaceId &&
          (job.noteId === noteId || job.originNoteId === noteId)
        ) {
          linkedArticleRequests.current.cancel(
            `${job.workspaceId}:${job.noteId}`,
          );
        }
      }
      wikiEnrichmentRequests.current.delete(`${workspaceId}:${noteId}`);
      setLinkedArticleJobs((current) =>
        current.flatMap((job) => {
          if (job.workspaceId !== workspaceId) {
            return [job];
          }
          if (job.noteId === noteId || job.stage === "complete") {
            return [];
          }
          if (job.originNoteId === noteId) {
            return [
              {
                ...job,
                stage: "error" as const,
                error:
                  "The source note was deleted. Delete this unfinished page, or create the link again from another note.",
              },
            ];
          }
          return [job];
        }),
      );
      setVault((current) => ({
        ...current,
        spaces: current.spaces.map((space) => {
          if (space.workspace.id !== workspaceId) return space;
          const deletion = deleteNoteFromSnapshot(space, noteId, now);
          return deletion.deleted
            ? markSpaceOverviewStale(deletion.snapshot)
            : deletion.snapshot;
        }),
        updatedAt: now,
      }));
      scheduleSpaceOverviewRefresh(workspaceId);
      if (deletingOpenNote) {
        setScreen("notes");
        setContextOpen(false);
        closeConnections();
        replaceHistory(
          [createNavigationEntry({ screen: "notes" })],
          0,
        );
      }
      showToast("Note deleted", `“${note.title}” was removed from this Space.`);
    },
    [
      closeConnections,
      linkedArticleJobs,
      replaceHistory,
      scheduleSpaceOverviewRefresh,
      showToast,
    ],
  );

  const deleteSource = useCallback(
    (sourceId: EntityId) => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const workspace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === workspaceId,
      );
      const source = workspace?.sources.find(
        (candidate) => candidate.id === sourceId,
      );
      if (!workspace || !source) {
        return;
      }

      const connectedNoteCount = workspace.notes.filter((note) =>
        note.sourceIds.includes(sourceId),
      ).length;
      const cleanupDescription =
        connectedNoteCount === 0
          ? "The preserved source will be permanently removed."
          : `It will be detached from ${connectedNoteCount} ${
              connectedNoteCount === 1 ? "note" : "notes"
            }, but ${connectedNoteCount === 1 ? "that note" : "those notes"} and their content will stay intact.`;
      if (
        !window.confirm(
          `Delete source “${source.title}”? ${cleanupDescription} This cannot be undone.`,
        )
      ) {
        return;
      }

      const now = new Date().toISOString();
      setSelectedSourceId((current) =>
        current === sourceId ? null : current,
      );
      setVault((current) => ({
        ...current,
        spaces: current.spaces.map((space) => {
          if (space.workspace.id !== workspaceId) return space;
          const deletion = deleteSourceFromSnapshot(space, sourceId, now);
          return deletion.deleted
            ? markSpaceOverviewStale(deletion.snapshot)
            : deletion.snapshot;
        }),
        updatedAt: now,
      }));
      scheduleSpaceOverviewRefresh(workspaceId);
      showToast(
        "Source deleted",
        connectedNoteCount === 0
          ? `“${source.title}” was removed from this Space.`
          : `“${source.title}” was removed; its ${
              connectedNoteCount === 1 ? "note was" : "notes were"
            } kept intact.`,
      );
    },
    [scheduleSpaceOverviewRefresh, showToast],
  );

  const registerLinkConcept = useCallback(
    (
      input: RegisterWikiLinkInput,
      originNoteId: EntityId,
    ): EntityId => {
      const now = new Date().toISOString();
      const phrase = input.phrase.trim().replace(/\s+/g, " ");
      const currentSnapshot = snapshotRef.current;
      const originNote = currentSnapshot.notes.find(
        (note) => note.id === originNoteId,
      );
      const shouldWriteWithAI =
        input.destinationNoteIds.length === 0 &&
        input.articleMode === "ai";
      const candidateArticle: Note = {
        id: `note-${nanoid(10)}`,
        title: phrase,
        slug: slugifyTitle(phrase) || `article-${nanoid(5)}`,
        summary: shouldWriteWithAI
          ? `Orion is writing a Space article for ${phrase}.`
          : "",
        body: shouldWriteWithAI
          ? [
              "<!-- orion-link-pending -->",
              `> Orion is writing this article from “${originNote?.title ?? "the current note"}”, its sources, and the active Space.`,
            ].join("\n\n")
          : "",
        aliases: [],
        tags: shouldWriteWithAI ? ["orion-link-pending"] : [],
        kind: "wiki",
        status: "ready",
        conceptIds: [],
        sourceIds: [...(originNote?.sourceIds ?? [])],
        createdAt: now,
        updatedAt: now,
        color: "#8798ff",
      };
      const register = (notes: readonly Note[], concepts: AppSnapshot["concepts"]) =>
        input.destinationNoteIds.length > 0
          ? registerConceptPhrase(notes, concepts, {
              phrase,
              noteIds: input.destinationNoteIds,
              description: input.description,
            })
          : ensureCanonicalConceptPhrase(notes, concepts, {
              phrase,
              candidateArticle,
              description: input.description,
            });
      const preview = register(
        currentSnapshot.notes,
        currentSnapshot.concepts,
      );
      setSnapshot((current) => {
        const result = register(current.notes, current.concepts);
        return {
          ...current,
          notes: result.notes,
          concepts: result.concepts,
          updatedAt: new Date().toISOString(),
        };
      });
      if (shouldWriteWithAI && originNote) {
        const concept = preview.concepts.find(
          (candidate) => candidate.id === preview.conceptId,
        );
        const articleId = concept?.canonicalNoteId;
        const article = articleId
          ? preview.notes.find((note) => note.id === articleId)
          : undefined;
        if (
          articleId &&
          article &&
          isLinkedArticlePlaceholder(article, phrase)
        ) {
          void generateLinkedArticle(
            {
              ...currentSnapshot,
              notes: preview.notes,
              concepts: preview.concepts,
              updatedAt: now,
            },
            articleId,
            originNoteId,
            phrase,
            input.articleInstructions,
            input.selectedContext,
          );
        }
      } else if (input.destinationNoteIds.length === 0) {
        const concept = preview.concepts.find(
          (candidate) => candidate.id === preview.conceptId,
        );
        const blankArticleId = concept?.canonicalNoteId;
        if (blankArticleId) {
          window.setTimeout(() => openNote(blankArticleId), 0);
        }
        showToast(
          "Blank article created",
          `“${phrase}” is ready for you to write.`,
        );
      }
      return preview.conceptId;
    },
    [generateLinkedArticle, openNote, showToast],
  );

  const generateLinkTitle = useCallback(
    async (
      originNoteId: EntityId,
      selectedContext: string,
    ): Promise<string> => {
      const currentSnapshot = snapshotRef.current;
      const workspaceId = currentSnapshot.workspace.id;
      const result = await chatWithOrion(
        buildLinkTitleRequest(
          currentSnapshot,
          originNoteId,
          selectedContext,
        ),
      );
      if (snapshotRef.current.workspace.id !== workspaceId) {
        throw new Error(
          "The active Space changed while Orion was naming this page. Try again in the current Space.",
        );
      }
      return normalizeGeneratedLinkTitle(result.reply);
    },
    [],
  );

  const generateAIWriting = useCallback(
    async (
      originNoteId: EntityId,
      input: Omit<AIWritingRequestInput, "originNoteId">,
    ): Promise<string> => {
      const currentSnapshot = snapshotRef.current;
      const workspaceId = currentSnapshot.workspace.id;
      const result = await chatWithOrion(
        buildAIWritingRequest(currentSnapshot, {
          ...input,
          originNoteId,
        }),
      );
      if (snapshotRef.current.workspace.id !== workspaceId) {
        throw new Error(
          "The active Space changed while Orion was writing. Try again in the current Space.",
        );
      }
      return normalizeAIWritingReply(result.reply);
    },
    [],
  );

  const generateAIImage = useCallback(
    async (
      originNoteId: EntityId,
      input: Omit<AIImageRequestInput, "originNoteId">,
      signal: AbortSignal,
    ) => {
      const currentSnapshot = snapshotRef.current;
      const workspaceId = currentSnapshot.workspace.id;
      const request = buildAIImagePrompt(currentSnapshot, {
        ...input,
        originNoteId,
      });
      const image = await generateNoteImage(request.prompt, signal);
      if (snapshotRef.current.workspace.id !== workspaceId) {
        throw new Error(
          "The active Space changed while Orion was creating the image. Try again in the current Space.",
        );
      }
      return { ...image, alt: request.alt };
    },
    [],
  );

  const updateSettings = useCallback((settings: Settings) => {
    const now = new Date().toISOString();
    setVault((current) => ({
      ...current,
      spaces: current.spaces.map((space) => ({
        ...space,
        settings: { ...settings },
        updatedAt: now,
      })),
      updatedAt: now,
    }));
  }, []);

  const disableConceptAutoLink = useCallback(
    (conceptId: EntityId) => {
      const concept = snapshotRef.current.concepts.find(
        (candidate) => candidate.id === conceptId,
      );
      if (!concept) {
        return;
      }
      const now = new Date().toISOString();
      setSnapshot((current) => ({
        ...current,
        concepts: current.concepts.map((candidate) =>
          candidate.id === conceptId
            ? { ...candidate, autoLink: false }
            : candidate,
        ),
        updatedAt: now,
      }));
      showToast(
        "Phrase unlinked",
        `“${concept.label}” will no longer link automatically. Its article was kept.`,
      );
    },
    [setSnapshot, showToast],
  );

  const sendChatMessage = useCallback(
    async (prompt: string): Promise<ChatResult> => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const space = vaultRef.current.spaces.find(
        (candidate) => candidate.workspace.id === workspaceId,
      );
      if (!space) {
        throw new Error("This Space is no longer available.");
      }
      const token = chatRequests.current.start(
        workspaceId,
        `chat-request-${nanoid(10)}`,
      );
      if (!token) {
        throw new Error("Orion is already replying in this Space.");
      }
      setChatBusySpaceIds((current) => {
        const next = new Set(current);
        next.add(workspaceId);
        return next;
      });

      try {
        const result = await chatWithOrion(buildChatRequest(space, prompt));
        if (chatRequests.current.isCurrent(token)) {
          const now = new Date().toISOString();
          const createdNotes = (result.noteActions?.length ?? 0) > 0;
          setVault((current) => ({
            ...current,
            spaces: current.spaces.map((candidate) => {
              if (candidate.workspace.id !== workspaceId) return candidate;
              const next = applyChatResult(
                candidate,
                prompt,
                result,
                now,
                () => `chat-${nanoid(10)}`,
                () => `note-${nanoid(10)}`,
              );
              return createdNotes ? markSpaceOverviewStale(next) : next;
            }),
            updatedAt: now,
          }));
          if (createdNotes) {
            scheduleSpaceOverviewRefresh(workspaceId);
          }
        }
        return result;
      } finally {
        if (chatRequests.current.finish(token)) {
          setChatBusySpaceIds((current) => {
            const next = new Set(current);
            next.delete(workspaceId);
            return next;
          });
        }
      }
    },
    [scheduleSpaceOverviewRefresh],
  );

  const saveChatMessageAsNote = useCallback(
    (messageId: string) => {
      const current = activeSpace(vaultRef.current);
      const workspaceId = current.workspace.id;
      const pendingKey = `${workspaceId}:${messageId}`;
      const message = current.studio.messages.find(
        (candidate) =>
          candidate.id === messageId && candidate.role === "assistant",
      );
      if (!message) return;
      const existing = message.createdNoteIds
        ?.map((id) => current.notes.find((note) => note.id === id))
        .find((note): note is Note => Boolean(note));
      if (existing) {
        openNote(existing.id);
        return;
      }
      if (pendingChatNoteSaveNotices.current.has(pendingKey)) return;

      const now = new Date().toISOString();
      const noteId = `note-${nanoid(10)}`;
      if (saveChatReplyAsNote(current, messageId, now, noteId) === current) {
        return;
      }
      pendingChatNoteSaveNotices.current.set(pendingKey, {
        workspaceId,
        messageId,
        noteId,
      });
      setVault((currentVault) => {
        const target = currentVault.spaces.find(
          (space) => space.workspace.id === workspaceId,
        );
        if (!target) return currentVault;
        const next = saveChatReplyAsNote(target, messageId, now, noteId);
        if (next === target) return currentVault;
        const marked = markSpaceOverviewStale(next);
        return {
          ...currentVault,
          spaces: currentVault.spaces.map((space) =>
            space.workspace.id === workspaceId ? marked : space,
          ),
          updatedAt: now,
        };
      });
    },
    [openNote],
  );

  useEffect(() => {
    for (const [key, pending] of pendingChatNoteSaveNotices.current) {
      const space = vault.spaces.find(
        (candidate) => candidate.workspace.id === pending.workspaceId,
      );
      const landed = space?.notes.some(
        (note) => note.id === pending.noteId,
      );
      if (landed) {
        pendingChatNoteSaveNotices.current.delete(key);
        scheduleSpaceOverviewRefresh(pending.workspaceId);
        showToast("Note created", "The Chat reply is now an editable note.", {
          label: "Open note",
          run: () => {
            const liveVault = vaultRef.current;
            if (liveVault.activeSpaceId === pending.workspaceId) {
              openNote(pending.noteId);
              return;
            }
            switchSpace(pending.workspaceId);
            window.setTimeout(() => openNote(pending.noteId), 0);
          },
        });
        continue;
      }
      const message = space?.studio.messages.find(
        (candidate) => candidate.id === pending.messageId,
      );
      if (!space || !message || message.createdNoteIds?.length) {
        pendingChatNoteSaveNotices.current.delete(key);
      }
    }
  }, [openNote, scheduleSpaceOverviewRefresh, showToast, switchSpace, vault]);

  const clearChat = useCallback(() => {
    chatRequests.current.invalidate(vaultRef.current.activeSpaceId);
    const now = new Date().toISOString();
    setSnapshot((current) => {
      const studio = normalizeStudio(current.studio);
      return {
        ...current,
        studio: {
          ...studio,
          messages: [],
        },
        updatedAt: now,
      };
    });
  }, []);

  const applyImport = useCallback(
    (payload: ImportStudioApplyPayload) => {
      const workspaceId = vaultRef.current.activeSpaceId;
      const liveSpace = vaultRef.current.spaces.find(
        (space) => space.workspace.id === workspaceId,
      );
      if (
        !liveSpace ||
        (payload.baseSnapshotVersion &&
          stableSnapshotVersion(liveSpace) !== payload.baseSnapshotVersion)
      ) {
        throw new Error(
          "This Space changed after Orion finished reading. Review the import again before adding it.",
        );
      }
      const firstNoteId = payload.notes[0]?.id ?? null;
      setSnapshot((current) => {
        if (
          payload.baseSnapshotVersion &&
          stableSnapshotVersion(current) !== payload.baseSnapshotVersion
        ) {
          return current;
        }
        snapshotBeforeImport.current = current;
        const conceptMap = new Map(
          current.concepts.map((concept) => [concept.id, concept]),
        );
        payload.concepts.forEach((concept) => conceptMap.set(concept.id, concept));
        const importedNoteIds = new Set(payload.notes.map((note) => note.id));
        const notes = [
          ...payload.notes,
          ...current.notes.filter((note) => !importedNoteIds.has(note.id)),
        ];
        const vocabulary = reconcileConceptVocabulary(
          notes,
          [...conceptMap.values()],
        );
        return markSpaceOverviewStale({
          ...current,
          notes: vocabulary.notes,
          sources: [...payload.sources, ...current.sources],
          concepts: vocabulary.concepts,
          relationships: [
            ...payload.relationships,
            ...current.relationships,
          ],
          activeNoteId: firstNoteId ?? current.activeNoteId,
          updatedAt: new Date().toISOString(),
        });
      });
      scheduleSpaceOverviewRefresh(workspaceId);
      if (firstNoteId) openNote(firstNoteId);
      showToast(
        "Import added",
        `${payload.notes.length} ${
          payload.notes.length === 1 ? "note" : "notes"
        } joined your atlas.`,
        {
          label: "Undo",
          run: () => {
            if (!snapshotBeforeImport.current) return;
            cancelSpaceOverviewRefresh(workspaceId);
            setSnapshot(snapshotBeforeImport.current);
            snapshotBeforeImport.current = null;
            setScreen("home");
            replaceHistory(
              [createNavigationEntry({ screen: "home" })],
              0,
            );
            setToast(null);
          },
        },
      );
    },
    [
      cancelSpaceOverviewRefresh,
      openNote,
      replaceHistory,
      scheduleSpaceOverviewRefresh,
      showToast,
    ],
  );

  const openView = useCallback(
    (view: WorkspaceView) => {
      pendingScrollRestore.current = null;
      const next = pushNavigationHistory(
        historyRef.current,
        historyIndexRef.current,
        { screen: view },
        readScrollPosition(workspaceContentRef.current),
      );
      replaceHistory(next.entries, next.index);
      setScreen(view);
      setSelectedSourceId(null);
      setContextOpen(false);
      closeConnections();
    },
    [closeConnections, replaceHistory],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        vaultLoadError ||
        closingRef.current
      ) {
        return;
      }
      if (event.key === "Escape") {
        if (commandOpen) {
          setCommandOpen(false);
        } else if (exportOpen) {
          setExportOpen(false);
        } else if (importOpen) {
          setImportOpen(false);
        } else if (selectedSourceId) {
          setSelectedSourceId(null);
        } else if (contextOpen) {
          setContextOpen(false);
        } else {
          closeConnections();
        }
        return;
      }
      if (commandOpen || exportOpen || importOpen || selectedSourceId) {
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (modifier && event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        createNote();
      }
      if (
        modifier &&
        event.shiftKey &&
        event.key.toLocaleLowerCase() === "i"
      ) {
        event.preventDefault();
        setImportOpen(true);
      }
      if (modifier && event.key === "[") {
        event.preventDefault();
        navigateHistory(-1);
      }
      if (modifier && event.key === "]") {
        event.preventDefault();
        navigateHistory(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    closeConnections,
    commandOpen,
    contextOpen,
    createNote,
    exportOpen,
    importOpen,
    navigateHistory,
    selectedSourceId,
    vaultLoadError,
  ]);

  async function handleExport(request: ExportRequest): Promise<boolean> {
    try {
      const originNoteId = screen === "note" ? activeNote?.id ?? null : null;
      if (request.format === "web") {
        const document = buildWebExportDocument(
          snapshot,
          request.scope,
          originNoteId,
        );
        const result = await exportWebPage(document.fileName, document.html);
        if (!result.cancelled) {
          showToast(
            "Web article exported",
            `${document.noteIds.length} ${document.noteIds.length === 1 ? "note" : "notes"} saved as one offline file${result.path ? ` at ${result.path}` : ""}.`,
          );
        }
        return true;
      }

      const selectedNotes = notesForExportScope(
        snapshot,
        request.scope,
        originNoteId,
      );
      const result = await exportMarkdown(
        selectedNotes.map(({ title, body, tags }) => ({ title, body, tags })),
      );
      if (!result.cancelled) {
        showToast(
          "Markdown exported",
          `${result.exportedCount} ${result.exportedCount === 1 ? "note" : "notes"} saved to ${result.directory}.`,
        );
      }
      return true;
    } catch (error) {
      showToast(
        "Export failed",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  async function handleSaveKey(apiKey: string) {
    await saveApiKey(apiKey);
    updateSettings({ ...snapshot.settings, apiKeyConfigured: true });
  }

  async function handleDeleteKey() {
    await deleteApiKey();
    updateSettings({ ...snapshot.settings, apiKeyConfigured: false });
  }

  async function handleSaveAnthropicKey(apiKey: string) {
    await saveAnthropicApiKey(apiKey);
    updateSettings({
      ...snapshot.settings,
      anthropicApiKeyConfigured: true,
    });
  }

  async function handleDeleteAnthropicKey() {
    await deleteAnthropicApiKey();
    updateSettings({
      ...snapshot.settings,
      anthropicApiKeyConfigured: false,
    });
  }

  async function handleSaveElevenLabsKey(apiKey: string) {
    await saveElevenLabsApiKey(apiKey);
    updateSettings({
      ...snapshot.settings,
      elevenLabsApiKeyConfigured: true,
      speechVoice: "elevenlabs",
    });
  }

  async function handleDeleteElevenLabsKey() {
    await deleteElevenLabsApiKey();
    updateSettings({
      ...snapshot.settings,
      elevenLabsApiKeyConfigured: false,
    });
  }

  function acquireSpeechPlaybackContext(): AudioContext {
    const existing = speechPlaybackContext.current;
    if (existing && existing.state !== "closed") {
      if (existing.state === "suspended") void existing.resume();
      return existing;
    }
    const created = openSpeechPlaybackContext();
    if (!created) {
      throw new Error("This environment cannot play spoken notes.");
    }
    speechPlaybackContext.current = created;
    return created;
  }

  function cloudSpeechKey(
    engine: "openai" | "elevenlabs",
    text: string,
  ): string {
    const voiceId =
      engine === "elevenlabs"
        ? resolveElevenLabsVoiceId(snapshot.settings)
        : "";
    return cloudSpeechCacheKey(engine, text, voiceId);
  }

  async function loadCloudSpeechChunks(
    text: string,
    signal?: AbortSignal,
  ): Promise<GeneratedSpeech[]> {
    const engine = resolveSpeechEngine(snapshot.settings);
    if (engine === "system") return [];
    if (engine === "elevenlabs" && !snapshot.settings.elevenLabsApiKeyConfigured) {
      throw new Error(
        "Add an ElevenLabs API key in Settings before listening with ElevenLabs.",
      );
    }
    if (engine === "openai" && !snapshot.settings.apiKeyConfigured) {
      throw new Error(
        "Add an OpenAI API key in Settings before listening with OpenAI.",
      );
    }
    const voiceId =
      engine === "elevenlabs"
        ? resolveElevenLabsVoiceId(snapshot.settings)
        : undefined;
    return preparedSpeech.current.set(cloudSpeechKey(engine, text), async () => {
      const parts = chunkSpeechText(text, speechChunkLimit(engine));
      const spoken: GeneratedSpeech[] = [];
      for (const chunk of parts) {
        if (signal?.aborted) {
          throw signal.reason ?? new Error("Reading was cancelled.");
        }
        spoken.push(await generateSpeech(engine, chunk, voiceId));
      }
      return spoken;
    });
  }

  async function prepareSpeech(
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const engine = resolveSpeechEngine(snapshot.settings);
    if (engine === "system") return;
    await loadCloudSpeechChunks(text, signal);
  }

  async function speakNoteText(
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: SpeechPlaybackProgress) => void,
  ): Promise<void> {
    const engine = resolveSpeechEngine(snapshot.settings);
    if (engine === "elevenlabs" && !snapshot.settings.elevenLabsApiKeyConfigured) {
      throw new Error(
        "Add an ElevenLabs API key in Settings before listening with ElevenLabs.",
      );
    }
    if (engine === "openai" && !snapshot.settings.apiKeyConfigured) {
      throw new Error(
        "Add an OpenAI API key in Settings before listening with OpenAI.",
      );
    }
    if (engine === "system") {
      await speakWithSystemVoice(text, signal, onProgress);
      return;
    }
    const alreadyQueued = preparedSpeech.current.has(
      cloudSpeechKey(engine, text),
    );
    if (!alreadyQueued) {
      onProgress?.({
        elapsedSeconds: 0,
        durationSeconds: 0,
        ratio: 0,
        loading: true,
      });
    }
    const chunks = await loadCloudSpeechChunks(text, signal);
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Reading was cancelled.");
    }
    const playback = acquireSpeechPlaybackContext();
    const textChunks = chunkSpeechText(text, speechChunkLimit(engine));
    const charTotal = Math.max(
      1,
      textChunks.reduce((sum, chunk) => sum + chunk.length, 0),
    );
    let charsCompleted = 0;
    let elapsedBefore = 0;
    for (const [index, spoken] of chunks.entries()) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Reading was cancelled.");
      }
      const chunkChars = textChunks[index]?.length ?? 1;
      let chunkDuration = 0;
      await playDecodedSpeech(
        playback,
        decodeBase64Audio(spoken.base64Data),
        signal,
        (localElapsed, localDuration) => {
          chunkDuration = localDuration;
          const safeDuration = Math.max(localDuration, 0.001);
          const charsInChunk =
            chunkChars * Math.min(1, localElapsed / safeDuration);
          const ratio = Math.min(
            1,
            (charsCompleted + charsInChunk) / charTotal,
          );
          const elapsed = elapsedBefore + localElapsed;
          onProgress?.({
            elapsedSeconds: elapsed,
            durationSeconds:
              ratio > 0.02 ? elapsed / ratio : elapsedBefore + localDuration,
            ratio,
            loading: false,
          });
        },
      );
      charsCompleted += chunkChars;
      elapsedBefore += chunkDuration;
    }
  }

  function eraseCurrentSpace() {
    if (
      !window.confirm(
        `Erase every note, source, concept, and connection in “${snapshot.workspace.name}”? Your other spaces will not be affected.`,
      )
    ) {
      return;
    }
    chatRequests.current.invalidate(snapshot.workspace.id);
    setLinkedArticleJobs((current) =>
      current.filter(
        (job) => job.workspaceId !== snapshot.workspace.id,
      ),
    );
    const empty = createEmptySnapshot(
      snapshot.workspace.name,
      new Date().toISOString(),
      snapshot.workspace.id,
    );
    empty.settings = { ...snapshot.settings };
    setSnapshot(empty);
    resetSpaceNavigation();
    showToast(
      "Space cleared",
      `${snapshot.workspace.name} is ready for a fresh start.`,
    );
  }

  function renderScreen() {
    if (screen === "note" && activeNote) {
      return (
        <NoteView
          note={activeNote}
          notes={snapshot.notes}
          concepts={snapshot.concepts}
          sources={snapshot.sources}
          onOpenNote={openNote}
          onOpenConcept={(conceptId) =>
            followConcept(conceptId, activeNote.id)
          }
          onOpenSource={setSelectedSourceId}
          onAttachSource={attachSourceToNote}
          onUpdateNote={updateNote}
          onDeleteNote={deleteNote}
          onFinishEditing={finishNoteEditing}
          onRegisterConcept={(input) =>
            registerLinkConcept(input, activeNote.id)
          }
          onGenerateLinkTitle={(selectedContext) =>
            generateLinkTitle(activeNote.id, selectedContext)
          }
          onGenerateAIWriting={(input) =>
            generateAIWriting(activeNote.id, input)
          }
          onGenerateAIImage={(input, signal) =>
            generateAIImage(activeNote.id, input, signal)
          }
          onDisableConceptAutoLink={disableConceptAutoLink}
          aiArticleWritingEnabled={isSelectedAIConfigured(snapshot.settings)}
          aiImageGenerationEnabled={snapshot.settings.apiKeyConfigured}
          aiProviderName={selectedAIProviderName(snapshot.settings)}
          onSpeakNote={speakNoteText}
          onPrepareSpeech={prepareSpeech}
        />
      );
    }
    if (screen === "notes") {
      return (
        <NotesIndex
          notes={snapshot.notes}
          onOpenNote={openNote}
          onDeleteNote={deleteNote}
        />
      );
    }
    if (screen === "sources") {
      return (
        <SourcesView
          sources={snapshot.sources}
          onOpenSource={setSelectedSourceId}
          onDeleteSource={deleteSource}
        />
      );
    }
    if (screen === "chat") {
      return (
        <ChatView
          snapshot={snapshot}
          busy={chatBusySpaceIds.has(snapshot.workspace.id)}
          onSend={sendChatMessage}
          onClear={clearChat}
          onOpenNote={openNote}
          onSaveReply={saveChatMessageAsNote}
          onOpenSettings={() => openView("settings")}
        />
      );
    }
    if (screen === "settings") {
      return (
        <SettingsView
          settings={snapshot.settings}
          themePalette={resolvedThemePalette}
          onChange={updateSettings}
          onSaveApiKey={handleSaveKey}
          onDeleteApiKey={handleDeleteKey}
          onTestApiKey={testOpenAIKey}
          onSaveAnthropicApiKey={handleSaveAnthropicKey}
          onDeleteAnthropicApiKey={handleDeleteAnthropicKey}
          onTestAnthropicApiKey={testAnthropicKey}
          onSaveElevenLabsApiKey={handleSaveElevenLabsKey}
          onDeleteElevenLabsApiKey={handleDeleteElevenLabsKey}
          onTestElevenLabsApiKey={testElevenLabsKey}
          onOpenDataLocation={() => {
            void openDataDirectory().catch((error) =>
              showToast(
                "Couldn’t open data folder",
                error instanceof Error ? error.message : String(error),
              ),
            );
          }}
          onEraseVault={eraseCurrentSpace}
        />
      );
    }
    return (
      <HomeView
        snapshot={snapshot}
        themePalette={resolvedThemePalette}
        onOpenNote={openNote}
        onOpenConcept={(conceptId) => followConcept(conceptId)}
        onNewNote={createNote}
        onImport={() => setImportOpen(true)}
        onOpenNotes={() => openView("notes")}
        onToggleTask={toggleHomeTask}
        overviewBusy={overviewBusySpaceIds.has(snapshot.workspace.id)}
        overviewError={overviewErrors.get(snapshot.workspace.id) ?? null}
        onRefreshOverview={() => {
          void refreshSpaceOverview(snapshot.workspace.id, true);
        }}
      />
    );
  }

  const shellClassName = [
    "app-shell",
    connectionConcept ? "with-context with-connection-canvas" : "",
    snapshot.settings.sidebarCollapsed ? "is-sidebar-collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={shellClassName}>
      <Sidebar
        view={screen === "note" ? "notes" : screen}
        notes={snapshot.notes}
        spaces={vault.spaces}
        activeSpaceId={vault.activeSpaceId}
        activeNoteId={screen === "note" ? snapshot.activeNoteId : null}
        linkedArticleJobs={linkedArticleJobs.filter(
          (job) => job.workspaceId === snapshot.workspace.id,
        )}
        generateEnabled={isSelectedAIConfigured(snapshot.settings)}
        generateJobs={generateJobs.filter(
          (job) => job.workspaceId === snapshot.workspace.id,
        )}
        onGenerate={startGenerate}
        onRestartGenerate={restartGenerate}
        onDeleteGenerate={deleteGenerate}
        onViewChange={openView}
        onOpenNote={openNote}
        onDeleteNote={deleteNote}
        onNewNote={createNote}
        onCreateSpace={createSpace}
        onDeleteSpace={deleteSpace}
        onSwitchSpace={switchSpace}
        onRestartLinkedArticle={restartLinkedArticle}
        onDeleteLinkedArticle={deletePausedLinkedArticle}
        collapsed={snapshot.settings.sidebarCollapsed}
        onToggleCollapsed={() =>
          updateSettings({
            ...snapshot.settings,
            sidebarCollapsed: !snapshot.settings.sidebarCollapsed,
          })
        }
      />
      <div className="workspace-shell">
        <Topbar
          workspaceName={snapshot.workspace.name}
          contextOpen={Boolean(connectionConcept) || contextOpen}
          onOpenSearch={() => setCommandOpen(true)}
          onExport={() => setExportOpen(true)}
          rightPanelLabel={
            connectionConcept
              ? "Close connections canvas"
              : contextOpen
                ? "Close note connections and sources"
                : "Open note connections and sources"
          }
          rightPanelControls={
            connectionConcept
              ? "connections-canvas-panel"
              : "note-details-panel"
          }
          onToggleContext={
            screen === "note"
              ? () => {
                  if (connectionConcept) {
                    closeConnections();
                  } else {
                    setContextOpen((value) => !value);
                  }
                }
              : undefined
          }
          onBack={historyIndex > 0 ? () => navigateHistory(-1) : undefined}
          onForward={
            historyIndex >= 0 && historyIndex < history.length - 1
              ? () => navigateHistory(1)
              : undefined
          }
        />
        <main ref={workspaceContentRef} className="workspace-content">
          {renderScreen()}
        </main>
      </div>
      {!connectionConcept && contextOpen && screen === "note" && (
        <ContextPanel
          note={activeNote}
          snapshot={snapshot}
          onOpenNote={openNote}
          onOpenSource={setSelectedSourceId}
          onClose={() => setContextOpen(false)}
        />
      )}

      {connectionConcept && (
        <ConnectionCanvas
          key={`${connectionConcept.id}:${connectionOriginNoteId ?? "none"}`}
          concept={connectionConcept}
          notes={snapshot.notes}
          references={connectionReferences}
          originNote={connectionOriginNote}
          selectedNoteId={snapshot.activeNoteId}
          onSelectNote={(noteId) => openNote(noteId, true, true)}
          onClose={closeConnections}
        />
      )}

      <CommandPalette
        open={commandOpen}
        snapshot={snapshot}
        onClose={() => setCommandOpen(false)}
        onOpenNote={openNote}
        onOpenView={openView}
        onOpenConcept={(conceptId) =>
          followConcept(
            conceptId,
            screen === "note" ? activeNote?.id ?? null : null,
          )
        }
        onNewNote={createNote}
        onImport={() => setImportOpen(true)}
      />

      <ExportDialog
        open={exportOpen}
        snapshot={snapshot}
        activeNote={screen === "note" ? activeNote : null}
        onClose={() => setExportOpen(false)}
        onExport={handleExport}
      />

      <ImportStudio
        open={importOpen}
        snapshot={snapshot}
        onClose={() => setImportOpen(false)}
        onApply={applyImport}
      />

      {selectedSource && (
        <SourceViewer
          source={selectedSource}
          notes={snapshot.notes}
          onOpenNote={(noteId) => {
            setSelectedSourceId(null);
            openNote(noteId);
          }}
          onDeleteSource={deleteSource}
          onClose={() => setSelectedSourceId(null)}
        />
      )}

      {toast && (
        <div className="toast" key={toast.id}>
          <CheckCircle2 size={18} />
          <span>
            <strong>{toast.title}</strong>
            <small>{toast.message}</small>
          </span>
          {toast.action && (
            <button
              type="button"
              className="toast-action"
              onClick={toast.action.run}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" onClick={() => setToast(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {!hydrated && (
        <div className="loading-veil">
          <img src="/orion-mark.svg" alt="" />
          <span>Opening your atlas</span>
        </div>
      )}
      {closing && (
        <div className="loading-veil closing-veil" role="status" aria-live="polite">
          <img src="/orion-mark.svg" alt="" />
          <span>Securing your atlas</span>
        </div>
      )}
      {hydrated && vaultLoadError && (
        <div
          className="loading-veil vault-error-veil"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="vault-error-title"
          onKeyDown={(event) => {
            if (event.key !== "Tab") return;
            const focusable = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                FOCUSABLE_SELECTOR,
              ),
            );
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!first || !last) {
              event.preventDefault();
              return;
            }
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="vault-error-card">
            <img src="/orion-mark.svg" alt="" />
            <span className="eyebrow neutral">Vault protected</span>
            <strong id="vault-error-title">Orion couldn’t open this atlas</strong>
            <p>{vaultLoadError}</p>
            <p>
              Automatic saving is paused so the existing vault cannot be
              overwritten. Repair or move the vault file, then retry.
            </p>
            <div>
              {isTauriRuntime() ? (
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => {
                    void openDataDirectory().catch((error) =>
                      showToast(
                        "Couldn’t open data folder",
                        error instanceof Error
                          ? error.message
                          : String(error),
                      ),
                    );
                  }}
                >
                  Open data folder
                </button>
              ) : (
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Discard the unreadable browser-preview vault? This cannot be undone.",
                      )
                    ) {
                      clearBrowserSnapshot();
                      setLoadAttempt((value) => value + 1);
                    }
                  }}
                >
                  Discard browser vault
                </button>
              )}
              <button
                className="button primary"
                type="button"
                autoFocus
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
