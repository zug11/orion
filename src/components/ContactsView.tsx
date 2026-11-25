import { useMemo, useState } from "react";
import type { Note } from "../types";
import { Contact, Search } from "../lib/icons";
import { displayNoteTitle } from "../lib/noteMetadata";
import { contactSourceNotes } from "../lib/contacts";

interface ContactsProps {
  notes: readonly Note[];
  onOpenNote: (id: string) => void;
}

export function ContactsView({ notes, onOpenNote }: ContactsProps) {
  const [query, setQuery] = useState("");
  const sorted = useMemo(() => [...notes].sort((a, b) => displayNoteTitle(a).localeCompare(displayNoteTitle(b))), [notes]);
  const term = query.trim().toLocaleLowerCase();
  const filtered = sorted.filter(note => [displayNoteTitle(note), note.contact?.organization]
    .some(value => value?.toLocaleLowerCase().includes(term)));
  return <div className="view index-view">
    <div className="view-title-row"><h1>Contacts</h1></div>
    <div className="index-toolbar">
      <label className="inline-search"><Search size={15} />
        <input aria-label="Find contacts" placeholder="Find by name or organization…" value={query} onChange={event => setQuery(event.target.value)} />
      </label>
    </div>
    <ul className="contact-directory" aria-label="Space contacts">
      {filtered.map(note => <li key={note.id}>
        <button type="button" onClick={() => onOpenNote(note.id)}>
          <Contact size={17} aria-hidden="true" /><strong>{displayNoteTitle(note)}</strong>
          {note.contact?.organization && <span>{note.contact.organization}</span>}
        </button>
      </li>)}
    </ul>
    {!filtered.length && <p role="status">No contacts match this search.</p>}
  </div>;
}

export function ContactSources({ note, notes, onOpenNote }: ContactsProps & { note: Note }) {
  const sources = useMemo(() => contactSourceNotes(note.id, notes), [note.id, notes]);
  return <section className="contact-sources" aria-label="Contact details">
    <p><Contact size={16} aria-hidden="true" />Contact{note.contact?.organization && <> · {note.contact.organization}</>}</p>
    {sources.length > 0 && <><h2>Linked notes</h2><ul>
      {sources.map(source => <li key={source.id}><button className="text-button" type="button" onClick={() => onOpenNote(source.id)}>{displayNoteTitle(source)}</button></li>)}
    </ul></>}
  </section>;
}
