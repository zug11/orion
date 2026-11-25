import type { AppSnapshot } from "../types";
import type { VoiceTurn } from "./voiceConversation";
import type { Ticket } from "./tickets";
import { ticketCode } from "./ticketCodes";
import { ticketTitleKey } from "./ticketInference";
import { matchSpokenTickets, reportedVoiceTicket, resolveVoiceTickets, spokenTicketAnchor, spokenTicketChoices,
  ticketChoiceQuestion, voiceTicketCompletionReference, type TicketSpace } from "./voiceTicketCompletion";

type SpokenTurn = Pick<VoiceTurn, "key" | "prompt" | "focusedTicketId" | "ticketQuestionKey">;
export interface TicketQuestion {
  key: number;
  space: TicketSpace;
  choices: Ticket[];
  message: string;
  focusedTicketId?: string;
  /** An answer must begin after Orion presented this particular question. */
  after?: number;
}
export type TicketDecision = { kind: "complete"; tickets: Ticket[] } | { kind: "notice"; message: string } | { kind: "ignore"; guidance?: string }
  | { kind: "ask"; question: TicketQuestion; search?: string };

function mentionedTickets(space: TicketSpace, prompt: string) {
  const tickets = spokenTicketChoices(space);
  const words = " " + ticketTitleKey(prompt) + " ";
  const found = tickets.filter(ticket => {
    const title = ticketTitleKey(ticket.title);
    const code = ticketCode(space.ticketCodes, ticket.id);
    return title.includes(" ") && words.includes(" " + title + " ") || !!code && [ticketTitleKey(code), ticketTitleKey(code.replace(/-0+/, "-"))]
      .some(form => words.includes(" " + form + " "));
  });
  for (const clause of prompt.split(/[,;.!?]|\b(?:and|or)\b/i)) {
    const noun = /\b(?:ticket|card)\b/i.exec(clause);
    if (!noun) continue;
    const before = clause.slice(0, noun.index).split(/\b(?:the|that|my|our|this)\s+/i);
    const after = clause.slice(noun.index + noun[0].length).trim().replace(/^(?:about|for|called|named)\s+/i, "");
    const reference = after || (before.length > 1 && before[before.length - 1].trim());
    if (reference) found.push(...matchSpokenTickets(space, tickets, reference));
  }
  return [...new Set(found)];
}

const affirmative = /^(?:yes|yeah|yep|yup|sure|correct|please do|go ahead|do it|that s right|that s the one|that one)(?: please(?: do)?| do it| go ahead| that one| that s the one)?$/;
const negative = /^(?:no|nope|not yet|never mind|nevermind|leave it|cancel|don t|do not)(?: thanks| please| do that)?$/;
const ordinals = ["first", "second", "third"];

function ticketQuestion(space: TicketSpace, turn: SpokenTurn, choices: Ticket[], message: string): TicketQuestion {
  return { key: turn.key, space: { notes: space.notes, ticketCodes: space.ticketCodes }, choices, message, focusedTicketId: turn.focusedTicketId };
}

/** Only real human turns enter this dialogue. A question and its candidate
 * identities live in one call; later navigation cannot substitute another card. */
export class VoiceTicketDialogue {
  question?: TicketQuestion;
  private previous?: { key: number; prompt: string; spaceId: string; space: TicketSpace };

  reset() { this.previous = undefined; this.question = undefined; }

  private ask(space: TicketSpace, turn: SpokenTurn, choices: Ticket[], message: string, search?: string): TicketDecision {
    this.question = ticketQuestion(space, turn, choices, message);
    return { kind: "ask", question: this.question, search };
  }

