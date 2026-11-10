// Automatizaciones: rules "when X happens, do Y" for the person's own work, run by nexus-sessiond.
//   when: every N minutes · every day at HH:MM (catches up once if the computer was off) · when files change in a
//         folder (debounced; .git, node_modules and build output ignored) · when the session starts
//   do:   run a command in a project folder · show a notice · open an app
// Commands run in a bubblewrap sandbox: the system is read-only, the home folder is hidden except the project folder
// (and read-only git/ssh settings so `git pull` works), and NEXUS's own sockets and tokens are out of reach.
// Without bubblewrap a command is refused, never run unconfined. Every rule is created by the person (NEXUS AI only
// fills in a draft the person reviews in the app).
// NEXUS Connect (core/src/connect.ts, in the Engine): "when something happens in a service" (Wiwink, GoHighLevel…)
// is checked every N minutes through the Engine, which holds the keys; each new thing (an invoice, a contact) runs the
// action once, with its data: {{cliente.email}} in a service action or a notice, $NEXUS_EVENTO (JSON) in a command.
// "do something in a service" goes through the Engine too; this process never sees a key.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { render, type ConnectorInfo, type ConnectEvent, type PollResult } from "./connect.ts";

export type Trigger =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "files"; path: string }
  | { kind: "login" }
  | { kind: "service"; connector: string; trigger: string; input: Record<string, string>; minutes: number };
export type Action =
  | { kind: "command"; command: string; cwd: string }
  | { kind: "notify"; text: string }
  | { kind: "open"; app: string }
  | { kind: "service"; connector: string; op: string; input: Record<string, string> };
/** How the automations reach NEXUS Connect (nexus-sessiond → the Engine). */
export type Services = {
  catalog: () => ConnectorInfo[] | null;   // null: the Engine has not answered yet
  run: (connector: string, op: string, input: Record<string, string>, event?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  poll: (connector: string, trigger: string, input: Record<string, string>, state: unknown) => Promise<PollResult>;
};
/** What a service rule last saw: `sig` is its trigger setup (a new setup starts again from a new baseline). */
type Watch = { sig: string; at: string; state: unknown; baseline?: number; error?: string; errorAt?: string; pending?: ConnectEvent[] };
export type Notify = "always" | "failure" | "never";
export type Automation = { id: string; name: string; enabled: boolean; trigger: Trigger; action: Action; notify: Notify; created: string };
export type Run = { id: string; automation: string; name: string; at: string; reason: string; ok: boolean; exitCode: number | null; ms: number; output: string; killed?: "timeout" | "stopped" };

export const LIMITS = { automations: 100, runsKept: 300, runsPerAutomation: 30, outputKept: 16_384, outputLive: 65_536, timeoutMs: 10 * 60_000,
  serviceMs: 150_000, eventsPerPoll: 50, toastsPerBatch: 3, errorQuietMs: 6 * 3600_000, eventEnv: 32_768 };
const IGNORED = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|dist|build|target|\.next|\.cache|\.idea)(\/|$)/;

/** "~/x" and relative paths are taken from the home folder; the result must be an existing folder inside it. */
export function homeFolder(p: unknown, home: string): string {
  let s = String(p ?? "").trim();
  if (!s) throw new Error("falta la carpeta");
  if (s === "~") s = home; else if (s.startsWith("~/")) s = path.join(home, s.slice(2)); else if (!path.isAbsolute(s)) s = path.join(home, s);
  let real: string;
  try { real = fs.realpathSync(s); } catch { throw new Error(`la carpeta ${s.replace(home, "~")} no existe`); }
  const h = fs.realpathSync(home);
  if (real !== h && !real.startsWith(h + path.sep)) throw new Error("la carpeta tiene que estar dentro de tu carpeta personal");
  if (!fs.statSync(real).isDirectory()) throw new Error(`${s.replace(home, "~")} no es una carpeta`);
  return real;
}

