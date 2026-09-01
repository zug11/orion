// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import * as importBatching from "../lib/importBatching";
import * as providerHealth from "../lib/providerHealth";
import { fixedPipelineResponse } from "../lib/knowledgeOrchestration/testFixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import {
  fetchWebPage,
  organizeWithAI,
  preflightKnowledgeProvider,
  recognizeDocumentText,
  runKnowledgeAssignment,
} from "../lib/storage";
import type {
  AppSnapshot,
  OrganizeContentResult,
  ParsedImport,
} from "../types";
import {
  ImportStudio,
  knowledgeImportFailureMessage,
  orchestrationEyebrow,
  orchestrationReassurance,
  progressFromKnowledgeTelemetry,
  type ImportStudioApplyPayload,
} from "./ImportStudio";
import type { KnowledgeTelemetry } from "../lib/knowledgeOrchestration/protocol";
import {
  KnowledgeDeadlineExceededError,
  KnowledgeProviderTimeoutError,
} from "../lib/knowledgeOrchestration/service";

vi.mock("../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage")>();
  const runKnowledgeAssignment = vi.fn();
  return {
    ...actual,
    fetchWebPage: vi.fn(),
    organizeWithAI: vi.fn(),
    preflightKnowledgeProvider: vi.fn().mockResolvedValue({ ok: true, latencyMs: 0 }),
    recognizeDocumentText: vi.fn(),
    runKnowledgeAssignment,
    // Import Studio wraps the assignment driver in the opt-in provider
    // failover; with failover off by default the wrapper only delegates, so
    // the harness keeps asserting against the same mocked driver seam.
    createFailoverKnowledgeDriver: () => runKnowledgeAssignment,
  };
});

const pdfUiState = vi.hoisted(() => ({ pages: [] as string[] }));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "test-pdf-worker" },
  getDocument: () => ({
    promise: Promise.resolve({
      get numPages() {
        return pdfUiState.pages.length;
      },
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({
          items: pdfUiState.pages[pageNumber - 1]
            ? [{ str: pdfUiState.pages[pageNumber - 1], hasEOL: true }]
            : [],
        }),
      }),
    }),
    destroy: vi.fn(),
  }),
}));

const snapshot = createEmptySnapshot(
  "Import test Space",
  "2026-08-07T00:00:00.000Z",
);

