// Agent registry: each role has explicit tools, limits and a system prompt.
// Agents cannot change their own definition; the registry is fixed at construction.
export type AgentDef = {
  id: string;
  title: string;
  provider: string;
  tools: string[];
  /** true if the role can modify files (these are serialized per project to avoid write conflicts). */
  writes: boolean;
  systemPrompt: string;
  timeoutMs: number;
  maxBudgetUsd: number;
};

const READ = ["Read", "Glob", "Grep"];
const WRITE = [...READ, "Edit", "Write"];

export const DEFAULT_AGENTS: AgentDef[] = [
  { id: "developer", title: "Developer", provider: "claude-code", tools: WRITE, writes: true, timeoutMs: 600_000, maxBudgetUsd: 2,
    systemPrompt: "You are the Developer agent. Implement exactly what is asked in the current project, with small focused changes. Do not touch files outside the task. End with a short summary of the files you changed." },
  { id: "testing", title: "Testing", provider: "claude-code", tools: WRITE, writes: true, timeoutMs: 600_000, maxBudgetUsd: 2,
    systemPrompt: "You are the Testing agent. Read the existing code and write automated tests for it in the project's existing test style. You cannot run commands: say which command a human should run. Never edit non-test source files." },
  { id: "security", title: "Security", provider: "claude-code", tools: READ, writes: false, timeoutMs: 300_000, maxBudgetUsd: 1,
    systemPrompt: "You are the Security agent. Review the code read-only for vulnerabilities. Report each finding with file, line, severity and a proposed fix. If you find none, say so explicitly. Do not modify anything." },
  { id: "documentation", title: "Documentation", provider: "claude-code", tools: WRITE, writes: true, timeoutMs: 300_000, maxBudgetUsd: 1,
    systemPrompt: "You are the Documentation agent. Write or update documentation (README, docs/) that accurately describes the code as it is. Do not change source code." },
  { id: "research", title: "Research", provider: "claude-code", tools: READ, writes: false, timeoutMs: 300_000, maxBudgetUsd: 1,
    systemPrompt: "You are the Research agent. Investigate the codebase read-only and answer the question with evidence (file paths and lines). Do not modify anything." },
  // Planner has no tools at all: it only turns a goal into a JSON plan.
  { id: "planner", title: "Planner", provider: "claude-code", tools: [], writes: false, timeoutMs: 120_000, maxBudgetUsd: 0.5,
    systemPrompt: "You are the Planner. You only output JSON, no prose, no code fences." },
];

export class AgentRegistry {
  private byId = new Map<string, AgentDef>();
  constructor(defs: AgentDef[] = DEFAULT_AGENTS) { for (const d of defs) this.byId.set(d.id, Object.freeze({ ...d, tools: Object.freeze([...d.tools]) as unknown as string[] })); }
  get(id: string) { return this.byId.get(id); }
  list() { return this.byId.values().toArray(); }
}
