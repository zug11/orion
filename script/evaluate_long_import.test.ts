import { File as NodeFile } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../src/data/defaults";
import { parseImportFile } from "../src/lib/files";
import { runKnowledgeImportBatch } from "../src/lib/knowledgeOrchestration/import";
import type { KnowledgeTelemetry } from "../src/lib/knowledgeOrchestration/protocol";
import type { KnowledgeAssignmentExecutionRequest } from "../src/lib/knowledgeOrchestration/service";
import { fixedPipelineResponse } from "../src/lib/knowledgeOrchestration/testFixtures";

const pdfPath = process.env.ORION_LONG_IMPORT_EVAL_PDF;
const ocrRuntimePath = process.env.ORION_LONG_IMPORT_EVAL_OCR_RUNTIME;
const execFileAsync = promisify(execFile);
const mode = process.env.ORION_LONG_IMPORT_EVAL_MODE === "compliant"
  ? "compliant"
  : "recovery";
const optInDescribe = pdfPath ? describe : describe.skip;

const HEGEL_EVALUATION_KNOWLEDGE_OBJECTS = [
  "Contradiction as Immanent Critique",
  "Identity Depends on Nonidentity",
  "Determinate Negation Produces Content",
  "Conceptual Mediation Shapes Experience",
  "Freedom Requires Institutional Form",
  "History Is Legible Through Rupture",
  "Totality Reveals Systemic Dependence",
  "Reconciliation Must Preserve Difference",
  "The Subject Is Socially Mediated",
  "Objectivity Exceeds Conceptual Capture",
  "Dialectics Resists Fixed Oppositions",
  "Second Nature Conceals Historical Formation",
  "Truth Emerges Through Internal Tension",
  "Reason Is Both Critical and Practical",
  "Experience Revises the Concept",
  "Universality Bears Particular Content",
  "Spirit Is Collective Self-Interpretation",
  "Negativity Prevents Premature Closure",
  "The Whole Is Known Through Its Fractures",
  "Philosophy Interprets Social Contradiction",
  "Concepts Carry Historical Sediment",
  "Critique Begins Inside Its Object",
] as const;

interface EvaluationCounters {
  activeReaders: number;
  maxReaderConcurrency: number;
  readingCalls: number;
  adaptiveChildReadingCalls: number;
  readingFailuresInjected: number;
  writingPlanCalls: number;
  writingPlanCorrections: number;
  writerCalls: number;
  writerCorrections: number;
  writerFailuresInjected: number;
  writerSlots: Set<string>;
  telemetry: KnowledgeTelemetry[];
}