function Harness({
  onApply = () => undefined,
  testSnapshot = snapshot,
}: {
  onApply?: (
    payload: ImportStudioApplyPayload,
  ) => void | Promise<void>;
  testSnapshot?: AppSnapshot;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open import
      </button>
      <ImportStudio
        open={open}
        snapshot={testSnapshot}
        onClose={() => setOpen(false)}
        onApply={onApply}
      />
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parsedPage(title: string, url: string): ParsedImport {
  return {
    title,
    fileName: `${title.toLocaleLowerCase().replace(/\s+/g, "-")}.html`,
    mimeType: "text/html",
    format: "html",
    byteSize: 24,
    text: `${title} readable body`,
    warnings: [],
    sourceUrl: url,
  };
}

function organizedResult(title: string): OrganizeContentResult {
  return {
    notes: [
      {
        title,
        summary: `A reading note about ${title}.`,
        body: `# ${title}\n\nA durable reading note.`,
        tags: ["reading"],
        aliases: [],
        links: [],
      },
    ],
    wikiArticles: [],
    concepts: [],
    suggestedConnections: [],
  };
}

function longPageText(pageCount = 206, charactersPerPage = 1_900): string {
  return Array.from(
    { length: pageCount },
    (_, index) =>
      `## Page ${index + 1}\n\n${`Argument on page ${index + 1}. `.repeat(charactersPerPage).slice(0, charactersPerPage)}`,
  ).join("\n\n");
}

describe("Import unified intake", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  beforeEach(() => {
    pdfUiState.pages = [];
    vi.mocked(fetchWebPage).mockReset();
    vi.mocked(organizeWithAI).mockReset();
    vi.mocked(recognizeDocumentText).mockReset();
    vi.mocked(runKnowledgeAssignment).mockReset();
    vi.mocked(preflightKnowledgeProvider).mockResolvedValue({ ok: true, latencyMs: 0 });
    delete (window as Window & { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  });

  it("translates the long-import pipeline into calm, concrete progress", () => {
    const telemetry: KnowledgeTelemetry = {
      runId: "run-progress",
      logicalWidth: 4,
      physicalWidth: 3,
      writeWidth: 0,
      completedAssignments: 0,
      failedAssignments: 0,
      activeAssignments: 3,
      waitingAssignments: 1,
      currentPrimitives: [],
      status: "running",
      pipelineStage: "reading-plan",
      readingCompleted: 0,
      readingTotal: 6,
      writingCompleted: 0,
      writingTotal: 3,
    };
    const expected = [
      {
        stage: "reading-plan" as const,
        eyebrow: "Preparing the reading",
        operation: "Orion is mapping what to look for",
        detail: "Using this Space to guide the reading",
      },
      {
        stage: "reading" as const,
        eyebrow: "Reading in parallel",
        operation: "Orion is reading every part",
        detail: "0 of 6 readings ready",
      },
      {
        stage: "writing-plan" as const,
        eyebrow: "Planning the notes",
        operation: "Orion is deciding what belongs together",
        detail: "0 readings ready · planning what is relevant and new",
      },
      {
        stage: "writing" as const,
        eyebrow: "Writing in parallel",
        operation: "Orion is preparing 3 connected notes",
        detail: "0 of 3 ready",
      },
      {
        stage: "assembling" as const,
        eyebrow: "Final checks",
        operation: "Orion is connecting and checking the notes",
        detail: "Checking sources, links, and repeated material",
      },
    ];

    for (const item of expected) {
      const progress = progressFromKnowledgeTelemetry(
        { ...telemetry, pipelineStage: item.stage },
        1,
        "Hegel",
      );
      expect(orchestrationEyebrow(progress.orchestrationStage)).toBe(
        item.eyebrow,
      );
      expect(progress.operationLabel).toBe(item.operation);
      expect(progress.detailLabel).toBe(item.detail);
      expect(orchestrationReassurance(progress.orchestrationStage)).not.toMatch(
        /worker|blueprint|fan.?out/i,
      );
    }
  });

  it("keeps Space readings in the visible total until all reading is complete", () => {
    const telemetry: KnowledgeTelemetry = {
      runId: "run-space-reading-progress",
      logicalWidth: 16,
      physicalWidth: 4,
      writeWidth: 0,
      completedAssignments: 14,
      failedAssignments: 0,
      activeAssignments: 2,
      waitingAssignments: 0,
      currentPrimitives: [],
      status: "running",
      pipelineStage: "reading",
      sourceSummaryCompleted: 12,
      sourceSummaryTotal: 12,
      spaceSummaryCompleted: 2,
      spaceSummaryTotal: 4,
      readingCompleted: 12,
      readingTotal: 12,
      writingCompleted: 0,
      writingTotal: 3,
    };

    expect(
      progressFromKnowledgeTelemetry(telemetry, 1, "Hegel").detailLabel,
    ).toBe("14 of 16 readings ready");
    expect(
      progressFromKnowledgeTelemetry(
        {
          ...telemetry,
          completedAssignments: 16,
          activeAssignments: 0,
          spaceSummaryCompleted: 4,
        },
        1,
        "Hegel",
      ).detailLabel,
    ).toBe("16 of 16 readings ready");
  });

  it("uses calm stage-aware copy for hidden import diagnostics", () => {
    const diagnostic = new Error(
      "Invalid schema in writing blueprint artifact:42 for writer slot writer-2; parser rejected payload.",
    );
    const expected = new Map([
      ["reading-plan", "Orion could not finish preparing the reading."],
      ["reading", "Orion could not finish reading every part of this import."],
      [
        "writing-plan",
        "Orion finished the reading but could not complete the note plan.",
      ],
      [
        "writing",
        "Orion finished the reading but could not complete every planned note.",
      ],
      [
        "assembling",
        "Orion prepared the notes but could not finish the final checks.",
      ],
      ["direct", "Orion could not finish shaping these notes."],
    ] as const);

    for (const [stage, copy] of expected) {
      const message = knowledgeImportFailureMessage(diagnostic, stage);
      expect(message).toBe(copy);
      expect(message).not.toMatch(
        /assignment|artifact|blueprint|parser|payload|schema|writer slot/i,
      );
    }
  });

  it("uses one file affordance and a focused paste sheet", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Import" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose files, images, or media" }),
    );
    expect(
      screen.getByRole("heading", { name: "Choose a source" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Documents & images/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Audio or video/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close file choices" }));

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Field memo" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A durable observation for this Space." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(screen.getByText("Field memo")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    expect(
      screen.queryByRole("heading", { name: "Import" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    expect(screen.getByText("Field memo")).toBeVisible();
  });

  it("imports ready material while another source prepares, retaining the pending source after apply", async () => {
    const slow = deferred<ParsedImport>();
    vi.mocked(fetchWebPage).mockReturnValueOnce(slow.promise);
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);
    fireEvent.change(screen.getByLabelText("Webpage or YouTube URL"), { target: { value: "https://example.org/slow" } });
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Ready memo" } });
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "This short note is ready without waiting for media." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(screen.getByRole("button", { name: "Review sources" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Create notes" }));
    await screen.findByRole("button", { name: "Add to Orion" });
    // A late extraction stays outside the frozen selection and is kept queued.
    await act(async () => { slow.resolve(parsedPage("Later source", "https://example.org/slow")); await slow.promise; });
    fireEvent.click(screen.getByRole("button", { name: "Add to Orion" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0][0].sources).toHaveLength(1);
    expect(onApply.mock.calls[0][0].sources[0].title).toBe("Ready memo");
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    expect(screen.getByText("Later source")).toBeVisible();
    expect(screen.queryByText("Ready memo")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    expect(screen.getByRole("checkbox", { name: "Exclude later-source.html" })).toHaveAttribute("aria-checked", "true");
  });

  it("does not let a cancelled old import change a new Space's intake stage", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const first = createEmptySnapshot("First", "2026-08-31T00:00:00Z");
    first.settings.apiKeyConfigured = true;
    const probe = deferred<Awaited<ReturnType<typeof preflightKnowledgeProvider>>>();
    vi.mocked(preflightKnowledgeProvider).mockReturnValueOnce(probe.promise);
    const view = render(<Harness testSnapshot={first} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "A source in the first Space." } });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));
    await waitFor(() => expect(preflightKnowledgeProvider).toHaveBeenCalledOnce());
    view.rerender(<Harness testSnapshot={createEmptySnapshot("Second")} />);
    await act(async () => { probe.resolve({ ok: true, latencyMs: 10 }); await probe.promise; });
    expect(screen.getByRole("button", { name: "Review sources" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Review what Orion will import" })).not.toBeInTheDocument();
    expect(runKnowledgeAssignment).not.toHaveBeenCalled();
  });

  it("queues multiple webpage fetches, preserves progress while closed, and ignores a late deleted result", async () => {
    const first = deferred<ParsedImport>();
    const second = deferred<ParsedImport>();
    vi.mocked(fetchWebPage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<Harness />);

    const input = screen.getByLabelText("Webpage or YouTube URL");
    fireEvent.change(input, {
      target: { value: "https://example.org/research" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(screen.getByText("Fetching readable webpage text…")).toBeVisible();

    fireEvent.change(input, {
      target: { value: "https://iana.org/domains" },
    });
    expect(screen.getByRole("button", { name: "Add URL" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add URL" }));
    expect(screen.getByText("2 sources")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Close import" }));
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    expect(screen.getByText("2 sources")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Remove example.org" }));
    await act(async () => {
      first.resolve(parsedPage("Removed page", "https://example.org/research"));
      await first.promise;
    });
    expect(screen.queryByText("Removed page")).not.toBeInTheDocument();

    await act(async () => {
      second.resolve(parsedPage("IANA domains", "https://iana.org/domains"));
      await second.promise;
    });
    await waitFor(() => expect(screen.getByText("IANA domains")).toBeVisible());
    expect(screen.getByText("1 source")).toBeVisible();
  });

  it("recognizes image text locally and ignores completion after removal", async () => {
    const first = deferred<Awaited<ReturnType<typeof recognizeDocumentText>>>();
    vi.mocked(recognizeDocumentText).mockReturnValueOnce(first.promise);
    const { container } = render(<Harness />);
    const input = container.querySelector<HTMLInputElement>(
      `input[type="file"][accept*=".png"]`,
    );
    expect(input).not.toBeNull();
    const image = new File([new Uint8Array([1, 2, 3])], "planning-board.png", {
      type: "image/png",
    });

    fireEvent.change(input!, { target: { files: [image] } });

    expect(screen.getByText("Recognizing text locally…")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove planning-board.png" }),
    );
    await act(async () => {
      first.resolve({
        text: "A whiteboard plan that finished too late",
        pageCount: 1,
        pages: [
          {
            pageNumber: 1,
            text: "A whiteboard plan that finished too late",
          },
        ],
        warnings: [],
      });
      await first.promise;
    });

    expect(screen.queryByText("Planning Board")).not.toBeInTheDocument();
    expect(screen.queryByText("Import queue")).not.toBeInTheDocument();
  });

  it("forwards the PDF parser's exact selective page list to native Vision", async () => {
    pdfUiState.pages = [
      `A damaged philosophical page ${"�".repeat(8)} still contains enough words to preserve its argument.`,
    ];
    const recognition = deferred<Awaited<ReturnType<typeof recognizeDocumentText>>>();
    vi.mocked(recognizeDocumentText).mockReturnValueOnce(recognition.promise);
    const result = {
      text: "A repaired philosophical page still contains enough words to preserve its argument.",
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          text: "A repaired philosophical page still contains enough words to preserve its argument.",
        },
      ],
      warnings: [],
    };
    const { container } = render(<Harness />);
    const input = container.querySelector<HTMLInputElement>(
      `input[type="file"][accept*=".pdf"]`,
    );
    const pdf = new File([new TextEncoder().encode("%PDF-fixture")], "book.pdf", {
      type: "application/pdf",
    });

    fireEvent.change(input!, { target: { files: [pdf] } });

    await waitFor(() => {
      expect(recognizeDocumentText).toHaveBeenCalledWith(pdf, {
        pageNumbers: [1],
      });
    });
    expect(screen.getByText("Repairing 1 PDF page locally…")).toBeVisible();
    await act(async () => {
      recognition.resolve(result);
      await recognition.promise;
    });
    expect(await screen.findByText("Book")).toBeVisible();
  });

  it("clears the completed batch only after it is successfully applied", async () => {
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A short source ready to become a note." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Create notes" }));

    expect(
      await screen.findByRole("heading", { name: "1 note prepared" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add to Orion" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Open import" }));

    expect(screen.queryByText("Import queue")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review sources" })).toBeDisabled();
  });

  it("reads long documents with six parallel section workers before synthesis", async () => {
    const firstWave = deferred<OrganizeContentResult>();
    let sectionCalls = 0;
    vi.mocked(organizeWithAI).mockImplementation((request) => {
      if (request.taskInstructions?.includes("Final editorial synthesis")) {
        return Promise.resolve(organizedResult("Hegel's three studies"));
      }
      sectionCalls += 1;
      if (sectionCalls <= 6) return firstWave.promise;
      return Promise.resolve(organizedResult(`Reading ${sectionCalls}`));
    });
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Hegel" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: longPageText() },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    await waitFor(() => expect(organizeWithAI).toHaveBeenCalledTimes(6));
    expect(screen.getByText("Reading in parallel")).toBeVisible();
    expect(screen.getByText("Hegel")).toBeVisible();
    expect(screen.getByText("1 of 1")).toBeVisible();
    expect(screen.getByText("Reading 9 sections")).toBeVisible();
    expect(screen.getByText("Section 1 of 9")).toBeVisible();

    await act(async () => {
      firstWave.resolve(organizedResult("Opening reading"));
      await firstWave.promise;
    });

    expect(
      await screen.findByRole("heading", { name: "1 note prepared" }),
    ).toBeVisible();
    expect(organizeWithAI).toHaveBeenCalledTimes(10);
    const synthesisRequest = vi.mocked(organizeWithAI).mock.calls[9]?.[0];
    expect(synthesisRequest?.content).toContain("# Reading map for Hegel");
    expect(synthesisRequest?.taskInstructions).toContain(
      "Final editorial synthesis",
    );
  });

  it("uses page-aware parallel readings for a modest five-page installed import", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    const readingGate = deferred<void>();
    const readingRangeIds: string[] = [];
    let plannedReadingCount = 0;
    let activeReadingCount = 0;
    let maximumConcurrentReadings = 0;
    let failWriterOnce = true;
    vi.mocked(runKnowledgeAssignment).mockImplementation(async (request) => {
      if (request.assignment.output.kind === "reading-blueprint") {
        plannedReadingCount = request.assignment.output.sourceRanges.length;
        return {
          response: {
            kind: "complete",
            payload: {
              spaceExplanation: "A Space-aware frame for the imported source.",
              spaceFocusConcepts: [],
              spaceQuestions: ["What does the source establish?"],
              readers: request.assignment.output.sourceRanges.map(
                ({ sourceId, rangeId }, index) => ({
                  readerId: `reader-${index + 1}`,
                  sourceId,
                  rangeId,
                  focusQuestions: ["What matters in this complete range?"],
                  focusConcepts: [],
                  comparisons: [],
                  mustPreserve: [`Source range ${sourceId}/${rangeId}`],
                }),
              ),
              warnings: [],
            },
          },
        };
      }
      if (request.assignment.output.kind === "source-reading") {
        const { sourceId, rangeId } = request.assignment.output;
        readingRangeIds.push(rangeId);
        activeReadingCount += 1;
        maximumConcurrentReadings = Math.max(
          maximumConcurrentReadings,
          activeReadingCount,
        );
        await readingGate.promise.finally(() => {
          activeReadingCount -= 1;
        });
        return {
          response: {
            kind: "complete",
            payload: {
              sourceId,
              rangeId,
              summary: `Summary for ${rangeId}`,
              coverage: { complete: true, limitations: [] },
              sourceAssessment: {
                importance: "high",
                rationale: "This section advances the source argument.",
              },
              spaceAssessment: {
                relevance: "medium",
                novelty: "medium",
                focusConcepts: ["argument"],
                deprioritizedConcepts: [],
                reviewedNoteIds: [],
                rationale: "This section advances the source argument.",
              },
              sourceClaims: [
                {
                  claimId: "claim-1",
                  text: `A grounded claim from ${rangeId}.`,
                  support: [{ sourceId, rangeId }],
                },
              ],
              synthesisSeeds: [
                {
                  seedId: "seed-1",
                  proposedTitle: "The structure of the argument",
                  thesis: `The claim from ${rangeId} contributes to one shared argument.`,
                  claimIds: ["claim-1"],
                  importance: "high",
                  contribution: "new",
                  relatedNoteIds: [],
                  rationale: "Each page range develops the same durable idea.",
                },
              ],
              spaceInterpretations: [],
              mustPreserve: request.assignment.constraints.mustPreserve,
            },
          },
        };
      }
      if (request.assignment.output.kind === "writing-blueprint") {
        const readings = request.context.pipelineMaterials
          ?.filter(({ kind }) => kind === "source-reading")
          .map(({ payload }) => payload as {
            artifactId: string;
            reading: {
              sourceId: string;
              sourceClaims: Array<{ claimId: string }>;
              synthesisSeeds: Array<{ seedId: string }>;
              mustPreserve: string[];
            };
          }) ?? [];
        const sourceIds = [readings[0].reading.sourceId];
        return {
          response: {
            kind: "complete",
            payload: {
              spaceThesis: "The source ranges form one note.",
              outputs: [
                {
                  outputId: "output-1",
                  operation: "create",
                  kind: "note",
                  title: "Five-page reading",
                  editorialBrief: "Synthesize the selected claims.",
                  sourceIds,
                  claimSelections: readings.map(({ artifactId, reading }) => ({
                    artifactId,
                    claimIds: [reading.sourceClaims[0].claimId],
                  })),
                  lensSelections: [],
                  mustPreserve: [
                    ...new Set(
                      readings.flatMap(({ reading }) => reading.mustPreserve),
                    ),
                  ],
                  estimatedTokens: 700,
                  writerSlotId: "writer-1",
                  existingDestination: null,
                },
              ],
              seedDispositions: readings.map(
                ({ artifactId, reading }, index) => ({
                  artifactId,
                  seedId: reading.synthesisSeeds[0].seedId,
                  disposition: index === 0 ? "output" : "merged",
                  outputId: "output-1",
                  rationale:
                    index === 0
                      ? "This seed defines the shared argument."
                      : "This range extends the same shared argument.",
                }),
              ),
              writerSlots: [
                {
                  writerSlotId: "writer-1",
                  objective: "Write the note.",
                  outputIds: ["output-1"],
                },
              ],
              concepts: [],
              suggestedConnections: [],
              warnings: [],
            },
          },
        };
      }
      if (request.assignment.output.kind === "writer-result") {
        if (failWriterOnce) {
          failWriterOnce = false;
          throw new KnowledgeProviderTimeoutError(
            "OpenAI did not respond while writing this note.",
          );
        }
        const planned = request.context.pipelineMaterials?.find(
          ({ kind }) => kind === "writing-blueprint",
        )?.payload as {
          assignedOutputs: Array<{
            outputId: string;
            operation: "create";
            kind: "note";
            title: string;
            sourceIds: string[];
            claimSelections: Array<{ artifactId: string; claimIds: string[] }>;
            lensSelections: [];
            mustPreserve: string[];
            existingDestination: null;
          }>;
        };
        return {
          response: {
            kind: "complete",
            payload: {
              writerSlotId: request.assignment.output.writerSlotId,
              drafts: planned.assignedOutputs.map((output) => ({
                outputId: output.outputId,
                operation: output.operation,
                kind: output.kind,
                title: output.title,
                summary: "A complete five-page reading.",
                body: "# Five-page reading\n\nA complete five-page reading.",
                tags: [],
                aliases: [],
                links: [],
                overview: "",
                spaceRelevance: "",
                sourceGroundedDetails: [],
                uncertainties: [],
                sourceIds: output.sourceIds,
                claimSelections: output.claimSelections,
                lensSelections: output.lensSelections,
                mustPreserve: output.mustPreserve,
                existingDestination: output.existingDestination,
              })),
              warnings: [],
            },
          },
        };
      }
      return {
        response: {
          kind: "complete",
          payload: {
            ...organizedResult("Unexpected"),
            provenance: [
              {
                kind: "note",
                title: "Unexpected",
                sourceIds: [],
                evidenceReferences: [],
              },
            ],
            ownerProposals: [],
            warnings: [],
          },
        },
      };
    });
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Five pages" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: longPageText(5, 500) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    await waitFor(() => {
      expect(plannedReadingCount).toBeGreaterThan(1);
      expect(readingRangeIds).toHaveLength(plannedReadingCount);
    });
    expect(await screen.findByText("Reading in parallel")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Orion is reading every part" }),
    ).toBeVisible();
    expect(
      screen.getByText(`0 of ${plannedReadingCount} readings ready`),
    ).toBeVisible();
    expect(
      screen.getByText("Every planned part is read before note writing begins."),
    ).toBeVisible();
    expect(new Set(readingRangeIds).size).toBe(plannedReadingCount);
    expect(maximumConcurrentReadings).toBe(plannedReadingCount);

    await act(async () => {
      readingGate.resolve();
      await readingGate.promise;
    });
    // A writer timeout is auto-resumable: Orion recovers from the saved
    // checkpoint on its own instead of pausing for a manual resume. The
    // doubled writer-result call count asserted below is the durable proof of
    // the silent recovery; the transient recovery label is timing-dependent.
    expect(
      await screen.findByRole("heading", { name: "1 note prepared" }, {
        timeout: 6_000,
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", {
        name: "Orion paused while writing the notes.",
      }),
    ).not.toBeInTheDocument();
    const assignmentKinds = vi
      .mocked(runKnowledgeAssignment)
      .mock.calls.map(([request]) => request.assignment.output.kind);
    expect(
      assignmentKinds.filter((kind) => kind === "reading-blueprint"),
    ).toHaveLength(1);
    expect(
      assignmentKinds.filter((kind) => kind === "source-reading"),
    ).toHaveLength(plannedReadingCount);
    expect(
      assignmentKinds.filter((kind) => kind === "writing-blueprint"),
    ).toHaveLength(1);
    expect(
      assignmentKinds.filter((kind) => kind === "writer-result"),
    ).toHaveLength(2);
  });

  it("shows the fast direct-reading path without forecasting a total", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    const gate = deferred<void>();
    vi.mocked(runKnowledgeAssignment).mockImplementation(async (request) => {
      await gate.promise;
      const sourceId = request.context.runManifest?.sources[0].sourceId ?? "missing";
      return {
        response: {
          kind: "complete",
          payload: {
            result: organizedResult("Observed reading"),
            provenance: [
              {
                kind: "note",
                title: "Observed reading",
                sourceIds: [sourceId],
                evidenceReferences: [{ kind: "source", sourceId }],
              },
            ],
            ownerProposals: [],
            warnings: [],
          },
        },
      };
    });
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} />);
    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A compact but conceptually dense source." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    await waitFor(() => expect(runKnowledgeAssignment).toHaveBeenCalledOnce());
    expect(screen.getByText("Organizing")).toBeVisible();
    expect(await screen.findByText("Reading the source in one pass")).toBeVisible();
    const progress = screen.getByRole("progressbar");
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    expect(
      await screen.findByRole("heading", {
        name: "1 note prepared",
      }),
    ).toBeVisible();
    expect(organizeWithAI).not.toHaveBeenCalled();
  });

  it("returns to review cleanly when an installed import is cancelled", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    vi.mocked(runKnowledgeAssignment).mockImplementation(
      async (_request, signal) =>
        await new Promise((_, reject) => {
          const rejectFromAbort = () => reject(signal.reason);
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener("abort", rejectFromAbort, { once: true });
        }),
    );
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A source whose reading the user cancels." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    await waitFor(() => expect(runKnowledgeAssignment).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("heading", {
        name: "Review what Orion will import",
      }),
    ).toBeVisible();
    expect(screen.queryByText("Import notes")).not.toBeInTheDocument();
  });

  it("preserves source previews and exposes an exhausted deadline", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runKnowledgeAssignment).mockRejectedValue(
      new KnowledgeDeadlineExceededError(),
    );
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "A complete source that reaches the import limit." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    // The time limit is a deliberate stop, so there is no silent retry — but
    // the source still lands, with the actual stop reason and an explicit retry.
    expect(
      await screen.findByRole("heading", { name: "Orion reached the import time limit." }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Retry import" }),
    ).toBeVisible();
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orion import]"),
      expect.objectContaining({
        message: expect.stringMatching(/knowledge-import limit/i),
      }),
    );
    warningSpy.mockRestore();
  });

  it("lands the source as a first-class note without a second AI workflow", async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
      {};
    const diagnostic = new Error(
      "Invalid schema in writing blueprint artifact:42 for writer slot writer-2; parser rejected payload.",
    );
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runKnowledgeAssignment).mockRejectedValue(
      diagnostic,
    );
    const onApply = vi.fn();
    const aiSnapshot: AppSnapshot = {
      ...snapshot,
      settings: { ...snapshot.settings, apiKeyConfigured: true },
    };
    render(<Harness testSnapshot={aiSnapshot} onApply={onApply} />);

    fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
    fireEvent.change(screen.getByLabelText(/Title/), {
      target: { value: "Safe source" },
    });
    fireEvent.change(screen.getByLabelText("Text"), {
      target: { value: "Every paragraph must survive the provider failure." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));

    // A persistent provider failure lands the source as a real note built
    // locally from preserved text, without concealing the provider failure.
    expect(
      await screen.findByRole("heading", { name: "Orion could not finish this import." }, {
        timeout: 6_000,
      }),
    ).toBeVisible();
    expect(
      screen.getByText(diagnostic.message),
    ).toBeVisible();
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining("[Orion import]"),
      diagnostic,
    );
    expect(organizeWithAI).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep preview" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0]?.[0].notes[0]?.body).toContain(
      "Every paragraph must survive the provider failure.",
    );
    warningSpy.mockRestore();
  });

  it.each(["assignment", "preflight", "later batch"])("shows a %s failure for two short sources and retries without losing either", async (failureStage) => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.spyOn(console, "warn").mockImplementation(() => {});
    if (failureStage === "later batch") {
      vi.spyOn(importBatching, "partitionImportSourcesForSynthesis")
        .mockImplementation((sources) => sources.map((source) => [source]));
    }
    vi.spyOn(providerHealth, "autoResumeBackoffMs").mockReturnValue(0);
    const cause = "Invalid schema in provider response at /Users/zelda/import; token='sk-secret-token-123456789'.";
    const succeed: typeof runKnowledgeAssignment = async (request) => {
      if (request.assignment.output.kind !== "root-result") return fixedPipelineResponse(request);
      const sources = request.context.runManifest!.sources;
      return { response: { kind: "complete", payload: {
        result: { ...organizedResult("unused"), notes: sources.flatMap((source) => organizedResult(`Synthesized ${source.title}`).notes) },
        provenance: sources.map((source) => ({ kind: "note", title: `Synthesized ${source.title}`, sourceIds: [source.sourceId], evidenceReferences: [{ kind: "source", sourceId: source.sourceId }] })),
        ownerProposals: [], warnings: [],
      } } };
    };
    if (failureStage === "preflight") {
      vi.mocked(preflightKnowledgeProvider).mockResolvedValue({ ok: false, message: cause });
    } else {
      vi.mocked(runKnowledgeAssignment).mockRejectedValue(new Error(cause));
    }
    if (failureStage === "later batch") {
      vi.mocked(runKnowledgeAssignment).mockImplementation((request, signal) =>
        request.context.runManifest?.sources[0].title === "First idea"
          ? succeed(request, signal)
          : Promise.reject(new Error(cause)),
      );
    }
    const onApply = vi.fn();
    render(<Harness testSnapshot={{ ...snapshot, settings: { ...snapshot.settings, apiKeyConfigured: true } }} onApply={onApply} />);
    for (const title of ["First idea", "Second idea"]) {
      fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
      fireEvent.change(screen.getByLabelText(/Title/), { target: { value: title } });
      fireEvent.change(screen.getByLabelText("Text"), { target: { value: `The complete text of ${title}.` } });
      fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));
    expect(await screen.findByRole("heading", { name: /Orion (could not finish this import|paused while reading the source)\./ }, { timeout: 6_000 })).toBeVisible();
    expect(screen.getByText(/Invalid schema in provider response/)).toHaveTextContent("[redacted]");
    expect(screen.queryByText(/zelda|sk-secret-token/)).not.toBeInTheDocument();
    expect(screen.queryByText("2 notes prepared")).not.toBeInTheDocument();
    expect(screen.queryByText(/Orion shaped your source/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep preview" })).toBeEnabled();
    expect(onApply).not.toHaveBeenCalled();
    if (failureStage === "preflight") expect(runKnowledgeAssignment).not.toHaveBeenCalled();

    vi.mocked(preflightKnowledgeProvider).mockResolvedValue({ ok: true, latencyMs: 0 });
    vi.mocked(runKnowledgeAssignment).mockClear();
    vi.mocked(runKnowledgeAssignment).mockImplementation(succeed);
    fireEvent.click(screen.getByRole("button", { name: /(?:Retry|Resume) import/ }));
    expect(await screen.findByRole("heading", { name: failureStage === "later batch" ? "2 notes prepared" : "1 note prepared" })).toBeVisible();
    expect(screen.queryByRole("alert", { name: "Import diagnostic" })).not.toBeInTheDocument();
    expect(runKnowledgeAssignment).toHaveBeenCalledTimes(failureStage === "later batch" ? 1 : 4);
    if (failureStage === "later batch") {
      expect(vi.mocked(runKnowledgeAssignment).mock.calls[0][0].context.runManifest?.sources.map(({ title }) => title)).toEqual(["Second idea"]);
    }
    fireEvent.click(screen.getByRole("button", { name: "Add to Orion" }));
    await waitFor(() => expect(onApply).toHaveBeenCalledOnce());
    expect(onApply.mock.calls[0][0].sources.map((source: { text: string }) => source.text)).toEqual([
      "The complete text of First idea.", "The complete text of Second idea.",
    ]);
    expect(organizeWithAI).not.toHaveBeenCalled();
  });

  it.each(["recovers", "exhausts", "cancelled"])(
    "automatically retries a transient readiness check: %s",
    async (outcome) => {
      (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.mocked(preflightKnowledgeProvider).mockReset().mockResolvedValue({
        ok: false, message: "Orion could not reach OpenAI: connection reset.",
      });
      if (outcome === "recovers") {
        vi.mocked(preflightKnowledgeProvider)
          .mockResolvedValueOnce({ ok: false, message: "Orion could not reach OpenAI: connection reset." })
          .mockResolvedValueOnce({ ok: true, latencyMs: 12 });
      }
      vi.mocked(runKnowledgeAssignment).mockImplementation(async (request) => {
        const sourceId = request.context.runManifest!.sources[0].sourceId;
        return { response: { kind: "complete", payload: {
          result: organizedResult("Recovered idea"),
          provenance: [{ kind: "note", title: "Recovered idea", sourceIds: [sourceId], evidenceReferences: [{ kind: "source", sourceId }] }],
          ownerProposals: [], warnings: [],
        } } };
      });
      render(<Harness testSnapshot={{ ...snapshot, settings: { ...snapshot.settings, apiKeyConfigured: true } }} />);
      fireEvent.click(screen.getByRole("button", { name: "Paste text" }));
      fireEvent.change(screen.getByLabelText("Text"), { target: { value: "A short source that should survive reconnection." } });
      fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
      fireEvent.click(screen.getByRole("button", { name: "Review sources" }));
      vi.useFakeTimers();
      fireEvent.click(screen.getByRole("button", { name: "Organize with AI" }));
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(screen.getByRole("heading", { name: "Orion is reconnecting to your AI provider" })).toBeVisible();
      expect(preflightKnowledgeProvider).toHaveBeenCalledTimes(1);
      if (outcome === "cancelled") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await act(() => vi.advanceTimersByTimeAsync(11_000));
      if (outcome === "recovers") {
        expect(screen.getByRole("heading", { name: "1 note prepared" })).toBeVisible();
        expect(preflightKnowledgeProvider).toHaveBeenCalledTimes(2);
        expect(runKnowledgeAssignment).toHaveBeenCalledOnce();
      } else if (outcome === "exhausts") {
        expect(screen.getByRole("button", { name: "Retry import" })).toBeVisible();
        expect(preflightKnowledgeProvider).toHaveBeenCalledTimes(3);
        expect(runKnowledgeAssignment).not.toHaveBeenCalled();
      } else {
        expect(screen.getByRole("heading", { name: "Review what Orion will import" })).toBeVisible();
        expect(preflightKnowledgeProvider).toHaveBeenCalledTimes(1);
        expect(runKnowledgeAssignment).not.toHaveBeenCalled();
      }
    },
  );

});
