// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSpace,
  createEmptySnapshot,
  createEmptyVault,
} from "../data/defaults";
import type { AppSnapshot } from "../types";
import {
  apiKeyStatus,
  anthropicApiKeyStatus,
  buildOrganizerInstructionSuffix,
  clearBrowserSnapshot,
  deleteAnthropicApiKey,
  deleteApiKey,
  exportWebPage,
  loadSnapshot,
  parseChatResult,
  recognizeDocumentText,
  saveAnthropicApiKey,
  saveApiKey,
  saveSnapshot,
} from "./storage";

const invokeTauriMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeTauriMock }));

describe("organizer instruction boundaries", () => {
  it("keeps task guidance before a full, independently bounded Space preference", () => {
    const suffix = buildOrganizerInstructionSuffix({
      taskInstructions: `batch-first ${"🪐".repeat(2_500)}`,
      organizationInstructions: `space-second ${"🧭".repeat(2_500)}`,
    });

    expect(suffix.indexOf("batch-first")).toBeLessThan(
      suffix.indexOf("space-second"),
    );
    expect(suffix).not.toContain("�");
    expect(suffix).not.toContain("🪐".repeat(2_001));
    expect(suffix).not.toContain("🧭".repeat(2_001));
  });
});

describe("browser OCR boundary", () => {
  it("explains that image recognition requires the desktop app", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "board.png", {
      type: "image/png",
    });

    await expect(recognizeDocumentText(file)).rejects.toThrow(
      /installed Orion desktop app/i,
    );
  });

  it("derives HEIC MIME and sends only the image bytes to native Vision", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      text: "A photographed plan",
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "A photographed plan" }],
      warnings: [],
    });
    const file = new File([new Uint8Array([1, 2, 3])], "board.heic");

    try {
      await expect(recognizeDocumentText(file)).resolves.toMatchObject({
        text: "A photographed plan",
        pageCount: 1,
      });
      expect(invokeTauriMock).toHaveBeenCalledWith(
        "recognize_document_text",
        {
          request: {
            fileName: "board.heic",
            mimeType: "image/heic",
            base64Data: "AQID",
          },
        },
      );
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });
});

describe("native web export boundary", () => {
  it("passes the generated file through the narrow native save command", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeTauriMock.mockResolvedValueOnce({
      path: "/tmp/atlas.html",
      cancelled: false,
    });

    try {
      await expect(
        exportWebPage("atlas.html", "<!doctype html><title>Atlas</title>"),
      ).resolves.toEqual({ path: "/tmp/atlas.html", cancelled: false });
      expect(invokeTauriMock).toHaveBeenCalledWith("export_web_page", {
        request: {
          fileName: "atlas.html",
          html: "<!doctype html><title>Atlas</title>",
        },
      });
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    }
  });

  it("refuses an empty web article before invoking native code", async () => {
    invokeTauriMock.mockClear();
    await expect(exportWebPage("empty.html", "   ")).rejects.toThrow(
      /no web article/i,
    );
    expect(invokeTauriMock).not.toHaveBeenCalled();
  });
});

