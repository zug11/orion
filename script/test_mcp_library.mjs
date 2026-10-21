import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const [binary, fixture] = process.argv.slice(2);
assert(binary && fixture, "Provide the exact MCP executable and fixture vault.");
const directory = await mkdtemp("/private/tmp/orion-library-");
const vaultPath = join(directory, "vault.json");
const vault = JSON.parse(await readFile(fixture, "utf8"));
const space = vault.spaces.find((space) => space.workspace.id === vault.activeSpaceId);
const scope = space.workspace.id;
const timestamp = "2026-09-05T00:00:00Z";
const makeNote = (id, title, body) => ({ id, title, body, slug: id, summary: "", kind: "article", status: "ready", aliases: [], tags: ["mcp-contract"], conceptIds: [], sourceIds: [], pinned: false, createdAt: timestamp, updatedAt: timestamp });
const a = makeNote("knowledge-a", "Contract Alpha", "# Overview\né😀 evidence\n## Actions\n- [ ] Read beta\n[Beta](orion-note://knowledge-b)\n");
a.aliases = ["Contract First"]; a.sourceIds = ["knowledge-source"]; a.conceptIds = ["knowledge-concept"];
const b = makeNote("knowledge-b", "Contract Beta", "# Beta\n[Gamma](orion-note://knowledge-c)\n\nA focused search view keeps the answer readable and the evidence close.\n");
b.sourceIds = ["knowledge-source"];
space.notes.push(a, b, makeNote("knowledge-c", "Contract Gamma", "Same substantive body."), makeNote("knowledge-d", "Contract Duplicate", "Same substantive body."));
space.sources.push({ id: "knowledge-source", title: "Contract evidence", kind: "text", text: "é😀 evidence preserved", importedAt: timestamp, noteIds: [a.id, b.id] });
space.concepts.push({ id: "knowledge-concept", label: "Contract Alpha", aliases: ["Contract First"], description: "Test vocabulary", canonicalNoteId: a.id, noteIds: [a.id], autoLink: true });
// Canary data exists only in this isolated fixture; never touch a user's vault.
const completedCanary = "completed-contract-canary";
const childCanary = "completed-detail-canary";
const lazyCanary = "completed-continuation-canary";
const pendingCanary = "fresh-completion-canary";
const visibilityBody = ["# Working contract", "Original Unicode é😀 before tasks.",
  `- [x] ${completedCanary} 🧭`, `  ${childCanary}`, lazyCanary,
  `- [ ] ${pendingCanary} 🧭`, "  Pending task detail.", "",
  "Requirement: preserve this independent prose.", "", "## Exact range",
  "Original scalar range é😀 must remain exact.", "",
  "```markdown", "- [x] A fenced example remains visible.", "```", ""].join("\r\n");
const visibilityNote = makeNote("working-contract", "Working view contract", visibilityBody);
visibilityNote.tags = [];
visibilityNote.summary = `${completedCanary} cached summary`;
visibilityNote.sourceIds = ["working-source"];
space.notes.push(visibilityNote);
space.sources.push({ id: "working-source", title: "Working view source", kind: "text", text: visibilityBody,
  importedAt: timestamp, noteIds: [visibilityNote.id] });
