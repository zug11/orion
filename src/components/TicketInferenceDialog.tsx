import { useEffect, useRef, useState } from 'react';
import { boardColumns } from '../lib/tickets';
import { dateLabel } from '../lib/calendarDate';
import { DateButton } from './CalendarPicker';
import { UrgencyPicker } from './Tickets';
import { reviewTicket, type TicketReviewRow, validTicketTitle, MAX_INFERRED_TICKETS, type TicketInferenceTarget, type TicketInferenceProgress, type TicketInference, type TicketInferenceActions } from '../lib/ticketInference';
import { LoaderCircle, X } from '../lib/icons';

export function TicketInferenceDialog({ board, actions, onClose }: {
  board: TicketInferenceTarget; actions: TicketInferenceActions; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<TicketInference | null>(null);
  const [drafts, setDrafts] = useState<Array<TicketReviewRow & { selected: boolean; taskId?: string }>>([]);
  const [progress, setProgress] = useState<TicketInferenceProgress | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { const node = dialog.current; node?.showModal(); node?.querySelector('button')?.focus(); return () => node?.close(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setProgress(null); setError(''); setResult(null);
    // StrictMode's discarded mount must not dispatch a second paid request.
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return actionsRef.current.generate(board, controller.signal, value => { if (!controller.signal.aborted) setProgress(value); });
    }).then(value => {
      if (controller.signal.aborted) return;
      setResult(value); setDrafts(value.suggestions.map((s, index) => ({ ...reviewTicket(s, index), selected: !s.likelyDuplicate, taskId: s.taskId, boardId:s.boardId??board.id })));
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Could not infer tickets. Try again.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [board.id, board.noteId, attempt]);
  const close = () => { dialog.current?.close(); onClose(); };
  const selected = drafts.filter(d => d.selected);
  return <dialog ref={dialog} className="work-item-composer ticket-inference" aria-label="Infer tickets from note"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <form onSubmit={event => {
      event.preventDefault();
      if (!result || !selected.length || !selected.every(d => validTicketTitle(d.title))) return;
      if (actions.apply(board, result, selected.map(({ selected: _selected, taskId: _taskId, ...row }) => ({ ...row, title: row.title.trim() })))) close();
      else { setError('The note changed or these tickets already exist. Infer again to use the current note.'); setResult(null); }
    }}>
      <header><h2>Tickets from your note</h2><button type="button" className="icon-button" aria-label="Cancel" onClick={close}><X size={16}/></button></header>
      <p className="ticket-inference-intro">{board.fromNote ? `Review actions from ${board.title} and choose where they belong. Tickets stay linked to this note.` : `Choose which changes to apply to ${board.title}.`}</p>
      {busy && <p className="ticket-inference-busy" role="status"><LoaderCircle size={16} className="spin"/>{progress?.total ? `Reading note · ${progress.completed} of ${progress.total} sections` : 'Collecting open to-dos…'}</p>}
      {error && <p className="ticket-error" role="alert">{error}</p>}
      {result?.partial && <p className="ticket-inference-intro">Showing the first {MAX_INFERRED_TICKETS} actions. Add these, then infer again to collect the rest.</p>}
      {result?.localOnly && <p className="ticket-inference-intro">Showing written to-dos. Connect AI in Settings to also find actions in prose.</p>}
      {result && !result.localOnly && <p className="ticket-inference-intro">Read {result.sectionsRead ?? 1} of {result.totalSections ?? 1} sections · Completed to-dos excluded</p>}
      {result && <div className="ticket-suggestions">
        {!drafts.length && <p>No new actions or ticket updates found.</p>}
        {drafts.map((draft, index) => <div className="ticket-suggestion" key={index}>
          <label className="ticket-suggestion-choice"><input type="checkbox" checked={draft.selected} aria-label={`Include suggestion ${index + 1}`} onChange={e => setDrafts(current => current.map((d, i) => i === index ? { ...d, selected: e.target.checked } : d))}/>
            <input type="text" aria-label={`Ticket ${index + 1}`} maxLength={140} readOnly={Boolean(draft.taskId)} title={result.suggestions[index].onBoard ? 'Update existing ticket' : draft.taskId ? 'Existing to-do — added to this board in place' : undefined} required={draft.selected} value={draft.title} onChange={e => setDrafts(current => current.map((d, i) => i === index ? { ...d, title: e.target.value } : d))}/></label>
          <div className="inferred-ticket-details">
            <strong>Description</strong>
            <p>{result.suggestions[index].description || (draft.taskId ? 'Keep current description.' : 'No description suggested.')}</p>
            <strong>Checklist</strong>
            {result.suggestions[index].checklist?.length
              ? <ul>{result.suggestions[index].checklist!.map(step => <li key={step}>{step}</li>)}</ul>
              : <p>{draft.taskId ? 'Keep current checklist.' : 'No checklist steps suggested.'}</p>}
          </div>
          <blockquote>{result.suggestions[index].evidence}</blockquote>
          {result.suggestions[index].detailPassages?.some(passage => passage !== result.suggestions[index].evidence) && <details className="inferred-ticket-details">
            <summary>Source for these details</summary>
            {result.suggestions[index].detailPassages!.filter(passage => passage !== result.suggestions[index].evidence).map(passage => <blockquote key={passage}>{passage}</blockquote>)}
          </details>}
          {result.suggestions[index].likelyDuplicate && <p className="ticket-duplicate-hint">May already exist: {result.suggestions[index].likelyDuplicate!.title}. Left unchecked; include it only if this is separate work.</p>}
          {board.fromNote && <label className="ticket-board-choice">Board<select aria-label={`Board for suggestion ${index+1}`} value={draft.boardId} disabled={result.suggestions[index].onBoard} onChange={event=>setDrafts(current=>current.map((d,i)=>i===index?{...d,boardId:event.target.value}:d))}>
            <option value="">No board</option>{result.boards?.map(candidate=><option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
          </select></label>}
          {result.suggestions[index].schedulePassages?.length && (result.suggestions[index].dueDate || result.suggestions[index].status) ?
            <details className="inferred-ticket-details"><summary>Source for date and status</summary>
              {result.suggestions[index].schedulePassages.map(passage => <blockquote key={passage}>{passage}</blockquote>)}
            </details> : null}
          <div className="ticket-inference-schedule">
            <label>Status <select aria-label={`Status for suggestion ${index + 1}`} value={draft.status}
              disabled={Boolean(result.suggestions[index].existingStatus && result.suggestions[index].existingStatus !== 'todo')}
              onChange={event => setDrafts(current => current.map((d, i) => i === index ? { ...d, status: event.target.value === 'progress' ? 'progress' : 'todo' } : d))}>
              <option value="todo">To do</option><option value="progress">In progress</option>
              {draft.status.startsWith('column-') && <option value={draft.status}>{boardColumns(result.boards?.find(b => b.id === draft.boardId) ?? board).find(([id]) => id === draft.status)?.[1] ?? 'Current column'}</option>}
            </select></label>
            {result.suggestions[index].existingDueDate
              ? <span>Due {dateLabel(draft.dueDate)}</span>
              : <DateButton label={`Due date for suggestion ${index + 1}`} value={draft.dueDate} onChange={dueDate =>
                  setDrafts(current => current.map((d, i) => i === index ? { ...d, dueDate } : d))}/>}
          </div>
          <UrgencyPicker value={draft.urgency} title={`suggestion ${index + 1}`} onChange={urgency => {
            setDrafts(current => current.map((d, i) => i === index ? { ...d, urgency } : d)); return true;
          }}/>
        </div>)}
      </div>}
      <footer><button type="button" className="text-button" onClick={close}>{busy ? 'Cancel' : 'Close'}</button>
        {error ? <button type="button" className="button secondary" onClick={() => setAttempt(a => a + 1)}>Infer again</button> : result && drafts.length > 0 && <button type="submit" className="button primary" disabled={!selected.length || !selected.every(d => validTicketTitle(d.title))}>{result.suggestions.some(s=>s.onBoard) ? `Apply ${selected.length} ${selected.length === 1 ? 'change' : 'changes'}` : `Add ${selected.length} ${selected.length === 1 ? 'ticket' : 'tickets'}`}</button>}
      </footer>
    </form>
  </dialog>;
}
