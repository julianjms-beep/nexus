// NEXUS Guard (core/src/guard.ts, guardd.ts): the security checkup, the parsers, the root operations against a fake
// system folder and fake tools, and the unix-socket protocol. What matters most: nothing that weakens the computer
// happens without the account's password, wrong passwords get locked out, and a password never reaches a command line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {
  checkup, passwordProblem, people, shadowHash, sudoersNoPassword, greetdAutologin, exposedListeners, createGuard, GuardError,
  SUDO_GUARD_FILE, type RootFacts, type UserFacts,
} from "../src/guard.ts";
import { serveGuard } from "../src/guardd.ts";
import type { RunResult } from "../src/devices.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-guard-")));
const SAFE_ROOT: RootFacts = { firewall: "on", remote: false, sudoNoPassword: false, loginPassword: true, defaultPassword: false, hardened: true };
const SAFE_USER: UserFacts = { lockAfter: 5, idleAvailable: true, update: { available: false, autoDownload: true, debianPending: 0 }, sandbox: true, exposed: [] };
const DEV_ROOT: RootFacts = { firewall: "missing", remote: true, sudoNoPassword: true, loginPassword: false, defaultPassword: true, hardened: false };

test("checkup: a computer with everything in place scores 100 and has nothing to fix", () => {
  const c = checkup(SAFE_ROOT, SAFE_USER);
  assert.equal(c.score, 100); assert.equal(c.grade, "protegido"); assert.equal(c.headline, "Tu equipo está protegido");
  assert.ok(c.items.every((i) => i.level === "ok" && !i.fix));
  assert.deepEqual(c.items.map((i) => i.id), ["firewall", "password", "remote", "sudo", "login", "kernel", "lock", "sandbox", "updates"]);
});

test("checkup: the dev image as it shipped is at risk, and every problem the person can fix carries its action", () => {
  const c = checkup(DEV_ROOT, { ...SAFE_USER, lockAfter: 0, idleAvailable: false });
  assert.equal(c.grade, "riesgo"); assert.ok(c.score <= 10);
  const fix = Object.fromEntries(c.items.filter((i) => i.fix).map((i) => [i.id, i.fix!.action]));
  assert.deepEqual(fix, { password: "password", remote: "remote-off", sudo: "sudo-ask", login: "login-ask" });
  assert.match(c.headline, /necesita atención: 7 avisos/);
});

test("checkup: one warning keeps the computer 'protegido' only while the score stays high; a bad item never does", () => {
  assert.equal(checkup({ ...SAFE_ROOT, remote: true }, SAFE_USER).grade, "protegido");
  assert.equal(checkup({ ...SAFE_ROOT, remote: true }, SAFE_USER).score, 90);
  assert.equal(checkup({ ...SAFE_ROOT, remote: true, sudoNoPassword: true }, SAFE_USER).grade, "mejorable");
  assert.equal(checkup({ ...SAFE_ROOT, defaultPassword: true }, SAFE_USER).grade, "mejorable");
  assert.equal(checkup({ ...SAFE_ROOT, defaultPassword: true, firewall: "off" }, SAFE_USER).grade, "riesgo");
  assert.equal(checkup(SAFE_ROOT, { ...SAFE_USER, lockAfter: 0 }).items.find((i) => i.id === "lock")!.fix!.action, "lock-5");
});

test("checkup: without the guard nothing root-only is claimed; listening programs count only without firewall", () => {
  const c = checkup(null, SAFE_USER);
  assert.equal(c.guard, false); assert.equal(c.items[0].id, "guard"); assert.equal(c.items[0].level, "bad");
  assert.ok(!c.items.some((i) => i.id === "firewall" || i.id === "password"));
  const exposed = [{ port: 5173, name: "Vite" }];
  assert.equal(checkup(SAFE_ROOT, { ...SAFE_USER, exposed }).score, 100);
  assert.equal(checkup(SAFE_ROOT, { ...SAFE_USER, exposed }).items.at(-1)!.level, "info");
  const open = checkup({ ...SAFE_ROOT, firewall: "off" }, { ...SAFE_USER, exposed });
  assert.equal(open.items.at(-1)!.level, "warn"); assert.equal(open.score, 70); assert.match(open.items.at(-1)!.detail, /Vite \(5173\)/);
  assert.equal(checkup(SAFE_ROOT, { ...SAFE_USER, update: { available: true, autoDownload: true, debianPending: 0 } }).score, 95);
  assert.equal(checkup(SAFE_ROOT, { ...SAFE_USER, update: null }).score, 100);
  // SSH's own port is not listed again while remote access is on (it has its own line); with it off, it is
  const ssh = [{ port: 22, name: "Acceso remoto (SSH)" }];
  assert.ok(!checkup({ ...SAFE_ROOT, remote: true }, { ...SAFE_USER, exposed: ssh }).items.some((i) => i.id === "exposed"));
  assert.ok(checkup(SAFE_ROOT, { ...SAFE_USER, exposed: ssh }).items.some((i) => i.id === "exposed"));
});

