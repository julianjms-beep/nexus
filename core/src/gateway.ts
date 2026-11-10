// Worker gateway: a SEPARATE listener (never the local API) that speaks only the worker protocol over TLS 1.3 with mutual auth.
// Unauthenticated peers may do exactly one thing: enroll with a one-time token. Everything else needs a registered client cert.
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Pki, certInfo, fingerprintOf, inspectCsr } from "./pki.ts";
import { FrameReader, sendFrame, validateFrame, sanitizeText, WORKER_MESSAGES, PROTOCOL_VERSION, type Frame } from "./protocol.ts";
import { resolveGatewayBind } from "./netpolicy.ts";
import type { Audit } from "./audit.ts";
import type { Isolation } from "./isolation.ts";

export type WorkerKind = "sandbox" | "agent";
export type WorkerStatus = "pending" | "active" | "revoked";
export type Ceilings = { cpuSeconds?: number; memoryMb?: number; timeoutMs?: number; maxProcesses?: number; maxOutputBytes?: number; maxFileMb?: number; maxBudgetUsd?: number };
export type WorkerRecord = {
  id: string; name: string; owner: string; status: WorkerStatus; createdAt: string;
  enroll?: { tokenHash: string; expiresAt: number; used: boolean };
  fingerprint?: string; prevFingerprints: { fp: string; until: number }[]; certNotAfter?: string; caGen?: number;
  advertised?: { platform: string; isolation: Isolation; kinds: WorkerKind[] };
  kinds: WorkerKind[]; allowedProjects: string[]; ceilings: Ceilings; maxConcurrent: number; lastSeen?: number; revokedAt?: string;
};
export type EnrollmentBundle = { version: 1; workerId: string; name: string; gateway: { host: string; port: number }; caPems: string[]; enrollToken: string; expiresAt: string };
export type GatewayOptions = { host?: string; port?: number; advertiseHost?: string; leaseMs?: number; heartbeatMs?: number; serverNames?: string[];
  clientCertDays?: number; graceMs?: number; enrollTtlMs?: number; env?: Record<string, string | undefined> };

const sha = (s: string) => createHash("sha256").update(s).digest();
const WORKER_ID = /^w-[0-9a-f]{10}$/;

class Registry {
  data: { salt: string; fenceCounter: number; workers: Record<string, WorkerRecord> };
  constructor(private file: string) {
    try { this.data = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.data = { salt: randomBytes(16).toString("hex"), fenceCounter: 0, workers: {} }; this.save(); }
  }
  save() { const t = this.file + ".tmp"; fs.writeFileSync(t, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(t, this.file); }
  alias(realPath: string) { return "p_" + createHash("sha256").update(this.data.salt + "|" + realPath).digest("hex").slice(0, 12); }
  nextFence() { this.data.fenceCounter++; this.save(); return this.data.fenceCounter; }
  get(id: string) { return this.data.workers[id]; }
  list() { return Object.values(this.data.workers); }
  byFingerprint(fp: string, now = Date.now()) {
    for (const w of this.list()) {
      if (w.fingerprint === fp) return w;
      if (w.prevFingerprints.some((p) => p.fp === fp && p.until > now)) return w;
    }
    return undefined;
  }
}

type Conn = { socket: tls.TLSSocket; state: "anon" | "awaiting-hello" | "ready"; rec?: WorkerRecord; remote: string; lastSeen: number; timer?: NodeJS.Timeout };

export class Gateway extends EventEmitter {
  readonly pki: Pki; readonly registry: Registry;
  address?: { host: string; port: number };
  private server?: tls.Server; private conns = new Map<string, Conn>(); private all = new Set<Conn>();
  private monitor?: NodeJS.Timeout; private enrollStamps = new Map<string, number[]>();
  readonly opts: Required<Pick<GatewayOptions, "leaseMs" | "heartbeatMs" | "clientCertDays" | "graceMs" | "enrollTtlMs">> & GatewayOptions;

