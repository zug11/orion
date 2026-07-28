import { CheckCircle2, X } from "lucide-react";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
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
import { HomeView } from "./components/HomeView";
import {
  ImportStudio,
  type ImportStudioApplyPayload,
} from "./components/ImportStudio";
import { NoteView } from "./components/NoteView";
import { NotesIndex } from "./components/NotesIndex";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type WorkspaceView } from "./components/Sidebar";
import { SourcesView } from "./components/SourcesView";
import { Topbar } from "./components/Topbar";
import {
  activeSpace,
  createEmptySnapshot,
  createEmptyVault,
  defaultSettings,
  slugifyTitle,
} from "./data/defaults";
import {
  ensureCanonicalConceptPhrase,
  reconcileConceptVocabulary,
  registerConceptPhrase,
  type RegisterWikiLinkInput,
} from "./lib/concepts";
import {
  apiKeyStatus,
  chatWithOrion,
  deleteApiKey,
  exportMarkdown,
  clearBrowserSnapshot,
  isTauriRuntime,
  loadSnapshot,
  openDataDirectory,
  saveApiKey,
  saveSnapshot,
  testOpenAIKey,
} from "./lib/storage";
import {
  applyChatResult,
  buildChatRequest,
  ChatRequestRegistry,
} from "./lib/chat";
import {
  getConceptReferences,
  resolveConceptDestination,
} from "./lib/wiki";
import { normalizeStudio } from "./lib/studio";
import type {
  AppSnapshot,
  ChatResult,
  EntityId,
  Note,
  OrionVault,
  Settings,
} from "./types";

