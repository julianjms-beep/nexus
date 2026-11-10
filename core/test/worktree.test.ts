// Real git, throwaway repositories.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Worktrees } from "../src/worktree.ts";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wt-")));
  const proj = path.join(base, "proj"); fs.mkdirSync(proj);
  g(proj, "init", "-q", "-b", "main"); fs.writeFileSync(path.join(proj, "app.txt"), "line1\nline2\nline3\n"); g(proj, "add", "-A"); g(proj, "commit", "-qm", "init");
  const data = path.join(base, "data"); const audit = new Audit(path.join(data, "audit.jsonl")); const sec = new Security(audit);
  sec.allowRoot(proj);
  return { base, proj, data, audit, sec, wts: new Worktrees(data, audit, sec) };
}

test("agent edits happen in a separate directory and branch; main tree stays untouched", () => {
  const { proj, wts, sec } = setup();
  const wt = wts.create(proj, "run1");
  assert.notEqual(wt.path, proj); assert.equal(wt.branch, "nexus/run1");
  assert.equal(sec.authorize({ kind: "fs.write", path: path.join(wt.path, "new.py") }).allowed, true, "worktree is an authorized root");
  fs.writeFileSync(path.join(wt.path, "new.py"), "print(1)\n");
  assert.equal(fs.existsSync(path.join(proj, "new.py")), false);
  assert.equal(g(proj, "status", "--porcelain"), "");
  const sha = wts.commitAll(wt, "agent work"); assert.ok(sha);
  assert.deepEqual(wts.changedFiles(wt), ["new.py"]);
  assert.equal(g(proj, "rev-parse", "main"), wt.base, "main branch did not move");
});

test("commitAll returns null when nothing changed", () => {
  const { proj, wts } = setup(); assert.equal(wts.commitAll(wts.create(proj, "r"), "x"), null);
});

test("unverified changes are never integrated; verified clean changes merge with --no-ff", () => {
  const { proj, wts } = setup(); const wt = wts.create(proj, "run2");
  fs.writeFileSync(path.join(wt.path, "feature.py"), "x=1\n"); wts.commitAll(wt, "feat");
  const denied = wts.integrate(proj, wt, false);
  assert.equal(denied.merged, false); assert.match(denied.reason!, /not verified/); assert.equal(fs.existsSync(path.join(proj, "feature.py")), false);
  const ok = wts.integrate(proj, wt, true);
  assert.equal(ok.merged, true); assert.ok(fs.existsSync(path.join(proj, "feature.py")));
  assert.equal(g(proj, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "merge commit with two parents");
});

test("conflicts are detected before merging and nothing changes", () => {
  const { proj, wts } = setup(); const wt = wts.create(proj, "run3");
  fs.writeFileSync(path.join(wt.path, "app.txt"), "line1\nAGENT\nline3\n"); wts.commitAll(wt, "agent edit");
  fs.writeFileSync(path.join(proj, "app.txt"), "line1\nHUMAN\nline3\n"); g(proj, "commit", "-qam", "human edit");
  const c = wts.conflicts(proj, wt.branch); assert.equal(c.clean, false); assert.deepEqual(c.conflicts, ["app.txt"]);
  const head = g(proj, "rev-parse", "HEAD");
  const r = wts.integrate(proj, wt, true); assert.equal(r.merged, false); assert.match(r.reason!, /conflicts: app.txt/);
  assert.equal(g(proj, "rev-parse", "HEAD"), head); assert.equal(g(proj, "status", "--porcelain"), "");
});

test("integration refuses a dirty main tree", () => {
  const { proj, wts } = setup(); const wt = wts.create(proj, "run4");
  fs.writeFileSync(path.join(wt.path, "a.py"), "1\n"); wts.commitAll(wt, "a");
  fs.writeFileSync(path.join(proj, "wip.txt"), "wip");
  assert.match(wts.integrate(proj, wt, true).reason!, /uncommitted/);
});

test("cleanup removes the directory and authorization but keeps the branch by default", () => {
  const { proj, wts, sec } = setup(); const wt = wts.create(proj, "run5");
  fs.writeFileSync(path.join(wt.path, "a.py"), "1\n"); wts.commitAll(wt, "a");
  wts.cleanup(wt);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(sec.authorize({ kind: "fs.read", path: path.join(wt.path, "a.py") }).allowed, false);
  assert.ok(g(proj, "branch", "--list", wt.branch).includes("run5"));
  wts.cleanup(wt, true); assert.equal(g(proj, "branch", "--list", wt.branch), "");
});

test("a tampered .git pointer is detected and nothing is committed", () => {
  const { base, proj, wts } = setup(); const wt = wts.create(proj, "run6");
  const other = path.join(base, "other"); fs.mkdirSync(other); g(other, "init", "-q");
  fs.writeFileSync(path.join(wt.path, ".git"), `gitdir: ${path.join(other, ".git")}\n`);
  assert.throws(() => wts.commitAll(wt, "evil"), /tampered/);
});

test("repository hooks are not executed by NEXUS git operations", () => {
  const { base, proj, wts } = setup(); const marker = path.join(base, "hook-ran");
  fs.writeFileSync(path.join(proj, ".git", "hooks", "pre-commit"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(proj, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const wt = wts.create(proj, "run7"); fs.writeFileSync(path.join(wt.path, "a.py"), "1\n"); wts.commitAll(wt, "a");
  assert.equal(fs.existsSync(marker), false);
});

test("non-repositories, unauthorized projects and bad names are refused", () => {
  const { base, wts } = setup();
  const plain = path.join(base, "plain"); fs.mkdirSync(plain);
  assert.throws(() => wts.create(plain, "x"), /not authorized/);
  const { proj, wts: w2 } = setup(); assert.throws(() => w2.create(proj, "../evil"), /bad worktree name/);
});
