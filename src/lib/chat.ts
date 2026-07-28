import type {
  AppSnapshot,
  ChatRequest,
  ChatResult,
  StudioMessage,
} from "../types";
import { normalizeStudio } from "./studio";

export interface ChatRequestToken {
  id: string;
  spaceId: string;
  generation: number;
}

export class ChatRequestRegistry {
  private readonly pending = new Map<string, ChatRequestToken>();
  private readonly generations = new Map<string, number>();

  start(spaceId: string, id: string): ChatRequestToken | null {
    if (this.pending.has(spaceId)) {
      return null;
    }
    const token = {
      id,
      spaceId,
      generation: this.generations.get(spaceId) ?? 0,
    };
    this.pending.set(spaceId, token);
    return token;
  }

  invalidate(spaceId: string): void {
    this.generations.set(
      spaceId,
      (this.generations.get(spaceId) ?? 0) + 1,
    );
  }

  isCurrent(token: ChatRequestToken): boolean {
    const current = this.pending.get(token.spaceId);
    return (
      current?.id === token.id &&
      current.generation === token.generation &&
      (this.generations.get(token.spaceId) ?? 0) === token.generation
    );
  }

  finish(token: ChatRequestToken): boolean {
    if (this.pending.get(token.spaceId)?.id !== token.id) {
      return false;
    }
    this.pending.delete(token.spaceId);
    return true;
  }
}

export function buildChatRequest(
  snapshot: AppSnapshot,
  prompt: string,
): ChatRequest {
  const studio = normalizeStudio(snapshot.studio);

  return {
    prompt: prompt.trim().slice(0, 8_000),
    workspaceName: snapshot.workspace.name,
    notes: snapshot.notes.slice(0, 80).map((note) => ({
      title: note.title,
      summary: note.summary.slice(0, 1_000),
      body: note.body.slice(0, 8_000),
    })),
    sources: snapshot.sources.slice(0, 30).map((source) => ({
      title: source.title,
      text: source.text.slice(0, 6_000),
    })),
    concepts: snapshot.concepts.slice(0, 120).map((concept) => ({
      label: concept.label,
      description: concept.description.slice(0, 1_000),
    })),
    history: studio.messages.slice(-12).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 4_000),
    })),
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
  };
}

export function applyChatResult(
  snapshot: AppSnapshot,
  prompt: string,
  result: ChatResult,
  now: string,
  idFactory: () => string,
): AppSnapshot {
  const studio = normalizeStudio(snapshot.studio);
  const messages: StudioMessage[] = [
    ...studio.messages,
    {
      id: idFactory(),
      role: "user",
      content: prompt.trim(),
      cardIds: [],
      contextCardIds: [],
      createdAt: now,
    },
    {
      id: idFactory(),
      role: "assistant",
      content: result.reply.trim(),
      cardIds: [],
      contextCardIds: [],
      createdAt: now,
    },
  ];

  return {
    ...snapshot,
    studio: {
      ...studio,
      messages,
    },
    updatedAt: now,
  };
}
