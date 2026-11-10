// Automatizaciones: validation, time rules, the sandbox command line, runs, notices and the files trigger.
// Commands are run by a stand-in for bubblewrap (plain /bin/sh) so this works on the Mac; the real sandbox is
// checked by its command line here and by running it on NEXUS OS.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Automations, validate, due, nextRun, describe, sandboxArgv, homeFolder } from "../src/automations.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-auto-")));
const APPS = { terminal: "Terminal", browser: "Navegador" };
const shSpawn = (argv: string[]) => spawn("/bin/sh", ["-c", argv[argv.length - 1]], { cwd: argv[argv.indexOf("--chdir") + 1], stdio: ["ignore", "pipe", "pipe"] });
function make(home: string, extra: Record<string, unknown> = {}) {
  const notices: [string, string][] = []; const launched: string[] = [];
  const a = new Automations({ configDir: path.join(home, ".config/nexus"), home, runtimeDir: path.join(home, "run"), apps: APPS,
    notice: (t, k) => notices.push([t, k]), changed: () => {}, launch: (x) => launched.push(x),
    spawnFn: shSpawn, hasSandbox: () => true, tickMs: 60_000, debounceMs: 80, ...extra });
  return { a, notices, launched };
}
const waitFor = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 25)); } };

test("validate: rules are normalised; folders must exist inside home; errors are for the person", () => {
  const home = tmp(); fs.mkdirSync(path.join(home, "proyectos/web"), { recursive: true });
  const a = validate({ name: "  Tests  web ", trigger: { kind: "files", path: "~/proyectos/web" }, action: { kind: "command", command: "npm test" } }, home, Object.keys(APPS));
  assert.equal(a.name, "Tests web");
  assert.deepEqual(a.trigger, { kind: "files", path: path.join(home, "proyectos/web") });
  assert.deepEqual(a.action, { kind: "command", command: "npm test", cwd: path.join(home, "proyectos/web") }, "cwd defaults to the watched folder");
  assert.equal(a.notify, "failure"); assert.equal(a.enabled, true);
  assert.deepEqual(validate({ name: "x", trigger: { kind: "daily", time: "09:00" }, action: { kind: "open", app: "browser" }, notify: "always" }, home, Object.keys(APPS)).trigger, { kind: "daily", time: "09:00" });
  const bad: [any, RegExp][] = [
    [{ trigger: { kind: "login" }, action: { kind: "notify", text: "x" } }, /nombre/],
    [{ name: "x", trigger: { kind: "daily", time: "9" }, action: { kind: "notify", text: "x" } }, /HH:MM/],
    [{ name: "x", trigger: { kind: "interval", minutes: 0 }, action: { kind: "notify", text: "x" } }, /minutos/],
    [{ name: "x", trigger: { kind: "files", path: "/etc" }, action: { kind: "notify", text: "x" } }, /dentro de tu carpeta personal/],
    [{ name: "x", trigger: { kind: "files", path: "~/no-existe" }, action: { kind: "notify", text: "x" } }, /no existe/],
    [{ name: "x", trigger: { kind: "login" }, action: { kind: "open", app: "rm" } }, /app no existe/],
    [{ name: "x", trigger: { kind: "login" }, action: { kind: "command", command: " ", cwd: "~" } }, /comando/],
    [{ name: "x", trigger: { kind: "cron" }, action: { kind: "notify", text: "x" } }, /cuándo/],
  ];
  for (const [input, re] of bad) assert.throws(() => validate(input, home, Object.keys(APPS)), re, JSON.stringify(input));
  fs.symlinkSync("/etc", path.join(home, "fuera"));
  assert.throws(() => homeFolder("~/fuera", home), /dentro de tu carpeta personal/, "a link out of home is refused");
});

test("due: every N minutes, and daily at HH:MM with one catch-up if the computer was off", () => {
  const at = (s: string) => new Date(s);
  assert.equal(due({ kind: "interval", minutes: 30 }, at("2026-11-09T09:00:00"), at("2026-11-09T09:29:00")), false);
  assert.equal(due({ kind: "interval", minutes: 30 }, at("2026-11-09T09:00:00"), at("2026-11-09T09:30:00")), true);
  const d = { kind: "daily", time: "09:00" } as const;
  assert.equal(due(d, at("2026-11-08T09:00:05"), at("2026-11-09T08:59:00")), false);
  assert.equal(due(d, at("2026-11-08T09:00:05"), at("2026-11-09T09:00:10")), true);
  assert.equal(due(d, at("2026-11-08T09:00:05"), at("2026-11-09T15:00:00")), true, "switched on at 15:00: runs once");
  assert.equal(due(d, at("2026-11-09T15:00:01"), at("2026-11-09T15:30:00")), false, "…and not again that day");
  assert.equal(due(d, at("2026-11-09T10:00:00"), at("2026-11-09T11:00:00")), false, "created after 09:00: first run tomorrow");
  assert.equal(due({ kind: "login" }, at("2020-01-01"), at("2026-11-09")), false);
});

