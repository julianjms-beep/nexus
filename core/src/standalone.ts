// NEXUS for agents without NEXUS OS: the orchestrator of core/src/agentd.ts (capabilities, risk control with the
// person's approval, the watchdog, budgets, the MCP server) running inside one `nexus-agent` process on any Linux or
// macOS, with the sandbox of core/src/agent-platform.ts. No desktop, no daemon, nothing installed system-wide.
//
//   * One local HTTP server on 127.0.0.1 (a random port), alive only while the agent runs. The agent reaches /mcp
//     and /llm with the token of its own run; nothing else answers without the admin token, which lives in a file
//     the sandbox cannot read (~/.nexus-agent/run/<pid>.json, mode 0600).
//   * Approvals: when the agent asks for something critical (git push, rm -r, a deploy…) the person gets a native
//     dialog (macOS: osascript; Linux: zenity or kdialog) whose default button is "Deny". Without a desktop, the
//     request waits for `nexus-agent approvals` in another terminal. No answer in 5 minutes means no.
//   * The person's API key never enters the sandbox: the agent gets a placeholder and this process adds the real
//     key on the way out, counting tokens and dollars against the budget.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Agents, type Approval, type AgentPlatform } from "./agentd.ts";
import { detectPlatform, sandboxPath } from "./agent-platform.ts";

export type Lang = "en" | "es";
/** true = approved, false = denied, null = this computer cannot show a dialog (the request stays pending). */
export type Approver = (ap: Approval, lang: Lang) => Promise<boolean | null>;

const T = {
  en: { wants: "wants to run", deny: "Deny", approve: "Approve", title: "NEXUS · approval needed", committee: "Review committee" },
  es: { wants: "quiere ejecutar", deny: "Rechazar", approve: "Aprobar", title: "NEXUS · hace falta tu permiso", committee: "Comité de revisión" },
};
export function approvalText(ap: Approval, lang: Lang): string {
  const t = T[lang];
  return `«${ap.agentName}» ${t.wants}:\n\n    ${ap.title}\n\n${ap.detail}`;
}

type Exec = (cmd: string, args: string[]) => Promise<{ code: number | null; out: string; missing: boolean }>;
const defaultExec: Exec = (cmd, args) => new Promise((resolve) => {
  let out = "";
  const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
  c.stdout.on("data", (d) => { if (out.length < 4096) out += d; });
  c.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, out, missing: e.code === "ENOENT" }));
  c.on("close", (code) => resolve({ code, out, missing: false }));
});

// The dialog's text travels as arguments (`on run argv`), never inside the script: nothing an agent writes is ever
// read as AppleScript. The first button (Deny) is the default and the cancel button, so a stray Enter or Esc denies.
const MAC_DIALOG = [
  "on run argv",
  "set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons {(item 3 of argv), (item 4 of argv)} default button 1 cancel button 1 with icon caution giving up after 290",
  "if gave up of r then return \"\"",
  "return button returned of r",
  "end run",
];
/** The native yes/no dialog of this computer. */
export function dialogApprover(o: { platform?: string; env?: NodeJS.ProcessEnv; exec?: Exec } = {}): Approver {
  const platform = o.platform ?? process.platform, env = o.env ?? process.env, exec = o.exec ?? defaultExec;
  return async (ap, lang) => {
    const t = T[lang], text = approvalText(ap, lang).slice(0, 1500);
    if (platform === "darwin") {
      const r = await exec("/usr/bin/osascript", [...MAC_DIALOG.flatMap((l) => ["-e", l]), "--", text, t.title, t.deny, t.approve]);
      if (r.missing) return null;
      return r.code === 0 && r.out.trim() === t.approve;
    }
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
    const z = await exec("zenity", ["--question", "--no-markup", "--width=560", "--timeout=290", "--default-cancel", `--title=${t.title}`, `--text=${text}`, `--ok-label=${t.approve}`, `--cancel-label=${t.deny}`]);
    if (!z.missing) return z.code === 0;
    const k = await exec("kdialog", ["--title", t.title, "--yes-label", t.approve, "--no-label", t.deny, "--warningyesno", text]);
    if (!k.missing) return k.code === 0;
    return null;
  };
}

