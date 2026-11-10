// The sandbox of the standalone nexus-agent (core/src/agent-platform.ts). On macOS the profile is ENFORCED for real
// here: a shell started inside it tries what a hostile agent would try, against a fake home full of secrets and
// against this computer's real home, and every attempt has to fail while ordinary work keeps working. The Linux
// command lines are checked as text everywhere and run for real on NEXUS OS (bubblewrap).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { macProfile, macPlatform, linuxPlatform, toolDirs, sandboxPath, detectPlatform } from "../src/agent-platform.ts";
import type { AgentSandboxSpec } from "../src/agentd.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-plat-")));
const mac = process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");

/** A home with secrets, tools and a project, as a developer's would be. */
function fakeHome() {
  const home = tmp();
  const w = (p: string, text = "x\n") => { fs.mkdirSync(path.dirname(path.join(home, p)), { recursive: true }); fs.writeFileSync(path.join(home, p), text); };
  w(".ssh/id_ed25519", "PRIVATE KEY\n"); w(".npmrc", "//registry.npmjs.org/:_authToken=secreto\n"); w(".aws/credentials", "aws\n");
  w("Documents/diario.txt", "privado\n"); w(".zshrc", "# shell\n"); w(".cargo/credentials.toml", "token\n");
  w(".gitconfig", "[user]\n\tname = Ana\n"); w(".local/bin/mytool", "#!/bin/sh\necho mytool-ok\n"); fs.chmodSync(path.join(home, ".local/bin/mytool"), 0o755);
  w(".cargo/bin/cargo", "#!/bin/sh\necho cargo\n"); w(".nvm/versions/node/v1/bin/node", "");
  w("proyectos/web/index.js", "console.log('hola')\n"); w("proyectos/otro/secreto.txt", "de otro proyecto\n");
  const agentHome = path.join(home, ".nexus-agent/agents/web/home"); fs.mkdirSync(agentHome, { recursive: true });
  const spec: AgentSandboxSpec = { home, agentHome, folder: path.join(home, "proyectos/web"), read: [path.join(home, "proyectos/web")], write: [path.join(home, "proyectos/web")], runtimeDirs: [], interactive: false };
  return { home, agentHome, spec, opts: { home, commandHome: path.join(home, ".nexus-agent/cmd-home"), env: { PATH: `${home}/.local/bin:${home}/bin-privado:/usr/bin:/bin`, LANG: "en_US.UTF-8" } } };
}

test("tool folders: programs inside the home are found, folders that keep credentials are not", () => {
  const { home } = fakeHome();
  const t = toolDirs(home, ["/usr/bin", "/no/such/dir"]).map((p) => p.replace(home, "~"));
  assert.deepEqual(t, ["~/.gitconfig", "~/.local/bin", "~/.nvm/versions", "~/.cargo/bin", "/usr/bin"]);
  assert.ok(!t.some((p) => /\.ssh|\.npmrc|\.aws|credentials|^~\/\.cargo$/.test(p)));
  // PATH: what is in the home and is not a tool folder disappears; the system's stays
  assert.equal(sandboxPath(home, toolDirs(home), `${home}/.local/bin:${home}/bin-privado:/usr/bin:relativo::/bin`), `${home}/.local/bin:/usr/bin:/bin:/usr/local/bin`);
});

test("macOS profile: default-deny for writes, homes hidden, services by name, keys only on request", () => {
  const { home, agentHome, spec } = fakeHome();
  const p = macProfile({ home, agentHome, folder: spec.folder, read: [], write: [], tools: toolDirs(home) });
  assert.match(p, /^\(version 1\)\n\(allow default\)\n/);
  assert.ok(p.indexOf("(deny file-write*)") < p.indexOf("(allow file-write*"));
  assert.ok(p.includes(`(deny file-read* (subpath ${JSON.stringify(home)}) (subpath "/Users") (subpath "/Volumes")`));
  assert.ok(p.includes(`(subpath ${JSON.stringify(spec.folder)})`) && p.includes(`(subpath ${JSON.stringify(agentHome)})`));
  assert.ok(p.includes("(deny mach-lookup)") && p.includes("(deny appleevent-send)") && p.includes("(deny signal)"));
  for (const hidden of ["pasteboard", "SecurityServer", "launchservicesd", "windowserver", ".ssh", ".npmrc"]) assert.ok(!p.includes(hidden), hidden);
  // the folders above the project can be walked through (their names are known anyway), never listed
  assert.ok(p.includes(`(allow file-read-metadata`) && p.includes(`(literal ${JSON.stringify(path.join(home, "proyectos"))})`));
  assert.ok(!new RegExp(`\\(allow file-read\\* [^\\n]*\\((subpath|literal) ${JSON.stringify(home).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`).test(p));
  const k = macProfile({ home, agentHome, folder: spec.folder, read: [], write: [], tools: [], keys: true });
  assert.ok(k.includes(JSON.stringify(path.join(home, ".ssh"))) && k.includes("com.apple.SecurityServer"));
});

