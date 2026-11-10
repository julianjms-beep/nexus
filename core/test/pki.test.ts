// Cryptography lifecycle, network exposure policy, isolation providers, signed audit and protocol framing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { Pki, generateKeyAndCsr, inspectCsr, certInfo, shouldRenew } from "../src/pki.ts";
import { resolveGatewayBind, classify } from "../src/netpolicy.ts";
import { detectIsolation } from "../src/isolation.ts";
import { Audit, Ed25519FileSigner } from "../src/audit.ts";
import { validateFrame, WORKER_MESSAGES, GATEWAY_MESSAGES, FrameReader, sanitizeText, clampNumber, chunkBuffer, MAX_FRAME_BYTES } from "../src/protocol.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pkit-")));
const DAY = 86_400_000;

test("issuance: client cert is bound to the forced CN, matches the worker's own key, and is not a CA", () => {
  const pki = new Pki(tmp()).init();
  const { keyPem, csrPem } = generateKeyAndCsr("w-aaaaaaaaaa");
  const cert = pki.sign(csrPem, "w-aaaaaaaaaa", "client", 7); const i = certInfo(cert);
  assert.equal(i.cn, "w-aaaaaaaaaa"); assert.equal(i.isCA, false);
  assert.ok(i.x509.checkPrivateKey(createPrivateKey(keyPem)));
  assert.match(i.x509.keyUsage?.join(",") ?? "", /Client Authentication|1\.3\.6\.1\.5\.5\.7\.3\.2/);
  assert.throws(() => pki.sign(csrPem, "w-someone-else", "client", 7), /CN does not match/, "CSR subject is not trusted");
});

