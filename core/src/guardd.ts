// nexus-guardd: the root half of NEXUS Guard (core/src/guard.ts) — the firewall, remote access, sudo's password, the
// password at power-on and password changes, for Ajustes → Privacidad y seguridad.
//
//   * No network port and no network at all (its unit denies every address family but unix and netlink): it listens
//     only on the unix socket /run/nexus-guard/guard.sock, which only the group nexus-update (the desktop's people)
//     can open.
//   * It runs no command a caller sends: six fixed operations (status, firewall, remote, sudo, login, password), each
//     with checked arguments. The ones that would make the computer less safe ask for the account's password.
//   * One JSON object per line; answers carry the request's id. Operations run one at a time.
//   * The journal gets one line per change ("remote access off"), never an argument, a name or a password.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGuard, GuardError, type Guard } from "./guard.ts";

type Arg = Record<string, unknown>;
const obj = (a: unknown): Arg => (a && typeof a === "object" && !Array.isArray(a) ? a as Arg : {});

export function serveGuard(o: { socketPath: string; guard: Guard; gid?: number; log?: (line: string) => void }) {
  const log = o.log ?? ((l: string) => console.log(`nexus-guardd: ${l}`));
  const commands: Record<string, (arg: Arg) => Promise<unknown>> = {
    status: () => o.guard.facts(),
    firewall: async () => { const r = await o.guard.firewall(); log("firewall up"); return r; },
    remote: async (a) => { const r = await o.guard.remote(a); log(`remote access ${a.on === true ? "on" : "off"}`); return r; },
    sudo: async (a) => { const r = await o.guard.sudo(a); log(`sudo ${a.ask === false ? "without password" : "asks for the password"}`); return r; },
    login: async (a) => { const r = await o.guard.login(a); log(`power-on ${a.ask === false ? "without password" : "asks for the password"}`); return r; },
    password: async (a) => { const r = await o.guard.password(a); log("a password was changed"); return r; },
  };
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(fn: () => Promise<T>) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const clients = new Set<net.Socket>();
  fs.rmSync(o.socketPath, { force: true });
  const server = net.createServer((sock) => {
    if (clients.size >= 16) { sock.destroy(); return; }
    clients.add(sock);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > 8192) { sock.destroy(); return; }
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let req: { id?: unknown; cmd?: unknown; arg?: unknown };
        try { req = JSON.parse(line); } catch { sock.write(JSON.stringify({ ok: false, error: "petición mal formada" }) + "\n"); continue; }
        const id = typeof req.id === "number" || typeof req.id === "string" ? req.id : null;
        const fn = typeof req.cmd === "string" && Object.hasOwn(commands, req.cmd) ? commands[req.cmd] : null;
        if (!fn) { sock.write(JSON.stringify({ id, ok: false, error: "orden desconocida", code: "bad" }) + "\n"); continue; }
        inTurn(() => fn(obj(req.arg))).then(
          (result) => { if (!sock.destroyed) sock.write(JSON.stringify({ id, ok: true, result }) + "\n"); },
          (e) => {
            const known = e instanceof GuardError;
            if (!known) log(`an operation failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
            if (!sock.destroyed) sock.write(JSON.stringify({ id, ok: false, error: known ? e.message : "No se ha podido hacer el cambio.", code: known ? e.code : "failed" }) + "\n");
          });
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => clients.delete(sock));
  });
  server.listen(o.socketPath, () => {
    fs.chmodSync(o.socketPath, 0o660);
    if (o.gid !== undefined) fs.chownSync(o.socketPath, 0, o.gid);
  });
  return { server, close: () => { for (const c of clients) c.destroy(); server.close(); } };
}

function groupId(name: string): number | undefined {
  try {
    for (const line of fs.readFileSync("/etc/group", "utf8").split("\n")) { const f = line.split(":"); if (f[0] === name) return Number(f[2]); }
  } catch { /* none */ }
  return undefined;
}

function main() {
  const stateDir = process.env.STATE_DIRECTORY || "/var/lib/nexus-guard";
  const runDir = process.env.RUNTIME_DIRECTORY || "/run/nexus-guard";
  const gid = groupId("nexus-update");
  if (gid !== undefined) { fs.chownSync(runDir, 0, gid); fs.chmodSync(runDir, 0o710); }
  const srv = serveGuard({ socketPath: path.join(runDir, "guard.sock"), guard: createGuard({ stateDir }), gid });
  process.on("SIGTERM", () => { srv.close(); process.exit(0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
