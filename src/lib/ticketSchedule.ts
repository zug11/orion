// Scheduling is inferred only from a quoted clause about the selected action.
// The calendar parser is loaded when inference runs, outside the startup path.
import { statedTicketDeadline } from './calendarRecognition';

export interface TicketSchedule {
  dueDate?: string;
  status?: 'progress';
}

const uncertain = /\b(?:if|unless|whether|maybe|might|may (?:already )?be|could|would|possibly|perhaps|tentativ\w*|hypothetical\w*|probably|not|never|used to|was due|were due|had been|haven['’]t|hasn['’]t|isn['’]t|aren['’]t|wasn['’]t|didn['’]t|don['’]t|won['’]t|i think|i wonder|i hope|for example|for instance)\b/i;
const startedByAuthor = /\b(?:i|we)(?:['’]ve|\s+have)?\s+(?:(?:already|just)\s+)*(?:started|begun|began|resumed)\b/i;
const workingOn = /\b(?:i['’]m|i am|we['’]re|we are|i['’]ve been|we['’]ve been|(?:i|we) have been)\s+(?:(?:already|currently|still)\s+)*working on\b/i;
const activeState = /\b(?:is|are|has been|have been)\s+(?:(?:already|currently|still)\s+)*(?:in progress|underway|under way)\b|\b(?:work|implementation|development)\s+has\s+(?:already\s+)?(?:begun|started|resumed)\b|(?:^|[[(])\s*(?:wip|in progress)\s*[:)\]]/i;
const pausedState = /\b(?:no longer (?:working|active|in progress|underway)|on hold|paused|stopped working)\b/i;
const negatedActivity = /\b(?:not|never|haven['’]t|hasn['’]t|didn['’]t|isn['’]t|aren['’]t)\s+(?:already |currently |actually )?(?:start(?:ed)?|begun|in progress|underway|working on)\b/i;
const endedState = /\b(?:cancelled|canceled|abandoned|(?:is|are|was|were|it['’]s|now|already|since|then)\s+(?:already\s+)?(?:complete|completed|done|finished)|(?:i|we)(?:['’]ve|\s+have)?\s+(?:already\s+)?(?:finished|completed)|(?:finished|completed)\s+it)\b/i;
const questionOpening = /^\s*(?:(?:when|whether|why|how)\b|(?:is|are|was|were|did|has|have|should|can)\s+(?:the|this|that|it|we|i|they)\b)/i;
const withdrawnDeadline = /\b(?:no (?:longer (?:a |any )?)?(?:due date|deadline)|no longer due|(?:not|isn['’]t) due|(?:due date|deadline) (?:was |is |has been )?(?:removed|withdrawn|cancelled|canceled))\b/i;

export function readTicketSchedule(passage: string, reference: string): TicketSchedule {
  const dates = new Set<string>();
  let active = false;
  // Keep negations and questions attached to their sentences, while keeping
  // periods within numeric dates intact. A later explicit withdrawal supersedes
  // an earlier assertion about this action.
  const sentences = passage
    .replace(/“[^”]*”|"[^"]*"/g, ' ')
    .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.(?=\s+\d)/gi, '$1')
    .replace(/\?(?=\s|$)/g, '?\n')
    .split(/\.(?=\s|$)|[;\n!]/);
  for (const sentence of sentences) {
    if (sentence.includes('?') || questionOpening.test(sentence) || /[“”"]/.test(sentence)) continue;
    const withdrawn = withdrawnDeadline.test(sentence);
    if (withdrawn) dates.clear();
    if (negatedActivity.test(sentence)) active = false;
    if (uncertain.test(sentence)) continue;
    if (!withdrawn && endedState.test(sentence)) {
      active = false;
      dates.clear();
      continue;
    }
    if (pausedState.test(sentence)) {
      active = false;
    } else if (startedByAuthor.test(sentence) || workingOn.test(sentence) || activeState.test(sentence)) {
      active = true;
    }
    if (withdrawn || !/\b(?:due|deadline|by|no later than)\b/i.test(sentence)) continue;
    const date = statedTicketDeadline(sentence, reference);
    if (date) dates.add(date);
  }
  const schedule: TicketSchedule = {};
  if (dates.size === 1) schedule.dueDate = [...dates][0];
  if (active) schedule.status = 'progress';
  return schedule;
}
