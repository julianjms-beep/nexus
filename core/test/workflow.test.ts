// FIXTURE-based tests: a fake `claude` script stands in for the real CLI so scheduling, handoffs,
// validation, locking and approvals can be tested deterministically. The real CLI is exercised
// by core/test/live-phase2.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { ClaudeCodeAdapter } from "../src/adapter.ts";
import { WorkflowEngine, validatePlan, extractJson, type Plan, type Run } from "../src/workflow.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wf-")));

function fake(dir: string) {
  const f = path.join(dir, "fake-claude");
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv;
const prompt = a[a.indexOf("-p") + 1]; const sys = a[a.indexOf("--append-system-prompt") + 1] || "";
const tools = a[a.indexOf("--tools") + 1] || "";
const start = Date.now();
const finish = () => { const m = prompt.match(/WRITEFILE:(\\S+)/); if (m) fs.writeFileSync(m[1], "x");
  if (prompt.includes("BOOM")) { console.log(JSON.stringify({ type: "result", result: "boom", is_error: true })); process.exit(1); }
  const planned = prompt.includes("Decompose") ? fs.readFileSync(${JSON.stringify(path.join(dir, "plan.json"))}, "utf8") : null;
  console.log(JSON.stringify({ type: "result", is_error: false, result: planned ?? JSON.stringify({ role: sys.slice(0, 22), start, end: Date.now(), tools, prompt }) })); process.exit(0); };
const m = prompt.match(/SLEEP:(\\d+)/); setTimeout(finish, m ? Number(m[1]) : 10);
`, { mode: 0o755 });
  return f;
}
function setup() {
  const base = tmp(); const proj = path.join(base, "proj"); fs.mkdirSync(proj);
  const data = path.join(base, "data"); fs.mkdirSync(data);
  const audit = new Audit(path.join(data, "audit.jsonl")); const sec = new Security(audit);
  const orch = new Orchestrator(data, audit, sec, { "claude-code": new ClaudeCodeAdapter(fake(base)) });
  orch.addProject("p", proj);
  const wf = new WorkflowEngine(data, orch, sec, audit);
  return { base, proj, data, audit, sec, orch, wf };
}
const finished = (wf: WorkflowEngine, id: string) => new Promise<Run>((res) => {
  const chk = (r: Run) => r.id === id && r.status !== "running" && (wf.off("run", chk), res(r));
  const cur = wf.getRun(id)!; if (cur.status !== "running") return res(cur); wf.on("run", chk);
});
const out = (r: Run, id: string) => JSON.parse(r.steps.find((s) => s.id === id)!.result!);

test("validatePlan rejects cycles, unknown agents/deps, bad paths, planner and oversize plans", () => {
  const ok = (id: string) => ["developer", "security", "planner"].includes(id);
  const s = (id: string, agent = "developer", dependsOn: string[] = []) => ({ id, agent, prompt: "x", dependsOn });
  assert.deepEqual(validatePlan({ goal: "g", steps: [s("a"), s("b", "security", ["a"])] }, ok), []);
  assert.ok(validatePlan({ goal: "g", steps: [s("a", "developer", ["b"]), s("b", "developer", ["a"])] }, ok).includes("dependency cycle"));
  assert.ok(validatePlan({ goal: "g", steps: [s("a", "hacker")] }, ok).length);
  assert.ok(validatePlan({ goal: "g", steps: [s("a", "planner")] }, ok).length);
  assert.ok(validatePlan({ goal: "g", steps: [s("a", "developer", ["zzz"])] }, ok).length);
  assert.ok(validatePlan({ goal: "g", steps: [{ ...s("a"), expectFiles: ["../x"] }] }, ok).length);
  assert.ok(validatePlan({ goal: "g", steps: Array.from({ length: 9 }, (_, i) => s("s" + i)) }, ok).length);
  assert.ok(validatePlan("nope", ok).length);
});

test("extractJson tolerates fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":2} thanks'), { a: 2 });
  assert.equal(extractJson("no json"), undefined);
});

test("sequential handoff: step B receives A's result and its own role's tools only", async () => {
  const { proj, wf } = setup();
  const plan: Plan = { goal: "g", steps: [
    { id: "dev", agent: "developer", prompt: "WRITEFILE:out.txt build it", dependsOn: [], expectFiles: ["out.txt"] },
    { id: "sec", agent: "security", prompt: "review it", dependsOn: ["dev"] } ] };
  const r = await finished(wf, wf.run(proj, plan).id);
  assert.equal(r.status, "succeeded");
  const sec = out(r, "sec");
  assert.ok(sec.prompt.includes("Results from previous steps"));
  assert.ok(sec.prompt.includes("WRITEFILE:out.txt"), "A's output reached B");
  assert.ok(!sec.tools.includes("Edit") && !sec.tools.includes("Write") && !sec.tools.includes("Bash"), "security agent is read-only");
  assert.ok(out(r, "dev").tools.includes("Edit"));
});

test("independent read-only steps run in parallel", async () => {
  const { proj, wf } = setup();
  const plan: Plan = { goal: "g", steps: [
    { id: "r1", agent: "research", prompt: "SLEEP:600", dependsOn: [] },
    { id: "r2", agent: "security", prompt: "SLEEP:600", dependsOn: [] } ] };
  const r = await finished(wf, wf.run(proj, plan).id);
  const a = out(r, "r1"), b = out(r, "r2");
  assert.ok(a.start < b.end && b.start < a.end, "time ranges overlap");
});

test("write-capable steps are serialized per project", async () => {
  const { proj, wf } = setup();
  const plan: Plan = { goal: "g", steps: [
    { id: "w1", agent: "developer", prompt: "SLEEP:500", dependsOn: [] },
    { id: "w2", agent: "documentation", prompt: "SLEEP:500", dependsOn: [] } ] };
  const r = await finished(wf, wf.run(proj, plan).id);
  assert.equal(r.status, "succeeded");
  const a = out(r, "w1"), b = out(r, "w2");
  assert.ok(a.end <= b.start || b.end <= a.start, "no overlap between writers");
});

test("a failed step skips dependents and fails the run; independent steps still finish", async () => {
  const { proj, wf } = setup();
  const plan: Plan = { goal: "g", steps: [
    { id: "bad", agent: "developer", prompt: "BOOM", dependsOn: [] },
    { id: "after", agent: "security", prompt: "x", dependsOn: ["bad"] },
    { id: "free", agent: "research", prompt: "x", dependsOn: [] } ] };
  const r = await finished(wf, wf.run(proj, plan).id);
  const st = Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
  assert.deepEqual(st, { bad: "failed", after: "skipped", free: "succeeded" });
  assert.equal(r.status, "failed");
});

test("result validation: missing expected file fails the step even if the agent claims success", async () => {
  const { proj, wf } = setup();
  const r = await finished(wf, wf.run(proj, { goal: "g", steps: [{ id: "d", agent: "developer", prompt: "I did it", dependsOn: [], expectFiles: ["nope.txt"] }] }).id);
  assert.equal(r.steps[0].status, "failed");
  assert.match(r.steps[0].reason!, /expected file missing/);
});

test("approval checkpoint blocks until a human decides; rejection fails the step", async () => {
  const { proj, wf, sec } = setup();
  const plan: Plan = { goal: "g", steps: [{ id: "d", agent: "developer", prompt: "x", dependsOn: [], approval: true }] };
  const run = wf.run(proj, plan);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(run.steps[0].status, "awaiting_approval");
  assert.equal(sec.pendingApprovals().length, 1);
  sec.decide(sec.pendingApprovals()[0].id, false);
  assert.equal((await finished(wf, run.id)).steps[0].reason, "rejected at approval checkpoint");

  const run2 = wf.run(proj, plan);
  await new Promise((r) => setTimeout(r, 200));
  sec.decide(sec.pendingApprovals()[0].id, true);
  assert.equal((await finished(wf, run2.id)).status, "succeeded");
});

test("cancelling a run stops running tasks and releases approval waits", async () => {
  const { proj, wf, sec } = setup();
  const run = wf.run(proj, { goal: "g", steps: [
    { id: "slow", agent: "research", prompt: "SLEEP:5000", dependsOn: [] },
    { id: "gate", agent: "developer", prompt: "x", dependsOn: [], approval: true } ] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(wf.cancel(run.id), true);
  const r = await finished(wf, run.id);
  assert.equal(r.status, "cancelled");
  assert.equal(sec.pendingApprovals().length, 0);
  // writer lock was released: a new writer step can run
  assert.equal((await finished(wf, wf.run(proj, { goal: "g", steps: [{ id: "w", agent: "developer", prompt: "x", dependsOn: [] }] }).id)).status, "succeeded");
});

test("runs outside authorized projects are refused", () => {
  const { base, wf } = setup();
  assert.throws(() => wf.run(base, { goal: "g", steps: [{ id: "a", agent: "developer", prompt: "x", dependsOn: [] }] }), /not authorized/);
});

test("proposePlan returns a validated proposal and rejects an invalid one; nothing runs", async () => {
  const { base, proj, wf, orch } = setup();
  const good = { goal: "g", steps: [{ id: "a", agent: "developer", prompt: "do", dependsOn: [] }] };
  fs.writeFileSync(path.join(base, "plan.json"), JSON.stringify(good));
  const p = await wf.proposePlan(proj, "make a thing");
  assert.deepEqual(p.plan, good);
  assert.equal(wf.listRuns().length, 0);
  fs.writeFileSync(path.join(base, "plan.json"), JSON.stringify({ goal: "g", steps: [{ id: "a", agent: "root", prompt: "do", dependsOn: [] }] }));
  const bad = await wf.proposePlan(proj, "make a thing");
  assert.ok(bad.errors.length && !bad.plan);
  assert.equal(orch.listTasks().filter((t) => t.agent === "planner").length, 2);
});

test("runs persist; interrupted runs become failed after restart", async () => {
  const { proj, data, audit, sec, orch, wf } = setup();
  wf.run(proj, { goal: "g", steps: [{ id: "slow", agent: "research", prompt: "SLEEP:5000", dependsOn: [] }] });
  await new Promise((r) => setTimeout(r, 200));
  const wf2 = new WorkflowEngine(data, orch, sec, audit);
  assert.equal(wf2.listRuns()[0].status, "failed");
  wf.cancel(wf.listRuns()[0].id);
});
