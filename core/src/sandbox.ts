// NEXUS Sandbox: runs test suites chosen from a fixed runner list inside the platform's isolation provider.
//   macOS (development): Seatbelt + watchdog  -> iso-seatbelt.ts
//   Linux (NEXUS OS):    bubblewrap + cgroup v2 -> iso-linux.ts
// No provider, or a provider whose self-test fails => nothing runs (fail closed).
// Agents never pick the command: they pick a runner id from RUNNERS, and NEXUS owns the argv.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit.ts";
import type { Security } from "./security.ts";
import { resolveReal } from "./security.ts";
import type { IsolationProvider, Isolation, Limits, Launched } from "./isolation.ts";
import { SeatbeltProvider } from "./iso-seatbelt.ts";
import { LinuxBwrapProvider } from "./iso-linux.ts";

export { buildProfile } from "./iso-seatbelt.ts";
export type Runner = { id: string; description: string; argv: (bin: string) => string[]; binary: string; parse: (stdout: string, stderr: string) => Summary };
export type Summary = { tests?: number; failures?: number; errors?: number; failed: string[] };
export type SandboxLimits = Limits;
export type SandboxResult = {
  id: string; runner: string; workdir: string; ok: boolean; exitCode: number | null; signal: string | null;
  timedOut: boolean; cancelled: boolean; killedBy?: string; outputTruncated: boolean; durationMs: number; startedAt: string;
  summary: Summary; stdout: string; stderr: string; limits: SandboxLimits; isolation?: string;
};
export type SandboxHandle = { id: string; cancel: () => void; done: Promise<SandboxResult> };

export const DEFAULT_LIMITS: SandboxLimits = { cpuSeconds: 60, memoryMb: 512, timeoutMs: 120_000, maxProcesses: 64, maxOutputBytes: 1_000_000, maxFileMb: 32 };