test("a new password must be long enough and not a guess", () => {
  assert.match(passwordProblem("corta", "carlos"), /8 caracteres/);
  assert.match(passwordProblem(12345678, "carlos"), /8 caracteres/);
  for (const p of ["12345678", "aaaaaaaaaa", "password", "nexus123", "Qwertyui", "carlitos\nx"]) assert.notEqual(passwordProblem(p, "carlos"), "", p);
  assert.notEqual(passwordProblem("anagarcia1", "anagarcia1"), "");
  assert.notEqual(passwordProblem("x".repeat(129), "carlos"), "");
  assert.equal(passwordProblem("tres tristes tigres", "carlos"), "");
  assert.equal(passwordProblem("mi-nexus-es-el-mejor", "carlos"), "");
});

const PASSWD = "root:x:0:0:root:/root:/bin/bash\nnexus-engine:x:999:990::/var/lib/nexus:/usr/sbin/nologin\ncarlos:x:1000:1000:Carlos,,,:/home/carlos:/bin/bash\nana:x:1001:1001:Ana:/home/ana:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n";
const GROUP = "root:x:0:\nsudo:x:27:carlos\nnexus-update:x:989:carlos,ana\n";
const SHADOW = "root:!:20000:0:99999:7:::\ncarlos:$y$fake$carlos:20000:0:99999:7:::\nana:$y$fake$ana:20000:0:99999:7:::\n";

test("people, hashes, sudoers and greetd's config are read as they are written on Debian", () => {
  assert.deepEqual(people(PASSWD, GROUP), [{ name: "carlos", uid: 1000, admin: true }, { name: "ana", uid: 1001, admin: false }]);
  assert.equal(shadowHash(SHADOW, "carlos"), "$y$fake$carlos");
  assert.equal(shadowHash(SHADOW, "root"), ""); assert.equal(shadowHash(SHADOW, "nadie"), "");
  assert.equal(sudoersNoPassword(["# nexus ALL=(ALL) NOPASSWD: ALL\nDefaults env_reset\n%sudo ALL=(ALL:ALL) ALL\n"]), false);
  assert.equal(sudoersNoPassword(["%sudo ALL=(ALL:ALL) ALL\n", "nexus ALL=(ALL) NOPASSWD: ALL\n"]), true);
  assert.deepEqual(greetdAutologin('[terminal]\nvt = 1\n[default_session]\ncommand = "x"\n'), { auto: false, gated: false });
  assert.deepEqual(greetdAutologin('[initial_session]\ncommand = "/usr/bin/nexus-session"\nuser = "nexus"\n'), { auto: true, gated: false });
  assert.deepEqual(greetdAutologin('#[initial_session]\n[initial_session]\ncommand = "/usr/bin/nexus-session --initial" # gate\n'), { auto: true, gated: true });
});

test("listening sockets: only the ones other computers could reach are reported", () => {
  const head = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const row = (addr: string, port: number, st = "0A") => `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0\n`;
  const tcp = head + row("0100007F", 7777) + row("3500007F", 53) + row("00000000", 22) + row("0804A8C0", 5173) + row("00000000", 9000, "01");
  const tcp6 = head + row("00000000000000000000000001000000", 7779) + row("00000000000000000000000000000000", 22) + row("00000000000000000000000000000000", 5355);
  assert.deepEqual(exposedListeners([tcp, tcp6], new Map([[5173, "Vite"]])), [
    { port: 22, name: "Acceso remoto (SSH)" }, { port: 5173, name: "Vite" }, { port: 5355, name: "Nombres de red (LLMNR)" },
  ]);
  assert.deepEqual(exposedListeners([""]), []);
});

