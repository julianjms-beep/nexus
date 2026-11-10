// NEXUS devices: what the menu bar's Wi-Fi, battery and Control Center panels show and change — Wi-Fi
// (NetworkManager via nmcli), Bluetooth (bluetoothctl), airplane mode (rfkill), sound (PipeWire via wpctl), screen
// brightness (brightnessctl through logind), the power mode (power-profiles-daemon), the battery (/sys) and what is
// playing (playerctl, MPRIS). Runs inside nexus-sessiond as the person. Every piece is optional: a computer without a
// tool, a radio or a daemon reports that part as unavailable and the panel simply does not show it.
//
// Safety: commands run with execFile-style argv (never a shell), with a timeout and LC_ALL=C (English output to parse).
// A Wi-Fi password never goes on the command line (any user can read /proc/*/cmdline): the network's profile is written
// through the stdin of `nmcli connection edit`. Inputs are checked (SSID ≤ 32 bytes, WPA password 8–63 letters or 64 hex
// digits, MAC addresses).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nmcliFields } from "./setup.ts";

export type RunResult = { code: number; out: string; err: string; missing?: boolean; timedOut?: boolean };
export type Runner = (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<RunResult>;

export class DeviceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const defaultRunner: Runner = (cmd, args, opts = {}) => new Promise((resolve) => {
  let out = "", err = "", done = false, timedOut = false;
  const child = spawn(cmd, args, { env: { ...process.env, LC_ALL: "C", LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs ?? 5000);
  const finish = (r: RunResult) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
  child.stdout.on("data", (d) => { if (out.length < 1 << 20) out += d; });
  child.stderr.on("data", (d) => { if (err.length < 1 << 16) err += d; });
  child.on("error", (e: NodeJS.ErrnoException) => finish({ code: 127, out, err: String(e.message), missing: e.code === "ENOENT" }));
  child.on("close", (code) => finish({ code: code ?? (timedOut ? 124 : 1), out, err, timedOut }));
  child.stdin.on("error", () => { /* the tool exited before reading */ });
  child.stdin.end(opts.input ?? "");
});

// ---------------------------------------------------------------- parsers (pure, tested)

/** One line of `nmcli -t` output (the same splitter the first-boot setup uses). */
export const nmFields = nmcliFields;

export type WifiNet = { ssid: string; signal: number; bars: number; secure: boolean; security: string; current: boolean; known: boolean };
export function bars(signal: number) { return signal >= 60 ? 3 : signal >= 35 ? 2 : 1; }

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` → one entry per name (the strongest), hidden ones skipped. */
export function parseWifiList(out: string, known: string[] = []): WifiNet[] {
  const by = new Map<string, WifiNet>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [inUse, ssid, sig, sec] = nmFields(line);
    if (!ssid) continue;
    const signal = Math.max(0, Math.min(100, Number(sig) || 0));
    const security = (sec ?? "").trim() === "--" ? "" : (sec ?? "").trim();
    const n: WifiNet = { ssid, signal, bars: bars(signal), secure: security !== "", security, current: inUse === "*", known: known.includes(ssid) };
    const prev = by.get(ssid);
    if (!prev) by.set(ssid, n);
    else { if (n.current) prev.current = true; if (n.signal > prev.signal) { prev.signal = n.signal; prev.bars = n.bars; } }
  }
  return [...by.values()].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.known) - Number(a.known) || b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

export type NmDevice = { device: string; type: string; state: string; connection: string };
/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device` */
export function parseNmDevices(out: string): NmDevice[] {
  return out.split("\n").filter((l) => l.trim()).map((l) => { const [device, type, state, connection] = nmFields(l); return { device, type, state, connection: connection ?? "" }; });
}

export type KnownNet = { name: string; type: string; lastUsed: number };
/** `nmcli -t -f NAME,TYPE,TIMESTAMP connection show` → the saved Wi-Fi networks, most recently used first. */
export function parseKnown(out: string): KnownNet[] {
  return out.split("\n").filter((l) => l.trim()).map((l) => { const [name, type, ts] = nmFields(l); return { name, type, lastUsed: Number(ts) || 0 }; })
    .filter((k) => k.type === "802-11-wireless" || k.type === "wifi").sort((a, b) => b.lastUsed - a.lastUsed);
}

/** `wpctl get-volume @DEFAULT_AUDIO_SINK@` → "Volume: 0.45 [MUTED]" */
export function parseVolume(out: string): { volume: number; muted: boolean } | null {
  const m = /Volume:\s*([\d.]+)/.exec(out);
  if (!m) return null;
  return { volume: Math.max(0, Math.min(150, Math.round(Number(m[1]) * 100))), muted: /\[MUTED\]/.test(out) };
}

/** `bluetoothctl show` → null without a controller */
export function parseBtShow(out: string): { powered: boolean; name: string } | null {
  if (!/Controller\s+[0-9A-F:]{17}/i.test(out)) return null;
  return { powered: /Powered:\s*yes/i.test(out), name: /\bAlias:\s*(.+)/.exec(out)?.[1]?.trim() ?? /\bName:\s*(.+)/.exec(out)?.[1]?.trim() ?? "" };
}
/** `bluetoothctl devices [Paired|Connected]` → "Device AA:BB:CC:DD:EE:FF Name" lines */
export function parseBtDevices(out: string): { mac: string; name: string }[] {
  const r: { mac: string; name: string }[] = [];
  for (const l of out.split("\n")) { const m = /^Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})(?:\s+(.*))?$/i.exec(l.trim()); if (m) r.push({ mac: m[1].toUpperCase(), name: (m[2] ?? "").trim() || m[1] }); }
  return r;
}

/** `powerprofilesctl list` → the modes this computer offers and the active one */
export function parsePowerProfiles(out: string): { mode: string; modes: string[] } | null {
  const modes: string[] = []; let mode = "";
  for (const l of out.split("\n")) {
    const m = /^(\*)?\s*([a-z-]+):\s*$/.exec(l);
    if (m) { modes.push(m[2]); if (m[1]) mode = m[2]; }
  }
  return modes.length ? { mode: mode || modes[0], modes } : null;
}

/** `brightnessctl -m -c backlight info` → "intel_backlight,backlight,400,40%,1000" */
export function parseBrightness(out: string): { device: string; percent: number } | null {
  const line = out.split("\n").find((l) => l.includes(","));
  if (!line) return null;
  const f = line.split(",");
  const cur = Number(f[2]), max = Number(f[4]);
  if (!(max > 0)) return null;
  return { device: f[0], percent: Math.round((100 * cur) / max) };
}

/** `rfkill -n -o TYPE,SOFT` → whether every radio is switched off (airplane mode) */
export function parseRfkill(out: string): { radios: number; allBlocked: boolean } {
  const rows = out.split("\n").map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 2 && r[0]);
  return { radios: rows.length, allBlocked: rows.length > 0 && rows.every((r) => r[1] === "blocked") };
}

