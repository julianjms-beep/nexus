// Remote execution over REAL TLS. Worker processes are separate OS processes running the real sandbox (Seatbelt) and Python.
// "Fake workers" are authenticated TLS clients that speak the protocol dishonestly, to prove the control plane does not trust them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import zlib from "node:zlib";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Audit } from "../src/audit.ts";
import { Gateway, type GatewayOptions, type WorkerKind } from "../src/gateway.ts";
import { RemoteExecutor, sanitizeSandbox, sanitizeAgent, type ExecutorOptions, type JobInput } from "../src/remote.ts";
import { WorkerNode, DEFAULT_POLICY, type WorkerPolicy } from "../src/worker.ts";
import { FrameReader, sendFrame, chunkBuffer, type Frame } from "../src/protocol.ts";
import { sha256 } from "../src/transfer.ts";

const CLI = path.resolve(import.meta.dirname, "../src/worker-cli.ts");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-rx-")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown, ms = 20_000, what = "condition") { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(40); } }
const PASS = "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n";
const attack = (body: string) => `import unittest, os, sys, socket, subprocess, time\nclass T(unittest.TestCase):\n    def test_attack(self):\n${body.split("\n").map((l) => "        " + l).join("\n")}\n`;

type Env = Awaited<ReturnType<typeof setup>>;
async function setup(gwOpts: GatewayOptions = {}, exOpts: ExecutorOptions = {}) {
  const base = tmp(); const audit = new Audit(path.join(base, "ctl", "audit.jsonl"));
  const gw = new Gateway(path.join(base, "ctl"), audit, { port: 0, heartbeatMs: 300, leaseMs: 1500, graceMs: 60_000, ...gwOpts });
  const addr = await gw.start();
  const remote = new RemoteExecutor(gw, audit, path.join(base, "ctl"), { queueTimeoutMs: 3000, acceptTimeoutMs: 3000, cancelGraceMs: 2000, resultTimeoutMs: 5000, ...exOpts });
  const procs: ChildProcess[] = []; const socks: tls.TLSSocket[] = []; const nodes: WorkerNode[] = []; let n = 0;
  const cleanup = async () => { for (const p of procs) p.kill("SIGKILL"); for (const s of socks) s.destroy(); for (const w of nodes) await w.stop(); await gw.stop(); };
  const project = (files: Record<string, string>) => { const d = path.join(base, "projects", `p${n++}`); fs.mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return fs.realpathSync(d); };
  const enroll = async (name: string, o: { kinds?: WorkerKind[]; projects?: string[]; policy?: Partial<WorkerPolicy>; maxConcurrent?: number } = {}) => {
    const { worker, bundle } = gw.createWorker({ name, kinds: o.kinds ?? ["sandbox"], maxConcurrent: o.maxConcurrent });
    for (const p of o.projects ?? []) gw.grantProject(worker.id, p);
    const dir = path.join(base, name); await WorkerNode.enroll(bundle, dir, o.policy); return { rec: worker, dir };
  };
  /** a real worker as a separate OS process */
  const realWorker = async (name: string, o: Parameters<typeof enroll>[1] & { args?: string[] } = {}) => {
    const w = await enroll(name, o);
    const p = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "run", "--dir", w.dir, "--reconnect-ms", "250", ...(o.args ?? [])], { stdio: ["pipe", "pipe", "inherit"] }); procs.push(p);
    const list: any[] = []; let buf = ""; p.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { try { list.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
    await until(() => list.some((x) => x.event === "connected") && gw.connection(w.rec.id), 15_000, `${name} connected`);
    return { ...w, p, list, count: (e: string) => list.filter((x) => x.event === e).length, auditEvents: () => new Audit(path.join(w.dir, "audit.jsonl")).read() };
  };
  /** an authenticated TLS client that speaks the protocol by hand (and may lie) */
  const fake = async (name: string, o: { kinds?: WorkerKind[]; projects?: string[]; accept?: boolean; isolation?: boolean; beat?: boolean } = {}) => {
    const w = await enroll(name, { kinds: o.kinds, projects: o.projects });
    const d = path.join(w.dir, "identity");
    const sock = tls.connect({ host: "127.0.0.1", port: addr.port, key: fs.readFileSync(path.join(d, "key.pem")), cert: fs.readFileSync(path.join(d, "cert.pem"), "utf8"), ca: fs.readFileSync(path.join(d, "ca.pem"), "utf8"), minVersion: "TLSv1.3", rejectUnauthorized: true });
    socks.push(sock); const frames: Frame[] = []; const offers: Frame[] = []; const blobs: Frame[] = []; const running: any[] = [];
    const send = (f: any) => sendFrame(sock, f);
    new FrameReader(sock, (f) => { frames.push(f); if (f.type === "offer") { offers.push(f); if (o.accept !== false) { send({ type: "accepted", jobId: f.jobId, executionId: f.executionId, fence: f.fence }); running.push({ jobId: f.jobId, executionId: f.executionId, fence: f.fence }); } } if (f.type === "blob") blobs.push(f); }, () => {});
    sock.on("error", () => {});
    await new Promise<void>((r) => sock.on("secureConnect", () => r()));
    send({ type: "hello", version: 1, platform: "darwin", isolation: { available: o.isolation !== false, mechanism: "seatbelt", platform: "darwin" }, kinds: o.kinds ?? ["sandbox"], running: [] });
    await until(() => frames.some((f) => f.type === "hello.ok"), 5000, `${name} hello.ok`);
    const heartbeat = (list: any[]) => send({ type: "heartbeat", running: list, active: list.length });
    if (o.beat !== false) { const timer = setInterval(() => heartbeat(running), 200); timer.unref(); sock.on("close", () => clearInterval(timer)); }
    const sendResult = (offer: Frame, result: object, files?: Buffer) => { const chunks = files ? chunkBuffer(files) : [];
      send({ type: "result", jobId: offer.jobId, executionId: offer.executionId, fence: offer.fence, ...result, ...(files ? { files: { bytes: files.length, sha256: sha256(files), chunks: chunks.length } } : {}) });
      chunks.forEach((data, seq) => send({ type: "blob", jobId: offer.jobId, executionId: offer.executionId, fence: offer.fence, seq, last: seq === chunks.length - 1, data })); };
    return { ...w, sock, frames, offers, blobs, running, send, heartbeat, sendResult, kills: () => frames.filter((f) => f.type === "kill") };
  };
  const sbJob = (projectPath: string, extra: Partial<JobInput> = {}): JobInput => ({ kind: "sandbox", projectPath, snapshotDir: projectPath, runner: "python-unittest", limits: { cpuSeconds: 30, memoryMb: 512, timeoutMs: 30_000 }, ...extra });
  const types = () => audit.read().map((x) => x.type);
  const find = (type: string) => audit.read().filter((x) => x.type === type).map((x) => x.data as any);
  const running = (id: string) => until(() => remote.listJobs().find((j) => j.id === id)?.status === "running", 15_000, "job running");
  return { base, audit, gw, addr, remote, cleanup, project, enroll, realWorker, fake, sbJob, types, find, running };
}