optInDescribe("opt-in long PDF import evaluation", () => {
  it("extracts the real PDF and completes the recovery topology without landing", async () => {
    if (!pdfPath) throw new Error("ORION_LONG_IMPORT_EVAL_PDF was not supplied.");
    const bytes = await readFile(pdfPath);
    const documentPages = await readPdfPageCount(bytes);
    const file = new NodeFile([bytes], basename(pdfPath), {
      type: "application/pdf",
    }) as unknown as File;
    let visionPageNumbers: number[] = [];
    const baseline = ocrRuntimePath
      ? await parseImportFile(file)
      : undefined;
    const parsed = await parseImportFile(
      file,
      ocrRuntimePath
        ? async (_document, options) => {
            visionPageNumbers = [...(options?.pageNumbers ?? [])];
            if (visionPageNumbers.length === 0) {
              throw new Error("The selective Vision evaluation received no page numbers.");
            }
            const { stdout } = await execFileAsync(
              ocrRuntimePath,
              [
                "--input",
                pdfPath,
                "--mime-type",
                "application/pdf",
                "--page-numbers",
                visionPageNumbers.join(","),
              ],
              { maxBuffer: 16 * 1024 * 1024 },
            );
            return JSON.parse(stdout);
          }
        : undefined,
    );
    const extraction = auditExtraction(parsed.text, documentPages);
    const baselineExtraction = baseline
      ? auditExtraction(baseline.text, documentPages)
      : undefined;
    const snapshot = createEmptySnapshot(
      "Long import evaluation",
      "2026-08-14T00:00:00.000Z",
      "space-long-import-evaluation",
    );
    const counters: EvaluationCounters = {
      activeReaders: 0,
      maxReaderConcurrency: 0,
      readingCalls: 0,
      adaptiveChildReadingCalls: 0,
      readingFailuresInjected: 0,
      writingPlanCalls: 0,
      writingPlanCorrections: 0,
      writerCalls: 0,
      writerCorrections: 0,
      writerFailuresInjected: 0,
      writerSlots: new Set(),
      telemetry: [],
    };
    let logicalRanges = 0;
    let injectedReadingRange: string | undefined;
    let injectedWriterSlot: string | undefined;

    const driver = async (request: KnowledgeAssignmentExecutionRequest) => {
      const output = request.assignment.output;
      if (output.kind === "reading-blueprint") {
        logicalRanges = output.sourceRanges.length;
      }
      if (output.kind === "source-reading") {
        counters.readingCalls += 1;
        const readingCallOrdinal = counters.readingCalls;
        counters.activeReaders += 1;
        counters.maxReaderConcurrency = Math.max(
          counters.maxReaderConcurrency,
          counters.activeReaders,
        );
        if (output.rangeId.includes(".part-")) {
          counters.adaptiveChildReadingCalls += 1;
        }
        try {
          // A small delay makes the scheduler's real physical width observable.
          await delay(4);
          const response = fixedPipelineResponse(request);
          if (mode === "recovery") {
            const semantic = response as {
              response: {
                payload: {
                  sourceClaims: Array<{
                    claimId: string;
                    text: string;
                    support: Array<{ sourceId: string; rangeId: string }>;
                  }>;
                  synthesisSeeds: Array<Record<string, unknown>>;
                };
              };
            };
            // Capture the ordinal before the concurrent delay. Reading the
            // shared counter afterwards would give every call in a physical
            // wave the same synthetic seed titles and accidentally model
            // semantic repetition rather than a dense book.
            const semanticOrdinal = readingCallOrdinal * 2 - 1;
            const firstKnowledgeObject =
              HEGEL_EVALUATION_KNOWLEDGE_OBJECTS[semanticOrdinal - 1];
            const secondKnowledgeObject =
              HEGEL_EVALUATION_KNOWLEDGE_OBJECTS[semanticOrdinal];
            semantic.response.payload.sourceClaims.push({
              claimId: "claim-2",
              text: `A second independently useful claim in reading ${semanticOrdinal}.`,
              support: [{ sourceId: output.sourceId, rangeId: output.rangeId }],
            });
            semantic.response.payload.synthesisSeeds = [
              {
                seedId: "seed-1",
                proposedTitle: firstKnowledgeObject,
                thesis: `${firstKnowledgeObject} is a distinct durable thesis supported by this reading.`,
                claimIds: ["claim-1"],
                importance: "high",
                contribution: "new",
                relatedNoteIds: [],
                rationale: "The fixture models a distinct high-value idea.",
              },
              {
                seedId: "seed-2",
                proposedTitle: secondKnowledgeObject,
                thesis: `${secondKnowledgeObject} is a second distinct durable thesis supported by this reading.`,
                claimIds: ["claim-2"],
                importance: "high",
                contribution: "connects",
                relatedNoteIds: [],
                rationale: "The fixture models another distinct high-value idea.",
              },
            ];
          }
          if (
            mode === "recovery" &&
            injectedReadingRange === undefined &&
            !output.rangeId.includes(".part-")
          ) {
            injectedReadingRange = output.rangeId;
            counters.readingFailuresInjected += 1;
            const incomplete = structuredClone(response) as {
              response: {
                payload: { coverage: { complete: boolean; limitations: string[] } };
              };
            };
            incomplete.response.payload.coverage = {
              complete: false,
              limitations: ["The fixture requested narrower exact ranges."],
            };
            return incomplete as ReturnType<typeof fixedPipelineResponse>;
          }
          return response;
        } finally {
          counters.activeReaders -= 1;
        }
      }
      if (output.kind === "writing-blueprint") {
        counters.writingPlanCalls += 1;
        if (request.observations.length > 0) {
          counters.writingPlanCorrections += 1;
        }
        if (mode === "recovery") {
          return {
            response: { kind: "complete", payload: {} },
          } as ReturnType<typeof fixedPipelineResponse>;
        }
      }
      if (output.kind === "writer-result") {
        counters.writerCalls += 1;
        counters.writerSlots.add(output.writerSlotId);
        if (request.observations.length > 0) {
          counters.writerCorrections += 1;
        }
        await delay(4);
        if (
          mode === "recovery" &&
          (injectedWriterSlot === undefined ||
            injectedWriterSlot === output.writerSlotId)
        ) {
          injectedWriterSlot ??= output.writerSlotId;
          counters.writerFailuresInjected += 1;
          return {
            response: {
              kind: "complete",
              payload: {
                writerSlotId: output.writerSlotId,
                drafts: [],
                warnings: [],
              },
            },
          } as ReturnType<typeof fixedPipelineResponse>;
        }
      }
      return fixedPipelineResponse(request);
    };

    const startedAt = performance.now();
    const result = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "fixture-pdf", parsed }],
      importGuidance:
        "Build focused notes around the document's actual arguments and conceptual transitions.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver,
      landOnFailure: true,
      onTelemetry: (telemetry) => {
        counters.telemetry.push(structuredClone(telemetry));
      },
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    const finalTelemetry = counters.telemetry.at(-1);
    const report = {
      fixture: basename(pdfPath),
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mode,
      vision: {
        enabled: Boolean(ocrRuntimePath),
        selectedPages: visionPageNumbers,
        replacementCharactersBefore: baselineExtraction?.replacementCharacters,
        replacementCharactersAfter: extraction.replacementCharacters,
      },
      extraction,
      topology: {
        logicalRanges,
        readingCalls: counters.readingCalls,
        adaptiveChildReadingCalls: counters.adaptiveChildReadingCalls,
        readingFailuresInjected: counters.readingFailuresInjected,
        maxReaderConcurrency: counters.maxReaderConcurrency,
        maximumTelemetryPhysicalWidth: Math.max(
          0,
          ...counters.telemetry.map(({ physicalWidth }) => physicalWidth),
        ),
        writingPlanCalls: counters.writingPlanCalls,
        writingPlanCorrections: counters.writingPlanCorrections,
        writerJobs: counters.writerSlots.size,
        writerCalls: counters.writerCalls,
        writerCorrections: counters.writerCorrections,
        writerFailuresInjected: counters.writerFailuresInjected,
      },
      result: {
        noteCount: result.organized.notes.length,
        noteTitles: result.organized.notes.map(({ title }) => title),
        connectionCount: result.organized.suggestedConnections.length,
        landing: result.landing ?? null,
        warnings: result.warnings,
        extractionWarnings: parsed.warnings,
        finalStatus: finalTelemetry?.status ?? "unknown",
      },
      elapsedMs,
    };

    console.log(`\nORION_LONG_IMPORT_EVALUATION\n${JSON.stringify(report, null, 2)}\n`);

    expect(parsed.format).toBe("pdf");
    expect(extraction.pagesWithText).toBeGreaterThan(0);
    expect(extraction.characters).toBeGreaterThan(60_000);
    expect(logicalRanges).toBeGreaterThan(1);
    expect(counters.maxReaderConcurrency).toBeGreaterThan(1);
    expect(counters.maxReaderConcurrency).toBeLessThanOrEqual(6);
    expect(result.landing).toBeUndefined();
    expect(result.organized.notes.length).toBeGreaterThan(0);
    expect(finalTelemetry?.status).toBe("completed");
    if (ocrRuntimePath && baselineExtraction) {
      expect(visionPageNumbers.length).toBeGreaterThan(0);
      expect(extraction.replacementCharacters).toBeLessThan(
        baselineExtraction.replacementCharacters,
      );
    }

    if (mode === "recovery") {
      expect(counters.readingFailuresInjected).toBe(1);
      expect(counters.adaptiveChildReadingCalls).toBeGreaterThanOrEqual(2);
      expect(counters.writingPlanCalls).toBeGreaterThanOrEqual(2);
      expect(counters.writingPlanCorrections).toBeGreaterThanOrEqual(1);
      expect(counters.writerCorrections).toBeGreaterThanOrEqual(1);
      expect(counters.writerFailuresInjected).toBe(2);
      expect(result.organized.notes.length).toBeGreaterThanOrEqual(10);
      expect(
        result.organized.notes.every(({ title }) =>
          HEGEL_EVALUATION_KNOWLEDGE_OBJECTS.includes(
            title as (typeof HEGEL_EVALUATION_KNOWLEDGE_OBJECTS)[number],
          ),
        ),
      ).toBe(true);
      expect(
        result.organized.notes.every(
          ({ title }) =>
            !/\bpart\s+\d+\b|\brange[- ]?\d+\b|^notes?\s+(?:on|of)\b/iu.test(
              title,
            ),
        ),
      ).toBe(true);
      expect(result.warnings.some((warning) =>
        warning.includes("repaired the note plan locally")
      )).toBe(true);
    }
  });
});

