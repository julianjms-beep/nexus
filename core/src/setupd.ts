// nexus-setupd: the root helper of the first-boot assistant of a NEXUS OS release image. It only runs while the
// computer has no person's account yet (nexus-setupd.service: ConditionPathExists=!/var/lib/nexus-setup/done) and
// stops for good once the assistant has created it.
//
// The assistant (nexus-setup, a QML app) runs as the login screen's user (_greetd) and talks to it over HTTP on
// 127.0.0.1 with a random token that only root and the group _greetd can read (/run/nexus-setup/token). It:
//   GET  /state        keyboards, Apple keyboard?, time zone, network (cable / Wi-Fi)
//   GET  /timezones    the zone names
//   GET  /wifi         Wi-Fi networks around (NetworkManager)
//   POST /wifi         {ssid, password}: connect (the password goes to nmcli in a 0600 file, never on a command line)
//   POST /keyboard     {id}: /etc/default/keyboard; answers the labwc lines so the assistant's own screen follows
//   POST /finish       {fullName, username, password, password2, keyboard, timezone, claudeKey?}: creates the account
//                      (useradd + chpasswd), sets keyboard and time zone, keeps the Claude key where the engine reads
//                      it, marks setup as done and opens the new desktop once without asking for the password again.
// Passwords and keys are never logged or written anywhere else.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  KEYBOARDS, keyboardById, keyboardFile, xkbEnv, isAppleKeyboard, checkAccount, checkClaudeKey, checkTimezone,
  parseWifiList, nmcliFields, checkSsid, checkWifiPassword, firstLoginConfig, SETUP_GROUPS,
} from "./setup.ts";
import { keyMgmtFor, wifiProfileScript, wiredFrom, parseWifiList as parseScan } from "./devices.ts";
import os from "node:os";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string, args: string[], input?: string) => Promise<RunResult>;

export type SetupdOptions = {
  host?: string; port: number;
  runDir: string;            // token lives here (0750 root:_greetd)
  stateDir: string;          // "done" lives here
  greeterGid?: number;       // group that may read the token
  run: Runner;
  files?: Partial<typeof DEFAULT_FILES>;
  /** what happens after /finish answered: the real one restarts greetd into the new desktop */
  afterFinish?: (user: string) => void;
  log?: (msg: string) => void;
};

export const DEFAULT_FILES = {
  passwd: "/etc/passwd", group: "/etc/group", keyboard: "/etc/default/keyboard", greetdConfig: "/etc/greetd/config.toml",
  credentials: "/var/lib/nexus/credentials.json", inputDevices: "/proc/bus/input/devices", localtime: "/etc/localtime",
  timezone: "/etc/timezone", zoneinfo: "/usr/share/zoneinfo",
};

const realRun: Runner = (cmd, args, input) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; });
  p.stderr.on("data", (d) => { stderr += d; });
  p.on("error", (e) => resolve({ code: 127, stdout, stderr: String(e.message) }));
  p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  p.stdin.end(input ?? "");
});

const names = (file: string) => {
  try { return new Set(fs.readFileSync(file, "utf8").split("\n").map((l) => l.split(":")[0]).filter(Boolean)); } catch { return new Set<string>(); }
};
const readOr = (file: string, fallback = "") => { try { return fs.readFileSync(file, "utf8"); } catch { return fallback; } };
const writeAtomic = (file: string, data: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.nexus-setup.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};

