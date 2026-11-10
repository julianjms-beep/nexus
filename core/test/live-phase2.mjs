// Phase 2 acceptance: Developer + Testing agents collaborate through the real Claude Code CLI.
// The produced tests are then run by THIS script (not by an agent) to prove the code works.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawnSync } from "node:child_process";
import { createApp } from "../src/server.ts";

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-live2-")));
const proj = path.join(base, "demo"); fs.mkdirSync(proj);
const { server, token } = createApp(path.join(base, "data"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const api = async (p, method = "GET", body) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) })).json();
await api("/api/projects", "POST", { name: "demo", path: proj });

console.log("-- planner proposal (read-only, nothing executes) --");
const prop = await api("/api/plans", "POST", { project: proj, goal: "Create slug.js exporting slugify(str) (lowercase, accents removed, non-alphanumerics to single hyphens, trimmed) with node:test tests in slug.test.js" });
console.log(JSON.stringify(prop.plan ? prop.plan.steps.map((s) => `${s.id}:${s.agent}<-[${s.dependsOn}]`) : prop.errors));

console.log("-- running explicit 2-agent plan --");
const plan = { goal: "slugify with tests", steps: [
  { id: "implement", agent: "developer", dependsOn: [], expectFiles: ["slug.js"],
    prompt: "Create slug.js (CommonJS) exporting a function slugify(str): lowercase, strip accents, replace runs of non-alphanumerics with a single hyphen, trim hyphens. Export with module.exports = { slugify }." },
  { id: "tests", agent: "testing", dependsOn: ["implement"], expectFiles: ["slug.test.js"],
    prompt: "Write slug.test.js using node:test and node:assert covering normal text, accents, repeated separators, leading/trailing separators and empty string. Import from ./slug.js." } ] };
const run = await api("/api/runs", "POST", { project: proj, plan });
let cur = run; const t0 = Date.now();
while (cur.status === "running" && Date.now() - t0 < 420000) { await new Promise((r) => setTimeout(r, 3000)); cur = await api(`/api/runs/${run.id}`); }
for (const s of cur.steps) console.log(`${s.id} (${s.agent}): ${s.status} ${s.reason ?? ""}\n   ${(s.result ?? "").slice(0, 160).replace(/\n/g, " ")}`);
console.log("run:", cur.status, "| files:", fs.readdirSync(proj).join(", "));
const r = spawnSync("node", ["--test"], { cwd: proj, encoding: "utf8" });
console.log("node --test in demo project -> exit", r.status, (r.stdout.match(/ℹ (tests|pass|fail) \d+/g) ?? []).join(" | "));
const s = await api("/api/state");
console.log("audit integrity:", JSON.stringify(s.auditIntegrity), "| step events:", s.audit.filter((e) => e.type === "step.finished").length);
server.close(); process.exit(cur.status === "succeeded" && r.status === 0 ? 0 : 1);
