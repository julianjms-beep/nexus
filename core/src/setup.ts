// First boot of a NEXUS OS release image: the pure rules behind the setup assistant (nexus-setup) and its root
// helper (setupd.ts). Nothing here touches the system; setupd.ts does, after these checks say yes.

export type Keyboard = { id: string; layout: string; variant?: string; name: string; sample: string };

/** The keyboards the assistant offers (XKB layout + variant). The first is the default. */
export const KEYBOARDS: Keyboard[] = [
  { id: "es", layout: "es", name: "Español (España)", sample: "ñ ç € @" },
  { id: "latam", layout: "latam", name: "Español (Latinoamérica)", sample: "ñ ¿ ¡ @" },
  { id: "es-cat", layout: "es", variant: "cat", name: "Català", sample: "ŀl ç à" },
  { id: "us", layout: "us", name: "English (US)", sample: "@ # $ ~" },
  { id: "gb", layout: "gb", name: "English (UK)", sample: "£ @ \" ~" },
  { id: "pt", layout: "pt", name: "Português (Portugal)", sample: "ç ã õ €" },
  { id: "br", layout: "br", name: "Português (Brasil)", sample: "ç ã õ" },
  { id: "fr", layout: "fr", name: "Français", sample: "é è à ç" },
  { id: "de", layout: "de", name: "Deutsch", sample: "ä ö ü ß" },
  { id: "it", layout: "it", name: "Italiano", sample: "è é à ù" },
];

export function keyboardById(id: unknown): Keyboard | undefined {
  return KEYBOARDS.find((k) => k.id === id);
}

/** Apple keyboards: the left Option key types like on macOS (Option+2 = @). Same rule as /usr/bin/nexus-session. */
export const APPLE_OPTIONS = "lv3:lalt_switch";
export function isAppleKeyboard(procInputDevices: string): boolean {
  return /^N: Name="Apple.*[Kk]eyboard/m.test(procInputDevices);
}

/** /etc/default/keyboard (Debian's format; nexus-session and the login screen read it). */
export function keyboardFile(k: Keyboard): string {
  return [
    "# Written by the NEXUS OS setup assistant. Change it in Ajustes or with: localectl set-x11-keymap <layout>",
    `XKBMODEL="pc105"`, `XKBLAYOUT="${k.layout}"`, `XKBVARIANT="${k.variant ?? ""}"`, `XKBOPTIONS=""`, `BACKSPACE="guess"`, "",
  ].join("\n");
}

/** labwc environment lines for a keyboard (labwc re-reads them on SIGHUP, so the layout changes at once). */
export function xkbEnv(k: Keyboard, apple: boolean): string {
  const lines = [`XKB_DEFAULT_LAYOUT=${k.layout}`];
  if (k.variant) lines.push(`XKB_DEFAULT_VARIANT=${k.variant}`);
  if (apple) lines.push(`XKB_DEFAULT_OPTIONS=${APPLE_OPTIONS}`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- the person's account

/** Groups of the person who uses the computer (missing ones are skipped by setupd). Same list as the dev image. */
export const SETUP_GROUPS = ["sudo", "video", "render", "input", "audio", "netdev", "bluetooth", "lpadmin", "nexus-shell", "nexus-update"];

/** Names that already mean something on a Debian system or in NEXUS and must never become a person's login. */
const RESERVED = new Set(["root", "admin", "nexus-engine", "nexus-agent", "daemon", "bin", "sys", "sync", "games", "man",
  "lp", "mail", "news", "uucp", "proxy", "www-data", "backup", "list", "irc", "nobody", "systemd-network",
  "systemd-resolve", "messagebus", "polkitd", "sshd", "_greetd", "greeter", "guest", "user", "sudo", "operator"]);

/** "Ana García López" -> "ana": first word, no accents, lowercase letters/digits only. */
export function suggestUsername(fullName: string): string {
  const first = String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
  const plain = first.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/ñ/g, "n").replace(/[^a-z0-9]/g, "");
  const name = plain.replace(/^[0-9]+/, "").slice(0, 24);
  return name || "usuario";
}

export type AccountInput = { fullName?: unknown; username?: unknown; password?: unknown; password2?: unknown };
export type Check = { ok: true } | { ok: false; field: "fullName" | "username" | "password" | "password2"; error: string };

/** The rules for the account the assistant creates. `taken`: login names already on this system. Messages in Spanish (shown as is). */
export function checkAccount(a: AccountInput, taken: Set<string> = new Set()): Check {
  const fullName = typeof a.fullName === "string" ? a.fullName.trim() : "";
  if (!fullName) return { ok: false, field: "fullName", error: "Escribe tu nombre." };
  if (fullName.length > 60 || /[:,=\\\n\r\t\0]/.test(fullName)) return { ok: false, field: "fullName", error: "El nombre no puede llevar «: , =» ni pasar de 60 letras." };
  const username = typeof a.username === "string" ? a.username : "";
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(username)) return { ok: false, field: "username", error: "El usuario va en minúsculas, sin espacios ni tildes, y empieza por una letra." };
  if (RESERVED.has(username) || username.startsWith("nexus") || taken.has(username)) return { ok: false, field: "username", error: "Ese nombre de usuario ya lo usa el sistema. Prueba otro." };
  const password = typeof a.password === "string" ? a.password : "";
  if ([...password].length < 6) return { ok: false, field: "password", error: "La contraseña necesita al menos 6 caracteres." };
  if (password.length > 256 || /[\n\r\0]/.test(password)) return { ok: false, field: "password", error: "La contraseña no puede llevar saltos de línea." };
  if (password.toLowerCase() === username || password.toLowerCase() === fullName.toLowerCase()) return { ok: false, field: "password", error: "Usa una contraseña distinta de tu nombre." };
  if (a.password2 !== undefined && a.password2 !== password) return { ok: false, field: "password2", error: "Las dos contraseñas no coinciden." };
  return { ok: true };
}

