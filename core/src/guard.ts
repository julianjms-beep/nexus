// NEXUS Guard: the security of this computer, in one place. Two halves:
//
//   * the pure part (this file's top): `checkup()` turns plain facts about the computer (is the firewall up, can
//     someone come in over the network, does it lock by itself, is the password still the factory one…) into the
//     list Ajustes → Privacidad y seguridad shows, with a score. No I/O, fully tested.
//   * `createGuard()`: what the root service nexus-guardd (core/src/guardd.ts) does. It reads the facts only root can
//     read and makes the few changes that need root, each one a fixed operation — never a command from the caller:
//       remote   turn remote access (SSH) on or off; the firewall opens port 22 only while it is on
//       sudo     ask for the password before administering (sudo), or not
//       login    ask for the password when the computer is switched on, or go straight to the desktop
//       password change a person's password
//
// The rule that keeps a program running as the person from quietly weakening the computer: an operation that makes
// it SAFER needs nothing; one that makes it LESS safe (remote access on, sudo without password, no password at
// power-on) and a password change need the account's password, checked here against /etc/shadow. Wrong passwords
// are counted: after 5 the guard refuses to check for a minute (longer each time).
//
// Passwords never go on a command line (anyone can read /proc/*/cmdline), are never logged and never stored.
import fs from "node:fs";
import path from "node:path";
import { defaultRunner, type Runner } from "./devices.ts";

// ---------------------------------------------------------------- the checkup (pure)

/** What only root can see (nexus-guardd answers it). */
export type RootFacts = {
  firewall: "on" | "off" | "missing";
  remote: boolean;
  sudoNoPassword: boolean;
  loginPassword: boolean;
  /** true: some person's password is still the factory one; null: could not tell */
  defaultPassword: boolean | null;
  hardened: boolean;
};
/** What the desktop session knows. */
export type UserFacts = {
  /** minutes without touching the computer before it locks; 0 = never */
  lockAfter: number;
  idleAvailable: boolean;
  /** NEXUS Update: null when the service is not answering */
  update: { available: boolean; autoDownload: boolean; debianPending: number } | null;
  sandbox: boolean;
  /** programs listening to the whole network (not only this computer) */
  exposed: { port: number; name: string }[];
};
export type CheckLevel = "ok" | "warn" | "bad" | "info";
export type CheckItem = { id: string; level: CheckLevel; title: string; detail: string; fix?: { label: string; action: string } };
export type Checkup = { score: number; grade: "protegido" | "mejorable" | "riesgo"; headline: string; items: CheckItem[]; guard: boolean };

const WEIGHT: Record<string, number> = {
  firewall: 25, password: 25, remote: 10, sudo: 10, login: 10, lock: 10, sandbox: 10, kernel: 5, updates: 5, guard: 20,
};