test("describe: plain Spanish for the list", () => {
  const home = "/home/carlos";
  const base = { id: "1", name: "n", enabled: true, notify: "failure" as const, created: "" };
  assert.deepEqual(describe({ ...base, trigger: { kind: "files", path: "/home/carlos/proyectos/web" }, action: { kind: "command", command: "npm test", cwd: "/home/carlos/proyectos/web" } }, home),
    { when: "Cuando cambie algo en ~/proyectos/web", what: "Ejecuta «npm test» en ~/proyectos/web" });
  assert.equal(describe({ ...base, trigger: { kind: "interval", minutes: 120 }, action: { kind: "open", app: "browser" } }, home, APPS).when, "Cada 2 horas");
  assert.equal(describe({ ...base, trigger: { kind: "interval", minutes: 120 }, action: { kind: "open", app: "browser" } }, home, APPS).what, "Abre Navegador");
  assert.equal(describe({ ...base, trigger: { kind: "daily", time: "09:00" }, action: { kind: "notify", text: "Stand-up" } }, home).when, "Cada día a las 09:00");
});

test("sandbox: system read-only, home hidden except the project, NEXUS sockets and tokens hidden", () => {
  const home = tmp(); const proj = path.join(home, "p"); fs.mkdirSync(proj); fs.mkdirSync(path.join(home, ".ssh")); fs.mkdirSync(path.join(home, ".cache"));
  const run = path.join(home, "runuser"); fs.mkdirSync(run);
  const v = sandboxArgv("npm test", proj, home, [run, "/no/such/dir"]);
  const s = v.join(" ");
  assert.equal(v[0], "bwrap");
  assert.match(s, /--ro-bind \/ \//);
  assert.ok(s.includes(`--tmpfs ${run}`)); assert.ok(!s.includes("/no/such/dir"));
  assert.ok(s.includes(`--tmpfs ${home} `), "the home folder is hidden…");
  assert.ok(s.includes(`--bind ${proj} ${proj} --chdir ${proj}`), "…except the project, writable");
  assert.ok(s.includes(`--ro-bind ${home}/.ssh ${home}/.ssh`), "ssh keys read-only for git pull");
  assert.ok(s.includes(`--bind ${home}/.cache ${home}/.cache`));
  assert.ok(s.indexOf(`--tmpfs ${home} `) < s.indexOf(`--bind ${proj}`), "order: hide first, then bind");
  assert.ok(s.includes("--unshare-pid") && s.includes("--die-with-parent") && s.includes("--new-session"));
  assert.deepEqual(v.slice(-4), ["--", "/bin/sh", "-c", "npm test"]);
});

test("runs: output, exit code, history, notices on failure only (by default), stop", async () => {
  const home = tmp(); fs.mkdirSync(path.join(home, "p"));
  const { a, notices } = make(home);
  const ok = a.save_({ name: "Pasa", trigger: { kind: "interval", minutes: 60 }, action: { kind: "command", command: "echo hola", cwd: "~/p" } });
  const bad = a.save_({ name: "Tests", trigger: { kind: "interval", minutes: 60 }, action: { kind: "command", command: "echo fallo >&2; exit 3", cwd: "~/p" } });
  a.runNow(ok.id); a.runNow(bad.id);
  await waitFor(() => a.history(ok.id).length === 1 && a.history(bad.id).length === 1);
  const r1 = a.history(ok.id)[0], r2 = a.history(bad.id)[0];
  assert.equal(r1.ok, true); assert.equal(r1.output.trim(), "hola"); assert.equal(r1.reason, "a mano");
  assert.equal(r2.ok, false); assert.equal(r2.exitCode, 3); assert.match(r2.output, /fallo/);
  assert.deepEqual(notices, [["Tests: ha fallado (código 3)", "warn"]]);
  const v = a.view().find((x) => x.id === bad.id)!;
  assert.equal(v.last?.ok, false); assert.equal(v.when, "Cada hora"); assert.match(v.what, /Ejecuta «echo fallo/);
  // a long command can be stopped
  const slow = a.save_({ name: "Lento", trigger: { kind: "login" }, action: { kind: "command", command: "sleep 30", cwd: "~/p" }, notify: "always" });
  assert.equal(a.runNow(slow.id).started, true);
  assert.equal(a.runNow(slow.id).started, false, "never two runs of the same rule at once");
  a.stopRun(slow.id);
  await waitFor(() => a.history(slow.id).length === 1);
  assert.equal(a.history(slow.id)[0].killed, "stopped"); assert.equal(a.history(slow.id)[0].ok, false);
  // saved to disk, 0600, and read back
  const f = path.join(home, ".config/nexus/automations.json");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(make(home).a.view().length, 3);
  a.stop();
});

test("notices and apps; a command is refused (never run unconfined) when the sandbox is missing", async () => {
  const home = tmp();
  const { a, notices, launched } = make(home);
  const n = a.save_({ name: "Stand-up", trigger: { kind: "daily", time: "09:55" }, action: { kind: "notify", text: "Reunión en 5 minutos" } });
  const o = a.save_({ name: "Abrir", trigger: { kind: "login" }, action: { kind: "open", app: "browser" } });
  a.runNow(n.id); a.runNow(o.id);
  assert.deepEqual(notices, [["Reunión en 5 minutos", "info"]]); assert.deepEqual(launched, ["browser"]);
  const { a: b } = make(home, { hasSandbox: () => false });
  assert.throws(() => b.save_({ name: "x", trigger: { kind: "login" }, action: { kind: "command", command: "true", cwd: "~" } }), /bubblewrap/);
  a.stop(); b.stop();
});

test("files trigger: a change runs it once (debounced); node_modules/.git changes and its own writes do not", async () => {
  const home = tmp(); const proj = path.join(home, "web"); fs.mkdirSync(path.join(proj, "node_modules"), { recursive: true }); fs.mkdirSync(path.join(proj, "src"));
  const { a } = make(home);
  const r = a.save_({ name: "Tests al guardar", trigger: { kind: "files", path: "~/web" }, action: { kind: "command", command: "echo ok > salida.txt" } });
  a.start();
  await new Promise((x) => setTimeout(x, 150));
  fs.writeFileSync(path.join(proj, "node_modules/x.js"), "1");
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(a.history(r.id).length, 0, "node_modules is ignored");
  fs.writeFileSync(path.join(proj, "src/a.ts"), "1"); fs.writeFileSync(path.join(proj, "src/b.ts"), "2");
  await waitFor(() => a.history(r.id).length === 1);
  assert.match(a.history(r.id)[0].reason, /^cambio en /);
  await new Promise((x) => setTimeout(x, 600));
  assert.equal(a.history(r.id).length, 1, "two quick saves = one run, and its own salida.txt does not trigger it again");
  a.setEnabled(r.id, false);
  fs.writeFileSync(path.join(proj, "src/c.ts"), "3");
  await new Promise((x) => setTimeout(x, 300));
  assert.equal(a.history(r.id).length, 1, "switched off: nothing runs");
  a.stop();
});

test("login rules run once per session, not on every restart of the session daemon", async () => {
  const home = tmp();
  const { a, notices } = make(home);
  a.save_({ name: "Hola", trigger: { kind: "login" }, action: { kind: "notify", text: "Buenos días" } });
  a.start(); a.stop();
  const { a: again, notices: n2 } = make(home);
  again.start(); again.stop();
  assert.deepEqual(notices, [["Buenos días", "info"]]); assert.deepEqual(n2, []);
});

test("next run: interval from the last start, daily today or tomorrow, nothing for files/login", () => {
  const now = new Date(2026, 10, 9, 10, 0);
  assert.equal(nextRun({ kind: "interval", minutes: 30 }, new Date(2026, 10, 9, 9, 45), now)!.getTime(), new Date(2026, 10, 9, 10, 15).getTime());
  assert.equal(nextRun({ kind: "interval", minutes: 5 }, new Date(2026, 10, 9, 9, 0), now)!.getTime(), now.getTime(), "overdue: now");
  assert.equal(nextRun({ kind: "daily", time: "18:30" }, new Date(2026, 10, 9, 9, 0), now)!.getTime(), new Date(2026, 10, 9, 18, 30).getTime());
  assert.equal(nextRun({ kind: "daily", time: "09:00" }, new Date(2026, 10, 9, 9, 0, 5), now)!.getTime(), new Date(2026, 10, 10, 9, 0).getTime(), "ran today: tomorrow");
  assert.equal(nextRun({ kind: "files", path: "/x" }, now, now), null);
  assert.equal(nextRun({ kind: "login" }, now, now), null);
});
