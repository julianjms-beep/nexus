// Usage ledger + budgets. All dollar figures here are ESTIMATES: Claude Code reports `total_cost_usd`
// computed client-side from token counts at list API prices. They are NOT what Anthropic bills you:
//   * subscription (claude.ai login): no per-token charge; usage counts against plan limits
//   * metered (ANTHROPIC_API_KEY / Console): the estimate approximates the real charge
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Audit } from "./audit.ts";

export type UsageRecord = {
  ts: string; taskId: string; runId?: string; agent: string; project: string; model?: string; costUsd: number;
  inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number; durationMs?: number; status: string;
  /** present when the figures were reported by a remote worker (untrusted, capped by the job budget) */
  remote?: { workerId: string; reportedCostUsd: number; capped: boolean };
};
export type Budgets = { perRunUsd: number; perProjectUsd: number; totalUsd: number };
export type Billing = { mode: "subscription" | "metered" | "unknown"; authMethod?: string; subscriptionType?: string; note: string };
export const DEFAULT_BUDGETS: Budgets = { perRunUsd: 3, perProjectUsd: 20, totalUsd: 50 };

/** Pull cost/tokens out of a Claude Code `result` stream event (shape verified against CLI 2.1.300). */
export function usageFromResult(ev: any): Pick<UsageRecord, "costUsd" | "inputTokens" | "outputTokens" | "cacheCreationTokens" | "cacheReadTokens" | "model" | "durationMs"> {
  const u = ev?.usage ?? {};
  return { costUsd: Number(ev?.total_cost_usd) || 0, inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0,
    model: ev?.modelUsage ? Object.keys(ev.modelUsage).join(",") || undefined : undefined, durationMs: ev?.duration_ms };
}

export class UsageLedger {
  private billingCache?: { at: number; v: Billing };
  constructor(private dir: string, private audit: Audit, private claudeBin = "claude") { fs.mkdirSync(dir, { recursive: true }); }
  private get file() { return path.join(this.dir, "usage.jsonl"); }

  record(r: UsageRecord) { fs.appendFileSync(this.file, JSON.stringify(r) + "\n"); }
  all(): UsageRecord[] {
    try { return fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  }

  budgets(): Budgets { try { return { ...DEFAULT_BUDGETS, ...JSON.parse(fs.readFileSync(path.join(this.dir, "budgets.json"), "utf8")) }; } catch { return { ...DEFAULT_BUDGETS }; } }
  setBudgets(b: Partial<Budgets>): Budgets {
    const next = { ...this.budgets() };
    for (const k of ["perRunUsd", "perProjectUsd", "totalUsd"] as const) if (b[k] !== undefined) { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) throw new Error(`bad budget ${k}`); next[k] = n; }
    fs.writeFileSync(path.join(this.dir, "budgets.json"), JSON.stringify(next, null, 2));
    this.audit.record("budget.updated", next);
    return next;
  }

  spent(filter: { project?: string; runId?: string } = {}) {
    return this.all().filter((r) => (!filter.project || r.project === filter.project) && (!filter.runId || r.runId === filter.runId)).reduce((s, r) => s + r.costUsd, 0);
  }

  /** Is there budget left to start more work? Records a budget.exhausted audit event when not. */
  check(project: string, runId?: string): { ok: boolean; reason?: string } {
    const b = this.budgets();
    const why = this.spent() >= b.totalUsd ? `total budget $${b.totalUsd} exhausted`
      : this.spent({ project }) >= b.perProjectUsd ? `project budget $${b.perProjectUsd} exhausted`
      : runId && this.spent({ runId }) >= b.perRunUsd ? `run budget $${b.perRunUsd} exhausted` : undefined;
    if (why) { this.audit.record("budget.exhausted", { project, runId, reason: why, spent: this.spent(), budgets: b }); return { ok: false, reason: why }; }
    return { ok: true };
  }

  summary() {
    const rs = this.all(); const sum = (xs: UsageRecord[]) => ({ costUsd: xs.reduce((s, r) => s + r.costUsd, 0), tasks: xs.length,
      tokens: xs.reduce((s, r) => s + r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens, 0) });
    const group = (key: (r: UsageRecord) => string) => Object.fromEntries([...new Set(rs.map(key))].map((k) => [k, sum(rs.filter((r) => key(r) === k))]));
    return { estimated: true, total: sum(rs), byAgent: group((r) => r.agent), byProject: group((r) => r.project), byRun: group((r) => r.runId ?? "(single task)"),
      recent: rs.slice(-25).reverse(), budgets: this.budgets(), spent: this.spent(),
      exhaustions: this.audit.read().filter((e) => e.type === "budget.exhausted").slice(-10).reverse(), billing: this.billing() };
  }

  /** Subscription vs metered, WITHOUT exposing identity: only the auth method and plan type are kept. */
  billing(): Billing {
    if (this.billingCache && Date.now() - this.billingCache.at < 60_000) return this.billingCache.v;
    let v: Billing;
    if (process.env.ANTHROPIC_API_KEY) v = { mode: "metered", authMethod: "api-key", note: "ANTHROPIC_API_KEY is set: Claude Code bills this key per token. Estimates approximate real charges." };
    else {
      const r = spawnSync(this.claudeBin, ["auth", "status"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER } });
      try {
        const j = JSON.parse(r.stdout);
        if (j.loggedIn && j.authMethod === "claude.ai") v = { mode: "subscription", authMethod: j.authMethod, subscriptionType: j.subscriptionType,
          note: "Logged in with a Claude subscription: no per-token billing. Dollar figures are API-price ESTIMATES, not charges; real limit is your plan's usage allowance." };
        else if (j.loggedIn) v = { mode: "metered", authMethod: j.authMethod, note: "Logged in via API/Console: usage is billed per token. Estimates approximate real charges." };
        else v = { mode: "unknown", note: "Claude Code is not logged in." };
      } catch { v = { mode: "unknown", note: "Could not determine the authentication type." }; }
    }
    this.billingCache = { at: Date.now(), v };
    return v;
  }
}