test("a sandbox job runs on an independent worker process and returns a structured, persisted result", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS, "app.py": "x = 1\n" }); const w = await e.realWorker("w1", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj)); const o = await job.done;
  assert.equal(o.status, "succeeded", JSON.stringify(o)); assert.equal(o.workerId, w.rec.id); assert.equal(o.sandbox!.summary.tests, 1); assert.equal(o.attempt, 1); assert.ok(o.executionId && o.fence! > 0);
  assert.equal(e.remote.getResult(job.id).status, "succeeded", "result persisted on the control plane");
  const wa = w.auditEvents().map((x) => x.type); assert.ok(wa.includes("job.accepted") && wa.includes("job.finished") && wa.includes("sandbox.run"), "the worker kept its own audit chain: " + wa.join(","));
  assert.ok(new Audit(path.join(w.dir, "audit.jsonl")).verify().ok);
  assert.deepEqual(fs.readdirSync(path.join(w.dir, "work")), [], "scratch directory removed after the job");
  for (const x of ["remote.job.submitted", "remote.job.dispatched", "remote.job.accepted", "remote.job.result"]) assert.ok(e.types().includes(x), x);
  assert.equal(e.find("remote.job.dispatched")[0].effects, "none"); assert.ok(e.audit.verify().ok);
});

