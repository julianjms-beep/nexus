// macOS development provider: Seatbelt (sandbox-exec) + resource watchdog.
//
// Guarantees (enforced by the kernel via a deny-default Seatbelt profile):
//   * reads limited to: the workdir, a private tmp dir, the interpreter and system libraries
//   * writes limited to: the workdir and the private tmp dir
//   * no network of any kind, no Mach services except logging (no Keychain, LaunchServices, Apple Events)
// Limits (best effort on macOS, which has no cgroups): CPU seconds (RLIMIT_CPU), file size, open files,
// resident-memory and process-count watchdog polled every 50 ms (kills the whole process group).
// macOS does NOT enforce RLIMIT_AS/RLIMIT_DATA (verified), so a single allocation that completes between two polls can
// briefly exceed the memory limit before the kill. Documented limitation; the Linux provider enforces it in the kernel.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { IsolationProvider, Isolation, LaunchSpec, Launched } from "./isolation.ts";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const sbQuote = (p: string) => JSON.stringify(p); // Seatbelt string literals use the same escaping for our inputs

export function buildProfile(workdir: string, priv: string, interp: string[]): string {
  const sys = ["/usr/lib", "/usr/share", "/System", "/private/var/db/dyld", "/private/etc/localtime", "/var/db/timezone", "/Library/Preferences/Logging"];
  return [
    "(version 1)", "(deny default)",
    "(allow process-fork)",
    `(allow process-exec ${[...interp, "/usr/bin", "/bin", "/usr/local/bin"].map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`,
    "(allow sysctl-read)", "(allow file-read-metadata)",
    `(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") ${[...sys, ...interp, "/usr/bin", "/bin"].map((p) => `(subpath ${sbQuote(p)})`).join(" ")})`,
    `(allow file-read* file-write* (subpath ${sbQuote(workdir)}) (subpath ${sbQuote(priv)}))`,
    '(allow file-write* (literal "/dev/null"))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.logd"))',
    // no (allow network*) anywhere: all sockets are denied by the default rule
  ].join("\n");
}

export class SeatbeltProvider implements IsolationProvider {
  readonly mechanism = "seatbelt";
  status(): Isolation {
    return fs.existsSync(SANDBOX_EXEC) ? { available: true, mechanism: this.mechanism, platform: "darwin" }
      : { available: false, mechanism: "none", platform: "darwin", reason: "sandbox-exec not found" };
  }
  launch(spec: LaunchSpec): Launched {
    const { limits } = spec;
    const profile = path.join(spec.priv, "..", `${path.basename(spec.priv)}.sb`);
    fs.writeFileSync(profile, buildProfile(spec.workdir, spec.priv, spec.readOnly), { mode: 0o600 });
    const cpu = Math.ceil(limits.cpuSeconds), fsz = Math.ceil(limits.maxFileMb * 1024); // macOS sh counts ulimit -f in 1 KiB blocks (verified)
    const script = `ulimit -t ${cpu}; ulimit -f ${fsz}; ulimit -n 256; ulimit -c 0; exec "$@"`;
    const child = spawn(SANDBOX_EXEC, ["-f", profile, "/bin/sh", "-c", script, "sh", ...spec.argv],
      { cwd: spec.workdir, env: spec.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ } };
    return {
      child,
      kill: killGroup,
      violation() { // resident memory + process count of this process group
        const ps = spawnSync("/bin/ps", ["-axo", "pgid=,rss="], { encoding: "utf8" }).stdout ?? "";
        let rss = 0, n = 0;
        for (const l of ps.split("\n")) { const [g, r] = l.trim().split(/\s+/).map(Number); if (g === child.pid) { rss += r; n++; } }
        if (rss / 1024 > limits.memoryMb) return `memory limit ${limits.memoryMb}MB exceeded`;
        if (n > limits.maxProcesses) return `process limit ${limits.maxProcesses} exceeded`;
        return undefined;
      },
      finalize(code, signal) { return code === 152 || signal === "SIGXCPU" ? `cpu limit ${cpu}s exceeded` : undefined; },
      cleanup() { killGroup(); fs.rmSync(profile, { force: true }); },
    };
  }
}
