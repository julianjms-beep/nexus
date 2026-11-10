// NEXUS worker node. Runs on any machine; owns its private key; enforces its OWN local policy regardless of what the gateway says.
import tls from "node:tls";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { Audit } from "./audit.ts";
import { Security } from "./security.ts";
import { Sandbox, RUNNERS, type SandboxLimits } from "./sandbox.ts";
import { ClaudeCodeAdapter } from "./adapter.ts";
import { detectIsolation, type Isolation } from "./isolation.ts";
import { Pki, generateKeyAndCsr, certInfo, shouldRenew } from "./pki.ts";
import { FrameReader, sendFrame, validateFrame, GATEWAY_MESSAGES, PROTOCOL_VERSION, chunkBuffer, sanitizeText, type Frame } from "./protocol.ts";
import { unpackToDir, collectChanges, sha256, LIMITS, TransferError, type Manifest } from "./transfer.ts";
import type { EnrollmentBundle } from "./gateway.ts";

export type WorkerPolicy = {
  allowKinds: ("sandbox" | "agent")[];
  /** Agent jobs run Claude Code UNSANDBOXED on this host with this host's own Claude login. Off unless the operator opts in. */
  allowAgentJobs: boolean;
  allowedTools: string[];
  maxConcurrent: number;
  ceilings: SandboxLimits & { maxBudgetUsd: number };
};
export const DEFAULT_POLICY: WorkerPolicy = {
  allowKinds: ["sandbox"], allowAgentJobs: false, allowedTools: ["Read", "Glob", "Grep", "Edit", "Write"], maxConcurrent: 2,
  ceilings: { cpuSeconds: 120, memoryMb: 1024, timeoutMs: 300_000, maxProcesses: 64, maxOutputBytes: 1_000_000, maxFileMb: 32, maxBudgetUsd: 1 },
};
type Running = { jobId: string; executionId: string; fence: number };
type JobCtx = Running & { spec: any; manifest: Manifest; archive: { bytes: number; sha256: string; chunks: number }; chunks: Buffer[]; state: "receiving" | "running"; cancel?: () => void; killed?: boolean };

const clampTo = (v: unknown, ceiling: number, min = 1) => Math.max(min, Math.min(ceiling, typeof v === "number" && Number.isFinite(v) ? v : ceiling));
const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);
const isIp = (h: string) => net.isIP(h) !== 0;

export class WorkerNode extends EventEmitter {
  readonly policy: WorkerPolicy; readonly audit: Audit; isolation: Isolation;
  private sock?: tls.TLSSocket; private hb?: NodeJS.Timeout; private renewTimer?: NodeJS.Timeout; private reconnectTimer?: NodeJS.Timeout;
  private stopped = false; private revoked = false; private backoff = 0; private ready = false;
  private jobs = new Map<string, JobCtx>(); private highestFence = new Map<string, number>();
  private pendingRenew?: { keyPem: string };
  private security: Security; private sandbox: Sandbox;
  private server: { host: string; port: number; workerId: string };
  private selfTestDone: Promise<void> = Promise.resolve();
  constructor(readonly dir: string, private opts: { reconnectMs?: number; renewCheckMs?: number; simulatePlatform?: string; claudeBin?: string; selfTest?: boolean } = {}) {
    super();
    this.server = JSON.parse(fs.readFileSync(path.join(dir, "identity", "server.json"), "utf8"));
    this.policy = { ...DEFAULT_POLICY, ...JSON.parse(fs.readFileSync(path.join(dir, "policy.json"), "utf8")) };
    this.audit = new Audit(path.join(dir, "audit.jsonl"));
    this.security = new Security(this.audit);
    this.sandbox = new Sandbox(dir, this.audit, this.security, this.policy.ceilings);
    // A simulated platform is judged by detectIsolation alone; the real platform asks the sandbox's own provider.
    this.isolation = opts.simulatePlatform ? detectIsolation(opts.simulatePlatform) : this.sandbox.isolation();
  }

