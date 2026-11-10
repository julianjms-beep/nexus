// How an AI agent is isolated on a computer that is NOT NEXUS OS (the standalone `nexus-agent`, core/src/standalone.ts):
//
//   * macOS: the kernel's sandbox (Seatbelt, through /usr/bin/sandbox-exec) with a profile written here. The agent
//     gets a private home of its own; the person's home, other disks, the shared temp folder, the clipboard, the
//     Keychain, other apps (Apple Events, LaunchServices) and other processes are out of reach. It can write only in
//     the project folder and its own home. The network stays (the agent talks to its model's API).
//   * Linux: bubblewrap, the same sandbox NEXUS OS uses (core/src/agentd.ts), plus the folders where developers keep
//     their tools inside the home (nvm, cargo, pyenv…), read-only, so `node`, `claude` or `cargo` exist inside.
//
// Both hand the agent the same deal: its own home, the project, the tools — never keys or tokens. A command the agent
// asks NEXUS to run sees the person's SSH keys only when the person approved that very command (`keys`).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { agentSandboxArgv, type AgentPlatform, type AgentSandboxSpec } from "./agentd.ts";
import { sandboxArgv } from "./automations.ts";

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const uniq = (a: string[]) => [...new Set(a)];
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
const sbq = (p: string) => JSON.stringify(p);   // Seatbelt string literals escape like JSON for the paths we pass
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Where programs live inside a home folder. Programs and their libraries only: never a folder that also keeps
// credentials (~/.cargo holds credentials.toml, so only its bin; ~/.npmrc, ~/.aws, ~/.config/gh… are not here).
const TOOL_PLACES = [
  ".gitconfig", ".config/git", ".local/bin", ".local/lib", ".local/share/claude", ".nvm/versions", ".volta", ".asdf", ".local/share/mise",
  ".local/share/fnm", ".local/share/pnpm", "Library/pnpm", ".cargo/bin", ".rustup", ".bun/bin", ".bun/install/global", ".deno/bin", ".pyenv", "go/bin", ".sdkman/candidates",
];
/** The tool folders that exist in this home (real paths), plus `extra` (where node and nexus-agent themselves are). */
export function toolDirs(home: string, extra: string[] = []): string[] {
  const h = real(home);
  return uniq([...TOOL_PLACES.map((r) => path.join(h, r)).filter((p) => fs.existsSync(p)).map(real), ...extra.filter((p) => fs.existsSync(p)).map(real)]);
}
/** The person's PATH without the entries the sandbox hides (anything in the home that is not a tool folder). */
export function sandboxPath(home: string, tools: string[], current = process.env.PATH ?? ""): string {
  const h = real(home);
  const keep = uniq(current.split(":").filter((p) => p && path.isAbsolute(p))).filter((p) => { const r = real(p); return !inside(r, h) || tools.some((t) => inside(r, t)); });
  for (const d of ["/usr/local/bin", "/usr/bin", "/bin"]) if (!keep.includes(d)) keep.push(d);
  return keep.join(":");
}

// ---------------------------------------------------------------- macOS

// Services of the system a command-line program needs: logging, user lookup, certificate checks, preferences, network
// configuration, DNS, temp folders, file watching. Everything else is denied by name — among it the clipboard
// (com.apple.pasteboard.1), the Keychain (SecurityServer), LaunchServices (opening apps) and the window server.
const MACH_OK = [
  "com.apple.system.logger", "com.apple.logd", "com.apple.system.notification_center", "com.apple.diagnosticd", "com.apple.analyticsd",
  "com.apple.system.opendirectoryd.libinfo", "com.apple.system.DirectoryService.libinfo_v1",
  "com.apple.trustd", "com.apple.trustd.agent", "com.apple.ocspd",
  "com.apple.cfprefsd.daemon", "com.apple.cfprefsd.agent",
  "com.apple.SystemConfiguration.configd", "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.networkd", "com.apple.dnssd.service",
  "com.apple.bsd.dirhelper", "com.apple.FSEvents", "com.apple.CoreServices.coreservicesd",
];
const MACH_KEYS = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.securityd.xpc", "com.apple.security.agent"];