/** The list and the score. `root` is null when nexus-guardd does not answer (then nothing root-only is claimed). */
export function checkup(root: RootFacts | null, user: UserFacts): Checkup {
  const items: CheckItem[] = [];
  const add = (id: string, level: CheckLevel, title: string, detail: string, fix?: CheckItem["fix"]) => { items.push({ id, level, title, detail, ...(fix ? { fix } : {}) }); };

  if (!root) {
    add("guard", "bad", "El guardián de NEXUS no responde", "Sin él no se puede comprobar el cortafuegos, el acceso remoto ni las contraseñas. Reinicia el equipo; si sigue igual, instala la última actualización.");
  } else {
    if (root.firewall === "on") add("firewall", "ok", "Cortafuegos activado", "Nadie puede iniciar una conexión hacia este equipo desde la red. Lo que tú abres hacia fuera funciona con normalidad.");
    else if (root.firewall === "off") add("firewall", "bad", "Cortafuegos apagado", "Cualquier programa que escuche en la red queda a la vista de los demás equipos.", { label: "Activar", action: "firewall" });
    else add("firewall", "bad", "Falta el cortafuegos", "Esta copia de NEXUS todavía no lo trae. Llega con la próxima actualización del sistema.");

    if (root.defaultPassword === true) add("password", "bad", "La contraseña es la de fábrica", "Quien conozca NEXUS la conoce. Cámbiala: es lo que protege la pantalla bloqueada.", { label: "Cambiar", action: "password" });
    else if (root.defaultPassword === false) add("password", "ok", "Contraseña propia", "La contraseña de la cuenta no es la de fábrica.");
    else add("password", "info", "Contraseña sin comprobar", "No se ha podido comprobar si la contraseña es la de fábrica.");

    if (root.remote) add("remote", "warn", "Acceso remoto activado", "Otro equipo puede entrar por SSH si tiene una llave autorizada (nunca con contraseña). Apágalo si no lo usas.", { label: "Desactivar", action: "remote-off" });
    else add("remote", "ok", "Acceso remoto desactivado", "Nadie puede entrar en este equipo desde otro.");

    if (root.sudoNoPassword) add("sudo", "warn", "Administrar no pide contraseña", "Cualquier programa tuyo puede hacerse administrador sin preguntar.", { label: "Pedir contraseña", action: "sudo-ask" });
    else add("sudo", "ok", "Administrar pide contraseña", "Para cambiar el sistema hay que escribir la contraseña.");

    if (root.loginPassword) add("login", "ok", "Pide contraseña al encender", "Sin la contraseña no se llega al escritorio.");
    else add("login", "warn", "Entra sin contraseña al encender", "Quien encienda el equipo llega directo a tu escritorio.", { label: "Pedir contraseña", action: "login-ask" });

    if (root.hardened) add("kernel", "ok", "Núcleo reforzado", "Los programas no pueden espiarse entre sí ni leer la memoria del sistema.");
    else add("kernel", "warn", "Núcleo sin reforzar", "Las protecciones del núcleo se aplican al reiniciar tras la actualización.");
  }

  if (!user.idleAvailable) add("lock", "warn", "No se bloquea sola", "Esta copia de NEXUS todavía no trae el bloqueo automático. Llega con la próxima actualización; mientras, bloquea con Súper + L.");
  else if (user.lockAfter <= 0) add("lock", "warn", "No se bloquea sola", "La pantalla queda abierta aunque te vayas.", { label: "Bloquear a los 5 min", action: "lock-5" });
  else add("lock", "ok", `Se bloquea a los ${user.lockAfter} min`, "Si dejas el equipo quieto, la pantalla se bloquea sola y también al suspender.");

  if (user.sandbox) add("sandbox", "ok", "Agentes aislados", "Cada agente de IA y cada automatización trabaja encerrado en su carpeta, sin tus llaves ni tu red.");
  else add("sandbox", "bad", "Agentes sin aislar", "Falta la herramienta que encierra a los agentes (bubblewrap).");

  if (!user.update) add("updates", "info", "Actualizaciones sin comprobar", "Ahora mismo no se puede consultar si hay actualizaciones.");
  else if (user.update.available || user.update.debianPending > 0) add("updates", "warn", "Hay actualizaciones pendientes", "Las actualizaciones traen los arreglos de seguridad. Van firmadas: NEXUS no instala nada que no lleve su firma.", { label: "Ver", action: "updates" });
  else add("updates", "ok", "Sistema al día", "Las actualizaciones van firmadas: NEXUS no instala nada que no lleve su firma.");

  // (remote access has its own line above, and its port is open on purpose while it is on)
  const exposed = user.exposed.filter((e) => !(root?.remote && e.port === 22));
  if (exposed.length) {
    const names = exposed.slice(0, 4).map((e) => `${e.name} (${e.port})`).join(", ") + (exposed.length > 4 ? ` y ${exposed.length - 4} más` : "");
    const shut = root?.firewall === "on";
    add("exposed", shut ? "info" : "warn", shut ? "Programas a la escucha, tapados por el cortafuegos" : "Programas a la vista de la red", names);
  }

  let lost = 0;
  for (const it of items) if ((it.level === "bad" || it.level === "warn") && Object.hasOwn(WEIGHT, it.id)) lost += WEIGHT[it.id];
  if (items.some((it) => it.id === "exposed" && it.level === "warn")) lost += 5;
  const score = Math.max(0, 100 - lost);
  const bad = items.some((it) => it.level === "bad");
  const grade = bad ? (score >= 75 ? "mejorable" : "riesgo") : score >= 90 ? "protegido" : score >= 70 ? "mejorable" : "riesgo";
  const todo = items.filter((it) => it.level === "bad" || it.level === "warn").length;
  const headline = grade === "protegido" && todo === 0 ? "Tu equipo está protegido"
    : grade === "protegido" ? "Tu equipo está protegido; queda un detalle"
    : grade === "mejorable" ? `Hay ${todo} ${todo === 1 ? "cosa" : "cosas"} que mejorar`
    : `Tu equipo necesita atención: ${todo} ${todo === 1 ? "aviso" : "avisos"}`;
  return { score, grade, headline, items, guard: root !== null };
}