test("Linux: the tool folders come back read-only over the hidden home; keys only for an approved command", () => {
  const { home, spec, opts } = fakeHome();
  const lx = linuxPlatform(opts);
  const a = lx.agent(spec);
  assert.equal(a.home, home);
  const at = (flag: string, p: string) => a.argv.findIndex((x, i) => x === flag && a.argv[i + 1] === p);
  assert.ok(at("--bind", spec.agentHome) > 0 && a.argv[at("--bind", spec.agentHome) + 2] === home, "the agent's home stands where the real one was");
  for (const t of [".local/bin", ".nvm/versions", ".cargo/bin"]) assert.ok(at("--ro-bind", path.join(home, t)) > at("--bind", spec.agentHome), t);
  assert.equal(a.argv.filter((x, i) => x === path.join(home, ".local/bin") && a.argv[i - 1] === "--ro-bind").length, 1, "bound once");
  assert.ok(!a.argv.some((x) => /\.ssh|\.npmrc|\.aws|credentials/.test(x)));
  assert.equal(a.argv.at(-1), "--");
  const safe = lx.command("npm test", path.join(spec.folder, "src"), spec.folder, false);
  assert.ok(!safe.some((x) => /\.ssh|\.npmrc/.test(x)));
  assert.equal(safe[safe.indexOf("--chdir") + 1], path.join(spec.folder, "src"));
  assert.ok(safe.includes(path.join(home, ".nvm/versions")));
  const approved = lx.command("git push", spec.folder, spec.folder, true);
  assert.equal(approved[approved.indexOf(path.join(home, ".ssh")) - 1], "--ro-bind");
  assert.equal(lx.env!().PATH, `${home}/.local/bin:/usr/bin:/bin:/usr/local/bin`);
  assert.equal(detectPlatform(opts, "win32"), null);
});