export type MacProfileSpec = {
  home: string; agentHome: string; folder: string; read: string[]; write: string[]; tools: string[];
  /** the person approved this command: their SSH folder, SSH agent and Keychain are reachable */
  keys?: boolean; sshAuthSock?: string;
};
/** The Seatbelt profile. Later rules win over earlier ones, so each block denies broadly and then opens the little it needs. */
export function macProfile(o: MacProfileSpec): string {
  const H = real(o.home), A = real(o.agentHome);
  const rw = uniq([real(o.folder), A, ...o.write.map(real)]);
  const keyPaths = o.keys ? [".ssh", ".npmrc", "Library/Keychains"].map((r) => path.join(H, r)).filter((p) => fs.existsSync(p)) : [];
  const ro = uniq([...o.read.map(real), ...o.tools.map(real), ...keyPaths]).filter((p) => !rw.includes(p));
  const sock = o.keys && o.sshAuthSock && fs.existsSync(o.sshAuthSock) ? real(o.sshAuthSock) : "";
  const parents = (p: string) => { const out: string[] = []; for (let d = path.dirname(p); d !== "/" && d !== "."; d = path.dirname(d)) out.push(d); return out; };
  const meta = uniq([...rw, ...ro, ...(sock ? [sock] : [])].flatMap(parents)).filter((d) => ![...rw, ...ro].some((x) => inside(d, x)));
  const sub = (ps: string[]) => ps.map((p) => `(subpath ${sbq(p)})`).join(" ");
  const lit = (ps: string[]) => ps.map((p) => `(literal ${sbq(p)})`).join(" ");
  const names = (ns: string[]) => ns.map((n) => `(global-name ${sbq(n)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "; ---- writing: only the project, the agent's own home and the terminal",
    "(deny file-write*)",
    `(allow file-write* ${sub(rw)} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/ptmx") (regex #"^/dev/tty") (regex #"^/dev/fd/")`,
    `  (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))`,
    "; ---- reading: nobody's home, no other disks, no shared temp folders, no keychains",
    `(deny file-read* (subpath ${sbq(H)}) (subpath "/Users") (subpath "/Volumes") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/root") (subpath "/Library/Keychains") (subpath "/private/var/db/sudo"))`,
    `(allow file-read* ${sub([...rw, ...ro])} (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db"))`,
    meta.length ? `(allow file-read-metadata ${lit(meta)})` : "",
    // (the way down to that one cache file of Apple's developer tools: git, cc… are xcrun shims)
    `(allow file-read-metadata (literal "/private/var/folders") (regex #"^/private/var/folders/[^/]+$") (regex #"^/private/var/folders/[^/]+/[^/]+(/T)?$"))`,
    "; ---- other programs: only the system services a command-line tool needs",
    "(deny mach-lookup)",
    `(allow mach-lookup ${names([...MACH_OK, ...(o.keys ? MACH_KEYS : [])])})`,
    "(deny appleevent-send)",
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "; ---- no local sockets of other programs (SSH agent, Docker…); the name service is the exception",
    "(deny network-outbound (remote unix-socket))",
    `(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))`,
    sock ? `(allow network-outbound (remote unix-socket (path-literal ${sbq(sock)})))\n(allow file-read* file-write* (literal ${sbq(sock)}))` : "",
  ].filter(Boolean).join("\n") + "\n";
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export type PlatformOptions = {
  home: string;
  /** a private home for the commands NEXUS runs for agents (their caches live there) */
  commandHome: string;
  /** extra read-only folders: where node and nexus-agent themselves are installed */
  extraTools?: string[];
  runtimeDirs?: string[];
  env?: NodeJS.ProcessEnv;
};
function baseEnv(o: PlatformOptions, home: string, tools: string[]): NodeJS.ProcessEnv {
  const src = o.env ?? process.env;
  const e: NodeJS.ProcessEnv = { HOME: home, PATH: sandboxPath(o.home, tools, src.PATH), LANG: src.LANG ?? "en_US.UTF-8", TERM: "dumb", CI: "1" };
  if (src.TZ) e.TZ = src.TZ;
  return e;
}

export function macPlatform(o: PlatformOptions): AgentPlatform & { tools: string[] } {
  const tools = toolDirs(o.home, o.extraTools);
  const sshAuthSock = (o.env ?? process.env).SSH_AUTH_SOCK;
  const ready = (home: string) => { fs.mkdirSync(path.join(home, "tmp"), { recursive: true, mode: 0o700 }); return real(home); };
  return {
    tools,
    available: () => fs.existsSync(SANDBOX_EXEC),
    agent: (s: AgentSandboxSpec) => {
      const home = ready(s.agentHome);
      return { argv: [SANDBOX_EXEC, "-p", macProfile({ home: o.home, agentHome: home, folder: s.folder, read: s.read, write: s.write, tools })], home };
    },
    command: (command, cwd, root, keys) => {
      const home = ready(o.commandHome);
      const profile = macProfile({ home: o.home, agentHome: home, folder: root, read: [], write: [], tools, keys, sshAuthSock });
      return [SANDBOX_EXEC, "-p", profile, "/bin/sh", "-c", `cd ${shq(cwd)} && ${command}`];
    },
    env: () => {
      const home = ready(o.commandHome);
      return { ...baseEnv(o, home, tools), TMPDIR: path.join(home, "tmp"), ...(sshAuthSock ? { SSH_AUTH_SOCK: sshAuthSock } : {}) };
    },
  };
}

// ---------------------------------------------------------------- Linux (outside NEXUS OS)

let bwrapWorks: boolean | undefined;
/** bubblewrap is installed AND this kernel lets an ordinary user use it (some distributions switch that off). */
export function bubblewrapWorks(): boolean {
  if (bwrapWorks === undefined) {
    const r = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "/bin/true"], { stdio: "ignore", timeout: 5000 });
    bwrapWorks = r.status === 0;
  }
  return bwrapWorks;
}
export function linuxPlatform(o: PlatformOptions): AgentPlatform & { tools: string[] } {
  const home = real(o.home), tools = toolDirs(o.home, o.extraTools);
  const runtimeDirs = o.runtimeDirs ?? ["/run/user", "/run/dbus"];
  // the tool folders inside the home come back read-only after the home itself has been replaced
  const withTools = (argv: string[], already: string[]) => {
    const add = tools.filter((t) => inside(t, home) && !already.includes(t)).flatMap((t) => ["--ro-bind", t, t]);
    const at = argv.indexOf("--chdir");
    return [...argv.slice(0, at), ...add, ...argv.slice(at)];
  };
  const bound = (argv: string[]) => argv.filter((_, i) => argv[i - 2] === "--ro-bind" || argv[i - 2] === "--bind");
  return {
    tools,
    available: bubblewrapWorks,
    agent: (s: AgentSandboxSpec) => { const a = agentSandboxArgv({ ...s, runtimeDirs }); return { argv: withTools(a, bound(a)), home: s.home }; },
    command: (command, cwd, root, keys) => {
      const a = sandboxArgv(command, root, o.home, runtimeDirs, keys);
      a[a.indexOf("--chdir") + 1] = cwd;
      return withTools(a, bound(a));
    },
    env: () => baseEnv(o, o.home, tools),
  };
}

/** The platform of this computer, or null when nexus-agent cannot isolate programs here. */
export function detectPlatform(o: PlatformOptions, platform: string = process.platform): (AgentPlatform & { tools: string[] }) | null {
  return platform === "darwin" ? macPlatform(o) : platform === "linux" ? linuxPlatform(o) : null;
}