export function startSetupd(o: SetupdOptions) {
  const F = { ...DEFAULT_FILES, ...o.files };
  const log = o.log ?? ((m: string) => console.log(m));
  fs.mkdirSync(o.runDir, { recursive: true });
  const token = crypto.randomBytes(32).toString("hex");
  const tokenFile = path.join(o.runDir, "token");
  fs.writeFileSync(tokenFile, token + "\n", { mode: 0o640 });
  if (o.greeterGid !== undefined) { fs.chownSync(o.runDir, 0, o.greeterGid); fs.chmodSync(o.runDir, 0o750); fs.chownSync(tokenFile, 0, o.greeterGid); }
  let finished = false;
  let zones: string[] | null = null;

  const apple = () => isAppleKeyboard(readOr(F.inputDevices));
  const currentKeyboard = () => {
    const t = readOr(F.keyboard);
    const layout = /^XKBLAYOUT="?([a-z]+)"?/m.exec(t)?.[1];
    const variant = /^XKBVARIANT="?([a-z]*)"?/m.exec(t)?.[1] || undefined;
    return (KEYBOARDS.find((k) => k.layout === layout && k.variant === variant) ?? KEYBOARDS[0]).id;
  };
  const timezones = async () => {
    if (zones) return zones;
    const r = await o.run("timedatectl", ["list-timezones", "--no-pager"]);
    zones = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : ["Europe/Madrid", "Atlantic/Canary", "UTC"];
    return zones;
  };
  const currentTimezone = () => {
    try { return fs.readlinkSync(F.localtime).replace(/^.*zoneinfo\//, ""); } catch { return readOr(F.timezone).trim() || "Europe/Madrid"; }
  };
  const network = async () => {
    const r = await o.run("nmcli", ["-t", "-f", "TYPE,STATE,CONNECTION", "device"]);
    if (r.code !== 0) return { manager: false, wifi: false, wired: false, online: false, ssid: "" };
    let wifi = false, wired = false, ssid = "";
    for (const line of r.stdout.split("\n")) {
      const [type, state, conn] = nmcliFields(line);
      if (type === "wifi") { wifi = true; if (state === "connected") ssid = conn; }
      if (type === "ethernet" && state === "connected") wired = true;
    }
    // cables stay with systemd-networkd (NetworkManager only does Wi-Fi): a wired card with an address is online
    if (!wired) wired = !!wiredFrom(os.networkInterfaces())?.connected;
    return { manager: true, wifi, wired, online: wired || !!ssid, ssid };
  };

  // The profile (password included) goes through `nmcli connection edit`'s stdin, never a command line, and comes up
  // with no secret agent, so a wrong password fails at once; it stays saved only if it connected (core/src/devices.ts).
  async function connectWifi(ssid: unknown, password: unknown) {
    if (!checkSsid(ssid)) return { error: "Ese nombre de red no es válido." };
    if (!checkWifiPassword(password)) return { error: "La contraseña del Wi-Fi tiene entre 8 y 63 caracteres." };
    const pw = typeof password === "string" ? password : "";
    const seen = parseScan((await o.run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"])).stdout).find((n) => n.ssid === ssid);
    let km: string;
    try { km = keyMgmtFor(seen ? seen.security : pw ? "WPA2" : ""); } catch (e) { const m = (e as Error).message; return { error: m.charAt(0).toUpperCase() + m.slice(1) + "." }; }
    const needsPw = km === "wpa-psk" || km === "sae";
    if (needsPw && !pw) return { error: "Esta red tiene contraseña: escríbela." };
    await o.run("nmcli", ["connection", "delete", "id", ssid]);   // an earlier try at the same network
    const edit = await o.run("nmcli", ["connection", "edit", "type", "wifi", "con-name", ssid], wifiProfileScript(ssid, km, needsPw ? pw : ""));
    if (edit.code !== 0) return { error: "No se ha podido guardar esa red." };
    const r = await o.run("nmcli", ["--wait", "30", "connection", "up", "id", ssid]);
    if (r.code === 0) {
      await o.run("nmcli", ["connection", "modify", "id", ssid, "connection.autoconnect", "yes"]);
      log("wifi: connected to a network");
      return { ok: true };
    }
    await o.run("nmcli", ["connection", "delete", "id", ssid]);
    const wrong = /secrets were required|no secrets/i.test(r.stderr) || (needsPw && /could not be found|Timeout/i.test(r.stderr));
    return { error: wrong ? "No se ha podido conectar: revisa la contraseña." : "No se ha podido conectar a esa red." };
  }

  async function finish(b: Record<string, unknown>) {
    if (finished) return { error: "La configuración ya está hecha." };
    const taken = names(F.passwd);
    const check = checkAccount(b, taken);
    if (!check.ok) return { error: check.error, field: check.field };
    const k = keyboardById(b.keyboard) ?? KEYBOARDS[0];
    const tz = checkTimezone(b.timezone, await timezones()) ? b.timezone : "Europe/Madrid";
    const claudeKey = typeof b.claudeKey === "string" ? b.claudeKey.trim() : "";
    if (claudeKey && !checkClaudeKey(claudeKey)) return { error: "Esa clave no parece de Anthropic (empieza por sk-ant-).", field: "claudeKey" };
    const user = b.username as string, fullName = (b.fullName as string).trim();
    finished = true;   // one account per setup, even if two requests race
    const groups = [...names(F.group)].filter((g) => SETUP_GROUPS.includes(g));
    const add = await o.run("useradd", ["--create-home", "--shell", "/bin/bash", "--comment", fullName, ...(groups.length ? ["--groups", groups.join(",")] : []), user]);
    if (add.code !== 0) { finished = false; log(`useradd failed (${add.code}): ${add.stderr.trim()}`); return { error: "No se ha podido crear la cuenta." }; }
    const pw = await o.run("chpasswd", [], `${user}:${b.password as string}\n`);
    if (pw.code !== 0) {
      await o.run("userdel", ["--remove", user]);
      finished = false; log(`chpasswd failed (${pw.code})`); return { error: "No se ha podido poner la contraseña." };
    }
    writeAtomic(F.keyboard, keyboardFile(k));
    const t = await o.run("timedatectl", ["set-timezone", tz]);
    if (t.code !== 0) {   // no timedated (or no D-Bus yet): the same thing by hand
      try { fs.rmSync(F.localtime, { force: true }); fs.symlinkSync(path.join(F.zoneinfo, tz), F.localtime); writeAtomic(F.timezone, tz + "\n"); } catch { /* keep the old zone */ }
    }
    if (claudeKey) {
      writeAtomic(F.credentials, JSON.stringify({ anthropicApiKey: claudeKey }), 0o600);
      const own = await o.run("chown", ["nexus-engine:nexus-engine", F.credentials]);
      if (own.code !== 0) log("could not hand the Claude key file to nexus-engine");
    }
    writeAtomic(path.join(o.stateDir, "done"), JSON.stringify({ user, at: new Date().toISOString() }) + "\n");
    log(`setup done: account ${user} created (groups ${groups.join(",") || "none"}), keyboard ${k.id}, zone ${tz}${claudeKey ? ", Claude key kept" : ""}`);
    setTimeout(() => o.afterFinish?.(user), 600);
    return { ok: true, user };
  }

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
    const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const want = Buffer.from(token);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://setup");
    try {
      let body: Record<string, unknown> = {};
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) return send(413, { error: "too large" }); }
        try { body = JSON.parse(raw || "{}"); } catch { return send(400, { error: "bad json" }); }
        if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, { error: "bad json" });
      }
      const p = url.pathname;
      if (req.method === "GET" && p === "/state") {
        return send(200, { keyboards: KEYBOARDS, keyboard: currentKeyboard(), apple: apple(), timezone: currentTimezone(), network: await network(), done: finished });
      }
      if (req.method === "GET" && p === "/timezones") return send(200, { zones: await timezones() });
      if (req.method === "GET" && p === "/wifi") {
        const r = await o.run("nmcli", ["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto"]);
        return send(200, { networks: r.code === 0 ? parseWifiList(r.stdout) : [], available: r.code === 0 });
      }
      if (req.method === "POST" && p === "/wifi") return send(200, await connectWifi(body.ssid, body.password ?? ""));
      if (req.method === "POST" && p === "/keyboard") {
        const k = keyboardById(body.id);
        if (!k) return send(400, { error: "unknown keyboard" });
        writeAtomic(F.keyboard, keyboardFile(k));
        return send(200, { ok: true, env: xkbEnv(k, apple()) });
      }
      if (req.method === "POST" && p === "/finish") return send(200, await finish(body));
      return send(404, { error: "not found" });
    } catch (e) {
      log(`error: ${(e as Error).message}`);
      return send(500, { error: "Algo ha fallado. Inténtalo otra vez." });
    }
  });
  server.listen(o.port, o.host ?? "127.0.0.1");
  return { server, token, close: () => server.close() };
}