// ---- the root half against a fake system
function fakeSystem(opts: { greetd?: string; nopasswd?: boolean; nft?: "on" | "off" | "missing" } = {}) {
  const root = tmp(), stateDir = path.join(root, "var/lib/nexus-guard");
  const w = (p: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), text); };
  w("etc/passwd", PASSWD); w("etc/group", GROUP); w("etc/shadow", SHADOW);
  w("etc/greetd/config.toml", opts.greetd ?? '[initial_session]\ncommand = "/usr/bin/nexus-session --initial"\nuser = "carlos"\n');
  w("etc/sudoers", "Defaults env_reset\n%sudo ALL=(ALL:ALL) ALL\n");
  if (opts.nopasswd !== false) w("etc/sudoers.d/nexus-dev", "nexus ALL=(ALL) NOPASSWD: ALL\n");
  for (const [k, v] of [["kernel/kptr_restrict", "2"], ["kernel/dmesg_restrict", "1"], ["kernel/yama/ptrace_scope", "1"], ["kernel/unprivileged_bpf_disabled", "1"]]) w(`proc/sys/${k}`, v + "\n");
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const passwords: Record<string, string> = { "$y$fake$carlos": "nexus", "$y$fake$ana": "la clave de ana" };
  let clock = 1_000_000;
  const ok: RunResult = { code: 0, out: "", err: "" };
  const guard = createGuard({
    root, stateDir, now: () => clock,
    run: async (cmd, args, o) => {
      calls.push({ cmd, args, input: o?.input });
      if (cmd === "perl") { const [h, p] = (o?.input ?? "").split("\n"); return { ...ok, out: passwords[h] === p ? "ok" : "no" }; }
      if (cmd === "nft") return opts.nft === "missing" ? { code: 127, out: "", err: "", missing: true } : { ...ok, code: opts.nft === "off" ? 1 : 0 };
      if (cmd === "chpasswd") { const [u, p] = (o?.input ?? "").trim().split(":"); passwords[`$y$fake$${u}`] = p; return ok; }
      if (cmd === "systemctl" && args[0] === "enable" && args.includes("ssh.service")) w("etc/systemd/system/multi-user.target.wants/ssh.service", "");
      if (cmd === "systemctl" && args[0] === "disable" && args.includes("ssh.service")) fs.rmSync(path.join(root, "etc/systemd/system/multi-user.target.wants/ssh.service"), { force: true });
      return ok;
    },
  });
  return { root, stateDir, guard, calls, tick: (ms: number) => { clock += ms; } };
}
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof GuardError && e.code === code && (!re || re.test(e.message)));

test("guard: the facts of a dev image, read from its files", async () => {
  const s = fakeSystem();
  assert.deepEqual(await s.guard.facts(), { firewall: "on", remote: false, sudoNoPassword: true, loginPassword: false, defaultPassword: true, hardened: true });
  assert.equal((await fakeSystem({ nft: "missing" }).guard.facts()).firewall, "missing");
  assert.equal((await fakeSystem({ nft: "off", nopasswd: false, greetd: "[default_session]\n" }).guard.facts()).firewall, "off");
  const rel = await fakeSystem({ nopasswd: false, greetd: '[default_session]\ncommand = "g"\n' }).guard.facts();
  assert.equal(rel.sudoNoPassword, false); assert.equal(rel.loginPassword, true);
});

test("guard: making the computer safer needs no password; undoing it does, and only an administrator's", async () => {
  const s = fakeSystem();
  // remote access: off is free and reloads the firewall; on asks for the password
  fs.mkdirSync(path.join(s.root, "etc/systemd/system/multi-user.target.wants"), { recursive: true });
  fs.writeFileSync(path.join(s.root, "etc/systemd/system/multi-user.target.wants/ssh.service"), "");
  assert.equal((await s.guard.facts()).remote, true);
  assert.equal((await s.guard.remote({ on: false })).remote, false);
  assert.ok(s.calls.some((c) => c.cmd === "systemctl" && c.args.join(" ") === "restart nexus-firewall.service"));
  await rejects(s.guard.remote({ on: true }), "auth");
  await rejects(s.guard.remote({ on: true, user: "carlos", password: "mala" }), "auth", /no es correcta/);
  await rejects(s.guard.remote({ on: true, user: "ana", password: "la clave de ana" }), "auth");   // right password, not an administrator
  await rejects(s.guard.remote({ on: true, user: "root", password: "x" }), "auth");
  assert.equal((await s.guard.remote({ on: true, user: "carlos", password: "nexus" })).remote, true);

  // sudo: asking for the password is one rule that sorts last, checked with visudo first
  assert.equal((await s.guard.sudo({ ask: true })).sudoNoPassword, false);
  const rule = path.join(s.root, "etc/sudoers.d", SUDO_GUARD_FILE);
  assert.match(fs.readFileSync(rule, "utf8"), /^%sudo ALL=\(ALL:ALL\) PASSWD: ALL$/m);
  assert.equal(fs.statSync(rule).mode & 0o777, 0o440);
  assert.ok(s.calls.some((c) => c.cmd === "visudo" && c.args[0] === "-cf"));
  await rejects(s.guard.sudo({ ask: false, user: "carlos", password: "no" }), "auth");
  assert.ok(fs.existsSync(rule));
  assert.equal((await s.guard.sudo({ ask: false, user: "carlos", password: "nexus" })).sudoNoPassword, true);

  // the password at power-on is a flag nexus-session looks at
  assert.equal((await s.guard.login({ ask: true })).loginPassword, true);
  assert.ok(fs.existsSync(path.join(s.stateDir, "ask-password")));
  await rejects(s.guard.login({ ask: false }), "auth");
  assert.equal((await s.guard.login({ ask: false, user: "carlos", password: "nexus" })).loginPassword, false);
  // a NEXUS whose greetd still starts the desktop directly cannot do it yet, and says so
  await rejects(fakeSystem({ greetd: '[initial_session]\ncommand = "/usr/bin/nexus-session"\n' }).guard.login({ ask: true }), "failed", /próxima actualización/);
});

