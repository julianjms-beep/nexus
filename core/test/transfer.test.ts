// Explicit manifests, path validation, size limits, secret detection, and untrusted-return handling.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { checkRelPath, scanSecrets, buildManifest, packBundle, unpackToDir, validateReturned, collectChanges, sha256, TransferError, LIMITS } from "../src/transfer.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-xfer-")));
const put = (root: string, rel: string, content: string | Buffer, mode?: number) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content, { mode }); };
const bundleOf = (files: { path: string; data: string; mode?: number }[]) => zlib.gzipSync(Buffer.from(JSON.stringify({ files })));
// synthetic strings shaped like real secrets (not valid credentials)
const FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP"; const FAKE_ANT = "sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789"; const FAKE_PEM = "-----BEGIN " + "PRIVATE KEY-----\nMIIB\n-----END " + "PRIVATE KEY-----";

test("path rules reject traversal, absolute paths, odd characters and forbidden names", () => {
  for (const ok of ["a.py", "src/app/main.py", "tests/test_x.py", "docs/README.md", ".gitignore"]) assert.equal(checkRelPath(ok), undefined, ok);
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a//b", "./a", "a/./b", "a\\b", "a\u0000b", "", "a b.txt", ".git/config", "node_modules/x/y.js", "a/.ssh/id", ".nexus/token", "x".repeat(400), "ä.py", ".git"]) assert.ok(checkRelPath(bad), `should reject ${JSON.stringify(bad)}`);
  assert.ok(checkRelPath(5 as any));
});

