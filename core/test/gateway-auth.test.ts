// Integration tests over REAL TLS sockets, with workers running as separate OS processes (worker-cli.ts).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { spawn, type ChildProcess } from "node:child_process";
import { Audit } from "../src/audit.ts";
import { Gateway, type GatewayOptions } from "../src/gateway.ts";
import { WorkerNode } from "../src/worker.ts";
import { Pki, generateKeyAndCsr, certInfo } from "../src/pki.ts";
import { FrameReader, sendFrame, type Frame } from "../src/protocol.ts";

const CLI = path.resolve(import.meta.dirname, "../src/worker-cli.ts");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-gw-")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => unknown, ms = 15_000, what = "condition") { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`); await sleep(40); } }

type Env = Awaited<ReturnType<typeof setup>>;
async function setup(opts: GatewayOptions = {}) {
  const base = tmp(); const audit = new Audit(path.join(base, "ctl", "audit.jsonl"));
  const gw = new Gateway(path.join(base, "ctl"), audit, { port: 0, heartbeatMs: 300, leaseMs: 1500, graceMs: 60_000, ...opts });
  const addr = await gw.start(); const procs: ChildProcess[] = [];
  const cleanup = async () => { for (const p of procs) p.kill("SIGKILL"); await gw.stop(); };
  /** enrolment through the real CLI in a separate process */
  const enrollCli = async (name: string) => {
    const { worker, bundle } = gw.createWorker({ name }); const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true });
    const bf = path.join(dir, "bundle.json"); fs.writeFileSync(bf, JSON.stringify(bundle));
    const p = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "enroll", "--bundle", bf, "--dir", path.join(dir, "node")], { stdio: ["ignore", "pipe", "inherit"] });
    const code = await new Promise<number | null>((r) => p.on("close", r)); assert.equal(code, 0, "enroll CLI exit code");
    return { worker, dir: path.join(dir, "node"), bundle };
  };
  const enrollInProc = async (name: string) => { const { worker, bundle } = gw.createWorker({ name }); const dir = path.join(base, name); await WorkerNode.enroll(bundle, dir); return { worker, dir, bundle }; };
  const runWorker = (dir: string, extra: string[] = []) => {
    const p = spawn("node", ["--experimental-transform-types", "--no-warnings", CLI, "run", "--dir", dir, "--reconnect-ms", "250", ...extra], { stdio: ["pipe", "pipe", "inherit"] }); procs.push(p);
    const list: any[] = []; let buf = ""; p.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { try { list.push(JSON.parse(buf.slice(0, i))); } catch { /* ignore */ } buf = buf.slice(i + 1); } });
    return { p, list, count: (e: string) => list.filter((x) => x.event === e).length, waitFor: (e: string, n = 1, ms = 15_000) => until(() => list.filter((x) => x.event === e).length >= n, ms, `${e} x${n}`) };
  };
  const raw = (o: { ca?: string[]; key?: string | Buffer; cert?: string; maxVersion?: "TLSv1.2" | "TLSv1.3" } = {}) => new Promise<{ sock: tls.TLSSocket; frames: Frame[]; closed: Promise<void>; send: (f: any) => void; sendRaw: (s: string) => void }>((resolve, reject) => {
    const sock = tls.connect({ host: "127.0.0.1", port: addr.port, ca: o.ca ?? gw.pki.trustedPems(), key: o.key, cert: o.cert, minVersion: "TLSv1.2", maxVersion: o.maxVersion, rejectUnauthorized: true });
    const frames: Frame[] = []; const closed = new Promise<void>((r) => sock.on("close", () => r()));
    new FrameReader(sock, (f) => frames.push(f), () => sock.destroy()); sock.on("error", reject);
    sock.on("secureConnect", () => resolve({ sock, frames, closed, send: (f) => sendFrame(sock, f), sendRaw: (s) => sock.write(s) }));
  });
  const identityOf = (dir: string) => { const d = path.join(dir, "identity"); return { key: fs.readFileSync(path.join(d, "key.pem")), cert: fs.readFileSync(path.join(d, "cert.pem"), "utf8") }; };
  return { base, audit, gw, addr, procs, cleanup, enrollCli, enrollInProc, runWorker, raw, identityOf };
}
const HELLO = { type: "hello", version: 1, platform: "darwin", isolation: { available: true, mechanism: "seatbelt", platform: "darwin" }, kinds: ["sandbox"], running: [] };
const types = (e: Env) => e.audit.read().map((x) => x.type);
const dropped = (e: Env) => e.audit.read().filter((x) => x.type === "gateway.connection_dropped").map((x) => (x.data as any).reason as string);

