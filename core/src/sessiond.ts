// nexus-sessiond: per-user desktop session helper. Runs as the logged-in user, inside the Wayland session.
//
//   * Relays the Engine's shell events to the desktop shell (long-poll) and launches apps from a FIXED catalog
//     (app id -> argv defined here; the Engine and the AI can only name an id).
//   * Performs power actions only after a human click: an Engine confirmation the person approved in the shell's
//     dialog, or the shell's own power menu. The Engine never powers anything off by itself.
//   * Proxies the shell's AI / status / settings calls to the Engine, so the QML shell never holds the Engine token.
// Listens on 127.0.0.1 only; bearer token in $XDG_RUNTIME_DIR/nexus/session.token (0600); Host/Origin checked.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createFiles } from "./files.ts";
import { Automations, type Services } from "./automations.ts";
import type { ConnectorInfo } from "./connect.ts";
import { localServers } from "./ports.ts";
import { Agents, AGENT_DRAFT_SCHEMA, AGENT_DRAFT_PROMPT, fromAgentDraft, costUsd } from "./agentd.ts";
import { Agencies, AgencyError } from "./agency.ts";
import { createDevices, DeviceError, type Runner } from "./devices.ts";
import { createWallpapers } from "./wallpaper.ts";
import { checkup, exposedListeners, type RootFacts } from "./guard.ts";
import { Store, profileName } from "./store.ts";
import { LinuxApps, humanSize, type Run as LinuxRun } from "./linuxapps.ts";
import { Mail, MailError } from "./mail.ts";
import { PROVIDERS, isProvider, checkKey, providerSearch, SearchError, wikiSearchUrl, parseWikiSearch, calc, answerRequest, parseAnswer, ANSWER_MODEL, type ProviderId, type WebResult } from "./websearch.ts";
import { PageIndex, settingsMatches, tokenize, fold, wikiQueryUrl, parseWiki, suggestUrl, parseSuggest } from "./search.ts";
import { Notices, checkNotice } from "./notices.ts";

// `window`: wlrctl match spec (exact app_id / title) of the app's window, used to bring an already open (or minimized)
// window to the front instead of starting a second copy.
const QML = "app_id:org.qt-project.qml";
export const SETTINGS_PAGES = ["apariencia", "fondo", "wifi", "bluetooth", "bateria", "sonido", "pantalla", "teclado", "cuenta", "ai", "buscador", "terminal", "seguridad", "actualizaciones", "acerca"];
// `needs`: a program that is not part of NEXUS itself (VS Code, from Microsoft's package): the app only exists while
// that file does (GET /apps leaves it out, launching it says so), e.g. on a NEXUS updated from before it came in the image.
export type CatalogApp = { name: string; icon: string; argv: string[]; single: boolean; window: string[]; needs?: string };
export const CATALOG: Record<string, CatalogApp> = {
  terminal: { name: "Terminal", icon: "terminal", argv: ["nexus-terminal"], single: false, window: ["app_id:foot"] },
  files: { name: "Archivos", icon: "files", argv: ["nexus-app", "Files"], single: false, window: [QML, "title:Archivos"] },
  editor: { name: "Notas", icon: "editor", argv: ["nexus-app", "Notes"], single: false, window: [QML, "title:Notas"] },
  // /usr/local/bin/code = Microsoft's `code` as a native Wayland window (see that file)
  code: { name: "VS Code", icon: "code", argv: ["/usr/local/bin/code"], single: true, window: ["app_id:com.microsoft.VSCode"], needs: "/usr/bin/code" },
  browser: { name: "Navegador", icon: "browser", argv: ["nexus-app", "Browser"], single: true, window: [QML, "title:Navegador"] },
  automations: { name: "Automatizaciones", icon: "automations", argv: ["nexus-app", "Automations"], single: true, window: [QML, "title:Automatizaciones"] },
  connect: { name: "Conexiones", icon: "connect", argv: ["nexus-app", "Connect"], single: true, window: [QML, "title:Conexiones"] },
  agents: { name: "Agentes", icon: "agents", argv: ["nexus-app", "Agents"], single: true, window: [QML, "title:Agentes"] },
  monitor: { name: "Monitor", icon: "monitor", argv: ["nexus-app", "Monitor"], single: true, window: [QML, "title:Monitor"] },
  mail: { name: "Mail", icon: "mail", argv: ["nexus-app", "Mail"], single: true, window: [QML, "title:NEXUS Mail"] },
  store: { name: "Store", icon: "store", argv: ["nexus-app", "Store"], single: true, window: [QML, "title:NEXUS Store"] },
  settings: { name: "Ajustes", icon: "settings", argv: ["nexus-app", "Settings"], single: true, window: [QML, "title:Ajustes"] },
};
// Friendly names for NEXUS's own processes in the Monitor (derived from the command line, which is never sent out).
const APP_FILES: Record<string, string> = { Files: "Archivos", Notes: "Notas", Monitor: "Monitor", Settings: "Ajustes", Browser: "Navegador", Automations: "Automatizaciones", Connect: "Conexiones", Agents: "Agentes", Store: "Store", WebApp: "App web", Mail: "Mail" };
export function friendlyName(comm: string, cmdline: string): string {
  if (cmdline.includes("/usr/share/nexus/shell/Main.qml")) return "Escritorio NEXUS";
  const app = /\/usr\/share\/nexus\/apps\/(\w+)\.qml/.exec(cmdline);
  if (app && Object.hasOwn(APP_FILES, app[1])) return APP_FILES[app[1]];
  if (/^\/usr\/share\/code\/code\0/.test(cmdline)) return "VS Code";
  if (/core\/src\/server\.ts/.test(cmdline)) return "Motor NEXUS";
  if (/core\/src\/sessiond\.ts/.test(cmdline)) return "Sesión NEXUS";
  if (comm === "MainThread" && /(^|\/)node\0/.test(cmdline)) return "node";
  if (/^QtWebEngineProc/.test(comm)) return "Navegador (páginas)";
  return comm;
}
/** Keyboard layouts Ajustes → Teclado offers (XKB names; the list stays short on purpose). */
export const KEYBOARD_LAYOUTS: { id: string; name: string }[] = [
  { id: "es", name: "Español (España)" }, { id: "latam", name: "Español (Latinoamérica)" }, { id: "us", name: "Inglés (EE. UU.)" }, { id: "gb", name: "Inglés (Reino Unido)" },
  { id: "fr", name: "Francés" }, { id: "de", name: "Alemán" }, { id: "it", name: "Italiano" }, { id: "pt", name: "Portugués (Portugal)" }, { id: "br", name: "Portugués (Brasil)" },
];
export const POWER: Record<string, string[]> = {
  lock: ["nexus-lock"], logout: ["labwc", "--exit"], reboot: ["systemctl", "reboot"], poweroff: ["systemctl", "poweroff"],
};
// Weather for the desktop widget: Open-Meteo (free, no account). Only the city's coordinates are sent.
export const CITIES: Record<string, { name: string; lat: number; lon: number }> = {
  madrid: { name: "Madrid", lat: 40.4168, lon: -3.7038 }, barcelona: { name: "Barcelona", lat: 41.3874, lon: 2.1686 },
  valencia: { name: "Valencia", lat: 39.4699, lon: -0.3763 }, sevilla: { name: "Sevilla", lat: 37.3891, lon: -5.9845 },
  zaragoza: { name: "Zaragoza", lat: 41.6488, lon: -0.8891 }, murcia: { name: "Murcia", lat: 37.9922, lon: -1.1307 },
  malaga: { name: "Málaga", lat: 36.7213, lon: -4.4214 }, bilbao: { name: "Bilbao", lat: 43.263, lon: -2.935 },
};
/** WMO weather code -> Spanish label, emoji and NEXUS icon (`glyph`: usr/share/nexus/icons/weather-<glyph>.svg, drawn
 *  by os/art/make-weather-icons.py; the desktop card uses it and falls back to the emoji). Day/night aware. */
export function describeWeather(code: number, isDay: boolean): { text: string; icon: string; glyph: string } {
  const dn = isDay ? "day" : "night";
  if (code === 0) return { text: "Despejado", icon: isDay ? "☀️" : "🌙", glyph: isDay ? "sun" : "moon" };
  if (code <= 2) return { text: "Poco nuboso", icon: isDay ? "⛅" : "☁️", glyph: `partly-${dn}` };
  if (code === 3) return { text: "Cubierto", icon: "☁️", glyph: "cloud" };
  if (code === 45 || code === 48) return { text: "Niebla", icon: "🌫️", glyph: "fog" };
  if (code >= 51 && code <= 57) return { text: "Llovizna", icon: "🌦️", glyph: `showers-${dn}` };
  if (code >= 61 && code <= 67) return { text: "Lluvia", icon: "🌧️", glyph: "rain" };
  if (code >= 71 && code <= 77) return { text: "Nieve", icon: "❄️", glyph: "snow" };
  if (code >= 80 && code <= 82) return { text: "Chubascos", icon: "🌦️", glyph: `showers-${dn}` };
  if (code === 85 || code === 86) return { text: "Chubascos de nieve", icon: "🌨️", glyph: "snow" };
  if (code >= 95) return { text: "Tormenta", icon: "⛈️", glyph: "storm" };
  return { text: "—", icon: "🌡️", glyph: "cloud" };
}
/** The lock screen's NEXUS AI card. Only a count and the weather: the tasks' text never shows on a locked screen. */
export function lockGreeting(openTasks: number, w: { temp?: unknown; city?: unknown } | null, hour: number): string {
  const hello = hour >= 6 && hour < 14 ? "Buenos días" : hour >= 14 && hour < 21 ? "Buenas tardes" : "Buenas noches";
  const tasks = openTasks <= 0 ? "No tienes tareas pendientes" : openTasks === 1 ? "Tienes 1 tarea pendiente" : `Tienes ${openTasks} tareas pendientes`;
  const sky = w && Number.isFinite(Number(w.temp)) && typeof w.city === "string" ? ` y hace ${Math.round(Number(w.temp))}° en ${w.city}` : "";
  return `${hello}. ${tasks}${sky}.`;
}
/** labwc title bars for the light theme (the dark ones are the NEXUS theme itself). Written to themerc-override. */
export const WM_LIGHT_HEADER = "# Written by NEXUS (Ajustes → Tema → Claro). Removed again with the dark theme; edit a copy, not this file.";
export const WM_LIGHT_THEME = [
  WM_LIGHT_HEADER,
  "window.active.border.color: #d5d9e6", "window.inactive.border.color: #e1e4ee",
  "window.active.title.bg.color: #f4f6fb", "window.inactive.title.bg.color: #eceef5",
  "window.active.label.text.color: #151a2b", "window.inactive.label.text.color: #8a90a8",
  "window.active.button.unpressed.image.color: #3b4160", "window.inactive.button.unpressed.image.color: #a0a6bd",
  "window.active.button.hover.bg.color: #e3e6f0",
  "menu.items.bg.color: #ffffff", "menu.items.text.color: #151a2b", "menu.border.color: #d5d9e6",
  "osd.bg.color: #ffffff", "osd.border.color: #d5d9e6", "osd.label.text.color: #151a2b",
  "window.active.shadow.color: #00000030", "window.inactive.shadow.color: #00000018",
  "",
].join("\n");
export const CC_MODULES = ["concentracion", "oscuro", "animaciones", "pantalla", "sonido", "musica", "energia"];
export const LOCK_AFTER = [0, 1, 2, 5, 10, 15, 30, 60];
export const TERM_FONTS = ["JetBrains Mono", "JetBrains Mono NL", "DejaVu Sans Mono"];
export const TERM_THEMES = ["auto", "oscuro", "claro", "oceano", "grafito"];
const PREF_KEYS: Record<string, (v: unknown) => boolean> = {
  theme: (v) => v === "dark" || v === "light",
  city: (v) => v === "off" || (typeof v === "string" && Object.hasOwn(CITIES, v)),
  accent: (v) => typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v),
  clock24: (v) => typeof v === "boolean",
  scale: (v) => v === "auto" || v === 1 || v === 1.25 || v === 1.5 || v === 2,   // interface size (nexus-display)
  animations: (v) => typeof v === "boolean",   // window animations (labwc) and the desktop's own motion
  dnd: (v) => typeof v === "boolean",          // No molestar: notices only go to Ajustes rápidos (warnings still show)
  layout: (v) => v === "barra" || v === "clasico",   // the desktop: one bar at the bottom (default) or top bar + dock
  searchWeb: (v) => v === "auto" || v === "manual" || v === "off",   // NEXUS Search: Claude's web results on every search, on request, or never
  searchMemory: (v) => typeof v === "boolean",   // NEXUS Search remembers the pages visited (only on this computer)
  lockAfter: (v) => typeof v === "number" && LOCK_AFTER.includes(v),   // minutes left alone before the screen locks (0 = never; nexus-idle)
  // Ajustes → Terminal (usr/bin/nexus-terminal reads them when a window opens)
  termFont: (v) => typeof v === "string" && TERM_FONTS.includes(v),
  termSize: (v) => typeof v === "number" && Number.isInteger(v) && v >= 9 && v <= 20,
  termTheme: (v) => typeof v === "string" && TERM_THEMES.includes(v),
  termCursor: (v) => v === "beam" || v === "block" || v === "underline",
  termWelcome: (v) => typeof v === "boolean",   // the greeting with what is installed and the shortcuts
  termSuggest: (v) => typeof v === "boolean",   // suggestions from the history while typing
  // Control Center → «Editar controles»: the tiles the person hid (Wi-Fi/Bluetooth/airplane always stay)
  ccHidden: (v) => Array.isArray(v) && v.length <= CC_MODULES.length && new Set(v).size === v.length && v.every((x) => typeof x === "string" && CC_MODULES.includes(x)),
};
// NEXUS Search: words that find each app besides its name
const APP_SEARCH_WORDS: Record<string, string> = {
  terminal: "terminal consola shell comandos", files: "archivos ficheros carpetas explorador documentos", editor: "notas editor texto apuntes",
  code: "vs code visual studio codigo programar editor", browser: "navegador web internet safari", automations: "automatizaciones tareas programadas cron",
  connect: "conexiones servicios cuentas integraciones gohighlevel ghl wiwink webhook crm facturas api",
  mail: "mail correo email gmail icloud mensajes bandeja", store: "store tienda apps aplicaciones whatsapp instalar webs",
  agents: "agentes ia programador", monitor: "monitor sistema procesos rendimiento memoria cpu", settings: "ajustes configuracion preferencias opciones",
};