/** `playerctl metadata --format "{{playerName}}\t{{status}}\t{{title}}\t{{artist}}"` */
export function parseMedia(out: string): { player: string; status: string; title: string; artist: string } | null {
  const line = out.split("\n").find((l) => l.includes("\t"));
  if (!line) return null;
  const [player, status, title, artist] = line.split("\t");
  if (!player) return null;
  return { player, status: status || "Stopped", title: title || "", artist: artist || "" };
}

export type BatteryInfo = {
  percent: number; status: string; onAc: boolean; minutesToFull: number | null; minutesToEmpty: number | null;
  healthPercent: number | null; cycles: number | null;
};
/** The first battery under /sys/class/power_supply (null on a desktop or a virtual machine) and whether mains power is on. */
export function readBattery(sysRoot = "/sys/class/power_supply"): BatteryInfo | null {
  const read = (d: string, f: string) => { try { return fs.readFileSync(path.join(sysRoot, d, f), "utf8").trim(); } catch { return ""; } };
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(sysRoot); } catch { return null; }
  const bat = dirs.find((d) => read(d, "type") === "Battery" && read(d, "scope") !== "Device");
  if (!bat) return null;
  const ac = dirs.find((d) => read(d, "type") === "Mains");
  const status = read(bat, "status") || "Unknown";
  const onAc = ac ? read(ac, "online") === "1" : status === "Charging" || status === "Full";
  const num = (f: string) => { const v = Number(read(bat, f)); return Number.isFinite(v) && read(bat, f) !== "" ? v : null; };
  const now = num("energy_now") ?? num("charge_now"), full = num("energy_full") ?? num("charge_full");
  const design = num("energy_full_design") ?? num("charge_full_design");
  const rate = Math.abs(num("power_now") ?? num("current_now") ?? 0);
  let percent = num("capacity");
  if (percent === null && now !== null && full) percent = Math.round((100 * now) / full);
  let toFull: number | null = null, toEmpty: number | null = null;
  if (rate > 0 && now !== null && full !== null) {
    if (status === "Charging") toFull = Math.round(((full - now) / rate) * 60);
    else if (status === "Discharging") toEmpty = Math.round((now / rate) * 60);
  }
  const cycles = num("cycle_count");
  return {
    percent: Math.max(0, Math.min(100, percent ?? 0)), status, onAc,
    minutesToFull: toFull !== null && toFull >= 0 && toFull < 48 * 60 ? toFull : null,
    minutesToEmpty: toEmpty !== null && toEmpty >= 0 && toEmpty < 72 * 60 ? toEmpty : null,
    healthPercent: full && design ? Math.min(100, Math.round((100 * full) / design)) : null,
    cycles: cycles && cycles > 0 ? cycles : null,
  };
}

