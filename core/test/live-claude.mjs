// Phase 1 acceptance: real Claude Code via the NEXUS HTTP API in a throwaway authorized project.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createApp } from "../src/server.ts";
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-live-")));
const proj = path.join(base, "demo"); fs.mkdirSync(proj);
const { server, token } = createApp(path.join(base, "data"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const api = async (p, method = "GET", body) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) })).json();
console.log("no token ->", (await fetch(url + "/api/state")).status);
console.log("agents:", JSON.stringify((await api("/api/state")).agents));
await api("/api/projects", "POST", { name: "demo", path: proj });
console.log("outside project ->", (await api("/api/tasks", "POST", { project: base, prompt: "hi" })).status);
const t = await api("/api/tasks", "POST", { project: proj, prompt: "Create a file named hello.txt containing exactly: nexus ok. Then reply with one short sentence." });
let cur = t; const t0 = Date.now();
while (cur.status === "running" && Date.now() - t0 < 240000) { await new Promise((r) => setTimeout(r, 2000)); cur = await api(`/api/tasks/${t.id}`); }
console.log("task:", cur.status, "|", cur.result, "|", cur.reason ?? "");
const f = path.join(proj, "hello.txt");
console.log("hello.txt:", fs.existsSync(f) ? JSON.stringify(fs.readFileSync(f, "utf8")) : "MISSING");
const s = await api("/api/state");
console.log("audit:", s.audit.map((e) => e.type).join(" > "), "| integrity:", JSON.stringify(s.auditIntegrity));
server.close(); process.exit(cur.status === "succeeded" && fs.existsSync(f) ? 0 : 1);
