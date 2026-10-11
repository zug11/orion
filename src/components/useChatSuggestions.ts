import { useEffect, useMemo, useState } from "react";
import type { AppSnapshot, ChatPromptSuggestion } from "../types";
import {
  generateChatSuggestions,
  getChatSuggestionContext,
  getChatSuggestionContextKey,
} from "../lib/chatSuggestions";

type Batch = {
  key: string;
  contextKey: string;
  status: "ready" | "error";
  suggestions: ChatPromptSuggestion[];
};

// Window-local, bounded and transient. Reopening an unchanged Space should not
// repeatedly purchase the same suggestions. Neither passages nor ideas persist.
const batches = new Map<string, Batch>();
const MAX_BATCHES = 12;
export const CHAT_SUGGESTION_DELAY_MS = 700;

function remember(batch: Batch) {
  batches.delete(batch.key);
  batches.set(batch.key, batch);
  while (batches.size > MAX_BATCHES) batches.delete(batches.keys().next().value!);
}

export function useChatSuggestions(snapshot: AppSnapshot, {
  enabled,
  focusNoteId,
  seed = 0,
}: { enabled: boolean; focusNoteId?: string; seed?: number }) {
  const [revision, setRevision] = useState(0);
  const [settled, setSettled] = useState<Batch>();
  const context = useMemo(() => getChatSuggestionContext(snapshot, { focusNoteId }),
    [snapshot.workspace.id, snapshot.workspace.name, snapshot.notes, snapshot.sources,
      snapshot.concepts, snapshot.relationships, focusNoteId]);
  const contextKey = context ? JSON.stringify([
    snapshot.settings.model, snapshot.settings.reasoningEffort,
    getChatSuggestionContextKey(context),
  ]) : "";
  const key = contextKey ? JSON.stringify([contextKey, seed, revision]) : "";
  const batch = settled?.key === key ? settled : batches.get(key);

  useEffect(() => {
    if (!enabled || !context || batches.has(key)) return;
    const controller = new AbortController();
    // Debounce navigation and edits, and avoid a provider call during StrictMode
    // setup/cleanup or a brief opening while the user is about to type.
    const timer = window.setTimeout(() => {
      const previousPrompts = [...batches.values()].reverse()
        .filter(item => item.contextKey === contextKey)
        .flatMap(item => item.suggestions.map(suggestion => suggestion.prompt))
        .filter((prompt, index, all) => all.indexOf(prompt) === index).slice(0, 8);
      // Rebudget after adding history (Unicode prompts also count toward bytes).
      const requestContext = getChatSuggestionContext(snapshot, {
        focusNoteId: context.attachedNoteId ?? undefined, previousPrompts,
      });
      if (!requestContext) return;
      void generateChatSuggestions(snapshot, requestContext, controller.signal)
        .then(suggestions => {
          if (controller.signal.aborted) return;
          const result: Batch = { key, contextKey, status: "ready", suggestions };
          remember(result);
          setSettled(result);
        }).catch(() => {
          if (controller.signal.aborted) return;
          // A failed batch stays failed until explicit Refresh; toggling Chat
          // must not cause an automatic retry loop or unexpected API usage.
          const result: Batch = { key, contextKey, status: "error", suggestions: [] };
          remember(result);
          setSettled(result);
        });
    }, CHAT_SUGGESTION_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // The exact packet + model/effort key describes the captured request.
    // Unrelated snapshot updates must not abort and repurchase it.
  }, [enabled, key]);

  return {
    status: !enabled ? "idle" as const : !context ? "empty" as const : batch?.status ?? "loading" as const,
    suggestions: enabled && context ? batch?.suggestions ?? [] : [],
    targetNoteId: context?.attachedNoteId ?? undefined,
    refresh: () => setRevision(value => value + 1),
  };
}