function connectorOf(catalog: ConnectorInfo[] | null | undefined, id: unknown): ConnectorInfo {
  if (!catalog) throw new Error("ahora mismo no puedo comprobar los servicios (el motor de NEXUS no responde); prueba en un momento");
  const c = catalog.find((x) => x.id === String(id ?? ""));
  if (!c) throw new Error("elige el servicio");
  if (!c.connected) throw new Error(`${c.name} no está conectado: conéctalo primero en la app Conexiones`);
  return c;
}
function serviceInput(params: { key: string; label: string; required?: boolean }[], src: unknown): Record<string, string> {
  const s = src && typeof src === "object" ? (src as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  for (const p of params) {
    const v = String(s[p.key] ?? "").replace(/\r\n?/g, "\n").trim();
    if (v.length > 2000) throw new Error(`«${p.label}» es demasiado largo`);
    if (v) out[p.key] = v; else if (p.required) throw new Error(`rellena «${p.label}»`);
  }
  return out;
}

/** Checks and normalises a rule coming from the app or from an AI draft. Errors are in Spanish for the person. */
export function validate(input: any, home: string, apps: string[], existing?: Automation, catalog?: ConnectorInfo[] | null): Automation {
  const name = String(input?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new Error("ponle un nombre");
  const t = input?.trigger ?? {};
  let trigger: Trigger;
  if (t.kind === "interval") {
    const m = Number(t.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 10_080) throw new Error("cada cuántos minutos: entre 1 y 10080 (una semana)");
    trigger = { kind: "interval", minutes: m };
  } else if (t.kind === "daily") {
    const time = String(t.time ?? "").trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("la hora tiene que ser HH:MM, por ejemplo 09:00");
    trigger = { kind: "daily", time };
  } else if (t.kind === "files") trigger = { kind: "files", path: homeFolder(t.path, home) };
  else if (t.kind === "login") trigger = { kind: "login" };
  else if (t.kind === "service") {
    const c = connectorOf(catalog, t.connector);
    const def = c.triggers.find((x) => x.id === String(t.trigger ?? ""));
    if (!def) throw new Error(`elige qué vigilar en ${c.name}`);
    const m = t.minutes === undefined || t.minutes === "" || Number(t.minutes) === 0 ? def.every : Number(t.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 1440) throw new Error("cada cuántos minutos se comprueba: entre 1 y 1440 (un día)");
    trigger = { kind: "service", connector: c.id, trigger: def.id, input: serviceInput(def.params, t.input), minutes: m };
  } else throw new Error("elige cuándo se ejecuta");
  const a = input?.action ?? {};
  let action: Action;
  if (a.kind === "command") {
    const command = String(a.command ?? "").trim();
    if (!command) throw new Error("escribe el comando");
    if (command.length > 2000) throw new Error("el comando es demasiado largo");
    action = { kind: "command", command, cwd: homeFolder(a.cwd || (trigger.kind === "files" ? trigger.path : ""), home) };
  } else if (a.kind === "notify") {
    const text = String(a.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) throw new Error("escribe el aviso");
    action = { kind: "notify", text };
  } else if (a.kind === "open") {
    const app = String(a.app ?? "");
    if (!apps.includes(app)) throw new Error("esa app no existe");
    action = { kind: "open", app };
  } else if (a.kind === "service") {
    const c = connectorOf(catalog, a.connector);
    const op = c.operations.find((x) => x.id === String(a.op ?? ""));
    if (!op) throw new Error(`elige qué hacer en ${c.name}`);
    action = { kind: "service", connector: c.id, op: op.id, input: serviceInput(op.params, a.input) };
  } else throw new Error("elige qué hace");
  const notify: Notify = input?.notify === "always" || input?.notify === "never" ? input.notify : "failure";
  return {
    id: existing?.id ?? randomBytes(6).toString("hex"), name, enabled: input?.enabled === false ? false : true,
    trigger, action, notify, created: existing?.created ?? new Date().toISOString(),
  };
}

const short = (p: string, home: string) => (p === home ? "~" : p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
/** Plain Spanish for the app and the notices. */
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export function describe(a: Automation, home: string, appNames: Record<string, string> = {}, catalog?: ConnectorInfo[] | null): { when: string; what: string } {
  const t = a.trigger;
  const conn = (id: string) => catalog?.find((c) => c.id === id);
  let when: string;
  if (t.kind === "service") {
    const c = conn(t.connector); const tr = c?.triggers.find((x) => x.id === t.trigger);
    const vals = Object.values(t.input).filter(Boolean);
    when = `${c?.name ?? t.connector}: ${lower(tr?.name ?? t.trigger)}${vals.length ? ` («${vals.join("», «")}»)` : ""}, lo mira cada ${t.minutes} min`;
  } else when = t.kind === "interval" ? (t.minutes === 1 ? "Cada minuto" : t.minutes % 60 === 0 ? (t.minutes === 60 ? "Cada hora" : `Cada ${t.minutes / 60} horas`) : `Cada ${t.minutes} minutos`)
    : t.kind === "daily" ? `Cada día a las ${t.time}`
    : t.kind === "files" ? `Cuando cambie algo en ${short(t.path, home)}` : "Al iniciar sesión";
  const x = a.action;
  let what: string;
  if (x.kind === "service") { const c = conn(x.connector); what = `${c?.name ?? x.connector}: ${lower(c?.operations.find((o) => o.id === x.op)?.name ?? x.op)}`; }
  else what = x.kind === "command" ? `Ejecuta «${x.command}» en ${short(x.cwd, home)}` : x.kind === "notify" ? `Te avisa: «${x.text}»` : `Abre ${appNames[x.app] ?? x.app}`;
  return { when, what };
}

/** When a time rule will run next (null for files/login/service rules: the class knows when a service is checked). */
export function nextRun(t: Trigger, since: Date, now: Date): Date | null {
  if (t.kind === "interval") { const n = new Date(since.getTime() + t.minutes * 60_000); return n < now ? now : n; }
  if (t.kind === "daily") {
    const [h, m] = t.time.split(":").map(Number);
    const today = new Date(now); today.setHours(h, m, 0, 0);
    if (since < today) return today < now ? now : today;
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1); return tomorrow;
  }
  return null;
}

/** Time rules. `since` is the last run, or when the rule was created / switched on. */
export function due(t: Trigger, since: Date, now: Date): boolean {
  if (t.kind === "interval") return now.getTime() - since.getTime() >= t.minutes * 60_000;
  if (t.kind === "daily") {
    const [h, m] = t.time.split(":").map(Number);
    const today = new Date(now); today.setHours(h, m, 0, 0);
    return now >= today && since < today; // also once later in the day if the computer was off at that time
  }
  return false;
}

/** `keys`: the person's SSH keys and npm token are visible (read-only). The person's own automations have them; an
 *  agent's command only when the person approved that very command (core/src/agentd.ts). */
export function sandboxArgv(command: string, cwd: string, home: string, runtimeDirs: string[], keys = true): string[] {
  const a = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
  for (const d of runtimeDirs) if (fs.existsSync(d)) a.push("--tmpfs", d); // session sockets, NEXUS tokens
  a.push("--tmpfs", home);
  for (const f of [".gitconfig", ".config/git", ...(keys ? [".ssh", ".npmrc"] : []), ".local/bin", ".local/lib"]) {
    const p = path.join(home, f); if (fs.existsSync(p)) a.push("--ro-bind", p, p);
  }
  for (const f of [".cache", ".npm", ".cargo", ".rustup"]) { const p = path.join(home, f); if (fs.existsSync(p)) a.push("--bind", p, p); }
  a.push("--bind", cwd, cwd, "--chdir", cwd, "--setenv", "HOME", home, "--unshare-pid", "--unshare-ipc", "--die-with-parent", "--new-session",
    "--", "/bin/sh", "-c", command);
  return a;
}

export type AutomationsOptions = {
  configDir: string; home: string; runtimeDir: string;
  apps: Record<string, string>;                         // id -> name, the app catalog
  notice: (text: string, kind: "info" | "warn") => void;  // a toast on the desktop
  changed: () => void;                                    // the app refreshes its list
  launch: (app: string) => void;
  hiddenDirs?: string[];                                  // extra folders hidden from commands (default /run/user, /run/nexus)
  services?: Services;                                    // NEXUS Connect through the Engine (absent: service rules cannot run)
  spawnFn?: (argv: string[], env: NodeJS.ProcessEnv) => ChildProcess; // tests
  hasSandbox?: () => boolean;
  now?: () => Date;
  tickMs?: number;
  debounceMs?: number;
};

export class Automations {
  private file: string; private runsFile: string; private loginMark: string; private stateFile: string;
  private list_: Automation[] = []; private runs: Run[] = [];
  private active = new Map<string, { child?: ChildProcess; run: Run; out: string; timer: NodeJS.Timeout; cancel?: (why: "timeout" | "stopped") => void }>();
  private watch: Record<string, Watch> = {};                  // service rules: what each one has seen
  private polling = new Set<string>();
  private queue = new Map<string, ConnectEvent[]>();          // new things found, run one after another
  private batch = new Map<string, { shown: number; hidden: number }>(); // a burst of events: a few notices, then one summary
  private stopped = false;
  private watchers = new Map<string, { w: fs.FSWatcher; timer?: NodeJS.Timeout; quietUntil: number }>();
  private enabledAt = new Map<string, number>();
  private tick?: NodeJS.Timeout;
  private now: () => Date;
  constructor(private o: AutomationsOptions) {
    this.file = path.join(o.configDir, "automations.json");
    this.runsFile = path.join(o.configDir, "automation-runs.json");
    this.stateFile = path.join(o.configDir, "automation-state.json");
    this.loginMark = path.join(o.runtimeDir, "automations-login-done");
    this.now = o.now ?? (() => new Date());
    this.list_ = this.read(this.file);
    this.runs = this.read(this.runsFile);
    try { const v = JSON.parse(fs.readFileSync(this.stateFile, "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) this.watch = v; } catch { /* first time */ }
    for (const [id, w] of Object.entries(this.watch)) if (Array.isArray(w?.pending) && w.pending.length) this.queue.set(id, w.pending);
  }
  private saveWatch() {
    const keep: Record<string, Watch> = {};
    for (const a of this.list_) { const w = this.watch[a.id]; if (w) { const q = this.queue.get(a.id); keep[a.id] = { ...w, pending: q?.length ? q : undefined }; } }
    this.watch = keep; this.write(this.stateFile, keep);
  }
  private sig(t: Trigger) { return t.kind === "service" ? JSON.stringify([t.connector, t.trigger, t.input]) : ""; }
  private catalog() { try { return this.o.services?.catalog() ?? null; } catch { return null; } }
  private read(f: string): any[] { try { const v = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(v) ? v : []; } catch { return []; } }
  private write(f: string, v: unknown) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); }
  private save() { this.write(this.file, this.list_); this.o.changed(); }
  private hasSandbox() {
    if (this.o.hasSandbox) return this.o.hasSandbox();
    return spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "true"], { timeout: 5000 }).status === 0;
  }

  // ---------------------------------------------------------------- state for the app
  view() {
    const catalog = this.catalog();
    return this.list_.map((a) => {
      const last = [...this.runs].reverse().find((r) => r.automation === a.id);
      const t = a.trigger;
      const w = t.kind === "service" && this.watch[a.id]?.sig === this.sig(t) ? this.watch[a.id] : undefined;
      const next = !a.enabled ? null : t.kind === "service" ? new Date(Math.max(this.now().getTime(), (w ? Date.parse(w.at) : 0) + t.minutes * 60_000)) : nextRun(t, this.lastStart(a), this.now());
      return { ...a, ...describe(a, this.o.home, this.o.apps, catalog), next: next ? next.toISOString() : null, running: this.active.has(a.id),
        last: last ? { at: last.at, ok: last.ok, ms: last.ms, killed: last.killed ?? null } : null,
        watch: t.kind === "service" ? { checking: this.polling.has(a.id), at: w?.at ?? null, baseline: w?.baseline ?? null, error: w?.error ?? null, queued: this.queue.get(a.id)?.length ?? 0 } : null };
    });
  }
  /** The latest run of a command automation working in `folder` (or inside it), when that run failed. */
  lastFailureIn(folder: string) {
    const ids = new Set(this.list_.filter((a) => a.action.kind === "command" && (a.action.cwd === folder || a.action.cwd.startsWith(folder + path.sep))).map((a) => a.id));
    const r = [...this.runs].reverse().find((x) => ids.has(x.automation));
    return r && !r.ok ? { name: r.name, at: r.at, output: r.output } : null;
  }
  history(id: string) { return this.runs.filter((r) => r.automation === id).slice(-LIMITS.runsPerAutomation).reverse(); }
  live(id: string) { const a = this.active.get(id); return a ? a.out : null; }

  save_(input: unknown) {
    const id = (input as any)?.id;
    const existing = id ? this.list_.find((a) => a.id === String(id)) : undefined;
    if (id && !existing) throw new Error("esa automatización ya no existe");
    if (!existing && this.list_.length >= LIMITS.automations) throw new Error("ya tienes demasiadas automatizaciones");
    const a = validate(input, this.o.home, Object.keys(this.o.apps), existing, this.catalog());
    if (a.action.kind === "command" && !this.hasSandbox()) throw new Error("este equipo no puede aislar comandos (falta bubblewrap): no se ejecutan sin aislar");
    this.list_ = existing ? this.list_.map((x) => (x.id === a.id ? a : x)) : [...this.list_, a];
    this.enabledAt.set(a.id, this.now().getTime());
    if (this.watch[a.id] && this.watch[a.id].sig !== this.sig(a.trigger)) { delete this.watch[a.id]; this.queue.delete(a.id); }
    this.save(); this.saveWatch(); this.arm(a);
    if (a.enabled && a.trigger.kind === "service" && !this.watch[a.id]) this.poll(a, false); // the baseline, right away
    return a;
  }
  remove(id: string) {
    const a = this.list_.find((x) => x.id === id); if (!a) throw new Error("esa automatización ya no existe");
    this.stopRun(id); this.disarm(id); this.queue.delete(id);
    this.list_ = this.list_.filter((x) => x.id !== id);
    this.save(); this.saveWatch();
    return { ok: true };
  }
  setEnabled(id: string, on: boolean) {
    const a = this.list_.find((x) => x.id === id); if (!a) throw new Error("esa automatización ya no existe");
    a.enabled = on; if (on) this.enabledAt.set(id, this.now().getTime());
    if (a.trigger.kind === "service") { delete this.watch[id]; this.queue.delete(id); } // back on: from now, nothing that happened while off
    this.save(); this.saveWatch(); if (on) this.arm(a); else this.disarm(id);
    if (on && a.trigger.kind === "service") this.poll(a, false);
    return a;
  }

  // ---------------------------------------------------------------- running
  /** "Ejecutar ahora". For a rule that watches a service it means "check the service now". */
  runNow(id: string, reason = "a mano") {
    const a = this.list_.find((x) => x.id === id); if (!a) throw new Error("esa automatización ya no existe");
    if (a.trigger.kind === "service" && reason === "a mano") return this.poll(a, true);
    return this.execute(a, reason);
  }
  private execute(a: Automation, reason: string, ev?: ConnectEvent): { started: boolean; run?: string; reason?: string } {
    if (this.active.has(a.id)) return { started: false, reason: "ya se está ejecutando" };
    const run: Run = { id: randomBytes(6).toString("hex"), automation: a.id, name: a.name, at: this.now().toISOString(), reason, ok: false, exitCode: null, ms: 0, output: "" };
    const t0 = Date.now();
    const x = a.action;
    if (x.kind === "notify" || x.kind === "open") {
      if (x.kind === "open") this.o.launch(x.app);
      run.ok = true; run.exitCode = 0;
      if (x.kind === "notify") { const text = ev ? render(x.text, ev.data).replace(/\s+/g, " ").trim().slice(0, 200) || x.text : x.text; run.output = text; this.toast(a.id, text, "info"); }
      else if (a.notify === "always") this.toast(a.id, `${a.name}: hecho`, "info");
      this.finish(a, run, Date.now() - t0);
      return { started: true, run: run.id };
    }
    if (x.kind === "service") return this.startService(a, x, run, t0, ev);
    if (!this.hasSandbox()) {
      run.output = "No se ha ejecutado: este equipo no puede aislar comandos (falta bubblewrap).";
      this.finish(a, run, 0); this.o.notice(`${a.name}: no se puede ejecutar sin aislamiento`, "warn");
      return { started: false, reason: "sin aislamiento" };
    }
    try { homeFolder(x.cwd, this.o.home); } catch (e) {
      run.output = `No se ha ejecutado: ${(e as Error).message}.`; this.finish(a, run, 0);
      if (a.notify !== "never") this.o.notice(`${a.name}: ${(e as Error).message}`, "warn");
      return { started: false, reason: (e as Error).message };
    }
    const argv = sandboxArgv(x.command, x.cwd, this.o.home, this.o.hiddenDirs ?? ["/run/user", "/run/nexus"]);
    const env = cleanEnv(this.o.home, ev);
    const child = (this.o.spawnFn ?? ((v: string[], e: NodeJS.ProcessEnv) => spawn(v[0], v.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: e, detached: true })))(argv, env);
    const entry = { child, run, out: "", timer: setTimeout(() => { entry.run.killed = "timeout"; this.kill(child); }, LIMITS.timeoutMs) };
    entry.timer.unref?.();
    this.active.set(a.id, entry);
    const add = (b: Buffer) => { entry.out += b.toString("utf8"); if (entry.out.length > LIMITS.outputLive) entry.out = entry.out.slice(-LIMITS.outputLive); };
    child.stdout?.on("data", add); child.stderr?.on("data", add);
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return; ended = true;
      clearTimeout(entry.timer); this.active.delete(a.id);
      run.exitCode = code; run.ok = code === 0 && !run.killed; run.output = entry.out.slice(-LIMITS.outputKept);
      this.finish(a, run, Date.now() - t0);
      const w = this.watchers.get(a.id); if (w) w.quietUntil = Date.now() + 3000; // its own writes do not trigger it again
      if (a.notify === "always" || (a.notify === "failure" && !run.ok)) {
        const why = run.killed === "timeout" ? "se ha cortado a los 10 minutos" : run.killed === "stopped" ? "detenida" : run.ok ? "ha ido bien" : `ha fallado (código ${code ?? "?"})`;
        this.toast(a.id, `${a.name}: ${why}`, run.ok ? "info" : "warn");
      }
    };
    child.on("exit", (code) => end(code)); child.on("error", () => end(null));
    this.o.changed();
    return { started: true, run: run.id };
  }
  /** "Do something in a service": one request through the Engine, which holds the key and keeps the audit. */
  private startService(a: Automation, x: Extract<Action, { kind: "service" }>, run: Run, t0: number, ev?: ConnectEvent) {
    let ended = false;
    const end = (ok: boolean, out: string) => {
      if (ended) return; ended = true;
      clearTimeout(entry.timer); this.active.delete(a.id);
      run.ok = ok; run.exitCode = ok ? 0 : 1; run.output = out.slice(-LIMITS.outputKept);
      this.finish(a, run, Date.now() - t0);
      if (a.notify === "always" || (a.notify === "failure" && !ok)) this.toast(a.id, `${a.name}: ${ok ? "hecho" : run.killed === "stopped" ? "detenida" : "no se ha hecho"}${ok || run.killed ? "" : ` (${firstLine(out)})`}`, ok ? "info" : "warn");
    };
    const entry: { run: Run; out: string; timer: NodeJS.Timeout; cancel: (why: "timeout" | "stopped") => void } = {
      run, out: "", timer: setTimeout(() => entry.cancel("timeout"), LIMITS.serviceMs),
      cancel: (why) => { run.killed = why; end(false, why === "timeout"
        ? "Cortada: el servicio no ha contestado a tiempo. Puede que la petición sí llegara: míralo en el servicio antes de repetirla."
        : "Detenida. Si la petición ya había salido, puede que el servicio la haya hecho igualmente."); },
    };
    entry.timer.unref?.();
    this.active.set(a.id, entry);
    this.o.changed();
    const svc = this.o.services;
    if (!svc) end(false, "NEXUS Connect no está disponible en esta sesión.");
    else svc.run(x.connector, x.op, x.input, ev?.data).then((r) => end(true, plain(r?.output ?? r)), (e) => end(false, `No se ha hecho: ${(e as Error).message}`));
    return { started: true, run: run.id };
  }
  private kill(child: ChildProcess) { try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } try { child.kill("SIGTERM"); } catch { /* gone */ } }
  stopRun(id: string) {
    const dropped = this.queue.get(id)?.length ?? 0;
    if (dropped) { this.queue.delete(id); this.batch.delete(id); this.saveWatch(); }
    const e = this.active.get(id);
    if (e) { if (e.cancel) e.cancel("stopped"); else if (e.child) { e.run.killed = "stopped"; this.kill(e.child); } }
    const a = this.list_.find((x) => x.id === id);
    if (dropped && a) this.o.notice(`${a.name}: detenida; ${dropped === 1 ? "se descarta 1 cosa pendiente" : `se descartan ${dropped} cosas pendientes`}`, "warn");
    return { ok: !!e || dropped > 0 };
  }
  private finish(a: Automation, run: Run, ms: number) {
    run.ms = ms;
    this.runs.push(run);
    const mine = this.runs.filter((r) => r.automation === a.id);
    if (mine.length > LIMITS.runsPerAutomation) { const drop = new Set(mine.slice(0, mine.length - LIMITS.runsPerAutomation).map((r) => r.id)); this.runs = this.runs.filter((r) => !drop.has(r.id)); }
    if (this.runs.length > LIMITS.runsKept) this.runs = this.runs.slice(-LIMITS.runsKept);
    this.write(this.runsFile, this.runs); this.o.changed();
    if (this.queue.has(a.id)) setImmediate(() => this.drain(a.id));
  }
  /** Several notices from one burst of events: the first few, then one "and N more". */
  private toast(id: string, text: string, kind: "info" | "warn") {
    const b = this.batch.get(id);
    if (!b || b.shown < LIMITS.toastsPerBatch) { if (b) b.shown++; this.o.notice(text, kind); } else b.hidden++;
  }
  /** The next thing found in the service, once the previous run has finished. */
  private drain(id: string) {
    if (this.stopped || this.active.has(id)) return;
    const a = this.list_.find((x) => x.id === id);
    const q = this.queue.get(id);
    if (!a || !a.enabled || !q?.length) {
      this.queue.delete(id); this.saveWatch();
      const b = this.batch.get(id); this.batch.delete(id);
      if (a && b?.hidden) this.o.notice(`${a.name}: y ${b.hidden} más (los tienes en Automatizaciones)`, "info");
      return;
    }
    const ev = q.shift()!;
    this.saveWatch();
    this.execute(a, ev.label || "algo nuevo", ev);
  }

  // ---------------------------------------------------------------- triggers
  private lastStart(a: Automation): Date {
    const last = [...this.runs].reverse().find((r) => r.automation === a.id && r.reason !== "a mano");
    const t = Math.max(last ? Date.parse(last.at) : 0, Date.parse(a.created) || 0, this.enabledAt.get(a.id) ?? 0);
    return new Date(t);
  }
  check() {
    const now = this.now();
    for (const a of this.list_) {
      if (!a.enabled || this.active.has(a.id)) continue;
      const t = a.trigger;
      if (t.kind === "service") {
        const w = this.watch[a.id];
        const at = w && w.sig === this.sig(t) ? Date.parse(w.at) || 0 : 0;
        if (now.getTime() - at >= t.minutes * 60_000) this.poll(a, false);
      } else if (due(t, this.lastStart(a), now)) this.runNow(a.id, t.kind === "daily" ? "a su hora" : "programada");
    }
  }
  /** Ask the Engine what is new in the service. The first time nothing runs: it only notes what already exists. */
  private poll(a: Automation, manual: boolean): { started: boolean; checking?: boolean; reason?: string } {
    const t = a.trigger;
    if (t.kind !== "service") return { started: false, reason: "no vigila ningún servicio" };
    if (this.polling.has(a.id)) return { started: false, reason: "ya lo está comprobando" };
    if (this.active.has(a.id) || this.queue.get(a.id)?.length) return { started: false, reason: "todavía está con lo último que encontró" };
    const svc = this.o.services;
    if (!svc) return { started: false, reason: "NEXUS Connect no está disponible en esta sesión" };
    const sig = this.sig(t);
    const prev = this.watch[a.id]?.sig === sig ? this.watch[a.id] : undefined;
    this.polling.add(a.id); this.o.changed();
    const current = () => { const c = this.list_.find((x) => x.id === a.id); return c && c.enabled && this.sig(c.trigger) === sig ? c : null; };
    svc.poll(t.connector, t.trigger, t.input, prev?.state).then((r) => {
      this.polling.delete(a.id);
      const c = current();
      if (this.stopped || !c) return this.o.changed(); // edited, switched off or removed meanwhile: a new baseline will be taken
      const baseline = r.baseline ?? prev?.baseline;
      this.watch[a.id] = { sig, at: this.now().toISOString(), state: r.state, ...(baseline !== undefined ? { baseline } : {}) };
      const events = (Array.isArray(r.events) ? r.events : []).slice(0, LIMITS.eventsPerPoll);
      if (events.length) { this.queue.set(a.id, [...(this.queue.get(a.id) ?? []), ...events]); if (!this.batch.has(a.id)) this.batch.set(a.id, { shown: 0, hidden: 0 }); }
      this.saveWatch();
      if (r.baseline !== undefined) { if (manual || !prev) this.o.notice(`${c.name}: vigilando. ${r.baseline === 1 ? "Ya había 1" : `Ya había ${r.baseline}`}; solo actuará con lo nuevo`, "info"); }
      else if (manual && !events.length) this.o.notice(`${c.name}: nada nuevo`, "info");
      if (events.length) this.drain(a.id);
      this.o.changed();
    }, (e) => {
      this.polling.delete(a.id);
      const c = current();
      if (this.stopped || !c) return this.o.changed();
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      const nowMs = this.now().getTime();
      const loud = manual || !prev?.errorAt || prev.error !== msg || nowMs - Date.parse(prev.errorAt) >= LIMITS.errorQuietMs;
      this.watch[a.id] = { sig, at: this.now().toISOString(), state: prev?.state, ...(prev?.baseline !== undefined ? { baseline: prev.baseline } : {}),
        error: msg, errorAt: loud ? this.now().toISOString() : prev?.errorAt };
      this.saveWatch();
      if (loud) { // the same problem is written down and announced at most every 6 hours
        this.finish(c, { id: randomBytes(6).toString("hex"), automation: c.id, name: c.name, at: this.now().toISOString(), reason: "comprobar el servicio",
          ok: false, exitCode: null, ms: 0, output: `No se ha podido comprobar: ${msg}` }, 0);
        if (manual || c.notify !== "never") this.o.notice(`${c.name}: no se ha podido comprobar (${msg})`, "warn");
      }
      this.o.changed();
    });
    return { started: true, checking: true };
  }
  private arm(a: Automation) {
    this.disarm(a.id);
    if (!a.enabled || a.trigger.kind !== "files") return;
    const dir = a.trigger.path;
    try {
      const entry: { w: fs.FSWatcher; timer?: NodeJS.Timeout; quietUntil: number } = { w: undefined as unknown as fs.FSWatcher, quietUntil: 0 };
      entry.w = fs.watch(dir, { recursive: true }, (_ev, file) => {
        if (file && IGNORED.test(String(file))) return;
        if (Date.now() < entry.quietUntil || this.active.has(a.id)) return;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.runNow(a.id, `cambio en ${file ?? "la carpeta"}`), this.o.debounceMs ?? 1500);
      });
      entry.w.on("error", () => this.disarm(a.id));
      this.watchers.set(a.id, entry);
    } catch { /* folder gone: shown when it runs */ }
  }
  private disarm(id: string) { const w = this.watchers.get(id); if (w) { clearTimeout(w.timer); try { w.w.close(); } catch { /* closed */ } this.watchers.delete(id); } }

  start() {
    for (const a of this.list_) this.arm(a);
    if (!fs.existsSync(this.loginMark)) { // once per session, not on every restart of nexus-sessiond
      try { fs.mkdirSync(path.dirname(this.loginMark), { recursive: true }); fs.writeFileSync(this.loginMark, ""); } catch { /* runtime dir */ }
      for (const a of this.list_) if (a.enabled && a.trigger.kind === "login") this.runNow(a.id, "al iniciar sesión");
    }
    for (const id of [...this.queue.keys()]) this.drain(id); // things found before a restart and not run yet
    this.check();
    this.tick = setInterval(() => this.check(), this.o.tickMs ?? 30_000); this.tick.unref?.();
  }
  stop() {
    this.stopped = true; clearInterval(this.tick);
    for (const id of [...this.watchers.keys()]) this.disarm(id);
    for (const e of [...this.active.values()]) { if (e.cancel) e.cancel("stopped"); else if (e.child) { e.run.killed = "stopped"; this.kill(e.child); } }
  }
}