/** An Anthropic API key, or nothing. Same rule as the engine (core/src/os.ts setKey). */
export function checkClaudeKey(k: unknown): boolean {
  return typeof k === "string" && /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(k.trim());
}

/** Zone names as `timedatectl list-timezones` prints them: Area/City (letters, digits, _ + - /). */
export function checkTimezone(tz: unknown, available: string[]): tz is string {
  return typeof tz === "string" && /^[A-Za-z0-9_+\-/]{2,64}$/.test(tz) && !tz.includes("..") && available.includes(tz);
}

// ---------------------------------------------------------------- Wi-Fi (NetworkManager's nmcli, terse output)

export type Wifi = { ssid: string; signal: number; secure: boolean; active: boolean };

/** Splits one `nmcli -t` line: fields are separated by ':' and a ':' or '\' inside a field comes escaped with '\'. */
export function nmcliFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ":") { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list` -> networks, strongest first, one entry per name, hidden ones left out. */
export function parseWifiList(out: string): Wifi[] {
  const best = new Map<string, Wifi>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [inUse, ssid, signal, security] = nmcliFields(line);
    if (!ssid) continue;
    const w: Wifi = { ssid, signal: Math.max(0, Math.min(100, Number(signal) || 0)), secure: !!security && security !== "--", active: inUse === "*" };
    const prev = best.get(ssid);
    if (!prev || w.active || (!prev.active && w.signal > prev.signal)) best.set(ssid, w);
  }
  return [...best.values()].sort((a, b) => Number(b.active) - Number(a.active) || b.signal - a.signal);
}

/** A network name nmcli can take as one argument (any bytes but NUL/newline, 1-32 bytes as Wi-Fi allows). */
export function checkSsid(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && Buffer.byteLength(s) <= 32 && !/[\n\r\0]/.test(s);
}

/** WPA passwords are 8-63 characters (or 64 hex digits); open networks have none. */
export function checkWifiPassword(p: unknown): boolean {
  return p === "" || p === undefined || (typeof p === "string" && ((p.length >= 8 && p.length <= 63 && !/[\n\r\0]/.test(p)) || /^[0-9a-fA-F]{64}$/.test(p)));
}

// ---------------------------------------------------------------- straight into the new desktop

/** greetd's configuration for the one start after setup: the usual one plus an automatic first login of the new
 *  person (greetd only reads initial_session when it starts, and this file lives in /run, so it never happens again). */
export function firstLoginConfig(baseToml: string, user: string): string {
  if (!/^[a-z][a-z0-9_-]{0,30}$/.test(user)) throw new Error("bad user name");
  const base = baseToml.replace(/\n\[initial_session\][^[]*/g, "\n");
  return `${base.trimEnd()}\n\n# NEXUS setup: open the new desktop once, without asking for the password that was just chosen\n[initial_session]\ncommand = "/usr/bin/nexus-session"\nuser = "${user}"\n`;
}
