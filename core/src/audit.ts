// Append-only JSONL audit log with a SHA-256 hash chain and optional per-record signatures.
//
// IMPORTANT: the hash chain alone is NOT a tamper-proof log. It detects accidental corruption and naive edits, but anyone with
// write access to the file can recompute the whole chain, truncate it, or roll it back. Signatures help only if the signing key
// is NOT on the audited host (HSM / remote signer), and real immutability additionally needs external anchoring of the head
// hash (append-only store, transparency log). See docs/AUDIT.md.
import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey } from "node:crypto";

export interface AuditSigner { keyId: string; /** signs a record hash (hex); returns base64 */ sign(hashHex: string): string }
export type AuditEvent = { seq: number; ts: string; type: string; data: unknown; prev: string; hash: string; sig?: string; keyId?: string };

/** Ed25519 signer using Node's crypto (no custom primitives). The key file is 0600 and created on first use. */
export class Ed25519FileSigner implements AuditSigner {
  keyId: string; publicKeyPem: string; private key;
  constructor(keyFile: string) {
    if (!fs.existsSync(keyFile)) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      const { privateKey } = generateKeyPairSync("ed25519");
      fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    this.key = createPrivateKey(fs.readFileSync(keyFile));
    this.publicKeyPem = createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString();
    this.keyId = createHash("sha256").update(this.publicKeyPem).digest("hex").slice(0, 16);
  }
  sign(hashHex: string) { return edSign(null, Buffer.from(hashHex, "hex"), this.key).toString("base64"); }
}
export function verifySignature(publicKeyPem: string, hashHex: string, sigB64: string): boolean {
  try { return edVerify(null, Buffer.from(hashHex, "hex"), createPublicKey(publicKeyPem), Buffer.from(sigB64, "base64")); } catch { return false; }
}

export class Audit {
  private last = "genesis";
  private seq = 0;
  constructor(private file: string, private signer?: AuditSigner) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (lines.length) {
        const e = JSON.parse(lines[lines.length - 1]) as AuditEvent;
        this.last = e.hash;
        this.seq = e.seq;
      }
    }
  }
  /** Hash of the newest record: the value to anchor externally. */
  head() { return { seq: this.seq, hash: this.last }; }
  record(type: string, data: unknown): AuditEvent {
    const base = { seq: ++this.seq, ts: new Date().toISOString(), type, data, prev: this.last };
    const hash = createHash("sha256").update(JSON.stringify(base)).digest("hex");
    const ev: AuditEvent = { ...base, hash };
    if (this.signer) { ev.sig = this.signer.sign(hash); ev.keyId = this.signer.keyId; }
    fs.appendFileSync(this.file, JSON.stringify(ev) + "\n");
    this.last = hash;
    return ev;
  }
  read(): AuditEvent[] {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  /** Verifies the chain; with `publicKeyPem` also verifies signatures (and, with requireSigned, that every record has one). */
  verify(opts: { publicKeyPem?: string; requireSigned?: boolean } = {}): { ok: boolean; brokenAt?: number; reason?: string } {
    let prev = "genesis";
    for (const e of this.read()) {
      const { hash, sig, keyId, ...base } = e;
      const expect = createHash("sha256").update(JSON.stringify(base)).digest("hex");
      if (e.prev !== prev || hash !== expect) return { ok: false, brokenAt: e.seq, reason: "hash chain" };
      if (opts.publicKeyPem) {
        if (!sig) { if (opts.requireSigned) return { ok: false, brokenAt: e.seq, reason: "unsigned record" }; }
        else if (!verifySignature(opts.publicKeyPem, hash, sig)) return { ok: false, brokenAt: e.seq, reason: "bad signature" };
      }
      prev = hash;
    }
    return { ok: true };
  }
}
