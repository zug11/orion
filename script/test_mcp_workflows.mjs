import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";

const [binary, fixture] = process.argv.slice(2);
assert(binary && fixture, "Provide the exact MCP executable and a fixture vault.");
const directory = await mkdtemp("/private/tmp/orion-workflows-");
const vaultPath = join(directory, "vault.json");
const socketPath = join(directory, "assistant.sock");
const descriptorPath = join(directory, "assistant-bridge.json");
const original = await readFile(fixture, "utf8");
const vault = JSON.parse(original);
const spaceId = vault.activeSpaceId;
const otherSpace = vault.spaces.find((space) => space.workspace.id !== spaceId)?.workspace.id;
const activeSpace = vault.spaces.find((space) => space.workspace.id === spaceId);
const noteId = activeSpace.notes[0].id;
const reviewTarget = { id: "review_target_fixture", spaceId, noteId, title: activeSpace.notes[0].title, noteVersion: "v1-0123456789abcdef" };
await writeFile(vaultPath, original);
const token = "ab".repeat(32);
let server;
let child;
const pending = new Map();
const calls = [];
let sequence = 0;
let output = "";
let stderr = "";
let job;
let reviewAllowed = true;
let reviewReceipt;
let reviewRequest;
const editorTarget = { id: "editor_target_fixture", spaceId, noteId, title: activeSpace.notes[0].title, ready: true };
const editorActionTarget = { id: "editor_action_target_fixture", spaceId, noteId, ready: true };
let editorActionAllowed = true, editorActionAIAllowed = true, editorActionWritesAllowed = true, editorActionNeverResponds = false, editorActionCorruption;
let editorActionDocumentVersion = "displayed-v1:fixture", editorActionSequence = 0, editorActionsStarted = 0;
const editorActionCaptures = new Map(), editorActionStarts = new Map(), editorActions = new Map();
let editorAllowed = true;
let editorNeverResponds = false;
let editorSequence = 0;
const editorReads = new Map();
const voiceTarget = { id: "voice_target_fixture", spaceId };
let voiceAllowed = true, voiceAIAllowed = false, voiceNeverResponds = false, voiceWrongReceipt = false, voiceCorruptResult;
let voiceSequence = 0, voiceControlsApplied = 0, voiceInventory = "inventory-1";
let voiceProjectionCase;
const voiceRequests = new Map(), voiceControls = new Map();
const historySecret = "COMPLETED-TASK-PRIVATE-FIXTURE";
const voiceJobs = [
  { id: "voice-worker-one", revision: 1, controlVersion: "control-1", state: "running", taskView: "working", subject: "Read the opening" },
  { id: "voice-worker-history", revision: 1, controlVersion: "history-control-1", state: "completed", taskView: "history", subject: historySecret },
];
const voiceSummary = (job, taskView) => ({ ...job, subject: job.taskView === "history" && taskView !== "history" ? "History research" : job.subject,
  subjectTruncated: false, stage: job.state === "running" ? "researching" : job.state, current: true,
  checkpointSequence: 1, savedNoteIds: [], historyWithheld: job.taskView === "history" && taskView !== "history" });
