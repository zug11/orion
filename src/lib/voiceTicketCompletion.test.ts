import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { completeVoiceTickets, resolveVoiceTickets, suggestSpokenTickets, voiceTicketCompletionReference } from "./voiceTicketCompletion";
import { VoiceTicketDialogue } from "./voiceTicketDialogue";
import { patchTicket, type Ticket } from "./tickets";

const line = "- [ ] Book the venue <!-- orion-ticket:v1 venue progress launch due=2026-12-01 urgency=high -->";
const note = (id: string, body: string): Note => ({ id, title: id, slug: id, body, summary: "", kind: "article", status: "ready",
  sourceIds: [], tags: [], aliases: [], conceptIds: [], createdAt: "2026-11-19", updatedAt: "2026-11-19" });
function fixture() {
  const space = createEmptySnapshot("Film", "2026-11-19", "film");
  space.notes = [note("production", [line, "  - [ ] Read the contract", "- [ ] Mix and master <!-- orion-ticket:v1 audio todo launch -->",
    "- [x] Buy tape <!-- orion-ticket:v1 tape done - -->", "- [ ] Buy batteries"].join("\n"))];
  space.ticketCodes = { version: 1, prefix: "FILM", nextNumber: 45, assigned: { venue: 7, audio: 42, tape: 44 }, assignedPrefixes: { venue: "ORION" } };
  return space;
}

describe("spoken ticket completion", () => {
  it.each([
    ["Could you please move ORION-007 to Done?", "ORION-007"],
    ["Orion, mark the Book the venue ticket as completed, please.", "the Book the venue ticket"],
    ["Put this ticket in the Done column", "this ticket"],
    ["Complete ticket FILM-042.", "ticket FILM-042"],
    ["Okay, could you just tick the venue one off for me?", "the venue one"],
    ["Let's cross that off the list.", "that"],
    ["Can we close out the audio ticket?", "the audio ticket"],
    ["You can take the venue one off my plate.", "the venue one"],
    ["Can you mark the venue one as resolved?", "the venue one"],
    ["Please mark that off.", "that"],
  ])("takes the literal reference from %s", (prompt, reference) => {
    expect(voiceTicketCompletionReference(prompt)).toBe(reference);
  });
  it.each(["Should I mark ORION-007 done?", "Don’t move ORION-007 to Done.", "I moved ORION-007 to Done.",
    "Tell me how to move this ticket to done.", "If I say mark it done, what happens?", "Mark it done if the producer signs.",
    "Write a note saying “mark ORION-007 done”.", "Complete this sentence.", "We should check on the venue."])("never authorizes %s", prompt => {
    expect(voiceTicketCompletionReference(prompt)).toBeUndefined();
  });
  it("recognizes acknowledged prefixes, spoken numbers, and a full title containing 'and'", () => {
    const space = fixture();
    for (const name of ["Orion seven", "ticket Orion oh oh seven", "ORION-7", "ticket number seven", "#7", "the Book the venue ticket"]) {
      expect(resolveVoiceTickets(space, name)).toMatchObject({ tickets: [{ id: "venue" }] });
    }
    expect(resolveVoiceTickets(space, "film forty-two")).toMatchObject({ tickets: [{ id: "audio" }] });
    expect(resolveVoiceTickets(space, "Mix and master")).toMatchObject({ tickets: [{ id: "audio" }] });
    expect(resolveVoiceTickets(space, "FILM-007")).toHaveProperty("message");
    expect(resolveVoiceTickets(space, "Buy batteries")).toHaveProperty("message");
    space.ticketCodes!.assigned.audio = 142;
    space.ticketCodes!.nextNumber = 143;
    expect(resolveVoiceTickets(space, "film one hundred and forty two")).toMatchObject({ tickets: [{ id: "audio" }] });
  });
  it("resolves a whole group before applying, preserves children and metadata, and verifies the saved tickets", async () => {
    const space = fixture();
    const apply = vi.fn((ticket: Ticket) => {
      const body = patchTicket(space.notes[0].body, ticket, { status: "done" });
      if (body === null) return false;
      space.notes = [{ ...space.notes[0], body }]; return true;
    });
    const confirm = vi.fn().mockResolvedValue(undefined);
    const finish = (reference: string) => {
      const result = resolveVoiceTickets(space, reference);
      return "message" in result ? result.message : completeVoiceTickets(space, result.tickets, apply, confirm);
    };
    expect(await finish("ORION-007 and missing")).toMatch(/which ticket/i);
    expect(apply).not.toHaveBeenCalled();
    expect(await finish("ORION-007, FILM-042 and FILM-044")).toBe("Moved ORION-007, FILM-042 to Done. FILM-044 is already Done.");
    expect(space.notes[0].body).toContain("- [x] Book the venue <!-- orion-ticket:v1 venue done launch due=2026-12-01 urgency=high -->\n  - [ ] Read the contract");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[0][0].map((ticket: Ticket) => ticket.id)).toEqual(["venue", "audio", "tape"]);
    confirm.mockRejectedValueOnce(new Error("offline"));
    await expect(finish("ORION-007")).rejects.toThrow("offline");
    expect(apply).toHaveBeenCalledTimes(2);
  });
  it("requires an unambiguous ticket identity including hidden duplicate markers", () => {
    const space = fixture();
    space.notes.push(note("backup", line.replace("venue progress", "backup todo")));
    expect(resolveVoiceTickets(space, "Book the venue")).toHaveProperty("message");
    expect(resolveVoiceTickets(space, "this ticket", "venue")).toMatchObject({ tickets: [{ id: "venue" }] });
    expect(resolveVoiceTickets(space, "this ticket")).toHaveProperty("message");
    space.notes.push(note("broken", "- [ ] <!-- orion-ticket:v1 venue todo - -->"));
    expect(resolveVoiceTickets(space, "ORION-007")).toHaveProperty("message");
  });
  it("rechecks the description and checklist for every named ticket before moving the group", async () => {
    const space = fixture(), apply = vi.fn(() => true), confirm = vi.fn();
    const result = resolveVoiceTickets(space, "FILM-042 and ORION-007");
    if (!("tickets" in result)) throw new Error("Missing test tickets");
    const original = space.notes[0];
    for (const detail of ["  Read the revised contract.\n", "  - [ ] Get approval from the producer\n"]) {
      space.notes = [{ ...original, body: original.body.replace("  - [ ] Read the contract", detail + "  - [ ] Read the contract") }];
      expect(await completeVoiceTickets(space, result.tickets, apply, confirm)).toMatch(/changed/);
      expect(apply).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    }
    space.notes = [{ ...original, body: "New unrelated paragraph.\n\n" + original.body }];
    expect(await completeVoiceTickets(space, result.tickets, apply, confirm)).toBe("Moved FILM-042, ORION-007 to Done.");
  });
});

