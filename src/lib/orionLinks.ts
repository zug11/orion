export interface OrionNoteLink {
  spaceId: string;
  noteId: string;
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
  return { spaceId, noteId };
}