// ---------------------------------------------------------------- checks

const CTRL = /[\u0000-\u001f\u007f]/;
export function checkSsid(v: unknown): string {
  const s = String(v ?? "");
  if (!s || Buffer.byteLength(s) > 32 || CTRL.test(s)) throw new DeviceError("ese nombre de red no es válido");
  return s;
}
export function checkWifiPassword(v: unknown): string {
  const s = String(v ?? "");
  if (CTRL.test(s)) throw new DeviceError("la contraseña tiene caracteres no válidos");
  if (/^[0-9a-f]{64}$/i.test(s)) return s;
  if (s.length < 8) throw new DeviceError("la contraseña de una red Wi-Fi tiene al menos 8 caracteres");
  if (s.length > 63) throw new DeviceError("la contraseña es demasiado larga (máximo 63 caracteres)");
  return s;
}
function checkMac(v: unknown): string {
  const s = String(v ?? "").toUpperCase();
  if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(s)) throw new DeviceError("ese aparato Bluetooth no es válido");
  return s;
}

/** nmcli's English error → what the person reads */
export function wifiError(r: RunResult): string {
  // (with --ask nmcli prints its "Password:" prompt on stdout: the wrong-password case is read from stderr only)
  const t = `${r.err}\n${r.out}`;
  if (r.timedOut) return "la red no ha respondido a tiempo";
  if (/secrets were required|no secrets|802-1x supplicant|wrong password|invalid.*(psk|key)/i.test(r.err)) return "la contraseña no es correcta";
  // ("could not be found": NetworkManager's activation error, also what an access point that ignores a wrong password causes)
  if (/No network with SSID|not found|could not be found/i.test(t)) return "esa red ya no está al alcance";
  if (/Not authorized|not authorised|Insufficient privileges/i.test(t)) return "NEXUS no tiene permiso para cambiar la red";
  if (/NetworkManager is not running|Could not create NMClient/i.test(t)) return "el gestor de red no está en marcha";
  if (/No Wi-Fi device found/i.test(t)) return "este equipo no tiene Wi-Fi";
  if (/IP configuration could not be reserved|ip-config-unavailable/i.test(t)) return "la red no ha dado dirección (prueba otra vez o reinicia el router)";
  return "no se ha podido conectar";
}

/** The kind of Wi-Fi security nmcli's scan reports → NetworkManager's key management ("" = open). Networks NEXUS
 *  cannot join from here say so instead of failing later. */
export function keyMgmtFor(security: string): "" | "wpa-psk" | "sae" | "owe" {
  const s = String(security || "").trim();
  if (!s || s === "--") return "";
  if (/802\.1X/i.test(s)) throw new DeviceError("las redes de empresa o de universidad (802.1X) aún no se pueden configurar desde aquí", 409);
  if (/WPA[123]?/i.test(s)) return /WPA3/i.test(s) && !/WPA[12]/i.test(s) ? "sae" : "wpa-psk";
  if (/WEP/i.test(s)) throw new DeviceError("esta red usa WEP, un cifrado antiguo que cualquiera puede romper: NEXUS no se conecta a ella", 409);
  if (/OWE/i.test(s)) return "owe";
  return "wpa-psk";
}

