// nexus-updated: NEXUS OS's update service (root). Installs NEXUS's signed updates (core/src/update.ts) and Debian's
// own updates of the base system, for Ajustes → Actualizaciones.
//
//   * No network port: it listens only on the unix socket /run/nexus-update/updated.sock, which only the desktop's
//     people (group nexus-update) can open. nexus-sessiond talks to it for the desktop; the Engine and the agents
//     cannot (they are not in that group).
//   * Protocol: one JSON object per line. Request {id, cmd, arg?}; answer {id, ok, result | error}; and, whenever
//     something changes, {event: "status", data} to every connected client. Long jobs (download, install, Debian)
//     answer at once and report their progress as events.
//   * Looks for updates a few minutes after starting and every 6 hours; downloads them by itself unless the person
//     turned that off. Installing is always the person's click.
//   * Where updates come from: /etc/nexus/update.conf (channel=URL). Whatever that channel says must be signed with
//     NEXUS's key, /usr/share/nexus/update/signing.pub.
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createUpdater, type RunFn, type Status, type HistoryItem } from "./update.ts";

export type AptUpgrade = { name: string; from: string; to: string };
/** `apt-get -s upgrade` lines like "Inst libc6 [2.41-12] (2.41-12+deb13u1 Debian-Security:13/stable-security [arm64])". */
export function parseAptUpgrades(out: string): AptUpgrade[] {
  const r: AptUpgrade[] = [];
  for (const m of out.matchAll(/^Inst (\S+) \[([^\]]+)\] \((\S+)/gm)) r.push({ name: m[1], from: m[2], to: m[3] });
  return r;
}

export type DebianStatus = { state: "idle" | "checking" | "installing"; count: number; packages: AptUpgrade[]; checkedAt?: string; progress?: number; rebootNeeded?: boolean; message?: string };
type StreamRun = (cmd: string, args: string[], opts: { env?: Record<string, string>; timeoutMs: number; onLine?: (l: string) => void }) => Promise<{ code: number; out: string }>;

/** Debian's updates of the base system (apt). NEXUS's own labwc stays pinned (/etc/apt/preferences.d/nexus-labwc). */
export function createDebian(o: { run: StreamRun; stateFile: string; onChange: () => void; note: (h: HistoryItem) => void; rebootFlag?: string; now?: () => Date }) {
  const now = o.now ?? (() => new Date());
  let st: DebianStatus = { state: "idle", count: 0, packages: [] };
  try { st = { ...JSON.parse(fs.readFileSync(o.stateFile, "utf8")), state: "idle", progress: undefined }; } catch { /* first time */ }
  const set = (p: Partial<DebianStatus>) => {
    st = { ...st, ...p };
    try { fs.writeFileSync(o.stateFile, JSON.stringify({ ...st, state: "idle", progress: undefined })); } catch { /* state dir missing in tests */ }
    o.onChange();
  };
  const env = { DEBIAN_FRONTEND: "noninteractive", LC_ALL: "C" };
  let busy = false;
  const check = async () => {
    if (busy) throw new Error("Ya se está trabajando con las actualizaciones de Debian.");
    busy = true; set({ state: "checking", message: undefined });
    try {
      const u = await o.run("apt-get", ["update", "-q"], { env, timeoutMs: 5 * 60_000 });
      if (u.code !== 0) return set({ state: "idle", message: "No se ha podido contactar con Debian (¿hay conexión a Internet?)." });
      const s = await o.run("apt-get", ["-s", "-q", "upgrade"], { env, timeoutMs: 2 * 60_000 });
      if (s.code !== 0) return set({ state: "idle", message: "apt no ha podido calcular las actualizaciones." });
      const packages = parseAptUpgrades(s.out);
      set({ state: "idle", count: packages.length, packages: packages.slice(0, 200), checkedAt: now().toISOString() });
    } finally { busy = false; }
  };
  const install = async () => {
    if (busy) throw new Error("Ya se está trabajando con las actualizaciones de Debian.");
    if (!st.count) throw new Error("No hay actualizaciones de Debian pendientes.");
    busy = true;
    const total = st.count; let done = 0;
    set({ state: "installing", progress: 0, message: undefined });
    try {
      const r = await o.run("apt-get", ["-y", "-q", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "upgrade"], {
        env, timeoutMs: 60 * 60_000,
        onLine: (l) => { if (/^Setting up /.test(l)) { done++; set({ progress: Math.min(0.99, done / total) }); } },
      });
      const kernel = st.packages.some((p) => /^linux-image/.test(p.name));
      const rebootNeeded = kernel || fs.existsSync(o.rebootFlag ?? "/run/reboot-required");
      if (r.code !== 0) {
        o.note({ version: `${total} paquetes`, from: "", at: now().toISOString(), result: "failed", kind: "debian", detail: r.out.trim().split("\n").slice(-2).join(" ").slice(0, 300) });
        return set({ state: "idle", progress: undefined, message: "Algunas actualizaciones de Debian no se han podido instalar. Vuelve a intentarlo más tarde." });
      }
      o.note({ version: `${total} paquetes`, from: "", at: now().toISOString(), result: "installed", kind: "debian" });
      set({ state: "idle", progress: undefined, count: 0, packages: [], rebootNeeded, message: rebootNeeded ? "Actualizaciones de Debian instaladas. Reinicia para terminar." : "Actualizaciones de Debian instaladas." });
    } finally { busy = false; }
  };
  return { status: () => st, check, install };
}