/** A new password good enough to protect the lock screen. Returns the problem in Spanish, or "" when it is fine. */
export function passwordProblem(next: unknown, user: string): string {
  if (typeof next !== "string" || next.length < 8) return "La contraseña nueva necesita al menos 8 caracteres.";
  if (next.length > 128) return "La contraseña nueva es demasiado larga (máximo 128).";
  if (/[\n\r\0]/.test(next)) return "La contraseña no puede tener saltos de línea.";
  const low = next.toLowerCase();
  if (low === user.toLowerCase() || (low.includes("nexus") && next.length < 12)) return "Esa contraseña es demasiado fácil de adivinar.";
  if (/^(.)\1+$/.test(next) || /^(?:0?123456789?0?|12345678|password|contraseña|qwertyui|qwertyuiop|abcd1234|iloveyou)$/i.test(next)) return "Esa contraseña es demasiado fácil de adivinar.";
  return "";
}

// ---------------------------------------------------------------- parsers (pure, tested)

export type Person = { name: string; uid: number; admin: boolean };
/** The people of this computer (uid 1000–59999 with a real shell) and whether they administer it (group sudo). */
export function people(passwd: string, group: string): Person[] {
  const sudo = new Set<string>(); let sudoGid = -1;
  for (const line of group.split("\n")) {
    const f = line.split(":");
    if (f[0] === "sudo") { sudoGid = Number(f[2]); for (const m of (f[3] ?? "").split(",")) if (m.trim()) sudo.add(m.trim()); }
  }
  const out: Person[] = [];
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f.length < 7) continue;
    const uid = Number(f[2]);
    if (!Number.isInteger(uid) || uid < 1000 || uid > 59999 || /(nologin|false)$/.test(f[6].trim())) continue;
    out.push({ name: f[0], uid, admin: sudo.has(f[0]) || Number(f[3]) === sudoGid });
  }
  return out;
}

/** A person's password hash from /etc/shadow ("" when the account has none it can log in with). */
export function shadowHash(shadow: string, user: string): string {
  for (const line of shadow.split("\n")) {
    const f = line.split(":");
    if (f[0] === user) { const h = f[1] ?? ""; return h.startsWith("$") ? h : ""; }
  }
  return "";
}

/** Does any sudoers text let someone administer without the password? (comments and Defaults lines do not count) */
export function sudoersNoPassword(texts: string[]): boolean {
  return texts.some((t) => t.split("\n").some((l) => { const s = l.trim(); return s !== "" && !s.startsWith("#") && !/^Defaults\b/.test(s) && /\bNOPASSWD\s*:/.test(s); }));
}

/** greetd's config: does it open a desktop by itself at power-on, and through NEXUS's own gate (`--initial`)? */
export function greetdAutologin(toml: string): { auto: boolean; gated: boolean } {
  let section = "", auto = false, gated = false;
  for (const raw of toml.split("\n")) {
    const l = raw.replace(/#.*$/, "").trim();
    const m = /^\[([^\]]+)\]$/.exec(l);
    if (m) { section = m[1].trim(); continue; }
    if (section === "initial_session" && /^command\s*=/.test(l)) { auto = true; gated = /--initial\b/.test(l); }
  }
  return { auto, gated };
}

const LOOPBACK = /^(?:0100007F|0000000000000000FFFF00000100007F|00000000000000000000000001000000|[0-9A-F]{6}7F)$/;
const PORT_NAMES: Record<number, string> = { 22: "Acceso remoto (SSH)", 53: "Nombres de red (DNS)", 80: "Servidor web", 443: "Servidor web", 631: "Impresoras", 5355: "Nombres de red (LLMNR)" };
/** TCP ports listening to more than this computer itself, from /proc/net/tcp and tcp6 (any user's). `names`: ports
 *  whose program is known (the person's own servers). */
export function exposedListeners(texts: string[], names: Map<number, string> = new Map()): { port: number; name: string }[] {
  const ports = new Set<number>();
  for (const text of texts) for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [addr, portHex] = f[1].split(":");
    if (!addr || !portHex || LOOPBACK.test(addr.toUpperCase())) continue;
    const port = parseInt(portHex, 16);
    if (port > 0 && port < 65536) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b).map((port) => ({ port, name: names.get(port) || PORT_NAMES[port] || "Programa" }));
}