  // ------------------------------------------------------------ enrollment (one-time, token authenticated, CA pinned)
  static async enroll(bundle: EnrollmentBundle, dir: string, policy: Partial<WorkerPolicy> = {}): Promise<void> {
    const { keyPem, csrPem } = generateKeyAndCsr(bundle.workerId);
    const { host, port } = bundle.gateway;
    const reply = await new Promise<Frame>((resolve, reject) => {
      const s = tls.connect({ host, port, ca: bundle.caPems, minVersion: "TLSv1.3", rejectUnauthorized: true, ...(isIp(host) ? {} : { servername: host }) });
      const to = setTimeout(() => { s.destroy(); reject(new Error("enrollment timed out")); }, 15_000);
      s.on("error", (e) => { clearTimeout(to); reject(e); });
      new FrameReader(s, (f) => { clearTimeout(to); resolve(f); s.end(); }, (r) => reject(new Error(r)));
      s.on("secureConnect", () => sendFrame(s, { type: "enroll", workerId: bundle.workerId, token: bundle.enrollToken, csrPem, platform: process.platform }));
    });
    if (reply.type !== "enroll.ok") throw new Error(`enrollment failed: ${reply.type === "enroll.denied" ? reply.reason : "unexpected reply"}`);
    const cert = new X509Certificate(reply.certPem);
    if (!cert.checkPrivateKey(createPrivateKey(keyPem))) throw new Error("issued certificate does not match our key");
    if (certInfo(reply.certPem).cn !== bundle.workerId) throw new Error("issued certificate has the wrong identity");
    if (!bundle.caPems.some((ca: string) => cert.verify(new X509Certificate(ca).publicKey))) throw new Error("issued certificate is not signed by the pinned CA");
    const id = path.join(dir, "identity"); fs.mkdirSync(id, { recursive: true, mode: 0o700 }); fs.mkdirSync(path.join(dir, "work"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(id, "key.pem"), keyPem, { mode: 0o600 });
    fs.writeFileSync(path.join(id, "cert.pem"), reply.certPem);
    fs.writeFileSync(path.join(id, "ca.pem"), (reply.caPems as string[]).join("\n"));
    fs.writeFileSync(path.join(id, "server.json"), JSON.stringify({ host, port, workerId: bundle.workerId }));
    fs.writeFileSync(path.join(dir, "policy.json"), JSON.stringify({ ...DEFAULT_POLICY, ...policy }, null, 2));
    new Audit(path.join(dir, "audit.jsonl")).record("worker.enrolled", { workerId: bundle.workerId, notAfter: certInfo(reply.certPem).notAfter.toISOString() });
  }

  // ------------------------------------------------------------ connection
  start() {
    this.stopped = false;
    // The provider must pass its adversarial self-test before this worker advertises isolation (fail closed).
    if (!this.opts.simulatePlatform && this.opts.selfTest !== false && this.isolation.available)
      this.selfTestDone = this.sandbox.selfTest().then((iso) => { this.isolation = iso; if (!iso.available) this.emit("error-log", `isolation self-test failed: ${iso.reason}`); });
    this.selfTestDone.then(() => this.connect()); this.renewTimer = setInterval(() => this.maybeRenew(), this.opts.renewCheckMs ?? 60_000); this.renewTimer.unref(); }
  async stop() {
    this.stopped = true; clearInterval(this.hb); clearInterval(this.renewTimer); clearTimeout(this.reconnectTimer);
    for (const j of this.jobs.values()) { j.killed = true; j.cancel?.(); }
    this.sock?.destroy(); this.ready = false;
  }
  status() { return { connected: this.ready, revoked: this.revoked, running: [...this.jobs.values()].map(({ jobId, executionId, fence, state }) => ({ jobId, executionId, fence, state })), isolation: this.isolation, workerId: this.server.workerId }; }
  private identity() {
    const d = path.join(this.dir, "identity");
    return { key: fs.readFileSync(path.join(d, "key.pem")), cert: fs.readFileSync(path.join(d, "cert.pem"), "utf8"), ca: fs.readFileSync(path.join(d, "ca.pem"), "utf8") };
  }
  private connect() {
    if (this.stopped || this.revoked) return;
    let id; try { id = this.identity(); } catch (e: any) { this.emit("error-log", `identity unreadable: ${e.message}`); return this.scheduleReconnect(); }
    const { host, port } = this.server;
    const s = tls.connect({ host, port, key: id.key, cert: id.cert, ca: id.ca, minVersion: "TLSv1.3", rejectUnauthorized: true, ...(isIp(host) ? {} : { servername: host }) });
    this.sock = s;
    s.on("secureConnect", () => sendFrame(s, { type: "hello", version: PROTOCOL_VERSION, platform: this.opts.simulatePlatform ?? process.platform, isolation: this.isolation,
      kinds: this.policy.allowKinds.filter((k) => k === "sandbox" || this.policy.allowAgentJobs), running: this.runningList() }));
    s.on("error", (e) => this.emit("error-log", e.message));
    s.on("close", () => {
      if (this.sock !== s) return;
      const was = this.ready; this.ready = false; clearInterval(this.hb);
      if (was) { this.audit.record("worker.disconnected", {}); this.emit("disconnected"); }
      this.scheduleReconnect();
    });
    new FrameReader(s, (f) => this.onFrame(f), (r) => { this.emit("error-log", `protocol: ${r}`); s.destroy(); });
  }
  private scheduleReconnect() {
    if (this.stopped || this.revoked) return;
    const base = this.opts.reconnectMs ?? 1000; this.backoff = Math.min(this.backoff ? this.backoff * 2 : base, 10_000);
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
  }
  private runningList(): Running[] { return [...this.jobs.values()].map(({ jobId, executionId, fence }) => ({ jobId, executionId, fence })); }
  private send(f: Frame) { return this.sock ? sendFrame(this.sock, f) : false; }

  private onFrame(f: Frame) {
    const bad = validateFrame(f, GATEWAY_MESSAGES);
    if (bad) { this.emit("error-log", `bad frame from gateway: ${bad}`); return this.sock?.destroy(); }
    switch (f.type) {
      case "hello.ok":
        this.ready = true; this.backoff = 0; clearInterval(this.hb);
        this.hb = setInterval(() => this.send({ type: "heartbeat", running: this.runningList(), active: this.jobs.size }), f.heartbeatMs); this.hb.unref();
        this.audit.record("worker.connected", { isolation: this.isolation.mechanism }); this.emit("connected"); break;
      case "bye":
        this.audit.record("worker.bye", { reason: f.reason });
        if (/revoked/i.test(f.reason)) { this.revoked = true; this.emit("revoked"); }
        break;
      case "renew.ok": this.applyRenewal(f); break;
      case "renew.denied": this.pendingRenew = undefined; this.emit("error-log", "renewal denied"); break;
      case "offer": this.onOffer(f); break;
      case "blob": this.onBlob(f); break;
      case "cancel": this.onCancel(f); break;
      case "kill": this.onKill(f); break;
    }
  }

  // ------------------------------------------------------------ certificate renewal / key rotation
  private maybeRenew() { try { if (this.ready && shouldRenew(this.identity().cert)) this.renewNow(); } catch { /* identity unreadable */ } }
  renewNow() {
    if (!this.ready || this.pendingRenew) return false;
    const { keyPem, csrPem } = generateKeyAndCsr(this.server.workerId); // new key every time: renewal IS key rotation
    this.pendingRenew = { keyPem };
    return this.send({ type: "renew", csrPem });
  }
  private applyRenewal(f: Frame) {
    const p = this.pendingRenew; this.pendingRenew = undefined; if (!p) return;
    try {
      const cert = new X509Certificate(f.certPem);
      if (!cert.checkPrivateKey(createPrivateKey(p.keyPem))) throw new Error("renewed certificate does not match the new key");
      if (certInfo(f.certPem).cn !== this.server.workerId) throw new Error("renewed certificate has the wrong identity");
      const cas = f.caPems as string[];
      if (!cas.some((ca) => cert.verify(new X509Certificate(ca).publicKey))) throw new Error("renewed certificate not signed by a CA in the bundle");
      const d = path.join(this.dir, "identity");
      for (const [n, c, m] of [["key.pem", p.keyPem, 0o600], ["cert.pem", f.certPem, 0o644], ["ca.pem", cas.join("\n"), 0o644]] as const) { fs.writeFileSync(path.join(d, n + ".new"), c, { mode: m }); fs.renameSync(path.join(d, n + ".new"), path.join(d, n)); }
      this.audit.record("worker.renewed", { notAfter: certInfo(f.certPem).notAfter.toISOString() });
      this.emit("renewed"); this.sock?.destroy(); // reconnect with the new identity
    } catch (e: any) { this.emit("error-log", `renewal rejected locally: ${e.message}`); }
  }

  // ------------------------------------------------------------ jobs
  private reject(f: { jobId: string; executionId: string; fence: number }, reason: string) {
    this.audit.record("job.rejected", { jobId: f.jobId, executionId: f.executionId, reason }); this.send({ type: "rejected", jobId: f.jobId, executionId: f.executionId, fence: f.fence, reason });
  }
  private onOffer(f: Frame) {
    const { jobId, executionId, fence, spec, manifest, archive } = f as any;
    if (fence < (this.highestFence.get(jobId) ?? 0)) return this.reject(f as any, "stale fencing token");
    const p = this.policy;
    if (this.jobs.size >= p.maxConcurrent) return this.reject(f as any, "worker at capacity");
    if (spec?.kind !== "sandbox" && spec?.kind !== "agent") return this.reject(f as any, "unknown job kind");
    if (!p.allowKinds.includes(spec.kind)) return this.reject(f as any, `policy does not allow ${spec.kind} jobs`);
    if (spec.kind === "agent" && !p.allowAgentJobs) return this.reject(f as any, "policy does not allow agent jobs");
    if (!this.isolation.available) return this.reject(f as any, `isolation unavailable on ${this.isolation.platform}: ${this.isolation.reason ?? "no provider"}`); // never execute without isolation
    if (spec.kind === "sandbox" && !RUNNERS[spec.runner]) return this.reject(f as any, "unknown runner");
    if (!Array.isArray(manifest?.files) || manifest.files.length > LIMITS.maxFiles || (manifest.totalBytes ?? 0) > LIMITS.maxTotalBytes) return this.reject(f as any, "manifest exceeds limits");
    if (!(archive?.bytes > 0) || archive.bytes > LIMITS.maxTotalBytes * 2 || archive.chunks > 400 || typeof archive.sha256 !== "string") return this.reject(f as any, "archive exceeds limits");
    this.highestFence.set(jobId, fence);
    this.jobs.set(jobId, { jobId, executionId, fence, spec, manifest, archive, chunks: [], state: "receiving" });
    this.audit.record("job.accepted", { jobId, executionId, fence, kind: spec.kind, files: manifest.files.length });
    this.send({ type: "accepted", jobId, executionId, fence });
  }
  private ctxFor(f: Frame) { const j = this.jobs.get(f.jobId); return j && j.executionId === f.executionId && j.fence === f.fence ? j : undefined; }
  private onBlob(f: Frame) {
    const j = this.ctxFor(f); if (!j || j.state !== "receiving") return;
    if (f.seq !== j.chunks.length) return this.finish(j, { status: "rejected", error: "blob out of order" });
    j.chunks.push(Buffer.from(f.data, "base64"));
    if (!f.last) return;
    const buf = Buffer.concat(j.chunks); j.chunks = [];
    if (buf.length !== j.archive.bytes || sha256(buf) !== j.archive.sha256) return this.finish(j, { status: "rejected", error: "archive hash mismatch" });
    j.state = "running"; void this.run(j, buf);
  }
  private onCancel(f: Frame) {
    const j = this.ctxFor(f); if (!j) return;
    this.audit.record("job.cancel_requested", { jobId: j.jobId, executionId: j.executionId });
    j.killed = false; j.cancel?.(); if (j.state === "receiving") this.finish(j, { status: "cancelled" });
  }
  private onKill(f: Frame) { // stale execution: stop it silently, report nothing
    const j = this.jobs.get(f.jobId); if (!j || (f.executionId && j.executionId !== f.executionId)) return;
    this.audit.record("job.killed_stale", { jobId: j.jobId, executionId: j.executionId }); j.killed = true; j.cancel?.(); this.jobs.delete(j.jobId);
  }
  private finish(j: JobCtx, r: { status: string; error?: string; sandbox?: object; agent?: object; bundle?: Buffer | null }) {
    if (!this.jobs.has(j.jobId) || this.jobs.get(j.jobId) !== j) return; // already killed/finished
    this.jobs.delete(j.jobId);
    const chunks = r.bundle ? chunkBuffer(r.bundle) : [];
    this.audit.record("job.finished", { jobId: j.jobId, executionId: j.executionId, status: r.status, error: r.error });
    this.send({ type: "result", jobId: j.jobId, executionId: j.executionId, fence: j.fence, status: r.status, ...(r.error ? { error: sanitizeText(r.error, 500) } : {}),
      ...(r.sandbox ? { sandbox: r.sandbox } : {}), ...(r.agent ? { agent: r.agent } : {}), ...(r.bundle ? { files: { bytes: r.bundle.length, sha256: sha256(r.bundle), chunks: chunks.length } } : {}) });
    chunks.forEach((data, seq) => this.send({ type: "blob", jobId: j.jobId, executionId: j.executionId, fence: j.fence, seq, last: seq === chunks.length - 1, data }));
  }
  private async run(j: JobCtx, archive: Buffer) {
    const scratch = path.join(this.dir, "work", j.executionId); const work = path.join(scratch, "work");
    try {
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      unpackToDir(archive, j.manifest, work);
      const realWork = fs.realpathSync(work); this.security.allowRoot(realWork);
      const c = this.policy.ceilings, req = j.spec.limits ?? {};
      const limits: SandboxLimits = { cpuSeconds: clampTo(req.cpuSeconds, c.cpuSeconds), memoryMb: clampTo(req.memoryMb, c.memoryMb, 16), timeoutMs: clampTo(req.timeoutMs, c.timeoutMs, 500),
        maxProcesses: clampTo(req.maxProcesses, c.maxProcesses, 4), maxOutputBytes: clampTo(req.maxOutputBytes, c.maxOutputBytes, 1000), maxFileMb: clampTo(req.maxFileMb, c.maxFileMb) };
      if (j.spec.kind === "sandbox") {
        const h = this.sandbox.run(realWork, j.spec.runner, limits); j.cancel = h.cancel;
        const r = await h.done;
        return this.finish(j, { status: r.cancelled ? "cancelled" : r.ok ? "succeeded" : "failed",
          sandbox: { ok: r.ok, exitCode: r.exitCode, signal: r.signal, killedBy: r.killedBy ?? null, timedOut: r.timedOut, cancelled: r.cancelled, outputTruncated: r.outputTruncated,
            durationMs: r.durationMs, summary: r.summary, stdout: tail(r.stdout, 60_000), stderr: tail(r.stderr, 60_000), limits } });
      }
      // agent job: restricted tools, scrubbed env, scratch cwd containing only the snapshot
      const role = j.spec.role ?? {};
      const tools = (Array.isArray(role.tools) ? role.tools : []).filter((t: unknown) => typeof t === "string" && this.policy.allowedTools.includes(t));
      let ev: any; const adapter = new ClaudeCodeAdapter(this.opts.claudeBin ?? "claude");
      const h = adapter.run({ cwd: realWork, prompt: String(j.spec.prompt ?? "").slice(0, 100_000), timeoutMs: limits.timeoutMs, maxBudgetUsd: clampTo(role.maxBudgetUsd, c.maxBudgetUsd, 0.01),
        allowedTools: tools, systemPrompt: sanitizeText(role.systemPrompt, 4000), onEvent: (e: any) => { if (e?.type === "result") ev = e; } });
      j.cancel = h.cancel;
      const r = await h.done;
      let bundle: Buffer | null = null;
      if (r.ok) { try { bundle = collectChanges(realWork, j.manifest).bundle; } catch (e: any) { return this.finish(j, { status: "failed", error: `could not collect changes: ${e.message}` }); } }
      const u = ev?.usage ?? {};
      return this.finish(j, { status: r.reason === "cancelled" ? "cancelled" : r.ok ? "succeeded" : "failed", bundle,
        agent: { ok: r.ok, result: sanitizeText(r.result, 20_000), reason: r.reason ? sanitizeText(r.reason, 500) : null, costUsd: Number(ev?.total_cost_usd) || 0, inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0, cacheCreationTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, model: ev?.modelUsage ? Object.keys(ev.modelUsage).join(",") : null } });
    } catch (e: any) {
      this.finish(j, { status: "failed", error: e instanceof TransferError ? `transfer: ${e.message}` : String(e?.message ?? e) });
    } finally {
      try { this.security.revokeRoot(work); } catch { /* ignore */ }
      fs.rmSync(scratch, { recursive: true, force: true }); // each job leaves nothing behind
    }
  }
}
void os; void Pki;
