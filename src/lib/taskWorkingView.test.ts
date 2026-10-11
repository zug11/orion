import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { workingTaskText, visibleTaskPassages, requestedTaskView } from "./taskWorkingView";
import { buildAssistantContext } from "./assistant/context";
import { runChatReading } from "./chatReading";
import { spaceNoteVersion } from "./spaceKnowledge";

const body = "# Work\r\n- [x] secret-finished 🧭\r\n  secret-detail\r\n- [ ] Next task\r\n\r\nRequirement: keep backups.\r\n\n```md\n- [x] code example\n```";
function fixture() {
  const snapshot = createEmptySnapshot("Tasks", "2026-10-09", "space-tasks");
  snapshot.notes = [{ id: "n", title: "Work", slug: "work", body, summary: "secret-finished summary", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" }];
  snapshot.spaceOverview = { title: "Overview", body: "secret-finished overview", relatedNoteIds: ["n"], generatedAt: "2026-10-09", stale: false };
  return snapshot;
}
describe("agent working context", () => {
  it("does not turn a request to exclude completed work into history authority", () => {
    for (const prompt of ["Ignore completed tasks", "Don't show finished work", "Work without closed items", "Do not include completed history"]) expect(requestedTaskView(prompt)).toBe("working");
    expect(requestedTaskView("Review the completed tasks for a regression")).toBe("history");
  });
  it("removes checked actions and continuations without shifting original UTF-16 coordinates or changing standalone requirements", () => {
    const masked = workingTaskText(body);
    expect(masked.length).toBe(body.length);
    expect(masked.split("\n").length).toBe(body.split("\n").length);
    expect(masked).not.toContain("secret-");
    expect(masked).toContain("Next task");
    expect(masked).toContain("Requirement: keep backups");
    expect(masked).toContain("- [x] code example");
    for (const passage of visibleTaskPassages(body, [{ start: 0, end: body.length }])) {
      expect(passage.text).toBe(body.slice(passage.start, passage.end));
      expect(passage.text).not.toContain("secret-");
    }
  });
  it("keeps open nested children and frontmatter / fenced examples", () => {
    const value = "---\n- [x] metadata\n---\n- [x] parent\n  - [ ] child\n\nDecision stays.\n~~~\n- [x] example\n~~~";
    expect(workingTaskText(value)).not.toContain("parent");
    for (const text of ["metadata", "child", "Decision stays", "example"]) expect(workingTaskText(value)).toContain(text);
  });
  it("drops stale derivatives before discovery while returning exact evidence, original versions and explicit history", () => {
    const snapshot = fixture();
    const packet = buildAssistantContext(snapshot, { query: "Next task", note_ids: ["n"] });
    expect(JSON.stringify(packet)).not.toContain("secret-");
    expect(packet.evidence[0].version).toBe(spaceNoteVersion(snapshot.notes[0]));
    expect(snapshot.notes[0].body).toBe(body);
    const history = buildAssistantContext(snapshot, { query: "audit", note_ids: ["n"], task_view: "history" });
    expect(JSON.stringify(history)).toContain("secret-finished");
  });
  it("filters adaptive Chat directory and subsequent exact reads before a provider sees them", async () => {
    const snapshot = fixture(); let turn = 0;
    await runChatReading(snapshot, "What is next?", async request => {
      expect(JSON.stringify(request)).not.toContain("secret-");
      if (!turn++) return { reply: "", readRequests: [{ kind: "note", id: "n", query: "Next", start: null }] };
      const packet = JSON.parse(request.readingContext!);
      for (const passage of packet.evidence) expect(passage.text).toBe(body.slice(passage.start, passage.end));
      return { reply: "Next task." };
    });
    expect(turn).toBe(2);
  });
});
