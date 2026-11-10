// Remote executor: places jobs on authorized workers and keeps them honest.
//
//  * every dispatch is an EXECUTION with a unique executionId and a globally monotonic fencing token
//  * a worker holds a LEASE renewed by heartbeats; an expired lease kills the execution's right to report anything
//  * messages (accepted/result/blobs) from expired, superseded or unknown executions are rejected and audited
//  * only effect-free jobs (sandbox test runs) are retried automatically; anything else fails with needsManualDecision
//  * everything the worker reports is untrusted: schema-checked, clamped, sanitised; returned files pass transfer.validateReturned
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Gateway, WorkerRecord } from "./gateway.ts";
import type { Audit } from "./audit.ts";
import { buildManifest, packBundle, validateReturned, sha256, TransferError, type ReceivedFile, type Manifest } from "./transfer.ts";
import { chunkBuffer, sanitizeText, clampNumber, MAX_FRAME_BYTES, type Frame } from "./protocol.ts";
import { resolveReal } from "./security.ts";

export type Kind = "sandbox" | "agent";
export type Effects = "none" | "unknown" | "external";
/** Retry policy by effect class. Anything that is not provably effect-free is never retried automatically. */
export const EFFECTS: Record<Kind, Effects> = { sandbox: "none", agent: "unknown" };

export type JobInput = {
  kind: Kind; projectPath: string; snapshotDir: string; runId?: string;
  runner?: string; role?: { id: string; tools: string[]; systemPrompt: string; maxBudgetUsd: number }; prompt?: string; limits?: Record<string, number>;
};
export type SandboxReport = { ok: boolean; exitCode: number | null; signal: string | null; killedBy: string | null; timedOut: boolean; cancelled: boolean; outputTruncated: boolean; durationMs: number;
  summary: { tests?: number; failures?: number; errors?: number; failed: string[] }; stdout: string; stderr: string; limits: Record<string, number> };
export type AgentReport = { ok: boolean; result: string; reason: string | null; costUsd: number; reportedCostUsd: number; costCapped: boolean; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; model: string | null };
export type RemoteOutcome = {
  jobId: string; status: "succeeded" | "failed" | "cancelled" | "lost" | "rejected" | "error"; attempt: number; workerId?: string; executionId?: string; fence?: number;
  reason?: string; needsManualDecision?: boolean; sandbox?: SandboxReport; agent?: AgentReport; files?: ReceivedFile[]; workerReported: true;
};
export type RemoteJob = { id: string; done: Promise<RemoteOutcome>; cancel: () => void };

type Exec = { executionId: string; fence: number; workerId: string; state: "offered" | "running" | "expired" | "superseded" | "done"; leaseExpires: number; startedAt: number;
  acceptTimer?: NodeJS.Timeout; pending?: { frame: Frame; parts: Buffer[]; timer: NodeJS.Timeout } };
type Job = { id: string; input: JobInput; alias: string; manifest?: Manifest; archive?: Buffer; archiveSha?: string; attempt: number; offers: number; excluded: Set<string>; avoid: Set<string>;
  current?: Exec; settled: boolean; outcome?: RemoteOutcome; cancelRequested: boolean; queuedAt: number; retryTimer?: NodeJS.Timeout; cancelTimer?: NodeJS.Timeout; resolve: (o: RemoteOutcome) => void; submittedAt: number };

export type ExecutorOptions = { maxAttempts?: number; queueTimeoutMs?: number; acceptTimeoutMs?: number; cancelGraceMs?: number; resultTimeoutMs?: number };

export class RemoteExecutor extends EventEmitter {
  private jobs = new Map<string, Job>();
  readonly o: Required<ExecutorOptions>;
  constructor(private gw: Gateway, private audit: Audit, private dir: string, opts: ExecutorOptions = {}) {
    super();
    this.o = { maxAttempts: 2, queueTimeoutMs: 30_000, acceptTimeoutMs: 10_000, cancelGraceMs: 5_000, resultTimeoutMs: 10_000, ...opts };
    fs.mkdirSync(path.join(dir, "remote"), { recursive: true });
    gw.on("frame", (rec: WorkerRecord, f: Frame) => this.onFrame(rec, f));
    gw.on("hello", (rec: WorkerRecord, f: Frame) => this.onHello(rec, f));
    gw.on("revoked", (rec: WorkerRecord) => this.onRevoked(rec));
    gw.on("sweep", (now: number) => this.onSweep(now));
  }

