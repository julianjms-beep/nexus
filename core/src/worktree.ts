// Isolated Git worktrees for agents. Each run works on its own branch in its own directory; the main
// working tree is never touched until a human integrates a VERIFIED, conflict-free branch.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Audit } from "./audit.ts";
import type { Security } from "./security.ts";
import { resolveReal } from "./security.ts";

export type Worktree = { name: string; path: string; branch: string; base: string; project: string };
export type ConflictReport = { clean: boolean; conflicts: string[] };

// Never run repository hooks (they are arbitrary code); never prompt; no system/global config surprises.
const GIT_BASE = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "protocol.ext.allow=never"];
function git(cwd: string, args: string[], allowFail = false): { code: number; out: string } {
  try {
    const out = execFileSync("/usr/bin/git", [...GIT_BASE, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
    return { code: 0, out };
  } catch (e: any) {
    if (!allowFail) throw new Error(`git ${args[0]} failed: ${(e.stderr || e.message).toString().trim()}`);
    return { code: e.status ?? 1, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() };
  }
}

export class Worktrees {
  constructor(private dir: string, private audit: Audit, private security: Security) { fs.mkdirSync(path.join(dir, "worktrees"), { recursive: true }); }

  isRepo(project: string) { return git(project, ["rev-parse", "--is-inside-work-tree"], true).code === 0 && git(project, ["rev-parse", "--verify", "HEAD"], true).code === 0; }

  create(projectIn: string, name: string): Worktree {
    if (!/^[\w-]{1,48}$/.test(name)) throw new Error("bad worktree name");
    const project = resolveReal(projectIn);
    if (!this.security.authorize({ kind: "fs.write", path: project }).allowed) throw new Error("project not authorized");
    if (!this.isRepo(project)) throw new Error("project is not a git repository with at least one commit (git init && git commit)");
    const base = git(project, ["rev-parse", "HEAD"]).out.trim();
    const wtPath = path.join(resolveReal(this.dir), "worktrees", name), branch = `nexus/${name}`;
    git(project, ["worktree", "add", "-b", branch, wtPath, base]);
    this.security.allowRoot(wtPath);
    const wt = { name, path: wtPath, branch, base, project };
    this.audit.record("worktree.created", wt);
    return wt;
  }

  /** The agent could rewrite the `.git` pointer file; refuse to commit if it no longer points at our gitdir. */
  private verifyPointer(wt: Worktree) {
    const expect = `gitdir: ${path.join(fs.realpathSync(wt.project), ".git", "worktrees", path.basename(wt.path))}`;
    const got = fs.readFileSync(path.join(wt.path, ".git"), "utf8").trim();
    if (got !== expect) throw new Error("worktree .git pointer was tampered with");
  }

  /** Commit whatever the agents produced onto the run branch. Returns the sha, or null if nothing changed. */
  commitAll(wt: Worktree, message: string): string | null {
    this.verifyPointer(wt);
    git(wt.path, ["add", "-A"]);
    if (!git(wt.path, ["status", "--porcelain"]).out.trim()) return null;
    git(wt.path, ["-c", "user.name=NEXUS", "-c", "user.email=nexus@local", "commit", "-q", "-m", message]);
    const sha = git(wt.path, ["rev-parse", "HEAD"]).out.trim();
    this.audit.record("worktree.committed", { branch: wt.branch, sha, files: git(wt.path, ["diff", "--name-only", `${wt.base}..HEAD`]).out.trim().split("\n").filter(Boolean) });
    return sha;
  }

  changedFiles(wt: Worktree) { return git(wt.path, ["diff", "--name-only", `${wt.base}..${wt.branch}`]).out.trim().split("\n").filter(Boolean); }

  /** Would merging `branch` into the project's current HEAD conflict? (read-only, uses git merge-tree) */
  conflicts(projectIn: string, branch: string): ConflictReport {
    const project = resolveReal(projectIn);
    const r = git(project, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", branch], true);
    if (r.code === 0) return { clean: true, conflicts: [] };
    if (r.code === 1) return { clean: false, conflicts: r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean) };
    throw new Error("merge-tree failed: " + r.out.trim());
  }

  /** Controlled integration: needs `verified`, a clean main tree and no conflicts. Never fast-forwards silently. */
  integrate(projectIn: string, wt: Worktree, verified: boolean): { merged: boolean; sha?: string; reason?: string } {
    const project = resolveReal(projectIn);
    const deny = (reason: string) => { this.audit.record("worktree.integrate_denied", { branch: wt.branch, reason }); return { merged: false, reason }; };
    if (!verified) return deny("changes are not verified (sandbox tests have not passed)");
    if (!this.security.authorize({ kind: "fs.write", path: project }).allowed) return deny("project not authorized");
    if (git(project, ["status", "--porcelain"]).out.trim()) return deny("main working tree has uncommitted changes");
    if (git(project, ["symbolic-ref", "-q", "HEAD"], true).code !== 0) return deny("main repo is on a detached HEAD");
    if (git(project, ["rev-parse", wt.branch]).out.trim() === git(project, ["rev-parse", wt.base]).out.trim()) return deny("branch has no commits");
    const c = this.conflicts(project, wt.branch);
    if (!c.clean) return deny(`merge conflicts: ${c.conflicts.join(", ")}`);
    git(project, ["-c", "user.name=NEXUS", "-c", "user.email=nexus@local", "merge", "--no-ff", "-q", "-m", `NEXUS: integrate ${wt.branch}`, wt.branch]);
    const sha = git(project, ["rev-parse", "HEAD"]).out.trim();
    this.audit.record("worktree.integrated", { branch: wt.branch, sha });
    return { merged: true, sha };
  }

  /** Remove the directory and its authorization; keep the branch unless asked (so work is never lost silently). */
  cleanup(wt: Worktree, deleteBranch = false) {
    this.security.revokeRoot(wt.path);
    git(wt.project, ["worktree", "remove", "--force", wt.path], true);
    if (fs.existsSync(wt.path)) fs.rmSync(wt.path, { recursive: true, force: true });
    git(wt.project, ["worktree", "prune"], true);
    if (deleteBranch) git(wt.project, ["branch", "-D", wt.branch], true);
    this.audit.record("worktree.cleaned", { branch: wt.branch, deleteBranch });
  }
}
