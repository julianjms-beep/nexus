// NEXUS Agentes: the orchestrator for AI agents on this computer (Claude Code, or any program that speaks MCP).
// It runs inside nexus-sessiond, as the person, and is the only way an agent reaches anything outside its sandbox.
//
//   * An agent is a named profile: one project folder and a list of capabilities written as MCP URIs
//     (fs://read/~/proyectos/web, fs://write/…, exec://…, system://read, logs://read, memory://proyecto,
//     automations://propose, notify://desktop). The MCP server only lists, and only accepts, what those URIs allow.
//   * `nexus-agente <agente> -- <programa>` starts the agent inside bubblewrap: a private home of its own, the
//     granted folders, no SSH keys, no NEXUS tokens, no desktop. Whatever needs your keys (git push) or is risky goes
//     through run_command, which classifies it (risk.ts): blocked, run in the sandbox, or held for your click.
//     Commits and pushes first go to a review committee (architecture, security, performance) when Claude is set up.
//   * Watchdog per run: repeated identical calls (a loop), call / time / token quotas. It pauses and asks you, or
//     halts: halting kills the agent's whole sandbox (its PID namespace).
//   * Self-healing loop: while an agent runs, NEXUS watches its folder; after a change it runs the project's checks
//     (tests, linter) in the sandbox and appends a failure to the agent's next NEXUS tool result.
//   * Shared memory per project (memory_save / memory_search), and project_context, which gives an agent only what
//     matters now (branch, changes, last commits, the failing check, the last failing automation).
//   * Token quotas: the agent's Claude API traffic can go through /llm/<token> here, which counts the tokens of every
//     answer and refuses new requests once the agent's budget is spent.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import { sandboxArgv } from "./automations.ts";
import { localServers } from "./ports.ts";
import { classifyCommand, GIT_SAFE_ENV, gitRepoRisks } from "./risk.ts";
import { resolveReal, isInside } from "./security.ts";

export const AGENT_LIMITS = {
  agents: 30, runsKept: 40, activityKept: 200, approvalMs: 5 * 60_000,
  loopRepeats: 5, loopWindowMs: 3 * 60_000,
  commandMs: 5 * 60_000, outputChars: 32_000, readChars: 200_000, writeBytes: 1_000_000, listEntries: 300,
  memoryEntries: 500, memoryChars: 4000, contextChars: 12_000, diffChars: 120_000, debounceMs: 2000,
};
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const COUNCIL_ROLES = ["arquitectura", "seguridad", "rendimiento"] as const;
// US$ per million tokens (Claude API list prices, 2026-11): input, output, cache read. Cache writes = 1.25× input
// (5 min) or 2× (1 h). Haiku 5.5 costs more above 100K prompt tokens. A model not listed is counted without a price.
export const PRICES: [RegExp, { in: number; out: number; read: number; over100k?: { in: number; out: number } }][] = [
  [/^claude-(fable|mythos)-5-1/, { in: 10, out: 50, read: 0.25 }],
  [/^claude-(fable|mythos)-5/, { in: 10, out: 50, read: 1 }],
  [/^claude-opus-5-5/, { in: 4, out: 20, read: 0.2 }],
  [/^claude-opus-(5|4-8)/, { in: 5, out: 25, read: 0.5 }],
  [/^claude-sonnet-5/, { in: 2, out: 10, read: 0.2 }],
  [/^claude-haiku-5-5/, { in: 0.1, out: 0.5, read: 0.01, over100k: { in: 0.5, out: 2.5 } }],
];
export type Usage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } };
/** Cost in US$ of one answer, or null when the model has no known price. */
export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES.find(([re]) => re.test(model))?.[1];
  if (!p) return null;
  const inp = u.input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, out = u.output_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0);
  const big = p.over100k && inp + read + w5m + w1h > 100_000 ? p.over100k : null;
  const pin = big ? big.in : p.in, pout = big ? big.out : p.out;
  return (inp * pin + w5m * pin * 1.25 + w1h * pin * 2 + read * p.read + out * pout) / 1e6;
}

export type ScopeKind = "fs.read" | "fs.write" | "exec" | "system" | "logs" | "memory" | "automations" | "notify";
export type Agent = {
  id: string; name: string; folder: string; scopes: string[]; check: string; council: boolean;
  maxCalls: number; maxMinutes: number; maxTokens: number; maxUsd: number; created: string;
  /** What the person wants from this agent, in their words (optional). The program reads it when it connects. */
  brief?: string;
};
export type Activity = { at: string; tool: string; text: string; outcome: "ok" | "error" | "denied" | "approved" | "waiting" | "info"; risk?: string };
export type Verdict = { role: string; approve: boolean; summary: string; findings: { severity: string; file: string; issue: string }[]; error?: string; model?: string; route?: string; tokens?: { input: number; output: number } };
export type Council = { available: boolean; ok: boolean; yes: number; verdicts: Verdict[]; empty?: boolean; usd?: number };
export type Health = { ok: boolean; at: string; command: string; output: string; ms: number; files: string[]; reported: boolean };
export type Run = {
  id: string; agent: string; tokenHash: string; started: string; ended?: string;
  status: "running" | "waiting" | "halted" | "ended"; reason?: string; program: string; goal: string;
  pid?: number; client?: string; calls: number; served: number; llm: { input: number; output: number; requests: number; usd: number; model?: string; unpriced?: boolean; councilUsd?: number };
  activity: Activity[]; recent: { key: string; at: number }[]; health?: Health; checking?: boolean; recheck?: boolean;
  changed: Set<string>; wasFailing?: boolean;
};
export type Approval = { id: string; run: string; agent: string; agentName: string; title: string; detail: string; risk: string; at: string; council?: Council };

// What an agent gets as ANTHROPIC_API_KEY. NEXUS swaps it for the person's real key on the way out (the Engine holds
// it), so an agent can use Claude, counted against its budget, but can never read or leak the key.
export const AGENT_KEY = "sk-ant-nexus-agent-the-key-stays-with-nexus";
// Claude Code policy for agents (managed settings + CLAUDE.md), bound read-only over /etc/claude-code in the sandbox only.
export const CLAUDE_POLICY_DIR = "/usr/share/nexus/agents/claude";

export type AgentsOptions = {
  configDir: string; dataDir: string; home: string; port: () => number;
  runtimeDirs: string[];                                   // hidden from agents (session sockets, NEXUS tokens)
  push: (kind: string, data: unknown) => void;             // desktop events: "agents", "agent-approval"
  notice: (text: string, kind: "info" | "warn") => void;
  launch: (app: string) => void;
  review?: (diff: string, role: string) => Promise<Verdict>;   // NEXUS AI (the Engine) reviews a diff as one role
  proposeAutomation?: (draft: Record<string, unknown>) => void;
  lastFailure?: (folder: string) => { name: string; at: string; output: string } | null;
  spawnFn?: (argv: string[], env?: NodeJS.ProcessEnv) => ChildProcess;   // tests
  hasSandbox?: () => boolean;
  fetchFn?: typeof fetch;                                  // tests (the LLM proxy)
  /** Sends an agent's Claude request with the person's key (the Engine adds it). Without it, only the agent's own key works. */
  forward?: (pathAndQuery: string, init: { method: string; headers: Record<string, string>; body?: Buffer }) => Promise<Response>;
  claudePolicy?: { dir: string; etc: string };             // where the policy files are, and the /etc/claude-code to cover
  watch?: boolean;                                         // tests switch the folder watcher off
  /** How programs are isolated on this computer. Default: bubblewrap, as on NEXUS OS. macOS: core/src/iso-agent-mac.ts. */
  platform?: AgentPlatform;
  /** The MCP bridge the agent's client starts (stdio). Default: nexus-mcp, as installed on NEXUS OS. */
  mcpCommand?: { command: string; args: string[] };
  /** Language of what the person reads in an approval. Default "es". */
  lang?: "es" | "en";
};
export type AgentSandboxSpec = { home: string; agentHome: string; folder: string; read: string[]; write: string[]; runtimeDirs: string[]; interactive: boolean; policy?: { dir: string; etc: string } };
export type AgentPlatform = {
  available: () => boolean;
  /** The command line that starts the agent program isolated (the launcher appends the program) and the HOME it sees. */
  agent: (o: AgentSandboxSpec) => { argv: string[]; home: string };
  /** The command line that runs one shell command isolated: only `root` is writable, it starts in `cwd`.
   *  `keys`: the person approved this very command, so their SSH keys / agent are reachable. */
  command: (command: string, cwd: string, root: string, keys: boolean) => string[];
  /** The environment of those commands. */
  env?: () => NodeJS.ProcessEnv;
};

// Never readable or writable through NEXUS, whatever the scopes say: keys, tokens, NEXUS's own state.
const SENSITIVE = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.kube(\/|$)/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.env(\.(local|production|development|test|prod|dev))?$/, /\.pem$/, /\.p12$/, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
  /(^|\/)\.git-credentials$/, /(^|\/)\.netrc$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.config\/gh(\/|$)/,
  /(^|\/)\.config\/nexus(\/|$)/, /(^|\/)\.local\/share\/nexus(\/|$)/, /(^|\/)\.claude(\.json|\/|$)/, /(^|\/)\.mozilla(\/|$)/,
];
const IGNORED = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|dist|build|target|\.next|\.cache|\.pytest_cache|coverage)(\/|$)/;
const PATH_SCOPE = /^(fs:\/\/(read|write)|exec:\/)\/(~(\/[^\0]*)?|\/[^\0]+)$/;
const PLAIN_SCOPES: Record<string, ScopeKind> = {
  "system://read": "system", "logs://read": "logs", "memory://proyecto": "memory", "automations://propose": "automations", "notify://desktop": "notify",
};

