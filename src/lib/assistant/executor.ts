import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import { buildImportPayload, classifyImportUrl, pastedTextToParsedImport } from "../../components/ImportStudio";
import type { AppSnapshot, ParsedImport, TranscribedMedia } from "../../types";
import { chatWithOrion, createFailoverKnowledgeDriver, fetchWebPage, generateNoteImage, organizeWithAI, recognizeDocumentText, saveNoteImage, transcribeYouTube } from "../storage";
import { parseImportFile } from "../files";
import { transcriptToParsedImport } from "../transcription";
import { buildSlideImagePrompt, MAX_DECK_SLIDE_IMAGES, parseDeckSlides } from "../slideDeck";
import { insertImageForSlide } from "../generate";
import { runPresentationWaves } from "../knowledgeOrchestration/waves";
import type { KnowledgeAssignmentDriver } from "../knowledgeOrchestration/service";
import { assertUnchangedSpace } from "./commit";
import { executeAssistantWorkflow } from "./workflows";
import type { AssistantClaim, AssistantJob, WorkflowDependencies } from "./types";

interface ExecutorHost {
  getSpace: (spaceId: string) => AppSnapshot | undefined;
  prepareSpace: (spaceId: string) => Promise<{ snapshot: AppSnapshot; revision: string }>;
  commit: (claim: AssistantClaim, sessionId: string, base: AppSnapshot, generated: AppSnapshot, result: Record<string, unknown>) => Promise<void>;
  onActivity: (jobs: AssistantJob[]) => void;
  onComplete: (job: AssistantClaim) => void;
}

