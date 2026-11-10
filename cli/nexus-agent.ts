#!/usr/bin/env node
// nexus-agent: run an AI coding agent (Claude Code, or any program) isolated in the current project, on any Linux
// or macOS. The agent gets the project folder, a private home and your tools — never your keys, the rest of your
// home, other disks, the clipboard or other apps. Whatever needs your keys or is critical (git push, rm -r, a
// deploy…) it has to ask NEXUS for, and NEXUS asks you. core/src/standalone.ts is the engine; this is the command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createStandalone, liveRuns, approvalText, agentEnv, type Lang } from "../core/src/standalone.ts";

const VERSION = "0.1.0";
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
// from source (a .ts file) the bridge needs the engine's sources too; the published bundle is one file
const SOURCES = /\.ts$/.test(SELF) ? [path.join(path.dirname(path.dirname(SELF)), "core", "src")] : [];
const tty = process.stderr.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("38;5;245", s), bold = (s: string) => c("1", s), acc = (s: string) => c("38;5;141", s), red = (s: string) => c("38;5;203", s), green = (s: string) => c("38;5;78", s);
const lang: Lang = /^es/i.test(process.env.NEXUS_LANG ?? process.env.LANG ?? "") ? "es" : "en";
const L = (en: string, es: string) => (lang === "es" ? es : en);
const fail = (msg: string, code = 2): never => { process.stderr.write(`nexus-agent: ${msg}\n`); process.exit(code); };

const HELP = () => L(`nexus-agent ${VERSION} — run an AI coding agent isolated in this project

  nexus-agent -- claude                 Claude Code, isolated in the current folder, with NEXUS connected (MCP)
  nexus-agent --goal "fix the tax test" -- claude
  nexus-agent                           a shell inside the sandbox, to see what the agent sees
  nexus-agent doctor                    check this computer and watch the sandbox block real attempts
  nexus-agent approvals                 answer the agent's requests from another terminal (no desktop needed)

Options (before --):
  --folder DIR     the project (default: the current folder; it must be inside your home)
  --read DIR       another folder the agent may read (repeatable)
  --goal TEXT      what this run is for (shown in the log)
  --allow-host H   let the agent reach one more site (repeatable; ".example.com" = it and everything under it)
  --open-network   do not filter the agent's network
  --max-usd N      spending cap for this agent, in US$ (needs ANTHROPIC_API_KEY; default 5)
  --check CMD      the project's check, run after the agent's changes (default: detected)

Inside, the agent has the project (read and write), a private home and your tools. It does NOT have your SSH keys,
tokens, the rest of your home, other disks, the clipboard, the Keychain or other apps. What needs your keys or is
critical (git push, rm -r, DROP TABLE, a deploy…) it asks NEXUS for, and NEXUS asks you. Your API key stays outside.
`, `nexus-agent ${VERSION} — ejecuta un agente de IA aislado en este proyecto

  nexus-agent -- claude                 Claude Code, aislado en la carpeta actual, con NEXUS conectado (MCP)
  nexus-agent --goal "arregla el test del IVA" -- claude
  nexus-agent                           una terminal dentro del aislamiento, para ver lo que ve el agente
  nexus-agent doctor                    revisa este equipo y enseña al aislamiento parando intentos reales
  nexus-agent approvals                 responde a lo que pide el agente desde otra terminal (sin escritorio)

Opciones (antes de --):
  --folder DIR     el proyecto (por defecto, la carpeta actual; tiene que estar dentro de tu carpeta personal)
  --read DIR       otra carpeta que el agente puede leer (se puede repetir)
  --goal TEXTO     para qué es esta ejecución (sale en el registro)
  --allow-host H   deja al agente llegar a un sitio más (se puede repetir; «.ejemplo.com» = ese y todo lo que cuelga)
  --open-network   no filtra la red del agente
  --max-usd N      límite de gasto del agente, en US$ (necesita ANTHROPIC_API_KEY; por defecto 5)
  --check CMD      la comprobación del proyecto, tras cada cambio del agente (por defecto, la que se detecte)

Dentro, el agente tiene el proyecto (leer y escribir), una carpeta personal propia y tus herramientas. NO tiene tus
llaves SSH, tus tokens, el resto de tu carpeta personal, otros discos, el portapapeles, el llavero ni otras apps.
Lo que necesite tus llaves o sea crítico (git push, rm -r, DROP TABLE, desplegar…) se lo pide a NEXUS, y NEXUS te
pregunta a ti. Tu clave de la API se queda fuera.
`);

