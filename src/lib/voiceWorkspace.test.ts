import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { applyChatTextEdits } from "./chatEdits";
import { boardMarker, noteWork } from "./tickets";
import { refreshVoiceCreation, resolveVoiceWorkspace, voiceWorkspaceRequest } from "./voiceWorkspace";

const now = new Date(2026, 10, 25, 12);
function note(body: string, id = "shoot"): Note {
  return { id, title: id === "shoot" ? "Production" : id, slug: id, body, kind: "article", status: "ready",
    summary: "", tags: [], aliases: [], conceptIds: [], sourceIds: [], createdAt: now.toISOString(), updatedAt: now.toISOString() };
}
const board = { id: "b1", title: "Launch", columns: [{ id: "column-review" as const, title: "Review" }] };
const picked = "[26 November 2026](orion-date://2026-11-26)";
function fixture() {
  const space = createEmptySnapshot("Film", now.toISOString(), "film");
  space.notes = [note(["---\na: 1\n---\n", boardMarker(board), "Camera rental — " + picked,
    "- [ ] Book venue <!-- orion-ticket:v1 venue progress b1 due=2026-11-26 -->\n\n  Send the deposit.",
    "- [x] Old film <!-- orion-ticket:v1 old done - due=2026-11-26 -->", "Costume fitting tomorrow."].join("\n\n"))];
  space.ticketCodes = { version: 1, prefix: "FILM", nextNumber: 2, assigned: { venue: 1 } };
  return space;
}
async function say(text: string, space = fixture(), focusNoteId?: string) {
  const request = voiceWorkspaceRequest(text, space);
  expect(request, text).toBeDefined();
  return resolveVoiceWorkspace(space, request!, { focusNoteId }, now, () => true);
}

