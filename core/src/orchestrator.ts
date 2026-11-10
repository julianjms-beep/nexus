// Central task orchestrator: project registry, task lifecycle, permission checks, audit trail.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Audit } from "./audit.ts";
import type { Security } from "./security.ts";
import { resolveReal } from "./security.ts";
import type { AgentAdapter, RunHandle } from "./adapter.ts";
import { AgentRegistry } from "./agents.ts";
import { usageFromResult, type UsageLedger } from "./usage.ts";

export type Project = { name: string; path: string };
export type TaskStatus = "running" | "succeeded" | "failed" | "cancelled" | "denied";
export type Task = {
  id: string; project: string; prompt: string; agent: string; status: TaskStatus;
  createdAt: string; finishedAt?: string; result?: string; reason?: string; sessionId?: string; costUsd?: number; runId?: string;
};

export class Orchestrator extends EventEmitter {
  private projects: Project[] = [];
  private tasks = new Map<string, Task>();
  private handles = new Map<string, RunHandle>();
  constructor(
    private dataDir: string, private audit: Audit, private security: Security,
    private adapters: Record<string, AgentAdapter>, private opts = { timeoutMs: 10 * 60_000, maxBudgetUsd: 2 }, readonly registry = new AgentRegistry(), readonly usage?: UsageLedger,
  ) {
    super();
    fs.mkdirSync(dataDir, { recursive: true });
    this.projects = this.load("projects.json", []);
    for (const t of this.load<Task[]>("tasks.json", [])) {
      // A task that was running when the process died cannot still be running.
      if (t.status === "running") { t.status = "failed"; t.reason = "orchestrator restarted"; }
      this.tasks.set(t.id, t);
    }
    for (const p of this.projects) { try { this.security.allowRoot(p.path); } catch { /* path vanished */ } }
  }
  private load<T>(f: string, d: T): T {
    try { return JSON.parse(fs.readFileSync(path.join(this.dataDir, f), "utf8")); } catch { return d; }
  }
  private save() {
    fs.writeFileSync(path.join(this.dataDir, "projects.json"), JSON.stringify(this.projects, null, 2));
    fs.writeFileSync(path.join(this.dataDir, "tasks.json"), JSON.stringify([...this.tasks.values()], null, 2));
  }

  addProject(name: string, dir: string): Project {
    const real = resolveReal(dir);
    this.security.allowRoot(real); // throws for home / filesystem root
    const p = { name, path: real };
    this.projects = this.projects.filter((x) => x.path !== real).concat(p);
    this.audit.record("project.added", p);
    this.save();
    return p;
  }
  listProjects() { return this.projects; }
  listTasks() { return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getTask(id: string) { return this.tasks.get(id); }
  /** Registers a task that ran elsewhere (remote worker) so it shows up in the task list. */
  addExternalTask(t: Task) { this.tasks.set(t.id, t); this.save(); this.emit("task", t); }
  agents() { return Object.values(this.adapters).map((a) => ({ id: a.id, ...a.detect() })); }

  submit(projectPath: string, prompt: string, agent = "developer", meta: { runId?: string; project?: string } = {}): Task {
    const def = this.registry.get(agent);
    const adapter = def && this.adapters[def.provider];
    const task: Task = { id: randomUUID(), project: resolveReal(projectPath), prompt, agent, status: "running", createdAt: new Date().toISOString(), runId: meta.runId };
    this.tasks.set(task.id, task);
    const deny = (reason: string) => {
      Object.assign(task, { status: "denied", reason, finishedAt: new Date().toISOString() });
      this.audit.record("task.denied", { id: task.id, reason });
      this.save(); this.emit("task", task); return task;
    };
    if (!adapter) return deny(`unknown agent ${agent}`);
    const d = this.security.authorize({ kind: "agent.run", project: task.project, agent });
    if (!d.allowed) return deny(d.reason);

    const budget = this.usage?.check(meta.project ?? task.project, meta.runId);
    if (budget && !budget.ok) return deny(`budget exhausted: ${budget.reason}`);
    this.audit.record("task.started", { id: task.id, project: task.project, agent, prompt });
    let lastResult: any;
    const h = adapter.run({
      cwd: task.project, prompt, timeoutMs: Math.min(def!.timeoutMs, this.opts.timeoutMs), maxBudgetUsd: Math.min(def!.maxBudgetUsd, this.opts.maxBudgetUsd),
      allowedTools: def!.tools, systemPrompt: def!.systemPrompt,
      onEvent: (e: any) => { if (e?.type === "result") lastResult = e; this.emit("event", { taskId: task.id, event: e }); },
    });
    task.sessionId = h.sessionId;
    this.handles.set(task.id, h);
    this.save();
    h.done.then((r) => {
      this.handles.delete(task.id);
      const cancelled = r.reason === "cancelled";
      Object.assign(task, {
        status: r.ok ? "succeeded" : cancelled ? "cancelled" : "failed",
        result: r.result, reason: r.reason, finishedAt: new Date().toISOString(),
      });
      if (lastResult) {
        const u = usageFromResult(lastResult); task.costUsd = u.costUsd;
        this.usage?.record({ ts: new Date().toISOString(), taskId: task.id, runId: meta.runId, agent, project: meta.project ?? task.project, status: task.status, ...u });
      }
      this.audit.record("task.finished", { id: task.id, status: task.status, exitCode: r.exitCode, reason: r.reason });
      this.save(); this.emit("task", task);
    });
    return task;
  }

  cancel(id: string) {
    const h = this.handles.get(id);
    if (!h) return false;
    this.audit.record("task.cancel_requested", { id });
    h.cancel();
    return true;
  }
}
