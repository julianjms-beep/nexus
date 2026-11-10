// Local servers the person is running, for the browser's new tab ("Servidores en marcha"): TCP sockets in LISTEN
// state on localhost or on every address, owned by this user, with the program's name. Read from /proc only:
// nothing is probed over the network and other users' sockets are never listed.
import fs from "node:fs";

// /proc/net/tcp{,6} addresses (hex, each 32-bit word little-endian) that a browser reaches as http://localhost:PORT
const LOOPBACK_OR_ANY = new Set([
  "0100007F", "00000000",                                            // 127.0.0.1, 0.0.0.0
  "00000000000000000000000001000000", "00000000000000000000000000000000", // ::1, ::
  "0000000000000000FFFF00000100007F",                                // ::ffff:127.0.0.1
]);

export type Listener = { port: number; inode: string };

/** LISTEN rows (st 0A) of one /proc/net/tcp or tcp6 file that belong to `uid` and answer on localhost. */
export function parseListeners(text: string, uid: number): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A" || Number(f[7]) !== uid) continue;
    const [addr, portHex] = f[1].split(":");
    if (!addr || !portHex || !LOOPBACK_OR_ANY.has(addr.toUpperCase())) continue;
    const port = parseInt(portHex, 16);
    if (port > 0 && port < 65536) out.push({ port, inode: f[9] });
  }
  return out;
}

/** A friendlier name for well-known development servers; otherwise the program name. */
export function serverName(comm: string, cmdline: string, fallback: (comm: string, cmdline: string) => string = (c) => c): string {
  const c = cmdline.split("\0").join(" ");
  if (/\bvite\b/.test(c)) return "Vite";
  if (/\bnext(\.js)?\b.*\b(dev|start)\b/.test(c)) return "Next.js";
  if (/\bastro\b/.test(c)) return "Astro";
  if (/\buvicorn\b/.test(c)) return "Uvicorn";
  if (/\bgunicorn\b/.test(c)) return "Gunicorn";
  if (/manage\.py\s+runserver/.test(c)) return "Django";
  if (/\bflask\b/.test(c)) return "Flask";
  if (/\bhttp\.server\b/.test(c)) return "python http.server";
  if (/\bjupyter\b/.test(c)) return "Jupyter";
  return fallback(comm, cmdline) || comm;
}

export type LocalServer = { port: number; process: string; folder: string };

/** Servers of this user listening on localhost, sorted by port. `hide` drops NEXUS's own services by name. */
export function localServers(opts: { uid?: number; proc?: string; name?: (comm: string, cmdline: string) => string; hide?: (name: string) => boolean } = {}): LocalServer[] {
  const proc = opts.proc ?? "/proc";
  const uid = opts.uid ?? (process.getuid ? process.getuid() : -1);
  let ls: Listener[] = [];
  for (const f of ["net/tcp", "net/tcp6"]) {
    try { ls = ls.concat(parseListeners(fs.readFileSync(`${proc}/${f}`, "utf8"), uid)); } catch { /* no IPv6, or not Linux */ }
  }
  if (!ls.length) return [];
  const want = new Map(ls.map((l) => [`socket:[${l.inode}]`, l.port]));
  const owner = new Map<number, string>(), where = new Map<number, string>();
  let pids: string[] = [];
  try { pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { /* not Linux */ }
  for (const pid of pids) {
    if (owner.size === want.size) break;
    let fds: string[];
    try { fds = fs.readdirSync(`${proc}/${pid}/fd`); } catch { continue; } // another user's process
    for (const fd of fds) {
      let link: string;
      try { link = fs.readlinkSync(`${proc}/${pid}/fd/${fd}`); } catch { continue; }
      const port = want.get(link);
      if (port === undefined || owner.has(port)) continue;
      let comm = "", cmd = "";
      try { comm = fs.readFileSync(`${proc}/${pid}/comm`, "utf8").trim(); cmd = fs.readFileSync(`${proc}/${pid}/cmdline`, "utf8"); } catch { /* exited */ }
      owner.set(port, serverName(comm, cmd, opts.name));
      try { const cwd = fs.readlinkSync(`${proc}/${pid}/cwd`); if (cwd !== "/") where.set(port, cwd.split("/").filter(Boolean).pop() ?? ""); } catch { /* exited */ }
    }
  }
  const ports = [...new Set(ls.map((l) => l.port))].sort((a, b) => a - b);
  return ports.map((port) => ({ port, process: owner.get(port) ?? "", folder: where.get(port) ?? "" })).filter((s) => !(opts.hide?.(s.process)));
}
