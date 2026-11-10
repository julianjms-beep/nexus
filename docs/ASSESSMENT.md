# NEXUS OS — Phase 0 assessment and Phase 1 status (2026-10-15)

## Phase 0 — repository audit
No NEXUS OS repository existed on this machine. The closest project, `~/Projects/jarvis` (Python/Swift voice assistant),
does not mention NEXUS and was left untouched. Decision (user): start from scratch in `~/Projects/nexus-os`.
Toolchain found: Node 24, Claude Code 2.1.300, Python 3.14, git. Rust 1.99 installed afterwards via rustup.

## Phase 1 — implemented and tested
| Piece | File | Status |
|---|---|---|
| Permission engine (default-deny, realpath containment, sensitive paths, approvals) | core/src/security.ts | implemented, 11 tests |
| Hash-chained audit log | core/src/audit.ts | implemented, tamper test |
| Provider-independent agent adapter + Claude Code adapter (`claude -p --output-format stream-json`) | core/src/adapter.ts | implemented; live run verified |
| Orchestrator: projects, task lifecycle, cancel, timeout, restart recovery | core/src/orchestrator.ts | implemented, 9 tests |
| Local API (127.0.0.1, bearer token 0600, Host/Origin checks, SSE) | core/src/server.ts | implemented, smoke-tested |
| Web UI (projects, task submit, tasks, approvals, audit) | ui/ | implemented, built, screenshot-checked |

## Evidence
- `npm test`: 20/20 pass (these use a fixture script in place of `claude`, declared as such in the test header).
- `node --experimental-transform-types core/test/live-claude.mjs`: real Claude Code 2.1.300 created `hello.txt`
  ("nexus ok") in an authorized temp project via the HTTP API; request without token -> 401; task outside project -> denied;
  audit chain integrity ok.

## Known limitations (honest list)
- **Not sandboxed.** Claude Code runs as the user. Mitigations only: env allowlist, no Bash tool by default, cwd = authorized
  project, budget cap ($2), timeout (10 min). Claude Code's own `acceptEdits` mode can still touch paths it considers in scope.
  A real sandbox (macOS sandbox-exec / container) is future work.

- Approvals exist in the engine and UI, but no Phase-1 action currently triggers one (high-risk actions arrive with later phases).
- Cost tracking reads nothing from Claude output yet; only the budget flag is passed.
- Tasks are single-shot; resume support exists in the adapter (`resume`) but is not exposed in the API/UI.
- Dashboard sections for Phases 2-9 (voice, flow, web studio, sentinel, etc.) do NOT exist.

## Next milestone
Phase 2: agent registry + task decomposition with two cooperating agents, plus install Rust and wrap the UI in Tauri.

## Update: desktop shell
`src-tauri/` (Tauri 2) compiles and launches: it starts the Node core on 127.0.0.1:7777, opens a native window on it and the
core exits when the app dies (verified). Run: `cd src-tauri && cargo run`. Limitations: requires Node on the machine and the repo
path (not bundled/signed); window open verified via process + port, not by screenshot (macOS accessibility blocked osascript).

## Phase 2 — agent execution (2026-10-15)
Implemented: agent registry with per-role tools/limits/system prompt (`agents.ts`), plan validation (cycles, unknown agents/deps,
path escapes, max 8 steps), dependency scheduler with parallel read-only steps and per-project serialized writers, handoff of
results between agents, result validation (non-empty result + `expectFiles`), approval checkpoints, cancel, persistence
(`workflow.ts`); Planner proposes plans but nothing runs without an explicit `POST /api/runs`; UI panel.
Evidence: `npm test` 32/32 (fixture claude). `core/test/live-phase2.mjs` with real Claude Code: Developer wrote slug.js, Testing
agent (depends on it, receives its result) wrote slug.test.js, and `node --test` run by the script (not an agent) passed 6/6.
Planner also produced a valid 4-step plan with a parallel-capable fan-out.

Findings fixed along the way:
- Agents loaded the user's global plugins/MCP/skills: ~230k context tokens, ~$0.92 per trivial call (and budget overruns -> exit 1).
  Now `--setting-sources project --strict-mcp-config --disable-slash-commands`: ~$0.009 per call. Pinned by a test.
- `--allowedTools` only pre-approves; `--tools` actually restricts. Both are passed; empty tool list (Planner) = no tools.
Limitations: agents cannot run commands (no Bash), so validation of behaviour is by file checks or a human/harness running tests;
writers are serialized per project but not isolated in separate worktrees; plan steps are not editable in the UI; no cost totals yet.

