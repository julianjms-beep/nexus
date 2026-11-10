// FIXTURE claude binary emitting synthetic cost figures; verifies NEXUS accounting, not real prices.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { ClaudeCodeAdapter } from "../src/adapter.ts";
import { UsageLedger, usageFromResult } from "../src/usage.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-usage-")));
function fake(dir: string, cost: number) {
  const f = path.join(dir, "fake-claude");
  fs.writeFileSync(f, `#!/usr/bin/env node
const a = process.argv;
if (a[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "someone@example.com", orgId: "org-secret-123", subscriptionType: "pro" })); process.exit(0); }
console.log(JSON.stringify({ type: "result", is_error: false, result: "ok", total_cost_usd: ${cost}, duration_ms: 5,
  usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 }, modelUsage: { "claude-test-1": {} } }));
`, { mode: 0o755 });
  return f;
}
function setup(cost = 0.25) {
  const base = tmp(); const p1 = path.join(base, "p1"), p2 = path.join(base, "p2"); fs.mkdirSync(p1); fs.mkdirSync(p2);
  const data = path.join(base, "data"); const audit = new Audit(path.join(data, "audit.jsonl")); const sec = new Security(audit);
  const bin = fake(base, cost); const usage = new UsageLedger(data, audit, bin);
  const orch = new Orchestrator(data, audit, sec, { "claude-code": new ClaudeCodeAdapter(bin) }, undefined, undefined, usage);
  orch.addProject("p1", p1); orch.addProject("p2", p2);
  const wait = (id: string) => new Promise<void>((res) => { if (orch.getTask(id)!.status !== "running") return res(); orch.on("task", (t) => t.id === id && res()); });
  return { base, p1, p2, data, audit, usage, orch, wait, bin };
}

test("usageFromResult extracts cost, tokens and model from a result event", () => {
  const u = usageFromResult({ total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, modelUsage: { m: {} } });
  assert.deepEqual([u.costUsd, u.inputTokens, u.outputTokens, u.cacheCreationTokens, u.cacheReadTokens, u.model], [0.5, 1, 2, 3, 4, "m"]);
  assert.equal(usageFromResult({}).costUsd, 0);
});

test("each task is recorded and aggregated per agent, project, run and total", async () => {
  const { orch, usage, p1, p2, wait } = setup(0.25);
  for (const [proj, agent, run] of [[p1, "developer", "r1"], [p1, "testing", "r1"], [p2, "developer", undefined]] as const) {
    const t = orch.submit(proj, "x", agent, { runId: run }); await wait(t.id);
    assert.equal(orch.getTask(t.id)!.costUsd, 0.25);
  }
  const s = usage.summary();
  assert.equal(s.estimated, true);
  assert.equal(s.total.costUsd, 0.75); assert.equal(s.total.tasks, 3); assert.equal(s.total.tokens, 3 * 1130);
  assert.equal(s.byAgent.developer.costUsd, 0.5); assert.equal(s.byAgent.testing.costUsd, 0.25);
  assert.equal(s.byProject[p1].costUsd, 0.5); assert.equal(s.byProject[p2].costUsd, 0.25);
  assert.equal(s.byRun.r1.costUsd, 0.5);
});

test("project budget exhaustion denies new tasks, audits the event, and other projects keep working", async () => {
  const { orch, usage, audit, p1, p2, wait } = setup(0.25);
  usage.setBudgets({ perProjectUsd: 0.4, totalUsd: 100 });
  await wait(orch.submit(p1, "a").id); await wait(orch.submit(p1, "b").id);   // 0.5 spent >= 0.4
  const denied = orch.submit(p1, "c");
  assert.equal(denied.status, "denied"); assert.match(denied.reason!, /budget exhausted: project budget/);
  assert.ok(audit.read().some((e) => e.type === "budget.exhausted"));
  assert.equal(usage.summary().exhaustions.length, 1);
  const other = orch.submit(p2, "ok"); await wait(other.id); assert.equal(orch.getTask(other.id)!.status, "succeeded");
});

test("total and per-run budgets are enforced", async () => {
  const { orch, usage, p1, p2, wait } = setup(0.25);
  usage.setBudgets({ perRunUsd: 0.2, perProjectUsd: 100, totalUsd: 100 });
  await wait(orch.submit(p1, "a", "developer", { runId: "R" }).id);
  assert.match(orch.submit(p1, "b", "developer", { runId: "R" }).reason!, /run budget/);
  assert.equal(orch.submit(p1, "c", "developer", { runId: "other" }).status, "running");
  usage.setBudgets({ perRunUsd: 100, totalUsd: 0.1 });
  assert.match(orch.submit(p2, "d").reason!, /total budget/);
});

test("budget values are validated", () => {
  const { usage } = setup();
  assert.throws(() => usage.setBudgets({ totalUsd: -1 })); assert.throws(() => usage.setBudgets({ perRunUsd: NaN }));
  assert.equal(usage.setBudgets({ totalUsd: 12 }).totalUsd, 12);
});

test("billing detection: subscription is reported without exposing email or org id", () => {
  const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  const { usage } = setup(); const b = usage.billing();
  assert.equal(b.mode, "subscription"); assert.equal(b.subscriptionType, "pro");
  const dump = JSON.stringify(usage.summary()); assert.ok(!dump.includes("someone@example.com") && !dump.includes("org-secret"));
  assert.match(b.note, /ESTIMATES, not charges/);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});

test("billing detection: an API key in the environment means metered billing", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  const { usage } = setup(); const b = usage.billing();
  assert.equal(b.mode, "metered"); assert.ok(!JSON.stringify(usage.summary()).includes("sk-test-not-real"));
  delete process.env.ANTHROPIC_API_KEY;
});

test("ledger survives restart (persisted on disk)", async () => {
  const { orch, usage, audit, data, p1, wait } = setup(0.25);
  await wait(orch.submit(p1, "a").id);
  assert.equal(new UsageLedger(data, audit).summary().total.costUsd, 0.25);
});