function auditExtraction(text: string, documentPages: number) {
  const pageMatches = [...text.matchAll(/^## Page (\d+)\s*$/gm)];
  const pageNumbers = pageMatches.map((match) => Number(match[1]));
  const highestPageNumber = Math.max(0, ...pageNumbers);
  const pageBodies = text
    .split(/^## Page \d+\s*$/gm)
    .slice(1)
    .map((page) => page.trim());
  const linePageCounts = new Map<string, number>();
  for (const page of pageBodies) {
    const uniqueLines = new Set(
      page
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter((line) => line.length >= 3 && line.length <= 120),
    );
    for (const line of uniqueLines) {
      linePageCounts.set(line, (linePageCounts.get(line) ?? 0) + 1);
    }
  }
  const repeatedLineCandidates = [...linePageCounts.entries()]
    .filter(([, pageCount]) => pageCount >= 5)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12)
    .map(([line, pageCount]) => ({ line, pageCount }));
  const pageCharacterCounts = pageBodies
    .map((page) => page.length)
    .sort((a, b) => a - b);
  const medianCharactersPerTextPage = pageCharacterCounts.length === 0
    ? 0
    : pageCharacterCounts[Math.floor(pageCharacterCounts.length / 2)];
  const replacementCharacters = [...text.matchAll(/\uFFFD/g)].length;
  const replacementCharactersPer10k = text.length === 0
    ? 0
    : Number(((replacementCharacters * 10_000) / text.length).toFixed(2));
  const qualityFlags: string[] = [];
  if (replacementCharactersPer10k >= 5) {
    qualityFlags.push(
      "Material replacement-character damage remains after local extraction; review the affected pages before relying on names or quotations.",
    );
  }
  if (repeatedLineCandidates.length > 0) {
    qualityFlags.push(
      "Repeated short edge lines remain after normalization and may be running furniture.",
    );
  }
  return {
    documentPages,
    pagesWithText: pageBodies.filter(Boolean).length,
    highestPageNumber,
    pagesWithoutSelectableText: Math.max(
      0,
      documentPages - pageBodies.filter(Boolean).length,
    ),
    characters: text.length,
    medianCharactersPerTextPage,
    lineEndHyphenations: [...text.matchAll(/[\p{L}\p{N}]-\n[\p{Ll}]/gu)].length,
    replacementCharacters,
    replacementCharactersPer10k,
    repeatedLineCandidates,
    qualityFlags,
  };
}

async function readPdfPageCount(bytes: Uint8Array): Promise<number> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
  });
  try {
    return (await loadingTask.promise).numPages;
  } finally {
    await loadingTask.destroy();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