const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} caracteres más)` : s);
class Denied extends Error {}

/** One capability URI → its kind and (for files and commands) the folder. Throws a Spanish message when invalid. */
export function parseScope(uri: unknown, home: string): { kind: ScopeKind; path?: string; uri: string } {
  const s = String(uri ?? "").trim();
  if (Object.hasOwn(PLAIN_SCOPES, s)) return { kind: PLAIN_SCOPES[s], uri: s };
  const m = PATH_SCOPE.exec(s);
  if (!m) throw new Error(`permiso desconocido: ${s.slice(0, 80)}`);
  const kind: ScopeKind = m[1] === "fs://read" ? "fs.read" : m[1] === "fs://write" ? "fs.write" : "exec";
  const p = m[3] === "~" ? home : m[3].startsWith("~/") ? path.join(home, m[3].slice(2)) : m[3];
  let real: string;
  try { real = fs.realpathSync(p); } catch { throw new Error(`la carpeta ${tilde(p, home)} no existe`); }
  const h = fs.realpathSync(home);
  if (real === h) throw new Error("un agente no puede tener toda tu carpeta personal: elige una carpeta de proyecto");
  if (!real.startsWith(h + path.sep)) throw new Error("las carpetas de un agente tienen que estar dentro de tu carpeta personal");
  if (SENSITIVE.some((r) => r.test(real))) throw new Error(`${tilde(real, h)} guarda claves o datos de NEXUS: no se puede dar a un agente`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${tilde(real, h)} no es una carpeta`);
  const scheme = kind === "fs.read" ? "fs://read" : kind === "fs.write" ? "fs://write" : "exec:/";
  return { kind, path: real, uri: `${scheme}/${tilde(real, h)}` };
}

/** Default capabilities for a project folder: read, write and run there, shared memory, system status. */
export function defaultScopes(folder: string, home: string): string[] {
  const t = tilde(folder, home);
  return [`fs://read/${t}`, `fs://write/${t}`, `exec://${t}`, "memory://proyecto", "system://read"];
}

/** The project's own checks (tests, linter), guessed from its files. "" when there is nothing to run. */
export function detectCheck(folder: string): string {
  const has = (f: string) => fs.existsSync(path.join(folder, f));
  if (has("package.json")) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8"))?.scripts ?? {};
      const parts: string[] = [];
      if (typeof s.test === "string" && !/no test specified/.test(s.test)) parts.push("npm test --silent");
      if (typeof s.lint === "string") parts.push("npm run lint --silent");
      if (parts.length) return parts.join(" && ");
    } catch { /* broken package.json: nothing to run */ }
  }
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("tests")) return "python3 -m pytest -q";
  if (has("Makefile")) { try { if (/^test:/m.test(fs.readFileSync(path.join(folder, "Makefile"), "utf8"))) return "make test"; } catch { /* unreadable */ } }
  return "";
}

/** Normalises an agent profile coming from the app. Errors are in Spanish for the person. */
export function validateAgent(input: any, home: string, existing?: Agent): Agent {
  const name = String(input?.name ?? existing?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new Error("ponle un nombre al agente");
  const id = existing?.id ?? (norm(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "agente");
  if (id === "runs" || id === "approvals") throw new Error("ese nombre está reservado: elige otro");
  const folderIn = String(input?.folder ?? (existing ? tilde(existing.folder, home) : "")).trim();
  if (!folderIn) throw new Error("elige la carpeta del proyecto");
  const folder = parseScope(`fs://read/${folderIn.startsWith("/") || folderIn.startsWith("~") ? folderIn : "~/" + folderIn}`, home).path!;
  const rawScopes: unknown[] = Array.isArray(input?.scopes) ? input.scopes : existing?.scopes ?? defaultScopes(folder, home);
  if (rawScopes.length > 30) throw new Error("demasiados permisos");
  const scopes = [...new Set(rawScopes.map((s) => parseScope(s, home).uri))];
  const check = String(input?.check ?? existing?.check ?? "").trim();
  if (check.length > 300 || /[\n\0]/.test(check)) throw new Error("el comando de comprobación tiene que ser una sola línea corta");
  const brief = String(input?.brief ?? existing?.brief ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (brief.length > 3000) throw new Error("el encargo es demasiado largo (máximo 3.000 letras)");
  const int = (v: unknown, d: number, lo: number, hi: number) => { const n = Math.round(Number(v ?? d)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    id, name, folder, scopes, check, brief,
    council: input?.council === undefined ? existing?.council ?? true : input.council === true,
    maxCalls: int(input?.maxCalls ?? existing?.maxCalls, 400, 10, 5000),
    maxMinutes: int(input?.maxMinutes ?? existing?.maxMinutes, 240, 5, 1440),
    maxTokens: int(input?.maxTokens ?? existing?.maxTokens, 2_000_000, 0, 50_000_000),
    maxUsd: (() => { const n = Number(input?.maxUsd ?? existing?.maxUsd ?? 5); return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n * 100) / 100)) : 5; })(),
    created: existing?.created ?? new Date().toISOString(),
  };
}

// «Escríbelo con tus palabras»: NEXUS AI turns a description into the form of a new agent (the person reviews it and saves).
export const AGENT_PERMS: Record<string, string> = { leer: "read", escribir: "write", ejecutar: "exec", memoria: "memory", sistema: "system", registros: "logs", automatizaciones: "automations", avisos: "notify" };
export const AGENT_DRAFT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["nombre", "carpeta", "encargo", "permisos", "comprobacion", "limite_usd", "comite"],
  properties: {
    nombre: { type: "string" }, carpeta: { type: "string" }, encargo: { type: "string" },
    permisos: { type: "array", items: { type: "string", enum: Object.keys(AGENT_PERMS) } },
    comprobacion: { type: "string" }, limite_usd: { type: "number" }, comite: { type: "boolean" },
  },
} as const;
export const AGENT_DRAFT_PROMPT = `You fill in the form of a new coding agent for NEXUS OS from what the person wrote in <quiere>. Call crear_agente exactly once. The person reviews it before saving.
An agent is an AI program (Claude Code) that works inside ONE project folder of the person's home, isolated, with only the permissions it is given. The person starts it from the terminal.
- nombre: short, in Spanish, like "Arreglatests" or "Revisor de la web".
- carpeta: the project folder as ~/ruta. Pick it from <carpetas> when one matches what they mean; otherwise use what they wrote.
- encargo: the agent's standing job in the person's words, made clear and concrete (what to do, what not to touch, when it is finished). 1–6 sentences, Spanish.
- permisos: the least it needs. leer = read the folder; escribir = change files in it; ejecutar = run commands there (tests, builds); memoria = shared notes between agents of this project; sistema = read CPU/memory/disk; registros = read system logs; automatizaciones = propose automations; avisos = desktop notices. Reviewing or explaining code needs only leer. Fixing code needs leer, escribir, ejecutar.
- comprobacion: one shell command that checks the project after changes (npm test, cargo test, python3 -m pytest -q…) or "" to let NEXUS detect it.
- limite_usd: a spending cap per session in US$ (1–20; 5 by default; bigger jobs more).
- comite: true unless they ask for no review (the review committee checks commits and risky commands).`;
/** NEXUS AI's answer → the shape the Agentes form opens (like a saved agent, without id). */
export function fromAgentDraft(d: any): Record<string, unknown> {
  const s = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  let folder = s(d?.carpeta, 200).replace(/\/+$/, "") || "~/proyectos/";
  if (!folder.startsWith("~") && !folder.startsWith("/")) folder = "~/" + folder;
  const perms = new Set((Array.isArray(d?.permisos) ? d.permisos : []).map((p: unknown) => AGENT_PERMS[String(p)]).filter(Boolean) as string[]);
  if (perms.has("write")) perms.add("read");
  if (!perms.size) perms.add("read");
  const usd = Number(d?.limite_usd);
  return { id: "", name: s(d?.nombre, 40), folderShort: folder, brief: String(d?.encargo ?? "").trim().slice(0, 3000), check: s(d?.comprobacion, 300),
    council: d?.comite !== false, maxCalls: 400, maxMinutes: 240, maxTokens: 2_000_000, maxUsd: Number.isFinite(usd) ? Math.min(50, Math.max(0.5, Math.round(usd * 100) / 100)) : 5,
    perms: [...perms] };
}

/** bwrap argv for the agent program itself (the launcher appends the program). Private home, granted folders only. */
export function agentSandboxArgv(o: AgentSandboxSpec): string[] {
  const a = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const d of o.runtimeDirs) if (fs.existsSync(d)) a.push("--tmpfs", d);
  // Claude Code reads managed settings from /etc/claude-code: inside the sandbox only, NEXUS's policy is there (read-only)
  if (o.policy && fs.existsSync(o.policy.etc) && fs.existsSync(path.join(o.policy.dir, "managed-settings.json"))) {
    a.push("--tmpfs", o.policy.etc);
    for (const f of ["managed-settings.json", "CLAUDE.md"]) if (fs.existsSync(path.join(o.policy.dir, f))) a.push("--ro-bind", path.join(o.policy.dir, f), path.join(o.policy.etc, f));
    a.push("--remount-ro", o.policy.etc);
  }
  a.push("--bind", o.agentHome, o.home);
  // what programs need to run (git identity, tools installed with npm i -g / pip --user), never keys or tokens
  for (const f of [".gitconfig", ".config/git", ".local/bin", ".local/lib"]) { const p = path.join(o.home, f); if (fs.existsSync(p)) a.push("--ro-bind", p, p); }
  const write = new Set(o.write);
  for (const p of o.read) if (!write.has(p)) a.push("--ro-bind", p, p);
  for (const p of o.write) a.push("--bind", p, p);
  a.push("--chdir", o.folder, "--setenv", "HOME", o.home, "--unshare-pid", "--unshare-ipc", "--die-with-parent");
  if (!o.interactive) a.push("--new-session"); // interactive agents keep the terminal; TIOCSTI is off system-wide (sysctl)
  a.push("--");
  return a;
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { HOME: home, PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, LANG: process.env.LANG ?? "es_ES.UTF-8", TERM: "dumb", CI: "1" };
  if (process.env.TZ) e.TZ = process.env.TZ;
  return e;
}