/** Who is using this desktop: login name and the full name from /etc/passwd (the start menu shows it). */
export function whoAmI(passwd: string, user: string): { user: string; name: string } {
  for (const l of passwd.split("\n")) {
    const f = l.split(":");
    if (f[0] === user) { const name = (f[4] ?? "").split(",")[0].trim(); return { user, name: name || user }; }
  }
  return { user, name: user };
}

type Ev = { seq: number; kind: string; data: Record<string, unknown> };
export type SessionOptions = {
  engineUrl: string;
  engineToken: () => string;
  runtimeDir: string;
  configDir: string;
  port?: number;
  spawnFn?: (argv: string[]) => { pid?: number; onExit: (cb: () => void) => void };
  /** Bring a window matching the spec to the front (un-minimizing it). Resolves false when no window matches. */
  focusFn?: (match: string[]) => Promise<boolean>;
  /** Open windows as "app_id: title" lines (wlrctl toplevel list), or null when the compositor cannot be asked. */
  listFn?: () => Promise<string[] | null>;
  /** The active window as "app_id: title" ("" none, null: cannot ask). Defaults to wlrctl. */
  focusedFn?: () => Promise<string | null>;
  /** How often the menu bar's active window is checked (ms). */
  focusPollMs?: number;
  /** Press a shortcut in the active window (wtype arguments from wtypeArgs). */
  keysFn?: (args: string[]) => void;
  /** minimize / maximize / fullscreen / close the active window. */
  windowFn?: (action: string) => Promise<boolean>;
  /** Whether a catalog app's `needs` file exists (tests); defaults to fs.existsSync. */
  existsFn?: (file: string) => boolean;
  /** NEXUS Store → Linux apps: how `flatpak` is run and how Flathub is asked (tests replace both) */
  linuxRun?: LinuxRun;
  linuxFetch?: typeof fetch;
  /** How often the open windows are checked for the dock's "running" dots (ms). */
  windowPollMs?: number;
  /** HTTP GET returning parsed JSON (weather). Defaults to fetch with a 10 s timeout. */
  fetchJson?: (url: string) => Promise<any>;
  /** How often the weather is refreshed (ms). */
  weatherEveryMs?: number;
  /** labwc's config folder (window title bars follow the light/dark theme). Default: ~/.config/labwc next to configDir. */
  wmConfigDir?: string;
  /** Make the compositor re-read its theme. Default: SIGHUP to this user's labwc. */
  reconfigureFn?: () => void;
  /** Apply the interface size (Wayland output scale). Default: nexus-display with the new value. */
  displayFn?: (scale: string) => void;
  /** The person's home folder (Archivos works only inside it). Default: $HOME. */
  homeDir?: string;
  /** Where the Papelera lives ($XDG_DATA_HOME). Default: ~/.local/share. */
  dataDir?: string;
  /** Runs nmcli, bluetoothctl, wpctl… for the menu bar's Wi-Fi, battery and Control Center (tests pass a fake). */
  devicesRun?: Runner;
  /** /sys/class/power_supply (tests). */
  powerSupplyDir?: string;
  /** Agencias scheduler tick in ms; 0 = no timer (tests). Default 20 s. */
  agencyTickMs?: number;
  /** NEXUS's wallpaper collection (index.json from os/art/make-wallpapers.py). Default: /usr/share/nexus/wallpapers. */
  wallpaperDir?: string;
  /** Clock for the wallpapers that change with the hour or in a slideshow (tests). */
  now?: () => Date;
  /** nexus-updated's socket (NEXUS Update, core/src/updated.ts). Default: /run/nexus-update/updated.sock. */
  updateSocket?: string;
  /** nexus-guardd's socket (NEXUS Guard, core/src/guardd.ts). Default: /run/nexus-guard/guard.sock. */
  guardSocket?: string;
  /** /proc (tests): the listening sockets Privacidad y seguridad reports. */
  procDir?: string;
  /** HTTP GET returning parsed JSON for NEXUS Search's Wikipedia panel (identifies itself as NEXUS OS). */
  searchFetchJson?: (url: string) => Promise<any>;
  /** Runs the mail helper (tests pass a fake). */
  mailRun?: Runner;
  /** fetch for the search provider (Brave, Tavily) — tests pass a fake. */
  providerFetch?: typeof fetch;
};
type Task = { id: string; text: string; done: boolean; created: string; doneAt?: string };

function defaultSpawn(argv: string[]) {
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", env: process.env, cwd: process.env.HOME || "/" }); // apps start in the home folder
  child.on("error", () => { /* reported via exit */ });
  child.unref();
  return { pid: child.pid, onExit: (cb: () => void) => { child.on("exit", cb); child.on("error", cb); } };
}
/** Runs a program to its end, handing over each line it prints as it comes (flatpak's progress). */
const defaultLinuxRun: LinuxRun = (argv, onLine) => new Promise((resolve) => {
  let out = "", rest = "";
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C.UTF-8" } });
  const take = (d: Buffer) => {
    const t = d.toString("utf8"); if (out.length < 200000) out += t;
    const parts = (rest + t).split(/[\r\n]/); rest = parts.pop() ?? "";
    for (const l of parts) if (l.trim()) onLine?.(l);
  };
  child.stdout.on("data", take); child.stderr.on("data", take);
  child.on("error", () => resolve({ code: 127, out }));
  child.on("close", (code) => resolve({ code: code ?? 1, out }));
});
function defaultList(): Promise<string[] | null> {
  return new Promise((resolve) => execFile("wlrctl", ["toplevel", "list"], { timeout: 3000 }, (err, out) => resolve(err ? null : out.split("\n").filter(Boolean))));
}
/** Does a window line ("app_id: title") match a wlrctl spec (exact app_id / title)? */
export function windowMatches(line: string, spec: string[]): boolean {
  const i = line.indexOf(": "); const appId = i < 0 ? line : line.slice(0, i), title = i < 0 ? "" : line.slice(i + 2);
  return spec.every((m) => m.startsWith("app_id:") ? appId === m.slice(7) : m.startsWith("title:") ? title === m.slice(6) : false);
}
// ---- the menu bar (shell/MenuBar.qml): which window is active, and its menus' shortcuts and window actions
/** The active window as "app_id: title", or "" when none (desktop, lock screen). */
function defaultFocused(): Promise<string | null> {
  return new Promise((resolve) => execFile("wlrctl", ["toplevel", "list", "state:focused"], { timeout: 3000 }, (err, out) => resolve(err ? null : (out.split("\n").find(Boolean) ?? ""))));
}
/** What the menu bar shows for a window line: the catalog app it is (if any), its app_id, title and a display name. */
export function describeFocus(line: string): { app: string; appId: string; title: string; name: string } {
  if (!line) return { app: "", appId: "", title: "", name: "" };
  const i = line.indexOf(": "); const appId = i < 0 ? line : line.slice(0, i), title = i < 0 ? "" : line.slice(i + 2);
  for (const [id, a] of Object.entries(CATALOG)) {
    if (windowMatches(line, a.window)) return { app: id, appId, title, name: a.name };
  }
  // someone else's app: the last part of its id ("org.gnome.Calculator" -> "Calculator"), else its title
  const last = appId.split(".").filter(Boolean).pop() ?? "";
  const name = last && last !== "qml" ? last.charAt(0).toUpperCase() + last.slice(1) : title || "App";
  return { app: "", appId, title, name: name.slice(0, 40) };
}
/** A menu's shortcut ("ctrl+shift+c", "super+Up", "F11") as wtype arguments: modifiers held, the key, modifiers let go.
 *  Only these modifiers and keys exist, so the shell can never make sessiond type text or anything else. */
const WTYPE_MODS: Record<string, string> = { ctrl: "ctrl", shift: "shift", alt: "alt", super: "logo" };
const NAMED_KEYS = new Set(["Return", "Escape", "Tab", "space", "BackSpace", "Delete", "Left", "Right", "Up", "Down", "Home", "End",
  "Prior", "Next", "plus", "minus", "equal", "grave", "comma", "period", "slash", "bracketleft", "bracketright"]);
export function wtypeArgs(combo: unknown): string[] | null {
  if (typeof combo !== "string" || combo.length > 40) return null;
  const parts = combo.split("+"); const key = parts.pop()!; const mods = parts;
  if (mods.some((m) => !Object.hasOwn(WTYPE_MODS, m)) || new Set(mods).size !== mods.length) return null;
  if (!/^[a-z0-9]$/.test(key) && !NAMED_KEYS.has(key) && !/^F([1-9]|1[0-2])$/.test(key)) return null;
  return [...mods.flatMap((m) => ["-M", WTYPE_MODS[m]]), "-k", key, ...[...mods].reverse().flatMap((m) => ["-m", WTYPE_MODS[m]])];
}
export const WINDOW_ACTIONS = ["minimize", "maximize", "fullscreen", "close"];
function defaultFocus(match: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile("wlrctl", ["toplevel", "focus", ...match], { timeout: 3000 }, (err) => resolve(!err)));
}