const firstLine = (s: string) => s.replace(/^No se ha hecho: /, "").split("\n")[0].slice(0, 160);
/** A service answer as short "clave: valor" lines for the history. */
function plain(v: unknown): string {
  if (!v || typeof v !== "object") return String(v ?? "hecho");
  const lines = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k.replace(/_/g, " ")}: ${x !== null && typeof x === "object" ? JSON.stringify(x) : String(x)}`);
  return lines.length ? lines.join("\n") : "hecho";
}

/** Commands get a small, predictable environment: no session variables, no tokens. */
// A rule that watches a service passes what it found as JSON in $NEXUS_EVENTO (never pasted into the command line:
// a customer called `$(rm -rf ~)` stays a string).
function cleanEnv(home: string, ev?: ConnectEvent): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { HOME: home, PATH: `${home}/.local/bin:/usr/local/bin:/usr/bin:/bin`, LANG: process.env.LANG ?? "es_ES.UTF-8", TERM: "dumb", CI: "1" };
  if (process.env.TZ) e.TZ = process.env.TZ;
  if (ev) {
    const j = JSON.stringify(ev.data ?? {});
    e.NEXUS_EVENTO = j.length <= LIMITS.eventEnv ? j : JSON.stringify({ aviso: "demasiado grande para pasarlo entero", id: ev.id });
    e.NEXUS_EVENTO_TITULO = String(ev.label ?? "").slice(0, 300);
  }
  return e;
}