space.spaceOverview = { ...space.spaceOverview, body: `${completedCanary} cached overview`, relatedNoteIds: [visibilityNote.id] };
// Independent inline edits exercise the executable, then feed real output to
// the renderer import/reopen suite. These never touch the user's library.
const inlineCases = [
  { name: "bold apply", body: "A careful thought.", anchor: "careful", mark: "bold", enabled: true, expected: "A **careful** thought.", text: "careful", marks: ["bold"] },
  { name: "italic apply", body: "A careful thought.", anchor: "careful", mark: "italic", enabled: true, expected: "A *careful* thought.", text: "careful", marks: ["italic"] },
  { name: "strike apply", body: "A careful thought.", anchor: "careful", mark: "strike", enabled: true, expected: "A ~~careful~~ thought.", text: "careful", marks: ["strike"] },
  { name: "bold remove", body: "A **careful** thought.", anchor: "**careful**", mark: "bold", enabled: false, expected: "A careful thought.", text: "careful", marks: [] },
  { name: "nested bold remove", body: "A ***careful*** thought.", anchor: "***careful***", mark: "bold", enabled: false, expected: "A *careful* thought.", text: "careful", marks: ["italic"] },
  { name: "nested italic remove", body: "A ***careful*** thought.", anchor: "***careful***", mark: "italic", enabled: false, expected: "A **careful** thought.", text: "careful", marks: ["bold"] },
  { name: "nested strike remove", body: "A ~~**careful**~~ thought.", anchor: "~~**careful**~~", mark: "strike", enabled: false, expected: "A **careful** thought.", text: "careful", marks: ["bold"] },
  { name: "nested apply", body: "A *careful* thought.", anchor: "*careful*", mark: "bold", enabled: true, expected: "A ***careful*** thought.", text: "careful", marks: ["bold", "italic"] },
  { name: "code literal apply", body: "A \\*literal\\* thought.", anchor: "\\*literal\\*", mark: "code", enabled: true, expected: "A `*literal*` thought.", text: "*literal*", marks: ["code"] },
  { name: "code literal remove", body: "A `*literal*` thought.", anchor: "`*literal*`", mark: "code", enabled: false, expected: "A \\*literal\\* thought.", text: "*literal*", marks: [] },
  { name: "backticks in code", body: "A tick ` here.", anchor: "tick ` here", mark: "code", enabled: true, expected: "A ``tick ` here``.", text: "tick ` here", marks: ["code"] },
  { name: "Unicode and entity", body: "A café 🧭 &amp; thought.", anchor: "café 🧭 &amp;", mark: "bold", enabled: true, expected: "A **café 🧭 &amp;** thought.", text: "café 🧭 &", marks: ["bold"] },
  { name: "literal blank spelling", body: "A &amp;nbsp; spelling.", anchor: "&amp;nbsp;", mark: "bold", enabled: true, expected: "A **&amp;nbsp;** spelling.", text: "&nbsp;", marks: ["bold"] },
  { name: "preserved explicit link", body: "A [**Beta**](https://example.com) thought.", anchor: "**Beta**", mark: "bold", enabled: false, expected: "A [Beta](https://example.com) thought.", text: "Beta", marks: ["link"], href: "https://example.com" },
  { name: "unlink formatted note label", body: "Read [**Beta**](orion-note://knowledge-b).", anchor: "[**Beta**](orion-note://knowledge-b)", command: "unlink", expected: "Read **Beta**.", text: "Beta", marks: ["bold"] },
  { name: "unlink formatted web label", body: 'Read [*Beta*](https://example.com "ordinary title").', anchor: '[*Beta*](https://example.com "ordinary title")', command: "unlink", expected: "Read *Beta*.", text: "Beta", marks: ["italic"] },
  { name: "heading in framed prose", body: "<!-- orion-block:v1 -->\r\n\r\n## A careful thought.\r\n\r\n<!-- /orion-block -->", anchor: "careful", mark: "bold", enabled: true, expected: "<!-- orion-block:v1 -->\r\n\r\n## A **careful** thought.\r\n\r\n<!-- /orion-block -->", text: "careful", marks: ["bold"] },
  { name: "reference link guard", body: "Read [label][ref].\n\n[ref]: https://example.com", anchor: "[label][ref]", mark: "code", enabled: true, rejected: true },
  { name: "shortcut link guard", body: "Read [label].\n\n[label]: https://example.com", anchor: "[label]", mark: "code", enabled: true, rejected: true },
  { name: "bare URL guard", body: "Visit https://example.com today.", anchor: "https://example.com", mark: "code", enabled: true, rejected: true },
  { name: "bare email guard", body: "Write name@example.com today.", anchor: "name@example.com", mark: "code", enabled: true, rejected: true },
  { name: "exposed autolink guard", body: "Visit `www.example.com` today.", anchor: "`www.example.com`", mark: "code", enabled: false, rejected: true },
  { name: "source footer guard", body: "Claim [1](orion-source://knowledge-source).\n\n##\t References\n\n1. [Evidence](orion-source://knowledge-source)", anchor: "References", mark: "bold", enabled: true, rejected: true },
  { name: "blank paragraph guard", body: "&nbsp; <!-- orion-text:v1 justify -->", anchor: "&nbsp;", mark: "bold", enabled: true, rejected: true },
  { name: "citation unlink guard", body: "Claim [1](orion-source://knowledge-source).", anchor: "[1](orion-source://knowledge-source)", command: "unlink", rejected: true },
  { name: "partial mark guard", body: "A **careful longer** thought.", anchor: "careful", mark: "bold", enabled: false, rejected: true },
];
inlineCases.push(
  { name: "leading code whitespace", body: "A careful thought.", anchor: " careful", mark: "code", enabled: true, expected: "A` careful` thought.", text: " careful", marks: ["code"] },
  { name: "trailing code whitespace", body: "A careful thought.", anchor: "careful ", mark: "code", enabled: true, expected: "A `careful `thought.", text: "careful ", marks: ["code"] },
  { name: "leading code tab", body: "A\tcareful thought.", anchor: "\tcareful", mark: "code", enabled: true, expected: "A`\tcareful` thought.", text: "\tcareful", marks: ["code"] },
  { name: "trailing code tab", body: "A careful\tthought.", anchor: "careful\t", mark: "code", enabled: true, expected: "A `careful\t`thought.", text: "careful\t", marks: ["code"] },
);
inlineCases.forEach((scenario, index) => {
  scenario.noteId = `inline-contract-${index}`;
  const note = makeNote(scenario.noteId, scenario.name, scenario.body);
  note.tags = [];
  space.notes.push(note);
});
const citationCases = [
  { id: "citation-unicode", body: "A Unicode claim." },
  { id: "citation-autolink", body: "Visit https://example.com?a=1&amp;query=word and name@example.com." },
  { id: "citation-formatted-label", body: "Read [**bold** and *italic* with \\[brackets\\] and \\` tick](orion-source://missing)." },
  { id: "citation-primary", body: "A café 🧭 claim. Another point." },
  { id: "citation-legacy", body: "Year [2024](orion-source://missing).\n\n## References\n\nAn authored essay section." },
  { id: "citation-protected", body: "---\r\nprivate: '[literal](orion-source://hidden)'\r\n---\r\n\r\n<!-- orion-block:v1 -->\r\n\r\nA claim. <!-- orion-paragraph-margins:v1 4 6 -->\r\n\r\n`[code](orion-source://citation-source)`\r\n\r\n~~~md\r\n[example](orion-source://citation-source)\r\n~~~\r\n\r\n<!-- /orion-block -->" },
];
citationCases.forEach(({ id, body }) => space.notes.push({ ...makeNote(id, id, body), tags: [] }));
space.sources.push({ id: "citation-source", title: "Evidence [one] \\ café", kind: "text", text: "Exact original evidence.", importedAt: timestamp, noteIds: [], future: { preserved: true } });
space.sources.push({ id: "citation-second", title: "Second evidence", kind: "text", text: "Another exact source.", importedAt: timestamp, noteIds: [], future: { preserved: [1, 2] } });
space.sources.push({ id: "citation-証拠", title: "\uFEFFUnicode evidence\u0085\uFEFF", kind: "text", text: "Unicode evidence.", importedAt: timestamp, noteIds: [] });
const original = structuredClone(vault);
await writeFile(vaultPath, JSON.stringify(vault));
let sequence = 0, output = "", stderr = "";
const pending = new Map();
const exercised = new Set();
const child = spawn(resolve(binary), ["--vault", vaultPath], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (data) => { stderr += data.toString(); });
child.on("error", (error) => { for (const waiter of pending.values()) waiter.reject(error); });
child.on("exit", (code) => { for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`)); });
child.stdout.on("data", (data) => {
  output += data.toString();
  for (;;) {
    const index = output.indexOf("\n"); if (index < 0) break;
    const line = output.slice(0, index); output = output.slice(index + 1);
    const response = JSON.parse(line); const waiter = pending.get(response.id);
    assert(waiter, "Unexpected protocol output."); pending.delete(response.id); waiter.resolve(response);
  }
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out: ${stderr}`)); }, 10_000);
  pending.set(id, { resolve: (result) => { clearTimeout(timer); resolve(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
let definitions;
const tool = async (name, args = {}, expectError = false) => {
  const response = (await request("tools/call", { name, arguments: args })).result;
  assert.equal(Boolean(response.isError), expectError, `${name}: ${JSON.stringify(response.structuredContent)}`);
  if (!expectError) {
    exercised.add(name);
    const schema = definitions.find((definition) => definition.name === name).outputSchema;
    for (const key of schema.required) assert(Object.hasOwn(response.structuredContent, key), `${name} omitted required output ${key}`);
    assert.equal(response.structuredContent.spaceId, scope);
  }
  return response.structuredContent;
};
const version = async (id) => (await tool("orion_get_notes", { note_ids: [id] })).notes[0].version;
try {
  await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "isolated-library-harness", version: "1" }, capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  definitions = (await request("tools/list")).result.tools;
  assert.equal(definitions.length, 57);
  assert.equal(new Set(definitions.map((tool) => tool.name)).size, 57);
  const sources = await tool("orion_list_sources", { query: "Contract evidence" }); assert.equal(sources.sources[0].id, "knowledge-source");
  const evidence = await tool("orion_search_sources", { query: "evidence", source_ids: ["knowledge-source"] }); assert.equal(evidence.matches[0].matchStart, 3);
  const passage = await tool("orion_get_source_passage", { source_id: "knowledge-source", start: 1, max_chars: 2 }); assert.equal(passage.text, "😀 ");
  const section = await tool("orion_get_note_section", { note_id: a.id, heading: "Actions" }); assert(section.text.includes("Read beta"));
  assert.equal((await tool("orion_get_notes", { note_ids: [a.id, b.id] })).notes.length, 2);
  assert.equal((await tool("orion_list_concepts", { query: "Contract Alpha" })).concepts[0].canonicalNote.id, a.id);
  assert.equal((await tool("orion_get_concept", { concept_id: "knowledge-concept" })).concept.canonicalNote.id, a.id);
  assert.equal((await tool("orion_resolve_link", { phrase: "Contract First" })).destinations[0].id, a.id);
  assert((await tool("orion_get_related_notes", { note_id: a.id })).notes.some((note) => note.id === b.id));
  assert.equal((await tool("orion_get_provenance", { note_id: a.id })).sources[0].id, "knowledge-source");
  assert.equal((await tool("orion_list_tags", { query: "mcp-contract" })).tags[0].noteCount, 4);
  const task = (await tool("orion_list_tasks", { note_id: a.id })).tasks[0]; assert.equal(task.lineIndex, 3);
  assert((await tool("orion_find_duplicate_notes")).groups.some((group) => group.notes.some((note) => note.id === "knowledge-c") && group.notes.some((note) => note.id === "knowledge-d")));
  assert.equal((await tool("orion_check_space_integrity")).mutated, false);
  assert((await tool("orion_get_recent_changes", { since: "2026-09-04T00:00:00Z", limit: 100 })).notes.some((note) => note.id === a.id));
  assert.deepEqual((await tool("orion_get_link_path", { from_note_id: a.id, to_note_id: "knowledge-c" })).path.map((note) => note.id), [a.id, b.id, "knowledge-c"]);
  assert.deepEqual(JSON.parse(await readFile(vaultPath, "utf8")), original, "Read tools changed the library.");
  await tool("orion_get_notes", { note_ids: [a.id, "nonexistent"] }, true);
  await tool("orion_get_source_passage", { space_id: "wrong-space", source_id: "knowledge-source" }, true);
  await tool("orion_get_note_section", { note_id: a.id, heading: "Actions", expected_version: "stale" }, true);
  await tool("orion_list_tasks", { send_to_provider: true }, true);
  await tool("orion_append_to_note", { note_id: a.id, expected_version: task.note.version, text: "Missing Space" }, true);
  // Exercise the packaged process boundary: every call must reread disk, not
  // merely reuse a previously projected in-memory note or cached overview.
  const visibilityRead = async (name, args = {}) => {
    const response = (await request("tools/call", { name, arguments: { space_id: scope, ...args } })).result;
    assert.equal(Boolean(response.isError), false, `${name}: ${JSON.stringify(response.structuredContent)}`);
    const content = response.structuredContent;
    assert.equal(content.spaceId ?? content.space?.id, scope, `${name} crossed its Space`);
    return content;
  };
  for (const name of ["orion_get_note", "orion_get_notes", "orion_get_note_section", "orion_get_source",
    "orion_get_source_passage", "orion_search", "orion_search_sources", "orion_browse_space", "orion_get_space_summary"]) {
    const schema = definitions.find(tool => tool.name === name).inputSchema.properties.task_view;
    assert(schema, `${name} does not advertise the packaged working/history contract`);
    assert.deepEqual(schema.enum, ["working", "history"], `${name} does not advertise explicit task views`);
    assert.equal(schema.default, "working");
  }
  const returnedMaterial = ({ query: _queryEcho, ...material }) => JSON.stringify(material);
  const beforeVisibilityReads = await readFile(vaultPath, "utf8");
  const workingRequests = [
    ["orion_get_note", { note_id: visibilityNote.id }],
    ["orion_get_notes", { note_ids: [visibilityNote.id] }],
    ["orion_get_note_section", { note_id: visibilityNote.id, heading: "Working contract" }],
    ["orion_get_source", { source_id: "working-source" }],
    ["orion_get_source_passage", { source_id: "working-source" }],
    ["orion_browse_space", {}], ["orion_get_space_summary", {}],
    ["orion_search", { query: completedCanary }],
    ["orion_search_sources", { query: completedCanary, source_ids: ["working-source"] }],
  ];
  for (const [name, args] of workingRequests) {
    const projected = await visibilityRead(name, args);
    const encoded = returnedMaterial(projected);
    assert.equal(projected.taskView, "working", `${name} did not default to working`);
    for (const canary of [completedCanary, childCanary, lazyCanary]) {
      assert(!encoded.includes(canary), `${name} exposed completed task text or a cached derivative: ${encoded}`);
    }
  }
  const working = await visibilityRead("orion_get_note", { note_id: visibilityNote.id });
  const explicitWorking = await visibilityRead("orion_get_note", { note_id: visibilityNote.id, task_view: "working" });
  const historical = await visibilityRead("orion_get_note", { note_id: visibilityNote.id, task_view: "history" });
  assert.equal(explicitWorking.note.body, working.note.body);
  assert.equal(historical.note.body, visibilityBody, "History changed original Markdown or line endings");
  assert.equal(historical.taskView, "history");
  assert.equal(working.note.version, historical.note.version, "A projected body received a fabricated write version");
  assert.equal([...working.note.body].length, [...visibilityBody].length, "Working projection changed scalar offsets");
  assert.equal(working.note.body.split("\r\n").length, visibilityBody.split("\r\n").length, "Working projection changed CRLF lines");
  assert(working.note.body.includes("Requirement: preserve this independent prose."));
  assert(working.note.body.includes("- [x] A fenced example remains visible."));
  const explicitSource = await visibilityRead("orion_get_source_passage", { source_id: "working-source", task_view: "history" });
  const workingSource = await visibilityRead("orion_get_source_passage", { source_id: "working-source" });
  assert.equal(explicitSource.text, visibilityBody);
  assert.equal(workingSource.source.version, explicitSource.source.version);
  const rangeText = "Original scalar range é😀 must remain exact.";
  const rangeStart = [...visibilityBody.slice(0, visibilityBody.indexOf(rangeText))].length;
  const scalarSlice = await visibilityRead("orion_get_source_passage", { source_id: "working-source", start: rangeStart, max_chars: [...rangeText].length });
  assert.equal(scalarSlice.offsetUnit, "unicode-scalar");
  assert.equal(scalarSlice.start, rangeStart); assert.equal(scalarSlice.end, rangeStart + [...rangeText].length);
  assert.equal(scalarSlice.text, [...visibilityBody].slice(scalarSlice.start, scalarSlice.end).join(""));
  const exactSection = await visibilityRead("orion_get_note_section", { note_id: visibilityNote.id, heading: "Exact range" });
  assert.equal(exactSection.offsetUnit, "unicode-scalar");
  assert.equal(exactSection.text, [...visibilityBody].slice(exactSection.start, exactSection.end).join(""));
  const visibleTasks = await visibilityRead("orion_list_tasks", { note_id: visibilityNote.id });
  assert.equal(visibleTasks.tasks.length, 1, "Default tasks should contain only the pending task, excluding fenced examples");
  const freshTask = visibleTasks.tasks[0];
  assert.equal(freshTask.lineIndex, 5, "Task line index must refer to the original note");
  assert.equal(freshTask.rawText, `${pendingCanary} 🧭`);
  assert.equal(freshTask.note.version, historical.note.version);
  const completedTasks = await visibilityRead("orion_list_tasks", { note_id: visibilityNote.id, state: "completed" });
  assert.equal(completedTasks.taskView, "history");
  assert.equal(completedTasks.tasks.length, 1);
  assert.equal(completedTasks.tasks[0].lineIndex, 2);
  assert.equal(completedTasks.tasks[0].rawText, `${completedCanary} 🧭`);
  const allTasks = await visibilityRead("orion_list_tasks", { note_id: visibilityNote.id, state: "all" });
  assert.deepEqual(allTasks.tasks.map(task => task.lineIndex), [2, 5]);
  const historicalSearch = await visibilityRead("orion_search", { query: completedCanary, task_view: "history" });
  assert(historicalSearch.results.some(result => JSON.stringify(result).includes(completedCanary)), "Scoped history search did not find the completed task");
  // A history request must not poison the next ordinary working read.
  assert(!(await visibilityRead("orion_get_note", { note_id: visibilityNote.id })).note.body.includes(completedCanary));
  assert.equal(await readFile(vaultPath, "utf8"), beforeVisibilityReads, "Working/history reads changed the stored bytes");
  await tool("orion_update_note", { space_id: scope, note_id: visibilityNote.id, expected_version: historical.note.version, body: working.note.body }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeVisibilityReads, "Filtered whole-note replacement changed the stored bytes");
  await tool("orion_set_task_completion", { space_id: scope, note_id: visibilityNote.id, expected_version: freshTask.note.version,
    line_index: freshTask.lineIndex, expected_text: freshTask.rawText, completed: true });
  const completedVaultBytes = await readFile(vaultPath, "utf8");
  const completedVault = JSON.parse(completedVaultBytes);
  const completedSpace = completedVault.spaces.find(item => item.workspace.id === scope);
  const expectedCompletedBody = visibilityBody.replace(`- [ ] ${pendingCanary}`, `- [x] ${pendingCanary}`);
  assert.equal(completedSpace.notes.find(note => note.id === visibilityNote.id).body, expectedCompletedBody,
    "Completion must change only the selected checkbox marker in the original Markdown");
  assert.deepEqual(completedSpace.notes.filter(note => note.id !== visibilityNote.id), space.notes.filter(note => note.id !== visibilityNote.id));
  assert.deepEqual(completedSpace.sources, space.sources);
  const freshWorking = await visibilityRead("orion_get_note", { note_id: visibilityNote.id });
  assert(!freshWorking.note.body.includes(pendingCanary), "Fresh note read exposed a newly completed task");
  assert(!freshWorking.note.body.includes("Pending task detail"), "Fresh note read exposed a completed task continuation");
  assert(freshWorking.note.body.includes("Requirement: preserve this independent prose."));
  assert.notEqual(freshWorking.note.version, freshTask.note.version);
  assert.equal((await visibilityRead("orion_list_tasks", { note_id: visibilityNote.id })).tasks.length, 0);
  assert.equal((await visibilityRead("orion_list_tasks", { note_id: visibilityNote.id, state: "completed" })).tasks.length, 2);
  const freshHistorical = await visibilityRead("orion_get_note", { note_id: visibilityNote.id, task_view: "history" });
  assert.equal(freshHistorical.note.body, expectedCompletedBody);
  assert.equal(freshHistorical.note.version, freshWorking.note.version);
  for (const [name, args] of [
    ["orion_get_notes", { note_ids: [visibilityNote.id] }],
    ["orion_get_note_section", { note_id: visibilityNote.id, heading: "Working contract" }],
    ["orion_search", { query: pendingCanary, kind: "note" }],
  ]) {
    assert(!returnedMaterial(await visibilityRead(name, args)).includes(pendingCanary), `${name} did not refresh its completed-task projection`);
  }
  await tool("orion_set_task_completion", { space_id: scope, note_id: visibilityNote.id, expected_version: freshTask.note.version,
    line_index: freshTask.lineIndex, expected_text: freshTask.rawText, completed: false }, true);
  assert.equal(await readFile(vaultPath, "utf8"), completedVaultBytes, "Fresh reads or stale completion retry mutated Markdown");

  await tool("orion_set_task_completion", { space_id: scope, note_id: a.id, expected_version: task.note.version, line_index: task.lineIndex, expected_text: task.rawText, completed: true });
  await tool("orion_edit_note_text", { space_id: scope, note_id: a.id, expected_version: await version(a.id), old_text: "é😀 evidence", new_text: "é😀 verified evidence" });
  const append = { space_id: scope, note_id: a.id, expected_version: await version(a.id), text: "\nOne append." };
  await tool("orion_append_to_note", append); await tool("orion_append_to_note", append, true);
  const apply = async (fields, expectError = false) => tool("orion_apply_note_command", {
    space_id: scope, note_id: a.id, expected_version: await version(a.id), ...fields,
  }, expectError);
  const imageAnchor = '![Existing diagram](orion-image://localhost/image_Abc-123456789 "Existing diagram")';
  const block = { space_id: scope, note_id: a.id, expected_version: await version(a.id), command: "block", text: "## Search review\n\nKeep the reading surface calm.\n\n- [ ] Check keyboard navigation\n- [x] Keep citations close\n\n| Area | Decision |\n| --- | --- |\n| **Search** | Ask AI on the right |\n| Answers | A clear reading view |\n\n" + imageAnchor };
  await tool("orion_apply_note_command", block);
  await tool("orion_apply_note_command", block, true);

  const paragraphLayout = { space_id: scope, note_id: a.id, expected_version: await version(a.id), command: "paragraph_format",
    anchor: "Keep the reading surface calm.", alignment: "justify", margin_left: 4, margin_right: 6 };
  await tool("orion_apply_note_command", paragraphLayout);
  const afterParagraphLayout = await readFile(vaultPath, "utf8");
  await tool("orion_apply_note_command", paragraphLayout, true);
  assert.equal(await readFile(vaultPath, "utf8"), afterParagraphLayout, "A stale layout replay rewrote the library.");
  await apply({ command: "document_margins", margin_left: 8, margin_right: 11 });
  await apply({ command: "image_layout", anchor: imageAnchor, layout: {
    placement: "wrap", alignment: "left", widthPercent: 37, xPercent: 24.5, offsetY: 97,
    gap: 18, caption: "A preserved café 🪐 caption", showCaption: true,
  } });
  const currentTableAnchor = async () => {
    const saved = JSON.parse(await readFile(vaultPath, "utf8"));
    const body = saved.spaces.find((entry) => entry.workspace.id === scope).notes.find((entry) => entry.id === a.id).body;
    const lines = body.split("\n");
    const start = lines.findIndex((line) => line.startsWith("<!-- orion-table:v1 ") || line.startsWith("|"));
    assert(start >= 0, "Expected a real table in the executable result");
    let end = start + 1;
    while (end < lines.length && lines[end].trim()) end += 1;
    return lines.slice(start, end).join("\n");
  };
  const tableLayout = { space_id: scope, note_id: a.id, expected_version: await version(a.id), command: "table_layout",
    anchor: await currentTableAnchor(), table_layout: { width: 74, header: true, banded: false, columns: [127, 220] } };
  await tool("orion_apply_note_command", tableLayout);
  const afterTableLayout = await readFile(vaultPath, "utf8");
  await tool("orion_apply_note_command", tableLayout, true);
  assert.equal(await readFile(vaultPath, "utf8"), afterTableLayout, "A stale table-layout retry rewrote the library.");
  const tableStates = [];
  const editTable = async (fields, expectError = false) => apply({ command: "table_edit", anchor: await currentTableAnchor(), ...fields }, expectError);
  await editTable({ operation: "insert_row", row_index: 3, values: ["Temporary *literal*", "Remove explicitly"] });
  await editTable({ operation: "insert_column", column_index: 2, values: ["Extra", "", "", "🪐"] });
  await editTable({ operation: "set_cell", row_index: 3, column_index: 2, text: "An exact café 🧭 cell\nSecond line" });
  assert((await currentTableAnchor()).includes("An exact café 🧭 cell<br>Second line"));
  tableStates.push({ name: "edited cells", markdown: await currentTableAnchor(), rows: 4, columns: 3, header: true, text: "An exact café 🧭 cell" });
  await editTable({ operation: "delete_column", column_index: 2 });
  await editTable({ operation: "delete_row", row_index: 3 });
  await apply({ command: "table_layout", anchor: await currentTableAnchor(), table_layout: { header: false } });
  assert((await currentTableAnchor()).includes("| | |\n| --- | --- |\n| Area | Decision |"));
  await editTable({ operation: "insert_row", row_index: 0 });
  tableStates.push({ name: "headerless blank real row", markdown: await currentTableAnchor(), rows: 4, columns: 2, header: false, firstRowEmpty: true, text: "AreaDecision" });
  await editTable({ operation: "delete_row", row_index: 0 });

  await apply({ command: "table_layout", anchor: await currentTableAnchor(), table_layout: { header: true } });
  await editTable({ operation: "resize", row_count: 4, column_count: 3 });
  await editTable({ operation: "resize", row_count: 3, column_count: 2 });
  const beforeUnsafeResize = await readFile(vaultPath, "utf8");
  await editTable({ operation: "resize", row_count: 1 }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeUnsafeResize, "Unsafe resize removed real table content.");
  await apply({ command: "link", target_note_id: b.id, text: "Supporting note" });
  const externalLink = { space_id: scope, note_id: a.id, expected_version: await version(a.id), command: "link",
    url: "EXAMPLE.com/reference)a?first=1&second=2#source", placement: "replace", anchor: "One append." };
  await tool("orion_apply_note_command", externalLink);
  const afterExternalLink = await readFile(vaultPath, "utf8");
  await tool("orion_apply_note_command", externalLink, true);
  assert.equal(await readFile(vaultPath, "utf8"), afterExternalLink, "A stale external-link replay rewrote the library.");
  await apply({ command: "link", url: "https://例え.jp/文", text: "Read [more] *now*" });
  await apply({ command: "excerpt", target_note_id: b.id, target_expected_version: await version(b.id), text: "A focused search view keeps the answer readable and the evidence close." });
  const beforeInvalidCommand = await readFile(vaultPath, "utf8");
  await apply({ command: "paragraph_format", anchor: "reading surface", margin_left: 4 }, true);
  await apply({ command: "document_margins", margin_left: "8" }, true);
  await apply({ command: "document_margins", margin_left: 8, text: "replacement" }, true);
  await apply({ command: "image_layout", anchor: imageAnchor, layout: { widthPercent: 101 } }, true);

  await apply({ command: "block", placement: "before", anchor: "Keep the reading surface calm.", text: "Must not nest" }, true);
  await apply({ command: "excerpt", target_note_id: b.id, target_expected_version: "stale", text: "A focused search view keeps the answer readable and the evidence close." }, true);
  await apply({ command: "table", rows: [["A", "B"], ["C"]] }, true);
  await apply({ command: "image", image_url: "file:///private.png" }, true);
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "file:///private/note", "//example.com/path",
    "https://user:secret@example.com/", "https://example.com\\@evil.test/", "https://example.com/\npath",
    "https://example.com/path with spaces", "https:example.com", "Project notes", `https://example.com/${"文".repeat(250)}`]) {
    await apply({ command: "link", url, text: "Must not save" }, true);
  }
  await apply({ command: "link", url: "https://example.com", target_note_id: b.id }, true);
  await apply({ command: "link", url: "https://example.com", target_expected_version: await version(b.id) }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeInvalidCommand, "Invalid editor commands wrote to the library.");
  const beforeBatch = await readFile(vaultPath, "utf8");
  await tool("orion_batch_update_metadata", { space_id: scope, notes: [{ note_id: a.id, expected_version: await version(a.id) }, { note_id: b.id, expected_version: "stale" }], tags: ["must-not-save"] }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeBatch);
  await tool("orion_batch_update_metadata", { space_id: scope, notes: [{ note_id: a.id, expected_version: await version(a.id) }, { note_id: b.id, expected_version: await version(b.id) }], tags: ["updated-contract"], pinned: true });
  const inlineStates = [];
  for (const scenario of inlineCases) {
    const before = await readFile(vaultPath, "utf8");
    const args = { space_id: scope, note_id: scenario.noteId, expected_version: await version(scenario.noteId),
      command: scenario.command ?? "inline_format", anchor: scenario.anchor,
      ...(scenario.command ? {} : { mark: scenario.mark, enabled: scenario.enabled }) };
    await tool("orion_apply_note_command", args, Boolean(scenario.rejected));
    const after = await readFile(vaultPath, "utf8");
    if (scenario.rejected) { assert.equal(after, before, `${scenario.name} changed the vault`); continue; }
    const markdown = JSON.parse(after).spaces.find(space => space.workspace.id === scope).notes.find(note => note.id === scenario.noteId).body;
    assert.equal(markdown, scenario.expected, scenario.name);
    inlineStates.push({ name: scenario.name, markdown, text: scenario.text, marks: scenario.marks, ...(scenario.href ? { href: scenario.href } : {}) });
    await tool("orion_apply_note_command", args, true);
    assert.equal(await readFile(vaultPath, "utf8"), after, `${scenario.name} stale replay changed the vault`);
  }
  const citationStates = [];
  const sourceVersion = async (id) => (await tool("orion_list_sources", { space_id: scope, limit: 100 })).sources.find((source) => source.id === id).version;
  const cite = async (noteId, name, fields) => {
    const args = { space_id: scope, note_id: noteId, expected_version: await version(noteId), command: "source_citation", ...fields };
    const oldSourceVersion = fields.citation_action === "insert" ? await sourceVersion(fields.source_id) : undefined;
    if (oldSourceVersion) args.source_expected_version = oldSourceVersion;
    const result = await tool("orion_apply_note_command", args);
    const after = await readFile(vaultPath, "utf8");
    const snapshot = JSON.parse(after).spaces.find(space => space.workspace.id === scope);
    const note = snapshot.notes.find(note => note.id === noteId);
    citationStates.push({ name, markdown: note.body, sourceIds: note.sourceIds });
    if (fields.citation_action === "insert") {
      assert(note.sourceIds.includes(fields.source_id));
      const source = snapshot.sources.find(source => source.id === fields.source_id);
      assert(source.noteIds.includes(noteId));
      assert.equal(result.sourceAttachments[0].source.version, await sourceVersion(source.id));
      if (result.sourceAttachments[0].changed) assert.notEqual(oldSourceVersion, result.sourceAttachments[0].source.version);
    }
    await tool("orion_apply_note_command", args, true);
    assert.equal(await readFile(vaultPath, "utf8"), after, `${name} stale replay wrote data`);
    return note.body;
  };
  await cite("citation-primary", "one citation", { citation_action: "insert", source_id: "citation-source", placement: "after", anchor: "claim" });
  await cite("citation-primary", "repeated source", { citation_action: "insert", source_id: "citation-source", placement: "after", anchor: "point" });
  await cite("citation-primary", "first appearance renumber", { citation_action: "insert", source_id: "citation-second", placement: "before", anchor: "A café" });
  const removed = await cite("citation-primary", "remove one marker", { citation_action: "remove", source_id: "citation-source", anchor: "claim [2](orion-source://citation-source)" });
  assert(removed.includes("claim. Another point [2](orion-source://citation-source)."));
  await cite("citation-primary", "remove first source and renumber", { citation_action: "remove", source_id: "citation-second", anchor: "[1](orion-source://citation-second)" });
  const none = await cite("citation-primary", "remove final marker retains provenance", { citation_action: "remove", source_id: "citation-source", anchor: "[1](orion-source://citation-source)" });
  assert.equal(none, " A café 🧭 claim. Another point.");
  const legacy = await cite("citation-legacy", "authored numeric label and References", { citation_action: "remove", source_id: "missing", anchor: "[2024](orion-source://missing)" });
  assert.equal(legacy, "Year 2024.\n\n## References\n\nAn authored essay section.");
  const label = await cite("citation-formatted-label", "remove authored formatted label", { citation_action: "remove", source_id: "missing", anchor: "[**bold** and *italic* with \\[brackets\\] and \\` tick](orion-source://missing)" });
  assert.equal(label, "Read **bold** and *italic* with \\[brackets\\] and \\` tick.");
  await cite("citation-protected", "protected CRLF and frontmatter", { citation_action: "insert", source_id: "citation-source", placement: "after", anchor: "claim" });
  await cite("citation-unicode", "exact Unicode ID and title whitespace", { citation_action: "insert", source_id: "citation-証拠", placement: "after", anchor: "claim" });
  const invalidCitation = { space_id: scope, note_id: "citation-primary", expected_version: await version("citation-primary"), command: "source_citation", citation_action: "insert", source_id: "citation-source", source_expected_version: "stale" };
  const beforeInvalid = await readFile(vaultPath, "utf8");
  await tool("orion_apply_note_command", invalidCitation, true);
  await tool("orion_apply_note_command", { ...invalidCitation, source_id: "foreign-source" }, true);
  await tool("orion_apply_note_command", { ...invalidCitation, note_id: "citation-autolink", expected_version: await version("citation-autolink"), source_expected_version: await sourceVersion("citation-source"), placement: "after", anchor: "word" }, true);
  await tool("orion_apply_note_command", { ...invalidCitation, source_id: "source&copy;" }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeInvalid);
  const commentBefore = JSON.parse(await readFile(vaultPath, "utf8")).spaces.find(item => item.workspace.id === scope).notes.find(item => item.id === b.id).body;
  const commentArgs = { space_id: scope, note_id: b.id, expected_version: await version(b.id), thread_id: "passage-thread-contract", message_id: "comment-contract", quote: "A focused search view keeps the answer readable and the evidence close.", comment: "Keep this balance in the next paragraph.", proposal: { kind: "addition", text: "An addition awaiting approval." } };
  await tool("orion_propose_passage_comment", commentArgs);
  const discussion = await tool("orion_get_passage_threads", { note_id: b.id, task_view: "history" });
  assert.equal(discussion.threads[0].state, "proposed");
  assert.equal(discussion.threads[0].messages[0].pending, true);
  assert.equal(discussion.threads[0].messages[0].proposal.kind, "addition");
  assert.equal(discussion.threads[0].anchorCurrent, true);
  const commentSaved = await readFile(vaultPath, "utf8");
  assert.equal(JSON.parse(commentSaved).spaces.find(item => item.workspace.id === scope).notes.find(item => item.id === b.id).body, commentBefore);
  await tool("orion_propose_passage_comment", commentArgs, true);
  assert.equal(await readFile(vaultPath, "utf8"), commentSaved);
  const saved = JSON.parse(await readFile(vaultPath, "utf8"));
  assert.deepEqual(saved.spaces.filter((space) => space.workspace.id !== scope), original.spaces.filter((space) => space.workspace.id !== scope));
  const updated = saved.spaces.find((space) => space.workspace.id === scope);
  assert.deepEqual(updated.settings, space.settings); assert.deepEqual(updated.concepts, space.concepts);
  assert.deepEqual(updated.sources, space.sources.map(source => source.id === "citation-source" ? { ...source, noteIds: ["citation-primary", "citation-protected"] } : source.id === "citation-second" ? { ...source, noteIds: ["citation-primary"] } : source.id === "citation-証拠" ? { ...source, noteIds: ["citation-unicode"] } : source));
  assert(updated.notes.find((note) => note.id === a.id).body.includes("- [x] Read beta"));
  assert.equal(updated.notes.find((note) => note.id === a.id).body.match(/One append/g).length, 1);
  const editorNote = updated.notes.find((note) => note.id === a.id);
  assert(editorNote.body.includes("<!-- orion-block:v1 -->"));
  assert(editorNote.body.includes("orion-excerpt:v2:"));
  assert(editorNote.body.includes("[Supporting note](orion-note://knowledge-b)"));
  assert(editorNote.body.includes("[One append\\.](https://example.com/reference%29a?first=1&second=2#source)"));
  assert(editorNote.body.includes("[Read \\[more\\] \\*now\\*](https://xn--r8jz45g.jp/%E6%96%87)"));
  assert.equal(editorNote.body.match(/## Search review/g).length, 1);
  assert(editorNote.body.startsWith("<!-- orion-document-margins:v1 8 11 -->\n\n"));
  assert(editorNote.body.includes("Keep the reading surface calm. <!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 4 6 -->"));
  const tableLayoutResult = editorNote.body.match(/<!-- orion-table:v1 ([^\n]+) -->/)?.[1];
  assert.deepEqual(JSON.parse(tableLayoutResult), { width: 74, header: true, banded: false, columns: [127, 220] });
  const imageTitle = editorNote.body.match(/orion-image-layout:v1:([^"\n]+)/)?.[1];
  assert.deepEqual(JSON.parse(decodeURIComponent(imageTitle)), {
    placement: "wrap", alignment: "left", widthPercent: 37, xPercent: 24.5, offsetY: 97,
    gap: 18, caption: "A preserved café 🪐 caption", showCaption: true, title: "Existing diagram",
  });

  if (process.env.ORION_EDITOR_FIXTURE_OUT) {
    await writeFile(resolve(process.env.ORION_EDITOR_FIXTURE_OUT), JSON.stringify({ spaceId: scope, note: editorNote, sourceNote: updated.notes.find((note) => note.id === b.id), tableStates, inlineStates, citationStates, citationSources: updated.sources.filter(source => source.id.startsWith("citation-")) }, null, 2) + "\n");
  }
  assert.equal(exercised.size, 23, "Not every new tool was exercised against the packaged executable.");
  console.log("All 23 library tools verified against the exact executable: working/history visibility, fresh completion reads, original versions/scalar offsets/line indices, unchanged Markdown, guarded edits, pending passage comments without prose changes, safe external links, portable paragraph/document/image/table layout, structured table edits, inline marks/unlink, source citations and atomic attachments, rejected semantic hazards, atomicity, citations, and Space isolation.");
} finally {
  child.kill();
  await rm(directory, { recursive: true, force: true });
}