type UpdaterLike = Pick<ReturnType<typeof createUpdater>, "status" | "check" | "download" | "install" | "undo" | "history" | "setAutoDownload">;
/** The socket the desktop talks to. Commands that take long answer at once; their progress arrives as events. */
export function serveUpdates(o: { socketPath: string; updater: UpdaterLike; debian: ReturnType<typeof createDebian>; versions: () => Record<string, string>; gid?: number }) {
  const clients = new Set<net.Socket>();
  const snapshot = () => ({ ...o.updater.status(), history: o.updater.history().slice(0, 20), debian: o.debian.status(), versions: o.versions() });
  const broadcast = () => { const line = JSON.stringify({ event: "status", data: snapshot() }) + "\n"; for (const c of clients) c.write(line); };
  // long jobs answer at once and report by events; what goes wrong also goes to the journal (journalctl -u nexus-updated)
  const background = (p: Promise<unknown>) => { p.catch((e) => console.error(`nexus-updated: ${(e as Error)?.message ?? e}`)).finally(broadcast); };
  const commands: Record<string, (arg: unknown) => Promise<unknown> | unknown> = {
    status: () => snapshot(),
    check: () => o.updater.check().then(() => snapshot()),
    // "install": download and then install, one job in the daemon (the desktop does not have to chain them)
    download: (arg) => {
      const fetched = o.updater.status().state === "ready" ? Promise.resolve() : o.updater.download();
      background(arg === "install" ? fetched.then(() => o.updater.install()) : fetched);
      return snapshot();
    },
    install: () => { background(o.updater.install()); return snapshot(); },
    undo: () => { background(o.updater.undo()); return snapshot(); },
    auto: (arg) => { if (typeof arg !== "boolean") throw new Error("auto espera true o false"); o.updater.setAutoDownload(arg); return snapshot(); },
    "debian-check": () => { background(o.debian.check()); return snapshot(); },
    "debian-install": () => { background(o.debian.install()); return snapshot(); },
  };
  fs.rmSync(o.socketPath, { force: true });
  const server = net.createServer((sock) => {
    clients.add(sock);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", async (chunk: string) => {
      buf += chunk;
      if (buf.length > 16_384) { sock.destroy(); return; }
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let req: { id?: unknown; cmd?: unknown; arg?: unknown };
        try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ ok: false, error: "petición mal formada" }) + "\n"); continue; }
        const id = typeof req.id === "number" || typeof req.id === "string" ? req.id : null;
        const fn = typeof req.cmd === "string" && Object.hasOwn(commands, req.cmd) ? commands[req.cmd] : null;
        if (!fn) { sock.write(JSON.stringify({ id, ok: false, error: `orden desconocida ${String(req.cmd).slice(0, 40)}` }) + "\n"); continue; }
        try { sock.write(JSON.stringify({ id, ok: true, result: await fn(req.arg) }) + "\n"); }
        catch (e) { sock.write(JSON.stringify({ id, ok: false, error: (e as Error).message }) + "\n"); }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => clients.delete(sock));
  });
  server.listen(o.socketPath, () => {
    fs.chmodSync(o.socketPath, 0o660);
    if (o.gid !== undefined) fs.chownSync(o.socketPath, 0, o.gid);
  });
  return { server, broadcast, close: () => { for (const c of clients) c.destroy(); server.close(); } };
}