## Phase 2.5 — sandbox, test loop, worktrees, costs (2026-10-15)
**Sandbox technology:** macOS Seatbelt via `sandbox-exec` (deny-default profile built per run) + watchdog. Docker/Apple `container`
are not installed; `sandbox-exec` is deprecated by Apple but works on macOS 26.3 and is what browsers/CLI tools use.
Guarantees (kernel-enforced, each pinned by an adversarial test that runs hostile Python in the real sandbox):
reads only workdir + private tmp + interpreter/system libs; writes only workdir + private tmp; no network at all; no Keychain /
Apple Events / LaunchServices (osascript, security, open verified neutralised); scrubbed env, private HOME; symlink escape blocked;
no orphan processes after timeout/cancel; agents never choose the command (fixed runner ids `python-unittest`, `node-test`).
Limits: CPU seconds (RLIMIT_CPU), file size (RLIMIT_FSIZE, 1 KiB blocks on macOS), wall-clock timeout, process count and RSS
watchdog (50 ms poll), output cap, persistent JSON logs per run in `.nexus/sandbox/`.
**Limitations:** macOS does not enforce RLIMIT_AS/DATA, so memory is polled: a single allocation completing between polls can briefly
overshoot before the kill. Seatbelt cannot cap process count itself (watchdog does). Python/node interpreters are readable
read-only. Same-user kernel exploits are out of scope. Claude Code itself still runs unsandboxed as the user (restricted by flags:
no Bash, tools allowlist, scrubbed env, own cwd = worktree) — only the *execution of generated code* is sandboxed.
**Test loop:** plan step `{kind:"sandbox", runner, fixWith, maxIterations<=5}`; NEXUS runs tests, on failure sends the fix agent a
structured report (failed test names, exit code, output tail), reruns; bounded by iterations and per-run/project/total budgets.
**Worktrees:** one branch+directory per run (`nexus/run-xxxx`), conflict detection with `git merge-tree`, hooks disabled, `.git`
pointer tamper check, work committed by NEXUS, independent sandbox re-verification of the committed state, directory removed after
the run, branch kept. Integration is a human action (`POST /api/runs/:id/integrate`), only if verified, tree clean, no conflicts.
**Costs:** per task/agent/run/project/total ledger (`.nexus/usage.jsonl`), budgets (`perRun/perProject/total`, defaults $3/$20/$50)
with `budget.exhausted` audit events and denial of new work. Figures are ESTIMATES from Claude Code's `total_cost_usd`.
This install uses a **claude.ai Pro subscription** (no per-token billing); if `ANTHROPIC_API_KEY` is set NEXUS reports "metered".
**Evidence:** `npm test` 74/74 (adds 18 adversarial sandbox, 9 git, 8 usage, 7 sandbox-workflow tests). `core/test/live-phase25.mjs`
with real Claude Code: scenario A (Planner plan with sandbox step; developer+testing+security+docs; 21 tests pass in sandbox;
verified branch integrated by explicit call) and scenario B (seeded bug in `stats.py`: iteration 1 FAIL on 2 tests, real Developer
fixed from the structured report, iteration 2 PASS). Estimated total $0.22 for 6 agent calls.
**Honest note:** in scenario A the tests passed on the first iteration, so the fix loop was exercised live only by scenario B
(seeded bug) and by fixture tests.
## Phase 3 — remote workers (2026-10-15) — ACCEPTED
Design + amendments: `docs/PHASE3-DESIGN.md`. Code: `pki.ts` (TLS 1.3 mTLS, issuance/renewal+key rotation/revocation/CA rotation via `openssl` + Node crypto),
`protocol.ts`, `gateway.ts` (separate listener, loopback by default, one-time enrollment tokens), `worker.ts` + `worker-cli.ts` (own key, local policy, own audit chain),
`transfer.ts` (explicit manifests, path rules, size limits, secret detection, hostile-return validation), `remote.ts` (executions, leases, fencing, effect-class retry policy),
`isolation.ts` (no provider => refuse), `netpolicy.ts`, signed-audit support in `audit.ts`, workflow `execution: local|remote|auto`, admin API and UI panel.
Evidence: `npm test` 131/131 (real TLS, separate worker processes, real Seatbelt/Python/git; the LLM is the only fixture) and `core/test/live-phase3.mjs`
with real Claude Code on a separate worker process: mTLS/TLS 1.3 (TLS_AES_256_GCM_SHA384), unauthenticated client dropped, worker key never on the control plane,
hostile job blocked from worker key/canary/~/.ssh/~/.claude/network, memory and CPU limits enforced, real Claude repaired a seeded bug on the worker (fail -> fix -> pass) with
output validated and fenced, verified branch integrated by a human, remote cancel in milliseconds with no orphan, SIGKILL mid-job recovered on a second worker (attempt 2, higher fence),
revocation stopped the worker, both audit chains intact. Estimated agent cost $0.03 (subscription: not billed).
Limitations: both ends share one Mac (separate processes, real TLS; the Linux VM milestone will give a true cross-host test); only macOS has an isolation provider
(Linux/Windows workers refuse execution); agent jobs run Claude Code unsandboxed on the worker and are off by default; the audit hash chain is not tamper-proof on its own
(see `audit.ts`; signed records are supported); certificate/CA rotation was tested with short windows, not over weeks; macOS memory-limit enforcement is polled.
Next: `docs/NEXUS-OS-ARCHITECTURE.md` (proposal awaiting approval; no distribution work starts before that).

**Remaining risks:** Seatbelt deprecation; Claude Code process unsandboxed; agent-written code is executed only in the sandbox but
merged code is then trusted by the user; UI task list shows full prompts (noisy); cost totals count only completed tasks.