describe("spoken work in the current Space", () => {
  it("reads real ticket titles, board status and ticket detail; limits completed work to explicit requests", async () => {
    expect((await say("Which tickets are open?")).message).toContain("Book venue, In progress");
    expect((await say("List tickets on the Launch board")).message).not.toContain("Old film");
    expect((await say("Which tickets are on the Launch board?")).message).toContain("Book venue");
    expect((await say("What tickets are due Thursday?")).message).toContain("Book venue, due 26 Nov");
    expect((await say("What tickets are due Friday?")).message).toContain("no matching tickets");
    expect((await say("What’s due this week?")).message).toContain("Book venue");
    expect((await say("Read completed tickets")).message).toContain("Old film");
    expect((await say("Read ticket Film zero zero one")).message).toContain("Send the deposit.");
  });
  it("reads picked dates, inferred mentions and open deadlines in the requested period", async () => {
    const space = fixture();
    const { message } = await say("What's on my calendar tomorrow?", space);
    expect(message).toContain("Camera rental"); expect(message).toContain("Costume fitting"); expect(message).toContain("ticket due");
    expect(message).not.toContain("Old film");
    expect((await say("Read my calendar next week", space)).message).toContain("no calendar entries");
  });
  it("creates a literal ticket on a named board with its own identity and chosen deadline", async () => {
    const { write } = await say("Could you create a ticket called Hire sound on the Launch board due Friday?");
    expect(write).toMatchObject({ kind: "append", note: { id: "shoot" }, board: { id: "b1" } });
    if (write?.kind !== "append") return;
    expect(noteWork(note(write.markdown)).tickets[0]).toMatchObject({ boardId: "b1", title: "Hire sound", dueDate: "2026-11-27" });
  });
  it("creates dated entries in the captured or named note and offers all-day scheduling for time requests", async () => {
    const { write } = await say("Schedule the rehearsal for Friday", fixture(), "shoot");
    expect(write).toMatchObject({ kind: "append", note: { id: "shoot" }, markdown: "rehearsal — [27 November 2026](orion-date://2026-11-27)" });
    expect((await say("Add an event called Rehearsal on Friday in the Production note")).write).toMatchObject({ kind:"append", note: { id:"shoot" } });
    expect((await say("Put camera handoff on my calendar for Friday")).write).toMatchObject({ kind:"append", newNoteTitle:"Calendar" });
    expect((await say("Schedule camera handoff for Friday at 3pm")).write).toBeUndefined();
    expect((await say("Schedule camera handoff for 2026-02-30")).write).toBeUndefined();
    for (const provider of ["Google", "Outlook", "Apple"]) {
      const external = await say(`Create an event in my ${provider} Calendar for Friday`);
      expect(external.write).toBeUndefined(); expect(external.message).toContain("calendar in this Space");
    }
  });
  it("moves a card to its named board or custom column and reschedules a ticket by spoken code", async () => {
    const space = fixture();
    space.notes.push(note(boardMarker({ id:"b2", title:"Archive" }) + "\n\n- [ ] Travel to Sydney <!-- orion-ticket:v1 travel todo b1 -->", "Wrap"));
    expect((await say("Move the Travel to Sydney ticket to Review in Launch board", space)).write).toMatchObject({ kind:"patchTicket", ticket:{ id:"travel" }, patch:{ status:"column-review", boardId:"b1" } });
    expect((await say("Move the venue ticket to Review", space)).write).toMatchObject({ kind:"patchTicket", patch:{ status:"column-review" } });
    expect((await say("Move Film zero zero one to the Archive board", space)).write).toMatchObject({ kind:"patchTicket", patch:{ boardId:"b2" } });
    expect((await say("Move the venue ticket to in progress", space)).write).toMatchObject({ kind:"patchTicket", patch:{ status:"progress" } });
    expect((await say("Push the venue ticket to Friday", space)).write).toMatchObject({ kind:"patchTicket", patch:{ dueDate:"2026-11-27" } });
  });
  it("moves a picked date by the exact source span, including frontmatter, and asks for ambiguous names", async () => {
    const space = fixture();
    const { write } = await say("Move the camera rental to Friday", space);
    if (write?.kind !== "moveDate") throw Error("expected date move");
    expect(space.notes[0].body.slice(write.from, write.to)).toBe(picked);
    expect(write.replacement).toBe("[27 November 2026](orion-date://2026-11-27)");
    space.notes.push(note("Camera rental — " + picked, "Other"));
    expect((await say("Reschedule camera rental to Friday", space)).write).toBeUndefined();
  });
  it("proposes inferred prose edits for review and refuses ambiguous or nonliteral source wording", async () => {
    const space = fixture();
    const result = await say("Reschedule costume fitting to Friday", space);
    expect(result.write).toBeUndefined(); expect(result.message).toContain("Review");
    const proposal = result.proposal!;
    expect(applyChatTextEdits(proposal.baseBody, proposal.edits)).toBe(space.notes[0].body.replace("tomorrow", "27 November 2026"));
    space.notes[0] = note(space.notes[0].body + "\n\nA separate mention of tomorrow.");
    expect((await say("Reschedule costume fitting to Friday", space)).proposal).toBeUndefined();
    space.notes = [note("Costume fitting tom**orr**ow.")];
    expect((await say("Reschedule costume fitting to Friday", space)).proposal).toBeUndefined();
  });
  it("reuses the note created by a preceding request and keeps explicit destination identities", async () => {
    const captured = fixture(), latest = { ...captured, notes: [...captured.notes, note("First ticket", "Tickets")] };
    const request = voiceWorkspaceRequest("Add a ticket called B", captured)!;
    if (request.kind !== "createTicket") throw Error("expected create");
    const original = await resolveVoiceWorkspace(captured, request, {}, now, () => true);
    expect(original.write).toMatchObject({ kind:"append", newNoteTitle:"Tickets" });
    const refreshed = await refreshVoiceCreation(captured, latest, request, {}, now, original);
    expect(refreshed.write).toMatchObject({ kind:"append", note:{ id:"Tickets", body:"First ticket" } });
    const named = voiceWorkspaceRequest("Add a ticket called B in the Production note", captured)!;
    if (named.kind !== "createTicket") throw Error("expected create");
    const first = await resolveVoiceWorkspace(captured, named, {}, now, () => true);
    const replaced = { ...latest, notes: [{ ...captured.notes[0], id:"replacement" }] };
    expect((await refreshVoiceCreation(captured, replaced, named, {}, now, first)).write).toBeUndefined();
  });
  it("reads a named existing ticket when the user says open ticket", async () => {
    const result = await say("Open ticket Film zero zero one");
    expect(result.message).toContain("Book venue"); expect(result.write).toBeUndefined();
  });
  it("keeps discussion and inferred conditional intentions out of the write path", () => {
    for (const prompt of ["Should we create a ticket for that?", "Maybe move the venue ticket to review", "If we reschedule rehearsal to Friday", "Research whether we should move the venue ticket"]) {
      expect(voiceWorkspaceRequest(prompt, fixture())).toBeUndefined();
    }
  });
});
