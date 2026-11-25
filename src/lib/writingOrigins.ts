import type { Note, WritingOrigin } from '../types';

const origins: readonly WritingOrigin[] = ['orion-ai', 'mcp'];

export function writingOrigins(value: unknown): WritingOrigin[] {
  return Array.isArray(value) ? origins.filter(origin => value.includes(origin)) : [];
}

export function isWritingOrigins(value: unknown): value is WritingOrigin[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > origins.length) return false;
  const canonical = writingOrigins(value);
  return canonical.length === value.length && canonical.every((origin, index) => origin === value[index]);
}

export function withWritingOrigin<T extends Note>(note: T, origin: WritingOrigin): T {
  const existing = writingOrigins(note.writingOrigins);
  return existing.includes(origin) ? note : { ...note, writingOrigins: writingOrigins([...existing, origin]) };
}

export function writingCredit(note: Note): string {
  return writingOrigins(note.writingOrigins).map(origin => origin === 'orion-ai' ? 'Orion AI' : 'External app via MCP').join(' · ');
}

/** An editor may have captured its note before a concurrent writer recorded a
 * new origin. Only the transaction that introduced an origin can undo it. */
export function mergeNoteWritingOrigins(previous: Note | undefined, next: Note,
  removal?: 'remove-orion-ai' | 'remove-mcp'): Note {
  if (!previous?.writingOrigins && !next.writingOrigins) return next;
  const origins = writingOrigins([...(previous?.writingOrigins ?? []), ...(next.writingOrigins ?? [])])
    .filter(origin => `remove-${origin}` !== removal);
  if (origins.length) return { ...next, writingOrigins: origins };
  const result = { ...next };
  delete result.writingOrigins;
  return result;
}