const bridgeProbe = (method, arguments_ = {}) => new Promise((resolve, reject) => {
  const socket = createConnection(socketPath); let data = "";
  socket.setTimeout(1000, () => socket.destroy(new Error("Unrelated bridge request was blocked.")));
  socket.on("error", reject); socket.on("connect", () => socket.write(JSON.stringify({ version: 1, token, method, arguments: arguments_ }) + "\n"));
  socket.on("data", chunk => { data += chunk; if (data.includes("\n")) { socket.end(); resolve(JSON.parse(data)); } });
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out: ${stderr}`)); }, 8_000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const tool = (name, arguments_ = {}) => request("tools/call", { name, arguments: arguments_ }).then((response) => response.result);
try {
  child = spawn(resolve(binary), ["--vault", vaultPath], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (data) => { stderr += data.toString(); });
  child.stdout.on("data", (data) => {
    output += data.toString();
    for (;;) {
      const index = output.indexOf("\n"); if (index < 0) break;
      const line = output.slice(0, index); output = output.slice(index + 1);
      assert(!line.includes(token), "The bridge token leaked to MCP stdout.");
      const response = JSON.parse(line); const waiter = pending.get(response.id);
      assert(waiter, "Unexpected protocol output."); pending.delete(response.id); waiter.resolve(response);
    }
  });
  await request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "isolated-workflow-harness", version: "1" }, capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const definitions = (await request("tools/list")).result.tools;
  assert.equal(definitions.length, 55);
  const proposedTool = definitions.find((item) => item.name === "orion_propose_note_edit");
  assert.equal(proposedTool.inputSchema.additionalProperties, false);
  assert.equal(proposedTool.inputSchema.properties.edit.oneOf[0].properties.edits.maxItems, 8);
  assert.equal(proposedTool.inputSchema.properties.edit.oneOf[1].properties.body.maxLength, 24_000);
  assert.deepEqual(proposedTool.inputSchema.properties.task_view.enum, ["working", "history"]);
  for (const name of ["orion_propose_note_edit", "orion_get_edit_review", "orion_cancel_edit_review"]) {
    const definition = definitions.find((item) => item.name === name);
    assert.equal(definition.annotations.openWorldHint, false);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert(definition.inputSchema.required.includes("space_id"));
    for (const state of ["awaiting_review", "accepted_in_editor", "saved", "save_failed", "discarded", "cancelled"]) assert(definition.outputSchema.properties.state.enum.includes(state));
  }
  assert.equal((await tool("orion_get_capabilities")).structuredContent.available, false);
  assert.equal((await tool("orion_list_spaces")).structuredContent.activeSpaceId, spaceId);

  server = createServer((stream) => {
    let line = "";
    stream.on("data", (chunk) => {
      line += chunk.toString(); if (!line.includes("\n")) return;
      const input = JSON.parse(line); calls.push(input);
      assert.equal(input.version, 1); assert.equal(input.token, token);
      const args = input.arguments;
      let result;
      const fail = (message) => stream.end(JSON.stringify({ ok: false, error: { code: "scope", message } }) + "\n");
      if (input.method === "capabilities") result = { available: true, access: { enabled: true, allowAI: false, allowWrites: reviewAllowed, spaceIds: [spaceId] },
        editorTargets: editorAllowed ? [editorTarget] : [], editorActionTargets: editorActionAllowed && editorActionAIAllowed && editorActionWritesAllowed ? [editorActionTarget] : [], workflowExecutorAvailable: true,
        voiceTargets: voiceAllowed ? [voiceTarget] : [],
        reviewTargets: reviewAllowed ? [reviewTarget] : [], reviewLimits: { pending: 8, retained: 32, retentionSeconds: 3600, providerCalls: 0 } };
      else if (["editor_action_capture", "editor_action_start", "editor_action_get", "editor_action_cancel"].includes(input.method)) {
        if (!editorActionAllowed || args.space_id !== spaceId) { fail("Editor action access is disabled for this exact Space."); return; }
        if (["editor_action_capture", "editor_action_start"].includes(input.method) && (args.note_id !== noteId || args.editor_target_id !== editorActionTarget.id)) { fail("That exact editor action target changed."); return; }
        let record;
        if (input.method === "editor_action_capture") {
          if (!editorActionAIAllowed || !editorActionWritesAllowed) { fail("Capturing an action requires both API and write permission, without making a provider call."); return; }
          record = editorActionCaptures.get(args.request_id);
          if (record && JSON.stringify(record.capture) !== JSON.stringify(args)) { fail("Capture request ID already belongs to different input."); return; }
          if (!record) {
            const id = `editor_action_${++editorActionSequence}`;
            record = { capture: args, polls: 0, receipt: { id, spaceId, noteId, editorTargetId: editorActionTarget.id,
              action: args.action, state: "capture_pending", createdAt: 1, updatedAt: 1 } };
            editorActionCaptures.set(args.request_id, record); editorActions.set(id, record);
          }
        } else if (input.method === "editor_action_start") {
          if (!editorActionAIAllowed || !editorActionWritesAllowed) { fail("Editor generation requires both API and write permission."); return; }
          const previous = editorActionStarts.get(args.request_id);
          record = previous?.record ?? [...editorActions.values()].find(item => item.receipt.captureId === args.capture_id);
          if (!record || !previous && (record.receipt.documentVersion !== args.expected_document_version || args.expected_document_version !== editorActionDocumentVersion)) { fail("That captured editor document has changed."); return; }
          if (previous && JSON.stringify(previous.input) !== JSON.stringify(args)) { fail("Start request ID already belongs to different input."); return; }
          if (record.startId && record.startId !== args.request_id) { fail("The captured action has already been consumed."); return; }
          if (!previous) {
            if (record.receipt.state !== "captured") { fail("The editor capture is no longer available."); return; }
            editorActionStarts.set(args.request_id, { input: args, record }); record.startId = args.request_id;
            editorActionsStarted++; record.receipt = { ...record.receipt, state: "submitted", updatedAt: 2 };
          }
        } else {
          record = editorActions.get(args.action_id);
          if (!record) { fail("The exact editor action expired."); return; }
          if (input.method === "editor_action_get" && record.receipt.state === "capture_pending" && !editorActionNeverResponds && record.polls++ > 0) {
            record.receipt = { ...record.receipt, state: "captured", captureId: `capture_${record.receipt.id}`,
              documentVersion: editorActionDocumentVersion,
              selection: { coordinateSystem: "prosemirror", from: 3, to: 8 }, effectiveTarget: { coordinateSystem: "prosemirror", from: 1, to: 12 }, updatedAt: 2 };
          }
          if (input.method === "editor_action_cancel" && ["accepting", "accepted_in_editor", "saved", "save_failed"].includes(record.receipt.state)) { fail("Local acceptance has already been claimed. Cancellation cannot undo an accepted editor change."); return; }
          if (input.method === "editor_action_cancel" && ["capture_pending", "captured", "submitted", "generating", "awaiting_review"].includes(record.receipt.state)) record.receipt = { ...record.receipt, state: "cancelled", updatedAt: 3 };
        }
        result = structuredClone(record.receipt);
        if (editorActionCorruption === "foreign-space") result.spaceId = "foreign-space";
        if (editorActionCorruption === "foreign-target") result.editorTargetId = "foreign-target";
        if (editorActionCorruption === "foreign-action") result.action = { kind: "write", amount: "section" };
        if (editorActionCorruption === "extra") result.body = "private generated prose";
        if (editorActionCorruption === "extra-action") result.action.model = "caller model";
        if (editorActionCorruption === "identity") result.id = "different-action";
        if (editorActionCorruption === "range") result.selection = { coordinateSystem: "dom-text-utf16", from: 3, to: 8 };
        if (editorActionCorruption === "partial-metadata") delete result.captureId;
        if (editorActionCorruption === "start-capture") result.captureId = "different-capture";
        if (editorActionCorruption === "foreign-result") result.result.url = "orion://open?space_id=foreign&note_id=foreign";
        if (editorActionCorruption === "foreign-citation") result.result.citation = "[Forged](https://example.com)";
        if (editorActionCorruption === "extra-result") result.result.body = "private generated text";
        if (editorActionCorruption === "saved-early") result.result = { noteId, version: "v1-save", url: `orion://open?space_id=${spaceId}&note_id=${noteId}`, citation: "[Saved](orion://open)" };
      }
      else if (["voice_list", "voice_get", "voice_control"].includes(input.method)) {
        if (!voiceAllowed || args.space_id !== spaceId || args.voice_target_id !== voiceTarget.id) { fail("That exact voice target is unavailable in this enabled Space."); return; }
        if (input.method === "voice_control" && args.action !== "cancel" && !voiceAIAllowed) { fail("AI permission is required for read-only research continuation."); return; }
        const identity = args.request_id && voiceControls.get(args.request_id);
        if (identity) {
          if (JSON.stringify(identity.args) !== JSON.stringify(args)) { fail("That control request ID already belongs to different input."); return; }
          result = identity.receipt;
        } else {
          let response;
          if (voiceProjectionCase) {
            assert.equal(input.method, `voice_${voiceProjectionCase.request.operation}`);
            const { operation: _operation, ...expected } = voiceProjectionCase.request;
            assert.deepEqual(args, expected, "Actual renderer fixture request changed in transport.");
            response = structuredClone(voiceProjectionCase.result);
          } else if (input.method === "voice_list") {
            if (args.inventory_version && args.inventory_version !== voiceInventory) { fail("The inventory changed; read its first page again."); return; }
            response = { spaceId, voiceTargetId: voiceTarget.id, taskView: args.task_view, inventoryVersion: voiceInventory,
              offset: args.offset, limit: args.limit, total: voiceJobs.length, nextOffset: args.offset + args.limit < voiceJobs.length ? args.offset + args.limit : null,
              items: voiceJobs.slice(args.offset, args.offset + args.limit).map(job => voiceSummary(job, args.task_view)) };
          } else {
            const selected = voiceJobs.find(job => job.id === args.work_order_id);
            if (!selected || selected.revision !== args.expected_revision || input.method === "voice_control" && selected.controlVersion !== args.expected_control_version) { fail("The exact worker revision/control version changed."); return; }
            if (input.method === "voice_get") {
              const summary = voiceSummary(selected, args.task_view), text = selected.taskView === "history" ? historySecret : "A supported finding 🧭";
              const bounded = [...text].slice(0, Math.max(0, args.max_chars - 1)).join("");
              response = { spaceId, voiceTargetId: voiceTarget.id, taskView: args.task_view, workOrder: { ...summary, subject: summary.subject.slice(0, 1), subjectTruncated: true,
                referenceOnly: true, ...(summary.historyWithheld ? { withheld: "history" } : { result: { text: { fragments: bounded ? [{ from: 0, to: bounded.length, text: bounded }] : [], complete: bounded === text, omittedChars: [...text].length - [...bounded].length }, evidence: [], omittedEvidence: 0 } }),
                findings: [], decisions: [], openQuestions: [], nextSteps: [], completedOperations: [], omissions: { findings: 0, decisions: 0, openQuestions: 0, nextSteps: 0, completedOperations: 0 } } };
            } else {
              voiceControlsApplied++;
              const changed = args.action !== "cancel" || selected.state === "running";
              if (changed) { if (args.action !== "cancel") selected.revision++; selected.state = args.action === "cancel" ? "cancelled" : "running"; selected.controlVersion = `control-${voiceControlsApplied + 1}`; voiceInventory = `inventory-${voiceControlsApplied + 1}`; }
              response = { spaceId, voiceTargetId: voiceTarget.id, requestId: args.request_id, controlVersion: selected.controlVersion,
                id: selected.id, revision: selected.revision, action: args.action, state: selected.state, changed, ...(args.action === "cancel" ? {} : { readOnly: true }) };
            }
          }
          const id = `voice_request_${++voiceSequence}`;
          result = { id, state: "pending" };
          const receipt = { id, state: "succeeded", result: response };
          voiceRequests.set(id, { args, polls: 0, receipt });
          if (args.request_id) voiceControls.set(args.request_id, { args, receipt });
        }
      } else if (input.method === "voice_request_get") {
        const read = voiceRequests.get(args.request_id);
        if (!voiceAllowed || args.space_id !== spaceId || !read) { fail("Voice request expired or owner changed."); return; }
        if (voiceNeverResponds || read.polls++ === 0) result = { id: args.request_id, state: "pending" };
        else {
          result = structuredClone({ ...read.receipt, ...(voiceWrongReceipt ? { id: "wrong-receipt" } : {}) });
          if (voiceCorruptResult === "extra") result.result.workOrder.transcript = historySecret;
          if (voiceCorruptResult === "scope") result.result.spaceId = "foreign-space";
          if (voiceCorruptResult === "history") result.result.workOrder.result = { text: { fragments: [{ from: 0, to: historySecret.length, text: historySecret }], complete: true, omittedChars: 0 }, evidence: [], omittedEvidence: 0 };
          if (voiceCorruptResult === "budget") result.result.workOrder.decisions = [{ fragments: [{ from: 0, to: 8, text: "overflow" }], complete: true, omittedChars: 0 }];
          if (voiceCorruptResult === "failed") result = { id: args.request_id, state: "failed", error: "The voice owner changed before this request could be applied." };
        }
      }
      else if (input.method === "editor_context_request") {
        if (!editorAllowed || args.space_id !== spaceId || args.editor_target_id !== editorTarget.id) { fail("That exact editor target is unavailable in this enabled Space."); return; }
        const id = `editor_read_${++editorSequence}`; editorReads.set(id, { args, polls: 0 }); result = { id, state: "pending" };
      } else if (input.method === "editor_context_get") {
        const read = editorReads.get(args.request_id);
        if (!editorAllowed || args.space_id !== spaceId || !read) { fail("Editor read expired or target changed."); return; }
        if (editorNeverResponds || read.polls++ === 0) result = { state: "pending" };
        else { editorReads.delete(args.request_id); result = { state: "ready", context: {
          referenceOnly: true, spaceId, noteId, editorTargetId: editorTarget.id, taskView: read.args.task_view,
          state: "selected", documentVersion: "displayed-v1:unsaved-reference", selection: { coordinateSystem: "dom-text-utf16", from: 5, to: 8 },
          fragments: [{ text: "🧭a", from: 5, to: 8 }], truncated: false, omittedChars: 0, completedTasksOmitted: false, completedTaskChars: 0,
        } }; }
      } else if (input.method === "review_submit") {
        if (!reviewAllowed) { fail("Note-write permission is not enabled for this Space."); return; }
        if (args.space_id !== spaceId || args.note_id !== noteId || args.review_target_id !== reviewTarget.id || args.expected_version !== reviewTarget.noteVersion) {
          fail("The exact open review target or note version changed."); return;
        }
        if (reviewRequest?.request_id === args.request_id) {
          if (JSON.stringify(reviewRequest) !== JSON.stringify(args)) { fail("This request ID was already used for different input."); return; }
        } else {
          reviewRequest = args;
          reviewReceipt = { id: `review_${args.request_id}`, spaceId, noteId, reviewTargetId: reviewTarget.id,
            state: "awaiting_review", createdAt: 1, updatedAt: 1 };
        }
        result = reviewReceipt;
      } else if (input.method === "review_get" || input.method === "review_cancel") {
        if (!reviewAllowed || !reviewReceipt || args.space_id !== spaceId || args.review_id !== reviewReceipt.id) {
          fail("Review is not available in this enabled Space."); return;
        }
        if (input.method === "review_cancel" && ["submitted", "awaiting_review"].includes(reviewReceipt.state)) reviewReceipt = { ...reviewReceipt, state: "cancelled", updatedAt: 2 };
        result = reviewReceipt;
      }
      else if (input.method === "start") {
        assert.equal(args.space_id, spaceId);
        job = { id: "job_fixture", spaceId, operation: args.operation, state: "queued", stage: "Waiting", createdAt: 1, updatedAt: 1 };
        result = job;
      } else if (input.method === "get_job" || input.method === "cancel_job") {
        if (args.space_id !== job.spaceId || args.job_id !== job.id) {
          stream.end(JSON.stringify({ ok: false, error: { code: "scope", message: "Job not in the selected Space." } }) + "\n"); return;
        }
        if (input.method === "cancel_job") job = { ...job, state: "cancelled" };
        result = job;
      } else if (input.method === "list_jobs") result = { spaceId, jobs: job ? [job] : [] };
      else throw new Error("Unexpected native method");
      stream.end(JSON.stringify({ ok: true, result }) + "\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  const descriptor = { version: 1, vault_path: await realpath(vaultPath), socket_path: await realpath(socketPath), token };
  await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  assert.equal((await tool("orion_get_capabilities")).structuredContent.available, true);
  const started = await tool("orion_get_context", { space_id: spaceId, request_id: "context-one", query: "Find evidence" });
  assert.equal(started.structuredContent.state, "queued");
  assert.equal(calls.at(-1).arguments.operation, "context");
  assert.equal(calls.at(-1).arguments.input.query, "Find evidence");
  await tool("orion_search_space", { space_id: spaceId, request_id: "search-one", query: "Which passages support this?" });
  assert.equal(calls.at(-1).arguments.operation, "search");
  assert.equal(calls.at(-1).arguments.input.query, "Which passages support this?");
  await tool("orion_export_word", { space_id: spaceId, request_id: "word-one", scope: "space" });
  assert.equal(calls.at(-1).arguments.operation, "export");
  assert.deepEqual(calls.at(-1).arguments.input, { scope: "space" });
  const beforeInvalid = calls.length;
  assert.equal((await tool("orion_export_word", { space_id: spaceId, request_id: "bad-path", scope: "space", path: "/tmp/not-authorized.docx" })).isError, true);
  assert.equal((await tool("orion_export_word", { space_id: spaceId, request_id: "missing-note", scope: "note" })).isError, true);
  assert.equal((await tool("orion_search_space", { space_id: spaceId, request_id: "bad-query", query: "x".repeat(601) })).isError, true);
  assert.equal((await tool("orion_research", { space_id: spaceId, request_id: "bad", question: "Why?", allow_write: true })).isError, true);
  assert.equal((await tool("orion_import", { request_id: "missing-space", inputs: [{ kind: "text", title: "A", text: "B" }] })).isError, true);
  assert.equal(calls.length, beforeInvalid, "Invalid inputs crossed the native boundary.");
  if (otherSpace) assert.equal((await tool("orion_get_job", { space_id: otherSpace, job_id: job.id })).isError, true);
  job = { ...job, state: "succeeded", result: { spaceId, evidence: [], coverage: { exhaustive: false } }, freshness: "current" };
  const completed = (await tool("orion_get_job", { space_id: spaceId, job_id: job.id })).structuredContent;
  assert.equal(completed.freshness, "current"); assert.equal(completed.result.coverage.exhaustive, false);
  await tool("orion_import", { space_id: spaceId, request_id: "file", mode: "local", inputs: [{ kind: "file", path: "/nonexistent/document.pdf" }] });
  assert.equal(calls.at(-1).arguments.input.inputs[0].path, "/nonexistent/document.pdf", "The app, not MCP, resolves file inputs.");
  assert.equal((await tool("orion_cancel_job", { space_id: spaceId, job_id: job.id })).structuredContent.state, "cancelled");
  assert.equal((await tool("orion_list_jobs", { space_id: spaceId })).structuredContent.jobs.length, 1);
  await chmod(descriptorPath, 0o644);
  assert.equal((await tool("orion_get_capabilities")).structuredContent.available, false);
  await chmod(descriptorPath, 0o600);
  // Review transport is deliberately a fake native host. It proves exact
  // dispatch/receipt separation and no local writes, not native UI acceptance.
  const capabilities = (await tool("orion_get_capabilities")).structuredContent;
  assert.deepEqual(capabilities.reviewTargets, [reviewTarget]);
  assert.equal(capabilities.access.allowAI, false, "Review must not require a provider.");
  assert.equal(capabilities.reviewLimits.providerCalls, 0);
  assert(!JSON.stringify(capabilities).includes('"body"'), "Discovery exposed a note body.");
  const proposal = { space_id: spaceId, request_id: "review-one", review_target_id: reviewTarget.id,
    note_id: noteId, expected_version: reviewTarget.noteVersion, edit: { kind: "focused", edits: [{ before: "Exact original", after: "Proposed change" }] } };
  const beforeBadReviews = calls.length;
  const invalidReviews = [
    { ...proposal, space_id: undefined }, { ...proposal, request_id: " padded " },
    { ...proposal, review_target_id: "bad\nidentity" }, { ...proposal, expected_version: "x".repeat(65) },
    { ...proposal, accept: true }, { ...proposal, allow_write: true }, { ...proposal, window_label: "main" },
    { ...proposal, task_view: "everything" },
    { ...proposal, edit: { kind: "focused", edits: [] } },
    { ...proposal, edit: { kind: "focused", edits: Array.from({ length: 9 }, () => ({ before: "A", after: "B" })) } },
    { ...proposal, edit: { kind: "focused", edits: [{ before: "", after: "B" }] } },
    { ...proposal, edit: { kind: "focused", edits: [{ before: "A".repeat(6001), after: "B" }] } },
    { ...proposal, edit: { kind: "focused", edits: Array.from({ length: 5 }, () => ({ before: "A".repeat(3000), after: "B".repeat(3000) })) } },
    { ...proposal, edit: { kind: "focused", edits: [{ before: "A", after: "B", note_id: "other" }] } },
    { ...proposal, edit: { kind: "rewrite", body: "" } },
    { ...proposal, edit: { kind: "rewrite", body: "🪐".repeat(24_001) } },
    { ...proposal, edit: { kind: "rewrite", body: "Body", accept: true } },
  ];
  for (const input of invalidReviews) assert.equal((await tool("orion_propose_note_edit", input)).isError, true, JSON.stringify(input).slice(0, 220));
  for (const name of ["orion_get_edit_review", "orion_cancel_edit_review"]) {
    for (const input of [{ review_id: "missing-space" }, { space_id: spaceId, job_id: "wrong-kind" }, { space_id: spaceId, review_id: "review-one", accept: true }]) assert.equal((await tool(name, input)).isError, true);
  }
  assert.equal(calls.length, beforeBadReviews, "Malformed reviews crossed the native boundary.");
  const proposed = (await tool("orion_propose_note_edit", proposal)).structuredContent;
  assert.equal(calls.at(-1).method, "review_submit");
  assert.deepEqual(calls.at(-1).arguments.edit, proposal.edit);
  assert.equal(proposed.state, "awaiting_review");
  assert(!("operation" in proposed), "A review was presented as a provider/workflow job.");
  assert(!JSON.stringify(proposed).includes("Exact original"), "Review receipt exposed the proposal body.");
  assert.deepEqual((await tool("orion_propose_note_edit", proposal)).structuredContent, proposed, "Identical retry changed receipt identity.");
  assert.equal((await tool("orion_propose_note_edit", { ...proposal, edit: { kind: "rewrite", body: "Different input" } })).isError, true);
  assert.equal((await tool("orion_propose_note_edit", { ...proposal, expected_version: "v1-stale" })).isError, true);
  assert.equal((await tool("orion_propose_note_edit", { ...proposal, review_target_id: "caller-invented" })).isError, true);
  assert.equal((await tool("orion_propose_note_edit", { ...proposal, note_id: "other-note" })).isError, true);
  if (otherSpace) assert.equal((await tool("orion_get_edit_review", { space_id: otherSpace, review_id: proposed.id })).isError, true);
  assert.equal((await tool("orion_get_edit_review", { space_id: spaceId, review_id: proposed.id })).structuredContent.state, "awaiting_review");
  const cancelled = (await tool("orion_cancel_edit_review", { space_id: spaceId, review_id: proposed.id })).structuredContent;
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual((await tool("orion_propose_note_edit", proposal)).structuredContent, cancelled, "Retry resurrected a cancelled proposal.");
  const rewrite = { ...proposal, request_id: "review-rewrite", task_view: "history", edit: { kind: "rewrite", body: "An explicit complete authored body." } };
  const rewritten = (await tool("orion_propose_note_edit", rewrite)).structuredContent;
  assert.equal(calls.at(-1).arguments.task_view, "history");
  assert.deepEqual(calls.at(-1).arguments.edit, rewrite.edit);
  // Native state is simulated here; no user action or disk save is claimed.
  reviewReceipt = { ...reviewReceipt, state: "accepted_in_editor" };
  assert.equal((await tool("orion_cancel_edit_review", { space_id: spaceId, review_id: rewritten.id })).structuredContent.state, "accepted_in_editor", "Cancellation must not undo accepted edits.");
  reviewReceipt = { ...reviewReceipt, state: "save_failed", error: "Local editor retains unsaved changes." };
  assert.equal((await tool("orion_get_edit_review", { space_id: spaceId, review_id: rewritten.id })).structuredContent.state, "save_failed");
  reviewReceipt = { ...reviewReceipt, state: "saved", error: undefined };
  assert.equal((await tool("orion_get_edit_review", { space_id: spaceId, review_id: rewritten.id })).structuredContent.state, "saved");
  reviewAllowed = false;
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.reviewTargets, []);
  assert.equal((await tool("orion_propose_note_edit", { ...proposal, request_id: "permission-denied" })).isError, true);
  assert.equal((await tool("orion_get_edit_review", { space_id: spaceId, review_id: rewritten.id })).isError, true);
  assert.equal((await tool("orion_cancel_edit_review", { space_id: spaceId, review_id: rewritten.id })).isError, true);
  // Executable connector contract, simulated renderer/native response only.
  // Write and AI permission are both disabled, while editor read access remains on.
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.editorTargets, [editorTarget]);
  const editorDefinition = definitions.find((item) => item.name === "orion_get_editor_context");
  assert.equal(editorDefinition.annotations.readOnlyHint, true);
  assert.equal(editorDefinition.inputSchema.additionalProperties, false);
  assert.equal(editorDefinition.inputSchema.properties.max_chars.maximum, 12_000);
  const beforeBadEditor = calls.length;
  for (const input of [
    { space_id: spaceId, editor_target_id: editorTarget.id, body: "Not allowed" },
    { space_id: spaceId, editor_target_id: editorTarget.id, max_chars: 12_001 },
    { space_id: spaceId, editor_target_id: editorTarget.id, max_chars: 0 },
    { space_id: spaceId, editor_target_id: editorTarget.id, max_chars: 3.2 },
    { space_id: spaceId, editor_target_id: editorTarget.id, task_view: "all" },
    { space_id: ` ${spaceId}`, editor_target_id: editorTarget.id },
    { space_id: spaceId, editor_target_id: editorTarget.id, cursor: 10 },
  ]) assert.equal((await tool("orion_get_editor_context", input)).isError, true);
  assert.equal(calls.length, beforeBadEditor, "Malformed editor input crossed the native boundary.");
  const context = (await tool("orion_get_editor_context", { space_id: spaceId, editor_target_id: editorTarget.id })).structuredContent;
  assert.equal(context.referenceOnly, true); assert.equal(context.taskView, "working");
  assert.equal(context.documentVersion, "displayed-v1:unsaved-reference"); assert.equal(context.fragments[0].text, "🧭a");
  assert.equal(context.selection.coordinateSystem, "dom-text-utf16"); assert(!("expected_version" in context));
  const startEditor = calls.findLast((call) => call.method === "editor_context_request");
  assert.deepEqual(startEditor.arguments, { space_id: spaceId, editor_target_id: editorTarget.id, task_view: "working", max_chars: 4000 });
  assert.equal((await tool("orion_get_editor_context", { space_id: spaceId, editor_target_id: editorTarget.id, task_view: "history", max_chars: 2 })).structuredContent.taskView, "history");
  assert.equal((await tool("orion_get_editor_context", { space_id: spaceId, editor_target_id: "invented" })).isError, true);
  if (otherSpace) assert.equal((await tool("orion_get_editor_context", { space_id: otherSpace, editor_target_id: editorTarget.id })).isError, true);
  editorAllowed = false;
  assert.equal((await tool("orion_get_editor_context", { space_id: spaceId, editor_target_id: editorTarget.id })).isError, true);
  editorAllowed = true; editorNeverResponds = true;
  const timeoutStart = Date.now(); const timeoutResult = await tool("orion_get_editor_context", { space_id: spaceId, editor_target_id: editorTarget.id });
  assert.equal(timeoutResult.isError, true); assert(Date.now() - timeoutStart < 4500, "Editor polling exceeded its bounded wait.");
  editorNeverResponds = false;
  // Voice tools use a different transient owner/mailbox. This host simulates
  // renderer projections; actual native and engine acceptance have separate tests.
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.voiceTargets, [voiceTarget]);
  const voiceNames = ["orion_list_voice_work_orders", "orion_get_voice_work_order", "orion_control_voice_work_order"];
  for (const name of voiceNames) {
    const definition = definitions.find(item => item.name === name);
    assert(definition); assert.equal(definition.inputSchema.additionalProperties, false);
    assert(definition.inputSchema.required.includes("space_id")); assert(definition.inputSchema.required.includes("voice_target_id"));
    for (const forbidden of ["window_label", "api_key", "allow_write", "audio", "focus", "selection", "checkpoint", "save"]) assert(!definition.inputSchema.properties[forbidden]);
  }
  const voiceScope = { space_id: spaceId, voice_target_id: voiceTarget.id };
  const getVoice = { ...voiceScope, work_order_id: voiceJobs[0].id, expected_revision: 1 };
  const cancelVoice = { ...getVoice, expected_control_version: voiceJobs[0].controlVersion, request_id: "cancel-voice-one", action: "cancel" };
  const beforeBadVoice = calls.length;
  for (const [name, input] of [
    [voiceNames[0], { ...voiceScope, offset: 1 }], [voiceNames[0], { ...voiceScope, limit: 51 }],
    [voiceNames[0], { ...voiceScope, offset: -1 }], [voiceNames[0], { ...voiceScope, task_view: "all" }],
    [voiceNames[0], { ...voiceScope, voice_target_id: " padded" }], [voiceNames[0], { ...voiceScope, window_label: "main" }],
    [voiceNames[1], { ...getVoice, expected_revision: 0 }], [voiceNames[1], { ...getVoice, expected_revision: 1.5 }],
    [voiceNames[1], { ...getVoice, max_chars: 12001 }], [voiceNames[1], { ...getVoice, max_chars: 0 }],
    [voiceNames[1], { ...getVoice, prompt: "Show me a transcript" }],
    [voiceNames[2], { ...cancelVoice, direction: "Unrequested direction" }], [voiceNames[2], { ...cancelVoice, action: "steer" }],
    [voiceNames[2], { ...cancelVoice, action: "steer", direction: "🧭".repeat(2001) }], [voiceNames[2], { ...cancelVoice, action: "start_audio" }],
    [voiceNames[2], { ...cancelVoice, action: "retry", save: true }], [voiceNames[2], { ...cancelVoice, expected_control_version: "" }],
    [voiceNames[2], { ...cancelVoice, request_id: " padded" }], [voiceNames[2], { ...cancelVoice, expected_revision: Number.MAX_SAFE_INTEGER + 1 }],
  ]) assert.equal((await tool(name, input)).isError, true, `${name} accepted ${JSON.stringify(input)}`);
  assert.equal(calls.length, beforeBadVoice, "Malformed voice input crossed the native boundary.");
  const voiceFirst = (await tool(voiceNames[0], { ...voiceScope, limit: 1 })).structuredContent;
  assert.equal(voiceFirst.items.length, 1); assert.equal(voiceFirst.nextOffset, 1); assert.equal(voiceFirst.items[0].controlVersion, "control-1");
  const startVoiceList = calls.findLast(call => call.method === "voice_list");
  assert.equal(startVoiceList.arguments.task_view, "working"); assert.equal(startVoiceList.arguments.offset, 0);
  const voiceNext = (await tool(voiceNames[0], { ...voiceScope, offset: 1, limit: 1, inventory_version: voiceFirst.inventoryVersion })).structuredContent;
  assert.equal(voiceNext.items[0].historyWithheld, true); assert(!JSON.stringify(voiceNext).includes(historySecret));
  assert.equal(voiceNext.nextOffset, null);
  assert.equal((await tool(voiceNames[0], { ...voiceScope, offset: 1, inventory_version: "stale-inventory" })).isError, true);
  const detailVoice = (await tool(voiceNames[1], { ...getVoice, max_chars: 3 })).structuredContent;
  assert.equal(detailVoice.workOrder.referenceOnly, true); assert.equal(detailVoice.workOrder.result.text.complete, false);
  assert.equal([...detailVoice.workOrder.subject + detailVoice.workOrder.result.text.fragments.map(part => part.text).join("")].length, 3);
  assert(!("prompt" in detailVoice.workOrder)); assert(!("selection" in detailVoice.workOrder)); assert(!("checkpoint" in detailVoice.workOrder)); assert(!("conversation" in detailVoice.workOrder));
  const historicalVoice = { ...voiceScope, work_order_id: voiceJobs[1].id, expected_revision: 1 };
  const workingDetail = (await tool(voiceNames[1], historicalVoice)).structuredContent;
  assert.equal(workingDetail.workOrder.withheld, "history"); assert(!JSON.stringify(workingDetail).includes(historySecret));
  const historicalDetail = (await tool(voiceNames[1], { ...historicalVoice, task_view: "history" })).structuredContent;
  assert(JSON.stringify(historicalDetail).includes(historySecret));
  for (const corruption of ["extra", "scope", "history", "budget"]) {
    voiceCorruptResult = corruption;
    const denied = await tool(voiceNames[1], corruption === "history" ? historicalVoice : { ...getVoice, max_chars: corruption === "budget" ? 1 : 4000 });
    assert.equal(denied.isError, true, `Malformed ${corruption} projection was released to MCP.`);
    assert(!JSON.stringify(denied).includes(historySecret), "Rejected private text leaked through the error.");
  }
  voiceCorruptResult = "failed";
  assert(JSON.stringify(await tool(voiceNames[1], getVoice)).includes("The voice owner changed before this request could be applied."));
  voiceCorruptResult = undefined;
  // This checked-in contract is generated and asserted by actual VoiceResearch
  // tests. Transport the exact projections (only native target/Space remapped)
  // through the executable's shared Rust validator, not a JS approximation.
  const actualProjections = JSON.parse(await readFile(new URL("../src/lib/assistant/voiceWorkOrders.contract.json", import.meta.url), "utf8"));
  for (const projection of actualProjections) {
    voiceProjectionCase = structuredClone(projection);
    Object.assign(voiceProjectionCase.request, voiceScope);
    Object.assign(voiceProjectionCase.result, { spaceId, voiceTargetId: voiceTarget.id });
    const { operation, ...input } = voiceProjectionCase.request;
    const name = operation === "get" ? voiceNames[1] : operation === "list" ? voiceNames[0] : voiceNames[2];
    const actual = await tool(name, input);
    assert(!actual.isError, `Actual renderer ${operation} projection was rejected: ${JSON.stringify(actual)}`);
    assert.deepEqual(actual.structuredContent, voiceProjectionCase.result, "Renderer projection was reinterpreted during MCP transport.");
  }
  voiceProjectionCase = undefined;
  assert(actualProjections.some(item => item.result.workOrder?.result?.evidence.some(entry => entry.title === "Exact 😀 title")));
  assert(actualProjections.some(item => item.request.max_chars === 1));
  assert(actualProjections.some(item => item.result.workOrder?.withheld === "history"));
  assert(actualProjections.some(item => item.result.workOrder?.withheld === "stale"));
  assert.equal((await tool(voiceNames[1], { ...getVoice, expected_revision: 99 })).isError, true);
  for (const name of voiceNames) {
    const input = name === voiceNames[0] ? voiceScope : name === voiceNames[1] ? getVoice : cancelVoice;
    assert.equal((await tool(name, { ...input, voice_target_id: "invented" })).isError, true);
    if (otherSpace) assert.equal((await tool(name, { ...input, space_id: otherSpace })).isError, true);
  }
  assert.equal((await tool(voiceNames[2], { ...cancelVoice, action: "retry", request_id: "ai-denied" })).isError, true);
  // Neither read nor cancel requires AI/write grants; no fixture vault writer runs.
  const cancelledVoice = (await tool(voiceNames[2], cancelVoice)).structuredContent;
  assert.equal(cancelledVoice.state, "cancelled"); assert.equal(cancelledVoice.changed, true);
  assert.deepEqual((await tool(voiceNames[2], cancelVoice)).structuredContent, cancelledVoice);
  assert.equal(voiceControlsApplied, 1, "Identical cancellation was applied twice.");
  assert.equal((await tool(voiceNames[2], { ...cancelVoice, task_view: "history" })).isError, true);
  assert.equal((await tool(voiceNames[2], { ...cancelVoice, request_id: "stale-control" })).isError, true);
  assert.equal((await tool(voiceNames[0], { ...voiceScope, offset: 1, inventory_version: voiceFirst.inventoryVersion })).isError, true);
  voiceAIAllowed = true;
  const retryVoice = { ...cancelVoice, expected_control_version: cancelledVoice.controlVersion, request_id: "retry-voice-one", action: "retry" };
  const retriedVoice = (await tool(voiceNames[2], retryVoice)).structuredContent;
  assert.equal(retriedVoice.revision, 2); assert.equal(retriedVoice.readOnly, true);
  const steerVoice = { ...retryVoice, expected_revision: 2, expected_control_version: retriedVoice.controlVersion, request_id: "steer-voice-one", action: "steer", direction: "Check the 🧭 conclusion and distinguish interpretation from evidence." };
  const steeredVoice = (await tool(voiceNames[2], steerVoice)).structuredContent;
  assert.equal(steeredVoice.id, getVoice.work_order_id); assert.equal(steeredVoice.revision, 3); assert.equal(steeredVoice.readOnly, true);
  assert.equal(calls.findLast(call => call.method === "voice_control").arguments.direction, steerVoice.direction);
  voiceWrongReceipt = true;
  assert.equal((await tool(voiceNames[1], { ...getVoice, expected_revision: 3 })).isError, true, "A response for another request was accepted.");
  voiceWrongReceipt = false; voiceAllowed = false;
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.voiceTargets, []);
  assert.equal((await tool(voiceNames[1], { ...getVoice, expected_revision: 3 })).isError, true);
  voiceAllowed = true; voiceNeverResponds = true;
  const timeoutControl = { ...steerVoice, action: "cancel", direction: undefined, request_id: "cancel-uncertain", expected_revision: 3, expected_control_version: steeredVoice.controlVersion };
  const voiceTimeoutStart = Date.now(), waitingVoice = tool(voiceNames[2], timeoutControl);
  await new Promise(resolve => setTimeout(resolve, 250));
  const probeStart = Date.now(); assert.equal((await bridgeProbe("capabilities")).result.available, true);
  assert(Date.now() - probeStart < 1000, "Polling held the private socket open across waits.");
  const voiceTimeout = await waitingVoice;
  assert.equal(voiceTimeout.isError, true); assert(Date.now() - voiceTimeoutStart < 4500, "Voice polling exceeded its dispatch bound.");
  const appliesBeforeReplay = voiceControlsApplied;
  voiceNeverResponds = false;
  const lateVoice = (await tool(voiceNames[2], timeoutControl)).structuredContent;
  assert.equal(lateVoice.state, "cancelled"); assert.equal(voiceControlsApplied, appliesBeforeReplay, "Uncertain control was repeated instead of replaying its receipt.");
  // These tests exercise the executable connector against a simulated native
  // mailbox. They do not prove an editor accepted, generated, or saved anything.
  const actionTools = ["orion_capture_editor_action", "orion_start_editor_action", "orion_get_editor_action", "orion_cancel_editor_action"];
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.editorActionTargets, [editorActionTarget]);
  for (const name of actionTools) {
    const definition = definitions.find(item => item.name === name);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.annotations.idempotentHint, true);
    assert.equal(definition.annotations.openWorldHint, name === actionTools[1]);
    assert.equal(definition.outputSchema.additionalProperties, false);
    assert(definition.inputSchema.required.includes("space_id"));
    for (const key of ["body", "selected_text", "from", "to", "selection", "accept", "model", "task_view", "window_label"]) assert(!(key in definition.inputSchema.properties));
  }
  const captureAction = { space_id: spaceId, note_id: noteId, editor_target_id: editorActionTarget.id, request_id: "capture-tighten", action: { kind: "rewrite", preset: "tighten", instruction: "Keep this voice." } };
  const invalidActionStart = { space_id: spaceId, note_id: noteId, editor_target_id: editorActionTarget.id, request_id: "start", capture_id: "capture", expected_document_version: editorActionDocumentVersion };
  const beforeBadActions = calls.length;
  for (const [name, base] of [[actionTools[0], captureAction], [actionTools[1], invalidActionStart], [actionTools[2], { space_id: spaceId, action_id: "action" }], [actionTools[3], { space_id: spaceId, action_id: "action" }]]) {
    for (const key of ["body", "selected_text", "from", "to", "selection", "accept", "model", "task_view", "allow_write", "window_label", "job_id"]) assert.equal((await tool(name, { ...base, [key]: "override" })).isError, true, `${name} accepted ${key}`);
    for (const bad of ["", " leading", "trailing ", "control\n"]) assert.equal((await tool(name, { ...base, space_id: bad })).isError, true);
  }
  for (const action of [
    { kind: "rewrite", preset: "unknown" }, { kind: "write", amount: "chapter" }, { kind: "image", quality: "fast", context: "internet" },
    { kind: "rewrite", preset: "tighten", instruction: "🧭".repeat(1251) }, { kind: "rewrite", preset: "tighten", instruction: "bad\u0000control" },
    { kind: "rewrite", preset: "tighten", body: "caller selection" }, { kind: "image", quality: "fast", context: "selection", url: "https://example.com" },
  ]) assert.equal((await tool(actionTools[0], { ...captureAction, action })).isError, true);
  assert.equal(calls.length, beforeBadActions, "Malformed action inputs crossed the native boundary.");
  editorActionAIAllowed = false;
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.editorActionTargets, []);
  assert.equal((await tool(actionTools[0], captureAction)).isError, true, "Capture bypassed disabled API grant.");
  editorActionAIAllowed = true; editorActionWritesAllowed = false;
  assert.equal((await tool(actionTools[0], captureAction)).isError, true, "Capture bypassed disabled write grant.");
  editorActionWritesAllowed = true;
  const capturedAction = (await tool(actionTools[0], captureAction)).structuredContent;
  assert.equal(capturedAction.state, "captured");
  assert.deepEqual(capturedAction.action, captureAction.action);
  assert.deepEqual(capturedAction.selection, { coordinateSystem: "prosemirror", from: 3, to: 8 });
  assert.deepEqual(capturedAction.effectiveTarget, { coordinateSystem: "prosemirror", from: 1, to: 12 });
  assert.equal(editorActionsStarted, 0, "Capturing unexpectedly started generation.");
  assert.deepEqual((await tool(actionTools[0], captureAction)).structuredContent, capturedAction, "Identical capture retry changed identity.");
  assert.equal((await tool(actionTools[0], { ...captureAction, action: { kind: "write", amount: "sentence" } })).isError, true);
  for (const override of [{ editor_target_id: "unknown" }, { note_id: "foreign" }, { space_id: "foreign" }]) assert.equal((await tool(actionTools[0], { ...captureAction, ...override })).isError, true);
  const startAction = { space_id: spaceId, note_id: noteId, editor_target_id: editorActionTarget.id, request_id: "start-tighten", capture_id: capturedAction.captureId, expected_document_version: capturedAction.documentVersion };
  editorActionAIAllowed = false; editorActionWritesAllowed = false;
  assert.equal((await tool(actionTools[1], startAction)).isError, true, "Start ignored missing API/write grants.");
  editorActionAIAllowed = true;
  assert.equal((await tool(actionTools[1], startAction)).isError, true, "Start ignored missing write grant.");
  editorActionWritesAllowed = true;
  assert.equal((await tool(actionTools[1], { ...startAction, expected_document_version: "displayed-v1:other" })).isError, true);
  assert.equal((await tool(actionTools[1], { ...startAction, capture_id: "other" })).isError, true);
  const actionStarted = (await tool(actionTools[1], startAction)).structuredContent;
  assert.equal(actionStarted.id, capturedAction.id); assert.equal(actionStarted.state, "submitted");
  assert.equal(editorActionsStarted, 1);
  assert.deepEqual((await tool(actionTools[1], startAction)).structuredContent, actionStarted);
  assert.equal(editorActionsStarted, 1, "Uncertain start replayed generation.");
  assert.equal((await tool(actionTools[1], { ...startAction, request_id: "second-start" })).isError, true, "Fresh request ID reused a consumed capture.");
  const actionLookup = { space_id: spaceId, action_id: actionStarted.id };
  const actionRecord = editorActions.get(actionStarted.id);
  for (const state of ["generating", "awaiting_review", "accepting", "accepted_in_editor", "save_failed"]) {
    actionRecord.receipt = { ...actionRecord.receipt, state, ...(state === "generating" ? { stage: "writing" } : {}) };
    assert.equal((await tool(actionTools[2], actionLookup)).structuredContent.state, state);
  }
  assert.equal((await tool(actionTools[3], actionLookup)).isError, true, "Cancellation must refuse an already claimed acceptance.");
  actionRecord.receipt = { ...actionRecord.receipt, state: "saved", result: { noteId, version: "v1-0123456789abcdef", url: `orion://open?space_id=${encodeURIComponent(spaceId)}&note_id=${encodeURIComponent(noteId)}`, citation: `[Saved note](orion://open?space_id=${encodeURIComponent(spaceId)}&note_id=${encodeURIComponent(noteId)})` } };
  assert.equal((await tool(actionTools[2], actionLookup)).structuredContent.state, "saved");
  assert.equal((await tool(actionTools[3], actionLookup)).isError, true);
  assert.equal((await tool(actionTools[2], { ...actionLookup, space_id: "foreign" })).isError, true);
  for (const corruption of ["foreign-space", "extra", "extra-action", "identity", "range", "partial-metadata", "foreign-result", "foreign-citation", "extra-result"]) {
    editorActionCorruption = corruption;
    assert.equal((await tool(actionTools[2], actionLookup)).isError, true, `Unsafe action receipt accepted: ${corruption}`);
  }
  editorActionCorruption = undefined;
  for (const corruption of ["foreign-target", "foreign-action"]) {
    editorActionCorruption = corruption;
    assert.equal((await tool(actionTools[0], captureAction)).isError, true, `Capture changed: ${corruption}`);
  }
  editorActionCorruption = "start-capture";
  assert.equal((await tool(actionTools[1], startAction)).isError, true);
  editorActionCorruption = undefined;
  const boundedCapture = { ...captureAction, request_id: "capture-unicode", action: { kind: "image", quality: "detailed", context: "space", instruction: "🧭".repeat(1250) } };
  const boundedAction = (await tool(actionTools[0], boundedCapture)).structuredContent;
  assert.equal(boundedAction.action.instruction.length, 2500, "Unicode instruction was byte- or UTF-16 truncated.");
  assert.equal((await tool(actionTools[3], { space_id: spaceId, action_id: boundedAction.id })).structuredContent.state, "cancelled");
  assert.equal((await tool(actionTools[0], boundedCapture)).structuredContent.state, "cancelled", "Capture replay resurrected cancelled work.");
  assert.equal((await tool(actionTools[1], { ...startAction, request_id: "cancelled-start", capture_id: boundedAction.captureId })).isError, true);
  editorActionCorruption = "saved-early";
  assert.equal((await tool(actionTools[2], { space_id: spaceId, action_id: boundedAction.id })).isError, true, "Unaccepted action advertised a saved result.");
  editorActionCorruption = undefined;
  const cancellableCapture = { ...captureAction, request_id: "capture-cancellable", action: { kind: "write", amount: "paragraph" } };
  const cancellableAction = (await tool(actionTools[0], cancellableCapture)).structuredContent;
  const cancellableStart = { ...startAction, request_id: "start-cancellable", capture_id: cancellableAction.captureId };
  assert.equal((await tool(actionTools[1], cancellableStart)).structuredContent.state, "submitted");
  editorActions.get(cancellableAction.id).receipt.state = "awaiting_review";
  const cancelledAction = (await tool(actionTools[3], { space_id: spaceId, action_id: cancellableAction.id })).structuredContent;
  assert.equal(cancelledAction.state, "cancelled");
  const startCountAfterCancel = editorActionsStarted;
  assert.deepEqual((await tool(actionTools[1], cancellableStart)).structuredContent, cancelledAction, "Start retry resurrected a cancelled preview.");
  assert.equal(editorActionsStarted, startCountAfterCancel);
  editorActionAllowed = false;
  assert.deepEqual((await tool("orion_get_capabilities")).structuredContent.editorActionTargets, []);
  assert.equal((await tool(actionTools[2], actionLookup)).isError, true);
  editorActionAllowed = true;
  editorActionNeverResponds = true;
  const uncertainCapture = { ...captureAction, request_id: "capture-uncertain" };
  const actionWaitStarted = Date.now(), actionWait = tool(actionTools[0], uncertainCapture);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal((await bridgeProbe("capabilities")).result.available, true, "Editor capture polling blocked unrelated native requests.");
  assert.equal((await actionWait).isError, true);
  assert(Date.now() - actionWaitStarted < 4500, "Editor capture wait exceeded dispatch bound.");
  const capturedCount = editorActionSequence;
  editorActionNeverResponds = false;
  assert.equal((await tool(actionTools[0], uncertainCapture)).structuredContent.state, "captured");
  assert.equal(editorActionSequence, capturedCount, "Uncertain capture retry created a new action.");
  const freshBeforeChange = (await tool(actionTools[0], { ...captureAction, request_id: "capture-before-change" })).structuredContent;
  editorActionDocumentVersion = "displayed-v1:changed";
  assert.equal((await tool(actionTools[1], { ...startAction, request_id: "start-after-change", capture_id: freshBeforeChange.captureId })).isError, true, "Stale captured document was retargeted.");
  assert.equal((await tool(actionTools[1], startAction)).structuredContent.state, "saved", "Exact historical retry should return the already retained receipt without reapplying.");

  const otherVault = join(directory, "other.json"); await writeFile(otherVault, original);
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, vault_path: otherVault }));
  const beforeMismatch = calls.length;
  assert.equal((await tool("orion_get_context", { space_id: spaceId, request_id: "wrong-vault", query: "Find" })).isError, true);
  assert.equal(calls.length, beforeMismatch, "A vault override reached the wrong app.");
  assert.equal((await tool("orion_propose_note_edit", proposal)).isError, true);
  assert.equal(calls.length, beforeMismatch, "A review reached a mismatched library.");
  assert.equal(await readFile(vaultPath, "utf8"), original, "The bridge harness changed its fixture vault.");
  assert.equal((await tool(voiceNames[0], voiceScope)).isError, true);
  assert.equal(calls.length, beforeMismatch, "A voice request reached a mismatched library.");
  assert.equal((await tool(actionTools[2], actionLookup)).isError, true);
  assert.equal(calls.length, beforeMismatch, "An editor action reached a mismatched library.");
  console.log(`MCP workflow/review/context/voice/editor-action transport verified: 55 tool schemas, typed dispatch, strict bounded validation, ${actualProjections.length} actual renderer projections through native validation (Unicode exact titles, 1-character budget, history/stale withholding), target/revision and pagination transport, separate acceptance/save receipts, permission-error propagation, bounded nonblocking mailbox polling, exact replay after timeout, capture-before-start and immutable action transport, strict result validation, no automatic acceptance, descriptor protection, vault identity, zero fixture writes and no credential output. Native/UI states and permissions are simulated; no live acceptance claimed.`);
} finally {
  child?.kill();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
