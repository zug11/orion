import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { createServer } from "node:net";
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
      if (input.method === "capabilities") result = { available: true, access: { enabled: true, allowAI: true, allowWrites: true, spaceIds: [spaceId] } };
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
  const beforeInvalid = calls.length;
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
  const otherVault = join(directory, "other.json"); await writeFile(otherVault, original);
  await writeFile(descriptorPath, JSON.stringify({ ...descriptor, vault_path: otherVault }));
  const beforeMismatch = calls.length;
  assert.equal((await tool("orion_get_context", { space_id: spaceId, request_id: "wrong-vault", query: "Find" })).isError, true);
  assert.equal(calls.length, beforeMismatch, "A vault override reached the wrong app.");
  assert.equal(await readFile(vaultPath, "utf8"), original, "The bridge harness changed its fixture vault.");
  console.log("MCP workflow transport verified: availability, typed dispatch, scoping, results, cancellation, descriptor protection, vault identity, and no credential output.");
} finally {
  child?.kill();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
