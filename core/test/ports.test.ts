// Local servers for the browser's new tab: parsed from a fake /proc (no network, other users never listed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseListeners, localServers, serverName } from "../src/ports.ts";

const HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
const row = (addr: string, port: number, st: string, uid: number, inode: number) =>
  `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`;

test("only LISTEN sockets of this user on localhost or every address", () => {
  const t = HEAD + row("0100007F", 3000, "0A", 1000, 11) + row("00000000", 5173, "0A", 1000, 12) + row("0100007F", 8080, "01", 1000, 13)
    + row("0100007F", 7777, "0A", 990, 14) + row("0A00020F", 9000, "0A", 1000, 15);
  assert.deepEqual(parseListeners(t, 1000), [{ port: 3000, inode: "11" }, { port: 5173, inode: "12" }]);
  const t6 = HEAD + row("00000000000000000000000001000000", 8000, "0A", 1000, 21) + row("00000000000000000000000000000000", 3000, "0A", 1000, 22);
  assert.deepEqual(parseListeners(t6, 1000).map((l) => l.port), [8000, 3000]);
});

test("ports get their program's name; dev servers are recognised; NEXUS's own are hidden", () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-proc-"));
  fs.mkdirSync(path.join(proc, "net"));
  fs.writeFileSync(path.join(proc, "net", "tcp"), HEAD + row("0100007F", 5173, "0A", 1000, 31) + row("0100007F", 7779, "0A", 1000, 32) + row("00000000", 8000, "0A", 1000, 33));
  fs.writeFileSync(path.join(proc, "net", "tcp6"), HEAD + row("00000000000000000000000000000000", 5173, "0A", 1000, 34));
  const pid = (n: number, comm: string, cmd: string[], inodes: number[]) => {
    const d = path.join(proc, String(n)); fs.mkdirSync(path.join(d, "fd"), { recursive: true });
    fs.writeFileSync(path.join(d, "comm"), comm + "\n"); fs.writeFileSync(path.join(d, "cmdline"), cmd.join("\0") + "\0");
    inodes.forEach((i, k) => fs.symlinkSync(`socket:[${i}]`, path.join(d, "fd", String(k + 3))));
  };
  pid(100, "node", ["node", "/home/x/web/node_modules/.bin/vite", "--port", "5173"], [31, 34]);
  fs.mkdirSync(path.join(proc, "web")); fs.symlinkSync(path.join(proc, "web"), path.join(proc, "100", "cwd"));
  pid(101, "MainThread", ["/usr/lib/nexus/node/bin/node", "core/src/sessiond.ts"], [32]);
  pid(102, "python3", ["python3", "-m", "http.server"], [33]);
  const name = (c: string, cmd: string) => (/sessiond\.ts/.test(cmd) ? "Sesión NEXUS" : c);
  assert.deepEqual(localServers({ uid: 1000, proc, name, hide: (n) => /NEXUS/.test(n) }), [{ port: 5173, process: "Vite", folder: "web" }, { port: 8000, process: "python http.server", folder: "" }]);
  assert.deepEqual(localServers({ uid: 1001, proc }), [], "someone else's servers are never listed");
  assert.equal(serverName("node", "node\0server.js\0"), "node");
});
