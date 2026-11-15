import { invoke, isTauri } from "@tauri-apps/api/core";
import { validateWebResult, webResearchDepth, type WebResearch } from "./webResearch";

/** Capture the selected model/authentication route once for this research run. */
export function researchWithOpenAI(model: string): WebResearch {
  return async (query, signal, requestedDepth) => {
    if (!isTauri()) throw new Error("OpenAI web research is available in the desktop Orion app using your saved connection.");
    signal.throwIfAborted();
    const depth = webResearchDepth(requestedDepth);
    const requestId = `web:${crypto.randomUUID()}`;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const cancel = () => {
      void invoke("cancel_openai_web_research", { requestId }).catch(() => { /* The native deadline remains bounded. */ });
      rejectAbort(signal.reason ?? new Error("Web research was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response = await Promise.race([invoke("research_openai_web", { requestId, query, depth, model }), aborted]);
      signal.throwIfAborted();
      return validateWebResult(response);
    } catch (error) {
      signal.throwIfAborted();
      throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "OpenAI web research could not finish. Try again.");
    } finally { signal.removeEventListener("abort", cancel); }
  };
}
