// Plans executed on a REAL worker process: agents (fixture claude on the worker), sandbox runs (real Seatbelt + Python),
// worktrees (real git). The model is the only fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createApp } from "../src/server.ts";
import { ClaudeCodeAdapter } from "../src/adapter.ts";
import { WorkerNode } from "../src/worker.ts";
import type { Plan, Run } from "../src/workflow.ts";

const CLI = path.resolve(import.meta.dirname, "../src/worker-cli.ts");
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wfr-")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown, ms = 20_000, what = "condition") { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(40); } }

function fakeClaude(dir: string) {
  const f = path.join(dir, "fake-claude"); const log = path.join(dir, "worker-claude-calls.log");
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv; const prompt = a[a.indexOf("-p") + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ head: prompt.slice(0, 60), fix: prompt.includes("Structured failure report"), cwd: process.cwd() }) + "\\n");
if (prompt.includes("MAKE_BUGGY")) fs.writeFileSync("calc.py", "def add(a, b):\\n    return a - b\\n");
if (prompt.includes("MAKE_TESTS")) fs.writeFileSync("test_calc.py", "import unittest\\nfrom calc import add\\nclass T(unittest.TestCase):\\n    def test_add(self):\\n        self.assertEqual(add(2, 3), 5)\\n");
if (prompt.includes("Structured failure report")) fs.writeFileSync("calc.py", "def add(a, b):\\n    return a + b\\n");
console.log(JSON.stringify({ type: "result", is_error: false, result: "done", total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 1 } }));
`, { mode: 0o755 });
  return { bin: f, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}
async function setup() {
  const base = tmp(); const proj = path.join(base, "proj"); fs.mkdirSync(proj); fs.writeFileSync(path.join(proj, "README.md"), "demo\n");
  g(proj, "init", "-q", "-b", "main"); g(proj, "add", "-A"); g(proj, "commit", "-qm", "init");
  const fc = fakeClaude(base);
  const app = createApp(path.join(base, "ctl"), { "claude-code": new ClaudeCodeAdapter("/bin/false") }, { gateway: { port: 0, heartbeatMs: 300, leaseMs: 1500, graceMs: 60_000 }, remote: { queueTimeoutMs: 2000, acceptTimeoutMs: 3000, cancelGraceMs: 2000 } });
  await app.gateway!.start(); app.orch.addProject("p", proj);
  const procs: ChildProcess[] = []; const nodes: WorkerNode[] = [];
  const cleanup = async () => { for (const p of procs) p.kill("SIGKILL"); for (const n of nodes) await n.stop(); await app.gateway!.stop(); };
  const worker = async (name: string) => {
    const { worker: rec, bundle } = app.gateway!.createWorker({ name, kinds: ["sandbox", "agent"] }); app.gateway!.grantProject(rec.id, proj);
    const dir = path.join(base, name); await WorkerNode.enroll(bundle, dir, { allowAgentJobs: true, allowKinds: ["sandbox", "agent"] });
    const p = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "run", "--dir", dir, "--reconnect-ms", "250", "--claude-bin", fc.bin], { stdio: ["ignore", "ignore", "inherit"] }); procs.push(p);
    await until(() => app.gateway!.connection(rec.id), 15_000, `${name} connected`); return { rec, p, dir };
  };
  const finished = (id: string) => new Promise<Run>((res) => { const chk = (r: Run) => r.id === id && r.status !== "running" && (app.wf.off("run", chk), res(r)); const cur = app.wf.getRun(id)!; if (cur.status !== "running") return res(cur); app.wf.on("run", chk); });
  const types = () => app.audit.read().map((x) => x.type);
  return { base, proj, app, fc, cleanup, worker, finished, types };
}
const plan = (maxIterations = 3): Plan => ({ goal: "add function with tests", steps: [
  { id: "dev", agent: "developer", prompt: "MAKE_BUGGY implement add", dependsOn: [], expectFiles: ["calc.py"] },
  { id: "tests", agent: "testing", prompt: "MAKE_TESTS for add", dependsOn: ["dev"], expectFiles: ["test_calc.py"] },
  { id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations, agent: "sandbox", prompt: "", dependsOn: ["tests"] } ] });

test("a whole plan runs on a separate worker: remote agents, remote sandbox, fix loop, fenced output, verified branch, human integration", async (t) => {
  const e = await setup(); t.after(e.cleanup); const w = await e.worker("remote1");
  const run = await e.finished(e.app.wf.run(e.proj, plan(3), { execution: "remote" }).id);
  assert.equal(run.status, "succeeded", JSON.stringify(run.steps)); assert.equal(run.execution, "remote");
  const v = run.steps.find((s) => s.id === "verify")!; assert.equal(v.iterations!.length, 2); assert.equal(v.iterations![0].ok, false); assert.equal(v.iterations![1].ok, true);
  assert.ok(v.iterations!.every((i) => i.remote && i.worker === w.rec.id), "every sandbox run happened on the worker");
  assert.ok(v.iterations![0].summary.failed[0].includes("test_add"), "structured failure came back from the worker's sandbox");
  // all agent work ran on the worker; nothing ran locally
  const calls = e.fc.calls(); assert.equal(calls.length, 3, "dev, tests, fix"); assert.equal(calls.filter((c) => c.fix).length, 1); assert.ok(calls.every((c) => c.cwd.includes(path.join(w.dir, "work"))), "in the worker's scratch dirs");
  assert.ok(!e.types().includes("task.started"), "no local agent task was started"); assert.ok(!e.types().includes("sandbox.run"), "no local sandbox run");
  assert.equal(e.types().filter((x) => x === "remote.job.dispatched").length, 6, "dev, tests, verify, fix, verify, final verification");
  assert.equal(e.types().filter((x) => x === "remote.output_applied").length, 3);
  // costs, with the worker-reported flag
  const s = e.app.usage.summary(); assert.equal(s.byRun[run.id].tasks, 3); assert.ok(e.app.usage.all().every((r) => r.remote?.workerId === w.rec.id));
  assert.ok(e.app.orch.listTasks().filter((x) => x.id.startsWith("remote:")).length === 3, "remote agent tasks appear in the task list");
  // worktree flow is unchanged
  assert.equal(run.verification?.ok, true); assert.equal(run.integration?.verified, true); assert.equal(fs.existsSync(path.join(e.proj, "calc.py")), false, "main tree untouched");
  assert.deepEqual(run.integration!.files.sort(), ["calc.py", "test_calc.py"]);
  assert.equal(e.app.wf.integrate(run.id).state, "merged"); assert.ok(fs.readFileSync(path.join(e.proj, "calc.py"), "utf8").includes("a + b"));
  assert.ok(e.app.audit.verify().ok);
});

test("execution 'remote' never falls back to local; infrastructure failure is not shown to the fix agent as a test failure", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const run = await e.finished(e.app.wf.run(e.proj, plan(3), { execution: "remote" }).id);        // no worker exists
  assert.equal(run.status, "failed"); const dev = run.steps.find((s) => s.id === "dev")!; assert.equal(dev.status, "failed"); assert.match(dev.reason!, /no eligible worker/);
  assert.ok(!e.types().includes("task.started") && !e.types().includes("sandbox.run") && !e.types().includes("run.remote_fallback_local"), "nothing ran locally");
  assert.equal(e.fc.calls().length, 0);
  // worker dies mid-sandbox: the failure is infrastructure, and the fixer is never consulted
  const w = await e.worker("mortal");
  const slow: Plan = { goal: "g", steps: [{ id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations: 3, agent: "sandbox", prompt: "", dependsOn: [] }] };
  fs.writeFileSync(path.join(e.proj, "test_slow.py"), "import unittest, time\nclass T(unittest.TestCase):\n    def test_slow(self):\n        time.sleep(30)\n"); g(e.proj, "add", "-A"); g(e.proj, "commit", "-qm", "slow test");
  const r2 = e.app.wf.run(e.proj, slow, { execution: "remote" }); await until(() => r2.steps[0].activeSandbox, 10_000, "remote sandbox started"); await sleep(500); w.p.kill("SIGKILL");
  const done = await e.finished(r2.id); const v = done.steps[0];
  assert.equal(done.status, "failed"); assert.match(v.reason!, /remote sandbox could not run the tests/); assert.equal(e.fc.calls().filter((c) => c.fix).length, 0, "no fix attempt was made for an infrastructure failure");
  assert.equal(done.integration?.verified, false);
});

test("execution 'auto' uses a worker when one is eligible and falls back to the local sandbox (audited) when not", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const sbOnly: Plan = { goal: "g", steps: [{ id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations: 1, agent: "sandbox", prompt: "", dependsOn: [] }] };
  fs.writeFileSync(path.join(e.proj, "test_ok.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n"); g(e.proj, "add", "-A"); g(e.proj, "commit", "-qm", "test");
  const local = await e.finished(e.app.wf.run(e.proj, sbOnly, { execution: "auto" }).id);
  assert.equal(local.status, "succeeded"); assert.ok(e.types().includes("run.remote_fallback_local")); assert.ok(e.types().includes("sandbox.run")); assert.ok(!local.steps[0].iterations![0].remote);
  const w = await e.worker("late");
  const remote = await e.finished(e.app.wf.run(e.proj, sbOnly, { execution: "auto" }).id);
  assert.equal(remote.status, "succeeded"); assert.equal(remote.steps[0].iterations![0].remote, true); assert.equal(remote.steps[0].iterations![0].worker, w.rec.id);
  assert.throws(() => e.app.wf.run(e.proj, sbOnly, { execution: "sideways" as any }), /execution must be/);
});