test("two independent processes authenticate over TLS 1.3 + mTLS and exchange heartbeats", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { worker, dir } = await e.enrollCli("alpha");
  const w = e.runWorker(dir); await w.waitFor("connected");
  const view = e.gw.listWorkers().find((x) => x.id === worker.id)!;
  assert.equal(view.online, true); assert.equal(view.status, "active"); assert.equal(view.isolation?.mechanism, process.platform === "linux" ? "linux-bwrap" : "seatbelt");
  assert.ok(w.p.pid && w.p.pid !== process.pid, "the worker is a different OS process");
  const conn = e.audit.read().find((x) => x.type === "worker.connected")!.data as any;
  assert.equal(conn.tls, "TLSv1.3"); assert.match(conn.cipher, /^TLS_(AES|CHACHA20)/);
  const seen1 = e.gw.registry.get(worker.id).lastSeen!; await sleep(900); assert.ok(e.gw.registry.get(worker.id).lastSeen! > seen1, "heartbeats advance lastSeen");
  assert.equal(fs.statSync(path.join(dir, "identity", "key.pem")).mode & 0o777, 0o600);
  const ctlFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? ctlFiles(path.join(d, x.name)) : [path.join(d, x.name)]));
  const workerKey = fs.readFileSync(path.join(dir, "identity", "key.pem"), "utf8").split("\n")[1];
  assert.ok(ctlFiles(path.join(e.base, "ctl")).every((f) => !fs.readFileSync(f, "utf8").includes(workerKey)), "the worker's private key never reached the control plane");
});

test("a client without a certificate can only enroll; anything else is dropped and audited", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const c = await e.raw(); c.send(HELLO); await c.closed;
  assert.ok(c.frames.some((f) => f.type === "bye")); assert.ok(types(e).includes("gateway.auth_anonymous")); assert.ok(dropped(e).includes("unauthenticated connections may only enroll"));
  assert.equal(e.gw.listWorkers().filter((w) => w.online).length, 0);
});

test("a certificate from a foreign CA, an expired certificate, and an unregistered one are all rejected", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { worker } = await e.enrollInProc("victim"); const id = worker.id;
  const mk = (pki: Pki, life: number | { notBefore: Date; notAfter: Date }) => { const { keyPem, csrPem } = generateKeyAndCsr(id); return { key: keyPem, cert: pki.sign(csrPem, id, "client", life) }; };
  const foreign = new Pki(tmp()).init();
  for (const [label, cred] of [["foreign CA", mk(foreign, 7)], ["expired", mk(e.gw.pki, { notBefore: new Date(Date.now() - 7200e3), notAfter: new Date(Date.now() - 3600e3) })], ["unregistered key", mk(e.gw.pki, 7)]] as const) {
    const c = await e.raw({ key: cred.key, cert: cred.cert }); c.send(HELLO); await c.closed;
    assert.ok(c.frames.some((f) => f.type === "bye"), label); assert.equal(e.gw.listWorkers().find((w) => w.id === id)!.online, false, label);
  }
  const why = e.audit.read().filter((x) => x.type === "gateway.auth_anonymous").map((x) => (x.data as any).why as string);
  assert.ok(why.some((w) => /unable.to.verify|self.signed|not trusted|unable.to.get|SIGNATURE_FAILURE|UNTRUSTED/i.test(w)), JSON.stringify(why)); assert.ok(why.some((w) => /expired/i.test(w)), JSON.stringify(why)); assert.ok(why.includes("certificate not registered"));
});

test("TLS 1.2 is refused", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  await assert.rejects(e.raw({ maxVersion: "TLSv1.2" }), /protocol|version|alert/i);
});

test("workers pin the CA: a gateway presenting a certificate from another CA is not trusted", async (t) => {
  const real = await setup(); t.after(real.cleanup); const fake = await setup(); t.after(fake.cleanup);
  const { bundle } = real.gw.createWorker({ name: "pinned" });
  await assert.rejects(WorkerNode.enroll({ ...bundle, gateway: fake.addr }, path.join(real.base, "pinned")), /self.signed|unable to verify|certificate|unable to get/i);
  assert.equal(real.gw.registry.get(bundle.workerId).status, "pending", "the token was never presented to the impostor, and was not consumed");
});