  private answer(question: TicketQuestion, turn: SpokenTurn): TicketDecision | undefined {
    const reply = ticketTitleKey(turn.prompt);
    const asking = turn.prompt.includes("?");
    if (negative.test(reply)) return { kind: "notice", message: "Okay, I’ll leave the tickets as they are." };
    if (affirmative.test(reply)) {
      if (!asking && question.choices.length === 1) return { kind: "complete", tickets: question.choices };
      return { kind: "ask", question };
    }
    const choice = turn.prompt.trim().replace(/[.!]+$/, "").replace(/^(?:(?:yes|yeah|yep|yup|okay|ok)[,\s]+)?(?:(?:i meant|i mean|go with|the one (?:about|for))\s+)?/i, "").replace(/,?\s+please$/i, "");
    const position = /^(?:the )?(first|second|third|1st|2nd|3rd)(?: one| ticket| option)?$/.exec(ticketTitleKey(choice));
    if (position) {
      const index = /^\d/.test(position[1]) ? Number(position[1][0]) - 1 : ordinals.indexOf(position[1]);
      const ticket = question.choices[index];
      if (ticket && asking) return { kind: "ask", question: ticketQuestion(question.space, turn, [ticket], ticketChoiceQuestion(question.space, [ticket])) };
      if (ticket) return { kind: "complete", tickets: [ticket] };
      return { kind: "ask", question };
    }
    // Match only a reference-sized reply against the choices originally offered.
    // An unrelated request can continue normally and ends this pending question.
    if (turn.prompt.length > 180 || asking || /\b(?:if|unless|maybe|don't|don’t|not|instead of)\b/i.test(turn.prompt)) return;
    const pool = question.choices.length ? question.choices : spokenTicketChoices(question.space);
    const matches = matchSpokenTickets(question.space, pool, choice);
    if (matches.length === 1) return { kind: "complete", tickets: matches };
    if (matches.length > 1) return { kind: "ask", question: ticketQuestion(question.space, turn, matches, ticketChoiceQuestion(question.space, matches)) };
  }

  interpret(space: AppSnapshot, turn: SpokenTurn): TicketDecision | undefined {
    if (this.previous?.spaceId !== space.workspace.id) this.reset();
    const previous = this.previous;
    if (previous && (turn.key < previous.key || turn.key === previous.key && turn.prompt === previous.prompt)) return;
    this.previous = { key: turn.key, prompt: turn.prompt, spaceId: space.workspace.id, space: { notes: space.notes, ticketCodes: space.ticketCodes } };
    const question = this.question;
    const sameFocus = question && question.focusedTicketId === turn.focusedTicketId;
    const canAnswer = sameFocus && question.after !== undefined && turn.key > question.after &&
      (turn.ticketQuestionKey === undefined || turn.ticketQuestionKey === question.key);
    const request = voiceTicketCompletionReference(turn.prompt);
    const reply = sameFocus && !request ? this.answer(question, turn) : undefined;
    if (reply && !canAnswer) {
      return { kind: "ignore", ...(turn.ticketQuestionKey === null ? {
        guidance: "To confirm, say “mark” followed by the ticket title or code and “done”.",
      } : {}) };
    }
    this.question = undefined;
    if (canAnswer) {
      if (request && spokenTicketAnchor(request) === "either" && question.choices.length === 1 && !turn.focusedTicketId) {
        return { kind: "complete", tickets: question.choices };
      }
      if (reply) {
        if (reply.kind === "ask") this.question = reply.question;
        return reply;
      }
    }
    const reference = request ?? reportedVoiceTicket(turn.prompt);
    if (!reference) return;
    const anchor = spokenTicketAnchor(reference);
    // Resolve the immediately preceding human mention against the Space as it
    // existed then. The write path rechecks the captured card on the current note.
    const usePrevious = anchor === "recent" || anchor === "either" && !turn.focusedTicketId;
    const recent = usePrevious && previous && previous.key !== turn.key
      ? mentionedTickets(previous.space, previous.prompt) : [];
    if (request && anchor === "either" && !turn.focusedTicketId && !recent.length &&
        /\b(?:close|finish)\b/i.test(turn.prompt) && !/\b(?:ticket|card)\b/i.test(turn.prompt)) return;
    const result = recent.length ? { tickets: recent } : resolveVoiceTickets(space, reference, turn.focusedTicketId);
    if ("message" in result) {
      if (!request && !result.choices?.length) return;
      if (!result.choices) return { kind: "notice", message: result.message };
      return this.ask(space, turn, result.choices, result.message, request && !anchor && !result.choices.length ? reference : undefined);
    }
    if (recent.length > 1 && previous) return this.ask(previous.space, turn, recent, ticketChoiceQuestion(previous.space, recent));
    if (request) return { kind: "complete", tickets: result.tickets };
    if (result.tickets.length === 1 && result.tickets[0].status !== "done") {
      return this.ask(space, turn, result.tickets, ticketChoiceQuestion(space, result.tickets));
    }
  }
}