describe("browser persistence fallback", () => {
  beforeEach(async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage(),
    });
    window.localStorage.clear();
    clearBrowserSnapshot();
    await deleteApiKey();
    await deleteAnthropicApiKey();
  });

  it("round-trips a vault snapshot through localStorage", async () => {
    const vault = createEmptyVault("Test constellation", TEST_NOW);

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      schemaVersion: 2,
      spaces: [{ workspace: { name: "Test constellation" } }],
    });
  });

  it("round-trips a fully populated import draft", async () => {
    const vault = createEmptyVault("Test vault", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.importDrafts.push({
      id: "draft-test",
      title: "Field notes",
      fileName: "field-notes.md",
      mimeType: "text/markdown",
      format: "markdown",
      byteSize: 128,
      extractedText: "Notes about the winter sky.",
      createdAt: "2026-07-27T10:00:00.000Z",
      status: "error",
      warnings: ["A heading could not be classified."],
      error: "Import paused.",
      generatedNoteIds: [],
    });

    await saveSnapshot(vault);

    expect((await loadSnapshot())?.spaces[0].importDrafts[0]).toMatchObject({
      id: "draft-test",
      status: "error",
      error: "Import paused.",
    });
  });

  it("round-trips import guidance and a living Space overview", async () => {
    const vault = createEmptyVault("Guided research", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.sources.push({
      id: "source-guided",
      title: "Interview",
      kind: "text",
      importedAt: TEST_NOW,
      importGuidance: "Focus on objections and explicit next actions.",
      text: "Interview transcript.",
      noteIds: [],
    });
    snapshot.spaceOverview = {
      title: "A dispute takes shape",
      body: "The Space centres on a developing disagreement.",
      relatedNoteIds: [],
      generatedAt: TEST_NOW,
      stale: true,
    };

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      spaces: [
        {
          sources: [
            {
              importGuidance:
                "Focus on objections and explicit next actions.",
            },
          ],
          spaceOverview: {
            title: "A dispute takes shape",
            stale: true,
          },
        },
      ],
    });
  });

  it("round-trips the optional last-opened navigation timestamp", async () => {
    const vault = createEmptyVault("Reading order", TEST_NOW);
    const snapshot = activeSpace(vault);
    snapshot.notes.push({
      id: "note-opened",
      title: "Opened note",
      slug: "opened-note",
      summary: "A note with navigation recency.",
      body: "Body",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
      lastOpenedAt: "2026-08-07T02:00:00.000Z",
    });

    await saveSnapshot(vault);

    expect(await loadSnapshot()).toMatchObject({
      spaces: [
        {
          notes: [
            { lastOpenedAt: "2026-08-07T02:00:00.000Z" },
          ],
        },
      ],
    });
  });

  it("tracks API key state without putting the key in the snapshot", async () => {
    expect(await apiKeyStatus()).toEqual({ configured: false });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: false });

    await saveApiKey("sk-test-secret");
    await saveAnthropicApiKey("sk-ant-test-secret");
    expect(await apiKeyStatus()).toEqual({ configured: true });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: true });
    expect(JSON.stringify(await loadSnapshot())).not.toContain("sk-test-secret");
    expect(JSON.stringify(await loadSnapshot())).not.toContain(
      "sk-ant-test-secret",
    );
    expect(JSON.stringify(window.localStorage)).not.toContain("sk-test-secret");
    expect(JSON.stringify(window.localStorage)).not.toContain(
      "sk-ant-test-secret",
    );

    await deleteApiKey();
    await deleteAnthropicApiKey();
    expect(await apiKeyStatus()).toEqual({ configured: false });
    expect(await anthropicApiKeyStatus()).toEqual({ configured: false });
  });

  it("rejects a corrupt snapshot instead of treating it as a new vault", async () => {
    window.localStorage.setItem("orion:vault:v2", "{not-json");

    await expect(loadSnapshot()).rejects.toThrow(
      "browser preview vault could not be loaded",
    );
  });

  it("migrates a valid single-space v1 snapshot without losing content", async () => {
    const legacy = createPopulatedSnapshot();
    window.localStorage.setItem("orion:vault:v1", JSON.stringify(legacy));

    const vault = await loadSnapshot();

    expect(vault).toMatchObject({
      schemaVersion: 2,
      activeSpaceId: legacy.workspace.id,
      spaces: [
        {
          workspace: { id: legacy.workspace.id },
          notes: [{ id: "note-test" }],
          concepts: [{ id: "concept-test" }],
        },
      ],
    });
  });

  it("accepts a vault saved before appearance preferences existed", async () => {
    const legacy = mutablePopulatedSnapshot();
    delete legacy.settings.themePreset;
    delete legacy.settings.themeAccent;
    delete legacy.settings.themeAccentCustom;
    delete legacy.settings.themeCanvasTone;
    delete legacy.settings.themeCanvasCustom;
    delete legacy.settings.themeSurfaceLift;
    delete legacy.settings.themeSurfaceCustom;
    delete legacy.settings.themeTextWarmth;
    delete legacy.settings.themeContrast;
    delete legacy.settings.homeAtmosphere;
    delete legacy.settings.homeAtmosphereTone;
    delete legacy.settings.homeAtmosphereMotion;
    window.localStorage.setItem("orion:vault:v1", JSON.stringify(legacy));

    await expect(loadSnapshot()).resolves.toMatchObject({
      schemaVersion: 2,
      spaces: [{ workspace: { id: "workspace-test-vault" } }],
    });
  });

  it("keeps spaces isolated through persistence", async () => {
    const vault = createEmptyVault("Main project", TEST_NOW);
    const second = createEmptySnapshot(
      "Second project",
      TEST_NOW,
      "workspace-second",
    );
    second.notes.push({
      ...createPopulatedSnapshot().notes[0],
      id: "note-second",
      conceptIds: [],
      sourceIds: [],
    });
    vault.spaces.push(second);
    vault.activeSpaceId = second.workspace.id;

    await saveSnapshot(vault);
    const loaded = await loadSnapshot();

    expect(loaded?.spaces[0].notes).toHaveLength(0);
    expect(loaded?.spaces[1].notes.map((note) => note.id)).toEqual([
      "note-second",
    ]);
    expect(loaded?.activeSpaceId).toBe("workspace-second");
  });

  it("keeps Chat isolated while round-tripping dormant legacy Studio data", async () => {
    const vault = createEmptyVault("Main project", TEST_NOW);
    const second = createEmptySnapshot(
      "Second project",
      TEST_NOW,
      "workspace-second",
    );
    second.studio.view = "dialectic";
    second.studio.zoom = 1.2;
    second.studio.selectedCardIds = ["legacy-card"];
    second.studio.cards.push({
      id: "legacy-card",
      kind: "synthesis",
      title: "Legacy synthesis",
      body: "A thought created by an older Orion build.",
      epistemicStatus: "inferred",
      origin: "orion",
      stage: "proposed",
      dialecticRole: "synthesis",
      conceptIds: [],
      noteIds: [],
      sourceIds: [],
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
    second.studio.messages.push({
      id: "studio-message",
      role: "assistant",
      content: "A reply from the older Studio.",
      cardIds: ["legacy-card"],
      contextCardIds: ["legacy-card"],
      createdAt: TEST_NOW,
    });
    vault.spaces.push(second);

    await saveSnapshot(vault);
    const loaded = await loadSnapshot();

    expect(loaded?.spaces[0].studio.messages).toEqual([]);
    expect(loaded?.spaces[1].studio).toMatchObject({
      view: "dialectic",
      zoom: 1.2,
      selectedCardIds: ["legacy-card"],
      cards: [
        {
          id: "legacy-card",
          stage: "proposed",
          dialecticRole: "synthesis",
        },
      ],
      messages: [
        {
          content: "A reply from the older Studio.",
          cardIds: ["legacy-card"],
          contextCardIds: ["legacy-card"],
        },
      ],
    });
  });

  it("accepts only a non-empty reply from Chat", () => {
    expect(parseChatResult({ reply: "A grounded answer." })).toEqual({
      reply: "A grounded answer.",
    });
    expect(() => parseChatResult({ reply: "   " })).toThrow(
      "unexpected response",
    );
    expect(() => parseChatResult({ cards: [] })).toThrow(
      "unexpected response",
    );
    expect(() =>
      parseChatResult({ reply: "Looks valid.", cards: [] }),
    ).toThrow("unexpected response");
  });

  it("rejects a v2 vault with a missing active space", async () => {
    const vault = createEmptyVault("Test vault", TEST_NOW);
    vault.activeSpaceId = "workspace-missing";
    window.localStorage.setItem("orion:vault:v2", JSON.stringify(vault));

    await expect(loadSnapshot()).rejects.toThrow(
      "browser preview vault could not be loaded",
    );
  });

  it.each([
    [
      "non-string title",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].title = 42;
      },
    ],
    [
      "invalid status",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].status = "published";
      },
    ],
    [
      "non-string nested tag",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].tags = ["valid", 42];
      },
    ],
    [
      "non-string last-opened timestamp",
      (snapshot: MutableSnapshot) => {
        snapshot.notes[0].lastOpenedAt = 42;
      },
    ],
  ])("rejects a note with a %s", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });

  it.each([
    [
      "non-boolean auto-link preference",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.autoLink = "yes";
      },
    ],
    [
      "unsupported reasoning effort",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.reasoningEffort = "extreme";
      },
    ],
    [
      "unsupported theme",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.theme = "sepia";
      },
    ],
    [
      "unsupported theme preset",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themePreset = "laser";
      },
    ],
    [
      "unsupported theme accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeAccent = "neon";
      },
    ],
    [
      "malformed custom accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeAccentCustom = "electric-blue";
      },
    ],
    [
      "unsupported canvas tone",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeCanvasTone = "black";
      },
    ],
    [
      "malformed custom canvas",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeCanvasCustom = "#123";
      },
    ],
    [
      "unsupported surface lift",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeSurfaceLift = "floating";
      },
    ],
    [
      "malformed custom surface",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeSurfaceCustom = "rgb(1, 2, 3)";
      },
    ],
    [
      "unsupported text warmth",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeTextWarmth = "hot";
      },
    ],
    [
      "unsupported theme contrast",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.themeContrast = "maximum";
      },
    ],
    [
      "unsupported home atmosphere",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphere = "galaxy";
      },
    ],
    [
      "unsupported atmosphere accent",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphereTone = "ultraviolet";
      },
    ],
    [
      "unsupported atmosphere motion",
      (snapshot: MutableSnapshot) => {
        snapshot.settings.homeAtmosphereMotion = "chaotic";
      },
    ],
  ])("rejects settings with an %s", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });

  it.each([
    [
      "workspace",
      (snapshot: MutableSnapshot) => {
        snapshot.workspace.createdAt = false;
      },
    ],
    [
      "source",
      (snapshot: MutableSnapshot) => {
        snapshot.sources[0].byteSize = -1;
      },
    ],
    [
      "concept",
      (snapshot: MutableSnapshot) => {
        snapshot.concepts[0].noteIds = ["note-test", 7];
      },
    ],
    [
      "relationship",
      (snapshot: MutableSnapshot) => {
        snapshot.relationships[0].strength = null;
      },
    ],
    [
      "import draft",
      (snapshot: MutableSnapshot) => {
        snapshot.importDrafts.push({
          id: "draft-test",
          title: "Draft",
          fileName: "draft.md",
          mimeType: "text/markdown",
          format: "markdown",
          byteSize: 12,
          extractedText: "Draft text",
          createdAt: "2026-07-27T10:00:00.000Z",
          status: "ready",
          warnings: [false],
          generatedNoteIds: [],
        });
      },
    ],
    [
      "active note reference",
      (snapshot: MutableSnapshot) => {
        snapshot.activeNoteId = 99;
      },
    ],
    [
      "Space overview",
      (snapshot: MutableSnapshot) => {
        snapshot.spaceOverview = {
          title: "Overview",
          body: "Body",
          relatedNoteIds: [42],
          generatedAt: TEST_NOW,
          stale: false,
        };
      },
    ],
    [
      "Space overview timestamp",
      (snapshot: MutableSnapshot) => {
        snapshot.spaceOverview = {
          title: "Overview",
          body: "Body",
          relatedNoteIds: [],
          generatedAt: "2026-02-30T12:00:00.000Z",
          stale: false,
        };
      },
    ],
  ])("rejects a malformed %s entity", async (_name, corrupt) => {
    const snapshot = mutablePopulatedSnapshot();
    corrupt(snapshot);

    await expectInvalidBrowserVault(snapshot);
  });
});