test("failing tests come back as structured failures, not as infrastructure errors", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_bad.py": "import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1, 2)\n" }); await e.realWorker("w1", { projects: [proj] });
  const o = await e.remote.submit(e.sbJob(proj)).done;
  assert.equal(o.status, "failed"); assert.equal(o.sandbox!.summary.failures, 1); assert.ok(o.sandbox!.summary.failed[0].includes("test_x")); assert.match(o.sandbox!.stderr, /AssertionError/);
});

test("isolation holds on the worker: no access to its keys or files, no network", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  let hits = 0; const srv = http.createServer((_q, s) => { hits++; s.end("x"); }); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); t.after(() => srv.close());
  const canary = path.join(e.base, "canary.txt"); fs.writeFileSync(canary, "TOP-SECRET-CANARY");
  const w = await e.realWorker("w1", { projects: [] }); const keyFile = path.join(w.dir, "identity", "key.pem");
  const proj = e.project({ "test_attack.py": attack(`for f in [${JSON.stringify(keyFile)}, ${JSON.stringify(canary)}, ${JSON.stringify(path.join(w.dir, "audit.jsonl"))}]:\n    try:\n        print("LEAK", open(f).read()[:40])\n    except Exception as ex:\n        print("blocked", type(ex).__name__)\ntry:\n    socket.create_connection(("127.0.0.1", ${(srv.address() as any).port}), 3); print("NETLEAK")\nexcept Exception as ex:\n    print("blocked net", type(ex).__name__)\nsys.exit(1)`) });
  e.gw.grantProject(w.rec.id, proj);
  const o = await e.remote.submit(e.sbJob(proj)).done; const out = o.sandbox!.stdout + o.sandbox!.stderr;
  assert.equal(o.status, "failed"); assert.ok(!out.includes("LEAK") && !out.includes("NETLEAK") && !out.includes("PRIVATE KEY") && !out.includes("TOP-SECRET-CANARY"), out); assert.ok((out.match(/blocked/g) ?? []).length >= 4); assert.equal(hits, 0);
});

test("resource limits are enforced on the worker and requests are clamped to its own ceilings", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const policy = { ceilings: { cpuSeconds: 2, memoryMb: 128, timeoutMs: 20_000, maxProcesses: 32, maxOutputBytes: 100_000, maxFileMb: 4, maxBudgetUsd: 0.5 } };
  const p1 = e.project({ "test_mem.py": attack("keep = []\nfor i in range(60):\n    keep.append(b'a' * (25 * 1024 * 1024)); time.sleep(0.05)\nprint('SURVIVED')") });
  const p2 = e.project({ "test_cpu.py": attack("while True: pass") });
  await e.realWorker("w1", { projects: [p1, p2], policy });
  const huge = { cpuSeconds: 600, memoryMb: 4096, timeoutMs: 600_000, maxProcesses: 9999, maxFileMb: 4096 };
  const mem = await e.remote.submit(e.sbJob(p1, { limits: huge })).done; const cpu = await e.remote.submit(e.sbJob(p2, { limits: huge })).done;
  assert.ok(mem.sandbox!.limits.memoryMb <= 128 && mem.sandbox!.limits.cpuSeconds <= 2 && mem.sandbox!.limits.timeoutMs <= 20_000, "requested limits were clamped: " + JSON.stringify(mem.sandbox!.limits));
  assert.match(mem.sandbox!.killedBy ?? "", /memory limit/); assert.ok(!mem.sandbox!.stdout.includes("SURVIVED")); assert.match(cpu.sandbox!.killedBy ?? "", /cpu limit/); assert.equal(cpu.sandbox!.timedOut, false);
});

test("remote cancellation kills the job on the worker and leaves no orphan process", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_slow.py": attack("subprocess.Popen(['/bin/sleep', '31339'])\ntime.sleep(120)") }); const w = await e.realWorker("w1", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj, { limits: { timeoutMs: 120_000 } })); await e.running(job.id); await sleep(700);
  const t0 = Date.now(); job.cancel(); const o = await job.done;
  assert.equal(o.status, "cancelled"); assert.ok(Date.now() - t0 < 2500, "worker confirmed the cancellation quickly: " + (Date.now() - t0) + "ms"); assert.equal(o.sandbox?.cancelled, true);
  await sleep(300); assert.notEqual(spawnSync("/usr/bin/pgrep", ["-f", "sleep 31339"]).status, 0, "no orphan process left on the worker host");
  assert.ok(w.auditEvents().some((x) => x.type === "job.cancel_requested")); assert.ok(e.types().includes("remote.job.cancel_requested"));
  assert.deepEqual(fs.readdirSync(path.join(w.dir, "work")), []);
});

