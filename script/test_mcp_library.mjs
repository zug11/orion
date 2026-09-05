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
const b = makeNote("knowledge-b", "Contract Beta", "# Beta\n[Gamma](orion-note://knowledge-c)\n");
b.sourceIds = ["knowledge-source"];
space.notes.push(a, b, makeNote("knowledge-c", "Contract Gamma", "Same substantive body."), makeNote("knowledge-d", "Contract Duplicate", "Same substantive body."));
space.sources.push({ id: "knowledge-source", title: "Contract evidence", kind: "text", text: "é😀 evidence preserved", importedAt: timestamp, noteIds: [a.id, b.id] });
space.concepts.push({ id: "knowledge-concept", label: "Contract Alpha", aliases: ["Contract First"], description: "Test vocabulary", canonicalNoteId: a.id, noteIds: [a.id], autoLink: true });
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
  assert.equal(definitions.length, 41);
  assert.equal(new Set(definitions.map((tool) => tool.name)).size, 41);
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
  assert((await tool("orion_get_recent_changes", { since: "2026-09-04T00:00:00Z" })).notes.some((note) => note.id === a.id));
  assert.deepEqual((await tool("orion_get_link_path", { from_note_id: a.id, to_note_id: "knowledge-c" })).path.map((note) => note.id), [a.id, b.id, "knowledge-c"]);
  assert.deepEqual(JSON.parse(await readFile(vaultPath, "utf8")), original, "Read tools changed the library.");
  await tool("orion_get_notes", { note_ids: [a.id, "nonexistent"] }, true);
  await tool("orion_get_source_passage", { space_id: "wrong-space", source_id: "knowledge-source" }, true);
  await tool("orion_get_note_section", { note_id: a.id, heading: "Actions", expected_version: "stale" }, true);
  await tool("orion_list_tasks", { send_to_provider: true }, true);
  await tool("orion_append_to_note", { note_id: a.id, expected_version: task.note.version, text: "Missing Space" }, true);
  await tool("orion_set_task_completion", { space_id: scope, note_id: a.id, expected_version: task.note.version, line_index: task.lineIndex, expected_text: task.rawText, completed: true });
  await tool("orion_edit_note_text", { space_id: scope, note_id: a.id, expected_version: await version(a.id), old_text: "é😀 evidence", new_text: "é😀 verified evidence" });
  const append = { space_id: scope, note_id: a.id, expected_version: await version(a.id), text: "\nOne append." };
  await tool("orion_append_to_note", append); await tool("orion_append_to_note", append, true);
  const beforeBatch = await readFile(vaultPath, "utf8");
  await tool("orion_batch_update_metadata", { space_id: scope, notes: [{ note_id: a.id, expected_version: await version(a.id) }, { note_id: b.id, expected_version: "stale" }], tags: ["must-not-save"] }, true);
  assert.equal(await readFile(vaultPath, "utf8"), beforeBatch);
  await tool("orion_batch_update_metadata", { space_id: scope, notes: [{ note_id: a.id, expected_version: await version(a.id) }, { note_id: b.id, expected_version: await version(b.id) }], tags: ["updated-contract"], pinned: true });
  const saved = JSON.parse(await readFile(vaultPath, "utf8"));
  assert.deepEqual(saved.spaces.filter((space) => space.workspace.id !== scope), original.spaces.filter((space) => space.workspace.id !== scope));
  const updated = saved.spaces.find((space) => space.workspace.id === scope);
  assert.deepEqual(updated.settings, space.settings); assert.deepEqual(updated.sources, space.sources); assert.deepEqual(updated.concepts, space.concepts);
  assert(updated.notes.find((note) => note.id === a.id).body.includes("- [x] Read beta"));
  assert.equal(updated.notes.find((note) => note.id === a.id).body.match(/One append/g).length, 1);
  assert.equal(exercised.size, 20, "Not every new tool was exercised against the packaged executable.");
  console.log("All 20 library tools verified against the exact executable: evidence, navigation, tasks, guarded edits, atomicity, citations, and Space isolation.");
} finally {
  child.kill();
  await rm(directory, { recursive: true, force: true });
}
