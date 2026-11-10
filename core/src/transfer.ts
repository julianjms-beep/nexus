// Project transfer: explicit manifests, path validation, size limits and secret detection.
// Used in BOTH directions. Whatever a worker returns is untrusted data and goes through the same checks.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

export const LIMITS = { maxFiles: 1000, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };
export type Limits = typeof LIMITS;
export type ManifestFile = { path: string; size: number; sha256: string; mode: number };
export type Manifest = { files: ManifestFile[]; totalBytes: number };
export type SecretHit = { path: string; rule: string };
export class TransferError extends Error { constructor(msg: string, readonly details?: unknown) { super(msg); } }

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------- path rules
const EXCLUDED_DIRS = new Set([".git", "node_modules", ".nexus", ".venv", "venv", "__pycache__", ".ssh", ".aws", ".gnupg", ".idea", ".vscode", "dist", ".pytest_cache", ".mypy_cache"]);
const EXCLUDED_FILES = new Set([".DS_Store"]);
const SEGMENT = /^[A-Za-z0-9._@+=,~-]{1,100}$/;
/** Returns an error string when `p` is not a safe relative POSIX path. */
export function checkRelPath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p || p.length > 300) return "bad path length";
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return "control character or backslash in path";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "absolute path";
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return "dot or empty segment";
    if (!SEGMENT.test(s)) return "unsafe character in path segment";
    if (EXCLUDED_DIRS.has(s) && s !== segs[segs.length - 1]) return `forbidden directory ${s}`;
  }
  if (EXCLUDED_DIRS.has(segs[segs.length - 1])) return "forbidden name";
  return undefined;
}

// ---------------------------------------------------------------- secrets
const NAME_RULES: [string, RegExp][] = [
  ["env-file", /(^|\/)\.env(\.|$)/], ["private-key-file", /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.|$)/], ["key-material-file", /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i],
  ["credentials-file", /(^|\/)(\.npmrc|\.netrc|\.pypirc|credentials|credentials\.json|secrets\.(json|ya?ml)|service-account.*\.json)$/i],
];
const CONTENT_RULES: [string, RegExp][] = [
  ["private-key-block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/], ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/], ["openai-style-key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/], ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/], ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-key", /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/], ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
];
const ASSIGNMENT = /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=_.-]{20,})/gi;
function entropy(s: string) { const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1); let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); } return h; }

/** Names the rule that matched, never the secret itself. */
export function scanSecrets(relPath: string, content: Buffer): string | undefined {
  for (const [rule, re] of NAME_RULES) if (re.test(relPath)) return rule;
  const text = content.subarray(0, LIMITS.maxFileBytes).toString("latin1");
  for (const [rule, re] of CONTENT_RULES) if (re.test(text)) return rule;
  for (const m of text.matchAll(ASSIGNMENT)) if (entropy(m[1]) >= 3.5) return "high-entropy-assignment";
  return undefined;
}