test("separation: projects the worker was not granted are never dispatched; no offer leaves the control plane", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const granted = e.project({ "test_ok.py": PASS }); const other = e.project({ "test_ok.py": PASS }); const w = await e.fake("w1", { projects: [granted] });
  const o = await e.remote.submit(e.sbJob(other)).done;
  assert.equal(o.status, "error"); assert.match(o.reason!, /no eligible worker.*project not granted/); assert.equal(w.offers.length, 0); assert.ok(!e.types().includes("remote.job.dispatched"));
});

test("least information: the worker receives an opaque alias and the explicit file list, never paths or other projects", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS, "src/lib.py": "x=1\n", ".git/config": "[core]", "node_modules/m/i.js": "1" });
  const w = await e.fake("w1", { projects: [proj] }); const job = e.remote.submit(e.sbJob(proj)); await until(() => w.offers.length === 1, 5000, "offer");
  const wire = JSON.stringify(w.frames); const offer = w.offers[0] as any;
  assert.ok(!wire.includes(proj) && !wire.includes(e.base) && !wire.includes(os.homedir()), "no local paths on the wire");
  assert.match(offer.spec.projectAlias, /^p_[0-9a-f]{12}$/); assert.deepEqual(Object.keys(offer.spec).sort(), ["kind", "limits", "projectAlias", "runner"]);
  assert.deepEqual(offer.manifest.files.map((f: any) => f.path), ["src/lib.py", "test_ok.py"], "only manifest files (no .git, no node_modules)");
  for (const f of offer.manifest.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  job.cancel(); await job.done;
});

test("secrets in the project block the dispatch; the report names path and rule, never the value", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const fakeKey = "AKIA" + "ABCDEFGHIJKLMNOP";
  const proj = e.project({ "test_ok.py": PASS, "settings.py": `AWS = "${fakeKey}"\n`, ".env": "A=1\n" }); const w = await e.fake("w1", { projects: [proj] });
  const o = await e.remote.submit(e.sbJob(proj)).done;
  assert.equal(o.status, "rejected"); assert.match(o.reason!, /settings\.py \(aws-access-key\)/); assert.match(o.reason!, /\.env \(env-file\)/); assert.ok(!JSON.stringify(e.audit.read()).includes(fakeKey));
  assert.equal(w.offers.length, 0); assert.ok(e.types().includes("remote.job.blocked_secrets"));
});

test("a worker whose platform has no isolation provider is never assigned, and refuses an offer even if forced", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS }); const w = await e.enroll("windowsish", { projects: [proj] });
  const node = new WorkerNode(w.dir, { simulatePlatform: "win32", reconnectMs: 250 }); node.start(); const stop = node.stop.bind(node); t.after(stop);
  await until(() => e.gw.connection(w.rec.id), 10_000, "connected");
  const view = e.gw.listWorkers().find((x) => x.id === w.rec.id)!; assert.equal(view.isolation?.available, false); assert.match(view.isolation?.reason ?? "", /no isolation mechanism implemented for win32/);
  const o = await e.remote.submit(e.sbJob(proj)).done; assert.equal(o.status, "error"); assert.match(o.reason!, /no isolation/);
  const rejected = new Promise<Frame>((r) => e.gw.on("frame", (_rec: any, f: Frame) => f.type === "rejected" && r(f)));
  e.gw.send(w.rec.id, { type: "offer", jobId: "forced", executionId: "e1", fence: 99, spec: { kind: "sandbox", runner: "python-unittest", projectAlias: "p_x", limits: {} }, manifest: { files: [], totalBytes: 0 }, archive: { bytes: 10, sha256: "x", chunks: 1 } });
  assert.match(((await rejected) as any).reason, /isolation unavailable on win32/);
});

