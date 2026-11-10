// nexus-updated (core/src/updated.ts): Debian's updates through apt (a fake apt here), and the unix-socket protocol
// the desktop's session uses: one JSON object per line, answers by id, status events to every client, nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { parseAptUpgrades, createDebian, serveUpdates, shellReportOk, touchesWindowManager } from "../src/updated.ts";
import type { HistoryItem, Status } from "../src/update.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-upd-")));
const SIM = `NOTE: This is only a simulation!
Reading package lists...
Inst libc6 [2.41-12] (2.41-12+deb13u1 Debian-Security:13/stable-security [arm64])
Inst linux-image-arm64 [6.12.48-1] (6.12.57-1 Debian:13.2/stable [arm64])
Conf libc6 (2.41-12+deb13u1 Debian-Security:13/stable-security [arm64])
`;

test("apt's simulation is read as package, installed version and new version", () => {
  assert.deepEqual(parseAptUpgrades(SIM), [
    { name: "libc6", from: "2.41-12", to: "2.41-12+deb13u1" },
    { name: "linux-image-arm64", from: "6.12.48-1", to: "6.12.57-1" },
  ]);
  assert.deepEqual(parseAptUpgrades("0 upgraded, 0 newly installed\n"), []);
});

test("Debian: check counts the updates, install runs apt with progress, a new kernel asks for a restart", async () => {
  const dir = tmp(), notes: HistoryItem[] = [], calls: string[][] = [];
  const d = createDebian({
    stateFile: path.join(dir, "debian.json"), onChange: () => {}, note: (h) => notes.push(h), rebootFlag: path.join(dir, "reboot-required"),
    run: async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (args.includes("-s")) return { code: 0, out: SIM };
      if (args.includes("upgrade")) { opts.onLine?.("Setting up libc6 (2.41-12+deb13u1) ..."); opts.onLine?.("Setting up linux-image-arm64 ..."); }
      return { code: 0, out: "" };
    },
  });
  await d.check();
  assert.equal(d.status().count, 2); assert.equal(d.status().packages[0].name, "libc6");
  assert.deepEqual(calls[0], ["apt-get", "update", "-q"]);
  await d.install();
  assert.ok(calls.at(-1)!.includes("Dpkg::Options::=--force-confold"), "the person's own config files are kept");
  assert.equal(d.status().count, 0); assert.equal(d.status().rebootNeeded, true); assert.match(d.status().message!, /Reinicia/);
  assert.equal(notes[0].kind, "debian"); assert.equal(notes[0].result, "installed"); assert.equal(notes[0].version, "2 paquetes");
  await assert.rejects(d.install(), /No hay actualizaciones de Debian pendientes/);
  // offline: said in words, nothing breaks
  const off = createDebian({ stateFile: path.join(dir, "d2.json"), onChange: () => {}, note: () => {}, run: async () => ({ code: 100, out: "Could not resolve" }) });
  await off.check();
  assert.match(off.status().message!, /No se ha podido contactar con Debian/);
});

test("an update that changes labwc's settings or the NEXUS window theme makes labwc read them again", () => {
  assert.equal(touchesWindowManager(["/etc/xdg/labwc/rc.xml"]), true);
  assert.equal(touchesWindowManager(["/usr/share/nexus/shell/Dock.qml", "/usr/share/themes/NEXUS/labwc/themerc"]), true);
  assert.equal(touchesWindowManager(["/usr/share/nexus/shell/Dock.qml", "/etc/nexus/update.conf"]), false);
  assert.equal(touchesWindowManager(["/usr/share/themes/Adwaita/gtk-3.0/gtk.css", "/etc/xdg/labwcx"]), false);
});

test("the shell's report: whole and newer than the restart, or no restart and no file", () => {
  const dir = tmp(), f = path.join(dir, "shell-health.json");
  assert.equal(shellReportOk(f, 0), true, "no desktop restart, no report: nothing to judge");
  assert.equal(shellReportOk(f, Date.now()), false, "restarted, and it never said it came back");
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), parts: ["topBar"], failed: [] }));
  assert.equal(shellReportOk(f, Date.now() - 5000), true);
  assert.equal(shellReportOk(f, Date.now() + 60_000), false, "a report from before the restart does not count");
  fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), parts: ["topBar"], failed: ["topBar"] }));
  assert.equal(shellReportOk(f, 0), false, "a part that did not load");
  fs.writeFileSync(f, "{");
  assert.equal(shellReportOk(f, 0), false);
});