// ---------------------------------------------------------------- the root half

export class GuardError extends Error {
  code: "auth" | "locked" | "bad" | "failed";
  constructor(message: string, code: "auth" | "locked" | "bad" | "failed" = "bad") { super(message); this.code = code; }
}

export type GuardOptions = {
  run?: Runner;
  /** where the system's files are (tests point this at a folder) */
  root?: string;
  stateDir?: string;
  now?: () => number;
  /** the factory password of the dev image, to warn while it is still in use */
  factoryPassword?: string;
};

// Overrides every earlier NOPASSWD: sudoers reads /etc/sudoers.d in name order and the LAST matching line wins.
export const SUDO_GUARD_FILE = "zz-nexus-guard";
const SUDO_GUARD_TEXT = "# NEXUS Guard (Ajustes → Privacidad y seguridad): administering asks for the password.\n# Written by nexus-guardd; remove it there, not by hand.\n%sudo ALL=(ALL:ALL) PASSWD: ALL\n";
// crypt(3) through perl (always there on Debian): the only thing that knows every hash /etc/shadow may hold (yescrypt…).
// Hash and password arrive on stdin, one per line.
const CRYPT_PERL = 'my $h = <STDIN>; my $p = <STDIN>; chomp $h; chomp $p; my $c = crypt($p, $h); print((defined $c && length $h > 3 && $c eq $h) ? "ok" : "no");';