test("agent jobs: refused by the worker's own policy even if the server offers them", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "a.py": "x=1\n" }); const w = await e.enroll("strict", { kinds: ["sandbox", "agent"], projects: [proj] }); // admin allows agent jobs, worker policy does not
  const node = new WorkerNode(w.dir, { reconnectMs: 250 }); node.start(); t.after(() => node.stop()); await until(() => e.gw.connection(w.rec.id), 10_000, "connected");
  const o = await e.remote.submit({ kind: "agent", projectPath: proj, snapshotDir: proj, prompt: "do it", role: { id: "developer", tools: ["Read", "Edit"], systemPrompt: "x", maxBudgetUsd: 0.1 } }).done;
  assert.equal(o.status, "error"); assert.match(o.reason!, /does not allow agent|its policy/);
  const rejected = new Promise<Frame>((r) => e.gw.on("frame", (_rec: any, f: Frame) => f.type === "rejected" && r(f)));
  e.gw.send(w.rec.id, { type: "offer", jobId: "forced2", executionId: "e2", fence: 98, spec: { kind: "agent", projectAlias: "p_x", limits: {} }, manifest: { files: [], totalBytes: 0 }, archive: { bytes: 10, sha256: "x", chunks: 1 } });
  assert.match(((await rejected) as any).reason, /policy does not allow (agent )?(jobs|kinds)|policy does not allow agent/);
});

test("recovery + fencing: a worker that drops the job is replaced by another; its late result is rejected as stale", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS });
  const a = await e.fake("a-flaky", { projects: [proj] }); await e.realWorker("b-solid", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj)); await until(() => a.offers.length === 1, 5000, "offer to flaky worker"); const first = a.offers[0] as any;
  a.running.length = 0; a.heartbeat([]);                              // "I no longer have that job" (restart / crash of the executor inside the worker)
  const o = await job.done;
  assert.equal(o.status, "succeeded"); assert.equal(o.attempt, 2); assert.notEqual(o.workerId, a.rec.id); assert.ok(o.fence! > first.fence, "fencing token strictly increases"); assert.notEqual(o.executionId, first.executionId);
  assert.ok(e.types().includes("remote.execution_expired") && e.types().includes("remote.job.requeued"));
  a.sendResult(first, { status: "succeeded", sandbox: { ok: true, exitCode: 0, summary: { failed: [] }, stdout: "forged", stderr: "" } });
  await until(() => e.find("remote.stale_message_rejected").length >= 1, 5000, "stale rejection");
  assert.equal(e.find("remote.stale_message_rejected")[0].executionId, first.executionId); assert.equal(e.find("remote.job.result").length, 1, "the job settled exactly once");
  assert.equal(o.sandbox!.stdout.includes("forged"), false); assert.ok(a.kills().length >= 1, "the stale worker was told to stop");
});

test("lease expiry: a result arriving after the lease expired is rejected even though no newer attempt exists", async (t) => {
  const e = await setup({ heartbeatMs: 5000, leaseMs: 800 }, { maxAttempts: 1 }); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS }); const a = await e.fake("a-silent", { projects: [proj], beat: false });
  const job = e.remote.submit(e.sbJob(proj)); await until(() => a.offers.length === 1, 5000, "offer"); const offer = a.offers[0] as any;
  const o = await job.done; assert.equal(o.status, "lost"); assert.match(o.reason!, /lease expired/); assert.ok(!o.needsManualDecision, "sandbox runs are effect-free: no manual decision needed");
  a.sendResult(offer, { status: "succeeded", sandbox: { ok: true, exitCode: 0, summary: { failed: [] }, stdout: "late", stderr: "" } });
  await until(() => e.find("remote.stale_message_rejected").length >= 1, 5000, "stale rejection"); assert.match(e.find("remote.stale_message_rejected")[0].why, /settled|expired/);
  assert.equal(e.remote.getResult(job.id).status, "lost");
});

test("jobs with possible external effects (agent) are NEVER retried automatically", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "a.py": "x=1\n" }); const a = await e.fake("a-agent", { kinds: ["sandbox", "agent"], projects: [proj] }); const b = await e.fake("b-agent", { kinds: ["sandbox", "agent"], projects: [proj] });
  const job = e.remote.submit({ kind: "agent", projectPath: proj, snapshotDir: proj, prompt: "p", role: { id: "developer", tools: ["Read"], systemPrompt: "s", maxBudgetUsd: 0.1 } });
  await until(() => a.offers.length + b.offers.length === 1, 5000, "offer"); const holder = a.offers.length ? a : b; holder.running.length = 0; holder.heartbeat([]);
  const o = await job.done;
  assert.equal(o.status, "lost"); assert.equal(o.needsManualDecision, true); assert.equal(o.attempt, 1); assert.match(o.reason!, /never retried automatically/);
  assert.equal(a.offers.length + b.offers.length, 1, "no second attempt on the other eligible worker"); assert.ok(!e.types().includes("remote.job.requeued"));
});