// ---------------------------------------------------------------- the real service
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const streamRun: StreamRun = (cmd, args, opts) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", pending = "";
  const take = (d: Buffer) => {
    const s = d.toString(); out = (out + s).slice(-200_000);
    if (opts.onLine) { pending += s; let i; while ((i = pending.indexOf("\n")) >= 0) { opts.onLine(pending.slice(0, i)); pending = pending.slice(i + 1); } }
  };
  p.stdout.on("data", take); p.stderr.on("data", take);
  const t = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs);
  p.on("error", (e) => { clearTimeout(t); resolve({ code: 127, out: String(e) }); });
  p.on("close", (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
});
const run: RunFn = (cmd, args, opts) => streamRun(cmd, args, { env: opts?.env, timeoutMs: opts?.timeoutMs ?? 120_000 });

function readConf(f: string): Record<string, string> {
  const r: Record<string, string> = {};
  try { for (const l of fs.readFileSync(f, "utf8").split("\n")) { const m = /^\s*([a-zA-Z]+)\s*=\s*(.*?)\s*$/.exec(l); if (m) r[m[1]] = m[2]; } } catch { /* defaults */ }
  return r;
}
function groupId(name: string): number | undefined {
  try { for (const l of fs.readFileSync("/etc/group", "utf8").split("\n")) { const p = l.split(":"); if (p[0] === name) return Number(p[2]); } } catch { /* none */ }
  return undefined;
}
/** The people with a NEXUS desktop open now (their nexus-sessiond left its token in /run/user/<uid>/nexus). */
/** The shell's report (nexus-sessiond writes it when the shell has made its parts): whole, and — when NEXUS Update
 *  restarted the shell — written after that restart. No file: fine unless the shell was restarted (then it must report). */
export function shellReportOk(file: string, restartedAt: number): boolean {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return !restartedAt; }
  let h: { at?: string; failed?: unknown } | null = null;
  try { h = JSON.parse(text); } catch { return false; }
  if (!h || !Array.isArray(h.failed) || h.failed.length) return false;
  return !restartedAt || Date.parse(String(h.at)) >= restartedAt - 1000;
}

/** Files labwc (the window manager) reads at start: its settings and the NEXUS window theme. When an update changes
 *  them, each desktop's labwc is told to read them again (what `labwc --reconfigure` does: a SIGHUP), so a new
 *  Alt+Tab or window look shows at once instead of at the next login. */