// ---------------------------------------------------------------------------------------------------- tool registry
const KNOWN_TOOLS: Record<string, string> = {
  git: "control de versiones", gh: "GitHub desde la terminal", node: "JavaScript (Node.js)", npm: "paquetes de Node", npx: "ejecutar paquetes de Node",
  pnpm: "paquetes de Node (pnpm)", yarn: "paquetes de Node (yarn)", bun: "JavaScript (Bun)", deno: "JavaScript (Deno)",
  python3: "Python 3", pip3: "paquetes de Python", uv: "entornos y paquetes de Python (uv)", pytest: "tests de Python", ruff: "linter de Python",
  gcc: "compilador C", "g++": "compilador C++", make: "builds con Makefile", cmake: "builds con CMake", cargo: "Rust: build y paquetes",
  rustc: "compilador de Rust", go: "Go", java: "Java", rg: "búsqueda en código (ripgrep)", jq: "procesar JSON", tmux: "terminales persistentes",
  curl: "peticiones HTTP", wget: "descargas", sqlite3: "bases de datos SQLite", psql: "PostgreSQL", docker: "contenedores", podman: "contenedores",
  kubectl: "Kubernetes", terraform: "infraestructura como código", claude: "Claude Code", ssh: "conexiones SSH", rsync: "copias y sincronización",
};
export function scanTools(home: string, dirs = [path.join(home, ".local/bin"), "/usr/local/bin", "/usr/bin"]): { name: string; description: string; path: string; mine: boolean }[] {
  const out: { name: string; description: string; path: string; mine: boolean }[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    const mine = d !== "/usr/bin";
    for (const n of names.sort()) {
      if (seen.has(n) || (!mine && !Object.hasOwn(KNOWN_TOOLS, n))) continue;
      const p = path.join(d, n);
      try { fs.accessSync(p, fs.constants.X_OK); if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      seen.add(n);
      out.push({ name: n, description: KNOWN_TOOLS[n] ?? "instalada en este equipo", path: p, mine });
    }
  }
  return out.slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------- MCP tools
type Ctx = { run: Run; agent: Agent };
type ToolOut = { text: string; isError?: boolean };
type Tool = { name: string; title: string; needs: ScopeKind[]; description: string; inputSchema: Record<string, unknown>; run: (c: Ctx, a: any) => Promise<ToolOut> };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "integer", description });