test("crash recovery with real processes: SIGKILL of the worker mid-job -> lease expiry -> the job completes on another worker", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_slowish.py": attack("time.sleep(2.5)") });
  const w1 = await e.realWorker("w1-first", { projects: [proj] }); const w2 = await e.realWorker("w2-second", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj)); await e.running(job.id);
  assert.equal(e.remote.listJobs().find((j) => j.id === job.id)!.worker, w1.rec.id); w1.p.kill("SIGKILL");
  const o = await job.done; assert.equal(o.status, "succeeded", JSON.stringify(o)); assert.equal(o.workerId, w2.rec.id); assert.equal(o.attempt, 2);
  assert.ok(e.find("remote.execution_expired")[0].why.match(/lease expired|reconnected|no longer/)); assert.ok(e.types().includes("remote.job.requeued"));
});

test("revoking a worker mid-job cuts it off immediately; with no other worker the job fails cleanly", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_slow.py": attack("time.sleep(60)") }); const w = await e.realWorker("w1", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj, { limits: { timeoutMs: 120_000 } })); await e.running(job.id); await sleep(500);
  e.gw.revokeWorker(w.rec.id, "test"); await until(() => w.count("revoked") === 1, 5000, "worker saw the revocation");
  const o = await job.done; assert.equal(o.status, "error"); assert.match(o.reason!, /no eligible worker/);
  assert.match(e.find("remote.execution_expired")[0].why, /worker revoked/); assert.ok(e.types().includes("worker.revoked"));
});

test("worker reports are untrusted: control characters, oversized text, absurd numbers and inconsistent claims are sanitised", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "test_ok.py": PASS }); const a = await e.fake("liar", { projects: [proj] });
  const job = e.remote.submit(e.sbJob(proj)); await until(() => a.offers.length === 1, 5000, "offer");
  a.sendResult(a.offers[0], { status: "succeeded", sandbox: { ok: true, exitCode: 1, signal: "X".repeat(500), killedBy: null, timedOut: false, cancelled: false, durationMs: -5,
    summary: { tests: 1e15, failures: -3, failed: ["a".repeat(2000), 5, null, "ok\u001b[2J\u0000"], injected: "x" }, stdout: "A\u0000\u001b[31m" + "B".repeat(150_000), stderr: "", limits: { memoryMb: 1e30, evil: 1 } } });
  const o = await job.done; const sb = o.sandbox!;
  assert.equal(o.status, "failed", "a claimed success with exit code 1 is not trusted"); assert.equal(sb.ok, false);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sb.stdout) && sb.stdout.length <= 60_000); assert.ok(sb.summary.tests! <= 10_000_000 && sb.summary.failures === 0 && sb.durationMs === 0);
  assert.deepEqual(sb.summary.failed.map((x) => x.length), [300, 5]); assert.ok(sb.signal!.length <= 20); assert.deepEqual(Object.keys(sb.limits), ["memoryMb"]); assert.ok(!("injected" in sb.summary));
  assert.equal(sanitizeSandbox("nope"), undefined); assert.equal(sanitizeSandbox({ ok: true, exitCode: 0, killedBy: "boom" })!.ok, false);
  const ag = sanitizeAgent({ ok: true, costUsd: 99999, result: "hi\u0007", inputTokens: -5, outputTokens: 1e30 }, 0.2)!; assert.equal(ag.costUsd, 0.2); assert.equal(ag.reportedCostUsd, 99999); assert.equal(ag.costCapped, true); assert.equal(ag.inputTokens, 0); assert.equal(ag.result, "hi");
});