export type StandaloneOptions = {
  /** the script the agent's MCP client starts as `<node> <cliPath> mcp` */
  cliPath: string;
  nodePath?: string;
  home?: string;
  /** default: ~/.nexus-agent */
  stateDir?: string;
  lang?: Lang;
  approver?: Approver;
  platform?: AgentPlatform & { tools: string[] };
  /** more read-only folders for the sandbox (running from source: where the .ts files are) */
  extraTools?: string[];
  /** the person's Anthropic API key, if they use one: it stays in this process */
  apiKey?: string;
  fetchFn?: typeof fetch;
  onNotice?: (text: string, kind: "info" | "warn") => void;
  /** an approval is waiting and no dialog could be shown */
  onPending?: (ap: Approval) => void;
  watch?: boolean;
};

export async function createStandalone(o: StandaloneOptions) {
  const home = fs.realpathSync(o.home ?? os.homedir());
  const stateDir = o.stateDir ?? path.join(home, ".nexus-agent");
  const lang: Lang = o.lang ?? "en";
  const node = o.nodePath ?? process.execPath;
  const dataDir = path.join(stateDir, "data"), runDir = path.join(stateDir, "run");
  for (const d of [stateDir, dataDir, runDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const platform = o.platform ?? detectPlatform({ home, commandHome: path.join(dataDir, "cmd-home"), extraTools: [path.dirname(path.dirname(node)), path.dirname(o.cliPath), ...(o.extraTools ?? [])] });
  if (!platform) throw new Error(lang === "es" ? "nexus-agent funciona en Linux y en macOS" : "nexus-agent runs on Linux and macOS");
  const approver = o.approver ?? dialogApprover();
  const admin = randomBytes(24).toString("base64url");
  let port = 0;
  const fetchFn = o.fetchFn ?? fetch;

  const agents: Agents = new Agents({
    configDir: path.join(stateDir, "config"), dataDir, home, port: () => port, runtimeDirs: [],
    platform, lang, watch: o.watch,
    mcpCommand: { command: node, args: [...(/\.ts$/.test(o.cliPath) ? ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"] : []), o.cliPath, "mcp"] },
    notice: (text, kind) => o.onNotice?.(text, kind),
    launch: () => { /* no desktop app here */ },
    push: (kind, data) => { if (kind === "agent-approval") void onApproval(String((data as { id?: unknown })?.id ?? "")); },
    ...(o.apiKey ? { forward: (pq: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => fetchFn(`https://api.anthropic.com${pq}`, { method: init.method, headers: { ...init.headers, "x-api-key": o.apiKey! }, body: init.body }) } : {}),
  });

  async function onApproval(id: string) {
    const ap = agents.view().approvals.find((a) => a.id === id);
    if (!ap) return;
    let answer: boolean | null = null;
    try { answer = await approver(ap, lang); } catch { answer = null; }
    if (answer === null) { o.onPending?.(ap); return; }   // waits for `nexus-agent approvals`, or times out as "no"
    try { agents.decide(id, answer, answer ? undefined : lang === "es" ? "rechazado en el diálogo" : "denied in the dialog"); } catch { /* answered elsewhere, or timed out */ }
  }

  const readBody = (req: http.IncomingMessage, limit: number) => new Promise<any>((res, rej) => {
    let n = 0; const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > limit) { rej(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { rej(new Error("bad json")); } });
    req.on("error", rej);
  });
  const isAdmin = (req: http.IncomingMessage) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, "")), b = Buffer.from(admin);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      // only this computer, and never a web page: a browser tab cannot be turned against the agent's server
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "bad host" });
      if (req.headers.origin) return send(403, { error: "bad origin" });
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      if (p === "/mcp") {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
        const r = await agents.mcp(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), await readBody(req, 4e6));
        if (r.status === 202) { res.writeHead(202); return res.end(); }
        return send(r.status, r.body);
      }
      if (p.startsWith("/llm/")) return await agents.proxy(req, res, p);
      if (!isAdmin(req)) return send(401, { error: "unauthorized" });
      if (req.method === "GET" && p === "/admin/approvals") return send(200, { approvals: agents.view().approvals });
      if (req.method === "POST" && p === "/admin/decide") {
        const b = await readBody(req, 4096);
        try { return send(200, agents.decide(String(b.id), b.approve === true, b.approve === true ? undefined : "denied from the terminal")); }
        catch { return send(409, { error: "not pending" }); }
      }
      return send(404, { error: "not found" });
    } catch (e) { send(400, { error: String((e as Error)?.message ?? e) }); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  const runFile = path.join(runDir, `${process.pid}.json`);

  return {
    agents, platform, port, admin, home, stateDir, runFile,
    /** The agent profile of a project folder (made on first use: read, write and run there, nothing else). */
    ensureAgent(folder: string, x: { read?: string[]; maxUsd?: number; check?: string } = {}) {
      const real = fs.realpathSync(folder);
      const tilde = (p: string) => (p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);
      const existing = agents.view().agents.find((a) => a.folder === real);
      const taken = new Set(agents.view().agents.map((a) => a.id));
      let name = existing?.name ?? (path.basename(real).replace(/[^\p{L}\p{N} ._-]+/gu, " ").trim().slice(0, 30) || "project");
      if (!existing) for (let i = 2; taken.has(name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")); i++) name = `${path.basename(real).slice(0, 26)} ${i}`;
      const t = tilde(real);
      const scopes = [`fs://read/${t}`, `fs://write/${t}`, `exec://${t}`, "memory://proyecto", "system://read", ...(x.read ?? []).map((d) => `fs://read/${tilde(fs.realpathSync(d))}`)];
      // a budget needs the traffic to pass through here, which needs the person's API key (a subscription login does not)
      const budget = o.apiKey ? { maxUsd: x.maxUsd ?? 5, maxTokens: 0 } : { maxUsd: 0, maxTokens: 0 };
      return agents.save({ ...(existing ? { id: existing.id } : {}), name, folder: real, scopes, council: false, check: x.check ?? existing?.check ?? "", ...budget });
    },
    /** Tell `nexus-agent approvals` (another terminal) where this run is. */
    publish(folder: string) { fs.writeFileSync(runFile, JSON.stringify({ pid: process.pid, port, admin, folder, started: new Date().toISOString() }), { mode: 0o600 }); },
    async close() {
      agents.stop();
      fs.rmSync(runFile, { force: true });
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export type Standalone = Awaited<ReturnType<typeof createStandalone>>;

/** The runs of this person that are alive now (for `nexus-agent approvals`). Files of dead processes are removed. */
export function liveRuns(stateDir: string): { pid: number; port: number; admin: string; folder: string }[] {
  const dir = path.join(stateDir, "run"); const out: { pid: number; port: number; admin: string; folder: string }[] = [];
  let names: string[] = []; try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      process.kill(Number(j.pid), 0);
      out.push({ pid: Number(j.pid), port: Number(j.port), admin: String(j.admin), folder: String(j.folder) });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") fs.rmSync(f, { force: true }); }
  }
  return out;
}

/** The environment of the agent program: its own home, the person's tools, the run's token — nothing else of theirs. */
export function agentEnv(home: string, tools: string[], agentHome: string, runEnv: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    HOME: agentHome, PATH: sandboxPath(home, tools), LANG: process.env.LANG ?? "en_US.UTF-8", TERM: process.env.TERM ?? "xterm-256color",
    NEXUS_IN_AGENT: "1", ...runEnv,
  };
  for (const k of ["COLORTERM", "TZ", "LC_ALL", "LC_CTYPE", "TERM_PROGRAM", "NO_COLOR"]) if (process.env[k]) e[k] = process.env[k];
  if (process.platform === "darwin") e.TMPDIR = path.join(agentHome, "tmp");
  return e;
}
