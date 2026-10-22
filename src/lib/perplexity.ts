import { invoke, isTauri } from "@tauri-apps/api/core";
import { validateWebResult, webResearchDepth, type WebResearch } from "./webResearch";

function requireDesktop() {
  if (!isTauri()) throw new Error("Enter your Perplexity key in the desktop Orion app. Web research uses its secure Keychain connection.");
}

export async function savePerplexityKey(apiKey: string): Promise<void> {
  requireDesktop();
  await invoke("save_perplexity_api_key", { apiKey });
}
export async function deletePerplexityKey(): Promise<void> {
  requireDesktop();
  await invoke("delete_perplexity_api_key");
}
export async function testPerplexityKey(): Promise<string> {
  requireDesktop();
  return invoke<string>("test_perplexity_key");
}

/** Aborting releases the UI immediately. Native code also cancels admitted remote work. */
export const researchWithPerplexity: WebResearch = async (query, signal, requestedDepth) => {
  requireDesktop();
  signal.throwIfAborted();
  const depth = webResearchDepth(requestedDepth);
  const requestId = `web:${crypto.randomUUID()}`;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    void invoke("cancel_perplexity_research", { requestId }).catch(() => { /* Native deadline remains bounded. */ });
    rejectAbort(signal.reason ?? new Error("Web research was cancelled."));
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([invoke("research_perplexity", { requestId, query, depth }), aborted]);
    signal.throwIfAborted();
    return validateWebResult(response);
  } catch (error) {
    signal.throwIfAborted();
    throw error instanceof Error ? error : new Error(typeof error === "string" ? error : "Web research could not finish. Try again.");
  } finally { signal.removeEventListener("abort", cancel); }
};