export function touchesWindowManager(changed: string[]): boolean {
  return changed.some((p) => /^\/etc\/xdg\/labwc\/|^\/usr\/share\/themes\/NEXUS\//.test(p));
}

function desktopUids(): number[] {
  try { return fs.readdirSync("/run/user").map(Number).filter((u) => Number.isInteger(u) && fs.existsSync(`/run/user/${u}/nexus/session.token`)); } catch { return []; }
}

function desktopUsers(): string[] {
  const names = new Map<number, string>();
  try { for (const l of fs.readFileSync("/etc/passwd", "utf8").split("\n")) { const p = l.split(":"); if (p.length > 2) names.set(Number(p[2]), p[0]); } } catch { /* none */ }
  const out: string[] = [];
  try { for (const uid of fs.readdirSync("/run/user")) if (fs.existsSync(`/run/user/${uid}/nexus/session.token`) && names.has(Number(uid))) out.push(names.get(Number(uid))!); } catch { /* none */ }
  return out;
}

async function main() {
  const conf = readConf("/etc/nexus/update.conf");
  const channel = (conf.channel || "").replace(/\/?$/, "/");
  const stateDir = process.env.STATE_DIRECTORY || "/var/lib/nexus-update";
  const cacheDir = process.env.CACHE_DIRECTORY || "/var/cache/nexus-update";
  const runDir = process.env.RUNTIME_DIRECTORY || "/run/nexus-update";
  const gid = groupId("nexus-update");
  if (gid !== undefined) { fs.chownSync(runDir, 0, gid); fs.chmodSync(runDir, 0o710); }
  let restartSelf = false;
  let shellRestartedAt = 0;   // when NEXUS Update last restarted the desktop shell (its report must be newer)
  let srv: ReturnType<typeof serveUpdates> | null = null;

  // the services that use the changed files: the Engine (and with it each desktop's session), the desktop shell
  const restart = async (changed: string[]) => {
    const touches = (re: RegExp) => changed.some((p) => re.test(p));
    await run("systemctl", ["daemon-reload"]);
    const engine = touches(/^\/usr\/lib\/nexus\/(engine|node)\/|^\/usr\/lib\/systemd\/system\/nexus-engined\.service$/);
    const session = engine || touches(/^\/usr\/lib\/systemd\/user\//);
    const shell = session || touches(/^\/usr\/share\/nexus\/|^\/usr\/lib\/nexus\/[^/]+\.so$|^\/usr\/bin\/nexus-shell$/);
    shellRestartedAt = shell && desktopUsers().length ? Date.now() : 0;
    if (engine) await run("systemctl", ["restart", "nexus-engined"], { timeoutMs: 60_000 });
    for (const user of desktopUsers()) {
      const u = ["--user", "-M", `${user}@`];
      await run("systemctl", [...u, "daemon-reload"]);
      const units = [...(session ? ["nexus-sessiond.service", "nexus-clipboard.service"] : []), ...(shell ? ["nexus-shell.service"] : [])];
      if (units.length) await run("systemctl", [...u, "restart", ...units], { timeoutMs: 60_000 });
    }
    if (touchesWindowManager(changed)) for (const user of desktopUsers()) await run("pkill", ["-HUP", "-x", "-u", user, "labwc"]);
    if (touches(/^\/usr\/lib\/nexus\/engine\/core\/src\/(update|updated)\.ts$/)) restartSelf = true;
  };
  // healthy: the Engine answers, and the Engine, every desktop's session and shell are running and did not restart
  // during an 8-second watch (a desktop that crashes and comes back keeps systemd's restart counter going up)
  const units = async () => {
    const show = async (opts: string[], unitNames: string[]) => {
      const r = await run("systemctl", [...opts, "show", ...unitNames, "-p", "ActiveState", "-p", "NRestarts"]);
      const states = [...r.out.matchAll(/^ActiveState=(\w+)$/gm)].map((m) => m[1]);
      return states.length === unitNames.length && states.every((x) => x === "active") ? (r.out.match(/NRestarts=\d+/g) ?? []).join(",") : null;
    };
    const parts = [await show([], ["nexus-engined.service"])];
    for (const user of desktopUsers()) parts.push(await show(["--user", "-M", `${user}@`], ["nexus-sessiond.service", "nexus-shell.service"]));
    return parts.includes(null) ? null : parts.join("|");
  };
  const healthy = async () => {
    const a = await units();
    await sleep(8000);
    const b = await units();
    const engine = await fetch("http://127.0.0.1:7777/", { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
    const shells = desktopUids().every((u) => shellReportOk(`/run/user/${u}/nexus/shell-health.json`, shellRestartedAt));
    return a !== null && a === b && engine && shells;
  };

  const updater = createUpdater({
    stateDir, cacheDir, channel: () => channel,
    publicKeyPem: fs.readFileSync("/usr/share/nexus/update/signing.pub", "utf8"),
    factoryManifest: "/usr/lib/nexus/update/factory.json",
    run, restart, healthy,
    reboot: async () => { await run("systemctl", ["reboot"]); },
    onStatus: () => srv?.broadcast(),
  });
  const debian = createDebian({ run: streamRun, stateFile: path.join(stateDir, "debian.json"), onChange: () => srv?.broadcast(), note: (h) => updater.noteHistory(h) });
  const readText = (f: string) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
  let labwc = "";
  run("dpkg-query", ["-W", "-f=${Version}", "labwc"]).then((r) => { labwc = r.out.trim(); srv?.broadcast(); });
  const versions = () => ({
    nexus: updater.status().installed, claudeCode: readText("/usr/lib/nexus/claude-code/VERSION"), labwc,
    debian: readText("/etc/debian_version"), kernel: os.release(), channel: channel.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  });
  srv = serveUpdates({ socketPath: path.join(runDir, "updated.sock"), updater, debian, versions, gid });

  // after an operation that replaced this very service: let systemd start the new one
  setInterval(() => { if (restartSelf && !updater.isBusy()) { restartSelf = false; run("systemctl", ["restart", "--no-block", "nexus-updated.service"]); } }, 5000).unref();

  await updater.recover().catch(() => {});
  const tick = async () => {
    if (!channel || channel === "/") return;
    const s = await updater.check().catch(() => null);
    if (s?.state === "available" && s.autoDownload && !s.available?.failedBefore) await updater.download().catch(() => {});
  };
  setTimeout(() => { void tick(); setInterval(() => void tick(), 6 * 3600_000); }, 3 * 60_000);
  process.on("SIGTERM", () => { srv?.close(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
export type { Status };