type AppScreen = WorkspaceView | "note";

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
  const [importOpen, setImportOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(true);
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
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const saveTimer = useRef<number | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const closingRef = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const chatRequests = useRef(new ChatRequestRegistry());
  const snapshotBeforeImport = useRef<AppSnapshot | null>(null);
  const snapshotRef = useRef(snapshot);
  const vaultRef = useRef(vault);
  const persistenceEnabledRef = useRef(persistenceEnabled);
  snapshotRef.current = snapshot;
  vaultRef.current = vault;
  persistenceEnabledRef.current = persistenceEnabled;

  const activeNote = useMemo(
    () =>
      snapshot.notes.find((note) => note.id === snapshot.activeNoteId) ?? null,
    [snapshot.activeNoteId, snapshot.notes],
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

  const queueSnapshotSave = useCallback((nextVault: OrionVault) => {
    const queued = saveQueue.current
      .catch(() => undefined)
      .then(() => saveSnapshot(nextVault));
    saveQueue.current = queued;
    return queued;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHydrated(false);
    setPersistenceEnabled(false);
    setVaultLoadError(null);
    Promise.all([loadSnapshot(), apiKeyStatus().catch(() => ({ configured: false }))])
      .then(([saved, keyStatus]) => {
        if (cancelled) return;
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
          const vocabulary = reconcileConceptVocabulary(
            base.notes,
            base.concepts,
          );
          return {
            ...base,
            notes: vocabulary.notes,
            concepts: vocabulary.concepts,
            studio: normalizeStudio(base.studio),
            settings: {
              ...defaultSettings,
              ...base.settings,
              apiKeyConfigured: keyStatus.configured,
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
        const nextSpace = activeSpace(nextVault);
        setVault(nextVault);
        if (nextSpace.activeNoteId && saved) {
          setHistory([nextSpace.activeNoteId]);
          setHistoryIndex(0);
        }
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
  }, [loadAttempt]);

  useEffect(() => {
    if (!hydrated || !persistenceEnabled || closing) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void queueSnapshotSave(vault).catch((error) =>
        showToast(
          "Couldn’t save",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }, 420);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
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

  useEffect(() => {
    document.documentElement.dataset.theme =
      snapshot.settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : snapshot.settings.theme;
  }, [snapshot.settings.theme]);

  const closeConnections = useCallback(() => {
    setConnectionConceptId(null);
    setConnectionOriginNoteId(null);
  }, []);

  const resetSpaceNavigation = useCallback(
    (space: AppSnapshot) => {
      setScreen("home");
      setCommandOpen(false);
      setImportOpen(false);
      setContextOpen(true);
      closeConnections();
      snapshotBeforeImport.current = null;
      setHistory(space.activeNoteId ? [space.activeNoteId] : []);
      setHistoryIndex(space.activeNoteId ? 0 : -1);
    },
    [closeConnections],
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
      resetSpaceNavigation(target);
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
      resetSpaceNavigation(space);
      showToast(
        "Blank space created",
        `${normalizedName} is completely separate from your other projects.`,
      );
    },
    [resetSpaceNavigation, showToast],
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
    ) => {
      setSnapshot((current) => ({
        ...current,
        activeNoteId: noteId,
        updatedAt: new Date().toISOString(),
      }));
      setScreen("note");
      if (!preserveConnections) {
        closeConnections();
        setContextOpen(true);
      }
      if (trackHistory) {
        setHistory((currentHistory) => {
          const nextBase = currentHistory.slice(0, historyIndex + 1);
          if (nextBase[nextBase.length - 1] === noteId) return nextBase;
          const next = [...nextBase, noteId].slice(-40);
          setHistoryIndex(next.length - 1);
          return next;
        });
      }
    },
    [closeConnections, historyIndex],
  );

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
      const nextIndex = historyIndex + direction;
      const noteId = history[nextIndex];
      if (!noteId || nextIndex < 0 || nextIndex >= history.length) return;
      setHistoryIndex(nextIndex);
      openNote(noteId, false);
    },
    [history, historyIndex, openNote],
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
      status: "draft",
      conceptIds: [],
      sourceIds: [],
      createdAt: now,
      updatedAt: now,
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

  const registerLinkConcept = useCallback(
    (input: RegisterWikiLinkInput): EntityId => {
      const now = new Date().toISOString();
      const phrase = input.phrase.trim().replace(/\s+/g, " ");
      const candidateArticle: Note = {
        id: `note-${nanoid(10)}`,
        title: phrase,
        slug: slugifyTitle(phrase) || `article-${nanoid(5)}`,
        summary: `A Space article for ${phrase}.`,
        body: "",
        aliases: [],
        tags: ["wiki-article"],
        kind: "wiki",
        status: "draft",
        conceptIds: [],
        sourceIds: [],
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
        snapshotRef.current.notes,
        snapshotRef.current.concepts,
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
      return preview.conceptId;
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
          setVault((current) => ({
            ...current,
            spaces: current.spaces.map((candidate) =>
              candidate.workspace.id === workspaceId
                ? applyChatResult(
                    candidate,
                    prompt,
                    result,
                    now,
                    () => `chat-${nanoid(10)}`,
                  )
                : candidate,
            ),
            updatedAt: now,
          }));
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
    [],
  );

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
      const firstNoteId = payload.notes[0]?.id ?? null;
      setSnapshot((current) => {
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
        return {
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
        };
      });
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
            setSnapshot(snapshotBeforeImport.current);
            snapshotBeforeImport.current = null;
            setScreen("home");
            setToast(null);
          },
        },
      );
    },
    [openNote, showToast],
  );

  const openView = useCallback((view: WorkspaceView) => {
    setScreen(view);
    closeConnections();
  }, [closeConnections]);

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
        } else if (importOpen) {
          setImportOpen(false);
        } else {
          closeConnections();
        }
        return;
      }
      if (commandOpen || importOpen) {
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
    createNote,
    importOpen,
    navigateHistory,
    vaultLoadError,
  ]);

  async function handleExport() {
    try {
      const result = await exportMarkdown(
        snapshot.notes.map(({ title, body, tags }) => ({ title, body, tags })),
      );
      if (!result.cancelled) {
        showToast(
          "Atlas exported",
          `${result.exportedCount} Markdown notes saved to ${result.directory}.`,
        );
      }
    } catch (error) {
      showToast(
        "Export failed",
        error instanceof Error ? error.message : String(error),
      );
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

  function eraseCurrentSpace() {
    if (
      !window.confirm(
        `Erase every note, source, concept, and connection in “${snapshot.workspace.name}”? Your other spaces will not be affected.`,
      )
    ) {
      return;
    }
    chatRequests.current.invalidate(snapshot.workspace.id);
    const empty = createEmptySnapshot(
      snapshot.workspace.name,
      new Date().toISOString(),
      snapshot.workspace.id,
    );
    empty.settings = { ...snapshot.settings };
    setSnapshot(empty);
    resetSpaceNavigation(empty);
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
          onOpenNote={openNote}
          onOpenConcept={(conceptId) =>
            followConcept(conceptId, activeNote.id)
          }
          onUpdateNote={updateNote}
          onRegisterConcept={registerLinkConcept}
          autoLinkEnabled={snapshot.settings.autoLink}
        />
      );
    }
    if (screen === "notes") {
      return <NotesIndex notes={snapshot.notes} onOpenNote={openNote} />;
    }
    if (screen === "sources") {
      return <SourcesView sources={snapshot.sources} />;
    }
    if (screen === "chat") {
      return (
        <ChatView
          snapshot={snapshot}
          busy={chatBusySpaceIds.has(snapshot.workspace.id)}
          onSend={sendChatMessage}
          onClear={clearChat}
          onOpenSettings={() => openView("settings")}
        />
      );
    }
    if (screen === "settings") {
      return (
        <SettingsView
          settings={snapshot.settings}
          onChange={updateSettings}
          onSaveApiKey={handleSaveKey}
          onDeleteApiKey={handleDeleteKey}
          onTestApiKey={testOpenAIKey}
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
          onOpenNote={openNote}
          onOpenConcept={(conceptId) => followConcept(conceptId)}
        onNewNote={createNote}
        onImport={() => setImportOpen(true)}
        onOpenNotes={() => openView("notes")}
      />
    );
  }

  const shellClassName = connectionConcept
    ? "app-shell with-context with-connection-canvas"
    : contextOpen && screen === "note"
      ? "app-shell with-context"
      : "app-shell";

  return (
    <div className={shellClassName}>
      <Sidebar
        view={screen === "note" ? "notes" : screen}
        notes={snapshot.notes}
        spaces={vault.spaces}
        activeSpaceId={vault.activeSpaceId}
        activeNoteId={screen === "note" ? snapshot.activeNoteId : null}
        onViewChange={openView}
        onOpenNote={openNote}
        onNewNote={createNote}
        onCreateSpace={createSpace}
        onSwitchSpace={switchSpace}
      />
      <div className="workspace-shell">
        <Topbar
          workspaceName={snapshot.workspace.name}
          contextOpen={Boolean(connectionConcept) || contextOpen}
          onOpenSearch={() => setCommandOpen(true)}
          onExport={handleExport}
          rightPanelLabel={
            connectionConcept
              ? "Close connections canvas"
              : "Toggle context panel"
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
        <main className="workspace-content">{renderScreen()}</main>
      </div>
      {!connectionConcept && contextOpen && screen === "note" && (
        <ContextPanel
          note={activeNote}
          snapshot={snapshot}
          onOpenNote={openNote}
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

      <ImportStudio
        open={importOpen}
        snapshot={snapshot}
        onClose={() => setImportOpen(false)}
        onApply={applyImport}
      />

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
