// Per-platform isolation providers. A platform without an available provider cannot execute jobs (fail closed).
// Providers: "seatbelt" (macOS, development) and "linux-bwrap" (NEXUS OS: bubblewrap namespaces + cgroup v2 limits).
// Seatbelt is macOS-only and is never reused implicitly elsewhere.
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

export type Isolation = { available: boolean; mechanism: string; platform: string; reason?: string };
export type Limits = { cpuSeconds: number; memoryMb: number; timeoutMs: number; maxProcesses: number; maxOutputBytes: number; maxFileMb: number };

export type LaunchSpec = {
  argv: string[];                 // argv[0] is an absolute, resolved interpreter path chosen by NEXUS (never by an agent)
  workdir: string;                // real path; the only writable project directory
  priv: string;                   // private HOME/TMPDIR for this job (writable, deleted afterwards)
  readOnly: string[];             // extra read-only roots (the interpreter's installation prefix)
  env: Record<string, string>;    // complete environment of the job (nothing is inherited)
  limits: Limits;
};
export type Launched = {
  child: ChildProcess;
  /** Kill every process of the job, including ones that left the process group. */
  kill(why: string): void;
  /** Polled every 50 ms while the job runs: a limit violation the provider observed, if any. */
  violation(): string | undefined;
  /** After exit: the limit that ended the job (cpu/memory/processes), if any. */
  finalize(code: number | null, signal: string | null): string | undefined;
  cleanup(): void;
};
export interface IsolationProvider {
  readonly mechanism: string;
  status(): Isolation;
  launch(spec: LaunchSpec): Launched;
}

export function detectIsolation(platform: string = process.platform, exists: (p: string) => boolean = fs.existsSync): Isolation {
  if (platform === "darwin") {
    return exists("/usr/bin/sandbox-exec") ? { available: true, mechanism: "seatbelt", platform }
      : { available: false, mechanism: "none", platform, reason: "sandbox-exec not found" };
  }
  if (platform === "linux") {
    // The Linux provider needs real kernel probes (user namespaces, a delegated cgroup), so it can only be judged on Linux itself.
    if (process.platform !== "linux") return { available: false, mechanism: "none", platform, reason: "linux isolation can only be verified on a linux host" };
    return linuxStatusHook?.() ?? { available: false, mechanism: "none", platform, reason: "linux provider not loaded" };
  }
  // Windows (AppContainer/job objects) and other platforms: not implemented.
  return { available: false, mechanism: "none", platform, reason: `no isolation mechanism implemented for ${platform}` };
}

// iso-linux.ts registers itself here (avoids an import cycle and keeps macOS from loading Linux code paths).
let linuxStatusHook: (() => Isolation) | undefined;
export function registerLinuxStatus(fn: () => Isolation) { linuxStatusHook = fn; }