test("enrollment: tokens are single use, expire, and every denial looks the same", async (t) => {
  const e = await setup({ enrollTtlMs: 600 }); t.after(e.cleanup);
  const { bundle } = e.gw.createWorker({ name: "once" });
  await WorkerNode.enroll(bundle, path.join(e.base, "once"));
  const msgs: string[] = [];
  const attempt = async (b: any, n: string) => { try { await WorkerNode.enroll(b, path.join(e.base, n)); msgs.push("OK?!"); } catch (err: any) { msgs.push(err.message); } };
  await attempt(bundle, "again");                                                    // reuse
  const fresh = e.gw.createWorker({ name: "fresh" }).bundle;
  await attempt({ ...fresh, enrollToken: "A".repeat(43) }, "wrongtoken");           // wrong token
  await attempt({ ...fresh, workerId: "w-0000000000" }, "unknownid");               // unknown id
  await sleep(700); await attempt(fresh, "expired");                                 // expired
  assert.equal(msgs.length, 4); assert.ok(msgs.every((m) => m === "enrollment failed: enrollment denied"), JSON.stringify(msgs));
  const reasons = e.audit.read().filter((x) => x.type === "worker.enroll_denied").map((x) => (x.data as any).why as string);
  assert.deepEqual(reasons, ["unknown or non-pending worker", "bad token", "unknown or non-pending worker", "token expired"]);
  assert.equal(e.gw.registry.get(fresh.workerId).status, "pending");
});

test("protocol abuse by an AUTHENTICATED worker is dropped", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { dir } = await e.enrollInProc("abuser"); const id = e.identityOf(dir);
  const abuse: [string, (c: Awaited<ReturnType<Env["raw"]>>) => void][] = [
    ["frame before hello", (c) => c.send({ type: "heartbeat", running: [], active: 0 })],
    ["unknown message type", (c) => { c.send(HELLO); c.send({ type: "exec", cmd: "id" }); }],
    ["malformed json", (c) => c.sendRaw("{nope}\n")],
    ["oversized frame", (c) => c.sendRaw("x".repeat(300_000) + "\n")],
    ["bad protocol version", (c) => c.send({ ...HELLO, version: 99 })],
    ["second hello", (c) => { c.send(HELLO); c.send(HELLO); }],
    ["extra fields", (c) => c.send({ ...HELLO, admin: true })],
    ["job result for a job that was never offered", (c) => { c.send(HELLO); c.send({ type: "result", jobId: "j", executionId: "e", fence: 1, status: "succeeded" }); setTimeout(() => c.sock.end(), 300); }],
  ];
  for (const [label, act] of abuse) { const c = await e.raw({ key: id.key, cert: id.cert }); act(c); await Promise.race([c.closed, sleep(3000)]); c.sock.destroy(); assert.ok(c.sock.destroyed, label); }
  const d = dropped(e); for (const frag of ["hello required first", "protocol violation: unknown message type", "malformed JSON", "frame too large", "unsupported protocol version", "protocol violation: unexpected field admin"]) assert.ok(d.some((x) => x.includes(frag)), `${frag} in ${JSON.stringify(d)}`);
});

test("revocation disconnects a live worker immediately and it can never come back", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { worker, dir } = await e.enrollCli("doomed"); const id = e.identityOf(dir);
  const w = e.runWorker(dir); await w.waitFor("connected");
  const t0 = Date.now(); e.gw.revokeWorker(worker.id, "test");
  await w.waitFor("revoked", 1, 3000); assert.ok(Date.now() - t0 < 3000, "revoked within seconds");
  assert.equal(e.gw.listWorkers().find((x) => x.id === worker.id)!.status, "revoked"); assert.equal(e.gw.listWorkers().find((x) => x.id === worker.id)!.online, false);
  const connectedBefore = w.count("connected"); await sleep(1500); assert.equal(w.count("connected"), connectedBefore, "the worker process stopped reconnecting");
  const c = await e.raw({ key: id.key, cert: id.cert }); c.send(HELLO); await c.closed; assert.ok(types(e).includes("gateway.auth_denied")); assert.ok(types(e).includes("worker.revoked"));
});

test("certificate renewal rotates the key; the old certificate dies after the grace window; the worker keeps working", async (t) => {
  const e = await setup({ graceMs: 1200 }); t.after(e.cleanup);
  const { worker, dir } = await e.enrollCli("rotator"); const before = e.identityOf(dir); const oldFp = e.gw.registry.get(worker.id).fingerprint!;
  const w = e.runWorker(dir); await w.waitFor("connected");
  w.p.stdin!.write("renew\n"); await w.waitFor("renewed"); await w.waitFor("connected", 2);
  const after = e.identityOf(dir); const rec = e.gw.registry.get(worker.id);
  assert.notEqual(rec.fingerprint, oldFp, "fingerprint changed"); assert.notEqual(after.key.toString(), before.key.toString(), "new private key (key rotation)");
  assert.ok(e.gw.registry.byFingerprint(oldFp), "old certificate still valid during the grace window");
  await sleep(1400); assert.equal(e.gw.registry.byFingerprint(oldFp), undefined, "old certificate rejected after the grace window");
  const c = await e.raw({ key: before.key, cert: before.cert }); c.send(HELLO); await c.closed; assert.ok(dropped(e).includes("unauthenticated connections may only enroll"));
  assert.equal(e.gw.listWorkers().find((x) => x.id === worker.id)!.online, true, "the worker is still connected with its new identity");
  assert.ok(types(e).includes("worker.renewed"));
});

