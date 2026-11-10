// Private PKI for NEXUS workers. Uses the system `openssl` CLI for X.509 issuance and Node's crypto for parsing.
// No custom cryptographic primitives: EC P-256 keys, ECDSA-SHA256 signatures, standard X.509 extensions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate, randomBytes } from "node:crypto";

const OPENSSL = "/usr/bin/openssl";
const ossl = (args: string[]) => execFileSync(OPENSSL, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function withTmp<T>(fn: (dir: string) => T): T {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-pki-"));
  try { return fn(d); } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
const REQ_CNF = "[req]\ndistinguished_name=dn\n[dn]\n"; // no prompt=no: it would override -subj

export const fingerprintOf = (pem: string) => new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase();
export function certInfo(pem: string) {
  const c = new X509Certificate(pem);
  const cn = /^CN=(.+)$/m.exec(c.subject)?.[1];
  return { fingerprint: fingerprintOf(pem), cn, notBefore: new Date(c.validFrom), notAfter: new Date(c.validTo), isCA: c.ca, x509: c };
}
/** Renew once less than a third of the certificate's lifetime remains. */
export function shouldRenew(pem: string, now = Date.now()) {
  const i = certInfo(pem); const total = i.notAfter.getTime() - i.notBefore.getTime();
  return i.notAfter.getTime() - now < total / 3;
}

/** Worker/gateway side: fresh EC P-256 key + CSR. The private key never leaves the caller. */
export function generateKeyAndCsr(cn: string): { keyPem: string; csrPem: string } {
  if (!/^[\w.-]{1,64}$/.test(cn)) throw new Error("bad common name");
  return withTmp((d) => {
    const key = path.join(d, "k.pem"), csr = path.join(d, "r.pem"), cnf = path.join(d, "req.cnf");
    fs.writeFileSync(cnf, REQ_CNF);
    ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]);
    ossl(["req", "-new", "-key", key, "-subj", `/CN=${cn}`, "-config", cnf, "-out", csr]);
    return { keyPem: fs.readFileSync(key, "utf8"), csrPem: fs.readFileSync(csr, "utf8") };
  });
}
/** Validates a CSR (signature, EC P-256 only) and returns its common name. */
export function inspectCsr(csrPem: string): { cn: string } {
  if (csrPem.length > 4096 || !/^-----BEGIN CERTIFICATE REQUEST-----/.test(csrPem)) throw new Error("not a CSR");
  return withTmp((d) => {
    const f = path.join(d, "r.pem"); fs.writeFileSync(f, csrPem);
    const v = spawnSync(OPENSSL, ["req", "-in", f, "-noout", "-verify"], { encoding: "utf8" });
    if (v.status !== 0 || !/verify OK/.test(v.stdout + v.stderr)) throw new Error("CSR signature invalid");
    const text = ossl(["req", "-in", f, "-noout", "-text"]);
    if (!/prime256v1/.test(text) || !/id-ecPublicKey/.test(text)) throw new Error("CSR key must be EC P-256");
    const cn = /Subject:\s*CN\s*=\s*([\w.-]+)\s*$/m.exec(text)?.[1];
    if (!cn) throw new Error("CSR subject must be a single CN");
    return { cn };
  });
}

type Meta = { active: number; serverGen: number; gens: { n: number; notAfter: string; retired?: boolean }[] };