export class Agents {
  private file: string; private runsFile: string;
  private list_: Agent[] = [];
  private runs = new Map<string, Run>();
  private byToken = new Map<string, string>();
  private approvals = new Map<string, { ap: Approval; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private watchers = new Map<string, { w: fs.FSWatcher; timer?: NodeJS.Timeout }>();
  private toolsCache: { key: string; list: ReturnType<typeof scanTools> } | null = null;
  private saveTimer?: NodeJS.Timeout;
  private tools: Tool[];

  constructor(private o: AgentsOptions) {
    this.file = path.join(o.configDir, "agents.json");
    this.runsFile = path.join(o.dataDir, "runs.json");
    try { const v = JSON.parse(fs.readFileSync(this.file, "utf8")); if (Array.isArray(v)) this.list_ = v.map((a) => ({ maxUsd: 5, ...a })); } catch { /* none yet */ }
    try {
      const v = JSON.parse(fs.readFileSync(this.runsFile, "utf8"));
      // runs of an earlier session: their tokens died with it
      if (Array.isArray(v)) for (const r of v) this.runs.set(r.id, { ...r, llm: { usd: 0, ...r.llm }, status: r.status === "halted" ? "halted" : "ended", ended: r.ended ?? r.started, changed: new Set(), recent: [] });
    } catch { /* none yet */ }
    this.tools = this.defineTools();
  }

  // ------------------------------------------------------------------------------------------------ profiles
  view() {
    const runs = [...this.runs.values()].sort((a, b) => b.started.localeCompare(a.started)).slice(0, AGENT_LIMITS.runsKept);
    return {
      agents: this.list_.map((a) => ({
        ...a, folderShort: tilde(a.folder, this.o.home), checkAuto: a.check || detectCheck(a.folder),
        running: runs.find((r) => r.agent === a.id && (r.status === "running" || r.status === "waiting"))?.id ?? null,
        tools: this.toolsFor(a).map((t) => t.name),
      })),
      runs: runs.map((r) => this.runView(r)),
      approvals: [...this.approvals.values()].map((x) => x.ap),
    };
  }
  private runView(r: Run) {
    const { tokenHash: _t, recent: _r, changed: _c, ...rest } = r;
    return { ...rest, activity: r.activity.slice(-80) };
  }
  get(id: string) { return this.list_.find((a) => a.id === id); }
  save(input: any) {
    const existing = input?.id ? this.get(String(input.id)) : undefined;
    if (input?.id && !existing) throw new Error("ese agente ya no existe");
    if (!existing && this.list_.length >= AGENT_LIMITS.agents) throw new Error("ya tienes demasiados agentes");
    const a = validateAgent(input, this.o.home, existing);
    if (!existing && this.get(a.id)) throw new Error(`ya hay un agente que se llama ${a.id}`);
    this.list_ = existing ? this.list_.map((x) => (x.id === a.id ? a : x)) : [...this.list_, a];
    this.write(this.file, this.list_);
    this.changed();
    return a;
  }
  remove(id: string) {
    if (!this.get(id)) throw new Error("ese agente ya no existe");
    for (const r of this.runs.values()) if (r.agent === id && (r.status === "running" || r.status === "waiting")) this.halt(r.id, "se ha borrado el agente");
    this.list_ = this.list_.filter((a) => a.id !== id);
    this.write(this.file, this.list_);
    this.changed();
    return { ok: true };
  }
  private scopes(a: Agent) { return a.scopes.map((s) => { try { return parseScope(s, this.o.home); } catch { return null; } }).filter((s): s is NonNullable<typeof s> => !!s); }
  private can(a: Agent, k: ScopeKind) { return this.scopes(a).some((s) => s.kind === k); }
  private toolsFor(a: Agent) { return this.tools.filter((t) => t.needs.some((k) => this.can(a, k))); }

  // ------------------------------------------------------------------------------------------------ runs
  private hasSandbox() {
    if (this.o.hasSandbox) return this.o.hasSandbox();
    if (this.o.platform) return this.o.platform.available();
    try { return require_bwrap(); } catch { return false; }
  }
  /** Called by nexus-agente (with the session token): a run, its MCP token and the sandbox to start the program in. */
  startRun(agentId: string, b: { program?: unknown; goal?: unknown; interactive?: unknown }) {
    const a = this.get(agentId); if (!a) throw new Error(`no hay ningún agente que se llame ${agentId}`);
    if (!this.hasSandbox()) throw new Error("este equipo no puede aislar programas (falta bubblewrap): no se arranca ningún agente sin aislar");
    for (const r of this.runs.values()) if (r.agent === a.id && (r.status === "running" || r.status === "waiting")) throw new Error(`${a.name} ya está en marcha: detenlo antes de arrancarlo otra vez`);
    const token = randomBytes(24).toString("base64url");
    const run: Run = {
      id: randomBytes(6).toString("hex"), agent: a.id, tokenHash: sha(token), started: new Date().toISOString(), status: "running",
      program: String(b.program ?? "").split("\n")[0].slice(0, 80), goal: String(b.goal ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      calls: 0, served: 0, llm: { input: 0, output: 0, requests: 0, usd: 0 }, activity: [], recent: [], changed: new Set(),
    };
    this.runs.set(run.id, run); this.byToken.set(run.tokenHash, run.id);
    this.prune();
    const agentHome = path.join(this.o.dataDir, a.id, "casa");
    fs.mkdirSync(agentHome, { recursive: true, mode: 0o700 });
    const mcpConfig = path.join(agentHome, ".nexus-mcp.json");
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { nexus: { type: "stdio", ...(this.o.mcpCommand ?? { command: "nexus-mcp", args: [] }) } } }, null, 2) + "\n", { mode: 0o600 });
    this.seedClaude(agentHome, a);
    const sc = this.scopes(a);
    const spec: AgentSandboxSpec = {
      home: this.o.home, agentHome, folder: a.folder, runtimeDirs: this.o.runtimeDirs, interactive: b.interactive === true,
      policy: this.o.claudePolicy ?? { dir: CLAUDE_POLICY_DIR, etc: "/etc/claude-code" },
      read: sc.filter((s) => s.kind === "fs.read").map((s) => s.path!), write: sc.filter((s) => s.kind === "fs.write").map((s) => s.path!),
    };
    // bubblewrap puts the agent's private home where the real one is; other platforms give it a home of its own
    const sb = this.o.platform ? this.o.platform.agent(spec) : { argv: agentSandboxArgv(spec), home: this.o.home };
    const argv = sb.argv;
    const base = `http://127.0.0.1:${this.o.port()}`;
    const env: Record<string, string> = { NEXUS_AGENT: a.id, NEXUS_AGENT_TOKEN: token, NEXUS_MCP_URL: `${base}/mcp`, NEXUS_MCP_CONFIG: path.join(sb.home, ".nexus-mcp.json") };
    if (a.maxTokens > 0 || a.maxUsd > 0) env.ANTHROPIC_BASE_URL = `${base}/llm/${token}`; // quota: the agent's Claude traffic is counted here
    if (env.ANTHROPIC_BASE_URL && this.o.forward) env.ANTHROPIC_API_KEY = AGENT_KEY;     // the real key is added by NEXUS on the way out
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"; env.DISABLE_AUTOUPDATER = "1";     // Claude Code is updated with NEXUS
    this.log(run, "nexus", `Arranca ${run.program || "el agente"} en ${tilde(a.folder, this.o.home)}${run.goal ? ` · objetivo: ${run.goal}` : ""}`, "info");
    this.watchFolder(run, a);
    return { run: run.id, token, argv, env, home: sb.home, folder: a.folder, name: a.name };
  }
  /** Claude Code's first-run state in the agent's private home: no onboarding, the NEXUS key accepted, the folder trusted. */
  private seedClaude(agentHome: string, a: Agent) {
    const f = path.join(agentHome, ".claude.json");
    let j: any = {};
    try { j = JSON.parse(fs.readFileSync(f, "utf8")); if (!j || typeof j !== "object" || Array.isArray(j)) j = {}; } catch { /* first run */ }
    j.hasCompletedOnboarding = true;
    j.theme ??= "dark";
    const ok = new Set<string>(Array.isArray(j.customApiKeyResponses?.approved) ? j.customApiKeyResponses.approved : []);
    ok.add(AGENT_KEY.slice(-20));
    j.customApiKeyResponses = { approved: [...ok], rejected: Array.isArray(j.customApiKeyResponses?.rejected) ? j.customApiKeyResponses.rejected : [] };
    j.projects ??= {};
    j.projects[a.folder] = { ...(j.projects[a.folder] ?? {}), hasTrustDialogAccepted: true };
    fs.writeFileSync(f + ".tmp", JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(f + ".tmp", f);
  }
  runStatus(id: string) { const r = this.runs.get(id); if (!r) throw new Error("no existe esa ejecución"); return { status: r.status, reason: r.reason ?? null, pid: r.pid ?? null }; }
  setPid(id: string, pid: unknown) { const r = this.runs.get(id); if (!r) throw new Error("no existe esa ejecución"); const n = Number(pid); if (Number.isInteger(n) && n > 1) r.pid = n; return { ok: true }; }
  endRun(id: string, code: unknown) {
    const r = this.runs.get(id); if (!r) throw new Error("no existe esa ejecución");
    if (r.status === "running" || r.status === "waiting") { r.status = "ended"; r.ended = new Date().toISOString(); this.log(r, "nexus", `El programa ha terminado (código ${Number(code)})`, "info"); }
    this.finish(r);
    return { ok: true };
  }
  /** SIGAGENT_HALT, NEXUS style: the run's token stops working and its sandbox (the whole PID namespace) is killed. */
  halt(id: string, reason = "detenido por ti") {
    const r = this.runs.get(id); if (!r) throw new Error("no existe esa ejecución");
    if (r.status === "halted" || r.status === "ended") return { ok: true };
    r.status = "halted"; r.reason = reason; r.ended = new Date().toISOString();
    for (const [aid, x] of this.approvals) if (x.ap.run === id) this.decide(aid, false);
    if (r.pid) { try { process.kill(r.pid, "SIGKILL"); } catch { /* already gone */ } }
    this.log(r, "nexus", `Detenido: ${reason}`, "denied");
    const a = this.get(r.agent);
    this.o.notice(`NEXUS ha detenido a ${a?.name ?? r.agent}: ${reason}`, "warn");
    this.finish(r);
    return { ok: true };
  }
  private finish(r: Run) {
    const w = this.watchers.get(r.id); if (w) { clearTimeout(w.timer); w.w.close(); this.watchers.delete(r.id); }
    this.byToken.delete(r.tokenHash);
    this.changed();
  }
  private prune() {
    const all = [...this.runs.values()].sort((a, b) => b.started.localeCompare(a.started));
    for (const r of all.slice(AGENT_LIMITS.runsKept)) if (r.status === "ended" || r.status === "halted") this.runs.delete(r.id);
  }
  stop() {
    for (const r of this.runs.values()) if (r.status === "running" || r.status === "waiting") this.halt(r.id, "se ha cerrado la sesión");
    for (const x of this.approvals.values()) clearTimeout(x.timer);
    clearTimeout(this.saveTimer); this.flush();
  }

  // ------------------------------------------------------------------------------------------------ approvals
  private ask(c: Ctx, title: string, detail: string, risk: string, council?: Council): Promise<boolean> {
    const ap: Approval = { id: randomBytes(6).toString("hex"), run: c.run.id, agent: c.agent.id, agentName: c.agent.name, title, detail, risk, at: new Date().toISOString(), council };
    c.run.status = "waiting";
    this.log(c.run, "permiso", `Pide permiso: ${title}`, "waiting", risk);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.decide(ap.id, false, "sin respuesta en 5 minutos"), AGENT_LIMITS.approvalMs);
      this.approvals.set(ap.id, { ap, resolve, timer });
      this.o.push("agent-approval", { id: ap.id });
      this.o.notice(`${c.agent.name} pide permiso: ${title}`, "warn");
      this.o.launch("agents");
      this.changed();
    });
  }
  decide(id: string, approve: boolean, why?: string) {
    const x = this.approvals.get(id); if (!x) throw new Error("ese permiso ya no está pendiente");
    this.approvals.delete(id); clearTimeout(x.timer);
    const r = this.runs.get(x.ap.run);
    if (r) {
      if (r.status === "waiting" && ![...this.approvals.values()].some((y) => y.ap.run === r.id)) r.status = "running";
      this.log(r, "permiso", `${approve ? "Aprobado" : "Rechazado"}${why ? ` (${why})` : ""}: ${x.ap.title}`, approve ? "approved" : "denied");
    }
    x.resolve(approve);
    this.changed();
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ MCP (JSON-RPC)
  runForToken(token: string) {
    const id = this.byToken.get(sha(String(token ?? "")));
    const r = id ? this.runs.get(id) : undefined;
    return r && (r.status === "running" || r.status === "waiting") ? r : undefined;
  }
  /** One JSON-RPC message from an agent. `null` body = a notification (HTTP 202). */
  async mcp(token: string, msg: any): Promise<{ status: number; body: unknown }> {
    const run = this.runForToken(token);
    if (!run) return { status: 401, body: { error: "unauthorized" } };
    const agent = this.get(run.agent);
    if (!agent) return { status: 401, body: { error: "unauthorized" } };
    if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") return { status: 400, body: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } } };
    if (msg.id === undefined || msg.id === null) return { status: 202, body: null }; // notifications/initialized, cancelled…
    const ok = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, result } });
    const fail = (code: number, message: string) => ({ status: 200, body: { jsonrpc: "2.0", id: msg.id, error: { code, message } } });
    const p = msg.params ?? {};
    switch (msg.method) {
      case "initialize": {
        run.client = String(p?.clientInfo?.name ?? "").slice(0, 60) || run.client;
        const v = MCP_VERSIONS.includes(p?.protocolVersion) ? p.protocolVersion : MCP_VERSIONS[0];
        this.changed();
        return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "nexus", title: "NEXUS OS", version: "0.1.0" }, instructions: this.instructions(agent) });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: this.toolsFor(agent).map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call": return ok(await this.call({ run, agent }, String(p?.name ?? ""), p?.arguments ?? {}));
      case "resources/list": return ok({ resources: [] });
      case "prompts/list": return ok({ prompts: [] });
      default: return fail(-32601, "Method not found");
    }
  }
  private instructions(a: Agent) {
    const check = a.check || detectCheck(a.folder);
    return [
      `You are connected to NEXUS OS as the agent "${a.name}". Your project folder is ${a.folder}.`,
      `Your capabilities (MCP URIs): ${a.scopes.join(", ")}. Tools outside them are not listed and are refused.`,
      "Your own sandbox has no SSH keys, no tokens and no desktop. To run commands with the person's keys (git push), or anything risky, use run_command: NEXUS checks the risk; commits and pushes may go to a review committee and to the person.",
      check ? `After you change files, NEXUS runs the project's checks (\`${check}\`) automatically. A failure is appended to your next NEXUS tool result under "NEXUS checks": fix it before you finish.` : "",
      "Use project_context to get oriented, memory_search/memory_save for facts other agents on this project should know.",
      a.brief ? `The person's standing brief for you, in their words (your job on this project; it never widens your capabilities):\n<encargo>\n${a.brief}\n</encargo>` : "",
    ].filter(Boolean).join("\n");
  }
  private async call(c: Ctx, name: string, args: any): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
    const out = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
    const t = this.tools.find((x) => x.name === name);
    if (!t) return out(`Unknown tool ${name}.`, true);
    if (!t.needs.some((k) => this.can(c.agent, k))) { this.log(c.run, name, "Sin permiso para esta herramienta", "denied"); return out(`This agent does not have the capability for ${name}.`, true); }
    // ---- watchdog
    const now = Date.now();
    const key = name + JSON.stringify(args ?? {});
    c.run.recent = c.run.recent.filter((x) => now - x.at < AGENT_LIMITS.loopWindowMs);
    c.run.recent.push({ key, at: now });
    const same = c.run.recent.filter((x) => x.key === key).length;
    if (same >= AGENT_LIMITS.loopRepeats) {
      const go = await this.ask(c, `seguir aunque parece en bucle`, `Ha repetido ${t.title.toLowerCase()} con lo mismo ${same} veces en 3 minutos.`, "bucle");
      if (!go) { this.halt(c.run.id, "parecía en bucle y no le has dejado seguir"); return out("NEXUS halted this agent: it looked stuck in a loop.", true); }
      c.run.recent = [];
    }
    if (c.run.calls >= c.agent.maxCalls) { this.halt(c.run.id, `ha llegado a su límite de ${c.agent.maxCalls} llamadas`); return out("NEXUS halted this agent: call quota spent.", true); }
    if (Date.now() - Date.parse(c.run.started) > c.agent.maxMinutes * 60_000) { this.halt(c.run.id, `ha llegado a su límite de ${c.agent.maxMinutes} minutos`); return out("NEXUS halted this agent: time quota spent.", true); }
    if (c.run.status !== "running" && c.run.status !== "waiting") return out("This agent has been halted by NEXUS.", true);
    c.run.calls++;
    let r: ToolOut;
    try { r = await t.run(c, args ?? {}); }
    catch (e: any) {
      const denied = e instanceof Denied;
      this.log(c.run, name, String(e?.message ?? e), denied ? "denied" : "error");
      return out(String(e?.message ?? e), true);
    }
    let text = clip(r.text, AGENT_LIMITS.readChars);
    const note = this.healthNote(c.run);
    if (note) text += "\n\n" + note;
    c.run.served += text.length;
    this.changed();
    return out(text, !!r.isError);
  }

  // ------------------------------------------------------------------------------------------------ paths
  private within(a: Agent, p: unknown, need: "read" | "write" | "exec"): string {
    const h = this.o.home;
    let s = String(p ?? "").trim() || a.folder;
    if (s === "~") s = h; else if (s.startsWith("~/")) s = path.join(h, s.slice(2)); else if (!path.isAbsolute(s)) s = path.join(a.folder, s);
    const real = resolveReal(s);
    if (SENSITIVE.some((r) => r.test(real))) throw new Denied(`${tilde(real, h)} guarda claves o datos de NEXUS: ningún agente puede usarlo.`);
    const kinds: ScopeKind[] = need === "read" ? ["fs.read", "fs.write"] : need === "write" ? ["fs.write"] : ["exec"];
    const roots = [...new Set(this.scopes(a).filter((x) => kinds.includes(x.kind)).map((x) => x.path!))];
    if (!roots.some((r) => isInside(r, real))) {
      const verb = need === "read" ? "leer" : need === "write" ? "escribir" : "ejecutar comandos";
      throw new Denied(`${tilde(real, h)} está fuera de donde este agente puede ${verb} (${roots.map((r) => tilde(r, h)).join(", ") || "ningún sitio"}).`);
    }
    return real;
  }

  /** Opens `p` without following a symlink at the end, then checks where the descriptor really points (Linux:
   *  /proc/self/fd), so a symlink the agent swaps in after the path check cannot make NEXUS read or write elsewhere. */
  private openChecked(a: Agent, p: string, need: "read" | "write", flags: number): number {
    let fd: number;
    try { fd = fs.openSync(p, flags | fs.constants.O_NOFOLLOW); }
    catch (e: any) { if (e?.code === "ELOOP" || e?.code === "EMLINK") throw new Denied(`${tilde(p, this.o.home)} es un enlace simbólico: NEXUS no lo sigue.`); throw e; }
    let real = p;
    try { real = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { try { real = fs.realpathSync(p); } catch { /* gone */ } }
    try { this.within(a, real, need); } catch (e) { fs.closeSync(fd); throw e; }
    return fd;
  }
  /** Writes through a checked descriptor; keeps the previous content in deshacer/. True when there was one. */
  private writeChecked(c: Ctx, p: string, content: string): boolean {
    if (Buffer.byteLength(content) > AGENT_LIMITS.writeBytes) throw new Error("el archivo es demasiado grande (máximo 1 MB)");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.within(c.agent, path.dirname(p), "write");
    const fd = this.openChecked(c.agent, p, "write", fs.constants.O_RDWR | fs.constants.O_CREAT);
    let kept = false;
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error(`${tilde(p, this.o.home)} no es un archivo`);
      if (st.size > 0) {
        const old = Buffer.alloc(Math.min(st.size, 8_000_000)); fs.readSync(fd, old, 0, old.length, 0);
        const undo = path.join(this.o.dataDir, c.agent.id, "deshacer");
        fs.mkdirSync(undo, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(undo, `${Date.now()}-${path.basename(p)}`), old, { mode: 0o600 });
        const all = fs.readdirSync(undo).sort(); for (const f of all.slice(0, Math.max(0, all.length - 100))) fs.rmSync(path.join(undo, f), { force: true });
        kept = true;
      }
      fs.ftruncateSync(fd, 0);
      fs.writeSync(fd, content, 0, "utf8");
    } finally { fs.closeSync(fd); }
    return kept;
  }
  private readChecked(a: Agent, p: string, max: number): Buffer {
    const fd = this.openChecked(a, p, "read", fs.constants.O_RDONLY);
    try {
      const st = fs.fstatSync(fd); if (!st.isFile()) throw new Error(`${tilde(p, this.o.home)} no es un archivo`);
      const buf = Buffer.alloc(Math.min(st.size, max)); const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n);
    } finally { fs.closeSync(fd); }
  }
  /** The granted folder (of these kinds) that contains `real`: what a sandbox binds, so no swapped subfolder is mounted. */
  private rootOf(a: Agent, real: string, kinds: ScopeKind[]) {
    return this.scopes(a).filter((x) => kinds.includes(x.kind) && isInside(x.path!, real)).map((x) => x.path!).sort((x, y) => x.length - y.length)[0] ?? real;
  }

  // ------------------------------------------------------------------------------------------------ sandboxed commands
  // `keys`: the person's SSH keys are reachable. Only for a command the person approved with their own click: any
  // other command's output goes back to the agent, so with the keys in sight `cat ~/.ssh/id_ed25519` would hand them over.
  private exec(command: string, cwd: string, ms = AGENT_LIMITS.commandMs, root = cwd, keys = false): Promise<{ code: number | null; output: string; ms: number; killed: boolean }> {
    let argv: string[];
    if (this.o.platform) argv = this.o.platform.command(command, cwd, root, keys);
    else {
      argv = sandboxArgv(command, root, this.o.home, this.o.runtimeDirs, keys);
      argv[argv.indexOf("--chdir") + 1] = cwd; // resolved inside the sandbox, where only `root` exists
    }
    // with the keys in reach, git runs nothing the repository names (hooks, core.sshCommand…): see risk.ts
    const env = { ...(this.o.platform?.env?.() ?? cleanEnv(this.o.home)), ...(keys ? GIT_SAFE_ENV : {}) };
    return new Promise((res) => {
      const t0 = Date.now(); let out = ""; let killed = false;
      const child = (this.o.spawnFn ?? ((v: string[], e?: NodeJS.ProcessEnv) => spawn(v[0], v.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: e, detached: true })))(argv, env);
      const add = (d: Buffer) => { out += d.toString("utf8"); if (out.length > 2 * AGENT_LIMITS.outputChars) out = out.slice(-AGENT_LIMITS.outputChars); };
      child.stdout?.on("data", add); child.stderr?.on("data", add);
      const timer = setTimeout(() => { killed = true; try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { child.kill("SIGKILL"); } }, ms);
      child.on("error", (e) => { out += String(e.message); });
      child.on("close", (code) => { clearTimeout(timer); res({ code, output: out.slice(-AGENT_LIMITS.outputChars), ms: Date.now() - t0, killed }); });
    });
  }

  /** The repository `cwd` is in (not above `root`): its config's risky names and its real hooks. Read here, never run. */
  private gitRisks(cwd: string, root: string): { off: string[]; warn: string[] } {
    try {
      for (let d = cwd; isInside(d, root) || d === root; d = path.dirname(d)) {
        let g = path.join(d, ".git");
        if (!fs.existsSync(g)) { if (d === root || d === path.dirname(d)) break; continue; }
        if (fs.statSync(g).isFile()) { const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, "utf8")); if (!m) break; g = path.resolve(d, m[1].trim()); }
        let config = ""; try { config = fs.readFileSync(path.join(g, "config"), "utf8").slice(0, 200_000); } catch { /* none */ }
        let hooks: string[] = [];
        try { hooks = fs.readdirSync(path.join(g, "hooks")).filter((n) => !n.endsWith(".sample") && (() => { try { const st = fs.statSync(path.join(g, "hooks", n)); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } })()).slice(0, 20); } catch { /* none */ }
        return gitRepoRisks(config, hooks);
      }
    } catch { /* unreadable: nothing to report */ }
    return { off: [], warn: [] };
  }

  // ------------------------------------------------------------------------------------------------ self-healing checks
  private watchFolder(run: Run, a: Agent) {
    if (this.o.watch === false || !(a.check || detectCheck(a.folder)) || !this.can(a, "fs.write")) return;
    try {
      const w = fs.watch(a.folder, { recursive: true }, (_e, f) => {
        const file = String(f ?? ""); if (!file || IGNORED.test(file)) return;
        run.changed.add(file);
        const entry = this.watchers.get(run.id); if (!entry) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => { this.runCheck(run, a).catch(() => {}); }, AGENT_LIMITS.debounceMs);
      });
      w.on("error", () => { /* folder removed */ });
      this.watchers.set(run.id, { w });
    } catch { /* no recursive watch here: the agent can still call check_project */ }
  }
  private async runCheck(run: Run, a: Agent): Promise<Health | null> {
    const cmd = a.check || detectCheck(a.folder);
    if (!cmd) return null;
    if (run.checking) { run.recheck = true; return run.health ?? null; }
    run.checking = true; this.changed();
    try {
      do {
        run.recheck = false;
        const files = [...run.changed].slice(0, 10); run.changed.clear();
        const r = await this.exec(cmd, a.folder);
        const ok = r.code === 0 && !r.killed;
        run.health = { ok, at: new Date().toISOString(), command: cmd, output: r.output.slice(-4000), ms: r.ms, files, reported: false };
        this.log(run, "comprobación", ok ? `${cmd} pasa (${(r.ms / 1000).toFixed(1)} s)` : `${cmd} falla${r.killed ? " (cortado a los 5 min)" : ` (código ${r.code})`}`, ok ? "ok" : "error");
      } while (run.recheck);
    } finally { run.checking = false; this.changed(); }
    return run.health ?? null;
  }
  /** The "interrupt": a failing check is appended once to the agent's next tool result (and its recovery too). */
  private healthNote(run: Run): string {
    const h = run.health;
    if (!h || h.reported) return "";
    h.reported = true;
    if (!h.ok) { run.wasFailing = true; return `--- NEXUS checks ---\nAfter your latest changes${h.files.length ? ` (${h.files.join(", ")})` : ""}, \`${h.command}\` FAILS. Fix this before you finish:\n${h.output.slice(-3000)}`; }
    if (run.wasFailing) { run.wasFailing = false; return `--- NEXUS checks ---\n\`${h.command}\` passes again.`; }
    return "";
  }

  // ------------------------------------------------------------------------------------------------ review committee
  private async council(c: Ctx, cwd: string, what: "commit" | "push"): Promise<Council> {
    if (!this.o.review) return { available: false, ok: false, yes: 0, verdicts: [] };
    const untracked = `git ls-files -o --exclude-standard | head -20 | while IFS= read -r f; do git diff --no-index -- /dev/null "$f"; done`;
    const cmd = what === "push"
      ? `git log -p --format='commit %h %s' @{upstream}..HEAD 2>/dev/null || git log -p --format='commit %h %s' -n 3`
      : `git diff HEAD; ${untracked}`;
    const d = await this.exec(cmd, cwd, 30_000, this.rootOf(c.agent, cwd, ["exec"]));
    const diff = d.output.slice(0, AGENT_LIMITS.diffChars);
    if (!diff.trim()) return { available: true, ok: true, yes: 3, verdicts: [], empty: true };
    this.log(c.run, "comité", `El comité revisa el ${what === "push" ? "push" : "commit"} (${COUNCIL_ROLES.join(", ")})`, "info");
    const verdicts = await Promise.all(COUNCIL_ROLES.map((role) => this.o.review!(diff, role).catch((e: any): Verdict => ({ role, approve: false, summary: String(e?.message ?? e), findings: [], error: "error" }))));
    const answered = verdicts.filter((v) => !v.error);
    if (!answered.length) return { available: false, ok: false, yes: 0, verdicts };
    const yes = answered.filter((v) => v.approve).length;
    const veto = answered.some((v) => v.findings.some((f) => f.severity === "alta"));
    const ok = yes >= 2 && !veto; // quorum: 2 of 3, and no high-severity finding from anyone
    // the committee's cost is part of this task's cost: it counts against the agent's dollar budget
    const usd = verdicts.reduce((sum, v) => sum + (v.model && v.tokens ? costUsd(v.model, { input_tokens: v.tokens.input, output_tokens: v.tokens.output }) ?? 0 : 0), 0);
    c.run.llm.usd += usd; c.run.llm.councilUsd = (c.run.llm.councilUsd ?? 0) + usd;
    const m = verdicts.find((v) => v.model)?.model;
    const how = m ? ` · ${/haiku/.test(m) ? "Haiku" : /sonnet/.test(m) ? "Sonnet" : "Opus"}, ${verdicts.find((v) => v.route)?.route ?? ""}` : "";
    this.log(c.run, "comité", `${ok ? "Aprobado" : "No aprobado"} por el comité (${yes} de ${verdicts.length} a favor${veto ? ", con un problema grave" : ""})${how}`, ok ? "approved" : "denied");
    if (c.agent.maxUsd > 0 && c.run.llm.usd >= c.agent.maxUsd) this.halt(c.run.id, `ha gastado su presupuesto de ${c.agent.maxUsd} US$`);
    return { available: true, ok, yes, verdicts, usd };
  }
  private councilText(cn: Council) {
    return cn.verdicts.map((v) => `[${v.role}] ${v.error ? "sin respuesta" : v.approve ? "a favor" : "en contra"}: ${v.summary}` + v.findings.map((f) => `\n  - (${f.severity}) ${f.file}: ${f.issue}`).join("")).join("\n");
  }

  // ------------------------------------------------------------------------------------------------ shared memory
  private memFile(folder: string) { return path.join(this.o.dataDir, "memoria", sha(folder).slice(0, 16) + ".json"); }
  private memRead(folder: string): { key: string; text: string; agent: string; at: string }[] { try { const v = JSON.parse(fs.readFileSync(this.memFile(folder), "utf8")); return Array.isArray(v) ? v : []; } catch { return []; } }
  private memSearch(folder: string, q: string, limit = 8) {
    const all = this.memRead(folder);
    const words = norm(q).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3);
    const scored = all.map((m, i) => ({ m, i, s: words.length ? words.filter((w) => norm(m.key + " " + m.text).includes(w)).length : 1 }));
    return scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.i - a.i).slice(0, limit).map((x) => x.m);
  }

  // ------------------------------------------------------------------------------------------------ the tools
  private defineTools(): Tool[] {
    const h = this.o.home;
    return [
      { name: "fs_list", title: "Listar carpeta", needs: ["fs.read", "fs.write"], inputSchema: obj({ path: str("Folder (absolute, ~/…, or relative to the project). Default: the project folder.") }),
        description: "List a folder the agent may read: name, type and size of each entry.",
        run: async (c, a) => {
          const p = this.within(c.agent, a.path, "read");
          const fd = this.openChecked(c.agent, p, "read", fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
          let ents: fs.Dirent[];
          try { ents = fs.readdirSync(fs.existsSync(`/proc/self/fd/${fd}`) ? `/proc/self/fd/${fd}` : p, { withFileTypes: true }); } finally { fs.closeSync(fd); }
          ents = ents.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
          const rows = ents.slice(0, AGENT_LIMITS.listEntries).map((e) => {
            if (e.isDirectory()) return `${e.name}/`;
            if (e.isSymbolicLink()) return `${e.name} (enlace)`;
            let size = ""; try { size = ` (${fs.lstatSync(path.join(p, e.name)).size} B)`; } catch { /* gone */ }
            return e.name + size;
          });
          this.log(c.run, "fs_list", tilde(p, h), "ok");
          return { text: `${tilde(p, h)}:\n${rows.join("\n")}${ents.length > rows.length ? `\n… y ${ents.length - rows.length} más` : ""}` };
        } },
      { name: "fs_read_file", title: "Leer archivo", needs: ["fs.read", "fs.write"], inputSchema: obj({ path: str("File to read."), offset: num("First line (1-based)."), limit: num("Number of lines.") }, ["path"]),
        description: "Read a text file the agent may read. NEXUS checks the path against the agent's fs:// capabilities; keys and .env files are never readable.",
        run: async (c, a) => {
          const p = this.within(c.agent, a.path, "read");
          const buf = this.readChecked(c.agent, p, 8_000_000);
          if (buf.length >= 8_000_000) throw new Error(`${tilde(p, h)} es demasiado grande`);
          if (buf.subarray(0, 8000).includes(0)) return { text: `${tilde(p, h)} is a binary file (${buf.length} bytes).` };
          let lines = buf.toString("utf8").split("\n");
          const from = Math.max(1, Number(a.offset) || 1), n = Math.max(1, Number(a.limit) || lines.length);
          lines = lines.slice(from - 1, from - 1 + n);
          this.log(c.run, "fs_read_file", tilde(p, h), "ok");
          return { text: lines.join("\n") };
        } },
      { name: "fs_write_file", title: "Escribir archivo", needs: ["fs.write"], inputSchema: obj({ path: str("File to write."), content: str("The whole new content.") }, ["path", "content"]),
        description: "Write (create or replace) a text file inside a folder the agent may write. NEXUS keeps the previous version so the person can undo it, and runs the project's checks afterwards.",
        run: async (c, a) => {
          const p = this.within(c.agent, a.path, "write");
          const content = String(a.content ?? "");
          const before = this.writeChecked(c, p, content);
          this.log(c.run, "fs_write_file", `${tilde(p, h)}${before ? " (la versión anterior está guardada)" : ""}`, "ok");
          return { text: `Wrote ${Buffer.byteLength(content)} bytes to ${p}.${before ? " The previous version is kept by NEXUS." : ""}` };
        } },
      { name: "fs_edit_file", title: "Editar archivo", needs: ["fs.write"],
        inputSchema: obj({ path: str("File to edit."), old_string: str("Exact text to replace (with enough context to be unique)."), new_string: str("Replacement text."), replace_all: { type: "boolean", description: "Replace every occurrence instead of exactly one." } }, ["path", "old_string", "new_string"]),
        description: "Replace an exact piece of text in a file the agent may write (must match exactly once unless replace_all). NEXUS keeps the previous version and runs the project's checks afterwards.",
        run: async (c, a) => {
          const p = this.within(c.agent, a.path, "write");
          const from = String(a.old_string ?? ""), to = String(a.new_string ?? "");
          if (!from) throw new Error("old_string está vacío");
          if (from === to) throw new Error("old_string y new_string son iguales");
          const buf = this.readChecked(c.agent, p, AGENT_LIMITS.writeBytes + 1);
          if (buf.subarray(0, 8000).includes(0)) throw new Error(`${tilde(p, h)} es un archivo binario`);
          const text = buf.toString("utf8");
          const n = text.split(from).length - 1;
          if (n === 0) throw new Error(`old_string no aparece en ${tilde(p, h)} (tiene que coincidir exactamente, espacios incluidos)`);
          if (n > 1 && a.replace_all !== true) throw new Error(`old_string aparece ${n} veces en ${tilde(p, h)}: añade contexto para que sea único, o usa replace_all`);
          const next = a.replace_all === true ? text.split(from).join(to) : text.replace(from, () => to);
          this.writeChecked(c, p, next);
          this.log(c.run, "fs_edit_file", `${tilde(p, h)} (${n} cambio${n === 1 ? "" : "s"}; la versión anterior está guardada)`, "ok");
          return { text: `Edited ${p}: ${n} replacement${n === 1 ? "" : "s"}. The previous version is kept by NEXUS.` };
        } },
      { name: "fs_search", title: "Buscar en archivos", needs: ["fs.read", "fs.write"], inputSchema: obj({ query: str("Text or regular expression."), path: str("Folder to search. Default: the project.") }, ["query"]),
        description: "Search file contents with ripgrep inside a folder the agent may read (respects .gitignore).",
        run: async (c, a) => {
          const p = this.within(c.agent, a.path, "read");
          const q = String(a.query ?? ""); if (!q || q.length > 300) throw new Error("la búsqueda tiene que tener entre 1 y 300 caracteres");
          const root = this.rootOf(c.agent, p, ["fs.read", "fs.write"]);
          const quote = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
          const r = await this.exec(`rg --no-config -n -S --max-count 5 --max-columns 200 --glob '!.env*' -- ${quote(q)} ${quote(p)}`, root, 30_000, root);
          this.log(c.run, "fs_search", `«${q.slice(0, 60)}» en ${tilde(p, h)}`, "ok");
          return { text: clip(r.output.split(p + "/").join("") || "No matches.", 20_000) };
        } },
      { name: "run_command", title: "Ejecutar comando", needs: ["exec"], inputSchema: obj({ command: str("Shell command line."), cwd: str("Working folder (must be granted by an exec:// capability). Default: the project.") }, ["command"]),
        description: "Run a shell command in a NEXUS sandbox (only the working folder is writable; your git identity is available; the person's SSH keys only for a command they approved). Every command is risk-classified first: dangerous ones are refused, critical ones (git push, git commit, rm -r, DROP TABLE, deploys…) wait for the review committee and/or the person. Installed tools: see installed_tools.",
        run: async (c, a) => {
          const cmd = String(a.command ?? "");
          const cwd = this.within(c.agent, a.cwd, "exec");
          const risk = classifyCommand(cmd);
          if (risk.level === "block") { this.log(c.run, "run_command", `Bloqueado: ${cmd.slice(0, 120)} — ${risk.reason}`, "denied", "block"); return { text: `NEXUS refused this command («${risk.reasonEn}»). Do not try to get around it.`, isError: true }; }
          let approved = false;   // the person clicked "approve" on this very command: only then are their keys reachable
          if (risk.level === "ask") {
            const what = risk.rule === "git-commit" ? "commit" : risk.rule?.startsWith("git-push") ? "push" : null;
            let cn: Council | undefined;
            if (what && c.agent.council) {
              cn = await this.council(c, cwd, what);
              if (c.run.status === "halted") return { text: "NEXUS has halted this agent: its dollar budget is spent.", isError: true };
              if (cn.available && !cn.ok) return { text: `The review committee did not approve this ${what}. Fix the findings and try again:\n${this.councilText(cn)}`, isError: true };
            }
            const auto = what === "commit" && cn?.available && cn.ok; // a local commit approved by the committee runs without asking
            if (!auto) {
              const en = this.o.lang === "en", why = en ? risk.reasonEn : risk.reason;
              // what this repository would run on its own during a git command (the agent may have written it)
              const gr = /\bgit\b/.test(cmd) ? this.gitRisks(cwd, this.rootOf(c.agent, cwd, ["exec"])) : { off: [], warn: [] };
              const gitNote = (gr.warn.length ? (en ? ` WARNING: this repository's git configuration runs or redirects on its own and NEXUS cannot switch it off: ${gr.warn.slice(0, 6).join(", ")}. Approve only if you set that up.`
                                                   : ` ATENCIÓN: la configuración de git de este repositorio ejecuta o redirige por su cuenta y NEXUS no puede desactivarlo: ${gr.warn.slice(0, 6).join(", ")}. Aprueba solo si lo pusiste tú.`) : "")
                + (gr.off.length ? (en ? ` Switched off for this command: ${gr.off.slice(0, 6).join(", ")}.` : ` Desactivado para este comando: ${gr.off.slice(0, 6).join(", ")}.`) : "");
              const yes = await this.ask(c, cmd.slice(0, 160), `${why[0].toUpperCase()}${why.slice(1)}. ${en ? "Folder" : "Carpeta"}: ${tilde(cwd, h)}.${gitNote}`, gr.warn.length ? "git-config" : risk.rule ?? "ask", cn?.available ? cn : undefined);
              if (!yes) return { text: "The person did not approve this command. Do not retry it; ask them or choose another way.", isError: true };
              approved = true;
            }
          }
          const r = await this.exec(cmd, cwd, AGENT_LIMITS.commandMs, this.rootOf(c.agent, cwd, ["exec"]), approved);
          const ok = r.code === 0 && !r.killed;
          this.log(c.run, "run_command", `${cmd.slice(0, 120)} → ${r.killed ? "cortado (5 min)" : `código ${r.code}`} · ${(r.ms / 1000).toFixed(1)} s`, ok ? "ok" : "error", risk.level);
          return { text: `exit ${r.killed ? "killed after 5 min" : r.code} · ${r.ms} ms\n${r.output}`, isError: !ok };
        } },
      { name: "check_project", title: "Comprobar proyecto", needs: ["exec", "fs.write"], inputSchema: obj({}),
        description: "Run the project's checks (tests and linter) now, in the sandbox, and return the result.",
        run: async (c) => {
          const h2 = await this.runCheck(c.run, c.agent);
          if (!h2) return { text: "This project has no tests or linter NEXUS can find (package.json scripts, pytest, cargo, go, make test)." };
          h2.reported = true; c.run.wasFailing = !h2.ok;
          return { text: `\`${h2.command}\` ${h2.ok ? "passes" : "FAILS"} (${h2.ms} ms)\n${h2.output}`, isError: !h2.ok };
        } },
      { name: "project_context", title: "Contexto del proyecto", needs: ["fs.read", "fs.write"], inputSchema: obj({}),
        description: "Only what matters now in the project: branch, uncommitted changes, recent commits, scripts, README start, the last check result, the last failing automation and the shared memory.",
        run: async (c) => {
          const f = c.agent.folder; const parts: string[] = [];
          const g = await this.exec("git rev-parse --abbrev-ref HEAD 2>/dev/null && echo && git status --short 2>/dev/null | head -30 && echo '--- últimos commits' && git log --oneline -n 8 2>/dev/null && echo '--- cambios' && git diff --stat HEAD 2>/dev/null | tail -15", f, 20_000);
          parts.push(`## git\n${g.output.trim() || "(no es un repositorio git)"}`);
          const small = (name: string) => this.readChecked(c.agent, path.join(f, name), 64_000).toString("utf8");
          try { const pj = JSON.parse(small("package.json")); parts.push(`## package.json\n${pj.name ?? ""} ${pj.version ?? ""}\nscripts: ${JSON.stringify(pj.scripts ?? {})}`); } catch { /* none, or not a plain file */ }
          for (const r of ["README.md", "README"]) { try { parts.push(`## ${r}\n${small(r).split("\n").slice(0, 30).join("\n")}`); break; } catch { /* none, or not a plain file */ } }
          const hl = c.run.health; if (hl) parts.push(`## última comprobación\n\`${hl.command}\` ${hl.ok ? "pasa" : "FALLA"}\n${hl.ok ? "" : hl.output.slice(-1500)}`);
          const lf = this.o.lastFailure?.(f); if (lf) parts.push(`## automatización que falló: ${lf.name} (${lf.at})\n${lf.output.slice(-1500)}`);
          if (this.can(c.agent, "memory")) { const mem = this.memRead(f).slice(-8); if (mem.length) parts.push(`## memoria del proyecto\n${mem.map((m) => `- ${m.key}: ${m.text.slice(0, 300)}`).join("\n")}`); }
          this.log(c.run, "project_context", tilde(f, h), "ok");
          return { text: clip(parts.join("\n\n"), AGENT_LIMITS.contextChars) };
        } },
      { name: "memory_save", title: "Guardar en memoria", needs: ["memory"], inputSchema: obj({ key: str("Short topic, e.g. 'api auth' or 'how to run e2e'."), text: str("What to remember (max 4000 characters).") }, ["key", "text"]),
        description: "Save a fact in the project's shared memory, for this and other agents working on the same folder. Same key replaces.",
        run: async (c, a) => {
          const key = String(a.key ?? "").replace(/\s+/g, " ").trim().slice(0, 80), text = String(a.text ?? "").trim().slice(0, AGENT_LIMITS.memoryChars);
          if (!key || !text) throw new Error("falta el tema o el texto");
          const f = c.agent.folder, all = this.memRead(f).filter((m) => m.key !== key);
          all.push({ key, text, agent: c.agent.id, at: new Date().toISOString() });
          this.write(this.memFile(f), all.slice(-AGENT_LIMITS.memoryEntries));
          this.log(c.run, "memory_save", key, "ok");
          return { text: `Saved "${key}".` };
        } },
      { name: "memory_search", title: "Buscar en memoria", needs: ["memory"], inputSchema: obj({ query: str("Words to look for. Empty: the latest entries.") }),
        description: "Search the project's shared memory (what this and other agents saved).",
        run: async (c, a) => {
          const r = this.memSearch(c.agent.folder, String(a.query ?? ""));
          this.log(c.run, "memory_search", String(a.query ?? "").slice(0, 60) || "(lo último)", "ok");
          return { text: r.length ? r.map((m) => `## ${m.key} (${m.agent}, ${m.at.slice(0, 10)})\n${m.text}`).join("\n\n") : "Nothing saved about that yet." };
        } },
      { name: "system_status", title: "Estado del sistema", needs: ["system"], inputSchema: obj({}),
        description: "CPU, memory, disk and the local servers running on this computer (localhost ports).",
        run: async (c) => {
          let disk = ""; try { const s = fs.statfsSync(h); disk = `${((s.bavail * s.bsize) / 1e9).toFixed(1)} GB libres de ${((s.blocks * s.bsize) / 1e9).toFixed(1)} GB`; } catch { /* n/a */ }
          const servers = localServers().map((s) => `:${s.port} ${s.process}${s.folder ? ` (${s.folder})` : ""}`);
          this.log(c.run, "system_status", "", "ok");
          return { text: [`CPU: ${os.cpus().length} núcleos, carga ${os.loadavg().map((x) => x.toFixed(2)).join(" ")}`, `Memoria: ${(os.freemem() / 1e9).toFixed(1)} GB libres de ${(os.totalmem() / 1e9).toFixed(1)} GB`, `Disco: ${disk}`, `Encendido desde hace ${Math.round(os.uptime() / 60)} min`, `Servidores locales: ${servers.join(", ") || "ninguno"}`].join("\n") };
        } },
      { name: "installed_tools", title: "Herramientas instaladas", needs: ["system", "exec"], inputSchema: obj({}),
        description: "The registry of command-line tools installed on this computer (rescanned when something new is installed), usable through run_command.",
        run: async (c) => {
          const list = this.toolRegistry();
          this.log(c.run, "installed_tools", `${list.length} herramientas`, "ok");
          return { text: list.map((t) => `${t.name} — ${t.description}${t.mine ? " (instalada por la persona)" : ""}`).join("\n") };
        } },
      { name: "logs_read", title: "Leer registros", needs: ["logs"], inputSchema: obj({ unit: str("Optional systemd user unit."), lines: num("How many lines (max 300)."), errors_only: { type: "boolean", description: "Only errors." } }),
        description: "Read the person's session logs (journalctl --user).",
        run: async (c, a) => {
          const args = ["--user", "--no-pager", "-q", "-o", "short-iso", "-n", String(Math.min(300, Math.max(1, Number(a.lines) || 80)))];
          if (a.unit) { const u = String(a.unit); if (!/^[\w@.-]{1,80}$/.test(u)) throw new Error("nombre de unidad no válido"); args.push("-u", u); }
          if (a.errors_only === true) args.push("-p", "err");
          const text = await new Promise<string>((res) => execFile("journalctl", args, { timeout: 15_000, maxBuffer: 4 << 20 }, (_e, so) => res(String(so ?? ""))));
          this.log(c.run, "logs_read", String(a.unit ?? "sesión"), "ok");
          return { text: clip(text || "No log lines.", 40_000) };
        } },
      { name: "automation_propose", title: "Proponer automatización", needs: ["automations"], inputSchema: obj({ name: str("Short name."), when: { type: "string", enum: ["files", "interval", "daily", "login"] }, minutes: num("For interval."), time: str("HH:MM for daily."), path: str("Folder to watch, for files."), command: str("Command to run."), cwd: str("Folder to run it in.") }, ["name", "when", "command"]),
        description: "Propose an automation (a rule that runs a command when files change, every N minutes, daily or at login). It opens as a draft in the Automatizaciones app; nothing exists until the person creates it.",
        run: async (c, a) => {
          if (!this.o.proposeAutomation) throw new Error("Automatizaciones no está disponible");
          const draft = { name: String(a.name ?? "").slice(0, 60), notify: "failure", trigger: { kind: String(a.when), minutes: Number(a.minutes) || undefined, time: a.time ? String(a.time) : undefined, path: a.path ? String(a.path) : undefined }, action: { kind: "command", command: String(a.command ?? ""), cwd: a.cwd ? String(a.cwd) : tilde(c.agent.folder, h) } };
          this.o.proposeAutomation(draft);
          this.log(c.run, "automation_propose", draft.name, "ok");
          return { text: "The draft is open in the Automatizaciones app. The person decides whether to create it." };
        } },
      { name: "notify", title: "Avisar a la persona", needs: ["notify"], inputSchema: obj({ text: str("Short message (max 200 characters).") }, ["text"]),
        description: "Show a short notice on the person's desktop.",
        run: async (c, a) => {
          const t = String(a.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200); if (!t) throw new Error("el aviso está vacío");
          this.o.notice(`${c.agent.name}: ${t}`, "info");
          this.log(c.run, "notify", t, "ok");
          return { text: "Shown." };
        } },
      { name: "council_review", title: "Revisión del comité", needs: ["exec"], inputSchema: obj({}),
        description: "Ask NEXUS's review committee (architecture, security, performance) to review the uncommitted changes now. Quorum: 2 of 3 in favour and no high-severity finding.",
        run: async (c) => {
          const cn = await this.council(c, c.agent.folder, "commit");
          if (!cn.available) return { text: "The committee is not available (NEXUS AI has no Claude key, or no connection).", isError: true };
          if (cn.empty) return { text: "There are no changes to review." };
          return { text: `${cn.ok ? "APPROVED" : "NOT APPROVED"} (${cn.yes} of 3 in favour)\n${this.councilText(cn)}`, isError: !cn.ok };
        } },
    ];
  }
  private toolRegistry() {
    const dirs = [path.join(this.o.home, ".local/bin"), "/usr/local/bin", "/usr/bin"];
    const key = dirs.map((d) => { try { return fs.statSync(d).mtimeMs; } catch { return 0; } }).join(",");
    if (this.toolsCache?.key !== key) this.toolsCache = { key, list: scanTools(this.o.home, dirs) };
    return this.toolsCache.list;
  }

  // ------------------------------------------------------------------------------------------------ token quota (LLM proxy)
  /** /llm/<token>/v1/… → api.anthropic.com, counting the tokens of each answer against the agent's budget. */
  async proxy(req: http.IncomingMessage, res: http.ServerResponse, p: string) {
    const m = /^\/llm\/([A-Za-z0-9_-]{20,64})(\/v1\/[A-Za-z0-9_/.-]+)$/.exec(p);
    const fail = (code: number, type: string, message: string) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type, message } })); };
    if (!m) return fail(404, "not_found_error", "not found");
    const run = this.runForToken(m[1]); const a = run && this.get(run.agent);
    if (!run || !a) return fail(401, "authentication_error", "NEXUS: this agent run is not active");
    const used = run.llm.input + run.llm.output;
    if (a.maxTokens > 0 && used >= a.maxTokens) {
      this.halt(run.id, `ha gastado su presupuesto de ${a.maxTokens.toLocaleString("es-ES")} tokens`);
      return fail(400, "invalid_request_error", `NEXUS: token budget spent (${used} of ${a.maxTokens}).`);
    }
    if (a.maxUsd > 0 && run.llm.usd >= a.maxUsd) {
      this.halt(run.id, `ha gastado su presupuesto de ${a.maxUsd} US$`);
      return fail(400, "invalid_request_error", `NEXUS: cost budget spent (${run.llm.usd.toFixed(4)} of ${a.maxUsd} USD).`);
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const ch of req) { size += (ch as Buffer).length; if (size > 32 << 20) return fail(413, "request_too_large", "too large"); chunks.push(ch as Buffer); }
    const headers: Record<string, string> = {};
    for (const h of ["x-api-key", "authorization", "anthropic-version", "anthropic-beta", "content-type", "accept", "user-agent", "x-app", "anthropic-dangerous-direct-browser-access"]) {
      const v = req.headers[h]; if (typeof v === "string") headers[h] = v;
    }
    const q = new URL(req.url ?? "/", "http://x").search;
    let model = ""; try { model = String(JSON.parse(Buffer.concat(chunks).toString("utf8"))?.model ?? ""); } catch { /* not JSON */ }
    // the placeholder key (or none) means "use the person's key": NEXUS adds it outside the agent's reach
    const placeholder = (v?: string) => !v || v.replace(/^Bearer\s+/i, "") === AGENT_KEY;
    const viaNexus = placeholder(headers["x-api-key"]) && placeholder(headers["authorization"]);
    let up: Response;
    try {
      const body = req.method === "GET" ? undefined : Buffer.concat(chunks);
      if (viaNexus) {
        if (!this.o.forward) return fail(401, "authentication_error", "NEXUS: this agent has no Claude key (set ANTHROPIC_API_KEY, or give NEXUS AI a key in Ajustes).");
        delete headers["x-api-key"]; delete headers["authorization"];
        up = await this.o.forward(`${m[2]}${q}`, { method: req.method ?? "POST", headers, body });
      } else up = await (this.o.fetchFn ?? fetch)(`https://api.anthropic.com${m[2]}${q}`, { method: req.method, headers, body });
    } catch { return fail(502, "api_error", "NEXUS could not reach api.anthropic.com"); }
    run.llm.requests++;
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    let tail = ""; const dec = new TextDecoder();
    // SSE: message_start carries the input usage, message_delta the cumulative usage of that message (max per field)
    const u: Usage = {};
    const keep = (k: keyof Usage, v: unknown) => { if (typeof v === "number" && v > ((u[k] as number) ?? 0)) (u as any)[k] = v; };
    const take = (text: string) => {
      for (const ev of text.split("\n")) {
        if (!ev.startsWith("data:") && !ev.startsWith("{")) continue;
        const raw = ev.startsWith("data:") ? ev.slice(5).trim() : ev;
        let j: any; try { j = JSON.parse(raw); } catch { continue; }
        const x = j?.type === "message_start" ? j.message?.usage : j?.usage;
        if (!x) continue;
        for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"] as const) keep(k, x[k]);
        if (x.cache_creation && typeof x.cache_creation === "object") u.cache_creation = { ...u.cache_creation, ...x.cache_creation };
        if (j?.type === "message_start" && j.message?.model) model = String(j.message.model);
      }
    };
    const msgIn = () => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const base = { input: run.llm.input, output: run.llm.output };
    if (up.body) {
      for await (const ch of up.body as any) {
        res.write(ch);
        tail += dec.decode(ch, { stream: true });
        const cut = tail.lastIndexOf("\n");
        if (cut >= 0) { take(tail.slice(0, cut)); tail = tail.slice(cut + 1); }
        run.llm.input = base.input + msgIn(); run.llm.output = base.output + (u.output_tokens ?? 0);
      }
    }
    take(tail + dec.decode());
    run.llm.input = base.input + msgIn(); run.llm.output = base.output + (u.output_tokens ?? 0);
    const usd = costUsd(model, u);
    if (usd === null) { if (msgIn() || u.output_tokens) run.llm.unpriced = true; } else run.llm.usd += usd;
    if (model) run.llm.model = model;
    res.end();
    this.changed();
  }

  // ------------------------------------------------------------------------------------------------ helpers
  private log(r: Run, tool: string, text: string, outcome: Activity["outcome"], risk?: string) {
    r.activity.push({ at: new Date().toISOString(), tool, text: text.slice(0, 300), outcome, ...(risk ? { risk } : {}) });
    if (r.activity.length > AGENT_LIMITS.activityKept) r.activity.splice(0, r.activity.length - AGENT_LIMITS.activityKept);
    this.changed();
  }
  private changed() {
    this.o.push("agents", {});
    if (!this.saveTimer) { this.saveTimer = setTimeout(() => { this.saveTimer = undefined; this.flush(); }, 1000); this.saveTimer.unref?.(); }
  }
  private flush() {
    try { this.write(this.runsFile, [...this.runs.values()].map((r) => ({ ...this.runView(r), tokenHash: "" }))); } catch { /* read-only disk */ }
  }
  private write(f: string, v: unknown) { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
}

function require_bwrap(): boolean {
  for (const d of ["/usr/bin", "/bin", "/usr/local/bin"]) if (fs.existsSync(path.join(d, "bwrap"))) return true;
  return false;
}