test("CA rotation end to end: overlap, renewal under the new CA, completion, and old-CA identities cut off", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const a = await e.enrollCli("renews"); const b = await e.enrollInProc("laggard"); const bId = e.identityOf(b.dir);
  const w = e.runWorker(a.dir); await w.waitFor("connected");
  assert.equal(e.gw.rotateCa(), 2);
  assert.throws(() => e.gw.completeCaRotation(), /still on an old CA/);
  w.p.stdin!.write("renew\n"); await w.waitFor("renewed"); await w.waitFor("connected", 2);
  assert.equal(e.gw.registry.get(a.worker.id).caGen, 2); assert.equal(fs.readFileSync(path.join(a.dir, "identity", "ca.pem"), "utf8").match(/BEGIN CERTIFICATE/g)!.length, 2, "worker received the CA bundle over the authenticated channel");
  assert.throws(() => e.gw.completeCaRotation(), /laggard|w-/, "the other worker still holds an old-CA cert");
  e.gw.completeCaRotation(true);
  assert.equal(e.gw.pki.meta.serverGen, 2);
  await w.p.stdin!.write("renew\n"); await sleep(300);
  const c = await e.raw({ key: bId.key, cert: bId.cert, ca: e.gw.pki.trustedPems() }); c.send(HELLO); await c.closed;
  assert.equal(e.gw.listWorkers().find((x) => x.id === b.worker.id)!.online, false, "old-CA identity can no longer authenticate");
  assert.equal(e.gw.listWorkers().find((x) => x.id === a.worker.id)!.online, true, "renewed worker is unaffected");
  w.p.kill("SIGSTOP"); w.p.kill("SIGCONT"); // still alive
  const srvCert = certInfo(fs.readFileSync(path.join(e.base, "ctl", "gateway-server.crt"), "utf8")); assert.equal(e.gw.pki.generationOf(fs.readFileSync(path.join(e.base, "ctl", "gateway-server.crt"), "utf8")), 2); assert.ok(srvCert.notAfter.getTime() > Date.now());
  assert.ok(types(e).includes("pki.ca_rotation_started") && types(e).includes("pki.ca_rotation_completed"));
});

test("a frozen worker is detected by missing heartbeats and recovers by itself", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { worker, dir } = await e.enrollCli("sleepy"); const w = e.runWorker(dir); await w.waitFor("connected");
  const disc = new Promise<void>((r) => e.gw.once("disconnect", () => r()));
  w.p.kill("SIGSTOP"); await Promise.race([disc, sleep(8000)]);
  assert.equal(e.gw.listWorkers().find((x) => x.id === worker.id)!.online, false); assert.ok(dropped(e).includes("heartbeat timeout"));
  w.p.kill("SIGCONT"); await w.waitFor("connected", 2, 20_000); await until(() => e.gw.listWorkers().find((x) => x.id === worker.id)!.online, 5000, "worker back online");
});

test("the gateway listens on loopback only: wildcard is refused and a LAN address cannot reach it", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  assert.equal(e.addr.host, "127.0.0.1");
  const g2 = new Gateway(path.join(tmp(), "c2"), new Audit(path.join(tmp(), "a2.jsonl")), { host: "0.0.0.0", port: 0, env: {} });
  await assert.rejects(g2.start(), /refusing to bind/);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
  if (lan) await assert.rejects(new Promise((res, rej) => { const s = tls.connect({ host: lan.address, port: e.addr.port, rejectUnauthorized: false }, () => res(s)); s.on("error", rej); }), /ECONNREFUSED|ETIMEDOUT/);
});

test("the control-plane audit trail is a consistent hash chain with the expected event sequence", async (t) => {
  const e = await setup(); t.after(e.cleanup);
  const { dir } = await e.enrollCli("audited"); const w = e.runWorker(dir); await w.waitFor("connected");
  assert.ok(e.audit.verify().ok);
  const seq = types(e); for (const x of ["gateway.server_cert_issued", "gateway.started", "worker.created", "gateway.auth_anonymous", "worker.enrolled", "worker.connected"]) assert.ok(seq.includes(x), x);
  assert.ok(seq.indexOf("worker.created") < seq.indexOf("worker.enrolled") && seq.indexOf("worker.enrolled") < seq.indexOf("worker.connected"));
});