// The app owns one executor. Terminal jobs release input/result memory in native code.
export function startAssistantExecutor(host: ExecutorHost): () => void {
  const sessionId = `renderer_${nanoid(20)}`;
  let disposed = false;
  let running: { id: string; controller: AbortController } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastActivity = "";

  async function run(claim: AssistantClaim, controller: AbortController) {
    const { signal } = controller;
    const jobArgs = { jobId: claim.id, sessionId };
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      controller.abort(new Error("This desktop workflow reached its 20-minute limit. No late result can save notes."));
      void invoke("assistant_cancel", { spaceId: claim.request.space_id, jobId: claim.id }).catch(() => undefined);
    }, 20 * 60_000);
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let reportedCalls = 0;
    try {
      const { snapshot, revision } = await host.prepareSpace(claim.request.space_id);
      await invoke("assistant_begin_context", { ...jobArgs, expectedUpdatedAt: revision });
      const gate = async () => {
        signal.throwIfAborted();
        const live = host.getSpace(claim.request.space_id);
        assertUnchangedSpace(snapshot, live);
        const policy = (space: AppSnapshot) => [space.settings.assistantAccess, space.settings.model, space.settings.reasoningEffort, space.settings.includeExistingNotesInAIContext, space.settings.organizationInstructions, space.settings.providerFailoverEnabled];
        if (!live || JSON.stringify(policy(snapshot)) !== JSON.stringify(policy(live))) throw new Error("Orion's workflow or AI settings changed. This job stopped.");
        await invoke("assistant_assert_job", jobArgs);
        signal.throwIfAborted();
      };
      const provider = createFailoverKnowledgeDriver(snapshot.settings);
      const driver: KnowledgeAssignmentDriver = async (request, requestSignal) => {
        await gate(); calls++;
        const result = await provider(request, requestSignal);
        if (result.usage) {
          inputTokens += result.usage.inputTokens ?? 0; outputTokens += result.usage.outputTokens ?? 0; reportedCalls++;
        }
        await gate(); return result;
      };
      driver.schedulesProviderCalls = true;
      const dependencies: WorkflowDependencies = {
        signal, assertCurrent: gate,
        progress: async (stage) => { await gate(); await invoke("assistant_progress", { ...jobArgs, stage }); },
        chat: async (request) => { await gate(); calls++; const result = await chatWithOrion(request, signal); await gate(); return result; },
        organize: async (request) => { await gate(); calls++; const result = await organizeWithAI(request, { signal }); await gate(); return result; },
        driver, buildImportPayload,
        previousResult: (previousJobId) => invoke("assistant_previous_result", { ...jobArgs, previousJobId }),
        readInput: async (index): Promise<ParsedImport> => {
          await gate();
          if (claim.request.operation !== "import") throw new Error("This job has no external import inputs.");
          const input = claim.request.input.inputs[index];
          if (input.kind === "text") return pastedTextToParsedImport(input.title, input.text);
          if (input.kind === "url") {
            const url = classifyImportUrl(input.url);
            if (url.kind === "youtube") return transcriptToParsedImport(await transcribeYouTube(url.url, { language: snapshot.settings.whisperLanguage }));
            return fetchWebPage(url.url);
          }
          const result = await invoke<{ kind: "transcript"; transcript: TranscribedMedia } | { kind: "file"; fileName: string; base64Data: string }>("assistant_read_input", { ...jobArgs, index });
          await gate();
          if (result.kind === "transcript") return transcriptToParsedImport(result.transcript);
          const bytes = Uint8Array.from(atob(result.base64Data), (character) => character.charCodeAt(0));
          return parseImportFile(new File([bytes], result.fileName), recognizeDocumentText);
        },
        illustrate: async (body, title) => {
          const pending = parseDeckSlides(body).map((slide, index) => ({ slide, index })).filter(({ slide }) => !slide.imageSrc).slice(0, MAX_DECK_SLIDE_IMAGES);
          const plates = await runPresentationWaves({ signal, jobs: pending.map(({ slide, index }) => ({ id: `slide-${index}`, kind: "image" as const, heading: slide.title, index, bullets: slide.bullets, brief: slide.visualBrief ?? "" })),
            execute: async (job) => {
              await gate(); calls++;
              const prompt = buildSlideImagePrompt({ deckTitle: title, slideTitle: job.heading, bullets: job.bullets, visualBrief: job.brief });
              const image = await generateNoteImage(prompt.prompt, signal);
              await gate();
              const bytes = Uint8Array.from(atob(image.base64Data), (character) => character.charCodeAt(0));
              const saved = await saveNoteImage(new File([bytes], "slide.jpg", { type: "image/jpeg" }), `image_${nanoid(16)}`);
              return { index: job.index, saved, alt: prompt.alt };
            },
          });
          for (const { result } of [...plates.results].sort((a, b) => a.result.index - b.result.index)) body = insertImageForSlide(body, result.index, `![${result.alt}](${result.saved.src})`);
          return { body, warnings: [] };
        },
      };
      const outcome = await executeAssistantWorkflow(snapshot, claim.request, dependencies);
      await gate();
      outcome.result.execution = {
        configuredModel: calls ? snapshot.settings.model : null, configuredReasoningEffort: calls ? snapshot.settings.reasoningEffort : null,
        elapsedMs: Date.now() - startedAt, scheduledAIRequests: calls,
        usage: { inputTokens: reportedCalls ? inputTokens : null, outputTokens: reportedCalls ? outputTokens : null, coverage: calls === reportedCalls ? "complete" : "partial-or-unavailable", reportedRequests: reportedCalls },
      };
      if (outcome.snapshot) await host.commit(claim, sessionId, snapshot, outcome.snapshot, outcome.result);
      else await invoke("assistant_finish", { ...jobArgs, result: outcome.result });
      host.onComplete(claim);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 1_000);
      await invoke("assistant_finish", { ...jobArgs, error: message }).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      if (running?.id === claim.id) running = undefined;
    }
  }

  async function poll() {
    try {
      const response = await invoke<{ jobs: AssistantClaim[]; stoppedJobIds: string[]; activity: AssistantJob[] }>("assistant_poll", { sessionId, ready: !running });
      if (disposed) return;
      const encoded = JSON.stringify(response.activity);
      if (encoded !== lastActivity) { lastActivity = encoded; host.onActivity(response.activity); }
      if (running && response.stoppedJobIds.includes(running.id)) running.controller.abort(new Error("The desktop workflow stopped."));
      for (const claim of response.jobs) {
        if (running) throw new Error("The executor received overlapping jobs.");
        const controller = new AbortController(); running = { id: claim.id, controller };
        void run(claim, controller);
      }
    } catch {
      // The next heartbeat reconnects. Native lease expiry handles a lost executor.
    } finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1_500); }
  }
  void poll();
  return () => { disposed = true; clearTimeout(timer); running?.controller.abort(new Error("Orion's workflow executor closed.")); };
}
