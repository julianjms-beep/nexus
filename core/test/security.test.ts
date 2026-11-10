import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sec-")));
function setup() {
  const base = tmp();
  const proj = path.join(base, "proj");
  fs.mkdirSync(proj);
  const audit = new Audit(path.join(base, "audit.jsonl"));
  const sec = new Security(audit);
  sec.allowRoot(proj);
  return { base, proj, audit, sec };
}

test("allows paths inside an authorized root", () => {
  const { proj, sec } = setup();
  assert.equal(sec.authorize({ kind: "fs.write", path: path.join(proj, "new/file.txt") }).allowed, true);
});

test("sibling directory sharing a string prefix is NOT inside the root", () => {
  const { base, sec } = setup();
  fs.mkdirSync(path.join(base, "proj-evil"));
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(base, "proj-evil", "x") }).allowed, false);
});

test("dot-dot traversal is denied", () => {
  const { proj, sec } = setup();
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(proj, "..", "secret") }).allowed, false);
});

test("symlink inside the root pointing outside is denied", () => {
  const { base, proj, sec } = setup();
  const outside = path.join(base, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "x");
  fs.symlinkSync(outside, path.join(proj, "link"));
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(proj, "link", "secret.txt") }).allowed, false);
});

test("sensitive files are denied even inside a root", () => {
  const { proj, sec } = setup();
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(proj, ".env") }).allowed, false);
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(proj, ".ssh", "id_rsa") }).allowed, false);
});

test("home directory and filesystem root cannot be authorized as projects", () => {
  const { sec } = setup();
  assert.throws(() => sec.allowRoot(os.homedir()));
  assert.throws(() => sec.allowRoot("/"));
});

test("agent runs outside authorized projects are denied", () => {
  const { base, sec } = setup();
  assert.equal(sec.authorize({ kind: "agent.run", project: base, agent: "claude-code" }).allowed, false);
});

test("high-risk actions are denied until a human approves; approval is audited", async () => {
  const { sec, audit } = setup();
  assert.equal(sec.authorize({ kind: "deploy" }).allowed, false);
  const { id, promise } = sec.requestApproval({ kind: "deploy" });
  assert.equal(sec.pendingApprovals().length, 1);
  assert.equal(sec.authorize({ kind: "deploy" }).allowed, false, "requesting is not approving");
  sec.decide(id, true);
  assert.equal(await promise, true);
  assert.equal(sec.authorize({ kind: "deploy" }).allowed, true);
  assert.ok(audit.read().some((e) => e.type === "security.approval_decided"));
});

test("a rejected approval stays denied", async () => {
  const { sec } = setup();
  const { id, promise } = sec.requestApproval({ kind: "secrets.read" });
  sec.decide(id, false);
  assert.equal(await promise, false);
  assert.equal(sec.authorize({ kind: "secrets.read" }).allowed, false);
});

test("only https urls may be opened", () => {
  const { sec } = setup();
  assert.equal(sec.authorize({ kind: "app.open", target: "https://youtube.com" }).allowed, true);
  assert.equal(sec.authorize({ kind: "app.open", target: "file:///etc/passwd" }).allowed, false);
  assert.equal(sec.authorize({ kind: "app.open", target: "javascript:alert(1)" }).allowed, false);
});

test("audit hash chain verifies and detects tampering", () => {
  const { base, audit, sec } = setup();
  sec.authorize({ kind: "deploy" });
  assert.deepEqual(audit.verify(), { ok: true });
  const f = path.join(base, "audit.jsonl");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"allowed":false', '"allowed":true'));
  assert.equal(new Audit(f).verify().ok, false);
});
