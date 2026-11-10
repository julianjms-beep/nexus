// The LLM is a fixture (deterministic buggy code, then a fix); the sandbox, git worktrees, python and
// the workflow engine are all REAL. Real-model behaviour is covered by core/test/live-phase25.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { ClaudeCodeAdapter } from "../src/adapter.ts";
import { Sandbox } from "../src/sandbox.ts";
import { Worktrees } from "../src/worktree.ts";
import { UsageLedger } from "../src/usage.ts";
import { WorkflowEngine, validatePlan, type Plan, type Run } from "../src/workflow.ts";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wfs-")));

function fake(dir: string) {
  const f = path.join(dir, "fake-claude");
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv; const prompt = a[a.indexOf("-p") + 1]; const cwd = process.cwd();
const tools = a[a.indexOf("--tools") + 1] || "";
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, JSON.stringify({ cwd, tools, head: prompt.slice(0, 40) }) + "\\n");
const GOOD = "def add(a, b):\\n    return a + b\\n";
if (prompt.includes("MAKE_BUGGY")) fs.writeFileSync("calc.py", "def add(a, b):\\n    return a - b\\n");
if (prompt.includes("MAKE_TESTS")) fs.writeFileSync("test_calc.py", "import unittest\\nfrom calc import add\\nclass T(unittest.TestCase):\\n    def test_add(self):\\n        self.assertEqual(add(2, 3), 5)\\n");
if (prompt.includes("MAKE_SLOW_TEST")) fs.writeFileSync("test_slow.py", "import unittest, time\\nclass T(unittest.TestCase):\\n    def test_slow(self):\\n        time.sleep(30)\\n");
if (prompt.includes("Structured failure report")) { if (!fs.existsSync("NOFIX")) fs.writeFileSync("calc.py", GOOD); }
console.log(JSON.stringify({ type: "result", is_error: false, result: "done", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
  return f;
}
function setup(opts: { git?: boolean; nofix?: boolean } = {}) {
  const git = opts.git ?? true;
  const base = tmp(); const proj = path.join(base, "proj"); fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, "README.md"), "demo\n"); if (opts.nofix) fs.writeFileSync(path.join(proj, "NOFIX"), "");
  if (git) { g(proj, "init", "-q", "-b", "main"); g(proj, "add", "-A"); g(proj, "commit", "-qm", "init"); }
  const data = path.join(base, "data"); fs.mkdirSync(data);
  const audit = new Audit(path.join(data, "audit.jsonl")); const sec = new Security(audit);
  const bin = fake(base); const usage = new UsageLedger(data, audit, bin);
  const orch = new Orchestrator(data, audit, sec, { "claude-code": new ClaudeCodeAdapter(bin) }, undefined, undefined, usage);
  orch.addProject("p", proj);
  const sandbox = new Sandbox(data, audit, sec, { cpuSeconds: 20, memoryMb: 512, timeoutMs: 20000, maxProcesses: 64, maxOutputBytes: 200000, maxFileMb: 8 });
  const wts = new Worktrees(data, audit, sec);
  const wf = new WorkflowEngine(data, orch, sec, audit, sandbox, wts);
  const calls = () => fs.readFileSync(path.join(base, "calls.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { base, proj, data, audit, sec, orch, sandbox, wts, wf, usage, calls };
}
const finished = (wf: WorkflowEngine, id: string) => new Promise<Run>((res) => {
  const chk = (r: Run) => r.id === id && r.status !== "running" && (wf.off("run", chk), res(r));
  const cur = wf.getRun(id)!; if (cur.status !== "running") return res(cur); wf.on("run", chk);
});
const plan = (maxIterations = 3): Plan => ({ goal: "add function with tests", steps: [
  { id: "dev", agent: "developer", prompt: "MAKE_BUGGY implement add", dependsOn: [], expectFiles: ["calc.py"] },
  { id: "tests", agent: "testing", prompt: "MAKE_TESTS for add", dependsOn: ["dev"], expectFiles: ["test_calc.py"] },
  { id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations, agent: "sandbox", prompt: "", dependsOn: ["tests"] } ] });

test("validatePlan covers sandbox steps", () => {
  const ok = (id: string) => ["developer", "testing"].includes(id);
  const base = { id: "v", kind: "sandbox", runner: "python-unittest", dependsOn: [] } as any;
  assert.deepEqual(validatePlan({ goal: "g", steps: [base] }, ok), []);
  assert.ok(validatePlan({ goal: "g", steps: [{ ...base, runner: "bash" }] }, ok).length, "arbitrary runner");
  assert.ok(validatePlan({ goal: "g", steps: [{ ...base, maxIterations: 99 }] }, ok).length);
  assert.ok(validatePlan({ goal: "g", steps: [{ ...base, fixWith: "planner" }] }, ok).length);
});

test("full loop: buggy code -> sandbox fails -> developer gets structured errors -> fix -> rerun passes -> verified branch", async () => {
  const { proj, wf, sandbox, calls, usage, data } = setup();
  const run = await finished(wf, wf.run(proj, plan(3)).id);
  assert.equal(run.status, "succeeded", JSON.stringify(run.steps));
  const v = run.steps.find((s) => s.id === "verify")!;
  assert.equal(v.iterations!.length, 2);
  assert.equal(v.iterations![0].ok, false); assert.equal(v.iterations![0].summary.failures, 1); assert.ok(v.iterations![0].summary.failed[0].includes("test_add"));
  assert.equal(v.iterations![1].ok, true);
  assert.ok(v.iterations![0].fixTaskId, "a fix task was dispatched");
  // the fix agent received the structured report and had no Bash
  const fixCall = calls().find((c) => c.head.includes("The automated tests failed"));
  assert.ok(fixCall && !fixCall.tools.includes("Bash") && fixCall.tools.includes("Edit"));
  const sbLog = sandbox.getResult(v.iterations![0].sandboxId)!; assert.match(sbLog.stderr, /FAIL: test_add/);
  // isolation: agents ran in the worktree, never in the main project
  assert.ok(calls().every((c) => c.cwd !== proj && c.cwd.includes("worktrees")));
  assert.equal(fs.existsSync(path.join(proj, "calc.py")), false, "main tree untouched");
  // finalisation
  assert.equal(run.verification?.ok, true); assert.equal(run.integration?.verified, true); assert.equal(run.integration?.state, "pending");
  assert.deepEqual(run.integration?.files.sort(), ["calc.py", "test_calc.py"]);
  assert.equal(fs.existsSync(run.workdir), false, "worktree directory cleaned up");
  assert.ok(g(proj, "branch", "--list", run.integration!.branch).length, "branch kept");
  // costs recorded per agent/run
  const s = usage.summary(); assert.equal(s.byRun[run.id].tasks, 3); assert.ok(s.byAgent.developer.tasks === 2 && s.byAgent.testing.tasks === 1);
  assert.ok(fs.readdirSync(path.join(data, "sandbox")).length >= 3, "sandbox logs persisted (2 loop runs + final verification)");
  // controlled integration
  const r = wf.integrate(run.id); assert.equal(r.state, "merged");
  assert.equal(fs.readFileSync(path.join(proj, "calc.py"), "utf8").includes("a + b"), true);
  assert.throws(() => wf.integrate(run.id), /already merged/);
});

test("tests that never pass: bounded by maxIterations, run fails, result is NOT verified", async () => {
  const { proj, wf, calls } = setup({ nofix: true });
  const run = await finished(wf, wf.run(proj, plan(2)).id);
  assert.equal(run.status, "failed");
  const v = run.steps.find((s) => s.id === "verify")!;
  assert.equal(v.status, "failed"); assert.equal(v.iterations!.length, 2); assert.match(v.reason!, /still failing after 2 iteration/);
  assert.equal(calls().filter((c) => c.head.includes("The automated tests failed")).length, 1, "exactly one fix attempt between 2 runs");
  assert.equal(run.integration?.verified, false);
  assert.equal(fs.existsSync(path.join(proj, "calc.py")), false);
});

test("an integration attempt on unverified work is denied and the project stays untouched", async () => {
  const { proj, wf } = setup({ nofix: true });
  const run = await finished(wf, wf.run(proj, plan(1)).id);
  const r = wf.integrate(run.id);
  assert.equal(r.state, "denied"); assert.match(r.note!, /not verified/);
  assert.equal(g(proj, "log", "--oneline").split("\n").length, 1);
});

test("run budget exhaustion stops the fix loop and is recorded", async () => {
  const { proj, wf, usage, audit } = setup();
  usage.setBudgets({ perRunUsd: 0.15, perProjectUsd: 100, totalUsd: 100 }); // each fake call costs 0.1: dev+tests = 0.2 >= 0.15
  const run = await finished(wf, wf.run(proj, plan(3)).id);
  assert.equal(run.status, "failed");
  assert.match(run.steps.find((s) => s.id === "verify")!.reason ?? "", /budget exhausted/);
  assert.ok(audit.read().some((e) => e.type === "budget.exhausted"));
});

test("cancelling a run kills the running sandbox", async () => {
  const { proj, wf } = setup();
  const p: Plan = { goal: "g", steps: [
    { id: "dev", agent: "developer", prompt: "MAKE_SLOW_TEST", dependsOn: [] },
    { id: "verify", kind: "sandbox", runner: "python-unittest", agent: "sandbox", prompt: "", dependsOn: ["dev"], maxIterations: 2 } as any ] };
  const run = wf.run(proj, p);
  for (let i = 0; i < 80 && !run.steps[1].activeSandbox; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(run.steps[1].activeSandbox, "sandbox started");
  assert.equal(wf.cancel(run.id), true);
  assert.equal((await finished(wf, run.id)).status, "cancelled");
});

test("discard deletes the branch; non-git projects run unisolated unless isolation is demanded", async () => {
  const { proj, wf } = setup();
  const run = await finished(wf, wf.run(proj, plan(3)).id);
  wf.discard(run.id); assert.equal(g(proj, "branch", "--list", run.integration!.branch), ""); assert.equal(run.integration!.state, "discarded");

  const plain = setup({ git: false });
  assert.throws(() => plain.wf.run(plain.proj, plan(), { isolate: true }), /not a git repository/);
  const r2 = await finished(plain.wf, plain.wf.run(plain.proj, plan(3)).id);
  assert.equal(r2.isolated, false); assert.equal(r2.status, "succeeded"); assert.equal(r2.integration, undefined);
});
