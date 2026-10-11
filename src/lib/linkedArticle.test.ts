// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, OrganizeContentResult, Source } from "../types";
import { ensureCanonicalConceptPhrase } from "./concepts";
import {
  applyLinkedArticleResult,
  buildLinkedArticleRequest,
  deleteLinkedArticleDraft,
  isLinkedArticlePlaceholder,
  isLinkedArticleOriginCurrent,
  LinkedArticleRequestRegistry,
  linkedArticleProgressForElapsed,
  linkedArticleStageForProgress,
  waitForLinkedArticle,
  type LinkedArticleJob,
} from "./linkedArticle";
import { workingTaskText } from "./taskWorkingView";
import type { EditorAILinkContext } from "./editorAIWorkingContext";

const NOW = "2026-07-29T01:00:00.000Z";

function makeOrigin(): Note {
  return {
    id: "note-origin",
    title: "Database lecture",
    slug: "database-lecture",
    summary: "A lecture about relational systems.",
    body: "SQL is used to query relational databases in the lecture project.",
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: ["source-lecture"],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("linked article generation", () => {
  function capture(documentMarkdown: string, selectedText = "SQL", touches = false): EditorAILinkContext {
    return { documentMarkdown, workingContext: {
      documentMarkdown: workingTaskText(documentMarkdown), selectedMarkdown: selectedText,
      selectedText, beforeMarkdown: "", afterMarkdown: "", selectionTouchesCompleted: touches,
      caretInsideCompleted: false,
    } };
  }

  it("projects live origin, direct sources and compact organizer derivatives before generation without mutating authored data", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const origin = { ...makeOrigin(), summary: "ORIGIN_SECRET cached summary." };
    const live = `${origin.body}\n\n- [x] ORIGIN_SECRET completed task\n- [ ] Visible next step`;
    snapshot.notes = [origin, { ...makeOrigin(), id: "related", title: "SQL related", summary: "RELATED_SECRET cached summary.",
      body: "SQL visible evidence.\n\n- [x] RELATED_SECRET done" }];
    snapshot.sources = [{ id: "source-lecture", title: "Lecture", kind: "text", importedAt: NOW,
      noteIds: [origin.id], text: "SQL source evidence.\n\n- [x] SOURCE_SECRET closed item" }];
    snapshot.settings.includeExistingNotesInAIContext = true;
    snapshot.relationships = [{ id: "r", fromNoteId: origin.id, toNoteId: "related", kind: "related", strength: 0.8, label: "related", context: "RELATION_SECRET" }];
    const editorContext = capture(live);
    const before = JSON.stringify({ snapshot, editorContext });
    const request = buildLinkedArticleRequest(snapshot, origin, "SQL", "", "SQL", editorContext);
    const wire = JSON.stringify(request);
    for (const secret of ["ORIGIN_SECRET", "RELATED_SECRET", "SOURCE_SECRET", "RELATION_SECRET"]) expect(wire).not.toContain(secret);
    expect(wire).toContain("Visible next step");
    expect(wire).toContain("SQL source evidence");
    expect(wire).toContain("SQL visible evidence");
    expect(JSON.stringify({ snapshot, editorContext })).toBe(before);
  });

  it("rejects partial checked selections even for a manually named article, and only the current instruction can allow history", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const origin = makeOrigin(); snapshot.notes = [origin];
    const live = `${origin.body}\n\n- [x] HIDDEN_SELECTION completed work`;
    const editorContext = capture(live, "HIDDEN_SELECTION", true);
    expect(() => buildLinkedArticleRequest(snapshot, origin, "A manually supplied title", "", "HIDDEN_SELECTION", editorContext)).toThrow(/completed work/);
    const history = buildLinkedArticleRequest(snapshot, origin, "A manually supplied title", "Include completed tasks in this article.", "HIDDEN_SELECTION", editorContext);
    expect(history.content).toContain(live);
    expect(history.content).toContain("Selected context for this link");
    expect(history.content).toContain("HIDDEN_SELECTION");
    expect(() => buildLinkedArticleRequest(snapshot, origin, "Include completed tasks", "", "Include completed tasks", editorContext)).toThrow(/completed work/);
  });

  it("fails closed for raw partial selected context whose completed-task boundary was lost", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const origin = { ...makeOrigin(), body: "- [x] HIDDEN_SELECTION\n- [ ] Visible task" }; snapshot.notes = [origin];
    expect(() => buildLinkedArticleRequest(snapshot, origin, "Named page", "", "HIDDEN_SELECTION")).toThrow(/boundary.*unavailable/);
    expect(buildLinkedArticleRequest(snapshot, origin, "Named page").content).not.toContain("HIDDEN_SELECTION");
  });

  it("reprojects current related knowledge on retry while preserving the captured selection", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const origin = makeOrigin(), editorContext = capture(origin.body);
    const related = { ...makeOrigin(), id: "related", title: "SQL next steps", summary: "NEWLY_COMPLETED task summary", body: "- [ ] NEWLY_COMPLETED" };
    snapshot.notes = [origin, related]; snapshot.settings.includeExistingNotesInAIContext = true;
    expect(JSON.stringify(buildLinkedArticleRequest(snapshot, origin, "SQL", "", "SQL", editorContext))).toContain("NEWLY_COMPLETED");
    const retry = { ...snapshot, notes: [origin, { ...related, body: "- [x] NEWLY_COMPLETED" }] };
    expect(JSON.stringify(buildLinkedArticleRequest(retry, origin, "SQL", "", "SQL", editorContext))).not.toContain("NEWLY_COMPLETED");
    expect(editorContext.documentMarkdown).toBe(origin.body);
  });

  it("allows only its own exact link-mark addition across retries and rejects authored changes or new completion", () => {
    const origin = { ...makeOrigin(), body: "- [ ] Learn SQL today." };
    const binding = { originBody: "Saved earlier draft", editorContext: capture(origin.body), originLinkConceptId: "concept_sql" };
    expect(isLinkedArticleOriginCurrent(origin, binding)).toBe(true);
    expect(isLinkedArticleOriginCurrent({ ...origin, body: "- [ ] Learn [SQL](orion-concept://concept_sql) today." }, binding)).toBe(true);
    for (const body of ["- [x] Learn [SQL](orion-concept://concept_sql) today.", "- [ ] Learn [SQL](orion-concept://another) today.",
      "- [ ] Learn **[SQL](orion-concept://concept_sql)** today.", "- [ ] Learn [SQL](orion-concept://concept_sql) tomorrow."]) {
      expect(isLinkedArticleOriginCurrent({ ...origin, body }, binding)).toBe(false);
    }
    expect(isLinkedArticleOriginCurrent({ ...origin, body: "!SQL" }, { ...binding, originBody: "![SQL](orion-concept://concept_sql)", editorContext: undefined })).toBe(false);
  });

  it("uses the exact host link receipt for a contextual inserted paragraph without accepting later prose or checkbox changes", () => {
    const origin = { ...makeOrigin(), body: "First passage.\n\n- [ ] A second passage." };
    const linkedDocument: { body?: string } = {};
    const binding = { originBody: origin.body, editorContext: capture(origin.body), linkedDocument };
    const linked = "[SQL](orion-concept://concept_sql)\n\n" + origin.body;
    expect(isLinkedArticleOriginCurrent({ ...origin, body: linked }, binding)).toBe(false);
    // RichNoteEditor records this only after its own successful transaction.
    linkedDocument.body = linked;
    expect(isLinkedArticleOriginCurrent({ ...origin, body: linked }, binding)).toBe(true);
    expect(isLinkedArticleOriginCurrent({ ...origin, body: linked.replace("[ ]", "[x]") }, binding)).toBe(false);
    expect(isLinkedArticleOriginCurrent({ ...origin, body: linked + "\n\nNew prose." }, binding)).toBe(false);
    expect(isLinkedArticleOriginCurrent({ ...origin, body: linked.replace("concept_sql", "concept_other") }, binding)).toBe(false);
  });

  it("grounds the AI request in the origin note, direct source, and Space", () => {
    const snapshot = createEmptySnapshot(
      "Data systems",
      NOW,
      "space-data",
    );
    const origin = makeOrigin();
    const source: Source = {
      id: "source-lecture",
      title: "Week 3 recording",
      kind: "audio",
      importedAt: NOW,
      text: "The lecturer contrasts declarative SQL with procedural code.",
      noteIds: [origin.id],
    };
    snapshot.notes = [origin];
    snapshot.sources = [source];
    snapshot.settings.organizationInstructions = "Keep the tone academic.";

    const request = buildLinkedArticleRequest(
      snapshot,
      origin,
      "SQL",
      "Focus on joins and relational algebra.",
      "SELECT users.id FROM users WHERE users.active = true;",
    );

    expect(request.spaceName).toBe("Data systems");
    expect(request.sourceName).toBe("Link created in Database lecture");
    expect(request.content).toContain(origin.body);
    expect(request.content).toContain(source.text);
    expect(request.content).toContain(
      "Selected context for this link",
    );
    expect(request.content).toContain(
      "SELECT users.id FROM users WHERE users.active = true;",
    );
    expect(request.taskInstructions).toContain(
      "exactly one canonical wiki article titled “SQL”",
    );
    expect(request.organizationInstructions).toContain(
      "Keep the tone academic.",
    );
    expect(request.taskInstructions).toContain(
      "Focus on joins and relational algebra.",
    );
    expect(request.timeoutMs).toBe(240_000);
  });

  it("uses relevant compact Space records without leaking existing article bodies", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const origin = makeOrigin();
    const sql: Note = {
      ...makeOrigin(),
      id: "note-sql-existing",
      title: "SQL",
      summary: "A canonical article about relational queries and joins.",
      body: "A long, carefully edited SQL article that must not be dumped.",
      kind: "wiki",
      sourceIds: [],
    };
    snapshot.notes = [
      origin,
      sql,
      ...Array.from({ length: 80 }, (_, index): Note => ({
        ...makeOrigin(),
        id: `note-unrelated-${index}`,
        title: `Ceramics ${index}`,
        summary: "Glaze and pigment experiments.",
        body: "Unrelated pottery notes.",
        sourceIds: [],
      })),
    ];

    const request = buildLinkedArticleRequest(snapshot, origin, "SQL");

    expect(request.existingNotes?.map(({ id }) => id)).toEqual([sql.id]);
    expect(request.existingNotes?.[0].semanticSketch).toContain(
      "carefully edited SQL article",
    );
    expect(request.existingNotes?.[0]).not.toHaveProperty("body");
  });

  it("turns the matching returned wiki article into a rich canonical page", () => {
    const placeholder: Note = {
      ...makeOrigin(),
      id: "note-sql",
      title: "SQL",
      slug: "sql",
      summary: "A Space article for SQL.",
      body: "",
      kind: "wiki",
      tags: ["wiki-article", "orion-link-draft"],
    };
    const result: OrganizeContentResult = {
      notes: [],
      wikiArticles: [
        {
          title: "SQL",
          summary: "A language for working with relational data.",
          body:
            "## Overview\n\nSQL is a declarative language for relational databases. In this Space it anchors the database lecture.\n\n## Limits\n\nThe lecture does not cover vendor extensions.",
          overview: "SQL is a declarative language for relational databases.",
          spaceRelevance: "It is central to the database lecture.",
          sourceGroundedDetails: [
            "The lecture contrasts SQL with procedural code.",
          ],
          uncertainties: ["The lecture does not cover vendor extensions."],
          tags: ["databases"],
          aliases: ["Structured Query Language"],
          links: [],
        },
      ],
      concepts: [],
      suggestedConnections: [],
    };

    const article = applyLinkedArticleResult(
      placeholder,
      result,
      "SQL",
      "Data systems",
      "2026-07-29T01:05:00.000Z",
    );

    expect(article.summary).toBe(
      "A language for working with relational data.",
    );
    expect(article.body).toContain("## Overview");
    expect(article.body).toContain("anchors the database lecture");
    expect(article.body).not.toContain("From the linked source");
    expect(article.aliases).toContain("Structured Query Language");
    expect(article.tags).not.toContain("orion-link-draft");
    expect(article.tags).not.toContain("ai-draft");
    expect(article.status).toBe("ready");
  });

  it("recognizes both current and legacy empty link placeholders", () => {
    const placeholder = {
      ...makeOrigin(),
      title: "SQL",
      body: "",
      summary: "A Space article for SQL.",
    };

    expect(isLinkedArticlePlaceholder(placeholder, "SQL")).toBe(true);
    expect(
      isLinkedArticlePlaceholder(
        { ...placeholder, kind: "wiki", summary: "" },
        "SQL",
      ),
    ).toBe(true);
    expect(
      isLinkedArticlePlaceholder(
        { ...placeholder, body: "A human-authored explanation." },
        "SQL",
      ),
    ).toBe(false);
    expect(
      isLinkedArticlePlaceholder(
        {
          ...placeholder,
          body: [
            "<!-- orion-link-pending -->",
            "> Orion is writing this article from “Database lecture”, its sources, and the active Space.",
          ].join("\n\n"),
          tags: ["orion-link-pending"],
          status: "ready",
        },
        "SQL",
      ),
    ).toBe(true);
    expect(
      isLinkedArticlePlaceholder(
        {
          ...placeholder,
          body: [
            "<!-- orion-link-draft -->",
            "> Orion is drafting this article from “Database lecture”, its sources, and the active Space.",
          ].join("\n\n"),
          tags: ["wiki-article", "orion-link-draft"],
        },
        "SQL",
      ),
    ).toBe(true);
    expect(
      isLinkedArticlePlaceholder(
        {
          ...placeholder,
          body:
            '> Orion is drafting this article from "Database lecture", its sources, and the active Space.',
          tags: ["wiki-article", "orion-link-draft"],
          summary: "Orion is preparing a Space article for SQL.",
        },
        "SQL",
      ),
    ).toBe(true);
    expect(
      isLinkedArticlePlaceholder(
        {
          ...placeholder,
          body: "A human-authored explanation.",
          tags: ["wiki-article", "orion-link-draft"],
        },
        "SQL",
      ),
    ).toBe(false);
  });

  it("keeps a restarted request owned when an older attempt finishes late", () => {
    const registry = new LinkedArticleRequestRegistry();
    const requestKey = "space-data:note-sql";

    expect(registry.begin(requestKey, "attempt-one")).toBe(true);
    registry.cancel(requestKey);
    expect(registry.begin(requestKey, "attempt-two")).toBe(true);

    registry.finish(requestKey, "attempt-one");

    expect(registry.owns(requestKey, "attempt-two")).toBe(true);
    registry.finish(requestKey, "attempt-two");
    expect(registry.has(requestKey)).toBe(false);
  });

  it("maps bounded progress to meaningful phases", () => {
    expect(linkedArticleStageForProgress(12)).toBe("gathering");
    expect(linkedArticleStageForProgress(38)).toBe("reading");
    expect(linkedArticleStageForProgress(70)).toBe("writing");
    expect(linkedArticleStageForProgress(90)).toBe("linking");
    expect(linkedArticleStageForProgress(100)).toBe("complete");
  });

  it("moves pending progress across the full request budget", () => {
    expect(linkedArticleProgressForElapsed(0, 90_000)).toBe(12);
    expect(linkedArticleProgressForElapsed(45_000, 90_000)).toBe(53);
    expect(linkedArticleProgressForElapsed(90_000, 90_000)).toBe(94);
    expect(linkedArticleProgressForElapsed(180_000, 90_000)).toBe(94);
  });

  it("pauses a request that does not respond so it can be restarted", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<never>(() => undefined);
      const result = waitForLinkedArticle(pending, 1_000);
      const rejection = expect(result).rejects.toThrow(
        /paused this article after 1 seconds/i,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts its watchdog only when the queued provider request starts", async () => {
    vi.useFakeTimers();
    try {
      let markProviderStarted: () => void = () => undefined;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      const pending = new Promise<never>(() => undefined);
      const result = waitForLinkedArticle(pending, 1_000, providerStarted);
      let rejected = false;
      void result.catch(() => {
        rejected = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(rejected).toBe(false);

      markProviderStarted();
      await vi.advanceTimersByTimeAsync(999);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).rejects.toThrow(/paused this article after 1 second/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a paused article and its now-orphaned link vocabulary", () => {
    const snapshot = createEmptySnapshot(
      "Data systems",
      NOW,
      "space-data",
    );
    const origin = makeOrigin();
    const placeholder: Note = {
      ...makeOrigin(),
      id: "note-sql",
      title: "SQL",
      slug: "sql",
      summary: "Orion is preparing a Space article for SQL.",
      body: [
        "<!-- orion-link-draft -->",
        "> Orion is drafting this article from “Database lecture”, its sources, and the active Space.",
      ].join("\n\n"),
      kind: "wiki",
      tags: ["wiki-article", "orion-link-draft"],
      conceptIds: ["concept-sql"],
    };
    snapshot.notes = [origin, placeholder];
    snapshot.sources = [
      {
        id: "source-lecture",
        title: "Week 3 recording",
        kind: "audio",
        importedAt: NOW,
        text: "SQL is discussed.",
        noteIds: [origin.id, placeholder.id],
      },
    ];
    snapshot.concepts = [
      {
        id: "concept-sql",
        label: "SQL",
        aliases: ["Structured Query Language"],
        description: "A reusable SQL link.",
        noteIds: [placeholder.id],
        canonicalNoteId: placeholder.id,
        color: "#8798ff",
        autoLink: true,
      },
    ];
    snapshot.relationships = [
      {
        id: "relationship-sql",
        fromNoteId: origin.id,
        toNoteId: placeholder.id,
        kind: "mentions",
        label: "mentions",
        strength: 0.8,
        conceptId: "concept-sql",
      },
    ];
    snapshot.activeNoteId = placeholder.id;
    const job: LinkedArticleJob = {
      id: "job-sql",
      workspaceId: snapshot.workspace.id,
      noteId: placeholder.id,
      originNoteId: origin.id,
      title: "SQL",
      originTitle: origin.title,
      progress: 72,
      stage: "error",
      error: "OpenAI did not respond.",
    };

    const deleted = deleteLinkedArticleDraft(
      snapshot,
      job,
      "2026-07-29T01:05:00.000Z",
    );

    expect(deleted.deleted).toBe(true);
    expect(deleted.snapshot.notes.map((note) => note.id)).toEqual([
      origin.id,
    ]);
    expect(
      deleted.snapshot.concepts.some(
        (concept) => concept.id === "concept-sql",
      ),
    ).toBe(false);
    expect(deleted.snapshot.relationships).toEqual([]);
    expect(deleted.snapshot.sources[0]?.noteIds).toEqual([origin.id]);
    expect(deleted.snapshot.activeNoteId).toBe(origin.id);
  });

  it("can queue the same phrase again after its paused page is deleted", () => {
    const snapshot = createEmptySnapshot(
      "Data systems",
      NOW,
      "space-data",
    );
    const origin = makeOrigin();
    const placeholder: Note = {
      ...makeOrigin(),
      id: "note-sql-old",
      title: "SQL",
      slug: "sql",
      summary: "Orion is preparing a Space article for SQL.",
      body:
        '> Orion is drafting this article from "Database lecture", its sources, and the active Space.',
      kind: "wiki",
      tags: ["wiki-article", "orion-link-draft"],
      conceptIds: ["concept-sql"],
    };
    snapshot.notes = [origin, placeholder];
    snapshot.concepts = [
      {
        id: "concept-sql",
        label: "SQL",
        aliases: [],
        description: "A reusable SQL link.",
        noteIds: [placeholder.id],
        canonicalNoteId: placeholder.id,
        color: "#8798ff",
        autoLink: true,
      },
    ];
    const job: LinkedArticleJob = {
      id: "job-sql",
      workspaceId: snapshot.workspace.id,
      noteId: placeholder.id,
      originNoteId: origin.id,
      title: "SQL",
      originTitle: origin.title,
      progress: 72,
      stage: "error",
    };

    const deleted = deleteLinkedArticleDraft(snapshot, job, NOW);
    const replacement: Note = {
      ...placeholder,
      id: "note-sql-new",
      conceptIds: [],
    };
    const relinked = ensureCanonicalConceptPhrase(
      deleted.snapshot.notes,
      deleted.snapshot.concepts,
      { phrase: "SQL", candidateArticle: replacement },
    );
    const concept = relinked.concepts.find(
      (candidate) => candidate.id === relinked.conceptId,
    );
    const article = relinked.notes.find(
      (candidate) => candidate.id === concept?.canonicalNoteId,
    );

    expect(article?.id).toBe(replacement.id);
    expect(isLinkedArticlePlaceholder(article!, "SQL")).toBe(true);
  });
});