// ---------------------------------------------------------------- manifest (sender side)
export type BuildResult = { manifest: Manifest; skipped: { path: string; reason: string }[]; secrets: SecretHit[] };
export function buildManifest(root: string, limits: Limits = LIMITS): BuildResult {
  const files: ManifestFile[] = []; const skipped: BuildResult["skipped"] = []; const secrets: SecretHit[] = [];
  let total = 0;
  const walk = (dir: string, rel: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${ent.name}` : ent.name; const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) { skipped.push({ path: r, reason: "symlink" }); continue; }
      if (ent.isDirectory()) { if (EXCLUDED_DIRS.has(ent.name)) { skipped.push({ path: r, reason: "excluded directory" }); continue; } walk(full, r); continue; }
      if (!ent.isFile()) { skipped.push({ path: r, reason: "not a regular file" }); continue; }
      if (EXCLUDED_FILES.has(ent.name)) continue;
      const bad = checkRelPath(r); if (bad) { skipped.push({ path: r, reason: bad }); continue; }
      const st = fs.statSync(full);
      if (st.size > limits.maxFileBytes) { skipped.push({ path: r, reason: "file too large" }); continue; }
      const buf = fs.readFileSync(full);
      const rule = scanSecrets(r, buf); if (rule) { secrets.push({ path: r, rule }); continue; }
      if (files.length >= limits.maxFiles) throw new TransferError(`too many files (limit ${limits.maxFiles})`);
      total += buf.length; if (total > limits.maxTotalBytes) throw new TransferError(`project too large (limit ${limits.maxTotalBytes} bytes)`);
      files.push({ path: r, size: buf.length, sha256: sha256(buf), mode: st.mode & 0o111 ? 0o755 : 0o644 });
    }
  };
  walk(root, "");
  return { manifest: { files, totalBytes: total }, skipped, secrets };
}

/** Packs exactly the manifest's files; re-verifies hashes at pack time (files may change after the manifest was built). */
export function packBundle(root: string, files: { path: string; sha256?: string; mode: number }[]): Buffer {
  const entries = files.map((f) => {
    const buf = fs.readFileSync(path.join(root, f.path));
    if (f.sha256 && sha256(buf) !== f.sha256) throw new TransferError(`file changed while packing: ${f.path}`);
    return { path: f.path, mode: f.mode, data: buf.toString("base64") };
  });
  return zlib.gzipSync(Buffer.from(JSON.stringify({ files: entries })));
}

// ---------------------------------------------------------------- receiving (worker side AND control side)
export type ReceivedFile = { path: string; mode: number; content: Buffer };
function readBundle(buf: Buffer, limits: Limits): ReceivedFile[] {
  let json: any;
  try { json = JSON.parse(zlib.gunzipSync(buf, { maxOutputLength: Math.ceil(limits.maxTotalBytes * 1.5) + 1_000_000 }).toString("utf8")); }
  catch { throw new TransferError("bundle is not valid gzip JSON within size limits"); }
  if (!json || !Array.isArray(json.files)) throw new TransferError("bundle has no files array");
  if (json.files.length > limits.maxFiles) throw new TransferError("too many files in bundle");
  const out: ReceivedFile[] = []; const seen = new Set<string>(); let total = 0;
  for (const e of json.files) {
    const bad = checkRelPath(e?.path); if (bad) throw new TransferError(`invalid path in bundle: ${bad}`);
    if (seen.has(e.path)) throw new TransferError("duplicate path in bundle"); seen.add(e.path);
    if (typeof e.data !== "string") throw new TransferError("bad file data");
    const content = Buffer.from(e.data, "base64");
    if (content.length > limits.maxFileBytes) throw new TransferError(`file too large: ${e.path}`);
    total += content.length; if (total > limits.maxTotalBytes) throw new TransferError("bundle too large");
    out.push({ path: e.path, mode: e.mode === 0o755 ? 0o755 : 0o644, content }); // modes are normalised: never setuid/setgid/world-writable
  }
  return out;
}

/** Worker side: the bundle must contain EXACTLY the manifest's files with matching sizes and hashes. */
export function unpackToDir(buf: Buffer, manifest: Manifest, dest: string, limits: Limits = LIMITS): number {
  const files = readBundle(buf, limits);
  if (files.length !== manifest.files.length) throw new TransferError("bundle does not match manifest (count)");
  const want = new Map(manifest.files.map((f) => [f.path, f]));
  const root = fs.realpathSync(dest);
  for (const f of files) {
    const m = want.get(f.path);
    if (!m) throw new TransferError(`file not in manifest: ${f.path}`);
    if (m.size !== f.content.length || m.sha256 !== sha256(f.content)) throw new TransferError(`size/hash mismatch: ${f.path}`);
    const full = path.resolve(root, f.path);
    if (path.relative(root, full).startsWith("..")) throw new TransferError("path escapes destination");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, { mode: f.mode, flag: "wx" }); // 'wx': never overwrite, never follow a planted link
  }
  return files.length;
}

/** Control side: validate files returned by a worker. Untrusted: any violation rejects the whole output. */
export function validateReturned(buf: Buffer, limits: Limits = { maxFiles: 500, maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: 10 * 1024 * 1024 }): ReceivedFile[] {
  const files = readBundle(buf, limits);
  const secrets: SecretHit[] = [];
  for (const f of files) { const r = scanSecrets(f.path, f.content); if (r) secrets.push({ path: f.path, rule: r }); }
  if (secrets.length) throw new TransferError("returned files contain secrets", secrets);
  return files;
}

/** Worker side: files that are new or changed relative to what was sent. Deletions are reported but never applied. */
export function collectChanges(dir: string, base: Manifest, limits: Limits = { maxFiles: 500, maxFileBytes: LIMITS.maxFileBytes, maxTotalBytes: 10 * 1024 * 1024 }) {
  const now = buildManifest(dir, { ...LIMITS, maxFiles: LIMITS.maxFiles }).manifest;
  const before = new Map(base.files.map((f) => [f.path, f.sha256]));
  const changed = now.files.filter((f) => before.get(f.path) !== f.sha256);
  const deleted = base.files.filter((f) => !now.files.some((n) => n.path === f.path)).map((f) => f.path);
  if (changed.length > limits.maxFiles) throw new TransferError("too many changed files");
  return { changed, deleted, bundle: changed.length ? packBundle(dir, changed) : null };
}
export { sha256 };