  constructor(private dir: string, private audit: Audit, opts: GatewayOptions = {}) {
    super();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.opts = { leaseMs: 15_000, heartbeatMs: 5_000, clientCertDays: 7, graceMs: 5 * 60_000, enrollTtlMs: 15 * 60_000, ...opts };
    this.pki = new Pki(path.join(dir, "ca")).init();
    this.registry = new Registry(path.join(dir, "workers.json"));
  }

  // ------------------------------------------------------------ lifecycle
  async start(): Promise<{ host: string; port: number }> {
    const bind = resolveGatewayBind(this.opts.host, this.opts.env ?? process.env); // throws unless explicitly allowed
    const { key, cert } = this.ensureServerCert(bind.host);
    this.server = tls.createServer({ key, cert, ca: this.pki.trustedPems(), requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3", handshakeTimeout: 10_000 });
    this.server.on("secureConnection", (s) => this.onConnection(s));
    this.server.on("tlsClientError", () => { /* failed handshakes are simply dropped */ });
    await new Promise<void>((res, rej) => { this.server!.once("error", rej); this.server!.listen(this.opts.port ?? 7778, bind.host, res); });
    const port = (this.server.address() as any).port;
    this.address = { host: this.opts.advertiseHost ?? (bind.exposure === "wildcard" ? "127.0.0.1" : bind.host), port };
    this.monitor = setInterval(() => this.sweep(), 500); this.monitor.unref();
    this.audit.record("gateway.started", { host: bind.host, port, exposure: bind.exposure, warnings: bind.warnings, tls: "1.3+mTLS" });
    return this.address;
  }
  async stop() {
    clearInterval(this.monitor);
    for (const c of this.all) c.socket.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
  private ensureServerCert(bindHost: string) {
    const kf = path.join(this.dir, "gateway-server.key"), cf = path.join(this.dir, "gateway-server.crt");
    const names = [...new Set(["localhost", "127.0.0.1", ...(bindHost !== "0.0.0.0" && bindHost !== "::" ? [bindHost] : []), ...(this.opts.serverNames ?? [])])];
    try {
      const cert = fs.readFileSync(cf, "utf8"); const info = certInfo(cert);
      const gen = this.pki.generationOf(cert);
      const sans = info.x509.subjectAltName ?? "";
      if (gen === this.pki.meta.serverGen && info.notAfter.getTime() - Date.now() > 30 * 86_400_000 && names.every((n) => sans.includes(n))) return { key: fs.readFileSync(kf, "utf8"), cert };
    } catch { /* issue a new one */ }
    const { keyPem, certPem } = this.pki.issueServer(names);
    fs.writeFileSync(kf, keyPem, { mode: 0o600 }); fs.writeFileSync(cf, certPem);
    this.audit.record("gateway.server_cert_issued", { names, fingerprint: fingerprintOf(certPem).slice(0, 16), notAfter: certInfo(certPem).notAfter.toISOString() });
    return { key: keyPem, cert: certPem };
  }
  private refreshContext() {
    const bind = this.address ? this.address.host : "127.0.0.1";
    const { key, cert } = this.ensureServerCert(bind);
    this.server?.setSecureContext({ key, cert, ca: this.pki.trustedPems(), minVersion: "TLSv1.3" });
  }

  // ------------------------------------------------------------ administration
  createWorker(o: { name: string; kinds?: WorkerKind[]; projects?: string[]; ceilings?: Ceilings; maxConcurrent?: number; owner?: string }): { worker: WorkerRecord; bundle: EnrollmentBundle } {
    if (!this.address) throw new Error("gateway not started");
    if (!/^[\w .-]{1,40}$/.test(o.name)) throw new Error("bad worker name");
    const kinds = (o.kinds ?? ["sandbox"]).filter((k): k is WorkerKind => k === "sandbox" || k === "agent");
    const id = "w-" + randomBytes(5).toString("hex"); const token = randomBytes(32).toString("base64url");
    const rec: WorkerRecord = { id, name: o.name, owner: o.owner ?? "local", status: "pending", createdAt: new Date().toISOString(),
      enroll: { tokenHash: sha(token).toString("hex"), expiresAt: Date.now() + this.opts.enrollTtlMs, used: false },
      prevFingerprints: [], kinds, allowedProjects: [...new Set(o.projects ?? [])], ceilings: o.ceilings ?? {}, maxConcurrent: o.maxConcurrent ?? 2 };
    this.registry.data.workers[id] = rec; this.registry.save();
    this.audit.record("worker.created", { id, name: rec.name, kinds, projects: rec.allowedProjects.length, enrollExpiresAt: new Date(rec.enroll!.expiresAt).toISOString() });
    return { worker: rec, bundle: { version: 1, workerId: id, name: rec.name, gateway: this.address, caPems: this.pki.trustedPems(), enrollToken: token, expiresAt: new Date(rec.enroll!.expiresAt).toISOString() } };
  }
  /** Grants a worker access to a project, identified to it only by an opaque alias. */
  grantProject(workerId: string, realProjectPath: string): string {
    const w = this.registry.get(workerId); if (!w) throw new Error("unknown worker");
    const alias = this.registry.alias(realProjectPath);
    if (!w.allowedProjects.includes(alias)) { w.allowedProjects.push(alias); this.registry.save(); this.audit.record("worker.project_granted", { id: workerId, alias }); }
    return alias;
  }
  revokeWorker(id: string, reason = "revoked by administrator") {
    const w = this.registry.get(id); if (!w) throw new Error("unknown worker");
    w.status = "revoked"; w.prevFingerprints = []; w.enroll = undefined; w.revokedAt = new Date().toISOString(); this.registry.save();
    this.audit.record("worker.revoked", { id, reason });
    const c = this.conns.get(id); if (c) this.drop(c, "worker revoked");
    this.emit("revoked", w);
  }
  rotateCa() {
    const gen = this.pki.rotate(); this.refreshContext();
    this.audit.record("pki.ca_rotation_started", { gen, trusted: this.pki.meta.gens.filter((g) => !g.retired).map((g) => g.n) });
    return gen;
  }
  /** Phase 2: only when every active worker holds a cert from the newest CA (or force). */
  completeCaRotation(force = false) {
    const laggards = this.registry.list().filter((w) => w.status === "active" && w.caGen !== this.pki.meta.active).map((w) => w.id);
    if (laggards.length && !force) throw new Error(`workers still on an old CA: ${laggards.join(", ")} (they must renew first, or re-enroll after retirement)`);
    this.pki.completeRotation(); this.refreshContext();
    this.audit.record("pki.ca_rotation_completed", { active: this.pki.meta.active, laggards });
    for (const id of laggards) { const c = this.conns.get(id); if (c) this.drop(c, "CA retired"); }
  }
  listWorkers() {
    const now = Date.now();
    return this.registry.list().map((w) => { const c = this.conns.get(w.id);
      return { id: w.id, name: w.name, status: w.status, online: !!c && c.state === "ready" && now - c.lastSeen < this.opts.heartbeatMs * 3, lastSeen: w.lastSeen ? new Date(w.lastSeen).toISOString() : null,
        platform: w.advertised?.platform, isolation: w.advertised?.isolation, kinds: w.kinds, projects: w.allowedProjects.length, certNotAfter: w.certNotAfter, caGen: w.caGen, maxConcurrent: w.maxConcurrent }; });
  }
  connection(id: string) { const c = this.conns.get(id); return c && c.state === "ready" ? c : undefined; }
  send(id: string, frame: Frame): boolean { const c = this.connection(id); return !!c && sendFrame(c.socket, frame); }

  // ------------------------------------------------------------ connections
  private identify(socket: tls.TLSSocket): { kind: "worker"; rec: WorkerRecord } | { kind: "anon"; why: string } | { kind: "denied"; why: string; rec: WorkerRecord } {
    const peer = socket.getPeerX509Certificate?.();
    if (!peer) return { kind: "anon", why: "no client certificate" };
    if (!socket.authorized) return { kind: "anon", why: `client certificate rejected: ${socket.authorizationError}` };
    const rec = this.registry.byFingerprint(peer.fingerprint256.replaceAll(":", "").toLowerCase());
    if (!rec) return { kind: "anon", why: "certificate not registered" };
    if (rec.status === "revoked") return { kind: "denied", why: "worker revoked", rec };
    if (rec.status !== "active" || /^CN=(.+)$/m.exec(peer.subject)?.[1] !== rec.id) return { kind: "anon", why: "certificate does not match registry" };
    return { kind: "worker", rec };
  }
  private onConnection(socket: tls.TLSSocket) {
    const id = this.identify(socket);
    const c: Conn = { socket, state: "anon", remote: socket.remoteAddress ?? "?", lastSeen: Date.now() };
    this.all.add(c);
    socket.on("error", () => {});
    socket.on("close", () => {
      this.all.delete(c); clearTimeout(c.timer);
      if (c.rec && this.conns.get(c.rec.id) === c) { this.conns.delete(c.rec.id); this.audit.record("worker.disconnected", { id: c.rec.id }); this.emit("disconnect", c.rec); }
    });
    if (id.kind === "denied") { this.audit.record("gateway.auth_denied", { why: id.why, worker: id.rec.id, remote: c.remote }); this.drop(c, id.why); return; }
    if (id.kind === "anon") { this.audit.record("gateway.auth_anonymous", { why: id.why, remote: c.remote }); c.timer = setTimeout(() => this.drop(c, "enrollment timeout"), 10_000); }
    else {
      c.rec = id.rec; c.state = "awaiting-hello";
      const old = this.conns.get(id.rec.id); if (old) this.drop(old, "replaced by a newer connection");
      c.timer = setTimeout(() => this.drop(c, "hello timeout"), 10_000);
    }
    new FrameReader(socket, (f) => this.onFrame(c, f), (why) => this.drop(c, why));
  }
  private drop(c: Conn, reason: string) {
    this.audit.record("gateway.connection_dropped", { reason, worker: c.rec?.id, remote: c.remote });
    try { sendFrame(c.socket, { type: "bye", reason: sanitizeText(reason, 200) }); } catch { /* socket already closing */ }
    c.socket.destroy();
  }
  private sweep() {
    const now = Date.now();
    for (const [, c] of this.conns) if (now - c.lastSeen > this.opts.heartbeatMs * 3) this.drop(c, "heartbeat timeout");
    this.emit("sweep", now);
  }
  private onFrame(c: Conn, f: Frame) {
    const bad = validateFrame(f, WORKER_MESSAGES);
    if (bad) return this.drop(c, `protocol violation: ${bad}`);
    c.lastSeen = Date.now();
    if (c.state === "anon") return f.type === "enroll" ? this.handleEnroll(c, f) : this.drop(c, "unauthenticated connections may only enroll");
    if (c.state === "awaiting-hello") return f.type === "hello" ? this.handleHello(c, f) : this.drop(c, "hello required first");
    const rec = c.rec!;
    if (rec.status !== "active") return this.drop(c, "worker not active");
    rec.lastSeen = c.lastSeen;
    switch (f.type) {
      case "renew": return this.handleRenew(c, f);
      case "enroll": case "hello": return this.drop(c, "unexpected message");
      default: this.emit("frame", rec, f, c); // heartbeat, accepted, rejected, result, blob -> executor
    }
  }

  private handleEnroll(c: Conn, f: Frame) {
    const now = Date.now(); const stamps = (this.enrollStamps.get(c.remote) ?? []).filter((t) => now - t < 60_000); stamps.push(now); this.enrollStamps.set(c.remote, stamps);
    const deny = (why: string) => { this.audit.record("worker.enroll_denied", { why, workerId: sanitizeText(f.workerId, 40), remote: c.remote });
      sendFrame(c.socket, { type: "enroll.denied", reason: "enrollment denied" }); setTimeout(() => c.socket.destroy(), 50); }; // generic reply: no oracle
    if (stamps.length > 10) return deny("rate limited");
    const rec = WORKER_ID.test(f.workerId) ? this.registry.get(f.workerId) : undefined;
    if (!rec || rec.status !== "pending" || !rec.enroll || rec.enroll.used) return deny("unknown or non-pending worker");
    if (now > rec.enroll.expiresAt) return deny("token expired");
    const given = sha(String(f.token)), want = Buffer.from(rec.enroll.tokenHash, "hex");
    if (!timingSafeEqual(given, want)) return deny("bad token");
    let cn: string; try { cn = inspectCsr(f.csrPem).cn; } catch (e: any) { return deny(`bad CSR: ${e.message}`); }
    if (cn !== rec.id) return deny("CSR common name does not match worker id");
    rec.enroll.used = true; // single use, consumed before issuing
    const certPem = this.pki.sign(f.csrPem, rec.id, "client", this.opts.clientCertDays);
    rec.status = "active"; rec.fingerprint = fingerprintOf(certPem); rec.certNotAfter = certInfo(certPem).notAfter.toISOString(); rec.caGen = this.pki.generationOf(certPem);
    rec.advertised = { platform: sanitizeText(f.platform, 40), isolation: { available: false, mechanism: "unknown", platform: sanitizeText(f.platform, 40) }, kinds: [] };
    this.registry.save();
    this.audit.record("worker.enrolled", { id: rec.id, fingerprint: rec.fingerprint.slice(0, 16), notAfter: rec.certNotAfter, caGen: rec.caGen, remote: c.remote });
    sendFrame(c.socket, { type: "enroll.ok", certPem, caPems: this.pki.trustedPems() });
    setTimeout(() => c.socket.end(), 100);
  }
  private handleHello(c: Conn, f: Frame) {
    clearTimeout(c.timer);
    const rec = c.rec!;
    if (f.version !== PROTOCOL_VERSION) return this.drop(c, "unsupported protocol version");
    const iso = f.isolation as any;
    rec.advertised = { platform: sanitizeText(f.platform, 40),
      isolation: { available: iso?.available === true, mechanism: sanitizeText(iso?.mechanism, 30), platform: sanitizeText(iso?.platform, 30), reason: iso?.reason ? sanitizeText(iso.reason, 200) : undefined },
      kinds: (f.kinds as unknown[]).filter((k): k is WorkerKind => k === "sandbox" || k === "agent") };
    this.registry.save();
    c.state = "ready"; rec.lastSeen = c.lastSeen; this.conns.set(rec.id, c);
    sendFrame(c.socket, { type: "hello.ok", heartbeatMs: this.opts.heartbeatMs, leaseMs: this.opts.leaseMs });
    this.audit.record("worker.connected", { id: rec.id, platform: rec.advertised.platform, isolation: rec.advertised.isolation.mechanism, kinds: rec.advertised.kinds, remote: c.remote,
      tls: c.socket.getProtocol(), cipher: c.socket.getCipher()?.name, clientCert: rec.fingerprint?.slice(0, 16) });
    this.emit("hello", rec, f, c);
  }
  private handleRenew(c: Conn, f: Frame) {
    const rec = c.rec!;
    try {
      if (inspectCsr(f.csrPem).cn !== rec.id) throw new Error("CSR common name mismatch");
      const certPem = this.pki.sign(f.csrPem, rec.id, "client", this.opts.clientCertDays);
      if (rec.fingerprint) rec.prevFingerprints.push({ fp: rec.fingerprint, until: Date.now() + this.opts.graceMs });
      rec.prevFingerprints = rec.prevFingerprints.filter((p) => p.until > Date.now());
      const old = rec.fingerprint; rec.fingerprint = fingerprintOf(certPem); rec.certNotAfter = certInfo(certPem).notAfter.toISOString(); rec.caGen = this.pki.generationOf(certPem);
      this.registry.save();
      this.audit.record("worker.renewed", { id: rec.id, old: old?.slice(0, 16), new: rec.fingerprint.slice(0, 16), notAfter: rec.certNotAfter, caGen: rec.caGen });
      sendFrame(c.socket, { type: "renew.ok", certPem, caPems: this.pki.trustedPems() });
    } catch (e: any) {
      this.audit.record("worker.renew_denied", { id: rec.id, why: e.message });
      sendFrame(c.socket, { type: "renew.denied", reason: "renewal denied" });
    }
  }
}