test("CSR validation: bad signature, non-EC keys and malformed input are refused", () => {
  assert.throws(() => inspectCsr("-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----\n"));
  assert.throws(() => inspectCsr("hello"));
  const d = tmp();
  execFileSync("/usr/bin/openssl", ["genrsa", "-out", path.join(d, "rsa.pem"), "2048"], { stdio: "ignore" });
  execFileSync("/usr/bin/openssl", ["req", "-new", "-key", path.join(d, "rsa.pem"), "-subj", "/CN=w-bbbbbbbbbb", "-out", path.join(d, "rsa.csr"), "-config", (() => { fs.writeFileSync(path.join(d, "c.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n"); return path.join(d, "c.cnf"); })()], { stdio: "ignore" });
  assert.throws(() => inspectCsr(fs.readFileSync(path.join(d, "rsa.csr"), "utf8")), /EC P-256|too long|not a CSR/);
  assert.throws(() => generateKeyAndCsr("bad name; rm -rf"), /bad common name/);
});

test("renewal policy: renew when less than a third of the lifetime remains; short lifetimes are supported", () => {
  const pki = new Pki(tmp()).init(); const { csrPem } = generateKeyAndCsr("w-cccccccccc");
  const now = Date.now();
  const fresh = pki.sign(csrPem, "w-cccccccccc", "client", { notBefore: new Date(now - 60_000), notAfter: new Date(now + 3 * DAY) });
  assert.equal(shouldRenew(fresh, now), false);
  assert.equal(shouldRenew(fresh, now + 2.5 * DAY), true);
  const expired = pki.sign(csrPem, "w-cccccccccc", "client", { notBefore: new Date(now - 2 * DAY), notAfter: new Date(now - DAY) });
  assert.ok(certInfo(expired).notAfter.getTime() < now); assert.equal(shouldRenew(expired, now), true);
});

test("CA rotation: overlap trusts both generations, completion retires the old one", () => {
  const pki = new Pki(tmp()).init(); const { csrPem } = generateKeyAndCsr("w-dddddddddd");
  const old = pki.sign(csrPem, "w-dddddddddd", "client", 7);
  assert.equal(pki.generationOf(old), 1);
  const gen2 = pki.rotate(); assert.equal(gen2, 2); assert.equal(pki.trustedPems().length, 2);
  const fresh = pki.sign(csrPem, "w-dddddddddd", "client", 7); assert.equal(pki.generationOf(fresh), 2);
  assert.equal(pki.generationOf(old), 1, "old certs still trusted during overlap");
  assert.equal(pki.meta.serverGen, 1, "server cert stays on the CA workers pin until completion");
  pki.completeRotation();
  assert.equal(pki.trustedPems().length, 1); assert.equal(pki.generationOf(old), undefined, "old CA no longer trusts anything"); assert.equal(pki.meta.serverGen, 2);
  assert.throws(() => new Pki(tmp()).sign(csrPem, "w-dddddddddd", "server", 7), /./);
});

test("server certificates carry SANs and the serverAuth purpose", () => {
  const pki = new Pki(tmp()).init(); const s = pki.issueServer(["localhost", "127.0.0.1"]); const x = certInfo(s.certPem).x509;
  assert.match(x.subjectAltName ?? "", /DNS:localhost/); assert.match(x.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  assert.match(x.keyUsage?.join(",") ?? "", /Server Authentication|1\.3\.6\.1\.5\.5\.7\.3\.1/);
});

test("network exposure: loopback by default; every wider bind needs its own explicit opt-in", () => {
  assert.equal(resolveGatewayBind(undefined, {}).host, "127.0.0.1"); assert.equal(resolveGatewayBind("localhost", {}).exposure, "loopback"); assert.equal(resolveGatewayBind("::1", {}).exposure, "loopback");
  assert.throws(() => resolveGatewayBind("192.168.1.66", {}), /refusing/);
  const lan = resolveGatewayBind("192.168.1.66", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1" }); assert.equal(lan.exposure, "private"); assert.ok(lan.warnings.length);
  assert.throws(() => resolveGatewayBind("0.0.0.0", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1" }), /wildcard/);
  assert.equal(resolveGatewayBind("0.0.0.0", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1", NEXUS_GATEWAY_ALLOW_WILDCARD: "1" }).exposure, "wildcard");
  assert.throws(() => resolveGatewayBind("8.8.8.8", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1" }), /not exposed to the Internet by default/);
  assert.throws(() => resolveGatewayBind("8.8.8.8", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1", NEXUS_GATEWAY_ALLOW_PUBLIC: "1" }), /not exposed/);
  assert.equal(resolveGatewayBind("8.8.8.8", { NEXUS_GATEWAY_ALLOW_NON_LOOPBACK: "1", NEXUS_GATEWAY_ALLOW_PUBLIC: "I_UNDERSTAND_THIS_EXPOSES_THE_GATEWAY_TO_THE_INTERNET" }).exposure, "public");
  assert.throws(() => resolveGatewayBind("example.com", {}), /IP literal/);
  for (const [ip, want] of [["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.32.0.1", "public"], ["100.64.1.1", "private"], ["169.254.1.1", "private"], ["fd00::1", "private"], ["2001:db8::1", "public"]] as const) assert.equal(classify(ip), want, ip);
});

test("isolation providers: macOS seatbelt, Linux bwrap (verified on Linux only); other platforms refuse to execute", () => {
  assert.deepEqual(detectIsolation("darwin", () => true), { available: true, mechanism: "seatbelt", platform: "darwin" });
  assert.equal(detectIsolation("darwin", () => false).available, false);
  const lin = detectIsolation("linux");
  if (process.platform === "linux") assert.ok(lin.mechanism === "linux-bwrap" || lin.available === false, JSON.stringify(lin));
  else { assert.equal(lin.available, false); assert.match(lin.reason!, /only be verified on a linux host/); }
  for (const p of ["win32", "freebsd"]) { const i = detectIsolation(p, () => true); assert.equal(i.available, false, p); assert.match(i.reason!, /no isolation mechanism implemented/); }
});

test("signed audit: signatures verify; tampering is detected; a recomputed hash chain is NOT detected without the public key (documented limitation)", () => {
  const d = tmp(); const signer = new Ed25519FileSigner(path.join(d, "audit.key"));
  assert.equal(fs.statSync(path.join(d, "audit.key")).mode & 0o777, 0o600);
  const a = new Audit(path.join(d, "a.jsonl"), signer); a.record("one", { n: 1 }); a.record("two", { n: 2 }); a.record("three", { n: 3 });
  assert.deepEqual(a.verify({ publicKeyPem: signer.publicKeyPem, requireSigned: true }), { ok: true });
  assert.equal(a.head().seq, 3);
  // 1) naive edit of a record -> chain breaks
  const f = path.join(d, "a.jsonl"); const orig = fs.readFileSync(f, "utf8");
  fs.writeFileSync(f, orig.replace('"n":2', '"n":99')); assert.equal(new Audit(f).verify().ok, false);
  // 2) attacker rewrites the whole chain with recomputed hashes (no signing key)
  const forged = new Audit(path.join(d, "forged.jsonl")); forged.record("one", { n: 1 }); forged.record("two", { n: 99 }); forged.record("three", { n: 3 });
  assert.equal(forged.verify().ok, true, "hash chain alone accepts a forged-but-consistent log: it is not tamper-proof");
  assert.equal(forged.verify({ publicKeyPem: signer.publicKeyPem, requireSigned: true }).ok, false, "a signature check catches it unless the attacker holds the key");
  // 3) tampering with a signed record's content breaks both
  fs.writeFileSync(f, orig); assert.equal(new Audit(f).verify({ publicKeyPem: signer.publicKeyPem }).ok, true);
  const other = new Ed25519FileSigner(path.join(d, "other.key")); assert.equal(new Audit(f).verify({ publicKeyPem: other.publicKeyPem }).ok, false, "wrong key");
});

test("protocol validation: whitelists types and fields, rejects wrong shapes and unknown fields", () => {
  const ok = { type: "hello", version: 1, platform: "darwin", isolation: {}, kinds: [], running: [] };
  assert.equal(validateFrame(ok, WORKER_MESSAGES), undefined);
  assert.match(validateFrame({ ...ok, type: "exec" }, WORKER_MESSAGES)!, /unknown message type/);
  assert.match(validateFrame({ ...ok, type: "constructor" }, WORKER_MESSAGES)!, /unknown message type/);
  assert.match(validateFrame({ ...ok, extra: 1 }, WORKER_MESSAGES)!, /unexpected field/);
  assert.match(validateFrame({ ...ok, version: "1" }, WORKER_MESSAGES)!, /must be number/);
  assert.match(validateFrame({ ...ok, kinds: {} }, WORKER_MESSAGES)!, /must be array/);
  assert.match(validateFrame({ type: "hello" }, WORKER_MESSAGES)!, /missing field/);
  assert.match(validateFrame({ type: "heartbeat", running: [], active: Infinity }, WORKER_MESSAGES)!, /finite/);
  assert.match(validateFrame([], WORKER_MESSAGES)!, /object/);
  assert.equal(validateFrame({ type: "bye", reason: "x" }, GATEWAY_MESSAGES), undefined);
  assert.match(validateFrame({ type: "bye", reason: "x" }, WORKER_MESSAGES)!, /unknown message type/, "directions are separate");
});

test("untrusted text is sanitised and numbers are clamped", () => {
  assert.equal(sanitizeText("ok\u0000\u001b[31m\u0007 text\n\ttab"), "ok[31m text\n\ttab"); assert.equal(sanitizeText("x".repeat(100), 10).length, 10); assert.equal(sanitizeText({}), "");
  assert.equal(clampNumber(NaN, 0, 5, 3), 3); assert.equal(clampNumber(-9, 0, 5), 0); assert.equal(clampNumber(99, 0, 5), 5); assert.equal(clampNumber("7", 0, 5, 1), 1);
  assert.equal(chunkBuffer(Buffer.alloc(300 * 1024)).length, 3); assert.equal(chunkBuffer(Buffer.alloc(0)).length, 1);
});

test("framing: oversized frames, malformed JSON and floods are rejected", async () => {
  const errors: string[] = []; const frames: any[] = [];
  const srv = net.createServer((s) => { new FrameReader(s, (f) => frames.push(f), (e) => { errors.push(e); s.destroy(); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const port = (srv.address() as any).port;
  const send = (data: string) => new Promise<void>((res) => { const c = net.connect(port, "127.0.0.1", () => { c.write(data); setTimeout(() => { c.destroy(); res(); }, 150); }); });
  await send('{"type":"a"}\n{"type":"b"}\n'); assert.equal(frames.length, 2);
  await send("{not json}\n"); await send("x".repeat(MAX_FRAME_BYTES + 10) + "\n"); await send("y".repeat(MAX_FRAME_BYTES + 10)); // no newline at all
  await send('{"type":"a"}\n'.repeat(700));
  srv.close();
  assert.deepEqual([errors[0], errors[1], errors[2]], ["malformed JSON", "frame too large", "frame too large"]); assert.ok(errors.includes("rate limit exceeded"));
});
