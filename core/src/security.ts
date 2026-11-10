// Default-deny authorization. Every sensitive operation goes through Security.authorize().
// Filesystem checks use realpath + path.relative, never string prefixes.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit.ts";

export type Risk = "low" | "medium" | "high";
export type Action =
  | { kind: "fs.read"; path: string }
  | { kind: "fs.write"; path: string }
  | { kind: "agent.run"; project: string; agent: string }
  | { kind: "sandbox.run"; project: string; runner: string }
  | { kind: "app.open"; target: string }
  | { kind: "secrets.read" }
  | { kind: "checkpoint"; label: string }
  | { kind: "deploy" };

export type Decision = { allowed: boolean; risk: Risk; reason: string };

const RISK: Record<Action["kind"], Risk> = {
  "fs.read": "low",
  "app.open": "low",
  "fs.write": "medium",
  "agent.run": "medium",
  "sandbox.run": "medium",
  "secrets.read": "high",
  checkpoint: "high",
  deploy: "high",
};

/** Resolve a path through symlinks even if the leaf does not exist yet. */
export function resolveReal(p: string): string {
  let abs = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(abs), ...tail.reverse());
    } catch {
      const parent = path.dirname(abs);
      if (parent === abs) return path.join(abs, ...tail.reverse());
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(resolveReal(root), resolveReal(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const SENSITIVE = [/(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.env(\.|$)/, /\.pem$/, /id_(rsa|ed25519)/];

export class Security {
  private roots = new Set<string>();
  private pending = new Map<string, { action: Action; resolve: (ok: boolean) => void }>();
  private granted = new Set<string>();
  constructor(private audit: Audit) {}

  allowRoot(dir: string) {
    const real = resolveReal(dir);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
    if (real === path.parse(real).root || real === resolveReal(process.env.HOME ?? "/")) {
      throw new Error("refusing to authorize filesystem root or home directory as a project");
    }
    this.roots.add(real);
    this.audit.record("security.root_allowed", { root: real });
  }
  revokeRoot(dir: string) { this.roots.delete(resolveReal(dir)); }
  listRoots() { return [...this.roots]; }

  /** Synchronous policy decision. High risk is never allowed without a granted approval. */
  authorize(action: Action): Decision {
    const risk = RISK[action.kind];
    let d: Decision;
    if (action.kind === "fs.read" || action.kind === "fs.write") {
      const real = resolveReal(action.path);
      if (SENSITIVE.some((r) => r.test(real))) d = { allowed: false, risk: "high", reason: "sensitive path" };
      else if (![...this.roots].some((r) => isInside(r, real))) d = { allowed: false, risk, reason: "outside authorized roots" };
      else d = { allowed: true, risk, reason: "inside authorized root" };
    } else if (action.kind === "agent.run" || action.kind === "sandbox.run") {
      const ok = [...this.roots].some((r) => isInside(r, action.project));
      d = { allowed: ok, risk, reason: ok ? "authorized project" : "project not authorized" };
    } else if (action.kind === "app.open") {
      const ok = /^https:\/\//.test(action.target);
      d = { allowed: ok, risk, reason: ok ? "https url" : "only https urls are allowed" };
    } else {
      const key = JSON.stringify(action);
      d = this.granted.has(key)
        ? { allowed: true, risk, reason: "explicit approval granted" }
        : { allowed: false, risk, reason: "high-risk action requires explicit approval" };
    }
    this.audit.record("security.decision", { action, ...d });
    return d;
  }

  /** Ask a human. Resolves only when decide() is called with that id; there is no auto-approve path. */
  requestApproval(action: Action): { id: string; promise: Promise<boolean> } {
    const id = randomUUID();
    const promise = new Promise<boolean>((resolve) => this.pending.set(id, { action, resolve }));
    this.audit.record("security.approval_requested", { id, action });
    return { id, promise };
  }
  pendingApprovals() { return [...this.pending].map(([id, p]) => ({ id, action: p.action })); }
  decide(id: string, approve: boolean) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    if (approve) this.granted.add(JSON.stringify(p.action));
    this.audit.record("security.approval_decided", { id, approve });
    p.resolve(approve);
    return true;
  }
}