// ---- macOS, for real
function inSandbox(argv: string[], script: string, env: NodeJS.ProcessEnv, cwd: string) {
  const r = spawnSync(argv[0], [...argv.slice(1), "/bin/sh", "-c", script], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

test("macOS, enforced: the agent works in its project and its own home", { skip: !mac }, () => {
  const { spec, opts } = fakeHome();
  const node = path.dirname(path.dirname(process.execPath));
  const p = macPlatform({ ...opts, extraTools: [node] });
  const a = p.agent(spec);
  const env = { ...p.env!(), HOME: a.home, TMPDIR: path.join(a.home, "tmp"), PATH: `${node}/bin:${p.env!().PATH}` };
  const r = inSandbox(a.argv, `
    echo cambio >> index.js && cat index.js | tail -1
    mkdir -p src && echo nuevo > src/a.txt && ls src
    echo nota > "$HOME/nota.txt" && cat "$HOME/nota.txt"
    echo t > "$TMPDIR/t" && echo tmp-ok
    mytool
    node -e 'console.log("node", 1 + 1)'
    git --version >/dev/null 2>&1 && echo git-ok
    pwd`, env, spec.folder);
  assert.equal(r.code, 0, r.out);
  for (const want of ["cambio", "a.txt", "nota", "tmp-ok", "mytool-ok", "node 2", "git-ok", spec.folder]) assert.ok(r.out.includes(want), `${want} missing in:\n${r.out}`);
});

test("macOS, enforced: keys, the rest of the home, other disks, other apps and other processes are out of reach", { skip: !mac }, () => {
  const { home, spec, opts } = fakeHome();
  const p = macPlatform(opts);
  const a = p.agent(spec);
  const env = { ...p.env!(), HOME: a.home, REAL: os.homedir(), FAKE: home };
  const outside = path.join(os.tmpdir(), `nexus-escape-${process.pid}`);
  // each line prints LEAK only if the attempt worked
  const r = inSandbox(a.argv, `
    cat "$FAKE/.ssh/id_ed25519" 2>/dev/null && echo LEAK-ssh
    cat "$FAKE/.npmrc" 2>/dev/null && echo LEAK-npmrc
    cat "$FAKE/.aws/credentials" 2>/dev/null && echo LEAK-aws
    cat "$FAKE/.cargo/credentials.toml" 2>/dev/null && echo LEAK-cargo
    cat "$FAKE/Documents/diario.txt" 2>/dev/null && echo LEAK-documents
    cat "$FAKE/proyectos/otro/secreto.txt" 2>/dev/null && echo LEAK-other-project
    ls "$FAKE" 2>/dev/null && echo LEAK-list-home
    ls "$FAKE/proyectos" 2>/dev/null && echo LEAK-list-projects
    ls "$REAL" 2>/dev/null && echo LEAK-real-home
    ls "$REAL/.ssh" 2>/dev/null && echo LEAK-real-ssh
    ls /Volumes/* 2>/dev/null | head -1 | grep -q . && echo LEAK-volumes
    ls /private/tmp 2>/dev/null && echo LEAK-tmp
    echo x >> "$FAKE/.zshrc" 2>/dev/null && echo LEAK-write-zshrc
    echo x > "$FAKE/proyectos/otro/pwned" 2>/dev/null && echo LEAK-write-other-project
    echo x > "${outside}" 2>/dev/null && echo LEAK-write-tmp
    echo x > /usr/local/nexus-pwned 2>/dev/null && echo LEAK-write-system
    /usr/bin/osascript -e 'tell application "System Events" to get name of first process' >/dev/null 2>&1 && echo LEAK-appleevents
    /usr/bin/security list-keychains 2>/dev/null | grep -q keychain && echo LEAK-keychain
    kill -0 1 2>/dev/null && echo LEAK-signal
    kill -0 ${process.pid} 2>/dev/null && echo LEAK-signal-parent
    /bin/launchctl list 2>/dev/null | grep -q com.apple && echo LEAK-launchd
    echo fin`, env, spec.folder);
  assert.ok(r.out.includes("fin"), r.out);
  assert.deepEqual(r.out.match(/LEAK-[a-z-]+/g) ?? [], [], r.out);
  assert.ok(!fs.existsSync(outside) && !fs.existsSync(path.join(home, "proyectos/otro/pwned")));
  assert.equal(fs.readFileSync(path.join(home, ".zshrc"), "utf8"), "# shell\n");
});

test("macOS, enforced: a command NEXUS runs sees the SSH keys only when the person approved it", { skip: !mac }, () => {
  const { home, spec, opts } = fakeHome();
  const p = macPlatform(opts);
  const run = (cmd: string, keys: boolean) => { const v = p.command(cmd, spec.folder, spec.folder, keys); const r = spawnSync(v[0], v.slice(1), { env: p.env!(), encoding: "utf8", timeout: 30_000 }); return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }; };
  const key = path.join(home, ".ssh/id_ed25519");
  const safe = run(`cat '${key}'; cat '${home}/.npmrc'; echo hecho > salida.txt; pwd`, false);
  assert.ok(!safe.out.includes("PRIVATE KEY") && !safe.out.includes("secreto"), safe.out);
  assert.ok(safe.out.includes(spec.folder));
  assert.equal(fs.readFileSync(path.join(spec.folder, "salida.txt"), "utf8"), "hecho\n");
  const approved = run(`cat '${key}'; echo x >> '${key}' 2>/dev/null || echo solo-lectura; cat '${home}/Documents/diario.txt' 2>/dev/null || echo sin-documentos`, true);
  assert.ok(approved.out.includes("PRIVATE KEY"), approved.out);
  assert.ok(approved.out.includes("solo-lectura") && approved.out.includes("sin-documentos"), approved.out);
  assert.equal(fs.readFileSync(key, "utf8"), "PRIVATE KEY\n");
});