const parseUnittest = (_o: string, e: string): Summary => ({
  tests: Number(e.match(/Ran (\d+) tests?/)?.[1] ?? NaN) || undefined,
  failures: Number(e.match(/failures=(\d+)/)?.[1] ?? 0), errors: Number(e.match(/errors=(\d+)/)?.[1] ?? 0),
  failed: [...e.matchAll(/^(?:FAIL|ERROR): (.+)$/gm)].map((m) => m[1]),
});
const parseNodeTest = (o: string): Summary => ({
  tests: Number(o.match(/ℹ tests (\d+)/)?.[1] ?? NaN) || undefined, failures: Number(o.match(/ℹ fail (\d+)/)?.[1] ?? 0), errors: 0,
  failed: [...o.matchAll(/^\s*✖ (.+?) \(/gm)].map((m) => m[1]),
});

export const RUNNERS: Record<string, Runner> = {
  "python-unittest": { id: "python-unittest", description: "python3 -m unittest discover (test*.py)", binary: "python3",
    argv: (bin) => [bin, "-m", "unittest", "discover", "-s", ".", "-p", "test*.py", "-v"], parse: parseUnittest },
  "node-test": { id: "node-test", description: "node --test", binary: "node",
    argv: (bin) => [bin, "--test"], parse: parseNodeTest },
};

/** Resolve a binary on PATH without spawning anything (no dependency on /usr/bin/which). */
export function which(name: string, PATH = process.env.PATH ?? "/usr/bin:/bin"): string | undefined {
  for (const dir of PATH.split(":").filter(Boolean)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return fs.realpathSync(p); } catch { /* next */ }
  }
  return undefined;
}
/** Read-only roots an interpreter needs (its installation prefix). */
export function interpreterRoots(bin: string): string[] {
  if (/^\/(usr|bin)\//.test(bin) && !bin.startsWith("/usr/local")) return []; // system binaries already readable
  const m = bin.match(/^(.*\/Python\.framework\/Versions\/[^/]+)\//); // framework python
  if (m) return [m[1]];
  return [path.dirname(path.dirname(bin)), bin].filter((p, i, a) => a.indexOf(p) === i && p !== "/");
}

export function providerFor(platform: string = process.platform): IsolationProvider | undefined {
  if (platform === "darwin") return new SeatbeltProvider();
  if (platform === "linux") return new LinuxBwrapProvider();
  return undefined;
}

type Exec = { code: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; killedBy?: string; timedOut: boolean; cancelled: boolean; durationMs: number };
const selfTestMemo = new Map<string, Promise<Isolation>>();

export class Sandbox {
  private active = new Map<string, () => void>();
  private selfTested?: Isolation;
  constructor(private dir: string, private audit: Audit, private security: Security, private limits: SandboxLimits = DEFAULT_LIMITS,
    private provider: IsolationProvider | undefined = providerFor()) {
    fs.mkdirSync(path.join(dir, "sandbox"), { recursive: true });
  }
  /** Whether this platform has an isolation provider that is currently usable (cheap; no self-test). */
  static available() { return providerFor()?.status().available ?? false; }
  /** Provider status, downgraded to unavailable if the adversarial self-test has run and failed. */
  isolation(): Isolation {
    const st = this.provider?.status() ?? { available: false, mechanism: "none", platform: process.platform, reason: `no isolation mechanism implemented for ${process.platform}` };
    return this.selfTested && !this.selfTested.available ? this.selfTested : st;
  }
  runners() { return Object.values(RUNNERS).map((r) => ({ id: r.id, description: r.description, available: !!which(r.binary) })); }
  getResult(id: string): SandboxResult | undefined { try { return JSON.parse(fs.readFileSync(path.join(this.dir, "sandbox", `${id}.json`), "utf8")); } catch { return undefined; } }
  listResults(limit = 50): SandboxResult[] {
    const d = path.join(this.dir, "sandbox");
    return fs.readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => this.getResult(f.slice(0, -5))!).filter(Boolean)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }
  cancel(id: string) { const c = this.active.get(id); if (c) c(); return !!c; }

  /** Launch argv in the provider, enforce timeout/output cap/limit violations, and clean up. Never throws. */
  private exec(id: string, argv: string[], workdir: string, readOnly: string[], limits: SandboxLimits): { cancel: () => void; done: Promise<Exec> } {
    const priv = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sbx-")));
    const env = { PATH: "/usr/bin:/bin", HOME: priv, TMPDIR: priv, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" };
    const started = Date.now();
    let L: Launched;
    try { L = this.provider!.launch({ argv, workdir, priv, readOnly, env, limits }); }
    catch (e: any) {
      fs.rmSync(priv, { recursive: true, force: true });
      return { cancel() {}, done: Promise.resolve({ code: null, signal: null, stdout: "", stderr: `isolation launch failed: ${e.message}`, truncated: false, killedBy: "isolation launch failed", timedOut: false, cancelled: false, durationMs: 0 }) };
    }
    let out = "", err = "", truncated = false, killedBy: string | undefined, cancelled = false, timedOut = false;
    const cap = (cur: string, d: Buffer) => { if (cur.length >= limits.maxOutputBytes) { truncated = true; return cur; } return (cur + d.toString()).slice(0, limits.maxOutputBytes); };
    L.child.stdout!.on("data", (d) => { out = cap(out, d); }); L.child.stderr!.on("data", (d) => { err = cap(err, d); });
    const killAll = (why: string) => { killedBy ??= why; L.kill(why); };
    const timer = setTimeout(() => { timedOut = true; killAll("timeout"); }, limits.timeoutMs);
    const watch = setInterval(() => { const v = L.violation(); if (v) killAll(v); }, 50);
    this.active.set(id, () => { cancelled = true; killAll("cancelled"); });
    const done = new Promise<Exec>((resolve) => {
      let finished = false;
      const finish = (code: number | null, signal: string | null, spawnErr?: string) => {
        if (finished) return; finished = true;
        clearTimeout(timer); clearInterval(watch); this.active.delete(id);
        const why = L.finalize(code, signal); if (why) killedBy ??= why;
        L.cleanup(); // no orphans: every process of the job is killed
        fs.rmSync(priv, { recursive: true, force: true });
        resolve({ code, signal, stdout: out, stderr: spawnErr ?? err, truncated, killedBy, timedOut, cancelled, durationMs: Date.now() - started });
      };
      L.child.on("error", (e) => finish(null, null, `spawn failed: ${e.message}`));
      L.child.on("close", (code, signal) => finish(code, signal));
    });
    return { cancel: () => this.cancel(id), done };
  }

  run(workdirIn: string, runnerId: string, over: Partial<SandboxLimits> = {}): SandboxHandle {
    const id = randomUUID(); const limits = { ...this.limits, ...over };
    const runner = RUNNERS[runnerId];
    const startedAt = new Date().toISOString();
    const fail = (why: string): SandboxHandle => {
      const r: SandboxResult = { id, runner: runnerId, workdir: workdirIn, ok: false, exitCode: null, signal: null, timedOut: false, cancelled: false, killedBy: why,
        outputTruncated: false, durationMs: 0, startedAt, summary: { failed: [] }, stdout: "", stderr: why, limits };
      this.audit.record("sandbox.denied", { id, runner: runnerId, workdir: workdirIn, why });
      return { id, cancel() {}, done: Promise.resolve(r) };
    };
    if (!runner) return fail(`unknown runner ${runnerId}`);
    const iso = this.isolation();
    if (!iso.available) return fail(`isolation unavailable (${iso.reason ?? iso.mechanism}): refusing to run unisolated`);
    const workdir = resolveReal(workdirIn);
    const d = this.security.authorize({ kind: "sandbox.run", project: workdir, runner: runnerId });
    if (!d.allowed) return fail(d.reason);
    const bin = which(runner.binary);
    if (!bin) return fail(`${runner.binary} not found`);

    this.audit.record("sandbox.started", { id, runner: runnerId, workdir, limits, isolation: iso.mechanism });
    const h = this.exec(id, runner.argv(bin), workdir, interpreterRoots(bin), limits);
    const done = h.done.then((x) => {
      const res: SandboxResult = { id, runner: runnerId, workdir, exitCode: x.code, signal: x.signal, timedOut: x.timedOut, cancelled: x.cancelled, killedBy: x.killedBy,
        outputTruncated: x.truncated, durationMs: x.durationMs, startedAt, summary: runner.parse(x.stdout, x.stderr), stdout: x.stdout, stderr: x.stderr, limits,
        isolation: iso.mechanism, ok: x.code === 0 && !x.killedBy };
      fs.writeFileSync(path.join(this.dir, "sandbox", `${id}.json`), JSON.stringify(res, null, 2));
      this.audit.record("sandbox.run", { id, runner: runnerId, workdir, ok: res.ok, exitCode: x.code, killedBy: x.killedBy, durationMs: res.durationMs, summary: res.summary });
      return res;
    });
    return { id, cancel: h.cancel, done };
  }

  /**
   * Adversarial self-test: the provider must stop reading outside, writing outside, network access, a memory hog and a
   * process bomb. Any escape marks the provider unavailable for this Sandbox (fail closed). Memoised per process.
   */
  async selfTest(): Promise<Isolation> {
    const st = this.isolation();
    if (!st.available || !this.provider) return st;
    const key = this.provider.mechanism;
    if (!selfTestMemo.has(key)) selfTestMemo.set(key, this.runSelfTest(st));
    this.selfTested = await selfTestMemo.get(key)!;
    this.audit.record("sandbox.selftest", { mechanism: key, available: this.selfTested.available, reason: this.selfTested.reason });
    return this.selfTested;
  }
  private async runSelfTest(st: Isolation): Promise<Isolation> {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-selftest-")));
    const work = path.join(base, "work"); fs.mkdirSync(work);
    const canary = path.join(base, "canary.txt"); fs.writeFileSync(canary, "SELFTEST-CANARY");
    const evil = path.join(base, "evil.txt");
    let hits = 0; const srv = net.createServer((s) => { hits++; s.destroy(); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    const node = fs.realpathSync(process.execPath);
    const probe = (code: string, over: Partial<SandboxLimits> = {}) =>
      this.exec(`selftest-${randomUUID()}`, [node, "-e", code], work, interpreterRoots(node), { ...DEFAULT_LIMITS, timeoutMs: 20_000, cpuSeconds: 15, ...over }).done;
    const J = JSON.stringify;
    // Kernel-enforced memory (cgroup) must stop even a single burst; the macOS watchdog polls every 50 ms, so it is held
    // to what it promises: a hog that grows over time.
    const kernelMemory = this.provider!.mechanism === "linux-bwrap";
    const hog = kernelMemory
      ? `console.log("RAN");const a=[];for(let i=0;i<48;i++){a.push(Buffer.alloc(16<<20,1))}console.log("ESCAPED")`
      : `console.log("RAN");const a=[];let i=0;const t=setInterval(()=>{a.push(Buffer.alloc(16<<20,1));if(++i===48){clearInterval(t);console.log("ESCAPED")}},40)`;
    try {
      // Every probe prints RAN first: a probe that never started proves nothing and counts as a failure.
      const [rd, wr, nw, mem, pids] = await Promise.all([
        probe(`console.log("RAN");try{console.log(require("fs").readFileSync(${J(canary)},"utf8"))}catch{console.log("blocked")}`),
        probe(`console.log("RAN");try{require("fs").writeFileSync(${J(evil)},"x")}catch{}`),
        probe(`console.log("RAN");const s=require("net").connect(${port},"127.0.0.1");s.on("connect",()=>{console.log("ESCAPED");process.exit(0)});s.on("error",()=>console.log("blocked"))`),
        probe(hog, { memoryMb: 160 }),
        probe(`console.log("RAN");const {spawn}=require("child_process");for(let i=0;i<120;i++){try{spawn("/bin/sleep",["30"]).on("error",()=>{})}catch{}}setTimeout(()=>console.log("ESCAPED"),1500)`, { maxProcesses: 40 }),
      ]);
      const failed: string[] = [];
      const ran = (r: Exec, name: string) => { if (!r.stdout.startsWith("RAN")) { failed.push(`${name} probe did not run (${(r.stderr || r.killedBy || "no output").slice(0, 120)})`); return false; } return true; };
      if (ran(rd, "read") && (rd.stdout.includes("SELFTEST-CANARY") || !rd.stdout.includes("blocked"))) failed.push("read outside workdir");
      if (ran(wr, "write") && fs.existsSync(evil)) failed.push("write outside workdir");
      if (ran(nw, "network") && (hits > 0 || nw.stdout.includes("ESCAPED"))) failed.push("network");
      if (ran(mem, "memory") && (!/memory limit/.test(mem.killedBy ?? "") || mem.stdout.includes("ESCAPED"))) failed.push(`memory limit (${mem.killedBy ?? "not enforced"})`);
      if (ran(pids, "process") && !/process limit/.test(pids.killedBy ?? "")) failed.push(`process limit (${pids.killedBy ?? "not enforced"})`);
      return failed.length ? { available: false, mechanism: st.mechanism, platform: st.platform, reason: `self-test failed: ${failed.join(", ")}` } : st;
    } finally {
      srv.close(); fs.rmSync(base, { recursive: true, force: true });
    }
  }
}
