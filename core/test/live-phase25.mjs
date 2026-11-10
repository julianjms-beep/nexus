// Phase 2.5 acceptance with the REAL Claude Code CLI, real sandbox, real git worktrees.
// Scenario A: Planner -> (approval) -> Developer -> Testing -> Sandbox -> (fix loop) -> verified branch -> integrate.
// Scenario B: a bug is seeded in the repo so the real Developer must fix it from the structured failure report.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { execFileSync } from "node:child_process";
import { createApp } from "../src/server.ts";

const g = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-live25-")));
const { server, token, sandbox, audit } = createApp(path.join(base, "data"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const api = async (p, method = "GET", body) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) })).json();
const waitRun = async (id, ms = 600000) => { const t0 = Date.now(); let r; do { await new Promise((x) => setTimeout(x, 3000)); r = await api(`/api/runs/${id}`); } while (r.status === "running" && Date.now() - t0 < ms); return r; };
const newProject = (name, files) => { const d = path.join(base, name); fs.mkdirSync(d); for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  g(d, "init", "-q", "-b", "main"); g(d, "add", "-A"); g(d, "commit", "-qm", "init"); return d; };
const show = (r) => { for (const s of r.steps) console.log(`  ${s.id} (${s.agent}): ${s.status}${s.reason ? " — " + s.reason : ""}${s.iterations ? "  iterations: " + s.iterations.map((i) => `#${i.n}:${i.ok ? "PASS" : "FAIL " + JSON.stringify(i.summary.failed)}`).join(" ") : ""}`); };
let failed = false; const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed = true; };

// ---------------- Scenario A ----------------
console.log("\n=== Scenario A: planner-driven development ===");
const A = newProject("inventory", { "README.md": "# inventory demo\n" });
await api("/api/projects", "POST", { name: "inventory", path: A });
const goal = "Build a small Python 3 module inventory.py with a class Inventory: add_item(name, qty, unit_price) (names are case-insensitive, qty must be > 0 else ValueError), remove_item(name, qty) (raises KeyError for unknown items and ValueError if stock is insufficient), total_value() (sum of qty*unit_price rounded to 2 decimals) and low_stock(threshold) (sorted list of names with qty <= threshold). " +
  "Also create automated unittest tests in test_inventory.py. Then verify the tests in the sandbox with the python-unittest runner, allowing the developer up to 3 fix iterations.";
const prop = await api("/api/plans", "POST", { project: A, goal });
check("planner produced a valid plan", !!prop.plan);
if (prop.plan) console.log("  plan:", prop.plan.steps.map((s) => `${s.id}[${s.kind ?? s.agent}]<-[${s.dependsOn}]`).join("  "));
check("plan contains a sandbox verification step", !!prop.plan?.steps.some((s) => s.kind === "sandbox"));
if (!prop.plan) { console.log(prop.errors); process.exit(1); }
console.log("  >> user approves the plan (POST /api/runs)");
const runA = await waitRun((await api("/api/runs", "POST", { project: A, plan: prop.plan })).id);
show(runA);
check("run succeeded", runA.status === "succeeded");
check("work happened in an isolated worktree/branch", runA.isolated && /^nexus\/run-/.test(runA.integration?.branch ?? ""));
check("main working tree untouched before integration", g(A, "status", "--porcelain") === "" && !fs.existsSync(path.join(A, "inventory.py")));
check("independent sandbox verification passed", runA.verification?.ok === true);
console.log("  files on branch:", runA.integration?.files.join(", "), "| fix iterations used:", Math.max(0, ...runA.steps.map((s) => (s.iterations?.length ?? 1) - 1)));
const merged = await api(`/api/runs/${runA.id}/integrate`, "POST");
check("human-triggered integration merged the verified branch", merged.state === "merged");
const post = await sandbox.run(A, "python-unittest").done;
check(`tests pass in the sandbox on the integrated project (${post.summary.tests} tests)`, post.ok);
check("worktree directory cleaned up", !fs.existsSync(runA.workdir));

// ---------------- Scenario B ----------------
console.log("\n=== Scenario B: seeded bug, real Developer fixes it from structured errors ===");
const B = newProject("seeded", {
  "stats.py": "def mean(xs):\n    return sum(xs) / (len(xs) - 1)\n\ndef median(xs):\n    s = sorted(xs)\n    return s[len(s) // 2]\n",
  "test_stats.py": "import unittest\nfrom stats import mean, median\nclass T(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(mean([2, 4, 6]), 4)\n    def test_median_odd(self):\n        self.assertEqual(median([3, 1, 2]), 2)\n    def test_median_even(self):\n        self.assertEqual(median([1, 2, 3, 4]), 2.5)\n",
});
await api("/api/projects", "POST", { name: "seeded", path: B });
const planB = { goal: "verify and repair stats module", steps: [{ id: "verify", kind: "sandbox", runner: "python-unittest", fixWith: "developer", maxIterations: 3, agent: "sandbox", prompt: "", dependsOn: [] }] };
const runB = await waitRun((await api("/api/runs", "POST", { project: B, plan: planB })).id);
show(runB);
const vB = runB.steps[0];
check("first sandbox run failed on the seeded bugs", vB.iterations?.[0]?.ok === false);
check("sandbox reported the failing tests structurally", (vB.iterations?.[0]?.summary.failed.length ?? 0) >= 1);
check("developer fixed it and the rerun passed", runB.status === "succeeded" && vB.iterations.at(-1).ok);
check("verified branch awaiting human integration; main untouched", runB.integration?.verified && g(B, "show", "HEAD:stats.py").includes("- 1"));
if (runB.integration?.state === "pending") await api(`/api/runs/${runB.id}/integrate`, "POST");

// ---------------- Records, costs, containment ----------------
console.log("\n=== Records ===");
const u = await api("/api/usage");
console.log("  billing:", JSON.stringify(u.billing));
console.log("  total (ESTIMATED, not billed):", `$${u.total.costUsd.toFixed(4)}`, `${u.total.tasks} agent calls`, `${u.total.tokens} tokens`);
console.log("  by agent:", Object.entries(u.byAgent).map(([k, v]) => `${k} $${v.costUsd.toFixed(4)} (${v.tasks})`).join(" | "));
console.log("  by project:", Object.entries(u.byProject).map(([k, v]) => `${path.basename(k)} $${v.costUsd.toFixed(4)}`).join(" | "));
const ev = audit.read();
const writers = ev.filter((e) => e.type === "task.started" && e.data.agent !== "planner");
check(`every file-writing agent task (${writers.length}) ran in an isolated worktree, never in the main project`, writers.length > 0 && writers.every((e) => e.data.project.includes("/worktrees/")));
console.log("  audit events:", ev.length, "| sandbox runs:", ev.filter((e) => e.type === "sandbox.run").length);
check("audit chain intact", audit.verify().ok);
check("no credentials in the usage summary", !/@|sk-ant|orgId/.test(JSON.stringify(u)));
server.close(); console.log(failed ? "\nRESULT: FAILED" : "\nRESULT: ALL CHECKS PASSED"); process.exit(failed ? 1 : 0);
