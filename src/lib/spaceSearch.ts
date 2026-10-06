import type { AppSnapshot, ChatRequest, ChatResult } from "../types";
import { isSelectedAIConfigured } from "./ai";
import { runChatReading, type ChatReadingOptions } from "./chatReading";

export type SpaceSearchDriver = (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;
export type SpaceSearchOptions = Omit<ChatReadingOptions, "purpose">;

/** Explicit AI search, shared by desktop search and assistant workflows. Never writes. */
export async function runSpaceSearch(
  snapshot: AppSnapshot,
  query: string,
  driver: SpaceSearchDriver,
  options: SpaceSearchOptions = {},
): Promise<ChatResult> {
  const question = query.trim();
  if (!question || question.length > 600) throw new Error("Enter a search question of up to 600 characters.");
  if (!isSelectedAIConfigured(snapshot.settings)) throw new Error("Add a key for the selected AI provider in Settings to answer from this Space.");
  if (!snapshot.notes.length && !snapshot.sources.length) return {
    reply: "This Space does not contain notes or sources yet. Add some material, then search it here.", evidence: [],
    coverage: { availableNotes: 0, availableSources: 0, openedNotes: 0, openedSources: 0, searches: 0, limited: false },
  };
  const currentSnapshot = options.currentSnapshot;
  return runChatReading(snapshot, question, driver, { ...options, purpose: "search",
    ...(currentSnapshot ? { currentSnapshot: () => {
      const current = currentSnapshot();
      if (current && !isSelectedAIConfigured(current.settings)) throw new Error("AI settings changed. Run the search again after configuring the selected provider.");
      return current;
    } } : {}),
  });
}