test("files returned by a worker are validated: traversal, secrets and forged copies are rejected; valid output is fenced", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const proj = e.project({ "a.py": "x=1\n" }); const a = await e.fake("agenty", { kinds: ["sandbox", "agent"], projects: [proj] });
  const bundle = (files: any[]) => zlib.gzipSync(Buffer.from(JSON.stringify({ files })));
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const agentJob = () => e.remote.submit({ kind: "agent", projectPath: proj, snapshotDir: proj, prompt: "p", role: { id: "developer", tools: ["Read", "Write"], systemPrompt: "s", maxBudgetUsd: 0.5 } });
  const ok = { ok: true, result: "done", costUsd: 0.1 };
  const run = async (files: any[]) => { const n = a.offers.length; const j = agentJob(); await until(() => a.offers.length === n + 1, 5000, "offer"); a.sendResult(a.offers[n], { status: "succeeded", agent: ok }, bundle(files)); return j.done; };

  const trav = await run([{ path: "../../escape.txt", data: b64("x"), mode: 0o644 }]); assert.equal(trav.status, "rejected"); assert.match(trav.reason!, /invalid path/); assert.equal(trav.files, undefined);
  const sec = await run([{ path: "notes.txt", data: b64("key=" + "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789"), mode: 0o644 }]); assert.equal(sec.status, "rejected"); assert.match(sec.reason!, /secrets/);
  const git = await run([{ path: ".git/hooks/pre-commit", data: b64("#!/bin/sh"), mode: 0o755 }]); assert.equal(git.status, "rejected");
  assert.ok(e.find("remote.output_rejected").length === 3);
  const good = await run([{ path: "src/new.py", data: b64("y = 2\n"), mode: 0o4755 }]); assert.equal(good.status, "succeeded"); assert.equal(good.files!.length, 1); assert.equal(good.files![0].mode, 0o644);
  assert.equal(e.remote.isCurrent(good), true, "the genuine outcome of the current execution may be applied"); assert.equal(e.remote.isCurrent({ ...good }), false, "a forged/copied outcome object may not");
  assert.equal(e.remote.isCurrent({ ...good, fence: good.fence! + 1 } as any), false);
});

test("agent job end to end on a real worker process (fixture claude): restricted tools, scrubbed env, validated output, capped cost", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  process.env.AWS_SECRET_ACCESS_KEY = "must-not-reach-the-agent";
  const fakeBin = path.join(e.base, "fake-claude"); fs.writeFileSync(fakeBin, `#!/usr/bin/env node
const fs = require("fs"); const a = process.argv;
fs.writeFileSync("hello.py", "print('hello from the worker')\\n");
fs.writeFileSync("args.json", JSON.stringify({ tools: a[a.indexOf("--tools") + 1], strict: a.includes("--strict-mcp-config"), cwdIsScratch: process.cwd().includes("/work/"), env: Object.keys(process.env).sort() }));
console.log(JSON.stringify({ type: "result", is_error: false, result: "created hello.py", total_cost_usd: 0.3, usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { "claude-fixture": {} } }));
`, { mode: 0o755 });
  const proj = e.project({ "README.md": "# demo\n" });
  const policy: Partial<WorkerPolicy> = { allowAgentJobs: true, allowKinds: ["sandbox", "agent"] };
  await e.realWorker("agentw", { kinds: ["sandbox", "agent"], projects: [proj], policy, args: ["--claude-bin", fakeBin] });
  const o = await e.remote.submit({ kind: "agent", projectPath: proj, snapshotDir: proj, prompt: "write hello.py", role: { id: "developer", tools: ["Read", "Edit", "Write", "Bash"], systemPrompt: "be brief", maxBudgetUsd: 0.2 } }).done;
  assert.equal(o.status, "succeeded", JSON.stringify(o)); assert.equal(o.agent!.costUsd, 0.2); assert.equal(o.agent!.reportedCostUsd, 0.3); assert.equal(o.agent!.costCapped, true); assert.equal(o.agent!.model, "claude-fixture");
  assert.deepEqual(o.files!.map((f) => f.path).sort(), ["args.json", "hello.py"]); const info = JSON.parse(o.files!.find((f) => f.path === "args.json")!.content.toString());
  assert.equal(info.tools, "Read,Edit,Write", "Bash was filtered out by the worker's own policy"); assert.equal(info.strict, true); assert.equal(info.cwdIsScratch, true);
  assert.ok(!info.env.includes("AWS_SECRET_ACCESS_KEY") && !info.env.some((k: string) => /SECRET|TOKEN/.test(k)), "scrubbed environment: " + info.env.join(","));
  assert.equal(e.remote.getResult(o.jobId).agent.costUsd, 0.2); assert.equal(e.find("remote.job.dispatched")[0].effects, "unknown");
});
