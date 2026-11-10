// Phase 3 acceptance: REAL TLS between independent OS processes, REAL Claude Code running on the worker,
// real Seatbelt sandbox, real git worktrees. Nothing is simulated except that both ends share one Mac.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http"; import tls from "node:tls";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createApp } from "../src/server.ts";
import { Audit } from "../src/audit.ts";
import { FrameReader, sendFrame } from "../src/protocol.ts";

const CLI = path.resolve(import.meta.dirname, "../src/worker-cli.ts");
const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000, what = "condition") => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout: " + what); await sleep(50); } };
let failed = false; const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`); if (!ok) failed = true; };

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-live3-")));
const app = createApp(path.join(base, "control"), undefined, { gateway: { port: 0, heartbeatMs: 500, leaseMs: 3000, graceMs: 60000 }, remote: { queueTimeoutMs: 4000, cancelGraceMs: 3000 } });
const { gateway, remote, wf, audit, usage, orch } = app; const addr = await gateway.start();
console.log(`control pid ${process.pid}; gateway (TLS 1.3 + mTLS) on ${addr.host}:${addr.port}; local API not exposed on this port`);
const procs = [];
const mkProject = (name, files) => { const d = path.join(base, name); fs.mkdirSync(d); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c); g(d, "init", "-q", "-b", "main"); g(d, "add", "-A"); g(d, "commit", "-qm", "init"); orch.addProject(name, d); return fs.realpathSync(d); };
async function startWorker(name, projects, { agent = false } = {}) {
  const { worker, bundle } = gateway.createWorker({ name, kinds: agent ? ["sandbox", "agent"] : ["sandbox"], maxConcurrent: 2 });
  for (const p of projects) gateway.grantProject(worker.id, p);
  const dir = path.join(base, "worker-" + name); fs.mkdirSync(dir); const bf = path.join(dir, "bundle.json"); fs.writeFileSync(bf, JSON.stringify(bundle));
  // async spawn: the gateway lives in THIS process, so blocking the event loop would starve the enrollment it must answer
  const ep = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "enroll", "--bundle", bf, "--dir", path.join(dir, "node"), ...(agent ? ["--allow-agent-jobs"] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  let eo = ""; ep.stdout.on("data", (d) => (eo += d)); ep.stderr.on("data", (d) => (eo += d));
  const code = await new Promise((r) => ep.on("close", r)); if (code !== 0) throw new Error("enroll failed: " + eo);
  const p = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "run", "--dir", path.join(dir, "node"), "--reconnect-ms", "300"], { stdio: ["ignore", "pipe", "inherit"] }); procs.push(p);
  const ev = []; let buf = ""; p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { try { ev.push(JSON.parse(buf.slice(0, i))); } catch {} buf = buf.slice(i + 1); } });
  await until(() => gateway.connection(worker.id), 20000, name + " connected");
  return { rec: worker, p, dir: path.join(dir, "node"), ev, wAudit: () => new Audit(path.join(dir, "node", "audit.jsonl")) };
}

try {
  console.log("\n=== 1. Authenticated communication (independent processes, TLS 1.3 + mTLS) ===");
  const secretKeyFile = path.join(base, "canary-secret.txt"); fs.writeFileSync(secretKeyFile, "TOP-SECRET-CANARY");
  const stats = mkProject("stats", {
    "stats.py": "def mean(xs):\n    return sum(xs) / (len(xs) - 1)\n\ndef median(xs):\n    s = sorted(xs)\n    return s[len(s) // 2]\n",
    "test_stats.py": "import unittest\nfrom stats import mean, median\nclass T(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(mean([2, 4, 6]), 4)\n    def test_median_odd(self):\n        self.assertEqual(median([3, 1, 2]), 2)\n    def test_median_even(self):\n        self.assertEqual(median([1, 2, 3, 4]), 2.5)\n" });
  const w1 = await startWorker("w1", [stats], { agent: true });
  const conn = audit.read().find((e) => e.type === "worker.connected").data;
  check("worker is a different OS process", w1.p.pid !== process.pid, `control ${process.pid}, worker ${w1.p.pid}`);
  check("TLS 1.3 negotiated with mutual authentication", conn.tls === "TLSv1.3", `${conn.tls} ${conn.cipher}`);
  const anon = await new Promise((res) => { const s = tls.connect({ host: addr.host, port: addr.port, ca: gateway.pki.trustedPems(), rejectUnauthorized: true }, () => { new FrameReader(s, () => {}, () => {}); sendFrame(s, { type: "hello", version: 1, platform: "darwin", isolation: { available: true, mechanism: "seatbelt", platform: "darwin" }, kinds: ["sandbox"], running: [] }); s.on("close", () => res("closed")); setTimeout(() => res("open"), 3000); }); s.on("error", () => res("error")); });
  check("a client without a certificate is dropped", anon === "closed" && audit.read().some((e) => e.type === "gateway.connection_dropped" && /may only enroll/.test(e.data.reason)));
  const keyLine = fs.readFileSync(path.join(w1.dir, "identity", "key.pem"), "utf8").split("\n")[1];
  check("worker's private key never reached the control plane", !fs.readdirSync(path.join(base, "control"), { recursive: true }).some((f) => { const full = path.join(base, "control", f); return fs.statSync(full).isFile() && fs.readFileSync(full, "utf8").includes(keyLine); }));

  console.log("\n=== 2. Isolation and resource limits on the worker ===");
  let hits = 0; const srv = http.createServer((_q, s) => { hits++; s.end("x"); }); await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const keyFile = path.join(w1.dir, "identity", "key.pem");
  const hostile = mkProject("hostile", { "test_attack.py": `import unittest, os, sys, socket, time\nclass T(unittest.TestCase):\n    def test_attack(self):\n        for f in [${JSON.stringify(keyFile)}, ${JSON.stringify(secretKeyFile)}, os.path.expanduser("~/.ssh"), os.path.expanduser("~/.claude")]:\n            try:\n                print("LEAK", open(f).read()[:30] if os.path.isfile(f) else os.listdir(f), flush=True)\n            except Exception as e:\n                print("blocked", type(e).__name__, flush=True)\n        try:\n            socket.create_connection(("127.0.0.1", ${srv.address().port}), 3); print("NETLEAK", flush=True)\n        except Exception as e:\n            print("blocked-net", type(e).__name__, flush=True)\n        keep = []\n        for i in range(60):\n            keep.append(b"a" * (25 * 1024 * 1024)); time.sleep(0.05)\n        print("SURVIVED")\n` });
  gateway.grantProject(w1.rec.id, hostile);
  const hj = await remote.submit({ kind: "sandbox", projectPath: hostile, snapshotDir: hostile, runner: "python-unittest", limits: { cpuSeconds: 30, memoryMb: 150, timeoutMs: 30000 } }).done;
  const out = hj.sandbox.stdout + hj.sandbox.stderr;
  check("worker key, canary, ~/.ssh and ~/.claude are unreadable inside the worker's sandbox", !out.includes("LEAK") && !out.includes("PRIVATE KEY") && !out.includes("TOP-SECRET") && (out.match(/blocked /g) ?? []).length >= 4);
  check("network is impossible from the job", !out.includes("NETLEAK") && hits === 0 && /blocked-net/.test(out));
  check("memory limit enforced on the worker", /memory limit/.test(hj.sandbox.killedBy ?? "") && !out.includes("SURVIVED"), hj.sandbox.killedBy);
  const cpuProj = mkProject("cpu", { "test_cpu.py": "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        while True: pass\n" }); gateway.grantProject(w1.rec.id, cpuProj);
  const cj = await remote.submit({ kind: "sandbox", projectPath: cpuProj, snapshotDir: cpuProj, runner: "python-unittest", limits: { cpuSeconds: 2, memoryMb: 256, timeoutMs: 30000 } }).done;
  check("CPU limit enforced on the worker", /cpu limit/.test(cj.sandbox.killedBy ?? ""), cj.sandbox.killedBy);
  srv.close();

  console.log("\n=== 3. Real plan executed on the worker (real Claude Code + sandbox + worktree) ===");
  const plan = { goal: "verify and repair stats module", steps: [{ id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations: 3, agent: "sandbox", prompt: "", dependsOn: [] }] };
  const run = wf.run(stats, plan, { execution: "remote" });
  await until(() => wf.getRun(run.id).status !== "running", 300000, "remote run");
  const r = wf.getRun(run.id); const it = r.steps[0].iterations ?? [];
  console.log("  iterations:", it.map((i) => `#${i.n}:${i.ok ? "PASS" : "FAIL " + JSON.stringify(i.summary.failed)} @${i.worker}`).join(" "));
  check("tests ran on the remote worker, failed on the seeded bugs", it[0]?.ok === false && it[0]?.remote === true && it[0]?.worker === w1.rec.id);
  check("real Claude Code on the worker fixed it from the structured report; rerun passed on the worker", r.status === "succeeded" && it.at(-1)?.ok === true);
  check("returned files were validated and applied only because the execution was current", audit.read().some((e) => e.type === "remote.output_applied"));
  check("verified branch awaiting human integration; main untouched", r.integration?.verified === true && g(stats, "show", "HEAD:stats.py").includes("- 1"));
  const merged = wf.integrate(run.id); check("human-triggered integration merged", merged.state === "merged");
  check("worker scratch directories cleaned up", fs.readdirSync(path.join(w1.dir, "work")).length === 0);

  console.log("\n=== 4. Remote cancellation ===");
  const slow = mkProject("slow", { "test_slow.py": "import unittest, subprocess, time\nclass T(unittest.TestCase):\n    def test_x(self):\n        subprocess.Popen(['/bin/sleep', '31337'])\n        time.sleep(120)\n" }); gateway.grantProject(w1.rec.id, slow);
  const sj = remote.submit({ kind: "sandbox", projectPath: slow, snapshotDir: slow, runner: "python-unittest", limits: { timeoutMs: 120000 } });
  await until(() => remote.listJobs().find((j) => j.id === sj.id)?.status === "running", 20000, "running"); await sleep(800);
  const t0 = Date.now(); sj.cancel(); const so = await sj.done;
  check("job cancelled and confirmed by the worker", so.status === "cancelled" && so.sandbox?.cancelled === true, `${Date.now() - t0}ms`);
  await sleep(400); check("no orphan process left on the worker host", spawnSync("/usr/bin/pgrep", ["-f", "sleep 31337"]).status !== 0);
  check("cancel recorded on both audit chains", w1.wAudit().read().some((e) => e.type === "job.cancel_requested") && audit.read().some((e) => e.type === "remote.job.cancel_requested"));

  console.log("\n=== 5. Recovery from a worker crash ===");
  const w2 = await startWorker("w2", [slow]);
  const nap = mkProject("nap", { "test_nap.py": "import unittest, time\nclass T(unittest.TestCase):\n    def test_x(self):\n        time.sleep(3)\n" }); gateway.grantProject(w1.rec.id, nap); gateway.grantProject(w2.rec.id, nap);
  const nj = remote.submit({ kind: "sandbox", projectPath: nap, snapshotDir: nap, runner: "python-unittest", limits: { timeoutMs: 60000 } });
  await until(() => remote.listJobs().find((j) => j.id === nj.id)?.status === "running", 20000, "running"); const first = remote.listJobs().find((j) => j.id === nj.id);
  const victim = first.worker === w1.rec.id ? w1 : w2; const survivor = victim === w1 ? w2 : w1;
  console.log(`  SIGKILL worker ${victim.rec.id} (pid ${victim.p.pid}) mid-job`); victim.p.kill("SIGKILL");
  const no = await nj.done;
  check("job recovered on the other worker after the lease expired", no.status === "succeeded" && no.workerId === survivor.rec.id && no.attempt === 2, `attempt ${no.attempt} on ${no.workerId}`);
  check("fencing token strictly increased; old execution expired", no.fence > first.fence && audit.read().some((e) => e.type === "remote.execution_expired" && e.data.executionId === first.executionId));

  console.log("\n=== 6. Revocation ===");
  gateway.revokeWorker(survivor.rec.id, "acceptance test");
  await until(() => survivor.ev.some((e) => e.event === "revoked"), 10000, "revoked event");
  const before = survivor.ev.filter((e) => e.event === "connected").length; await sleep(2000);
  check("revoked worker was told and stopped reconnecting", survivor.ev.filter((e) => e.event === "connected").length === before && gateway.listWorkers().find((x) => x.id === survivor.rec.id).status === "revoked");
  const after = await remote.submit({ kind: "sandbox", projectPath: nap, snapshotDir: nap, runner: "python-unittest" }).done;
  check("jobs are no longer assigned to revoked or dead workers", after.status === "error" && /no eligible worker/.test(after.reason), after.reason);

  console.log("\n=== 7. Records ===");
  const types = audit.read().map((e) => e.type); const need = ["gateway.started", "worker.enrolled", "worker.connected", "remote.job.dispatched", "remote.job.result", "remote.job.cancel_requested", "remote.execution_expired", "remote.job.requeued", "worker.revoked", "remote.output_applied"];
  check("control audit chain intact and complete", audit.verify().ok && need.every((x) => types.includes(x)), `${types.length} events`);
  check("worker audit chain intact", w1.wAudit().verify().ok, `${w1.wAudit().read().length} events on w1`);
  const u = usage.summary(); console.log(`  remote agent usage (ESTIMATED, worker-reported, capped): $${u.total.costUsd.toFixed(4)} in ${u.total.tasks} agent call(s); billing: ${u.billing.mode}`);
  check("remote agent usage recorded with the worker-reported flag", usage.all().some((x) => x.remote?.workerId === w1.rec.id));
  console.log("  remote jobs:", remote.listJobs(50).map((j) => `${j.kind}:${j.status}`).join(" "));
} catch (e) { console.log("ERROR", e); failed = true; }
for (const p of procs) p.kill("SIGKILL"); await gateway.stop();
console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: ALL CHECKS PASSED"); process.exit(failed ? 1 : 0);
