// These tests use a FIXTURE script standing in for the `claude` binary (it emits stream-json lines).
// They verify NEXUS's lifecycle/permission logic, not Claude itself. The real CLI is exercised
// separately by core/test/live-claude.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { ClaudeCodeAdapter, cleanEnv } from "../src/adapter.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-orch-")));

function fakeClaude(dir: string) {
  const f = path.join(dir, "fake-claude");
  fs.writeFileSync(f, `#!/usr/bin/env node
const a = process.argv; const prompt = a[a.indexOf("-p") + 1];
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", cwd: process.cwd(), args: a.slice(2) });
if (prompt === "ENV") { out({ type: "result", result: Object.keys(process.env).sort().join(","), is_error: false }); process.exit(0); }
if (prompt === "FAIL") { out({ type: "result", result: "boom", is_error: true }); process.exit(1); }
if (prompt === "HANG") { setInterval(() => {}, 1000); }
else { out({ type: "result", result: "done:" + prompt, is_error: false }); process.exit(0); }
`, { mode: 0o755 });
  return f;
}
function setup(timeoutMs = 5000) {
  const base = tmp();
  const proj = path.join(base, "proj"); fs.mkdirSync(proj);
  const data = path.join(base, "data");
  const audit = new Audit(path.join(data, "audit.jsonl"));
  const sec = new Security(audit);
  const orch = new Orchestrator(data, audit, sec, { "claude-code": new ClaudeCodeAdapter(fakeClaude(base)) }, { timeoutMs, maxBudgetUsd: 1 });
  orch.addProject("proj", proj);
  return { base, proj, data, audit, orch };
}
const finished = (orch: Orchestrator, id: string) => new Promise<any>((res) => {
  const t = orch.getTask(id)!; if (t.status !== "running") return res(t);
  orch.on("task", (x) => x.id === id && res(x));
});

test("runs a task in the authorized project, records result and audit trail", async () => {
  const { proj, orch, audit } = setup();
  const t = await finished(orch, orch.submit(proj, "hello").id);
  assert.equal(t.status, "succeeded");
  assert.equal(t.result, "done:hello");
  const types = audit.read().map((e) => e.type);
  assert.ok(types.includes("task.started") && types.includes("task.finished"));
  assert.equal(audit.verify().ok, true);
});

test("subprocess gets a scrubbed environment and no Bash tool", async () => {
  process.env.AWS_SECRET_ACCESS_KEY = "should-not-leak";
  const { proj, orch } = setup();
  const t = await finished(orch, orch.submit(proj, "ENV").id);
  assert.ok(!t.result.includes("AWS_SECRET_ACCESS_KEY"));
  assert.equal(Object.keys(cleanEnv()).includes("AWS_SECRET_ACCESS_KEY"), false);
  const args = (await new Promise<string>((res) => { orch.once("event", (e) => res(JSON.stringify(e))); orch.submit(proj, "x"); }));
  assert.ok(!args.includes('"Bash"'));
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "--tools"]) assert.ok(args.includes(flag), flag + " isolates the agent from user config");
});

test("failures are reported as failed, not success", async () => {
  const { proj, orch } = setup();
  const t = await finished(orch, orch.submit(proj, "FAIL").id);
  assert.equal(t.status, "failed");
});

test("tasks outside authorized projects are denied and never spawn", async () => {
  const { base, orch, audit } = setup();
  const t = orch.submit(base, "hello");
  assert.equal(t.status, "denied");
  assert.ok(!audit.read().some((e) => e.type === "task.started"));
});

test("unknown agents are denied", () => {
  const { proj, orch } = setup();
  assert.equal(orch.submit(proj, "hi", "nope").status, "denied");
});

test("cancel stops a hanging task", async () => {
  const { proj, orch } = setup();
  const t = orch.submit(proj, "HANG");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(orch.cancel(t.id), true);
  assert.equal((await finished(orch, t.id)).status, "cancelled");
});

test("timeout kills a hanging task and marks it failed", async () => {
  const { proj, orch } = setup(400);
  const t = await finished(orch, orch.submit(proj, "HANG").id);
  assert.equal(t.status, "failed");
  assert.equal(t.reason, "timeout");
});

test("state survives restart; interrupted tasks become failed", () => {
  const { proj, data, audit, orch } = setup();
  orch.submit(proj, "HANG");
  const sec2 = new Security(audit);
  const orch2 = new Orchestrator(data, audit, sec2, {});
  assert.equal(orch2.listProjects().length, 1);
  assert.equal(orch2.listTasks()[0].status, "failed");
  assert.equal(orch2.listTasks()[0].reason, "orchestrator restarted");
  orch.cancel(orch.listTasks()[0].id);
});

test("home directory cannot be registered as a project", () => {
  const { orch } = setup();
  assert.throws(() => orch.addProject("home", os.homedir()));
});