  // ------------------------------------------------------------ public API
  /** Would some worker accept this kind of job for this project right now? (used by execution: "auto") */
  hasEligible(kind: Kind, projectPath: string): boolean {
    const probe = { input: { kind }, alias: this.gw.registry.alias(resolveReal(projectPath)), excluded: new Set<string>(), avoid: new Set<string>() } as unknown as Job;
    return this.gw.registry.list().some((w) => this.eligible(w, probe));
  }
  getResult(jobId: string) { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "remote", `${jobId}.json`), "utf8")); } catch { return undefined; } }
  listJobs(limit = 30) {
    return [...this.jobs.values()].sort((a, b) => b.submittedAt - a.submittedAt).slice(0, limit).map((j) => ({ id: j.id, kind: j.input.kind, runId: j.input.runId, status: j.settled ? j.outcome!.status : j.current?.state ?? "queued",
      attempt: j.attempt, worker: j.current?.workerId, executionId: j.current?.executionId, fence: j.current?.fence, reason: j.outcome?.reason, submittedAt: new Date(j.submittedAt).toISOString() }));
  }
  /** Fencing check at apply time: may these results still be applied to the project? */
  isCurrent(o: RemoteOutcome): boolean {
    const j = this.jobs.get(o.jobId); const c = j?.current;
    return !!j && j.settled && j.outcome === o && !!c && c.executionId === o.executionId && c.fence === o.fence && c.state === "done";
  }

  submit(input: JobInput): RemoteJob {
    const id = randomUUID(); let resolve!: (o: RemoteOutcome) => void;
    const done = new Promise<RemoteOutcome>((r) => (resolve = r));
    const alias = this.gw.registry.alias(resolveReal(input.projectPath));
    const job: Job = { id, input, alias, attempt: 0, offers: 0, excluded: new Set(), avoid: new Set(), settled: false, cancelRequested: false, queuedAt: Date.now(), submittedAt: Date.now(), resolve };
    this.jobs.set(id, job);
    this.audit.record("remote.job.submitted", { jobId: id, kind: input.kind, alias, runId: input.runId });
    try {
      const real = resolveReal(input.snapshotDir); const b = buildManifest(real);
      if (b.secrets.length) { this.audit.record("remote.job.blocked_secrets", { jobId: id, hits: b.secrets }); // path + rule only, never the value
        this.settle(job, { status: "rejected", reason: `dispatch blocked: secrets detected in ${b.secrets.map((s) => `${s.path} (${s.rule})`).join(", ")}` }); return { id, done, cancel: () => this.cancel(id) }; }
      job.manifest = b.manifest; job.archive = packBundle(real, b.manifest.files); job.archiveSha = sha256(job.archive);
      if (Buffer.byteLength(JSON.stringify(b.manifest)) > MAX_FRAME_BYTES - 20_000) throw new TransferError("manifest too large for one frame: exclude some files");
    } catch (e: any) { this.settle(job, { status: "error", reason: `snapshot failed: ${e.message}` }); return { id, done, cancel: () => this.cancel(id) }; }
    setImmediate(() => this.schedule(job));
    return { id, done, cancel: () => this.cancel(id) };
  }

  cancel(jobId: string) {
    const j = this.jobs.get(jobId); if (!j || j.settled) return false;
    j.cancelRequested = true; this.audit.record("remote.job.cancel_requested", { jobId, executionId: j.current?.executionId });
    const c = j.current;
    if (!c || (c.state !== "offered" && c.state !== "running")) { this.settle(j, { status: "cancelled", reason: "cancelled before dispatch" }); return true; }
    this.gw.send(c.workerId, { type: "cancel", jobId, executionId: c.executionId, fence: c.fence });
    // if the worker does not confirm in time (offline, frozen) cancel locally; anything it later reports is stale
    j.cancelTimer = setTimeout(() => { if (j.settled) return; c.state = "superseded"; this.gw.send(c.workerId, { type: "kill", jobId, executionId: c.executionId });
      this.settle(j, { status: "cancelled", reason: "worker did not confirm cancellation in time; marked cancelled locally, later results from it will be rejected" }); }, this.o.cancelGraceMs);
    j.cancelTimer.unref();
    return true;
  }

  // ------------------------------------------------------------ scheduling
  private load(workerId: string) { let n = 0; for (const j of this.jobs.values()) if (!j.settled && j.current?.workerId === workerId && (j.current.state === "offered" || j.current.state === "running")) n++; return n; }
  private eligible(w: WorkerRecord, job: Job): boolean {
    const adv = w.advertised; const conn = this.gw.connection(w.id);
    return w.status === "active" && !!conn && !!adv && Date.now() - conn.lastSeen < this.gw.opts.heartbeatMs * 3
      && w.kinds.includes(job.input.kind) && adv.kinds.includes(job.input.kind)
      && adv.isolation.available === true                       // no isolation provider on that platform => never assigned
      && w.allowedProjects.includes(job.alias)                  // explicit per-project grant
      && this.load(w.id) < w.maxConcurrent && !job.excluded.has(w.id);
  }
  private explain(job: Job): string {
    const ws = this.gw.registry.list().filter((w) => w.status !== "revoked");
    if (!ws.length) return "no workers registered";
    return ws.map((w) => `${w.name}: ${w.status !== "active" ? w.status : !this.gw.connection(w.id) ? "offline" : !w.kinds.includes(job.input.kind) ? `not allowed to run ${job.input.kind}` : !w.advertised?.kinds.includes(job.input.kind) ? `its policy does not allow ${job.input.kind}`
      : !w.advertised?.isolation.available ? `no isolation (${w.advertised?.isolation.reason ?? w.advertised?.isolation.platform})` : !w.allowedProjects.includes(job.alias) ? "project not granted" : job.excluded.has(w.id) ? "excluded" : "busy"}`).join("; ");
  }
  private schedule(job: Job) {
    if (job.settled) return; clearTimeout(job.retryTimer);
    const all = this.gw.registry.list().filter((w) => this.eligible(w, job));
    const preferred = all.filter((w) => !job.avoid.has(w.id)); const pool = preferred.length ? preferred : all;
    const pick = pool.sort((a, b) => this.load(a.id) - this.load(b.id))[0];
    if (pick) return this.dispatch(job, pick);
    if (Date.now() - job.queuedAt > this.o.queueTimeoutMs) return this.settle(job, { status: "error", reason: `no eligible worker within ${Math.round(this.o.queueTimeoutMs / 1000)}s (${this.explain(job)})` });
    job.retryTimer = setTimeout(() => this.schedule(job), 250); job.retryTimer.unref();
  }
  private dispatch(job: Job, w: WorkerRecord) {
    const exec: Exec = { executionId: randomUUID(), fence: this.gw.registry.nextFence(), workerId: w.id, state: "offered", leaseExpires: Date.now() + this.gw.opts.leaseMs, startedAt: Date.now() };
    job.current = exec; job.attempt++; job.offers++;
    const chunks = chunkBuffer(job.archive!); const input = job.input; const c = w.ceilings;
    const limits: Record<string, number> = {}; for (const [k, v] of Object.entries(input.limits ?? {})) { const cap = (c as any)[k]; limits[k] = typeof cap === "number" ? Math.min(v, cap) : v; }
    const spec = { kind: input.kind, projectAlias: job.alias, ...(input.runner ? { runner: input.runner } : {}), ...(input.role ? { role: { ...input.role, maxBudgetUsd: Math.min(input.role.maxBudgetUsd, c.maxBudgetUsd ?? input.role.maxBudgetUsd) } } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}), limits };
    this.audit.record("remote.job.dispatched", { jobId: job.id, attempt: job.attempt, executionId: exec.executionId, fence: exec.fence, worker: w.id, kind: input.kind, alias: job.alias, files: job.manifest!.files.length, bytes: job.archive!.length, effects: EFFECTS[input.kind] });
    try {
      this.gw.send(w.id, { type: "offer", jobId: job.id, executionId: exec.executionId, fence: exec.fence, spec, manifest: job.manifest!, archive: { bytes: job.archive!.length, sha256: job.archiveSha!, chunks: chunks.length } });
      chunks.forEach((data, seq) => this.gw.send(w.id, { type: "blob", jobId: job.id, executionId: exec.executionId, fence: exec.fence, seq, last: seq === chunks.length - 1, data }));
    } catch (e: any) { return this.settle(job, { status: "error", reason: `could not send offer: ${e.message}` }); }
    exec.acceptTimer = setTimeout(() => { if (exec.state === "offered") this.expire(job, exec, "offer not acknowledged in time"); }, this.o.acceptTimeoutMs); exec.acceptTimer.unref();
  }

  // ------------------------------------------------------------ lease / fencing
  private lookup(workerId: string, jobId: string, executionId: string, fence: number, requireLease = true): { job: Job; exec: Exec } | { stale: string } {
    const job = this.jobs.get(jobId); if (!job) return { stale: "unknown job" };
    const exec = job.current; if (!exec) return { stale: "no current execution" };
    if (exec.executionId !== executionId) return { stale: "superseded execution id" };
    if (exec.fence !== fence) return { stale: "wrong fencing token" };
    if (exec.workerId !== workerId) return { stale: "execution belongs to another worker" };
    if (job.settled) return { stale: "job already settled" };
    if (exec.state !== "offered" && exec.state !== "running") return { stale: `execution is ${exec.state}` };
    if (requireLease && Date.now() > exec.leaseExpires) return { stale: "lease expired" };
    return { job, exec };
  }
  private stale(rec: WorkerRecord, f: Frame, why: string) {
    this.audit.record("remote.stale_message_rejected", { type: f.type, jobId: f.jobId, executionId: f.executionId, fence: f.fence, worker: rec.id, why });
    if (typeof f.jobId === "string" && typeof f.executionId === "string") this.gw.send(rec.id, { type: "kill", jobId: f.jobId, executionId: f.executionId });
  }
  private expire(job: Job, exec: Exec, why: string, hard = false) {
    if (exec.state === "expired" || exec.state === "done" || exec.state === "superseded") return;
    exec.state = "expired"; clearTimeout(exec.acceptTimer); if (exec.pending) clearTimeout(exec.pending.timer);
    this.audit.record("remote.execution_expired", { jobId: job.id, executionId: exec.executionId, fence: exec.fence, worker: exec.workerId, why });
    this.gw.send(exec.workerId, { type: "kill", jobId: job.id, executionId: exec.executionId });
    if (job.settled) return;
    if (job.cancelRequested) return this.settle(job, { status: "cancelled", reason: `cancelled (${why})` });
    const eff = EFFECTS[job.input.kind];
    if (eff === "none" && job.attempt < this.o.maxAttempts) {
      (hard ? job.excluded : job.avoid).add(exec.workerId);
      this.audit.record("remote.job.requeued", { jobId: job.id, nextAttempt: job.attempt + 1, why, effects: eff });
      job.queuedAt = Date.now(); job.current = undefined; return this.schedule(job);
    }
    this.settle(job, { status: "lost", reason: why, needsManualDecision: eff !== "none" ? true : undefined,
      ...(eff !== "none" ? { reason: `${why}; this job has effects class "${eff}" and is never retried automatically (needs-manual-decision)` } : { reason: `${why}; attempts exhausted (${job.attempt}/${this.o.maxAttempts})` }) });
  }
  private onSweep(now: number) {
    for (const j of this.jobs.values()) { const c = j.current; if (!j.settled && c && (c.state === "offered" || c.state === "running") && now > c.leaseExpires) this.expire(j, c, "lease expired (no heartbeat from the worker)"); }
  }
  private onRevoked(rec: WorkerRecord) {
    for (const j of this.jobs.values()) { const c = j.current; if (!j.settled && c?.workerId === rec.id && (c.state === "offered" || c.state === "running")) this.expire(j, c, "worker revoked", true); }
  }
  private onHello(rec: WorkerRecord, f: Frame) {
    const held = (Array.isArray(f.running) ? f.running : []).filter((r: any) => r && typeof r.jobId === "string" && typeof r.executionId === "string" && typeof r.fence === "number");
    for (const r of held) { const l = this.lookup(rec.id, r.jobId, r.executionId, r.fence); if ("stale" in l) { this.audit.record("remote.stale_execution_on_reconnect", { worker: rec.id, jobId: r.jobId, executionId: r.executionId, why: l.stale }); this.gw.send(rec.id, { type: "kill", jobId: r.jobId, executionId: r.executionId }); } else l.exec.leaseExpires = Date.now() + this.gw.opts.leaseMs; }
    for (const j of this.jobs.values()) { const c = j.current; if (!j.settled && c?.workerId === rec.id && (c.state === "offered" || c.state === "running") && !held.some((r: any) => r.executionId === c.executionId)) this.expire(j, c, "worker reconnected without this execution"); }
    for (const j of this.jobs.values()) if (!j.settled && !j.current) this.schedule(j);
  }

  // ------------------------------------------------------------ frames from workers
  private onFrame(rec: WorkerRecord, f: Frame) {
    switch (f.type) {
      case "heartbeat": return this.onHeartbeat(rec, f);
      case "accepted": { const l = this.lookup(rec.id, f.jobId, f.executionId, f.fence); if ("stale" in l) return this.stale(rec, f, l.stale);
        if (l.exec.state !== "offered") return; l.exec.state = "running"; clearTimeout(l.exec.acceptTimer); l.exec.leaseExpires = Date.now() + this.gw.opts.leaseMs;
        this.audit.record("remote.job.accepted", { jobId: l.job.id, executionId: l.exec.executionId, fence: l.exec.fence, worker: rec.id }); return; }
      case "rejected": { const l = this.lookup(rec.id, f.jobId, f.executionId, f.fence); if ("stale" in l) return this.stale(rec, f, l.stale);
        clearTimeout(l.exec.acceptTimer); l.exec.state = "done"; l.job.excluded.add(rec.id); l.job.attempt--; l.job.current = undefined;
        const reason = sanitizeText(f.reason, 300); this.audit.record("remote.job.rejected_by_worker", { jobId: l.job.id, worker: rec.id, reason });
        if (l.job.offers >= 6) return this.settle(l.job, { status: "rejected", reason: `rejected by workers: ${reason}` });
        l.job.queuedAt = Date.now(); return this.schedule(l.job); }
      case "result": return this.onResult(rec, f);
      case "blob": return this.onBlob(rec, f);
    }
  }
  private onHeartbeat(rec: WorkerRecord, f: Frame) {
    const items = (f.running as any[]).filter((r) => r && typeof r.jobId === "string" && typeof r.executionId === "string" && typeof r.fence === "number");
    for (const r of items) { const l = this.lookup(rec.id, r.jobId, r.executionId, r.fence); if ("stale" in l) this.stale(rec, { type: "heartbeat", ...r }, l.stale); else l.exec.leaseExpires = Date.now() + this.gw.opts.leaseMs; } // lease renewed only for CURRENT executions
    for (const j of this.jobs.values()) { const c = j.current; if (!j.settled && c?.workerId === rec.id && c.state === "running" && !c.pending && !items.some((r) => r.executionId === c.executionId)) this.expire(j, c, "worker no longer reports this execution"); }
  }
  private onResult(rec: WorkerRecord, f: Frame) {
    const l = this.lookup(rec.id, f.jobId, f.executionId, f.fence); if ("stale" in l) return this.stale(rec, f, l.stale);
    clearTimeout(l.exec.acceptTimer);
    const meta = (f as any).files;
    if (!meta) return this.finalize(l.job, l.exec, f, undefined);
    if (!(meta.bytes > 0 && meta.bytes <= 14 * 1024 * 1024 && meta.chunks > 0 && meta.chunks <= 120) || typeof meta.sha256 !== "string") return this.finalize(l.job, l.exec, { ...f, status: "error", error: "invalid files metadata" }, undefined);
    l.exec.pending = { frame: f, parts: [], timer: setTimeout(() => { if (!l.job.settled) this.settle(l.job, { status: "error", reason: "result blobs timed out" }); }, this.o.resultTimeoutMs) };
    l.exec.pending.timer.unref();
  }
  private onBlob(rec: WorkerRecord, f: Frame) {
    const l = this.lookup(rec.id, f.jobId, f.executionId, f.fence, false); if ("stale" in l) return this.stale(rec, f, l.stale);
    const p = l.exec.pending; if (!p) return this.stale(rec, f, "unexpected blob");
    if (f.seq !== p.parts.length) { clearTimeout(p.timer); return this.settle(l.job, { status: "error", reason: "result blob out of order" }); }
    p.parts.push(Buffer.from(f.data, "base64")); if (!f.last) return;
    clearTimeout(p.timer); const buf = Buffer.concat(p.parts); const meta = (p.frame as any).files;
    if (buf.length !== meta.bytes || sha256(buf) !== meta.sha256) return this.settle(l.job, { status: "error", reason: "result archive hash mismatch" });
    this.finalize(l.job, l.exec, p.frame, buf);
  }

  // ------------------------------------------------------------ results: treat as hostile input
  private finalize(job: Job, exec: Exec, f: Frame, buf: Buffer | undefined) {
    exec.state = "done"; if (exec.pending) clearTimeout(exec.pending.timer);
    let files: ReceivedFile[] | undefined;
    if (buf) { try { files = validateReturned(buf); } catch (e: any) {
      this.audit.record("remote.output_rejected", { jobId: job.id, worker: exec.workerId, why: e.message, rules: Array.isArray(e.details) ? e.details : undefined });
      return this.settle(job, { status: "rejected", reason: `worker output rejected: ${e.message}`, executionId: exec.executionId, fence: exec.fence, workerId: exec.workerId }); } }
    const base = { executionId: exec.executionId, fence: exec.fence, workerId: exec.workerId, files };
    const claimed = typeof f.status === "string" ? f.status : "error";
    if (job.input.kind === "sandbox") {
      const sb = sanitizeSandbox((f as any).sandbox);
      if (!sb) return this.settle(job, { ...base, status: claimed === "rejected" ? "rejected" : "error", reason: sanitizeText((f as any).error, 300) || "worker returned no sandbox report" });
      const status = sb.cancelled ? "cancelled" : sb.ok ? "succeeded" : "failed";
      if (status === "cancelled" && !job.cancelRequested) return this.settle(job, { ...base, sandbox: sb, status: "failed", reason: "worker cancelled the job without being asked" });
      return this.settle(job, { ...base, sandbox: sb, status });
    }
    const maxBudget = job.input.role?.maxBudgetUsd ?? 1; const ag = sanitizeAgent((f as any).agent, maxBudget);
    if (!ag) return this.settle(job, { ...base, status: claimed === "rejected" ? "rejected" : "error", reason: sanitizeText((f as any).error, 300) || "worker returned no agent report" });
    const status = claimed === "cancelled" && job.cancelRequested ? "cancelled" : claimed === "succeeded" && ag.ok ? "succeeded" : "failed";
    this.settle(job, { ...base, agent: ag, status, ...(status === "failed" ? { reason: ag.reason ?? "agent failed" } : {}) });
  }
  private settle(job: Job, o: Partial<RemoteOutcome> & { status: RemoteOutcome["status"] }) {
    if (job.settled) return;
    job.settled = true; clearTimeout(job.retryTimer); clearTimeout(job.cancelTimer);
    const outcome: RemoteOutcome = { jobId: job.id, attempt: job.attempt, workerReported: true, ...o };
    job.outcome = outcome; job.archive = undefined;
    if (job.current && (job.current.state === "offered" || job.current.state === "running")) job.current.state = o.status === "cancelled" ? "superseded" : "done";
    const { files, sandbox, agent, ...summary } = outcome;
    try { fs.writeFileSync(path.join(this.dir, "remote", `${job.id}.json`), JSON.stringify({ ...summary, sandbox, agent, files: files?.map((f) => ({ path: f.path, bytes: f.content.length })), settledAt: new Date().toISOString() }, null, 2)); } catch { /* best effort */ }
    this.audit.record("remote.job.result", { jobId: job.id, status: outcome.status, attempt: outcome.attempt, worker: outcome.workerId, executionId: outcome.executionId, fence: outcome.fence, reason: outcome.reason, needsManualDecision: outcome.needsManualDecision,
      sandboxOk: sandbox?.ok, killedBy: sandbox?.killedBy, costUsd: agent?.costUsd, files: files?.length });
    job.resolve(outcome); this.emit("settled", outcome);
  }
}