/** After setup: greetd starts again with a one-time configuration (in /run) that opens the new person's desktop, then
 *  that configuration is taken away, so the next logout or reboot shows the normal login screen. */
async function firstLogin(run: Runner, user: string, log: (m: string) => void) {
  const dropDir = "/run/systemd/system/greetd.service.d";
  const drop = path.join(dropDir, "50-nexus-first-login.conf");
  const cfg = "/run/nexus-first-login.toml";
  try {
    writeAtomic(cfg, firstLoginConfig(readOr(DEFAULT_FILES.greetdConfig), user));
    writeAtomic(drop, `# NEXUS setup: one automatic first login (removed a few seconds later)\n[Service]\nExecStart=\nExecStart=/usr/sbin/greetd --config ${cfg}\n`);
    await run("systemctl", ["daemon-reload"]);
    await run("systemctl", ["restart", "--no-block", "greetd.service"]);
    log(`opening the desktop of ${user}`);
    await new Promise((r) => setTimeout(r, 10_000));
  } finally {
    fs.rmSync(drop, { force: true });
    await run("systemctl", ["daemon-reload"]);
  }
}

function groupId(name: string): number | undefined {
  for (const l of readOr("/etc/group").split("\n")) { const p = l.split(":"); if (p[0] === name) return Number(p[2]); }
  return undefined;
}

async function main() {
  const log = (m: string) => console.log(m);
  const runDir = process.env.RUNTIME_DIRECTORY || "/run/nexus-setup";
  const stateDir = process.env.STATE_DIRECTORY || "/var/lib/nexus-setup";
  const s = startSetupd({
    port: Number(process.env.NEXUS_SETUP_PORT || 7791), runDir, stateDir, greeterGid: groupId("_greetd"), run: realRun, log,
    afterFinish: (user) => { void firstLogin(realRun, user, log).finally(() => { s.close(); process.exit(0); }); },
  });
  log(`nexus-setupd: waiting for the setup assistant on 127.0.0.1:${process.env.NEXUS_SETUP_PORT || 7791}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
