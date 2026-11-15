import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppSnapshot, ChatPromptSuggestion } from "../types";
import { aiProviderForModel, isSelectedAIConfigured } from "../lib/ai";
import { isChatGPTModel } from "../lib/chatgpt";
import {
  generateChatSuggestions,
  getChatSuggestionContext,
  getChatSuggestionContextKey,
} from "../lib/chatSuggestions";

type ConnectionScope = "openai" | "anthropic" | "chatgpt";
type Batch = {
  connectionScope: ConnectionScope;
  key: string;
  contextKey: string;
  status: "ready" | "error";
  suggestions: ChatPromptSuggestion[];
};

// Window-local, bounded and transient. Reopening an unchanged Space should not
// repeatedly purchase the same suggestions. Neither passages nor ideas persist.
const batches = new Map<string, Batch>();
const MAX_BATCHES = 12;
const connectionRevisions: Record<ConnectionScope, number> = { openai: 0, anthropic: 0, chatgpt: 0 };
const connectionListeners = new Set<() => void>();
const subscribeConnection = (listener: () => void) => {
  connectionListeners.add(listener);
  return () => { connectionListeners.delete(listener); };
};

/** Explicit credential/account changes invalidate even while Chat is unmounted. */
export function invalidateChatSuggestionConnection(scope: ConnectionScope) {
  connectionRevisions[scope]++;
  for (const [key, batch] of batches) if (batch.connectionScope === scope) batches.delete(key);
  for (const listener of connectionListeners) listener();
}
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
  const connectionScope: ConnectionScope = isChatGPTModel(snapshot.settings.model) ? "chatgpt" : aiProviderForModel(snapshot.settings.model);
  const configured = isSelectedAIConfigured(snapshot.settings);
  const available = enabled && configured;
  const connectionKey = JSON.stringify([configured, connectionScope === "chatgpt" ? snapshot.settings.chatgptAccountId ?? "" : ""]);
  const connectionRevision = useSyncExternalStore(subscribeConnection, () => connectionRevisions[connectionScope]);
  const previousConnection = useRef({ scope: connectionScope, key: connectionKey });
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = { scope: connectionScope, key: connectionKey };
    if (previous.scope === connectionScope && previous.key !== connectionKey) invalidateChatSuggestionConnection(connectionScope);
  }, [connectionScope, connectionKey]);
  const context = useMemo(() => getChatSuggestionContext(snapshot, { focusNoteId }),
    [snapshot.workspace.id, snapshot.workspace.name, snapshot.notes, snapshot.sources,
      snapshot.concepts, snapshot.relationships, focusNoteId]);
  const contextKey = context ? JSON.stringify([
    snapshot.settings.model, snapshot.settings.reasoningEffort,
    connectionKey, connectionRevision, getChatSuggestionContextKey(context),
  ]) : "";
  const key = contextKey ? JSON.stringify([contextKey, seed, revision]) : "";
  const batch = settled?.key === key ? settled : batches.get(key);

  useEffect(() => {
    if (!available || !context || batches.has(key) || connectionRevisions[connectionScope] !== connectionRevision) return;
    const controller = new AbortController();
    // Debounce navigation and edits, and avoid a provider call during StrictMode
    // setup/cleanup or a brief opening while the user is about to type.
    const timer = window.setTimeout(() => {
      if (controller.signal.aborted || connectionRevisions[connectionScope] !== connectionRevision) return;
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
          if (controller.signal.aborted || connectionRevisions[connectionScope] !== connectionRevision) return;
          const result: Batch = { connectionScope, key, contextKey, status: "ready", suggestions };
          remember(result);
          setSettled(result);
        }).catch(() => {
          if (controller.signal.aborted || connectionRevisions[connectionScope] !== connectionRevision) return;
          // A failed batch stays failed until Refresh or a real connection
          // change. Toggling Chat never causes automatic retries or API usage.
          const result: Batch = { connectionScope, key, contextKey, status: "error", suggestions: [] };
          remember(result);
          setSettled(result);
        });
    }, CHAT_SUGGESTION_DELAY_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
    // The exact packet + model/effort/connection key describes the request.
    // Unrelated snapshot updates must not abort and repurchase it.
  }, [available, key]);

  return {
    status: !available ? "idle" as const : !context ? "empty" as const : batch?.status ?? "loading" as const,
    suggestions: available && context ? batch?.suggestions ?? [] : [],
    targetNoteId: context?.attachedNoteId ?? undefined,
    refresh: () => setRevision(value => value + 1),
  };
}