/** What `nmcli connection edit type wifi con-name <ssid>` reads on stdin: the profile, password included, so it is
 *  never on a command line. Saved without autoconnect; it is switched on only once the password proved right. */
export function wifiProfileScript(ssid: string, keyMgmt: string, password: string): string {
  if (/[\r\n]/.test(ssid + password + keyMgmt)) throw new DeviceError("datos de la red no válidos");
  return [
    `set 802-11-wireless.ssid ${ssid}`,
    ...(keyMgmt ? [`set 802-11-wireless-security.key-mgmt ${keyMgmt}`] : []),
    ...(keyMgmt === "wpa-psk" || keyMgmt === "sae" ? [`set 802-11-wireless-security.psk ${password}`] : []),
    "set connection.autoconnect no", "save", "quit", "",
  ].join("\n");
}

// ---------------------------------------------------------------- the service

export type DevicesOptions = {
  run?: Runner; sysRoot?: string; interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** is there a Bluetooth adapter? (default: an hci* entry in /sys/class/bluetooth) */
  hasBluetooth?: () => boolean;
};

/** an hci* adapter in /sys/class/bluetooth: without one, `bluetoothctl show` waits seconds for a controller */
export function bluetoothAdapterPresent(root = "/sys/class/bluetooth"): boolean {
  try { return fs.readdirSync(root).some((n) => n.startsWith("hci")); } catch { return false; }
}

/** The cable: NEXUS leaves wired network cards to systemd-networkd (NetworkManager only does Wi-Fi), so it is read
 *  from the kernel's interfaces — a wired card (en*, eth*) with an IPv4 address is connected. */
export function wiredFrom(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): { device: string; connected: boolean; address: string } | null {
  const wired = Object.entries(ifaces).filter(([n]) => /^(en|eth)/.test(n));
  if (!wired.length) return null;
  for (const [n, a] of wired) { const v4 = (a ?? []).find((x) => x.family === "IPv4" && !x.internal); if (v4) return { device: n, connected: true, address: v4.address }; }
  return { device: wired[0][0], connected: false, address: "" };
}