// ---------------------------------------------------------------- report sanitisers (worker output is data, never trusted)
const num = (v: unknown, min: number, max: number, d = 0) => clampNumber(v, min, max, d);
const LIMIT_KEYS = ["cpuSeconds", "memoryMb", "timeoutMs", "maxProcesses", "maxOutputBytes", "maxFileMb"];
export function sanitizeSandbox(o: any): SandboxReport | undefined {
  if (!o || typeof o !== "object") return undefined;
  const exitCode = typeof o.exitCode === "number" && Number.isFinite(o.exitCode) ? num(o.exitCode, -1000, 1000) : null;
  const killedBy = typeof o.killedBy === "string" ? sanitizeText(o.killedBy, 200) : null;
  const timedOut = o.timedOut === true, cancelled = o.cancelled === true;
  const s = o.summary && typeof o.summary === "object" ? o.summary : {};
  const opt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? num(v, 0, 10_000_000) : undefined);
  return { ok: o.ok === true && exitCode === 0 && !killedBy && !timedOut && !cancelled, exitCode, signal: typeof o.signal === "string" ? sanitizeText(o.signal, 20) : null, killedBy, timedOut, cancelled,
    outputTruncated: o.outputTruncated === true, durationMs: num(o.durationMs, 0, 1e8),
    summary: { tests: opt(s.tests), failures: opt(s.failures), errors: opt(s.errors), failed: (Array.isArray(s.failed) ? s.failed : []).filter((x: unknown) => typeof x === "string").slice(0, 200).map((x: string) => sanitizeText(x, 300)) },
    stdout: sanitizeText(o.stdout, 60_000), stderr: sanitizeText(o.stderr, 60_000),
    limits: Object.fromEntries(LIMIT_KEYS.filter((k) => typeof o.limits?.[k] === "number").map((k) => [k, num(o.limits[k], 0, 1e12)])) };
}
export function sanitizeAgent(o: any, maxBudgetUsd: number): AgentReport | undefined {
  if (!o || typeof o !== "object") return undefined;
  const reported = num(o.costUsd, 0, 1e9); const cost = Math.min(reported, maxBudgetUsd);
  return { ok: o.ok === true, result: sanitizeText(o.result, 20_000), reason: typeof o.reason === "string" ? sanitizeText(o.reason, 500) : null, costUsd: cost, reportedCostUsd: reported, costCapped: reported > maxBudgetUsd,
    inputTokens: Math.floor(num(o.inputTokens, 0, 1e9)), outputTokens: Math.floor(num(o.outputTokens, 0, 1e9)), cacheCreationTokens: Math.floor(num(o.cacheCreationTokens, 0, 1e9)), cacheReadTokens: Math.floor(num(o.cacheReadTokens, 0, 1e9)),
    model: typeof o.model === "string" ? sanitizeText(o.model, 100) : null };
}