describe("less specific spoken requests", () => {
  const turn = (key: number, prompt: string, focusedTicketId?: string) => ({ key, prompt, focusedTicketId });
  it("applies a unique short title and uses the preceding human topic for a pronoun", () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    expect(dialogue.interpret(space, turn(1, "Tick the venue one off."))).toMatchObject({ kind: "complete", tickets: [{ id: "venue" }] });
    expect(dialogue.interpret(space, turn(2, "Can we talk about the venue ticket?"))).toBeUndefined();
    expect(dialogue.interpret(space, turn(3, "Check that one off please."))).toMatchObject({ kind: "complete", tickets: [{ id: "venue" }] });
    dialogue.interpret(space, turn(4, "Can we talk about the venue ticket?"));
    expect(dialogue.interpret(space, turn(5, "Tick that off.", "audio"))).toMatchObject({ kind: "complete", tickets: [{ id: "audio" }] });
    dialogue.interpret(space, turn(6, "What's the weather today?"));
    expect(dialogue.interpret(space, turn(7, "Check it off."))).toMatchObject({ kind: "ask", question: { choices: [] } });
    dialogue.reset();
    expect(dialogue.interpret(space, turn(8, "Close that."))).toBeUndefined();
    expect(dialogue.interpret(space, turn(9, "Close that.", "venue"))).toMatchObject({ kind: "complete", tickets: [{ id: "venue" }] });
  });
  it("offers to record a progress report and waits for a fresh human answer", () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    const prompt = "I've just finished booking the venue.";
    expect(dialogue.interpret(space, turn(1, prompt))).toMatchObject({ kind: "ask", question: { choices: [{ id: "venue" }] } });
    dialogue.question!.after = 2;
    expect(dialogue.interpret(space, turn(2, "yes"))).toEqual({ kind: "ignore" });
    dialogue.interpret(space, turn(3, prompt)); dialogue.question!.after = 3;
    expect(dialogue.interpret(space, turn(4, "yes please"))).toMatchObject({ kind: "complete", tickets: [{ id: "venue" }] });
    expect(dialogue.interpret(space, turn(5, "yes"))).toBeUndefined();
    for (const phrase of ["I'm done for today.", "I haven't finished booking the venue.", "What if the venue is done?", "The venue is almost done."]) {
      expect(dialogue.interpret(space, turn(6, phrase, "venue"))).toBeUndefined();
    }
    dialogue.interpret(space, turn(7, "That one's all sorted.", "venue")); dialogue.question!.after = 7;
    expect(dialogue.interpret(space, turn(8, "Not yet", "venue"))).toMatchObject({ kind: "notice" });
    expect(dialogue.interpret(space, turn(9, "yes", "venue"))).toBeUndefined();
  });
  it("asks which ticket a pronoun refers to when the previous turn named two", () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    dialogue.interpret(space, turn(1, "Can we compare ORION-007 and FILM-042?"));
    expect(dialogue.interpret(space, turn(2, "Tick that one off."))).toMatchObject({
      kind: "ask", question: { choices: [{ id: "venue" }, { id: "audio" }] },
    });
  });
  it("honours an explicitly open or previously discussed card when the two differ", () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    dialogue.interpret(space, turn(1, "Can we talk about the venue ticket?", "audio"));
    expect(dialogue.interpret(space, turn(2, "Tick the one we were just talking about off.", "audio"))).toMatchObject({ kind: "complete", tickets: [{ id: "venue" }] });
    dialogue.interpret(space, turn(3, "Can we talk about the venue ticket?"));
    expect(dialogue.interpret(space, turn(4, "Mark the open ticket done."))).toMatchObject({ kind: "ask", question: { choices: [] } });
  });
  it.each(["the deposit one", "the second one", "ticket FILM-043", "Yeah, the deposit one, please.", "Go with the second one."])("answers a choice with %s and never infers a write from a bare yes to several choices", reply => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    space.notes.push(note("finance", "- [ ] Pay the venue deposit <!-- orion-ticket:v1 deposit todo launch -->"));
    space.ticketCodes!.assigned.deposit = 43;
    expect(dialogue.interpret(space, turn(1, "Cross the venue one off."))).toMatchObject({
      kind: "ask", question: { message: expect.stringContaining("Pay the venue deposit"), choices: [{ id: "venue" }, { id: "deposit" }] },
    });
    dialogue.question!.after = 1;
    expect(dialogue.interpret(space, turn(2, "Yes"))).toMatchObject({ kind: "ask" }); dialogue.question!.after = 2;
    expect(dialogue.interpret(space, turn(3, reply))).toMatchObject({ kind: "complete", tickets: [{ id: "deposit" }] });
  });
  it("rechecks captured cards and drops unanswered questions on a new topic, view, call or Space", async () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue(), apply = vi.fn(), confirm = vi.fn();
    dialogue.interpret(space, turn(1, "The venue is all sorted.")); dialogue.question!.after = 1;
    space.notes = [note("production", space.notes[0].body.replace("Book the venue", "Cancel the booking"))];
    const reply = dialogue.interpret(space, turn(2, "go ahead"));
    if (reply?.kind !== "complete") throw new Error("Missing captured ticket");
    expect(await completeVoiceTickets(space, reply.tickets, apply, confirm)).toMatch(/changed/);
    expect(apply).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
    dialogue.interpret(space, turn(3, "That one's done.", "audio")); dialogue.question!.after = 3;
    expect(dialogue.interpret(space, turn(4, "yes", "venue"))).toBeUndefined();
    dialogue.interpret(space, turn(5, "That's done.", "audio")); dialogue.question!.after = 5;
    dialogue.interpret(space, turn(6, "Let's talk about something else.", "audio"));
    expect(dialogue.interpret(space, turn(7, "yes", "audio"))).toBeUndefined();
    dialogue.interpret(space, turn(8, "That's done.", "audio")); dialogue.question!.after = 8;
    dialogue.reset(); expect(dialogue.interpret(space, turn(9, "yes", "audio"))).toBeUndefined();
    dialogue.interpret(space, turn(10, "That's done.", "audio")); dialogue.question!.after = 10;
    expect(dialogue.interpret(createEmptySnapshot("Other", "", "other"), turn(11, "yes", "audio"))).toBeUndefined();
  });
  it("names the tentative choice before accepting it", () => {
    const space = fixture(), dialogue = new VoiceTicketDialogue();
    space.notes.push(note("finance", "- [ ] Pay the venue deposit <!-- orion-ticket:v1 deposit todo launch -->"));
    dialogue.interpret(space, turn(1, "Tick the venue one off.")); dialogue.question!.after = 1;
    expect(dialogue.interpret(space, turn(2, "The second one?"))).toMatchObject({
      kind: "ask", question: { message: "Should I mark “Pay the venue deposit” as Done?" },
    });
    dialogue.question!.after = 2;
    expect(dialogue.interpret(space, turn(3, "That's the one."))).toMatchObject({ kind: "complete", tickets: [{ id: "deposit" }] });
  });
  it("shows only supplied open titles to the semantic matcher and accepts only valid offered positions", async () => {
    const space = fixture(), signal = new AbortController().signal;
    const driver = vi.fn().mockResolvedValue({ reply: '{"matches":[1]}' });
    expect(await suggestSpokenTickets(space, "the rehearsal space rental", driver, signal)).toMatchObject([{ id: "venue" }]);
    const [request] = driver.mock.calls[0];
    expect(request).toMatchObject({ allowNoteActions: false, history: [], notes: [], sources: [], concepts: [] });
    expect(request.prompt).toContain("Book the venue");
    for (const withheld of ["Buy tape", "Buy batteries", "Read the contract", "orion-ticket:"]) expect(request.prompt).not.toContain(withheld);
    for (const reply of ['{"matches":[9]}', '{"matches":[1,1]}', '{"matches":[1],"status":"done"}', "not JSON"]) {
      driver.mockResolvedValueOnce({ reply });
      expect(await suggestSpokenTickets(space, "the rehearsal space rental", driver, signal)).toEqual([]);
    }
  });
});