export class Pki {
  meta: Meta = { active: 0, serverGen: 0, gens: [] };
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, "utf8")); } catch { /* first start */ }
  }
  private get metaFile() { return path.join(this.dir, "meta.json"); }
  private save() { fs.writeFileSync(this.metaFile, JSON.stringify(this.meta, null, 2)); }
  private p(n: number, ext: "key" | "crt") { return path.join(this.dir, `ca-${n}.${ext}`); }

  init() { if (!this.meta.gens.length) this.newGeneration(); return this; }

  /** Creates a new CA generation and makes it the one that signs new client certificates. */
  newGeneration(days = 3650): number {
    const n = Math.max(0, ...this.meta.gens.map((g) => g.n)) + 1;
    withTmp((d) => {
      const cnf = path.join(d, "ca.cnf");
      fs.writeFileSync(cnf, `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=NEXUS CA gen ${n}\n[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n`);
      const key = this.p(n, "key");
      ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key]); fs.chmodSync(key, 0o600);
      ossl(["req", "-new", "-x509", "-key", key, "-sha256", "-days", String(days), "-config", cnf, "-out", this.p(n, "crt")]);
    });
    this.meta.gens.push({ n, notAfter: certInfo(this.pem(n)).notAfter.toISOString() });
    this.meta.active = n; if (!this.meta.serverGen) this.meta.serverGen = n;
    this.save(); return n;
  }
  pem(n: number) { return fs.readFileSync(this.p(n, "crt"), "utf8"); }
  trustedPems() { return this.meta.gens.filter((g) => !g.retired).map((g) => this.pem(g.n)); }
  activeGen() { return this.meta.active; }
  generationOf(certPem: string): number | undefined {
    const x = new X509Certificate(certPem);
    return this.meta.gens.filter((g) => !g.retired).find((g) => x.verify(new X509Certificate(this.pem(g.n)).publicKey))?.n;
  }

  /** Signs a CSR. `cn` is forced by the caller (the CSR's own subject is NOT trusted).
   *  `life` is a number of days, or an explicit validity window (sub-day lifetimes are supported). */
  sign(csrPem: string, cn: string, usage: "client" | "server", life: number | { notBefore: Date; notAfter: Date }, sans: string[] = [], gen = this.meta.active): string {
    if (usage === "server" && !sans.length) throw new Error("server certs need SANs");
    const now = Date.now();
    const win = typeof life === "number" ? { notBefore: new Date(now - 5 * 60_000), notAfter: new Date(now + life * 86_400_000) } : life; // 5 min clock-skew allowance
    const fmt = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"; // YYMMDDHHMMSSZ
    return withTmp((d) => {
      const csr = path.join(d, "r.pem"), cnf = path.join(d, "ca.cnf"), out = path.join(d, "c.pem");
      fs.writeFileSync(csr, csrPem); fs.writeFileSync(path.join(d, "index.txt"), ""); fs.writeFileSync(path.join(d, "serial"), randomBytes(12).toString("hex") + "\n");
      const eku = usage === "client" ? "clientAuth" : "serverAuth";
      fs.writeFileSync(cnf, `[ca]\ndefault_ca=CA\n[CA]\ndatabase=${d}/index.txt\nnew_certs_dir=${d}\nserial=${d}/serial\ndefault_md=sha256\npolicy=pol\nunique_subject=no\nx509_extensions=ext\n[pol]\ncommonName=supplied\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\n${usage === "server" ? `subjectAltName=${sans.join(",")}\n` : ""}`);
      ossl(["ca", "-batch", "-notext", "-config", cnf, "-cert", this.p(gen, "crt"), "-keyfile", this.p(gen, "key"), "-in", csr, "-out", out,
        "-startdate", fmt(win.notBefore), "-enddate", fmt(win.notAfter)]);
      const pem = fs.readFileSync(out, "utf8");
      if (certInfo(pem).cn !== cn) throw new Error("issued certificate CN does not match the expected identity");
      return pem;
    });
  }
  /** Gateway TLS certificate, signed by the CA generation that workers currently pin (serverGen). */
  issueServer(names: string[], days = 90): { keyPem: string; certPem: string } {
    const sans = names.map((n) => (/^[\d.]+$/.test(n) || n.includes(":") ? `IP:${n}` : `DNS:${n}`));
    const { keyPem, csrPem } = generateKeyAndCsr("nexus-gateway");
    return { keyPem, certPem: this.sign(csrPem, "nexus-gateway", "server", days, sans, this.meta.serverGen) };
  }

  /** CA rotation, phase 1: new generation signs new client certs; the server cert stays on the old CA until workers have the new bundle. */
  rotate() { return this.newGeneration(); }
  /** Phase 2: server cert moves to the active CA and every older generation stops being trusted. */
  completeRotation() {
    this.meta.serverGen = this.meta.active;
    for (const g of this.meta.gens) if (g.n < this.meta.active) g.retired = true;
    this.save();
  }
}
