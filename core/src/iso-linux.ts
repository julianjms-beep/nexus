// NEXUS OS isolation provider "linux-bwrap": bubblewrap namespaces + cgroup v2 limits enforced by the kernel.
//
// Every job runs as:   sh (joins its own cgroup) -> prlimit (rlimits) -> bwrap (namespaces) -> interpreter
//   * user, pid, ipc, uts, net and cgroup namespaces; the job sees only its own processes and has NO network
//     (an empty network namespace: not even the host's loopback services are reachable)
//   * filesystem: a read-only root skeleton with /usr (+ usr-merge links), the interpreter prefix read-only,
//     the workdir and a private HOME/TMPDIR read-write, a size-limited private /tmp. Nothing else of the host exists.
//   * no capabilities, no new privileges (bwrap sets PR_SET_NO_NEW_PRIVS), nested user namespaces disabled,
//     new session (no terminal injection), scrubbed environment
//   * cgroup v2: memory.max (+ no swap, OOM kills the whole job), pids.max; cgroup.kill stops every process of the job
//   * rlimits: CPU seconds, file size, open files, no core dumps
// Requires a delegated cgroup subtree (systemd Delegate=yes). Without one the provider reports unavailable and nothing runs.
// Not yet: seccomp allow-list and Landlock as second barriers (planned; namespaces + no caps already block the obvious paths).
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerLinuxStatus, type IsolationProvider, type Isolation, type LaunchSpec, type Launched } from "./isolation.ts";

const BWRAP = "/usr/bin/bwrap", PRLIMIT = "/usr/bin/prlimit", SH = "/bin/sh", CGFS = "/sys/fs/cgroup";
export const SUPERVISOR = "nexus-supervisor";
const MECH = "linux-bwrap";

const read = (p: string) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const writable = (p: string) => { try { fs.accessSync(p, fs.constants.W_OK); return true; } catch { return false; } };
const counter = (file: string, key: string) => Number(read(file).match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] ?? 0);
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ------------------------------------------------------------------ delegated cgroup
let rootMemo: { root?: string; reason?: string } | undefined;
/** The cgroup under which job cgroups are created. Resolved once per process. */
export function cgroupRoot(): { root?: string; reason?: string } {
  if (!rootMemo?.root) rootMemo = resolveRoot();
  return rootMemo;
}
function resolveRoot(): { root?: string; reason?: string } {
  const line = read("/proc/self/cgroup").split("\n").find((l) => l.startsWith("0::"));
  if (!line) return { reason: "cgroup v2 (unified hierarchy) is not mounted" };
  const own = path.join(CGFS, line.slice(3).trim());
  const root = process.env.NEXUS_CGROUP_ROOT ? path.resolve(process.env.NEXUS_CGROUP_ROOT)
    : path.basename(own) === SUPERVISOR ? path.dirname(own) : own;
  if (!root.startsWith(CGFS + "/")) return { reason: `cgroup root ${root} is outside ${CGFS}` };
  const ctrls = read(path.join(root, "cgroup.controllers")).split(/\s+/);
  for (const c of ["memory", "pids"]) if (!ctrls.includes(c)) return { reason: `cgroup controller "${c}" is not delegated to ${root} (run under systemd with Delegate=yes)` };
  if (!writable(path.join(root, "cgroup.procs")) || !writable(path.join(root, "cgroup.subtree_control")))
    return { reason: `cgroup ${root} is not delegated to this user (run under systemd with Delegate=yes, or: systemd-run --user --scope -p Delegate=yes ...)` };
  // cgroup v2 "no internal processes" rule: move every process of the root into a leaf, then enable controllers for job cgroups.
  const sup = path.join(root, SUPERVISOR);
  try { fs.mkdirSync(sup); } catch (e: any) { if (e.code !== "EEXIST") return { reason: `cannot create ${sup}: ${e.message}` }; }
  const want = ["memory", "pids", ...(ctrls.includes("cpu") ? ["cpu"] : [])];
  for (let i = 0; i < 25; i++) {
    for (const pid of read(path.join(root, "cgroup.procs")).split("\n").filter(Boolean)) {
      try { fs.writeFileSync(path.join(sup, "cgroup.procs"), pid); } catch { /* exited meanwhile */ }
    }
    try { fs.writeFileSync(path.join(root, "cgroup.subtree_control"), want.map((c) => "+" + c).join(" ")); }
    catch (e: any) { if (e.code === "EBUSY") { pause(10); continue; } return { reason: `cannot enable controllers in ${root}: ${e.message}` }; }
    const enabled = read(path.join(root, "cgroup.subtree_control")).split(/\s+/);
    if (want.every((c) => enabled.includes(c))) return { root };
  }
  return { reason: `could not enable cgroup controllers in ${root} (processes keep appearing in it)` };
}

