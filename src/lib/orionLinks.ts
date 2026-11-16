export interface OrionNoteLink {
  spaceId: string;
  noteId: string;
  ticketId?: string;
  boardId?: string;
}

export function parseOrionNoteLink(rawUrl: string): OrionNoteLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "orion:" || url.hostname !== "open") {
    return null;
  }
  const spaceId = url.searchParams.get("space_id")?.trim();
  const noteId = url.searchParams.get("note_id")?.trim();
  if (!spaceId || !noteId) {
    return null;
  }
  const ticketId = url.searchParams.get('ticket_id') ?? undefined;
  const boardId = url.searchParams.get('board_id') ?? undefined;
  if ([ticketId,boardId].some(value=>value!==undefined&&!/^[\w-]{1,96}$/.test(value)) || ticketId&&boardId) return null;
  return { spaceId, noteId, ...(ticketId?{ticketId}:{}), ...(boardId?{boardId}:{}) };
}