interface MutableSnapshot {
  workspace: Record<string, unknown>;
  notes: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  concepts: Array<Record<string, unknown>>;
  relationships: Array<Record<string, unknown>>;
  importDrafts: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  spaceOverview?: Record<string, unknown>;
  activeNoteId: unknown;
}

const TEST_NOW = "2026-07-27T10:00:00.000Z";

function mutablePopulatedSnapshot(): MutableSnapshot {
  return createPopulatedSnapshot() as unknown as MutableSnapshot;
}

function createPopulatedSnapshot(): AppSnapshot {
  const snapshot = createEmptySnapshot("Test vault", TEST_NOW);
  snapshot.notes.push({
    id: "note-test",
    title: "Test note",
    slug: "test-note",
    summary: "A validation fixture.",
    body: "Fixture body.",
    aliases: [],
    tags: ["test"],
    kind: "article",
    status: "ready",
    conceptIds: ["concept-test"],
    sourceIds: ["source-test"],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  });
  snapshot.sources.push({
    id: "source-test",
    title: "Test source",
    kind: "text",
    importedAt: TEST_NOW,
    fileName: "test.txt",
    mimeType: "text/plain",
    byteSize: 12,
    text: "Fixture text",
    noteIds: ["note-test"],
  });
  snapshot.concepts.push({
    id: "concept-test",
    label: "Test concept",
    aliases: [],
    description: "A validation concept.",
    noteIds: ["note-test"],
    color: "#8ea6ff",
    autoLink: true,
  });
  snapshot.relationships.push({
    id: "relationship-test",
    fromNoteId: "note-test",
    toNoteId: "note-test",
    kind: "related",
    label: "relates to",
    strength: 0.5,
  });
  return snapshot;
}

async function expectInvalidBrowserVault(
  snapshot: MutableSnapshot,
): Promise<void> {
  window.localStorage.setItem("orion:vault:v1", JSON.stringify(snapshot));
  await expect(loadSnapshot()).rejects.toThrow(
    "browser preview vault could not be loaded",
  );
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
