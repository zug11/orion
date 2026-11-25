import { createContext } from "react";
import type { Note } from "../types";

export type LeadChoice = { existingId: string } | { name: string; organization?: string };

export interface LeadContacts {
  spaceId: string;
  contacts: readonly Note[];
  save: (choice: LeadChoice, sourceNoteId: string, insert: (contact: Note) => boolean) => boolean;
}

export const LeadContactsContext = createContext<LeadContacts | null>(null);