export function createSession(o: SessionOptions) {
  fs.mkdirSync(o.runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(o.configDir, { recursive: true });
  const tokenFile = path.join(o.runtimeDir, "session.token");
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile + ".tmp", token, { mode: 0o600 }); fs.renameSync(tokenFile + ".tmp", tokenFile);
  const prefsFile = path.join(o.configDir, "prefs.json");
  const spawnFn = o.spawnFn ?? defaultSpawn;
  const focusFn = o.focusFn ?? defaultFocus;
  const listFn = o.listFn ?? defaultList;
  const existsFn = o.existsFn ?? fs.existsSync;
  const focusedFn = o.focusedFn ?? defaultFocused;
  const keysFn = o.keysFn ?? ((args: string[]) => { spawnFn(["wtype", ...args]); });
  const windowFn = o.windowFn ?? ((action: string) => new Promise<boolean>((resolve) => execFile("wlrctl", ["toplevel", action, "state:focused"], { timeout: 3000 }, (err) => resolve(!err))));
  const installed = (id: string) => Object.hasOwn(CATALOG, id) && (!CATALOG[id].needs || existsFn(CATALOG[id].needs!));
  const installedApps = () => Object.entries(CATALOG).filter(([id]) => installed(id));

  // ---- local event buffer for the shell
  let seq = 0; const events: Ev[] = []; const waiters = new Set<() => void>();
  // the notification centre's memory (core/src/notices.ts): every "notice" event is kept there, with an id, so the
  // bell in the bar and shell/NotificationCenter.qml show what came before this shell started
  const notices = new Notices(path.join(o.dataDir ?? path.join(o.homeDir ?? process.env.HOME ?? os.homedir(), ".local", "share"), "nexus", "notices.json"));
  const push = (kind: string, data: Record<string, unknown>) => {
    if (kind === "notice") { try { data = { ...notices.add(data as { text: unknown }) }; } catch { return; } }
    events.push({ seq: ++seq, kind, data }); if (events.length > 200) events.splice(0, events.length - 200);
    for (const w of waiters) w(); waiters.clear();
  };
  const poll = async (since: number, wait: number) => {
    if (since < 0) return { head: seq, events: [] as Ev[] }; // a (re)starting shell asks for the current head only
    if (since > seq) since = 0;
    const pick = () => events.filter((e) => e.seq > since);
    if (!pick().length && wait > 0) await new Promise<void>((r) => { const done = () => { clearTimeout(t); r(); }; const t = setTimeout(() => { waiters.delete(done); r(); }, wait); t.unref(); waiters.add(done); });
    return { head: seq, events: pick() };
  };

  // ---- apps
  const running = new Map<string, Set<number>>();          // processes we started
  const windowsOpen = new Set<string>();                     // apps with a window on screen (asked to the compositor)
  const isRunning = (id: string) => windowsOpen.has(id) || (running.get(id)?.size ?? 0) > 0;
  // ---- virtual desktops and the window overview (shell/Overview.qml, Súper+Tab). labwc keeps the desktops but has
  // no way to ask about them, so this is NEXUS's own book: which desktop is current (every switch goes through here:
  // the Súper+1…4 keys run `nexusctl desktop N`), and on which desktop each window lives — a window is noted on the
  // desktop that was current when it first appeared, and moves when the person moves it here. labwc does the
  // switching through hidden key bindings (XF86Launch5…8 go to a desktop, XF86LaunchA…D send the active window to
  // one) that nexus-sessiond presses with wtype: the compositor runs its own actions, nothing is faked.
  const DESKTOPS = 4;
  const GO_KEYS = ["XF86Launch5", "XF86Launch6", "XF86Launch7", "XF86Launch8"], SEND_KEYS = ["XF86LaunchA", "XF86LaunchB", "XF86LaunchC", "XF86LaunchD"];
  let currentDesktop = 1;
  // two windows can read the same ("foot: Terminal" twice): the book keys them by line and occurrence ("line#0",
  // "line#1"), so a second terminal opened on desktop 2 is noted there, not where the first one is
  const windowDesk = new Map<string, number>();   // "app_id: title#n" -> desktop
  let lastLines: string[] = [];
  const keyed = (lines: string[]) => { const seen = new Map<string, number>(); return lines.map((l) => { const n = seen.get(l) ?? 0; seen.set(l, n + 1); return `${l}#${n}`; }); };
  const desktopOf = (key: string) => windowDesk.get(key) ?? currentDesktop;
  const windowList = () => keyed(lastLines).map((key, i) => { const line = lastLines[i]; return { line, ...describeFocus(line), icon: CATALOG[describeFocus(line).app]?.icon ?? "", focused: line === focusLine, desktop: desktopOf(key) }; });
  const desktopsView = () => ({ count: DESKTOPS, current: currentDesktop, windows: windowList() });
  const parseDesktop = (to: unknown): number => {
    if (to === "left") return currentDesktop > 1 ? currentDesktop - 1 : DESKTOPS;
    if (to === "right") return currentDesktop < DESKTOPS ? currentDesktop + 1 : 1;
    const n = Number(to); if (!Number.isInteger(n) || n < 1 || n > DESKTOPS) throw new Error("unknown desktop");
    return n;
  };
  const goToDesktop = (to: unknown) => {
    const n = parseDesktop(to);
    if (n !== currentDesktop) { keysFn(["-k", GO_KEYS[n - 1]]); currentDesktop = n; }
    push("desktops", desktopsView()); return desktopsView();
  };
  /** The window with that exact "app_id: title" line: focused, closed, or sent to a desktop (stays there, the view does not follow). */
  const windowOp = async (line: string, action: string, to?: unknown) => {
    if (!lastLines.includes(line)) throw new Error("no such window");
    const i = line.indexOf(": "); const match = [`app_id:${i < 0 ? line : line.slice(0, i)}`, `title:${i < 0 ? "" : line.slice(i + 2)}`];
    const key = keyed(lastLines)[lastLines.indexOf(line)];   // the first window with that line (wlrctl focuses that one too)
    if (action === "focus") { const target = desktopOf(key); if (target !== currentDesktop) goToDesktop(target); return { ok: await focusFn(match) }; }
    if (action === "move") {
      const n = parseDesktop(to);
      if (!(await focusFn(match))) return { ok: false };
      keysFn(["-k", SEND_KEYS[n - 1]]); windowDesk.set(key, n); push("desktops", desktopsView()); return { ok: true };
    }
    if (!WINDOW_ACTIONS.includes(action)) throw new Error("unknown window action");
    if (!(await focusFn(match))) return { ok: false };
    return { ok: await windowFn(action) };
  };
  const checkWindows = async () => {
    const lines = await listFn(); if (!lines) return;
    for (const [id, a] of Object.entries(CATALOG)) {
      const open = lines.some((l) => windowMatches(l, a.window)), was = windowsOpen.has(id);
      if (open === was) continue;
      if (open) windowsOpen.add(id); else windowsOpen.delete(id);
      push("app", { app: id, running: isRunning(id) });
    }
    const changed = lines.length !== lastLines.length || lines.some((l, i) => l !== lastLines[i]);
    if (changed) {
      const keys = keyed(lines);
      for (const k of keys) if (!windowDesk.has(k)) windowDesk.set(k, currentDesktop);
      for (const k of [...windowDesk.keys()]) if (!keys.includes(k)) windowDesk.delete(k);
      lastLines = lines; push("desktops", desktopsView());
    }
  };
  // the menu bar: the active window, told to the shell only when it changes
  let focusLine = "";
  const checkFocus = async () => {
    const line = await focusedFn(); if (line === null || line === focusLine) return;
    focusLine = line; push("focus", describeFocus(line));
  };
  // `folder` (Archivos only): open it at that folder of the person's home, e.g. NEXUS AI's "Enséñame 2026"
  const launch = async (app: string, by: string, folder?: unknown, page?: unknown) => {
    if (!Object.hasOwn(CATALOG, app)) throw new Error(`unknown app ${app}`);
    const a = CATALOG[app];
    if (!installed(app)) throw new Error(`${a.name} no está instalado`);
    const dir = folder === undefined || folder === null || folder === "" ? undefined : app === "files" ? files.folder(folder) : undefined;
    if (folder && app !== "files") throw new Error("only Archivos opens folders");
    // Ajustes can open at one of its pages (the desktop's "Cambiar el fondo…")
    const pg = page === undefined || page === null || page === "" ? undefined : String(page);
    if (pg !== undefined && (app !== "settings" || !SETTINGS_PAGES.includes(pg))) throw new Error("unknown page");
    // Already open (whoever opened it: us, a key binding, or a previous sessiond): bring its window back, also when
    // minimized, rather than opening another copy. The compositor is asked every time; our own list can be stale.
    if (await focusFn(a.window)) {
      push("app", { app, running: true, focus: true });
      if (dir) push("reveal", { path: dir }); // the open Archivos window goes there
      if (pg) push("ui", { panel: "settings", text: pg }); // the open Ajustes window goes to that page
      return { app, focused: true };
    }
    if (a.single && running.get(app)?.size) return { app, already: true }; // still starting: its window will appear by itself
    const h = spawnFn(dir ? [...a.argv, dir] : pg ? [...a.argv, pg] : a.argv);
    if (h.pid) {
      const set = running.get(app) ?? new Set(); set.add(h.pid); running.set(app, set);
      h.onExit(() => { set.delete(h.pid!); push("app", { app, running: isRunning(app) }); });
    }
    push("app", { app, running: true, by });
    return { app, pid: h.pid };
  };
  const power = (action: string) => {
    if (!Object.hasOwn(POWER, action)) throw new Error(`unknown power action ${action}`);
    push("power", { action });
    spawnFn(POWER[action]);
    return { ok: true, action };
  };

  // ---- prefs (only known keys, validated)
  const readPrefs = (): Record<string, unknown> => { try { return JSON.parse(fs.readFileSync(prefsFile, "utf8")); } catch { return {}; } };
  const writePrefs = (patch: Record<string, unknown>) => {
    const cur = readPrefs();
    for (const [k, v] of Object.entries(patch ?? {})) {
      const check = Object.hasOwn(PREF_KEYS, k) ? PREF_KEYS[k] : Object.hasOwn(wallpapers.validate, k) ? wallpapers.validate[k] : null;
      if (!check) throw new Error(`unknown preference ${k}`);
      if (!check(v)) throw new Error(`invalid value for ${k}`);
      cur[k] = v;
    }
    fs.writeFileSync(prefsFile + ".tmp", JSON.stringify(cur, null, 2)); fs.renameSync(prefsFile + ".tmp", prefsFile);
    push("prefs", cur);
    if (Object.hasOwn(patch ?? {}, "city")) refreshWeather().catch(() => {});
    if (Object.hasOwn(patch ?? {}, "theme")) syncWmTheme();
    if (Object.hasOwn(patch ?? {}, "scale")) display(String(cur.scale));
    if (Object.hasOwn(patch ?? {}, "animations")) syncAnimations();
    // the automatic lock reads its minutes when it starts
    if (Object.hasOwn(patch ?? {}, "lockAfter")) { spawnFn(["systemctl", "--user", "restart", "nexus-idle.service"]); push("security", {}); }
    if (Object.keys(patch ?? {}).some((k) => k === "theme" || k === "accentAuto" || Object.hasOwn(wallpapers.validate, k))) publishWallpaper();
    return cur;
  };

  // ---- wallpaper (core/src/wallpaper.ts): what is on screen now; the desktop and the lock screen follow it. Checked
  //      every 20 s too, for the pictures that change with the hour and the slideshows.
  const homeForWall = o.homeDir ?? process.env.HOME ?? os.homedir();
  const wallpapers = createWallpapers({ dir: o.wallpaperDir ?? "/usr/share/nexus/wallpapers", home: homeForWall, readPrefs: () => readPrefs(), now: o.now });
  let lastWall = "";
  const publishWallpaper = () => {
    const r = wallpapers.resolve();
    const key = JSON.stringify(r);
    if (key !== lastWall) { lastWall = key; push("wallpaper", r); }
    // "Color de acento a juego": the accent follows the picture (stored, so every app starts with it)
    const p = readPrefs();
    if (p.accentAuto === true && r.accent && r.accent !== p.accent) writePrefs({ accent: r.accent });
    return r;
  };

  // ---- window animations: NEXUS's labwc looks for ~/.config/nexus/no-animations before each one. Only the switch in
  //      Ajustes decides it; with no choice made yet, a file the person created by hand is left alone.
  const noAnimationsFile = path.join(o.configDir, "no-animations");
  const syncAnimations = () => {
    const want = readPrefs().animations;
    if (want === false && !fs.existsSync(noAnimationsFile)) {
      fs.mkdirSync(o.configDir, { recursive: true });
      fs.writeFileSync(noAnimationsFile, "Ajustes → Apariencia → Animaciones está apagado.\n");
    } else if (want === true) fs.rmSync(noAnimationsFile, { force: true });
  };
  syncAnimations();

  const display = o.displayFn ?? ((scale: string) => { execFile("nexus-display", [scale], { timeout: 10000 }, () => {}); });

  // ---- window title bars follow the theme: labwc themerc-override, only ever the file NEXUS wrote itself
  const wmDir = o.wmConfigDir ?? path.join(path.dirname(o.configDir), "labwc");
  const wmFile = path.join(wmDir, "themerc-override");
  const reconfigure = o.reconfigureFn ?? (() => { execFile("pkill", ["-HUP", "-x", "-U", String(process.getuid?.() ?? ""), "labwc"], () => {}); });
  const syncWmTheme = () => {
    let cur: string | null = null;
    try { cur = fs.readFileSync(wmFile, "utf8"); } catch { /* none */ }
    const light = readPrefs().theme === "light";
    if (light && cur !== WM_LIGHT_THEME && (cur === null || cur.startsWith(WM_LIGHT_HEADER))) {
      fs.mkdirSync(wmDir, { recursive: true });
      fs.writeFileSync(wmFile + ".tmp", WM_LIGHT_THEME); fs.renameSync(wmFile + ".tmp", wmFile);
      reconfigure();
    } else if (!light && cur !== null && cur.startsWith(WM_LIGHT_HEADER)) {
      fs.rmSync(wmFile, { force: true });
      reconfigure();
    }
  };

  // ---- Archivos: Papelera, Recientes, Favoritos, search, new folder, rename (core/src/files.ts: home only, nothing hidden)
  const files = createFiles({ home: o.homeDir ?? process.env.HOME ?? os.homedir(), configDir: o.configDir, dataDir: o.dataDir });
  files.standardFolders();

  // ---- tasks ("Hoy" widget): ~/.config/nexus/tasks.json, the person's own data
  const tasksFile = path.join(o.configDir, "tasks.json");
  const readTasks = (): Task[] => { try { const t = JSON.parse(fs.readFileSync(tasksFile, "utf8")); return Array.isArray(t) ? t : []; } catch { return []; } };
  const saveTasks = (t: Task[]) => {
    fs.writeFileSync(tasksFile + ".tmp", JSON.stringify(t, null, 2), { mode: 0o600 }); fs.renameSync(tasksFile + ".tmp", tasksFile);
    push("tasks", { tasks: visibleTasks(t) });
  };
  // open tasks, plus the ones finished in the last 12 h (shown crossed out); oldest first
  const visibleTasks = (t: Task[] = readTasks()) => t.filter((x) => !x.done || (x.doneAt && Date.now() - Date.parse(x.doneAt) < 12 * 3600_000));
  const addTask = (text: unknown) => {
    const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!t) throw new Error("empty task");
    const all = readTasks(); if (all.filter((x) => !x.done).length >= 200) throw new Error("too many open tasks");
    const task: Task = { id: randomBytes(6).toString("hex"), text: t, done: false, created: new Date().toISOString() };
    saveTasks([...all.filter((x) => !x.done || (x.doneAt && Date.now() - Date.parse(x.doneAt) < 7 * 86400_000)), task]);
    return task;
  };
  const setTask = (id: unknown, patch: { done?: unknown; remove?: boolean }) => {
    const all = readTasks(); const i = all.findIndex((x) => x.id === String(id));
    if (i < 0) throw new Error("unknown task");
    if (patch.remove) all.splice(i, 1);
    else { const done = patch.done === true; all[i] = { ...all[i], done, doneAt: done ? new Date().toISOString() : undefined }; }
    saveTasks(all);
    return { ok: true };
  };

  // ---- weather (Open-Meteo, every 30 min; nothing is sent when the city is "off")
  const fetchJson = o.fetchJson ?? (async (url: string) => { const r = await fetch(url, { signal: AbortSignal.timeout(10_000) }); if (!r.ok) throw new Error(`http ${r.status}`); return r.json(); });
  let weather: Record<string, unknown> | null = null;
  const refreshWeather = async () => {
    const key = String(readPrefs().city ?? "madrid");
    if (key === "off" || !Object.hasOwn(CITIES, key)) { weather = null; push("weather", { off: true }); return; }
    const c = CITIES[key];
    const j = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`);
    const temp = Number(j?.current?.temperature_2m), code = Number(j?.current?.weather_code);
    if (!Number.isFinite(temp) || !Number.isFinite(code)) throw new Error("unexpected weather answer");
    const d = describeWeather(code, j?.current?.is_day !== 0);
    weather = { city: c.name, temp: Math.round(temp), max: Math.round(Number(j?.daily?.temperature_2m_max?.[0])), min: Math.round(Number(j?.daily?.temperature_2m_min?.[0])), ...d, at: new Date().toISOString() };
    push("weather", weather);
  };

  // ---- Engine client
  const life = new AbortController(); // aborts in-flight Engine calls (the relay's long-poll) on stop()
  const engine = async (method: string, p: string, body?: unknown, timeoutMs = 120_000) => {
    const r = await fetch(o.engineUrl + p, {
      method, signal: AbortSignal.any([life.signal, AbortSignal.timeout(timeoutMs)]),
      headers: { authorization: `Bearer ${o.engineToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  };
  let engineUp: boolean | undefined;
  const setUp = (up: boolean) => { if (engineUp !== up) { engineUp = up; push("engine", { up }); } };
  let stopped = false;
  let windowTimer: ReturnType<typeof setInterval> | undefined;
  let focusTimer: ReturnType<typeof setInterval> | undefined;
  let weatherTimer: ReturnType<typeof setTimeout> | undefined;
  let wallTimer: ReturnType<typeof setInterval> | undefined;

  // ---- NEXUS Update: the root service nexus-updated (core/src/updated.ts) over its unix socket. Its status events
  //      become "update" events for Ajustes → Actualizaciones, and the moments that matter become desktop notices.
  //      Not running, or this person not in the group nexus-update: Ajustes says the service is not available.
  const updates = (() => {
    let sock: net.Socket | null = null, buf = "", nextId = 1, retry: ReturnType<typeof setTimeout> | undefined;
    let last: Record<string, any> | null = null;
    const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; t: ReturnType<typeof setTimeout> }>();
    const said = (t: string, kind = "info") => push("notice", { text: t, kind, app: "update" });
    const publish = (d: Record<string, any>) => {
      const was = last?.state;
      last = d; push("update", d);
      if (was === undefined || was === d.state) return;
      const v = d.available?.version;
      if (d.state === "ready" && v) said(`NEXUS OS ${v} está lista para instalarse: Ajustes → Actualizaciones.`);
      else if (d.state === "available" && v && was === "checking" && !d.autoDownload) said(`Hay una actualización: NEXUS OS ${v}.`);
      else if (d.state === "reboot") said(String(d.message || "Reinicia para terminar la actualización."));
      else if (d.state === "error" && (was === "installing" || was === "verifying" || was === "downloading")) said(String(d.message || "La actualización no ha salido bien."), "warn");
      else if (d.state === "idle" && was === "verifying") said(String(d.message || "Actualización instalada."), "good");
    };
    const connect = () => {
      if (sock || stopped) return;
      const c = net.connect(o.updateSocket ?? "/run/nexus-update/updated.sock");
      sock = c; c.setEncoding("utf8");
      c.on("connect", () => { request("status").catch(() => {}); });
      c.on("data", (chunk: string) => {
        buf += chunk;
        for (let i; (i = buf.indexOf("\n")) >= 0;) {
          let m: any; try { m = JSON.parse(buf.slice(0, i)); } catch { m = null; } buf = buf.slice(i + 1);
          if (!m) continue;
          if (m.event === "status" && m.data) { publish(m.data); continue; }
          const w = pending.get(m.id); if (!w) continue;
          pending.delete(m.id); clearTimeout(w.t);
          if (m.ok) { if (m.result && typeof m.result === "object") publish(m.result); w.ok(m.result); } else w.fail(new Error(String(m.error)));
        }
      });
      const gone = () => {
        if (sock !== c) return;
        sock = null; buf = "";
        for (const w of pending.values()) { clearTimeout(w.t); w.fail(new Error("unavailable")); }
        pending.clear();
        if (!stopped) { retry = setTimeout(connect, 5000); retry.unref(); }
      };
      c.on("error", gone); c.on("close", gone);
    };
    const request = (cmd: string, arg?: unknown) => new Promise<unknown>((ok, fail) => {
      if (!sock) connect();   // while it connects, what is written waits in the socket; a failed connect fails it below
      if (!sock) return fail(new Error("unavailable"));
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); fail(new Error("unavailable")); }, cmd === "check" ? 60_000 : 15_000);
      pending.set(id, { ok, fail, t });
      sock!.write(JSON.stringify({ id, cmd, ...(arg === undefined ? {} : { arg }) }) + "\n");
    });
    return { connect, request, last: () => last, stop: () => { clearTimeout(retry); sock?.destroy(); sock = null; } };
  })();
  const UPDATE_ACTIONS = ["check", "download", "install", "undo", "auto", "debian-check", "debian-install"];

  // ---- NEXUS Guard (Ajustes → Privacidad y seguridad): the root service nexus-guardd over its unix socket, one
  //      short connection per question. Passwords pass through to it and are never kept, logged or sent as events.
  const guardCall = (cmd: string, arg?: Record<string, unknown>) => new Promise<RootFacts>((ok, fail) => {
    const c = net.connect(o.guardSocket ?? "/run/nexus-guard/guard.sock");
    let buf = "", done = false;
    const end = (e: (Error & { code?: string }) | null, v?: RootFacts) => { if (done) return; done = true; clearTimeout(t); c.destroy(); if (e) fail(e); else ok(v!); };
    const gone = () => end(Object.assign(new Error("El guardián de NEXUS no responde."), { code: "unavailable" }));
    const t = setTimeout(gone, 45_000);
    c.setEncoding("utf8");
    c.on("connect", () => c.write(JSON.stringify({ id: 1, cmd, ...(arg ? { arg } : {}) }) + "\n"));
    c.on("data", (chunk: string) => {
      buf += chunk;
      const i = buf.indexOf("\n"); if (i < 0) return;
      let m: any; try { m = JSON.parse(buf.slice(0, i)); } catch { return gone(); }
      if (m?.ok && m.result && typeof m.result === "object") end(null, m.result);
      else end(Object.assign(new Error(String(m?.error ?? "No se ha podido hacer el cambio.")), { code: String(m?.code ?? "failed") }));
    });
    c.on("error", gone); c.on("close", gone);
  });
  const securityView = async (known?: RootFacts) => {
    let root: RootFacts | null = known ?? null;
    if (!root) try { root = await guardCall("status"); } catch { root = null; }
    const prefs = readPrefs();
    const lockAfter = typeof prefs.lockAfter === "number" ? prefs.lockAfter : 5;
    const u = updates.last();
    const proc = o.procDir ?? "/proc";
    const text = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
    let mine = new Map<number, string>();
    try { mine = new Map(localServers({ proc, name: friendlyName }).map((x) => [x.port, x.process])); } catch { /* not Linux */ }
    const me = os.userInfo().username;
    const idleAvailable = existsFn("/usr/bin/swayidle");
    const c = checkup(root, {
      lockAfter, idleAvailable, sandbox: existsFn("/usr/bin/bwrap"),
      // (a check that did not reach the channel proves nothing: say "not checked", never "up to date")
      update: u && !u.checkFailed ? { available: !!u.available, autoDownload: u.autoDownload !== false, debianPending: Number(u.debian?.count ?? 0) } : null,
      exposed: exposedListeners([text(`${proc}/net/tcp`), text(`${proc}/net/tcp6`)], mine),
    });
    return { ...c, user: me, lockAfter, lockChoices: LOCK_AFTER, idleAvailable, root, searchMemory: prefs.searchMemory !== false, remembered: pageIndex.frequent(1000).length };
  };
  const securityAct = async (b: Record<string, unknown>) => {
    const user = os.userInfo().username, password = typeof b.password === "string" ? b.password : undefined;
    const action = String(b.action);
    if (action === "firewall") return guardCall("firewall");
    if (action === "remote") return guardCall("remote", { on: b.on === true, user, password });
    if (action === "sudo") return guardCall("sudo", { ask: b.ask !== false, user, password });
    if (action === "login") return guardCall("login", { ask: b.ask !== false, user, password });
    if (action === "password") return guardCall("password", { user, current: typeof b.current === "string" ? b.current : "", next: b.next });
    throw Object.assign(new Error("acción desconocida"), { code: "bad" });
  };

  const relay = async () => {
    let since: number | undefined;
    while (!stopped) {
      try {
        if (since === undefined) { const s = await engine("GET", "/api/system", undefined, 10_000); if (s.status !== 200) throw new Error(`engine ${s.status}`); since = Number(s.json.engine?.shellHead ?? 0); setUp(true); }
        const r = await engine("GET", `/api/shell/events?since=${since}&wait=25000`, undefined, 40_000);
        if (r.status !== 200) throw new Error(`engine ${r.status}`);
        setUp(true);
        for (const e of r.json.events ?? []) {
          if (e.kind === "launch") { await launch(String(e.data?.app), String(e.data?.by ?? "engine")).catch(() => { /* not in catalog */ }); }
          else if (e.kind === "task") { try { addTask(e.data?.text); } catch { /* empty or too many */ } }
          else if (e.kind === "theme") { try { writePrefs({ theme: e.data?.mode }); } catch { /* invalid */ } }
          else if (e.kind === "confirm") push("confirm", { id: String(e.data?.id), action: String(e.data?.action), reason: String(e.data?.reason ?? "") });
          else push(String(e.kind), e.data ?? {});
        }
        since = Number(r.json.head ?? since);
      } catch {
        setUp(false); since = undefined;
        if (!stopped) await new Promise((res) => setTimeout(res, 1500));
      }
    }
  };

  // NEXUS AI asked to organise files: the Engine cannot see the home folder, so the plan is made here and travels
  // back inside the same answer. The person sees the real numbers and confirms (POST /files/organize) or not.
  const planOrganize = (reply: any) => {
    const i = Array.isArray(reply?.actions) ? reply.actions.findIndex((a: any) => a?.kind === "organize") : -1;
    if (i < 0) return;
    const a = reply.actions[i];
    reply.actions = reply.actions.filter((x: any, k: number) => k === i || x?.kind !== "organize"); // one plan per answer
    const lead = reply.source === "claude" && typeof reply.text === "string" && reply.text.trim() ? reply.text.trim() + "\n\n" : "";
    try {
      const plan = files.organizePlan({ target: a.target, what: a.what, by: a.by });
      reply.actions[reply.actions.indexOf(a)] = { kind: "organize", plan: plan.total ? plan : undefined };
      reply.text = lead + plan.text;
    } catch (e: any) {
      reply.actions[reply.actions.indexOf(a)] = { kind: "organize", error: String(e?.message ?? e) };
      const msg = String(e?.message ?? e);
      reply.text = lead + msg + (msg.startsWith("No encuentro") ? ". Dime el nombre de la carpeta, por ejemplo: «organiza Descargas por tipo»." : ".");
    }
  };

  // ---- NEXUS Connect (core/src/connect.ts, in the Engine). The keys never come here: this keeps only the catalog
  // (what each service can do and whether it is connected) and passes each check or action to the Engine.
  let connectCatalog: ConnectorInfo[] | null = null;
  const refreshConnect = async () => {
    const r = await engine("GET", "/api/connect", undefined, 10_000);
    if (r.status !== 200 || !Array.isArray(r.json?.connectors)) throw new Error(String(r.json?.error ?? `el motor ha contestado ${r.status}`));
    connectCatalog = r.json.connectors;
    return r.json;
  };
  const connectCall = async (p: string, b: unknown, timeoutMs: number) => {
    let r: { status: number; json: any };
    try { r = await engine("POST", p, b, timeoutMs); } catch (e: any) {
      throw new Error(e?.name === "TimeoutError" ? `el servicio no ha contestado en ${Math.round(timeoutMs / 1000)} segundos` : "el motor de NEXUS no responde");
    }
    if (r.status !== 200) throw new Error(String(r.json?.error ?? `el motor ha contestado ${r.status}`));
    return r.json;
  };
  const services: Services = {
    catalog: () => connectCatalog,
    // "automation": only rules the person created reach here; nothing else in the session can ask for a write
    run: (c, op, input, event) => connectCall(`/api/connect/${encodeURIComponent(c)}/run`, { op, input, event, origin: "automation" }, 120_000),
    poll: (c, trigger, input, state) => connectCall(`/api/connect/${encodeURIComponent(c)}/poll`, { trigger, input, state }, 120_000),
  };

  // ---- automations (core/src/automations.ts): run here, as the person, each command in a sandbox
  const automations = new Automations({
    services,
    configDir: o.configDir, home: o.homeDir ?? process.env.HOME ?? os.homedir(), runtimeDir: o.runtimeDir,
    apps: Object.fromEntries(installedApps().map(([id, a]) => [id, a.name])),
    notice: (text, kind) => push("notice", { text, kind, app: "automations" }),
    changed: () => push("automations", {}),
    launch: (app) => { launch(app, "automation").catch(() => { /* not in catalog */ }); },
  });
  // NEXUS AI only drafts: the app opens with it and the person presses Crear
  let automationDraft: Record<string, unknown> | null = null;
  const planAutomation = (reply: any) => {
    const a = Array.isArray(reply?.actions) ? reply.actions.find((x: any) => x?.kind === "automation") : undefined;
    if (!a) return;
    automationDraft = a.draft && typeof a.draft === "object" ? a.draft : null;
    reply.actions = reply.actions.filter((x: any) => x?.kind !== "automation").concat([{ kind: "automation", name: String(a.draft?.name ?? "") }]);
    launch("automations", "ai").then(() => push("automation-draft", {})).catch(() => { /* catalog */ });
  };

  // ---- AI agents (core/src/agentd.ts): MCP server, capabilities, watchdog, approvals, checks, committee, quotas
  const homeDir = o.homeDir ?? process.env.HOME ?? os.homedir();
  let listenPort = o.port ?? 7779;
  const agents = new Agents({
    configDir: o.configDir, dataDir: path.join(o.dataDir ?? path.join(homeDir, ".local", "share"), "nexus", "agentes"), home: homeDir,
    port: () => listenPort, runtimeDirs: ["/run/user", "/run/nexus", "/run/dbus"], // agents never reach the session or system bus
    push, notice: (text, kind) => push("notice", { text, kind, app: "agents" }),
    launch: (app) => { launch(app, "agent").catch(() => { /* not in catalog */ }); },
    review: async (diff, role) => { const r = await engine("POST", "/api/ai/review", { diff, role }, 150_000); if (r.status !== 200) throw new Error(`motor ${r.status}`); return r.json; },
    // the agent's Claude requests leave through the Engine, which adds the person's key (agents never get it)
    forward: (pq, init) => fetch(o.engineUrl + "/api/ai/anthropic" + pq, { method: init.method, signal: life.signal, body: init.body,
      headers: { ...init.headers, authorization: `Bearer ${o.engineToken()}` } }),
    proposeAutomation: (draft) => { automationDraft = draft; launch("automations", "agent").then(() => push("automation-draft", {})).catch(() => { /* catalog */ }); },
    lastFailure: (folder) => automations.lastFailureIn(folder),
  });

  // ---- Agencias (core/src/agency.ts, app Agentes → Agencias): teams of AI workers on a schedule, like an office.
  // Claude through the Engine (the key stays there); services only READ (origin "agencia": the Engine refuses writes).
  // One Claude answer through the Engine (it adds the person's key; nothing here ever sees it)
  const claudeViaEngine = async (b: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => {
    const r = await fetch(o.engineUrl + "/api/ai/anthropic/v1/messages", { method: "POST", body: JSON.stringify(b),
      signal: AbortSignal.any([life.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      headers: { authorization: `Bearer ${o.engineToken()}`, "content-type": "application/json", "anthropic-version": "2023-06-01" } });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };
  // The person's folders (names only, two levels, no hidden ones) so NEXUS AI can tell which folder they mean
  const homeFolders = () => {
    const out: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (out.length >= 80 || !e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules" || /[\n<>]/.test(e.name)) continue;
        out.push(`~/${rel}${e.name}`);
        if (depth < 1) walk(path.join(dir, e.name), `${rel}${e.name}/`, depth + 1);
      }
    };
    walk(homeDir, "", 0);
    return out;
  };
  const aiError = (code: string) => ({
    not_configured: "NEXUS AI no tiene clave de Claude: ponla en Ajustes → NEXUS AI", auth: "Claude no acepta la clave: revísala en Ajustes → NEXUS AI",
    rate_limit: "Claude pide ir más despacio: prueba dentro de un minuto", offline: "no hay conexión con Claude: revisa Internet",
    empty: "escribe con tus palabras qué quieres", refusal: "NEXUS AI no puede preparar eso",
  } as Record<string, string>)[code] ?? "NEXUS AI no ha podido prepararlo: prueba a explicarlo de otra forma";
  const claudeStatusError = (st: number, msg: string) => st === 401 ? aiError(/no Claude key/i.test(msg) ? "not_configured" : "auth") : st === 429 ? aiError("rate_limit") : aiError("");

  const devices = createDevices({ run: o.devicesRun, sysRoot: o.powerSupplyDir });
  const agencies = new Agencies({
    home: homeDir, configDir: o.configDir, dataDir: path.join(o.dataDir ?? path.join(homeDir, ".local", "share"), "nexus"),
    tickMs: o.agencyTickMs,
    claude: claudeViaEngine,
    readService: async (c, op, input) => {
      if (!connectCatalog) await refreshConnect().catch(() => { /* checked below */ });
      return connectCall(`/api/connect/${encodeURIComponent(c)}/run`, { op, input, origin: "agencia" }, 60_000);
    },
    catalog: () => connectCatalog,
    notice: (text, kind) => push("notice", { text, kind, app: "agents" }),
    changed: (id) => push("agency", { id }),
  });

  // ---- NEXUS Search (browser/search.html, core/src/search.ts): the pages visited, apps, Ajustes, files, Wikipedia, Claude's web search
  const pageIndex = new PageIndex(path.join(o.dataDir ?? path.join(homeDir, ".local", "share"), "nexus", "search", "index.json"));
  const searchFetch = o.searchFetchJson ?? (async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "NEXUS-OS/0.2 (NEXUS Search desktop client)", "api-user-agent": "NEXUS-OS/0.2 (NEXUS Search desktop client)" } });
    if (!r.ok) throw new Error(`http ${r.status}`); return r.json();
  });
  const webCache = new Map<string, { at: number; reply: unknown }>(); // the same search again within 30 min costs nothing
  const searchQuery = (url: URL) => String(url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  // ---- NEXUS Mail (core/src/mail.ts): IMAP/SMTP accounts with app passwords; NEXUS AI summarises and drafts
  const mail = new Mail({ file: path.join(o.configDir, "mail-accounts.json"), run: o.mailRun, claude: (b, ms) => claudeViaEngine(b, ms), notify: (text) => push("notice", { text, kind: "info", app: "mail" }) });
  let mailTimer: ReturnType<typeof setInterval> | undefined;
  // ---- NEXUS Store (core/src/store.ts): web apps, each in its own window with its own session
  const store = new Store(path.join(o.configDir, "webapps.json"));
  // ---- NEXUS Store → Linux apps (core/src/linuxapps.ts): Flathub's catalogue, installed with flatpak for this person
  const linuxApps = new LinuxApps({ run: o.linuxRun ?? defaultLinuxRun, fetchFn: o.linuxFetch, available: () => existsFn("/usr/bin/flatpak"), onChange: () => push("store", {}) });
  const linuxState = async () => ({ available: linuxApps.available(), installed: await linuxApps.installed(), jobs: linuxApps.jobList() });
  // ---- web results from the person's search provider (core/src/websearch.ts). The key lives in one 0600 file and
  //      is never sent anywhere but to its provider, nor back to the desktop.
  const providerFile = path.join(o.configDir, "search-provider.json");
  const readProvider = (): { provider: ProviderId; key: string } | null => {
    try { const j = JSON.parse(fs.readFileSync(providerFile, "utf8")); return isProvider(j?.provider) && checkKey(j.provider, j.key) ? { provider: j.provider, key: j.key } : null; } catch { return null; }
  };
  const providerView = () => ({ provider: readProvider()?.provider ?? null, providers: Object.entries(PROVIDERS).map(([id, x]) => ({ id, name: x.name, signup: x.signup, free: x.free })) });
  const SEARCH_ERRORS: Record<string, string> = {
    auth: "El servicio de búsqueda no acepta esa clave.", quota: "Se han gastado las búsquedas de este mes en ese servicio.",
    offline: "No hay conexión con el servicio de búsqueda.", failed: "El servicio de búsqueda ha dado un error.",
  };
  type ResultsReply = { q: string; instant: ReturnType<typeof calc>; results: WebResult[]; source: string; full: boolean; provider: ProviderId | null; error: string };
  const resultsCache = new Map<string, { at: number; reply: ResultsReply }>();
  const answerCache = new Map<string, { at: number; reply: unknown }>();
  const webResults = async (q: string): Promise<ResultsReply> => {
    const k = fold(q), hit = resultsCache.get(k);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.reply;
    const prov = readProvider();
    let results: WebResult[] = [], source = "", error = "", full = false;
    if (prov) {
      try { results = await providerSearch(prov.provider, prov.key, q, o.providerFetch); source = PROVIDERS[prov.provider].name; full = true; }
      catch (e) { error = e instanceof SearchError ? e.code : "failed"; }
    }
    const instant = calc(q);
    if (!results.length && !instant) {   // no key (or the provider failed): at least what Wikipedia has, through its own API
      full = false;
      try { results = parseWikiSearch(await searchFetch(wikiSearchUrl(q))); source = results.length ? "Wikipedia" : ""; } catch { /* offline */ }
    }
    const reply: ResultsReply = { q, instant, results, source, full, provider: prov?.provider ?? null, error };
    if (results.length && !error) { resultsCache.set(k, { at: Date.now(), reply }); while (resultsCache.size > 80) resultsCache.delete(resultsCache.keys().next().value!); }
    return reply;
  };
  const appMatches = (q: string) => {
    const terms = tokenize(q);
    return !terms.length ? [] : installedApps().filter(([id, a]) => {
      const words = tokenize(`${a.name} ${id} ${APP_SEARCH_WORDS[id] ?? ""}`);
      return terms.every((t) => words.some((w) => w === t || (t.length >= 2 && w.startsWith(t))));
    }).map(([id, a]) => ({ id, name: a.name, icon: a.icon }));
  };
  // what the address bar offers while they type: the visited site to complete, search suggestions, pages, apps, Ajustes
  const suggestCache = new Map<string, string[]>();
  const suggest = async (q: string) => {
    const prefs = readPrefs();
    const mine = prefs.searchMemory === false ? { top: null, pages: [] } : pageIndex.suggest(q, 3);
    let phrases: string[] = [];
    const k = fold(q.trim());
    if (k.length >= 2 && prefs.searchWeb !== "off") {
      if (suggestCache.has(k)) phrases = suggestCache.get(k)!;
      else {
        try {
          phrases = parseSuggest(q, await Promise.race([searchFetch(suggestUrl(q)), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 1500).unref())]));
          suggestCache.set(k, phrases); while (suggestCache.size > 300) suggestCache.delete(suggestCache.keys().next().value!);
        } catch { phrases = []; }
      }
    }
    return { q, top: mine.top, pages: mine.pages, phrases, apps: appMatches(q).slice(0, 2), settings: settingsMatches(q).slice(0, 1) };
  };
  const localSearch = (q: string) => {
    const apps = appMatches(q);
    let found: { name: string; path: string; dir: boolean }[] = [];
    if (q.length >= 2) {
      try { found = (files.search(homeDir, q, 8) as { name: string; path: string; dir: boolean }[]).map((e) => ({ name: e.name, path: e.path, dir: e.dir })); }
      catch { found = []; }
    }
    const prefs = readPrefs();
    return { q, apps, settings: settingsMatches(q), files: found, pages: pageIndex.search(q, 8),
      web: String(prefs.searchWeb ?? "auto"), memory: prefs.searchMemory !== false, remembered: pageIndex.stats().pages };
  };

  const me = () => {
    let pw = ""; try { pw = fs.readFileSync("/etc/passwd", "utf8"); } catch { /* none */ }
    const avatar = path.join(o.configDir, "avatar.png");
    return { ...whoAmI(pw, os.userInfo().username), photo: fs.existsSync(avatar) ? avatar : "" };
  };
  const keyboardView = () => {
    let layout = "";
    for (const f of [path.join(o.configDir, "..", "labwc", "environment"), "/etc/xdg/labwc/environment", "/etc/default/keyboard"]) {
      try { const m = /^(?:XKB_DEFAULT_LAYOUT|XKBLAYOUT)=\"?([a-z]{2,3})/m.exec(fs.readFileSync(f, "utf8")); if (m) { layout = m[1]; break; } } catch { /* next */ }
    }
    return { layout: layout || "es", layouts: KEYBOARD_LAYOUTS };
  };
  // ---- HTTP API for the shell
  const authed = (req: http.IncomingMessage) => {
    const a = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, "")), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const body = (req: http.IncomingMessage, limit = 1e6) => new Promise<any>((res, rej) => {
    let s = ""; req.on("data", (d) => { s += d; if (s.length > limit) rej(new Error("too large")); });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
  });
  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "bad host" });
      if (req.headers.origin && !/^(file:\/\/|https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$)/.test(req.headers.origin)) return send(403, { error: "bad origin" });
      // agents (core/src/agentd.ts) authenticate with their own run token, never with the session token
      const path0 = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path0 === "/mcp") {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); return res.end(); }
        const r = await agents.mcp(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), await body(req, 4e6));
        if (r.status === 202) { res.writeHead(202); return res.end(); }
        return send(r.status, r.body);
      }
      if (path0.startsWith("/llm/")) return await agents.proxy(req, res, path0);
      if (!authed(req)) return send(401, { error: "unauthorized" });
      const url = new URL(req.url ?? "/", "http://localhost"), p = url.pathname, m = req.method;
      if (m === "GET" && p === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0), wait = Math.min(Number(url.searchParams.get("wait") ?? 25_000), 25_000);
        return send(200, await poll(Number.isFinite(since) ? since : 0, Number.isFinite(wait) ? Math.max(0, wait) : 0));
      }
      if (m === "GET" && p === "/apps") return send(200, Object.fromEntries(installedApps().map(([id, a]) => [id, { name: a.name, icon: a.icon, running: isRunning(id) }])));
      if (m === "POST" && p === "/launch") { const b = await body(req); return send(200, await launch(String(b.app), "shell", b.path, b.page)); }
      // the launcher's «Buscar en la web»: a Navegador window on NEXUS Search with that text (the Browser turns text
      // that is not an address into a search, as its own bar does)
      if (m === "POST" && p === "/search/open") {
        const b = await body(req); const q = String(b.q ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (!q) return send(400, { error: "empty search" });
        spawnFn(["nexus-app", "Browser", q]); push("app", { app: "browser", running: true, by: "shell" });
        return send(200, { ok: true });
      }
      if (m === "POST" && p === "/power") { const b = await body(req); return send(200, power(String(b.action))); } // the shell's own menu: a human click
      // the menu bar (a human click on one of its menus): the active window, a shortcut pressed in it, a window action
      if (m === "GET" && p === "/focus") { await checkFocus().catch(() => {}); return send(200, describeFocus(focusLine)); }
      if (m === "POST" && p === "/keys") {
        const b = await body(req); const args = wtypeArgs(b.keys);
        if (!args) return send(400, { error: "unknown shortcut" });
        keysFn(args); return send(200, { ok: true });
      }
      if (m === "POST" && p === "/window") {
        const b = await body(req); const action = String(b.action);
        // with `line`: that window (the overview); without it: the active one (the menu bar)
        if (typeof b.line === "string") { try { return send(200, await windowOp(b.line, action, b.to)); } catch (e) { return send(400, { error: (e as Error).message }); } }
        if (!WINDOW_ACTIONS.includes(action)) return send(400, { error: "unknown window action" });
        return send(200, { ok: await windowFn(action) });
      }
      if (m === "GET" && p === "/desktops") { await checkWindows().catch(() => {}); return send(200, desktopsView()); }
      if (m === "POST" && p === "/desktop") { const b = await body(req); try { return send(200, goToDesktop(b.to)); } catch (e) { return send(400, { error: (e as Error).message }); } }
      if (m === "POST" && p === "/confirm") {
        const b = await body(req);
        const r = await engine("POST", "/api/shell/confirm", { id: String(b.id), approve: b.approve === true });
        if (r.status === 200 && r.json.ok && r.json.action) power(String(r.json.action));
        return send(r.status, r.json);
      }
      if (m === "POST" && p === "/ui") {
        // optional `text` (AI panel only): open the panel with that question already asked, e.g. `nexusctl ui ai "¿qué hora es?"`
        const b = await body(req); const panel = String(b.panel);
        if (!["ai", "launcher", "power", "quick", "wifi", "battery", "notices", "center", "overview", "start"].includes(panel)) return send(400, { error: "unknown panel" });
        if (panel === "overview") await checkWindows().catch(() => {});
        const text = b.text === undefined ? "" : typeof b.text === "string" ? b.text.trim() : null;
        if (text === null || text.length > 500 || (text && panel !== "ai")) return send(400, { error: "invalid text" });
        push("ui", text ? { panel, text } : { panel }); return send(200, { ok: true });
      }
      // ---- the notification centre: what was shown, newest first; read marks, delete, clear; `add` for scripts
      // (`nexusctl notify`) and the D-Bus bridge, so a Linux app's notification lands in the same place
      if (m === "GET" && p === "/notices") return send(200, { notices: notices.list(), unread: notices.unread() });
      if (m === "POST" && p === "/notices/add") {
        const b = await body(req);
        try { checkNotice(b); } catch { return send(400, { error: "empty notice" }); }
        push("notice", { text: b.text, kind: b.kind, app: b.app, title: b.title });
        return send(200, { ok: true, notice: notices.list()[0] });
      }
      if (m === "POST" && p === "/notices/read") { const b = await body(req); notices.markRead(b.id === undefined ? undefined : Number(b.id)); push("notices", { unread: notices.unread() }); return send(200, { ok: true, unread: notices.unread() }); }
      if (m === "POST" && p === "/notices/delete") { const b = await body(req); const ok = notices.remove(Number(b.id)); push("notices", { unread: notices.unread() }); return send(ok ? 200 : 404, ok ? { ok: true } : { error: "no such notice" }); }
      if (m === "POST" && p === "/notices/clear") { notices.clear(); push("notices", { unread: 0 }); return send(200, { ok: true }); }
      if (m === "GET" && p === "/prefs") return send(200, readPrefs());
      if (m === "GET" && p === "/me") return send(200, me());
      // the account's picture: an image of the person's own (inside their home) copied to ~/.config/nexus/avatar.png
      // and ~/.face (what Linux programs read); an empty path removes it
      if (m === "POST" && p === "/me/photo") {
        const b = await body(req); const src = String(b.path ?? "").trim();
        const avatar = path.join(o.configDir, "avatar.png"), face = path.join(homeDir, ".face");
        if (!src) { for (const f of [avatar, face]) fs.rmSync(f, { force: true }); push("me", me()); return send(200, me()); }
        let real = ""; try { real = fs.realpathSync(src); } catch { return send(400, { error: "esa imagen no existe" }); }
        if (!real.startsWith(fs.realpathSync(homeDir) + "/") || !/\.(png|jpe?g|webp)$/i.test(real)) return send(400, { error: "elige una imagen (png, jpg o webp) de tu carpeta personal" });
        if (fs.statSync(real).size > 25e6) return send(400, { error: "la imagen es demasiado grande" });
        fs.mkdirSync(o.configDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(real, avatar + ".tmp"); fs.renameSync(avatar + ".tmp", avatar);
        try { fs.copyFileSync(avatar, face); } catch { /* a read-only home */ }
        push("me", me()); return send(200, me());
      }
      // the keyboard: the layout labwc uses (XKB_DEFAULT_LAYOUT in ~/.config/labwc/environment; applied on reconfigure
      // for new windows, fully at the next login)
      if (m === "GET" && p === "/keyboard") return send(200, keyboardView());
      if (m === "POST" && p === "/keyboard") {
        const b = await body(req); const layout = String(b.layout ?? "").trim();
        if (!KEYBOARD_LAYOUTS.some((k) => k.id === layout)) return send(400, { error: "distribución desconocida" });
        const envFile = path.join(o.configDir, "..", "labwc", "environment");
        let lines: string[] = []; try { lines = fs.readFileSync(envFile, "utf8").split("\n"); } catch { /* new */ }
        lines = lines.filter((l) => !/^XKB_DEFAULT_LAYOUT=/.test(l) && l.trim() !== "");
        lines.push(`XKB_DEFAULT_LAYOUT=${layout}`);
        fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(envFile, lines.join("\n") + "\n");
        reconfigure();
        push("keyboard", keyboardView()); return send(200, keyboardView());
      }
      if (m === "GET" && p === "/wallpaper") return send(200, publishWallpaper());
      if (m === "GET" && p === "/wallpapers") return send(200, wallpapers.gallery());
      if (m === "POST" && p === "/wallpaper/next") { wallpapers.next(); return send(200, publishWallpaper()); }
      if (m === "POST" && p === "/shell/health") {
        // the shell says which of its parts are on screen; NEXUS Update reads this file after it restarts the desktop
        const b = await body(req);
        const names = (v: unknown) => Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && /^[A-Za-z]{1,24}$/.test(x));
        if (!names(b.parts) || !names(b.failed)) return send(400, { error: "informe mal formado" });
        const f = path.join(o.runtimeDir, "shell-health.json");
        fs.writeFileSync(f + ".tmp", JSON.stringify({ at: new Date().toISOString(), parts: b.parts, failed: b.failed }), { mode: 0o600 });
        fs.renameSync(f + ".tmp", f);
        return send(200, { ok: true });
      }
      // NEXUS Update (Ajustes → Actualizaciones): what nexus-updated says, and the person's clicks passed on to it
      if (m === "GET" && p === "/update") {
        try { return send(200, await updates.request("status")); }
        catch { return send(503, { error: "El servicio de actualizaciones no está disponible ahora mismo." }); }
      }
      if (m === "POST" && p === "/update") {
        const b = await body(req);
        if (!UPDATE_ACTIONS.includes(String(b.action))) return send(400, { error: "acción desconocida" });
        const arg = b.action === "auto" ? b.value === true : b.action === "download" && b.value === "install" ? "install" : undefined;
        try { return send(200, await updates.request(String(b.action), arg)); }
        catch (e) { const msg = (e as Error).message; return send(msg === "unavailable" ? 503 : 409, { error: msg === "unavailable" ? "El servicio de actualizaciones no está disponible ahora mismo." : msg }); }
      }
      // NEXUS Guard (Ajustes → Privacidad y seguridad): the checkup, and the person's changes passed on to nexus-guardd
      if (m === "GET" && p === "/security") return send(200, await securityView());
      if (m === "POST" && p === "/security") {
        const b = await body(req, 4096);
        try {
          const facts = await securityAct(b && typeof b === "object" ? b : {});
          push("security", {});
          if (b.action === "password") push("notice", { text: "Contraseña cambiada.", kind: "good", app: "security" });
          return send(200, await securityView(facts));
        } catch (e) {
          const code = String((e as { code?: string }).code ?? "failed");
          return send(code === "auth" ? 403 : code === "locked" ? 429 : code === "unavailable" ? 503 : code === "bad" ? 400 : 409, { error: (e as Error).message, code });
        }
      }
      if (m === "POST" && p === "/prefs") return send(200, writePrefs(await body(req)));
      if (m === "GET" && p === "/processes") return send(200, await processes());
      // the browser's new tab lists them: "Servidores en marcha" (core/src/ports.ts)
      if (m === "GET" && p === "/ports") return send(200, { servers: localServers({ name: friendlyName, hide: (n) => /NEXUS/.test(n) }) });
      if (m === "GET" && p === "/system") { const r = await engine("GET", "/api/system", undefined, 10_000); return send(r.status, r.json); }
      // the menu bar's Wi-Fi, battery and Control Center (core/src/devices.ts): read and change the real hardware
      if (p === "/devices" || p.startsWith("/devices/")) {
        try {
          if (m === "GET" && p === "/devices") return send(200, await devices.state());
          if (m === "GET" && p === "/devices/wifi") return send(200, await devices.wifiList(url.searchParams.get("rescan") === "1"));
          if (m === "GET" && p === "/devices/bluetooth") return send(200, await devices.scanBluetooth(Number(url.searchParams.get("seconds") || 6)));
          if (m === "GET" && p === "/devices/sound") return send(200, await devices.soundOutputs());
          if (m === "GET" && p === "/devices/display") return send(200, await devices.display());
          if (m === "POST") {
            const b = await body(req);
            const on = b.on === true;
            if (p === "/devices/wifi") return send(200, await devices.setWifi(on));
            if (p === "/devices/wifi/connect") return send(200, await devices.connectWifi(b.ssid, b.password === undefined ? undefined : String(b.password)));
            if (p === "/devices/wifi/disconnect") return send(200, await devices.disconnectWifi());
            if (p === "/devices/wifi/forget") return send(200, await devices.forgetWifi(b.ssid));
            if (p === "/devices/bluetooth") return send(200, await devices.setBluetooth(on));
            if (p === "/devices/bluetooth/connect") return send(200, await devices.connectBluetooth(b.mac, on));
            if (p === "/devices/bluetooth/pair") return send(200, await devices.pairBluetooth(b.mac));
            if (p === "/devices/bluetooth/forget") return send(200, await devices.forgetBluetooth(b.mac));
            if (p === "/devices/sound/output") return send(200, await devices.setSoundOutput(b.id));
            if (p === "/devices/display/mode") return send(200, await devices.setDisplayMode(b.output, b.mode));
            if (p === "/devices/airplane") return send(200, await devices.setAirplane(on));
            if (p === "/devices/sound") return send(200, await devices.setSound({ volume: b.volume, muted: b.muted }));
            if (p === "/devices/brightness") return send(200, await devices.setBrightness(b.value));
            if (p === "/devices/power") return send(200, await devices.setPowerMode(b.mode));
            if (p === "/devices/media") return send(200, await devices.mediaAction(b.action));
          }
          return send(404, { error: "no existe" });
        } catch (e) {
          if (e instanceof DeviceError) return send(e.status, { error: e.message });
          throw e;
        }
      }
      if (m === "POST" && p === "/ai") {
        // the person's own tasks travel with the question, so NEXUS AI can answer "¿qué tengo hoy?"
        // the browser adds the page being read (the Engine trims it and marks it as the website's words)
        const b = await body(req); const context = { tasks: visibleTasks().slice(-50).map((t) => ({ text: t.text, done: t.done })), page: b.page, output: b.output, via: b.via };
        const r = await engine("POST", "/api/ai/ask", { text: String(b.text ?? ""), history: b.history, context });
        if (r.status === 200) { planOrganize(r.json); planAutomation(r.json); }
        return send(r.status, r.json);
      }
      if (m === "GET" && p === "/search") return send(200, localSearch(searchQuery(url)));
      if (m === "GET" && p === "/search/suggest") return send(200, await suggest(String(url.searchParams.get("q") ?? "").slice(0, 200)));
      if (m === "GET" && p === "/search/frequent") return send(200, { pages: readPrefs().searchMemory === false ? [] : pageIndex.frequent(8) });
      if (p === "/mail" || p.startsWith("/mail/")) {
        const qs = (k: string) => url.searchParams.get(k) ?? "";
        try {
          if (m === "GET" && p === "/mail") return send(200, mail.view());
          if (m === "GET" && p === "/mail/list") return send(200, await mail.list(qs("account"), qs("folder")));
          if (m === "GET" && p === "/mail/read") return send(200, { message: await mail.read(qs("account"), qs("folder"), qs("uid")) });
          if (m === "GET" && p === "/mail/summary") return send(200, await mail.summary(qs("account")));
          if (m === "GET" && p === "/mail/followups") return send(200, await mail.followups(qs("account"), qs("days")));
          if (m === "POST") {
            const b = await body(req, 600_000);
            if (p === "/mail/accounts") return send(200, await mail.add(b));
            if (p === "/mail/accounts/remove") return send(200, mail.remove(b?.id));
            if (p === "/mail/vip") return send(200, mail.setVip(b?.id, b?.vip));
            if (p === "/mail/flag") return send(200, await mail.flag(b?.account, b?.folder, b?.uid, b?.seen));
            if (p === "/mail/delete") return send(200, await mail.remove1(b?.account, b?.folder, b?.uid));
            if (p === "/mail/draft") return send(200, await mail.draftReply(b?.account, b?.folder, b?.uid, b?.hint));
            // the person wrote it and clicked "Enviar" in the app: the only way a mail leaves this computer
            if (p === "/mail/send") return send(200, await mail.send(b?.account, { to: b?.to, cc: b?.cc, subject: b?.subject, body: b?.body, inReplyTo: b?.inReplyTo, references: b?.references }));
          }
        } catch (e) {
          if (e instanceof MailError) return send(e.status, { error: e.message, code: e.code });
          throw e;
        }
        return send(404, { error: "not found" });
      }
      if (p === "/store" || p.startsWith("/store/")) {
        if (m === "GET" && p === "/store") return send(200, store.view());
        // Linux apps: the catalogue (search or the most installed), one app's page, and what is installed
        if (p === "/store/linux" || p.startsWith("/store/linux/")) {
          try {
            if (m === "GET" && p === "/store/linux") {
              const q = (url.searchParams.get("q") ?? "").slice(0, 80);
              const state = await linuxState();
              // the catalogue needs Internet; what is installed is still shown without it
              try { return send(200, { ...state, apps: await linuxApps.search(q) }); }
              catch (e) { return send(200, { ...state, apps: [], error: (e as Error).message }); }
            }
            if (m === "GET" && p === "/store/linux/app") {
              const d = await linuxApps.details(url.searchParams.get("id"));
              const state = await linuxState();
              return send(200, { ...d, download: humanSize(d.downloadBytes), size: humanSize(d.installedBytes), installed: state.installed.some((a) => a.id === d.id), job: state.jobs.find((j) => j.id === d.id) ?? null });
            }
            if (m === "POST") {
              const b = await body(req, 4096);
              if (p === "/store/linux/install") { const { job, done } = linuxApps.install(b?.id); done.then((j) => push("notice", { text: j.state === "done" ? "App instalada. Ya puedes abrirla desde NEXUS Store." : (j.error ?? "No se ha podido instalar la app."), kind: j.state === "done" ? "info" : "warn", app: "store" })).catch(() => {}); return send(200, { job }); }
              if (p === "/store/linux/remove") { const { job, done } = linuxApps.remove(b?.id, b?.data === true); await done; return send(job.state === "done" ? 200 : 400, job.state === "done" ? await linuxState() : { error: job.error }); }
              if (p === "/store/linux/open") {
                const argv = linuxApps.launchArgv(b?.id);
                if (!(await linuxApps.installed()).some((a) => a.id === argv[2])) return send(404, { error: "Esa app no está instalada." });
                spawnFn(argv);
                return send(200, { ok: true });
              }
            }
          } catch (e) { return send(400, { error: (e as Error).message }); }
          return send(404, { error: "not found" });
        }
        if (m === "POST") {
          const b = await body(req, 4096);
          try {
            if (p === "/store/install") return send(200, store.install(b?.id));
            if (p === "/store/add") return send(200, store.add({ name: b?.name, url: b?.url }));
            if (p === "/store/remove") {
              const r = store.remove(b?.id);
              // its saved session goes with it (cookies, logins): the app starts clean if it is installed again
              if (r.removed) for (const base of [path.join(o.dataDir ?? path.join(homeDir, ".local", "share"), "nexus", "webapps"), path.join(homeDir, ".cache", "nexus", "webapps")]) {
                const dir = path.join(base, profileName(r.removed.id).replace(/^webapp-/, ""));
                if (path.dirname(dir) === base) fs.rmSync(dir, { recursive: true, force: true });
              }
              return send(200, r.view);
            }
            if (p === "/store/open") {
              const a = store.get(b?.id);
              if (!a) return send(404, { error: "Esa app no está instalada." });
              spawnFn(["nexus-app", "WebApp", a.url, a.name, a.id]);
              return send(200, store.view());
            }
            // a link inside a web app that leads to another site opens in the Navegador (https only)
            if (p === "/store/link") {
              let u: URL; try { u = new URL(String(b?.url ?? "")); } catch { return send(400, { error: "dirección no válida" }); }
              if (u.protocol !== "https:") return send(400, { error: "solo https" });
              spawnFn(["nexus-app", "Browser", u.href.slice(0, 2000)]);
              return send(200, { ok: true });
            }
          } catch (e) { return send(400, { error: (e as Error).message }); }
        }
        return send(404, { error: "not found" });
      }
      // web results in well under a second (the person's search provider, else Wikipedia) and the calculator
      if (m === "GET" && p === "/search/results") {
        const q = searchQuery(url);
        if (!q) return send(400, { error: "empty query" });
        if (readPrefs().searchWeb === "off") return send(200, { q, instant: calc(q), results: [], source: "", full: false, provider: readProvider()?.provider ?? null, error: "", off: true });
        return send(200, await webResults(q));
      }
      // the short answer, written by Claude from those results (one small request)
      if (m === "GET" && p === "/search/answer") {
        const q = searchQuery(url);
        if (!q) return send(400, { error: "empty query" });
        if (readPrefs().searchWeb === "off") return send(403, { error: "off" });
        const k = fold(q), hit = answerCache.get(k);
        if (hit && Date.now() - hit.at < 30 * 60_000) return send(200, { ...(hit.reply as object), cached: true });
        const res = await webResults(q);
        if (!res.full || !res.results.length) return send(409, { error: "no_results" });
        let r: { status: number; json: any };
        try { r = await claudeViaEngine(answerRequest(q, res.results), 40_000); } catch { return send(502, { error: "offline" }); }
        if (r.status !== 200) return send(502, { error: r.status === 401 ? (/no Claude key/i.test(String(r.json?.error?.message ?? "")) ? "not_configured" : "auth") : r.status === 429 ? "rate_limit" : "error" });
        const said = (Array.isArray(r.json?.content) ? r.json.content : []).filter((x: any) => x?.type === "text").map((x: any) => String(x.text ?? "")).join("");
        const reply = { answer: parseAnswer(said, res.results), usd: Math.round((costUsd(String(r.json?.model ?? ANSWER_MODEL), r.json?.usage ?? {}) ?? 0) * 100000) / 100000 };
        if (reply.answer.length) { answerCache.set(k, { at: Date.now(), reply }); while (answerCache.size > 80) answerCache.delete(answerCache.keys().next().value!); }
        return send(200, reply);
      }
      // the search provider (Ajustes → Buscador): which one, and its key — tried with one real search before it is kept
      if (p === "/search/provider") {
        if (m === "GET") return send(200, providerView());
        if (m === "DELETE") { fs.rmSync(providerFile, { force: true }); resultsCache.clear(); answerCache.clear(); return send(200, providerView()); }
        if (m === "POST") {
          const b = await body(req, 4096);
          if (!isProvider(b?.provider)) return send(400, { error: "servicio de búsqueda desconocido" });
          const key = String(b.key ?? "").trim();
          if (!checkKey(b.provider, key)) return send(400, { error: `Eso no tiene la forma de una clave de ${PROVIDERS[b.provider as ProviderId].name}.` });
          try { await providerSearch(b.provider, key, "NEXUS OS", o.providerFetch); }
          catch (e) { const code = e instanceof SearchError ? e.code : "failed"; return send(code === "auth" ? 403 : 502, { error: SEARCH_ERRORS[code] }); }
          fs.writeFileSync(providerFile + ".tmp", JSON.stringify({ provider: b.provider, key }), { mode: 0o600 }); fs.chmodSync(providerFile + ".tmp", 0o600); fs.renameSync(providerFile + ".tmp", providerFile);
          resultsCache.clear(); answerCache.clear();
          return send(200, providerView());
        }
      }
      if (m === "GET" && p === "/search/wiki") {
        const q = searchQuery(url);
        if (!q || readPrefs().searchWeb === "off") return send(200, { card: null });
        try { return send(200, { card: parseWiki(q, await searchFetch(wikiQueryUrl(q))) }); } catch { return send(200, { card: null }); }
      }
      if (m === "GET" && p === "/search/web") {
        const q = searchQuery(url);
        if (!q) return send(400, { error: "empty query" });
        if (readPrefs().searchWeb === "off") return send(403, { error: "La búsqueda en la web está desactivada." });
        const k = fold(q), hit = webCache.get(k);
        if (hit && Date.now() - hit.at < 30 * 60_000) return send(200, { ...(hit.reply as object), cached: true });
        const r = await engine("POST", "/api/ai/search", { q }, 90_000);
        if (r.status === 200 && !r.json?.error) { webCache.set(k, { at: Date.now(), reply: r.json }); while (webCache.size > 60) webCache.delete(webCache.keys().next().value!); }
        return send(r.status, r.json);
      }
      if (m === "POST" && p === "/search/visit") {
        const b = await body(req, 64_000);
        if (readPrefs().searchMemory === false) return send(200, { kept: false });
        return send(200, { kept: pageIndex.add({ url: b.url, title: b.title, description: b.description, text: b.text }) });
      }
      if (m === "POST" && p === "/search/forget") { const b = await body(req); return send(200, { ok: pageIndex.forget(b.url) }); }
      if (m === "POST" && p === "/search/clear") { pageIndex.clear(); return send(200, { ok: true, remembered: 0 }); }
      if (m === "GET" && p === "/tasks") return send(200, { tasks: visibleTasks() });
      if (m === "POST" && p === "/tasks") { const b = await body(req); return send(200, addTask(b.text)); }
      if (m === "POST" && p === "/tasks/done") { const b = await body(req); return send(200, setTask(b.id, { done: b.done })); }
      if (m === "POST" && p === "/tasks/delete") { const b = await body(req); return send(200, setTask(b.id, { remove: true })); }
      if (p.startsWith("/files/")) {
        if (m === "GET" && p === "/files/recent") return send(200, { entries: files.recent() });
        if (m === "GET" && p === "/files/search") return send(200, { entries: files.search(url.searchParams.get("in"), url.searchParams.get("q")) });
        if (m === "GET" && p === "/files/favorites") return send(200, { entries: files.favorites() });
        if (m === "GET" && p === "/files/trash") return send(200, { entries: files.listTrash() });
        if (m === "POST") {
          const b = await body(req); let r: any; let gone: string[] = []; // folders that no longer exist: Archivos leaves them
          if (p === "/files/favorites") r = files.setFavorite(b.path, b.on === true);
          else if (p === "/files/trash") { r = files.trash(b.path); gone = [String(b.path)]; }
          else if (p === "/files/restore") r = files.restore(b.id);
          else if (p === "/files/delete") r = files.remove(b.id);
          else if (p === "/files/empty") r = files.empty();
          else if (p === "/files/mkdir") r = files.mkdir(b.parent, b.name);
          else if (p === "/files/rename") r = files.rename(b.path, b.name);
          else if (p === "/files/organize") r = files.organizeApply(b.id);          // the person clicked "Organizar"
          else if (p === "/files/organize/undo") { r = files.organizeUndo(b.id); gone = r.removed; }
          else if (p === "/files/organize/cancel") { r = files.organizeCancel(b.id); return send(200, r); }
          else return send(404, { error: "not found" });
          push("files", gone.length ? { gone } : {}); // every open Archivos window refreshes
          return send(200, r);
        }
      }
      // NEXUS Connect: the Conexiones app (a person at the keyboard). Keys go to the Engine and never come back.
      if (p === "/connect" || p.startsWith("/connect/")) {
        if (m === "GET" && p === "/connect") { try { return send(200, await refreshConnect()); } catch (e: any) { return send(502, { error: String(e?.message ?? e) }); } }
        const mc = /^\/connect\/([a-z0-9-]{1,30})(\/test)?$/.exec(p);
        if (mc) {
          const [, id, test] = mc;
          const call = async (method: string, b?: unknown, timeoutMs = 60_000) => {
            let r: { status: number; json: any };
            try { r = await engine(method, `/api/connect/${id}${test ? "/test" : ""}`, b, timeoutMs); } catch { return send(502, { error: "el motor de NEXUS no responde" }); }
            if (!test) { await refreshConnect().catch(() => { /* next GET */ }); push("connect", {}); push("automations", {}); }
            return send(r.status, r.json);
          };
          if (m === "POST" && test) return call("POST", {});
          if (m === "POST" && !test) { const b = await body(req); return call("POST", { values: b?.values && typeof b.values === "object" ? b.values : {} }); }
          if (m === "DELETE" && !test) return call("DELETE");
        }
        return send(404, { error: "not found" });
      }
      // «＋ Añadir conexión»: the person's own connections (descriptions, never keys) and NEXUS AI drafts of them
      if (p === "/connect-custom" || p.startsWith("/connect-custom/")) {
        const pass = async (method: string, path: string, b: unknown, timeoutMs: number, changes: boolean) => {
          let r: { status: number; json: any };
          try { r = await engine(method, path, b, timeoutMs); } catch (e: any) {
            return send(502, { error: e?.name === "TimeoutError" ? "NEXUS AI ha tardado demasiado: vuelve a probar" : "el motor de NEXUS no responde" });
          }
          if (changes && r.status === 200) { await refreshConnect().catch(() => { /* next GET */ }); push("connect", {}); push("automations", {}); }
          return send(r.status, r.json);
        };
        if (m === "POST" && p === "/connect-custom") { const b = await body(req); return pass("POST", "/api/connect-custom", { spec: b?.spec && typeof b.spec === "object" ? b.spec : {} }, 30_000, true); }
        if (m === "POST" && p === "/connect-custom/draft") {
          const b = await body(req);
          return pass("POST", "/api/connect-custom/draft", { service: String(b?.service ?? "").slice(0, 80), notes: String(b?.notes ?? "").slice(0, 500) }, 400_000, false);
        }
        const mx = /^\/connect-custom\/(x-[a-z0-9-]{1,30})$/.exec(p);
        if (mx && m === "GET") return pass("GET", `/api/connect-custom/${mx[1]}`, undefined, 10_000, false);
        if (mx && m === "DELETE") return pass("DELETE", `/api/connect-custom/${mx[1]}`, undefined, 10_000, true);
        return send(404, { error: "not found" });
      }
      if (p === "/automations" || p.startsWith("/automations/")) {
        if (m === "GET" && p === "/automations") return send(200, { items: automations.view() });
        if (m === "POST" && p === "/automations") {
          const b = await body(req);
          if (b?.trigger?.kind === "service" || b?.action?.kind === "service") await refreshConnect().catch(() => { /* checked by validate */ });
          return send(200, automations.save_(b));
        }
        if (m === "GET" && p === "/automations/draft") { const d = automationDraft; automationDraft = null; return send(200, { draft: d }); }
        // «Escríbela con tus palabras»: NEXUS AI fills the form; nothing is created until the person presses Crear
        if (m === "POST" && p === "/automations/draft-text") {
          const b = await body(req); const text = String(b?.texto ?? "").slice(0, 1500);
          if (text.trim().length < 4) return send(400, { error: aiError("empty") });
          let r: { status: number; json: any };
          try { r = await engine("POST", "/api/ai/draft-automation", { text, folders: homeFolders() }, 150_000); } catch { return send(502, { error: "el motor de NEXUS no responde" }); }
          if (r.status !== 200 || !r.json?.draft) return send(r.status === 200 ? 422 : 502, { error: aiError(String(r.json?.error ?? "")), usd: r.json?.usd ?? 0 });
          await refreshConnect().catch(() => { /* the form checks services itself */ });
          return send(200, { draft: r.json.draft, usd: r.json.usd ?? 0 });
        }
        const mm = /^\/automations\/([0-9a-f]{12})\/(run|stop|enable|runs|delete)$/.exec(p);
        if (mm) {
          const [, id, verb] = mm;
          if (m === "GET" && verb === "runs") return send(200, { runs: automations.history(id), live: automations.live(id) });
          if (m === "POST" && verb === "run") return send(200, automations.runNow(id));
          if (m === "POST" && verb === "stop") return send(200, automations.stopRun(id));
          if (m === "POST" && verb === "enable") { const b = await body(req); return send(200, automations.setEnabled(id, b.on === true)); }
          if (m === "POST" && verb === "delete") return send(200, automations.remove(id));
        }
        return send(404, { error: "not found" });
      }
      // Agencias: the person's AI teams (Agentes → Agencias)
      if (p === "/agencias" || p.startsWith("/agencias/")) {
        try {
          if (m === "GET" && p === "/agencias") { if (!connectCatalog) await refreshConnect().catch(() => { /* no services yet */ }); return send(200, agencies.view()); }
          if (m === "GET" && p === "/agencias/plantilla") { await refreshConnect().catch(() => { /* no services */ }); return send(200, { agency: agencies.template() }); }
          if (m === "POST" && p === "/agencias") return send(200, agencies.save((await body(req))?.agency));
          if (m === "POST" && p === "/agencias/draft") {
            const b = await body(req); await refreshConnect().catch(() => { /* no services */ });
            return send(200, await agencies.draft(String(b?.descripcion ?? "").slice(0, 1500)));
          }
          const mg = /^\/agencias\/([a-z0-9-]{1,40})(?:\/(delete|enable|run|stop|chat|proposal|doc|folder))?$/.exec(p);
          if (mg) {
            const [, id, verb] = mg;
            if (m === "GET" && !verb) return send(200, agencies.detail(id));
            if (m === "GET" && verb === "doc") return send(200, agencies.doc(id, url.searchParams.get("file") ?? ""));
            if (m === "POST") {
              const b = (await body(req)) ?? {};
              if (verb === "delete") return send(200, agencies.remove(id));
              if (verb === "enable") return send(200, agencies.setEnabled(id, b.on === true));
              if (verb === "run") return send(200, agencies.runNow(id, String(b.worker ?? ""), String(b.task ?? "")));
              if (verb === "stop") return send(200, agencies.stopRun(id, String(b.run ?? "")));
              if (verb === "chat") return send(200, await agencies.chat(id, String(b.worker ?? ""), String(b.text ?? "")));
              if (verb === "proposal") return send(200, agencies.setProposal(id, String(b.id ?? ""), String(b.status ?? "")));
              if (verb === "folder") { const f = String(agencies.detail(id).folder); fs.mkdirSync(f, { recursive: true }); return send(200, { path: f }); }
            }
          }
          return send(404, { error: "not found" });
        } catch (e: any) {
          if (e instanceof AgencyError) return send(e.status, { error: e.message });
          throw e;
        }
      }
      if (p === "/agents" || p.startsWith("/agents/")) {
        if (m === "GET" && p === "/agents") return send(200, agents.view());
        if (m === "POST" && p === "/agents") return send(200, agents.save(await body(req)));
        // «Escríbelo con tus palabras»: NEXUS AI fills the new agent's form (the person reviews it and saves)
        if (m === "POST" && p === "/agents/draft") {
          const b = await body(req); const text = String(b?.texto ?? "").replace(/[<>]/g, "").trim().slice(0, 1500);
          if (text.length < 4) return send(400, { error: aiError("empty") });
          let r: { status: number; json: any };
          try {
            r = await claudeViaEngine({ model: "claude-sonnet-5-5", max_tokens: 3000, system: AGENT_DRAFT_PROMPT,
              tools: [{ name: "crear_agente", description: "Rellena el formulario del agente nuevo.", strict: true, input_schema: AGENT_DRAFT_SCHEMA }],
              tool_choice: { type: "auto" }   /* a forced tool is refused by models that think first; the prompt asks for exactly one call */,
              messages: [{ role: "user", content: `<quiere>${text}</quiere>\n<carpetas>${homeFolders().join(", ")}</carpetas>` }] }, 90_000);
          } catch { return send(502, { error: "el motor de NEXUS no responde" }); }
          if (r.status !== 200) return send(502, { error: claudeStatusError(r.status, String(r.json?.error?.message ?? "")) });
          const use = (Array.isArray(r.json?.content) ? r.json.content : []).find((x: any) => x?.type === "tool_use" && x.name === "crear_agente");
          if (!use) return send(422, { error: aiError(r.json?.stop_reason === "refusal" ? "refusal" : "") });
          const usd = Math.round((costUsd(String(r.json?.model ?? "claude-sonnet-5-5"), r.json?.usage ?? {}) ?? 0) * 10000) / 10000;
          return send(200, { draft: fromAgentDraft(use.input), usd });
        }
        const ma = /^\/agents\/([a-z0-9-]{1,30})\/(delete|start)$/.exec(p);
        if (ma && m === "POST") return send(200, ma[2] === "delete" ? agents.remove(ma[1]) : agents.startRun(ma[1], await body(req)));
        const mr = /^\/agents\/runs\/([0-9a-f]{12})(?:\/(pid|end|halt))?$/.exec(p);
        if (mr && m === "GET" && !mr[2]) return send(200, agents.runStatus(mr[1]));
        if (mr && m === "POST" && mr[2]) {
          const b = await body(req);
          return send(200, mr[2] === "pid" ? agents.setPid(mr[1], b.pid) : mr[2] === "end" ? agents.endRun(mr[1], b.code) : agents.halt(mr[1]));
        }
        const mp = /^\/agents\/approvals\/([0-9a-f]{12})$/.exec(p);
        if (mp && m === "POST") { const b = await body(req); return send(200, agents.decide(mp[1], b.approve === true)); }
        return send(404, { error: "not found" });
      }
      if (m === "GET" && p === "/weather") return send(200, weather ?? { off: String(readPrefs().city ?? "madrid") === "off", loading: true });
      if (m === "GET" && p === "/lockinfo") {
        // read by /usr/bin/nexus-lock (a shell script, hence key=value text instead of JSON)
        const open = visibleTasks().filter((t) => !t.done).length;
        // the lock screen shows the desktop's wallpaper (paths are checked in wallpaper.ts: no quotes, no new lines)
        const wall = wallpapers.resolve();
        const wl = wall.kind === "image" ? `wallpaper=${wall.file}\nwallpaper_ink=${wall.ink}\n` : wall.kind === "color" ? `wallpaper_color=${wall.color}\nwallpaper_ink=${wall.ink}\n` : "";
        const text = `clock24=${readPrefs().clock24 === false ? 0 : 1}\ngreeting=${lockGreeting(open, weather, new Date().getHours())}\n${wl}`;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); return res.end(text);
      }
      if (m === "GET" && p === "/ai/settings") { const r = await engine("GET", "/api/ai/settings"); return send(r.status, r.json); }
      if (m === "POST" && p === "/ai/key") { const b = await body(req); const r = await engine("POST", "/api/ai/key", { key: String(b.key ?? "") }); return send(r.status, r.json); }
      if (m === "DELETE" && p === "/ai/key") { const r = await engine("DELETE", "/api/ai/key"); return send(r.status, r.json); }
      send(404, { error: "not found" });
    } catch (e: any) {
      const offline = e?.name === "TimeoutError" || e?.cause?.code === "ECONNREFUSED";
      send(offline ? 503 : 400, { error: offline ? "engine unavailable" : String(e?.message ?? e) });
    }
  });
  return {
    server, token, tokenFile, push, launch, running,
    checkWindows,
    start: () => new Promise<number>((r) => server.listen(o.port ?? 7779, "127.0.0.1", () => {
      relay();
      updates.connect();
      mailTimer = setInterval(() => { if (mail.hasVip()) mail.poll().catch(() => {}); }, 5 * 60_000); mailTimer.unref();
      windowTimer = setInterval(() => { checkWindows().catch(() => {}); }, o.windowPollMs ?? 3000); windowTimer.unref();
      focusTimer = setInterval(() => { checkFocus().catch(() => {}); }, o.focusPollMs ?? 600); focusTimer.unref();
      // weather now, then every 30 min (a failed refresh retries in 2 min)
      const weatherLoop = () => refreshWeather().then(() => o.weatherEveryMs ?? 1_800_000, () => 120_000).then((ms) => { if (!stopped) { weatherTimer = setTimeout(weatherLoop, ms); weatherTimer.unref(); } });
      weatherLoop();
      try { syncWmTheme(); } catch { /* a read-only home must not stop the session */ }
      wallTimer = setInterval(() => { try { publishWallpaper(); } catch { /* next time */ } }, 20_000); wallTimer.unref();
      refreshConnect().catch(() => { /* the Engine may still be starting: the app asks again */ });
      try { automations.start(); } catch { /* a broken rules file must not stop the session */ }
      agencies.start();
      listenPort = (server.address() as any).port;
      r(listenPort);
    })),
    stop: () => new Promise<void>((r) => { stopped = true; automations.stop(); agents.stop(); agencies.stop(); clearInterval(windowTimer); clearInterval(focusTimer); clearTimeout(weatherTimer); clearInterval(wallTimer); clearInterval(mailTimer); updates.stop(); try { pageIndex.flush(); } catch { /* read-only home */ } life.abort(); for (const w of waiters) w(); server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Top processes for the Monitor app (all users; names only, no command lines: those can contain secrets).
 *  Linux: kernel threads are left out, and NEXUS's own processes get friendly names (see friendlyName). */
function processes(): Promise<{ pid: number; user: string; cpu: number; mem: number; rssKb: number; name: string }[]> {
  const linux = process.platform === "linux";
  const args = linux ? ["-eo", "pid=,ppid=,user:16=,pcpu=,pmem=,rss=,comm=", "--sort=-pcpu"] : ["-axo", "pid=,ppid=,user=,pcpu=,pmem=,rss=,comm=", "-r"];
  const cmdline = (pid: number) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "latin1"); } catch { return ""; } };
  return new Promise((resolve) => {
    execFile("ps", args, { timeout: 5000, maxBuffer: 4 << 20 }, (err, out) => {
      if (err) return resolve([]);
      const rows = out.split("\n").filter(Boolean).map((l) => {
        const [pid, ppid, user, cpu, mem, rss, ...rest] = l.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), user, cpu: Number(cpu), mem: Number(mem), rssKb: Number(rss), comm: rest.join(" ") };
      });
      resolve(rows.filter((r) => !linux || (r.pid !== 2 && r.ppid !== 2)).slice(0, 60).map(({ ppid: _p, comm, ...r }) => ({
        ...r, name: linux ? friendlyName(comm, cmdline(r.pid)) : path.basename(comm),
      })));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rt = process.env.XDG_RUNTIME_DIR;
  if (!rt) { console.error("nexus-sessiond: XDG_RUNTIME_DIR is not set (run inside a user session)"); process.exit(1); }
  const engineTokenFile = process.env.NEXUS_ENGINE_TOKEN_FILE ?? "/run/nexus/token";
  const s = createSession({
    engineUrl: process.env.NEXUS_ENGINE_URL ?? "http://127.0.0.1:7777",
    engineToken: () => { try { return fs.readFileSync(engineTokenFile, "utf8").trim(); } catch { return ""; } },
    runtimeDir: path.join(rt, "nexus"),
    configDir: path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "/tmp", ".config"), "nexus"),
    port: Number(process.env.NEXUS_SESSION_PORT ?? 7779),
    dataDir: process.env.XDG_DATA_HOME || undefined, // the same Papelera as every other Linux app
  });
  const port = await s.start();
  console.log(`nexus-sessiond on 127.0.0.1:${port} (token in ${s.tokenFile})`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { s.stop().then(() => process.exit(0)); });
}