test("the socket: answers by id, long jobs answer at once and report by events, unknown orders are refused", async () => {
  const dir = tmp(), sock = path.join(dir, "updated.sock");
  let st: Status = { state: "idle", installed: "0.2.0", autoDownload: true };
  let finishDownload: () => void = () => {};
  let installs = 0;
  const updater = {
    status: () => st,
    check: async () => { st = { ...st, state: "available", available: { version: "0.2.1", notes: ["Mejoras"], size: 10, released: "x" } }; return st; },
    download: () => new Promise<Status>((r) => { finishDownload = () => { st = { ...st, state: "ready" }; r(st); }; }),
    install: async () => { installs++; st = { ...st, state: "idle", installed: "0.2.1" }; return st; }, undo: async () => st, history: () => [], setAutoDownload: (on: boolean) => { st = { ...st, autoDownload: on }; return st; },
  };
  const debian = createDebian({ stateFile: path.join(dir, "deb.json"), onChange: () => {}, note: () => {}, run: async () => ({ code: 0, out: "" }) });
  const srv = serveUpdates({ socketPath: sock, updater: updater as never, debian, versions: () => ({ nexus: st.installed }) });
  await new Promise((r) => srv.server.once("listening", r));
  assert.equal(fs.statSync(sock).mode & 0o777, 0o660, "only root and the group nexus-update");

  const c = net.connect(sock); c.setEncoding("utf8");
  const lines: any[] = []; let buf = "";
  c.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const wait = async (pred: (l: any) => boolean) => { for (let i = 0; i < 100; i++) { const l = lines.find(pred); if (l) return l; await new Promise((r) => setTimeout(r, 10)); } throw new Error("no answer"); };
  await new Promise((r) => c.once("connect", r));

  c.write(JSON.stringify({ id: 1, cmd: "status" }) + "\n");
  const s1 = await wait((l) => l.id === 1);
  assert.equal(s1.ok, true); assert.equal(s1.result.installed, "0.2.0"); assert.equal(s1.result.versions.nexus, "0.2.0"); assert.equal(s1.result.debian.count, 0);
  c.write(JSON.stringify({ id: 2, cmd: "check" }) + "\n");
  assert.equal((await wait((l) => l.id === 2)).result.available.version, "0.2.1");
  c.write(JSON.stringify({ id: 3, cmd: "download" }) + "\n");
  assert.equal((await wait((l) => l.id === 3)).ok, true, "answered before the download ends");
  finishDownload();
  const ev = await wait((l) => l.event === "status" && l.data.state === "ready");
  assert.equal(ev.data.available.version, "0.2.1");
  assert.equal(installs, 0, "a plain download installs nothing");
  // "download, then install": one job; already downloaded, it goes straight to the install
  c.write(JSON.stringify({ id: 7, cmd: "download", arg: "install" }) + "\n");
  await wait((l) => l.event === "status" && l.data.installed === "0.2.1");
  assert.equal(installs, 1);
  c.write(JSON.stringify({ id: 4, cmd: "rm -rf /" }) + "\n");
  assert.match((await wait((l) => l.id === 4)).error, /orden desconocida/);
  c.write(JSON.stringify({ id: 5, cmd: "auto", arg: "yes" }) + "\n");
  assert.equal((await wait((l) => l.id === 5)).ok, false);
  c.write(JSON.stringify({ id: 6, cmd: "auto", arg: false }) + "\n");
  assert.equal((await wait((l) => l.id === 6)).result.autoDownload, false);
  c.write("not json\n");
  assert.match((await wait((l) => l.error === "petición mal formada")).error, /mal formada/);
  // a client that sends an endless line is cut off
  const big = net.connect(sock); await new Promise((r) => big.once("connect", r));
  const closed = new Promise((r) => big.once("close", r));
  big.write("x".repeat(20_000)); await closed;
  c.destroy(); srv.close();
});
