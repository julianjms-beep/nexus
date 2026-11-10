// Provider-independent agent adapter + Claude Code adapter using only the documented
// `claude -p --output-format stream-json` interface.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export type RunOptions = {
  cwd: string;
  prompt: string;
  timeoutMs: number;
  maxBudgetUsd?: number;
  sessionId?: string;
  resume?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  onEvent: (e: unknown) => void;
};
export type RunHandle = {
  sessionId: string;
  cancel: () => void;
  done: Promise<{ ok: boolean; result: string; exitCode: number | null; reason?: string }>;
};
export interface AgentAdapter {
  id: string;
  detect(): { installed: boolean; version?: string };
  run(opts: RunOptions): RunHandle;
}

// Only these variables reach the subprocess; everything else (cloud keys, tokens) stays out.
const ENV_ALLOW = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
export function cleanEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ENV_ALLOW) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

// No Bash by default: the subprocess is NOT sandboxed, so shell access is not granted implicitly.
export const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"];

export class ClaudeCodeAdapter implements AgentAdapter {
  id = "claude-code";
  constructor(private bin = "claude") {}

  detect() {
    const r = spawnSync(this.bin, ["--version"], { encoding: "utf8", env: cleanEnv() });
    return r.status === 0 ? { installed: true, version: r.stdout.trim() } : { installed: false };
  }

  run(o: RunOptions): RunHandle {
    const sessionId = o.resume ? o.resume : (o.sessionId ?? randomUUID());
    const args = ["-p", o.prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
    // --tools limits which built-in tools exist at all ("" = none); --allowedTools only pre-approves them.
    const tools = o.allowedTools ?? DEFAULT_TOOLS;
    args.push("--tools", tools.join(","));
    if (tools.length) args.push("--allowedTools", tools.join(","));
    // Isolate the agent from the user's global plugins/MCP servers/skills/hooks: they add hundreds of
    // thousands of context tokens per call (measured: ~$0.9 for a one-word reply) and widen the attack surface.
    args.push("--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands");
    if (o.resume) args.push("--resume", o.resume); else args.push("--session-id", sessionId);
    if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
    if (o.maxBudgetUsd) args.push("--max-budget-usd", String(o.maxBudgetUsd));

    const child: ChildProcess = spawn(this.bin, args, { cwd: o.cwd, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", stderr = "", result = "", isError = false, killedBy: string | undefined;
    const kill = (why: string) => { killedBy ??= why; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 3000).unref(); };
    const timer = setTimeout(() => kill("timeout"), o.timeoutMs);

    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result") { result = String(ev.result ?? ""); isError = !!ev.is_error; }
          o.onEvent(ev);
        } catch { o.onEvent({ type: "raw", line }); }
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });

    const done = new Promise<Awaited<RunHandle["done"]>>((resolve) => {
      child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, result: "", exitCode: null, reason: `spawn failed: ${e.message}` }); });
      child.on("close", (code) => {
        clearTimeout(timer);
        const ok = code === 0 && !isError && !killedBy;
        resolve({ ok, result, exitCode: code, reason: ok ? undefined : killedBy ?? (stderr.trim() || result || `exit ${code}`) });
      });
    });
    return { sessionId, cancel: () => kill("cancelled"), done };
  }
}