export function createDevices(o: DevicesOptions = {}) {
  const run = o.run ?? defaultRunner;
  const sysRoot = o.sysRoot ?? "/sys/class/power_supply";
  const hasBluetooth = o.hasBluetooth ?? (() => bluetoothAdapterPresent());
  const ifaces = o.interfaces ?? (() => os.networkInterfaces());
  const nm = (args: string[], t = 6000, input?: string) => run("nmcli", args, { timeoutMs: t, input });
  let lastScan = 0;

  async function nmState() {
    const radio = await nm(["-t", "-f", "WIFI-HW,WIFI", "radio"], 4000);
    if (radio.missing || radio.code !== 0) return { available: false as const };
    const [hw, sw] = nmFields(radio.out.trim().split("\n")[0] ?? "");
    const devs = parseNmDevices((await nm(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"], 4000)).out);
    const wifis = devs.filter((d) => d.type === "wifi");
    let wifiDev = wifis[0];
    if (wifis.length > 1) {
      // more than one Wi-Fi card (a USB adapter, or one sharing the connection as a hotspot): the computer's own Wi-Fi
      // is the first one not working as an access point
      for (const d of wifis) {
        if (!d.connection) { wifiDev = d; break; }
        const mode = (await nm(["-g", "802-11-wireless.mode", "connection", "show", "id", d.connection], 4000)).out.trim();
        if (mode !== "ap") { wifiDev = d; break; }
      }
    }
    const eth = devs.filter((d) => d.type === "ethernet");
    return { available: true as const, hw: hw === "enabled", on: sw === "enabled", wifiDev, eth };
  }
  async function knownNames(): Promise<KnownNet[]> {
    const r = await nm(["-t", "-f", "NAME,TYPE,TIMESTAMP", "connection", "show"], 4000);
    return r.code === 0 ? parseKnown(r.out) : [];
  }

  async function wifiState() {
    const s = await nmState();
    const ethernet = wiredFrom(ifaces());
    if (!s.available) return { available: false, hardware: false, on: false, device: "", current: null as WifiNet | null, ethernet };
    let current: WifiNet | null = null;
    if (s.wifiDev && s.wifiDev.state === "connected") {
      const r = await nm(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", s.wifiDev.device, "--rescan", "no"], 4000);
      current = parseWifiList(r.out).find((n) => n.current) ?? { ssid: s.wifiDev.connection, signal: 0, bars: 3, secure: true, security: "", current: true, known: true };
      current.known = true;
    }
    return { available: true, hardware: !!s.wifiDev && s.hw, on: s.on, device: s.wifiDev?.device ?? "", current, ethernet };
  }

  async function bluetooth() {
    if (!hasBluetooth()) return { available: false, on: false, devices: [] as { mac: string; name: string; connected: boolean }[] };
    const r = await run("bluetoothctl", ["show"], { timeoutMs: 3000 });
    const c = r.missing || r.timedOut ? null : parseBtShow(r.out);
    if (!c) return { available: false, on: false, devices: [] as { mac: string; name: string; connected: boolean }[] };
    let devices: { mac: string; name: string; connected: boolean }[] = [];
    if (c.powered) {
      const paired = parseBtDevices((await run("bluetoothctl", ["devices", "Paired"], { timeoutMs: 3000 })).out);
      const conn = new Set(parseBtDevices((await run("bluetoothctl", ["devices", "Connected"], { timeoutMs: 3000 })).out).map((d) => d.mac));
      devices = paired.slice(0, 12).map((d) => ({ ...d, connected: conn.has(d.mac) }));
    }
    return { available: true, on: c.powered, devices };
  }

  async function airplane() {
    const r = await run("rfkill", ["-n", "-o", "TYPE,SOFT"], { timeoutMs: 3000 });
    if (r.missing || r.code !== 0) return { available: false, on: false };
    const p = parseRfkill(r.out);
    return { available: p.radios > 0, on: p.allBlocked };
  }

  async function sound() {
    const r = await run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"], { timeoutMs: 3000 });
    const v = r.code === 0 ? parseVolume(r.out) : null;
    return v ? { available: true, ...v } : { available: false, volume: 0, muted: false };
  }

  async function brightness() {
    const r = await run("brightnessctl", ["-m", "-c", "backlight", "info"], { timeoutMs: 3000 });
    const b = r.code === 0 ? parseBrightness(r.out) : null;
    return b ? { available: true, value: b.percent } : { available: false, value: 0 };
  }

  async function power() {
    const r = await run("powerprofilesctl", ["list"], { timeoutMs: 4000 });
    const p = r.code === 0 ? parsePowerProfiles(r.out) : null;
    return p ? { available: true, ...p } : { available: false, mode: "", modes: [] as string[] };
  }

  async function media() {
    const r = await run("playerctl", ["metadata", "--format", "{{playerName}}\t{{status}}\t{{title}}\t{{artist}}"], { timeoutMs: 2500 });
    return r.code === 0 ? parseMedia(r.out) : null;
  }

  return {
    /** Everything the panels show, read in parallel (each part on its own; one slow tool does not hold the rest). */
    async state() {
      const [wifi, bt, air, snd, br, pw, med] = await Promise.all([wifiState(), bluetooth(), airplane(), sound(), brightness(), power(), media()]);
      return { wifi, bluetooth: bt, airplane: air, sound: snd, brightness: br, power: pw, battery: readBattery(sysRoot), media: med };
    },

    /** The networks in range (rescans at most every 10 s) and the saved ones. */
    async wifiList(rescan = false) {
      const s = await nmState();
      if (!s.available) throw new DeviceError("el gestor de red (NetworkManager) no está instalado en este equipo", 409);
      if (!s.wifiDev) return { networks: [] as WifiNet[], known: [] as string[], on: s.on, hardware: false };
      const known = await knownNames();
      const names = known.map((k) => k.name);
      const fresh = rescan && Date.now() - lastScan > 10_000;
      if (fresh) lastScan = Date.now();
      const r = await nm(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "ifname", s.wifiDev.device, "--rescan", fresh ? "yes" : "no"], fresh ? 15_000 : 6000);
      const networks = parseWifiList(r.out, names).map((n) => ({ ...n, known: names.some((k) => k === n.ssid || k.startsWith(n.ssid + " ")) }));
      return { networks, known: names, on: s.on, hardware: s.hw };
    },

    async setWifi(on: boolean) {
      const r = await nm(["radio", "wifi", on ? "on" : "off"]);
      if (r.missing) throw new DeviceError("el gestor de red (NetworkManager) no está instalado en este equipo", 409);
      if (r.code !== 0) throw new DeviceError(wifiError(r), 502);
      return { on };
    },

    /** Join a network. A saved one comes up from its profile. A new one (or a new password) gets a profile written
     *  through nmcli's stdin and is brought up with no secret agent, so a wrong password fails at once ("Secrets were
     *  required") instead of nmcli waiting for someone to type it again; the profile is kept only if it connected. */
    async connectWifi(ssidIn: unknown, passwordIn?: unknown) {
      const ssid = checkSsid(ssidIn);
      const s = await nmState();
      if (!s.available) throw new DeviceError("el gestor de red (NetworkManager) no está instalado en este equipo", 409);
      if (!s.wifiDev) throw new DeviceError("este equipo no tiene Wi-Fi", 409);
      const ifn = ["ifname", s.wifiDev.device];
      const saved = (await knownNames()).filter((k) => k.name === ssid || k.name.startsWith(ssid + " "));
      const given = passwordIn !== undefined && passwordIn !== null && passwordIn !== "";
      if (saved.length && !given) {
        const r = await nm(["--wait", "30", "connection", "up", "id", saved[0].name, ...ifn], 35_000);
        if (r.code === 0) return { ok: true, ssid };
        const msg = wifiError(r);
        if (msg === "la contraseña no es correcta") throw new DeviceError("la contraseña guardada para esta red ya no vale: escríbela otra vez", 401);
        throw new DeviceError(msg, 502);
      }
      // a new network (or a new password for a saved one): what kind of security it has comes from the scan
      const seen = parseWifiList((await nm(["-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", ...ifn, "--rescan", "auto"], 8000)).out).find((n) => n.ssid === ssid);
      const km = keyMgmtFor(seen ? seen.security : given ? "WPA2" : "");
      const needsPw = km === "wpa-psk" || km === "sae";
      if (needsPw && !given) throw new DeviceError("esta red tiene contraseña", 401);
      const pw = needsPw ? checkWifiPassword(passwordIn) : "";
      for (const k of saved) await nm(["connection", "delete", "id", k.name], 6000);   // a changed password: start again
      const edit = await nm(["connection", "edit", "type", "wifi", "con-name", ssid], 10_000, wifiProfileScript(ssid, km, pw));
      if (edit.missing) throw new DeviceError("el gestor de red (NetworkManager) no está instalado en este equipo", 409);
      if (edit.code !== 0) { await nm(["connection", "delete", "id", ssid], 6000); throw new DeviceError("no se ha podido guardar la red", 502); }
      const r = await nm(["--wait", "30", "connection", "up", "id", ssid, ...ifn], 35_000);
      if (r.code !== 0) {
        await nm(["connection", "delete", "id", ssid], 6000);   // nothing half-made stays behind
        let msg = wifiError(r);
        // some access points answer a wrong password by not answering at all
        if (needsPw && (msg === "esa red ya no está al alcance" || msg === "la red no ha respondido a tiempo") && seen) msg = "no se ha podido conectar: revisa la contraseña";
        throw new DeviceError(msg, /contraseña/.test(msg) ? 401 : 502);
      }
      await nm(["connection", "modify", "id", ssid, "connection.autoconnect", "yes"], 6000);
      return { ok: true, ssid };
    },

    async disconnectWifi() {
      const s = await nmState();
      if (!s.available || !s.wifiDev) throw new DeviceError("este equipo no tiene Wi-Fi", 409);
      const r = await nm(["device", "disconnect", s.wifiDev.device]);
      if (r.code !== 0) throw new DeviceError(wifiError(r), 502);
      return { ok: true };
    },

    async forgetWifi(ssidIn: unknown) {
      const ssid = checkSsid(ssidIn);
      const ks = (await knownNames()).filter((k) => k.name === ssid || k.name.startsWith(ssid + " "));
      if (!ks.length) throw new DeviceError("esa red no estaba guardada", 404);
      for (const k of ks) await nm(["connection", "delete", "id", k.name]);
      return { ok: true, forgotten: ks.length };
    },

    async setBluetooth(on: boolean) {
      const r = await run("bluetoothctl", ["power", on ? "on" : "off"], { timeoutMs: 6000 });
      if (r.missing) throw new DeviceError("este equipo no tiene Bluetooth (falta bluez)", 409);
      if (r.code !== 0 || /Failed|No default controller/i.test(r.out + r.err)) throw new DeviceError(/rfkill|Blocked/i.test(r.out + r.err) ? "el Bluetooth está bloqueado (modo avión)" : "no se ha podido cambiar el Bluetooth", 502);
      return { on };
    },

    async connectBluetooth(macIn: unknown, on: boolean) {
      const mac = checkMac(macIn);
      const r = await run("bluetoothctl", [on ? "connect" : "disconnect", mac], { timeoutMs: 20_000 });
      if (r.code !== 0 || /Failed|not available/i.test(r.out + r.err)) throw new DeviceError(on ? "no se ha podido conectar (¿está encendido y cerca?)" : "no se ha podido desconectar", 502);
      return { ok: true };
    },

    async setAirplane(on: boolean) {
      const r = await run("rfkill", [on ? "block" : "unblock", "all"], { timeoutMs: 4000 });
      if (r.missing) throw new DeviceError("este equipo no puede apagar sus radios (falta rfkill)", 409);
      if (r.code !== 0) throw new DeviceError("no se ha podido cambiar el modo avión", 502);
      return { on };
    },

    async setSound(v: { volume?: unknown; muted?: unknown }) {
      if (v.volume !== undefined) {
        const n = Math.round(Number(v.volume));
        if (!Number.isFinite(n)) throw new DeviceError("volumen no válido");
        const r = await run("wpctl", ["set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", String(Math.max(0, Math.min(100, n)) / 100)], { timeoutMs: 3000 });
        if (r.missing) throw new DeviceError("este equipo no tiene sonido (falta PipeWire)", 409);
        if (r.code !== 0) throw new DeviceError("no se ha podido cambiar el volumen", 502);
      }
      if (v.muted !== undefined) {
        const r = await run("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", v.muted ? "1" : "0"], { timeoutMs: 3000 });
        if (r.code !== 0) throw new DeviceError("no se ha podido silenciar", 502);
      }
      return sound();
    },

    async setBrightness(value: unknown) {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) throw new DeviceError("brillo no válido");
      // never fully dark: a black screen looks like a broken one
      const r = await run("brightnessctl", ["-q", "-c", "backlight", "set", `${Math.max(3, Math.min(100, n))}%`], { timeoutMs: 3000 });
      if (r.missing) throw new DeviceError("esta pantalla no deja cambiar el brillo desde NEXUS", 409);
      if (r.code !== 0) throw new DeviceError("no se ha podido cambiar el brillo", 502);
      return { value: Math.max(3, Math.min(100, n)) };
    },

    async setPowerMode(modeIn: unknown) {
      const mode = String(modeIn ?? "");
      if (!["power-saver", "balanced", "performance"].includes(mode)) throw new DeviceError("modo de energía no válido");
      const r = await run("powerprofilesctl", ["set", mode], { timeoutMs: 5000 });
      if (r.missing) throw new DeviceError("este equipo no tiene modos de energía (falta power-profiles-daemon)", 409);
      if (r.code !== 0) throw new DeviceError("no se ha podido cambiar el modo de energía", 502);
      return { mode };
    },

    async mediaAction(action: unknown) {
      const a = String(action ?? "");
      if (!["play-pause", "next", "previous"].includes(a)) throw new DeviceError("acción no válida");
      const r = await run("playerctl", [a], { timeoutMs: 3000 });
      if (r.code !== 0) throw new DeviceError("no hay nada reproduciéndose", 409);
      return { ok: true };
    },
  };
}
export type Devices = ReturnType<typeof createDevices>;