test("guard: changing the password checks the old one, refuses weak ones and never puts a password on a command line", async () => {
  const s = fakeSystem();
  await rejects(s.guard.password({ user: "carlos", current: "mala", next: "tres tristes tigres" }), "auth");
  await rejects(s.guard.password({ user: "carlos", current: "nexus", next: "corta" }), "bad", /8 caracteres/);
  await rejects(s.guard.password({ user: "carlos", current: "nexus", next: "nexus" }), "bad");
  const f = await s.guard.password({ user: "carlos", current: "nexus", next: "tres tristes tigres" });
  assert.equal(f.defaultPassword, false);
  const ch = s.calls.find((c) => c.cmd === "chpasswd")!;
  assert.deepEqual(ch.args, []); assert.equal(ch.input, "carlos:tres tristes tigres\n");
  for (const c of s.calls) assert.ok(!c.args.join(" ").includes("tigres") && !c.args.join(" ").includes("mala"), `${c.cmd} got a password as an argument`);
  // a person who is not an administrator changes their own too
  await s.guard.password({ user: "ana", current: "la clave de ana", next: "otra clave larga" });
  await rejects(s.guard.password({ user: "ana", current: "x\ny", next: "otra clave más" }), "auth");
});

test("guard: five wrong passwords lock the check, for longer each time, and a right one in between does not pass", async () => {
  const s = fakeSystem();
  for (let i = 0; i < 5; i++) await rejects(s.guard.sudo({ ask: false, user: "carlos", password: `mala${i}` }), "auth");
  const before = s.calls.filter((c) => c.cmd === "perl").length;
  await rejects(s.guard.sudo({ ask: false, user: "carlos", password: "nexus" }), "locked", /Espera 60 s/);
  assert.equal(s.calls.filter((c) => c.cmd === "perl").length, before);   // not even checked
  s.tick(61_000);
  for (let i = 0; i < 5; i++) await rejects(s.guard.remote({ on: true, user: "carlos", password: "otra" }), "auth");
  s.tick(61_000);
  await rejects(s.guard.remote({ on: true, user: "carlos", password: "nexus" }), "locked");   // second lock: two minutes
  s.tick(60_000);
  assert.equal((await s.guard.remote({ on: true, user: "carlos", password: "nexus" })).remote, true);
});

test("nexus-guardd: one JSON line per request, fixed operations only, errors with a code and never the password", async () => {
  const s = fakeSystem(), dir = tmp(), logs: string[] = [];
  const sockPath = path.join(dir, "g.sock");
  const srv = serveGuard({ socketPath: sockPath, guard: s.guard, log: (l) => logs.push(l) });
  await new Promise((r) => srv.server.once("listening", r));
  assert.equal(fs.statSync(sockPath).mode & 0o777, 0o660);
  const c = net.connect(sockPath); c.setEncoding("utf8");
  let buf = ""; const got: any[] = [];
  c.on("data", (d: string) => { buf += d; for (let i; (i = buf.indexOf("\n")) >= 0;) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const ask = async (cmd: unknown, arg?: unknown) => { const id = got.length + 1000; c.write(JSON.stringify({ id, cmd, arg }) + "\n"); for (;;) { const m = got.find((x) => x.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 5)); } };
  const st = await ask("status");
  assert.equal(st.ok, true); assert.equal(st.result.defaultPassword, true);
  for (const bad of ["exec", "constructor", "__proto__", 7]) { const r = await ask(bad, { cmd: "rm -rf /" }); assert.equal(r.ok, false); assert.equal(r.code, "bad"); }
  const wrong = await ask("remote", { on: true, user: "carlos", password: "secreto-malo" });
  assert.deepEqual([wrong.ok, wrong.code], [false, "auth"]);
  assert.ok(!JSON.stringify(wrong).includes("secreto-malo"));
  const arr = await ask("sudo", ["ask", false]);   // not an object: treated as no arguments → the safe direction
  assert.equal(arr.ok, true); assert.equal(arr.result.sudoNoPassword, false);
  const pw = await ask("password", { user: "carlos", current: "nexus", next: "tres tristes tigres" });
  assert.equal(pw.ok, true);
  assert.deepEqual(logs, ["sudo asks for the password", "a password was changed"]);
  assert.ok(!logs.join("\n").includes("tigres"));
  c.write("esto no es JSON\n");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(got.at(-1).ok, false);
  c.destroy(); srv.close();
});