// ------------------------------------------------------------------ status
/** usr-merge: /bin, /lib, ... are symlinks into /usr on Debian 13; mirror whatever the host has. */
function rootLinks(): string[] {
  const out: string[] = [];
  for (const d of ["bin", "sbin", "lib", "lib32", "lib64", "libx32"]) {
    const p = "/" + d; let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) out.push("--symlink", fs.readlinkSync(p), p);
    else if (st.isDirectory()) out.push("--ro-bind", p, p);
  }
  return out;
}
let probeMemo: Isolation | undefined;
export function linuxStatus(): Isolation {
  const platform = "linux";
  const no = (reason: string): Isolation => ({ available: false, mechanism: "none", platform, reason });
  if (!fs.existsSync(BWRAP)) return no("bubblewrap (/usr/bin/bwrap) is not installed");
  if (!fs.existsSync(PRLIMIT)) return no("prlimit (util-linux) is not installed");
  const cg = cgroupRoot();
  if (!cg.root) return no(cg.reason!);
  probeMemo ??= (() => {
    const r = spawnSync(BWRAP, ["--unshare-all", "--unshare-user", "--disable-userns", "--ro-bind", "/usr", "/usr", ...rootLinks(), "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"],
      { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin" } });
    return r.status === 0 ? { available: true, mechanism: MECH, platform } : no(`bubblewrap cannot create namespaces: ${(r.stderr || r.error?.message || "").trim().slice(0, 200)}`);
  })();
  return probeMemo;
}
registerLinuxStatus(linuxStatus);

// ------------------------------------------------------------------ provider
export class LinuxBwrapProvider implements IsolationProvider {
  readonly mechanism = MECH;
  status(): Isolation { return linuxStatus(); }

  launch(spec: LaunchSpec): Launched {
    const { limits } = spec;
    const root = cgroupRoot().root;
    if (!root) throw new Error("no delegated cgroup: refusing to run unisolated");
    const cg = path.join(root, `nexus-job-${randomUUID()}`);
    fs.mkdirSync(cg);
    const set = (f: string, v: number, optional = false) => { try { fs.writeFileSync(path.join(cg, f), String(v)); } catch (e) { if (!optional) throw e; } };
    set("memory.max", Math.ceil(limits.memoryMb * 1024 * 1024));
    set("memory.swap.max", 0, true);
    set("memory.oom.group", 1, true);
    set("pids.max", limits.maxProcesses + 3); // + bwrap's outer monitor, the namespace init and one spare for the exec chain

    const cpu = Math.ceil(limits.cpuSeconds), fsize = Math.ceil(limits.maxFileMb * 1024 * 1024);
    const bw = [
      "--unshare-user", "--unshare-ipc", "--unshare-pid", "--unshare-net", "--unshare-uts", "--unshare-cgroup-try",
      "--disable-userns", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--hostname", "nexus-sandbox",
      "--ro-bind", "/usr", "/usr", ...rootLinks(),
      ...["/etc/ld.so.cache", "/etc/localtime", "/etc/alternatives"].flatMap((p) => ["--ro-bind-try", p, p]),
      ...spec.readOnly.flatMap((p) => ["--ro-bind", p, p]),
      "--proc", "/proc", "--dev", "/dev",
      "--size", String(64 * 1024 * 1024), "--tmpfs", "/tmp",
      "--bind", spec.priv, spec.priv, "--bind", spec.workdir, spec.workdir,
      "--remount-ro", "/",
      "--chdir", spec.workdir, "--clearenv", ...Object.entries(spec.env).flatMap(([k, v]) => ["--setenv", k, v]),
      "--", ...spec.argv,
    ];
    // The shell moves ITSELF into the job cgroup before exec, so no process of the job ever runs outside it.
    const script = 'echo $$ > "$0" || exit 125; exec "$@"';
    const child = spawn(SH, ["-c", script, path.join(cg, "cgroup.procs"),
      PRLIMIT, `--cpu=${cpu}:${cpu + 2}`, `--fsize=${fsize}`, "--nofile=256", "--core=0", "--", BWRAP, ...bw],
      { cwd: "/", env: { PATH: "/usr/bin:/bin" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });

    const killAll = () => {
      try { fs.writeFileSync(path.join(cg, "cgroup.kill"), "1"); } catch { /* cgroup gone or kernel < 5.14 */ }
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* group already empty */ }
    };
    const limitHit = (): string | undefined => {
      if (counter(path.join(cg, "memory.events"), "oom_kill") > 0 || counter(path.join(cg, "memory.events"), "oom_group_kill") > 0)
        return `memory limit ${limits.memoryMb}MB exceeded`;
      if (counter(path.join(cg, "pids.events"), "max") > 0) return `process limit ${limits.maxProcesses} exceeded`;
      return undefined;
    };
    return {
      child,
      kill: killAll,
      violation: limitHit,
      finalize(code, signal) {
        const cpuUsec = counter(path.join(cg, "cpu.stat"), "usage_usec");
        return limitHit() ?? (code === 152 || signal === "SIGXCPU" || (code === 137 && cpuUsec >= cpu * 1e6) ? `cpu limit ${cpu}s exceeded` : undefined);
      },
      cleanup() {
        killAll();
        for (let i = 0; i < 100; i++) {
          try { fs.rmdirSync(cg); return; } catch (e: any) { if (e.code === "ENOENT") return; pause(20); }
        }
      },
    };
  }
}