test("secret detection names the rule and never matches ordinary code", () => {
  assert.equal(scanSecrets("a.txt", Buffer.from(FAKE_AWS)), "aws-access-key"); assert.equal(scanSecrets("a.txt", Buffer.from("key=" + FAKE_ANT)), "anthropic-key");
  assert.equal(scanSecrets("k.txt", Buffer.from(FAKE_PEM)), "private-key-block"); assert.equal(scanSecrets(".env", Buffer.from("A=1")), "env-file"); assert.equal(scanSecrets("config/.env.production", Buffer.from("")), "env-file");
  assert.equal(scanSecrets("deploy/server.pem", Buffer.from("x")), "key-material-file"); assert.equal(scanSecrets("id_rsa", Buffer.from("x")), "private-key-file");
  assert.equal(scanSecrets("c.py", Buffer.from('api_key = "Zq8fK2mX9vL4nR7tB1wY6hJ3pD5sA0cE"')), "high-entropy-assignment");
  assert.equal(scanSecrets("t.js", Buffer.from("ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")), "github-token");
  for (const benign of ['password = "changeme"', "const token = getToken(user)", "api_key = os.environ['API_KEY']", "def secret_santa(): pass", "# TODO rotate the token", "token: aaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) assert.equal(scanSecrets("x.py", Buffer.from(benign)), undefined, benign);
});

test("manifest: explicit allowed files only; excludes .git, node_modules, symlinks, hidden-secret files; hashes are correct", () => {
  const r = tmp(); put(r, "app.py", "print(1)\n"); put(r, "src/lib.py", "x=1\n"); put(r, "run.sh", "#!/bin/sh\n", 0o755); put(r, ".git/config", "[core]"); put(r, "node_modules/m/i.js", "1"); put(r, "__pycache__/a.pyc", "x"); put(r, ".DS_Store", "x");
  fs.symlinkSync("/etc/hosts", path.join(r, "link")); put(r, "bad name.txt", "x");
  const b = buildManifest(r);
  assert.deepEqual(b.manifest.files.map((f) => f.path), ["app.py", "run.sh", "src/lib.py"]);
  assert.equal(b.manifest.files.find((f) => f.path === "app.py")!.sha256, sha256(Buffer.from("print(1)\n"))); assert.equal(b.manifest.files.find((f) => f.path === "run.sh")!.mode, 0o755);
  const why = Object.fromEntries(b.skipped.map((s) => [s.path, s.reason])); assert.equal(why["link"], "symlink"); assert.equal(why[".git"], "excluded directory"); assert.match(why["bad name.txt"], /unsafe/);
  assert.deepEqual(b.secrets, []);
});

test("manifest: files with secrets are withheld and reported by path and rule only", () => {
  const r = tmp(); put(r, "ok.py", "x=1\n"); put(r, "cfg.py", `KEY = "${FAKE_AWS}"\n`); put(r, ".env", "A=1\n"); put(r, "pem/key.pem", FAKE_PEM);
  const b = buildManifest(r);
  assert.deepEqual(b.manifest.files.map((f) => f.path), ["ok.py"]);
  assert.deepEqual(b.secrets.map((s) => `${s.path}:${s.rule}`).sort(), [".env:env-file", "cfg.py:aws-access-key", "pem/key.pem:key-material-file"]);
  assert.ok(!JSON.stringify(b).includes(FAKE_AWS), "the secret itself never appears in the report");
});

test("manifest limits: file count, per-file and total size", () => {
  const r = tmp(); for (let i = 0; i < 5; i++) put(r, `f${i}.txt`, "x".repeat(100));
  assert.throws(() => buildManifest(r, { ...LIMITS, maxFiles: 3 }), /too many files/);
  assert.throws(() => buildManifest(r, { ...LIMITS, maxTotalBytes: 250 }), /project too large/);
  const big = tmp(); put(big, "big.bin", Buffer.alloc(300)); put(big, "small.txt", "x");
  const b = buildManifest(big, { ...LIMITS, maxFileBytes: 200 }); assert.deepEqual(b.manifest.files.map((f) => f.path), ["small.txt"]); assert.equal(b.skipped[0].reason, "file too large");
});

test("round trip: pack on the control side, unpack on the worker, modes normalised", () => {
  const r = tmp(); put(r, "a.py", "print('a')\n"); put(r, "d/b.py", "print('b')\n"); put(r, "x.sh", "#!/bin/sh\n", 0o755);
  const m = buildManifest(r).manifest; const buf = packBundle(r, m.files);
  const dest = tmp(); assert.equal(unpackToDir(buf, m, dest), 3);
  assert.equal(fs.readFileSync(path.join(dest, "d/b.py"), "utf8"), "print('b')\n"); assert.equal(fs.statSync(path.join(dest, "x.sh")).mode & 0o777, 0o755); assert.equal(fs.statSync(path.join(dest, "a.py")).mode & 0o777, 0o644);
});

test("worker rejects any bundle that does not match the manifest exactly", () => {
  const r = tmp(); put(r, "a.py", "1\n"); put(r, "b.py", "2\n"); const m = buildManifest(r).manifest;
  const entry = (p: string, d: string) => ({ path: p, data: Buffer.from(d).toString("base64") });
  assert.throws(() => unpackToDir(bundleOf([entry("a.py", "1\n")]), m, tmp()), /count/, "missing file");
  assert.throws(() => unpackToDir(bundleOf([entry("a.py", "1\n"), entry("b.py", "2\n"), entry("c.py", "3\n")]), m, tmp()), /count/, "extra file");
  assert.throws(() => unpackToDir(bundleOf([entry("a.py", "1\n"), entry("c.py", "2\n")]), m, tmp()), /not in manifest/);
  assert.throws(() => unpackToDir(bundleOf([entry("a.py", "1\n"), entry("b.py", "TAMPERED")]), m, tmp()), /mismatch/);
  assert.throws(() => unpackToDir(bundleOf([entry("a.py", "1\n"), entry("a.py", "1\n")]), m, tmp()), /duplicate|count/);
  assert.throws(() => unpackToDir(Buffer.from("not gzip"), m, tmp()), /gzip/);
});

test("path traversal inside a bundle is refused even if the manifest was forged to match", () => {
  const evil = "x\n"; const forged = { files: [{ path: "../escape.txt", size: 2, sha256: sha256(Buffer.from(evil)), mode: 0o644 }], totalBytes: 2 };
  const parent = tmp(); const dest = path.join(parent, "dest"); fs.mkdirSync(dest);
  assert.throws(() => unpackToDir(bundleOf([{ path: "../escape.txt", data: Buffer.from(evil).toString("base64") }]), forged, dest), /invalid path/);
  assert.equal(fs.existsSync(path.join(parent, "escape.txt")), false);
  for (const p of ["/tmp/abs.txt", "a/../../b", ".git/hooks/pre-commit"]) assert.throws(() => unpackToDir(bundleOf([{ path: p, data: "eA==" }]), { files: [{ path: p, size: 1, sha256: sha256(Buffer.from("x")), mode: 0o644 }], totalBytes: 1 }, tmp()), /invalid path/);
});

test("unpack never overwrites or follows a pre-planted link in the destination", () => {
  const r = tmp(); put(r, "a.py", "1\n"); const m = buildManifest(r).manifest; const buf = packBundle(r, m.files);
  const dest = tmp(); const outside = path.join(tmp(), "victim.txt"); fs.writeFileSync(outside, "ORIGINAL"); fs.symlinkSync(outside, path.join(dest, "a.py"));
  assert.throws(() => unpackToDir(buf, m, dest)); assert.equal(fs.readFileSync(outside, "utf8"), "ORIGINAL");
});

test("size bombs: oversized decompressed bundles and oversized files are rejected", () => {
  const big = zlib.gzipSync(Buffer.from(JSON.stringify({ files: [{ path: "a.txt", data: Buffer.alloc(40 * 1024 * 1024).toString("base64") }] })));
  assert.ok(big.length < 200_000, "tiny on the wire, huge when expanded");
  assert.throws(() => validateReturned(big), TransferError);
  assert.throws(() => validateReturned(bundleOf([{ path: "a.txt", data: Buffer.alloc(3 * 1024 * 1024).toString("base64") }])), /too large/);
});

test("returned files are untrusted: secrets, bad paths and setuid modes are not accepted as-is", () => {
  const ok = validateReturned(bundleOf([{ path: "src/new.py", data: Buffer.from("x=1\n").toString("base64"), mode: 0o4755 }]));
  assert.equal(ok.length, 1); assert.equal(ok[0].mode, 0o644, "setuid/setgid/world-writable bits are dropped");
  assert.throws(() => validateReturned(bundleOf([{ path: "leak.txt", data: Buffer.from("k=" + FAKE_ANT).toString("base64") }])), /secrets/);
  assert.throws(() => validateReturned(bundleOf([{ path: "../../etc/x", data: "eA==" }])), /invalid path/);
  assert.throws(() => validateReturned(bundleOf([{ path: ".git/hooks/post-commit", data: "eA==" }])), /invalid path/);
  assert.throws(() => validateReturned(bundleOf([{ path: "a", data: 5 as any }])), /bad file data/);
});

test("collectChanges reports new and modified files and lists deletions without applying them", () => {
  const r = tmp(); put(r, "keep.py", "k\n"); put(r, "edit.py", "old\n"); put(r, "gone.py", "g\n"); const base = buildManifest(r).manifest;
  put(r, "edit.py", "new\n"); put(r, "added.py", "a\n"); fs.rmSync(path.join(r, "gone.py"));
  const c = collectChanges(r, base);
  assert.deepEqual(c.changed.map((f) => f.path).sort(), ["added.py", "edit.py"]); assert.deepEqual(c.deleted, ["gone.py"]);
  assert.deepEqual(validateReturned(c.bundle!).map((f) => f.path).sort(), ["added.py", "edit.py"]);
  assert.equal(collectChanges(tmp(), { files: [], totalBytes: 0 }).bundle, null);
});