// ---------------------------------------------------------------- the MCP bridge (stdio ↔ this run's server)
async function mcpBridge(): Promise<number> {
  const url = process.env.NEXUS_MCP_URL, token = process.env.NEXUS_AGENT_TOKEN;
  if (!url || !token) fail(L("the MCP bridge only runs inside an agent started with nexus-agent", "el puente MCP solo funciona dentro de un agente arrancado con nexus-agent"));
  const emit = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
  const pending = new Set<Promise<void>>();
  const handle = async (line: string) => {
    let id: unknown = null;
    try { id = JSON.parse(line)?.id ?? null; } catch { emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    try {
      // long: a call may wait 5 minutes for the person's answer, and a command may run 5 more
      const r = await fetch(url!, { method: "POST", body: line, signal: AbortSignal.timeout(720_000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" } });
      if (r.status === 202) return;
      if (r.status === 401) { if (id !== null) emit({ jsonrpc: "2.0", id, error: { code: -32001, message: "NEXUS has halted this agent, or its run has ended." } }); return; }
      const text = await r.text();
      if (text) emit(JSON.parse(text));
    } catch { if (id !== null) emit({ jsonrpc: "2.0", id, error: { code: -32603, message: "Cannot reach NEXUS." } }); }
  };
  const rl = readline.createInterface({ input: process.stdin });
  for await (const raw of rl) {
    const line = raw.trim(); if (!line) continue;
    const p = handle(line).finally(() => pending.delete(p)); pending.add(p);
  }
  await Promise.all(pending);   // the client closed stdin: the answers already on their way are still delivered
  return 0;
}

// ---------------------------------------------------------------- approvals from another terminal
async function approvals(): Promise<number> {
  const stateDir = path.join(os.homedir(), ".nexus-agent");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));
  const seen = new Set<string>();
  process.stderr.write(dim(L("Waiting for requests from your agents (Ctrl+C to leave)…\n", "Esperando peticiones de tus agentes (Ctrl+C para salir)…\n")));
  for (;;) {
    for (const run of liveRuns(stateDir)) {
      const base = `http://127.0.0.1:${run.port}`, headers = { authorization: `Bearer ${run.admin}`, "content-type": "application/json" };
      let list: any[] = [];
      try { list = (await (await fetch(`${base}/admin/approvals`, { headers, signal: AbortSignal.timeout(4000) })).json()).approvals ?? []; } catch { continue; }
      for (const ap of list) {
        if (seen.has(ap.id)) continue; seen.add(ap.id);
        process.stderr.write(`\n${acc("◆")} ${approvalText(ap, lang)}\n`);
        const a = (await ask(bold(L("Approve? [y/N] ", "¿Aprobar? [s/N] ")))).trim().toLowerCase();
        const yes = a === "y" || a === "yes" || a === "s" || a === "si" || a === "sí";
        try {
          const r = await fetch(`${base}/admin/decide`, { method: "POST", headers, body: JSON.stringify({ id: ap.id, approve: yes }) });
          process.stderr.write(r.ok ? (yes ? green(L("approved\n", "aprobado\n")) : red(L("denied\n", "rechazado\n"))) : dim(L("already answered\n", "ya estaba respondido\n")));
        } catch { process.stderr.write(dim(L("that run has ended\n", "esa ejecución ya ha terminado\n"))); }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------- doctor: the sandbox, shown at work
async function doctor(): Promise<number> {
  const home = os.homedir();
  const work = fs.mkdtempSync(path.join(home, ".nexus-agent-doctor-"));
  const project = path.join(work, "project"); fs.mkdirSync(project);
  let code = 0;
  try {
    const sa = await createStandalone({ cliPath: SELF, extraTools: SOURCES, stateDir: path.join(work, "state"), lang, approver: async () => false, watch: false });
    try {
      const say = (ok: boolean, text: string) => { process.stderr.write(`  ${ok ? green("✔") : red("✖")} ${text}\n`); if (!ok) code = 1; };
      process.stderr.write(`${acc("◆")} ${bold("nexus-agent doctor")} ${dim(`· ${process.platform} · node ${process.version}`)}\n`);
      const available = sa.platform.available();
      say(available, process.platform === "darwin" ? L("macOS sandbox (sandbox-exec) available", "aislamiento de macOS (sandbox-exec) disponible")
        : L("bubblewrap installed and allowed for your user", "bubblewrap instalado y permitido para tu usuario"));
      if (!available) {
        if (process.platform === "linux") process.stderr.write(dim(L("    install it (apt install bubblewrap / dnf install bubblewrap). On Ubuntu 24.04+ unprivileged user namespaces must be allowed.\n",
          "    instálalo (apt install bubblewrap / dnf install bubblewrap). En Ubuntu 24.04+ hay que permitir los espacios de nombres de usuario sin privilegios.\n")));
        return 1;
      }
      const a = sa.ensureAgent(project);
      const r = sa.agents.startRun(a.id, { program: "doctor", interactive: false });
      const env = agentEnv(sa.home, sa.platform.tools, r.home, r.env, sa.net?.env);
      // (not spawnSync: the network filter lives in this very process and has to keep answering while a probe runs)
      const probe = (script: string) => new Promise<{ status: number | null }>((res) => {
        const c2 = spawn(r.argv[0], [...r.argv.slice(1), "/bin/sh", "-c", script], { cwd: project, env: { ...env, REAL: home }, stdio: "ignore" });
        const t = setTimeout(() => c2.kill("SIGKILL"), 30_000);
        c2.on("error", () => { clearTimeout(t); res({ status: 127 }); });
        c2.on("close", (code) => { clearTimeout(t); res({ status: code }); });
      });
      const works = await probe(`echo ok > a.txt && cat a.txt && echo ok > "$HOME/b.txt"`);
      say(works.status === 0, L("the agent can work in its project and in its own home", "el agente puede trabajar en su proyecto y en su propia carpeta personal"));
      // What counts is what really happened to YOUR home, looked at from outside: on Linux the agent sees a private
      // home at the same path, so "it could write there" says nothing by itself.
      const marker = `.nexus-agent-doctor-seen-${process.pid}`, pwned = path.join(home, ".nexus-agent-doctor-pwned");
      fs.writeFileSync(path.join(home, marker), "");   // a file of yours the agent must not even see the name of
      const rc = [".zshrc", ".bashrc", ".profile"].map((f) => path.join(home, f)).filter((f) => fs.existsSync(f));
      const before = rc.map((f) => fs.statSync(f).size);
      const blocked = async (script: string) => (await probe(script)).status !== 0;
      say(await blocked(`ls -a "$REAL" 2>/dev/null | grep -q '${marker}'`), L("blocked: list your home folder", "bloqueado: listar tu carpeta personal"));
      say(await blocked(`ls "$REAL/.ssh" >/dev/null 2>&1`) || !fs.existsSync(path.join(home, ".ssh")), L("blocked: read your SSH keys", "bloqueado: leer tus llaves SSH"));
      say(await blocked(`ls "$REAL/Documents" "$REAL/Documentos" "$REAL/Desktop" "$REAL/Escritorio" 2>/dev/null | grep -q .`), L("blocked: read your documents", "bloqueado: leer tus documentos"));
      await probe(`echo x > "$REAL/.nexus-agent-doctor-pwned"; for f in .zshrc .bashrc .profile; do echo '# pwned' >> "$REAL/$f"; done`);
      say(!fs.existsSync(pwned), L("blocked: write in your home folder", "bloqueado: escribir en tu carpeta personal"));
      say(rc.every((f, k) => fs.statSync(f).size === before[k]), L("blocked: change your shell's start-up files", "bloqueado: cambiar los archivos de arranque de tu terminal"));
      say(await blocked(`kill -0 ${process.pid} 2>/dev/null`), L("blocked: signal a process outside the sandbox", "bloqueado: mandar señales a un proceso de fuera"));
      if (process.platform === "darwin") {
        say(await blocked(`/usr/bin/osascript -e 'tell application "System Events" to get name of first process' >/dev/null 2>&1`), L("blocked: control other apps (Apple Events)", "bloqueado: controlar otras apps (Apple Events)"));
        say(await blocked(`/usr/bin/security list-keychains 2>/dev/null | grep -q keychain`), L("blocked: reach the Keychain", "bloqueado: llegar al llavero"));
        say(await blocked(`ls /Volumes/* 2>/dev/null | grep -q .`), L("blocked: read other disks", "bloqueado: leer otros discos"));
      } else {
        say(await blocked(`ls /run/user/$(id -u) 2>/dev/null | grep -q .`), L("blocked: reach your session's sockets (D-Bus, SSH agent)", "bloqueado: llegar a los sockets de tu sesión (D-Bus, agente SSH)"));
      }
      if (sa.net && sa.net.enforced) {
        // the network: straight out is closed; through the filter, only the sites on the list
        say(await blocked(`curl -s -m 6 --noproxy '*' -o /dev/null https://example.com`), L("blocked: connect straight to the internet", "bloqueado: salir directo a Internet"));
        say(await blocked(`curl -s -m 8 -o /dev/null -f https://example.com`) && sa.net.blocked.has("example.com"), L("blocked: send data to a site that is not on the list", "bloqueado: enviar datos a un sitio que no está en la lista"));
        say(!await blocked(`curl -s -m 12 -o /dev/null https://api.anthropic.com/`), L("allowed: reach the model's API through the filter", "permitido: llegar a la API del modelo por el filtro"));
      } else if (sa.net) process.stderr.write(dim(L("  network: the filter is not enforced on Linux yet (a program can go around it)\n", "  red: el filtro aún no es obligatorio en Linux (un programa puede saltárselo)\n")));
      fs.rmSync(pwned, { force: true }); fs.rmSync(path.join(home, marker), { force: true });
      const tools: string[] = [];
      for (const t of ["git", "node", "claude", "python3"]) if ((await probe(`command -v ${t} >/dev/null 2>&1`)).status === 0) tools.push(t);
      process.stderr.write(dim(L(`  tools the agent will find: ${tools.join(", ") || "none"}\n`, `  herramientas que el agente encontrará: ${tools.join(", ") || "ninguna"}\n`)));
      sa.agents.endRun(r.run, 0);
    } finally { await sa.close(); }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  process.stderr.write(code === 0 ? green(L("All good.\n", "Todo en orden.\n")) : red(L("Something is not right: do not run agents here until it is fixed.\n", "Algo no está bien: no ejecutes agentes aquí hasta arreglarlo.\n")));
  return code;
}

// ---------------------------------------------------------------- run
async function run(argv: string[]): Promise<number> {
  const cut = argv.indexOf("--");
  const opts = cut >= 0 ? argv.slice(0, cut) : argv, prog = cut >= 0 ? argv.slice(cut + 1) : [];
  let folder = process.cwd(), goal = "", maxUsd: number | undefined, check: string | undefined; const read: string[] = [];
  let network: "filtered" | "open" = "filtered"; const allowHosts: string[] = [];
  for (let i = 0; i < opts.length; i++) {
    const k = opts[i], v = opts[i + 1];
    const need = () => { if (v === undefined) fail(L(`${k} needs a value`, `${k} necesita un valor`)); i++; return v; };
    if (k === "--folder") folder = path.resolve(need());
    else if (k === "--read") read.push(path.resolve(need()));
    else if (k === "--goal") goal = need();
    else if (k === "--allow-host") allowHosts.push(need());
    else if (k === "--open-network") network = "open";
    else if (k === "--check") check = need();
    else if (k === "--max-usd") { maxUsd = Number(need()); if (!Number.isFinite(maxUsd) || maxUsd < 0) fail(L("--max-usd needs a number", "--max-usd necesita un número")); }
    else fail(L(`I do not understand «${k}». See: nexus-agent --help`, `no entiendo «${k}». Mira: nexus-agent --help`));
  }
  if (process.env.NEXUS_IN_AGENT) fail(L("you are already inside an agent's sandbox", "ya estás dentro del aislamiento de un agente"));
  const home = fs.realpathSync(os.homedir());
  let real = ""; try { real = fs.realpathSync(folder); } catch { fail(L(`the folder ${folder} does not exist`, `la carpeta ${folder} no existe`)); }
  if (real === home) fail(L("an agent cannot have your whole home folder: run this inside a project folder", "un agente no puede tener toda tu carpeta personal: ejecútalo dentro de la carpeta de un proyecto"));
  if (!real.startsWith(home + path.sep)) fail(L("the project has to be inside your home folder", "el proyecto tiene que estar dentro de tu carpeta personal"));
  if (maxUsd !== undefined && !process.env.ANTHROPIC_API_KEY) fail(L("--max-usd needs ANTHROPIC_API_KEY: only then does the agent's traffic pass through NEXUS to be counted", "--max-usd necesita ANTHROPIC_API_KEY: solo así el tráfico del agente pasa por NEXUS para contarlo"));

  const interactive = process.stdin.isTTY === true;
  const sa = await createStandalone({
    cliPath: SELF, extraTools: SOURCES, lang, apiKey: process.env.ANTHROPIC_API_KEY || undefined, network, allowHosts,
    onPending: () => { process.stderr.write("\x07"); },   // a bell: the request waits for `nexus-agent approvals`
  });
  if (!sa.platform.available()) {
    await sa.close();
    fail(L("this computer cannot isolate programs (run `nexus-agent doctor`): no agent is started without isolation", "este equipo no puede aislar programas (ejecuta `nexus-agent doctor`): no se arranca ningún agente sin aislar"));
  }
  let code = 1;
  try {
    let agent; try { agent = sa.ensureAgent(real, { read, maxUsd, check }); } catch (e) { await sa.close(); return fail((e as Error).message); }
    const program = prog.length ? prog : [process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/sh"];
    let r; try { r = sa.agents.startRun(agent.id, { program: program.join(" ").slice(0, 200), goal, interactive }); } catch (e) { await sa.close(); return fail((e as Error).message); }
    sa.publish(real);
    let argvProg = program;
    if (path.basename(program[0]) === "claude" && !program.includes("--mcp-config")) argvProg = [program[0], "--mcp-config", r.env.NEXUS_MCP_CONFIG, ...program.slice(1)];
    const env = agentEnv(sa.home, sa.platform.tools, r.home, r.env, sa.net?.env);
    const short = real.replace(home, "~");
    const netNote = !sa.net ? L("network open", "red abierta") : sa.net.enforced ? L("network: listed sites only", "red: solo los sitios de la lista") : L("network: filter not enforced on Linux yet", "red: el filtro aún no es obligatorio en Linux");
    process.stderr.write(`${acc("◆")} ${bold(`NEXUS · ${agent.name}`)} ${dim(`· ${short} · ${L("isolated", "aislado")} · ${L("your keys stay outside", "tus llaves se quedan fuera")} · ${netNote}`)}\n`);
    // A terminal or a pipe is handed over as it is. Output redirected to a FILE is relayed by this process instead:
    // the file is outside the sandbox, and a program that cannot even stat its own stdout dies at start-up (node does).
    const how = (fd: number) => { try { return fs.fstatSync(fd).isFile() ? "pipe" as const : "inherit" as const; } catch { return "pipe" as const; } };
    const child = spawn(r.argv[0], [...r.argv.slice(1), ...argvProg], { stdio: [how(0), how(1), how(2)], cwd: real, env });
    if (child.stdin) process.stdin.pipe(child.stdin);
    child.stdout?.pipe(process.stdout, { end: false }); child.stderr?.pipe(process.stderr, { end: false });
    process.on("SIGINT", () => { /* Ctrl+C belongs to the agent program, which shares this terminal */ });
    process.on("SIGTERM", () => { try { sa.agents.halt(r.run, "SIGTERM"); } catch { /* ended */ } child.kill("SIGKILL"); });
    child.on("spawn", () => { try { sa.agents.setPid(r.run, child.pid); } catch { /* ended */ } });
    let halted = "";
    const watch = setInterval(() => {
      try { const s = sa.agents.runStatus(r.run); if (s.status === "halted" && !halted) { halted = s.reason || "halted"; child.kill("SIGKILL"); } } catch { /* gone */ }
    }, 1000);
    code = await new Promise<number>((res) => {
      child.on("error", (e: NodeJS.ErrnoException) => { process.stderr.write(`nexus-agent: ${e.code === "ENOENT" ? L(`cannot start the sandbox`, `no se puede arrancar el aislamiento`) : e.message}\n`); res(127); });
      child.on("close", (c2, sig) => res(c2 ?? (sig ? 137 : 1)));
    });
    clearInterval(watch);
    try { sa.agents.endRun(r.run, code); } catch { /* halted */ }
    if (halted) { process.stderr.write(`\n${red(`◆ ${L("NEXUS halted the agent", "NEXUS ha detenido al agente")}`)}: ${halted}\n`); code = 137; }
    if (sa.net && sa.net.blocked.size) {
      const list = [...sa.net.blocked.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h, n]) => `${h} (${n})`).join(", ");
      process.stderr.write(dim(`${acc("◆")} ${L("NEXUS blocked connections to", "NEXUS ha bloqueado conexiones a")}: ${list}. ${L("To allow a site: --allow-host NAME", "Para permitir un sitio: --allow-host NOMBRE")}\n`));
    }
  } finally { await sa.close(); }
  return code;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") { process.stdout.write(HELP()); return 0; }
  if (argv[0] === "-v" || argv[0] === "--version") { process.stdout.write(VERSION + "\n"); return 0; }
  if (argv[0] === "mcp") return mcpBridge();
  if (argv[0] === "approvals") return approvals();
  if (argv[0] === "doctor") return doctor();
  return run(argv);
}
main().then((code) => process.exit(code), (e) => { process.stderr.write(`nexus-agent: ${(e as Error)?.message ?? e}\n`); process.exit(1); });
