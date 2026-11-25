import { useLayoutEffect, useId, useRef, useState } from "react";
import { MAX_CONTACT_LABEL_LENGTH } from "../../lib/contacts";
import { displayNoteTitle } from "../../lib/noteMetadata";
import { X } from "../../lib/icons";
import type { Note } from "../../types";
import type { LeadChoice } from "../LeadContactsContext";
import "./LeadContactDialog.css";

interface Props {
  contacts: readonly Note[];
  onSave: (choice: LeadChoice) => boolean;
  onClose: () => void;
}

export function LeadContactDialog({ contacts, onSave, onClose }: Props) {
  const [create, setCreate] = useState(contacts.length === 0);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  useLayoutEffect(() => { firstInput.current?.focus(); }, [create]);

  function close() {
    dialog.current?.close();
    onClose();
  }
  function save(choice: LeadChoice) {
    if (onSave(choice)) close();
    else setError(true);
  }

  const search = query.trim().toLocaleLowerCase();
  const matches = contacts.filter(note =>
    [displayNoteTitle(note), note.contact?.organization].some(field => field?.toLocaleLowerCase().includes(search)),
  );
  const labels = new Map<string, number>();
  const contactLabel = (note: Note) => JSON.stringify([displayNoteTitle(note).toLocaleLowerCase(), note.contact?.organization?.trim().toLocaleLowerCase() || ""]);
  for (const note of matches) {
    const label = contactLabel(note);
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  return <dialog ref={dialog} className="work-item-composer lead-contact-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}
    onKeyDown={event => event.stopPropagation()}>
    <header><h2 id={titleId}>{create ? "New contact" : "Link a contact"}</h2>
      <button type="button" className="icon-button" aria-label="Cancel" onClick={close}><X size={16}/></button>
    </header>
    {create ? <form onSubmit={event => {
      event.preventDefault();
      if (name.trim()) save({ name: name.trim(), ...(organization.trim() && { organization: organization.trim() }) });
    }}>
      <label>Name<input ref={firstInput} required maxLength={MAX_CONTACT_LABEL_LENGTH} value={name} onChange={event => setName(event.target.value)}/></label>
      <label>Organization (optional)<input maxLength={MAX_CONTACT_LABEL_LENGTH} value={organization} onChange={event => setOrganization(event.target.value)}/></label>
      <footer>
        {contacts.length > 0 && <button type="button" className="text-button" onClick={() => { setError(false); setCreate(false); }}>Choose an existing contact</button>}
        <button type="submit" className="button primary" disabled={!name.trim()}>Create and link</button>
      </footer>
    </form> : <>
      <label>Find a contact<input ref={firstInput} type="search" value={query}
        placeholder="Name or organization" onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && matches.length === 1) {
            event.preventDefault();
            save({ existingId: matches[0].id });
          }
          if (event.key === "ArrowDown" && matches.length) {
            event.preventDefault();
            results.current?.querySelector("button")?.focus();
          }
        }}/></label>
      <ul ref={results} className="lead-contact-results" aria-label="Matching contacts">
        {matches.map(note => <li key={note.id}><button type="button"
          aria-label={[displayNoteTitle(note), note.contact?.organization, (labels.get(contactLabel(note)) ?? 0) > 1 && note.id].filter(Boolean).join(", ")}
          onClick={() => save({ existingId: note.id })}>
          <strong>{displayNoteTitle(note)}</strong>
          {note.contact?.organization && <span>{note.contact.organization}</span>}
          {(labels.get(contactLabel(note)) ?? 0) > 1 && <small>{note.id}</small>}
        </button></li>)}
      </ul>
      {!matches.length && <p role="status">No matching contacts</p>}
      <footer><button className="button" type="button" onClick={() => {
        setName(query.trim()); setError(false); setCreate(true);
      }}>New contact</button></footer>
    </>}
    {error && <p className="ticket-error" role="alert">The note or contact changed. Close the picker and try again.</p>}
  </dialog>;
}