export function createGuard(o: GuardOptions = {}) {
  const run = o.run ?? defaultRunner;
  const root = o.root ?? "/";
  const stateDir = o.stateDir ?? "/var/lib/nexus-guard";
  const now = o.now ?? Date.now;
  const factory = o.factoryPassword ?? "nexus";
  const at = (...p: string[]) => path.join(root, ...p);
  const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
  const askFlag = path.join(stateDir, "ask-password");

  const persons = () => people(read(at("etc/passwd")), read(at("etc/group")));
  const matches = async (hash: string, password: string) => {
    if (!hash || /[\n\r\0]/.test(password)) return false;
    const r = await run("perl", ["-e", CRYPT_PERL], { input: `${hash}\n${password}\n`, timeoutMs: 8000 });
    return r.code === 0 && r.out.trim() === "ok";
  };

  // ---- wrong passwords are counted for everyone together: 5 in a row lock the check for 1 min, then 2, 4… up to 15
  let fails = 0, lockedUntil = 0, strikes = 0;
  const verify = async (user: unknown, password: unknown, needAdmin: boolean) => {
    const wait = lockedUntil - now();
    if (wait > 0) throw new GuardError(`Demasiados intentos. Espera ${Math.ceil(wait / 1000)} s.`, "locked");
    if (typeof user !== "string" || typeof password !== "string" || !password) throw new GuardError("Escribe tu contraseña.", "auth");
    const p = persons().find((x) => x.name === user);
    const ok = !!p && (!needAdmin || p.admin) && await matches(shadowHash(read(at("etc/shadow")), p.name), password);
    if (!ok) {
      if (++fails >= 5) { fails = 0; lockedUntil = now() + Math.min(15, 2 ** strikes++) * 60_000; }
      throw new GuardError("La contraseña no es correcta.", "auth");
    }
    fails = 0; strikes = 0;
    return p!;
  };

  // ---- the facts. Whether a password is the factory one costs a crypt() per person: remembered per hash.
  const factoryCache = new Map<string, boolean>();
  const facts = async (): Promise<RootFacts> => {
    const nft = await run("nft", ["list", "table", "inet", "nexus"], { timeoutMs: 4000 });
    const wants = at("etc/systemd/system/multi-user.target.wants");
    const sshEnabled = fs.existsSync(path.join(wants, "ssh.service")) || fs.existsSync(path.join(wants, "sshd.service")) || fs.existsSync(at("etc/systemd/system/sockets.target.wants/ssh.socket"));
    const sshActive = root === "/" ? (await run("systemctl", ["is-active", "ssh.service", "ssh.socket"], { timeoutMs: 4000 })).out.split("\n").some((l) => l.trim() === "active") : false;
    const dir = at("etc/sudoers.d");
    let names: string[] = []; try { names = fs.readdirSync(dir).filter((n) => !n.includes(".") && !n.endsWith("~")); } catch { /* none */ }
    const sudoNoPassword = !names.includes(SUDO_GUARD_FILE) && sudoersNoPassword([read(at("etc/sudoers")), ...names.map((n) => read(path.join(dir, n)))]);
    const g = greetdAutologin(read(at("etc/greetd/config.toml")));
    const loginPassword = !g.auto || (g.gated && fs.existsSync(askFlag));
    let defaultPassword: boolean | null = null;
    const shadow = read(at("etc/shadow"));
    if (shadow) {
      defaultPassword = false;
      for (const p of persons()) {
        const h = shadowHash(shadow, p.name);
        if (!h) continue;
        if (!factoryCache.has(h)) { if (factoryCache.size > 50) factoryCache.clear(); factoryCache.set(h, await matches(h, factory)); }
        if (factoryCache.get(h)) defaultPassword = true;
      }
    }
    const sys = (k: string) => Number(read(at("proc/sys", k)).trim() || "0");
    const hardened = sys("kernel/kptr_restrict") >= 1 && sys("kernel/dmesg_restrict") >= 1 && sys("kernel/yama/ptrace_scope") >= 1 && sys("kernel/unprivileged_bpf_disabled") >= 1;
    return { firewall: nft.missing ? "missing" : nft.code === 0 ? "on" : "off", remote: sshEnabled || sshActive, sudoNoPassword, loginPassword, defaultPassword, hardened };
  };

  const must = async (cmd: string, args: string[], what: string, input?: string) => {
    const r = await run(cmd, args, { timeoutMs: 20_000, input });
    if (r.code !== 0) throw new GuardError(`${what}${r.missing ? ` (falta ${cmd})` : ""}`, "failed");
  };
  const firewallUp = () => must("systemctl", ["restart", "nexus-firewall.service"], "No se ha podido activar el cortafuegos.");

  return {
    facts,
    /** Bring the firewall up (it is never turned off from the desktop). */
    async firewall() { await firewallUp(); return facts(); },
    async remote(a: { on?: unknown; user?: unknown; password?: unknown }) {
      if (a.on === true) {
        await verify(a.user, a.password, true);
        await must("systemctl", ["enable", "--now", "ssh.service"], "No se ha podido activar el acceso remoto.");
      } else {
        await must("systemctl", ["disable", "--now", "ssh.service"], "No se ha podido desactivar el acceso remoto.");
        await run("systemctl", ["disable", "--now", "ssh.socket"], { timeoutMs: 20_000 });   // only on systems that use the socket
      }
      await firewallUp();   // the firewall opens port 22 only while SSH is enabled
      return facts();
    },
    async sudo(a: { ask?: unknown; user?: unknown; password?: unknown }) {
      const f = at("etc/sudoers.d", SUDO_GUARD_FILE);
      if (a.ask === false) { await verify(a.user, a.password, true); fs.rmSync(f, { force: true }); return facts(); }
      const tmp = path.join(stateDir, "sudoers.check");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(tmp, SUDO_GUARD_TEXT, { mode: 0o440 });
      try {
        await must("visudo", ["-cf", tmp], "No se ha podido comprobar la regla de sudo.");
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.copyFileSync(tmp, f + ".new"); fs.chmodSync(f + ".new", 0o440); fs.renameSync(f + ".new", f);
      } finally { fs.rmSync(tmp, { force: true }); }
      return facts();
    },
    async login(a: { ask?: unknown; user?: unknown; password?: unknown }) {
      if (a.ask === false) { await verify(a.user, a.password, true); fs.rmSync(askFlag, { force: true }); return facts(); }
      const g = greetdAutologin(read(at("etc/greetd/config.toml")));
      if (g.auto && !g.gated) throw new GuardError("Esta copia de NEXUS todavía no puede pedir la contraseña al encender. Llega con la próxima actualización.", "failed");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(askFlag, ""); fs.chmodSync(askFlag, 0o644);   // nexus-session (the person) looks for it
      return facts();
    },
    async password(a: { user?: unknown; current?: unknown; next?: unknown }) {
      const p = await verify(a.user, a.current, false);
      const problem = passwordProblem(a.next, p.name);
      if (problem) throw new GuardError(problem);
      if (a.next === a.current) throw new GuardError("La contraseña nueva es igual que la de ahora.");
      await must("chpasswd", [], "No se ha podido cambiar la contraseña.", `${p.name}:${a.next as string}\n`);
      return facts();
    },
  };
}
export type Guard = ReturnType<typeof createGuard>;
