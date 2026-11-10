# NEXUS OS — Linux operating system architecture (proposal for approval)

Status: **PROPOSAL — nothing here is implemented yet.** No distribution work starts until this is approved.
Success criterion (unchanged): switch on a computer and NEXUS OS boots as the operating system. Opening NEXUS in a window is not success.

## 0. Honest scope
A bootable OS with its own desktop is a multi-year product if built from scratch. The plan below is deliberately a **distribution**:
we do not write a kernel, init system, network stack, graphics stack or audio stack. We integrate proven components and write the
parts that make NEXUS different: the Engine, the AI service, the policy/audit/isolation layer, the Shell and the first-party apps.
The Shell (compositor + desktop) is the largest piece of original engineering and is therefore staged.

## 1. Audit: what we already have and what happens to it on Linux
| Existing component (Phases 1–3) | Linux fate | Notes |
|---|---|---|
| `security.ts` policy engine (default deny, realpath containment, approvals) | **Reuse as-is** → core of `nexus-policyd` | Add caller identity from `SO_PEERCRED` (uid/pid/cgroup) instead of a bearer token |
| `audit.ts` hash chain + `AuditSigner` | **Reuse**, add TPM-bound / remote signer | Runs in `nexus-auditd`; key not readable by the audited services |
| `orchestrator.ts`, `agents.ts`, `workflow.ts`, `usage.ts`, `worktree.ts` | **Reuse as-is** (Node + git exist on Linux) | These are the Engine |
| `adapter.ts` (Claude Code via documented CLI) | **Reuse**; add provider adapters (local models, API) | Claude Code is proprietary: installed by the user at first boot, **not redistributed in the image** (verify licence before any bundling) |
| `sandbox.ts` (Seatbelt + watchdog) | **Do not port**; put behind an `IsolationProvider` interface and add a Linux provider | See §3. Seatbelt stays for macOS development |
| `isolation.ts` (per-platform detection) | **Reuse** and extend | The Linux provider flips `available` only when its self-test passes |
| `pki.ts`, `protocol.ts`, `transfer.ts`, `gateway.ts`, `worker.ts`, `remote.ts` | **Reuse as-is** (pure Node + `openssl`) | A Linux VM is a genuinely different kernel and host: it closes the "same Mac" limitation of Phase 3 |
| `server.ts` local HTTP API (127.0.0.1 + token) | **Keep for dev**, add a Unix-socket transport | Production IPC = Unix domain sockets in `/run/nexus/` with peer credentials |
| React UI + Tauri shell | **Demote to dev/diagnostic console** | Not the product. May survive as a remote-admin web console |
| 100+ tests | **Reuse**; run on Linux CI | Seatbelt-specific tests become provider-specific suites |

Not reusable / new: the compositor, the desktop shell, the first-party apps, the voice pipeline, the image build, the installer.

## 2. System architecture
```
┌──────────────────────────── NEXUS Applications (sandboxed, per-app manifest) ───────────────────────────┐
│ Files · Settings · Terminal · Notes · third-party apps · agent-built apps                                 │
├────────────────────────────────────── NEXUS Shell (user session) ───────────────────────────────────────┤
│ compositor (Wayland) · panel · launcher · notification centre · AI bar · resource panel · lock screen    │
├────────────────────────────────────── NEXUS AI (service) ───────────────────────────────────────────────┤
│ intent router · provider abstraction (Claude, local) · voice (wake, STT, TTS) · memory · tool broker     │
├────────────────────────────────────── NEXUS Engine (service) ───────────────────────────────────────────┤
│ orchestrator · agents · workflows · usage/budgets · worktrees · remote executor/gateway (existing code)  │
├──────────────────────────── NEXUS System Services (unprivileged, hardened systemd units) ───────────────┤
│ policyd (authorise) · auditd (chain+sign) · sandboxd (isolation) · credd (secret vault)                  │
├───────────────────────────────────────── NEXUS Workers ─────────────────────────────────────────────────┤
│ same Engine protocol (mTLS); a Linux isolation provider is required or execution is refused              │
├───────────────────────────────────── Linux kernel + systemd + PipeWire + Mesa ───────────────────────────┤
│ cgroup v2 · namespaces · seccomp · Landlock · AppArmor · LUKS/TPM2 · dm-verity · UEFI Secure Boot        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```
### 2.1 Services (systemd units, unprivileged users, `NoNewPrivileges`, `ProtectSystem=strict`, private /tmp, no capabilities, seccomp filter)
| Unit | Role | Runs as |
|---|---|---|
| `nexus-policyd` | The only place authorisation decisions are made, using the caller's kernel-verified identity | `nexus-policy` |
| `nexus-auditd` | Append-only chain, signs records, exposes the head hash for anchoring. Writers cannot rewrite history | `nexus-audit` |
| `nexus-sandboxd` | Launches every untrusted job as a transient systemd unit in its own cgroup + bubblewrap/Landlock/seccomp sandbox | `nexus-sandbox` (delegated cgroup subtree) |
| `nexus-credd` | Secret vault (TPM2-sealed). Secrets are injected into a process at launch, never passed to models or logs | `nexus-cred` |
| `nexus-engined` | Today's Engine (orchestrator, workflows, remote executor). Talks to the others over Unix sockets | `nexus-engine` |
| `nexus-aid` | NEXUS AI: model routing, voice, memory, tool broker with capability tokens | `nexus-ai` |
| `nexus-gatewayd` | Worker gateway (existing mTLS gateway); off by default, loopback by default | `nexus-gateway` |
| `nexus-voiced` | Wake word + STT/TTS over PipeWire; microphone only through a portal with a visible indicator | user service |

Everything starts from `nexus.target`. Per-user data lives in the user's home; system state in `/var/lib/nexus/*`.
### 2.2 IPC and identity
Unix domain sockets in `/run/nexus/`, authenticated with `SO_PEERCRED` (uid, gid, pid) and the caller's cgroup, so policy can tell
"the Shell", "an agent unit" and "a user app" apart. No TCP between local components. Remote access exists only through the mTLS gateway.
### 2.3 NEXUS AI as an OS service (not a chatbot)
- It acts only through **brokered, authorised interfaces**: (a) app *intents* declared in app manifests, (b) the accessibility tree (AT-SPI) for apps that opt in,
  (c) the filesystem through policyd-approved grants, (d) process/service control through `sandboxd`/systemd under policy.
- **No screen scraping by default.** Screen understanding is a portal with an explicit, visible, revocable grant per window.
- Agents are **managed services**: each run is a transient unit (`nexus-agent@<id>.service`) in `nexus-agents.slice`, with cgroup limits, a bubblewrap
  filesystem view containing only its worktree, no network unless that capability is granted, and the Phase 2.5 rules (no Bash, no secrets).
- **Capability tokens:** policyd mints short-lived, scoped tokens (e.g. `fs.write:/home/u/Projects/x` for 10 minutes); services verify them. An agent can never mint its own.
- Voice activation never authorises anything privileged (unchanged from the original brief).
### 2.4 Filesystem and boot
Immutable `/usr` (read-only, later dm-verity), `/etc/nexus` config, `/var/lib/nexus` state, `/var/lib/nexus/workspaces` for agent worktrees (own subvolume/quota),
encrypted homes (LUKS2 + TPM2 later). Boot chain: UEFI → systemd-boot → Unified Kernel Image → systemd → `nexus.target` → `greetd` → NEXUS Shell.
Secure Boot and measured boot arrive in phase L7, not in the first image.
### 2.5 Updates
Dev images: `apt`. Release: image-based A/B updates (`systemd-sysupdate`), atomic with rollback. Decided later; the image format below does not block it.

## 3. Linux isolation provider (replaces Seatbelt on Linux)
`IsolationProvider` interface (`run(spec) → handle`, `selfTest()`); providers: `seatbelt` (macOS, existing) and `linux-bwrap` (new).
`linux-bwrap` = transient systemd unit (`systemd-run`) with cgroup v2 `MemoryMax`, `CPUQuota`, `TasksMax`, `IOWeight` (**real kernel-enforced memory and process limits, stronger than on macOS**);
bubblewrap namespaces (user, mount, pid, net, ipc, uts), read-only bind of the interpreter, a single writable bind for the job directory, an empty network namespace;
seccomp allow-list; Landlock as a second filesystem barrier; scrubbed environment. `selfTest()` replays the adversarial suite (read outside, write outside, network, fork bomb, memory hog)
when the service starts; if any check fails the provider reports `available: false` and the worker **refuses to execute** (the Phase 3 rule).
Windows would need AppContainer/job objects and is out of scope.

## 4. Image build strategy
| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Debian 13 + mkosi** (systemd's image builder) | Declarative, reproducible (pinned snapshot), produces bootable disk images/UKIs/qcow2, huge package set (Node, Python, bubblewrap, Mesa, wlroots, Qt6, PipeWire), broad hardware, firmware | Not image-native by default (verity/A-B are added later) | **Recommended** |
| NixOS | Atomic, reproducible, rollback | Steep learning curve, unusual layout, slower iteration | Revisit for release engineering |
| Buildroot / Yocto | Tiny, tightly controlled | No ecosystem for a full desktop plus Node/Python/Qt; slow builds | No |
| Alpine (musl) | Small | musl friction with Node, Python wheels and voice tooling | No |

Pipeline: `mkosi` profiles `dev` (serial console, ssh key, apt) and `release` (read-only root). Output: raw GPT image (ESP + root) → qcow2. Kernel: Debian's signed LTS kernel first; a hardened custom config later.
### 4.1 What this Mac can do today (measured)
`arm64`, 10 cores, 16 GB RAM, **26 GB free disk (tight)**, hardware virtualisation supported (HVF), **no QEMU, Homebrew, Lima, Docker or UTM installed**.
- Target **aarch64 first** for the dev loop (native speed under Apple's hypervisor) and **x86_64 second** (what most real hardware needs; built in CI, emulation locally is slow).
- VM runner options: (a) **Apple Virtualization.framework** through a small Swift tool — no third-party installs, UEFI boot, virtio devices, but no 3D acceleration (software rendering is enough for milestone 1);
  (b) **QEMU + HVF** (via Homebrew) — virgl 3D, swtpm, more flexible. Recommendation: start with (a), add (b) when GPU/TPM testing is needed.
- mkosi needs Linux, so a small Debian arm64 **builder VM** (~20 GB) is required. **Disk space must be freed, or an external disk provided.**
### 4.2 Licensing to resolve before shipping an image
Claude Code and any non-free firmware or codecs are not ours to redistribute; wake-word engines and TTS voices have their own licences (candidates: openWakeWord, whisper.cpp, Piper — each to be verified).
The image installs Claude Code on first boot through the official installer, with the user's own login.

## 5. NEXUS Shell, graphics and window management
Not a web page in a window: a **native Wayland** desktop.
| Layer | Recommendation | Alternatives considered |
|---|---|---|
| Display stack | Wayland only (XWayland for legacy apps), Mesa, `greetd` login | X11 (weak isolation) |
| Compositor | **S1: wlroots-based compositor (Wayfire or labwc) + our shell as layer-shell clients. S2: our own `nexus-compositor` in Rust on Smithay**, behind a private shell protocol so the swap is invisible to apps | KWin/Mutter (heavy to bend into a distinct product), Hyprland (not a stable base), writing wlroots-level code from day one (too slow) |
| Shell UI toolkit | **Qt6/QML** (GPU scene graph, shaders, fluid animation — suits a futuristic visual language) | GTK4 (less suited to custom visuals), Rust + iced/Slint (immature for a full desktop), web (rejected) |
| Window management | Floating + tiling hybrid, virtual workspaces, snap zones, alt-tab overview, server-side decorations in the NEXUS style, a per-window **AI-access badge** showing whether NEXUS AI may read or act on that window | |
| Security | The compositor is a trust boundary: no cross-client screen capture; clipboard, screenshot and screencast only through portals with consent; session lock via `ext-session-lock` | |
| Desktop pieces | panel, launcher, notification centre, AI bar (always reachable), resource panel (cgroup-based), file explorer, settings, users, lock screen, voice indicator | |

Prerequisite: **I need the "futuristic reference" design you mentioned.** It is not present in this conversation or in my saved notes. Please re-send it (images or a description) before Shell design starts.

## 6. Migration plan (phases, tests, exit criteria)
Effort: S ≈ days, M ≈ 1–3 weeks, L ≈ 1–3 months, XL ≈ several months. The existing Tauri/React app stays as the dev console until replaced.
| Phase | Deliverable | Tests / exit criteria | Effort |
|---|---|---|---|
| **L0 Linux lab** | Debian arm64 builder VM; the repo running on Linux | `npm test` passes on Linux with Seatbelt suites skipped by platform; list of macOS-only assumptions | S |
| **L1 Isolation provider** | `IsolationProvider` refactor + `linux-bwrap` provider | The 18 adversarial sandbox tests pass on Linux, plus memory/pids limits enforced by cgroups; `selfTest()` gates `available` | M |
| **L2 Engine as services** | `nexus-engined/policyd/auditd/sandboxd` units, Unix-socket + peer-credential API, `nexusctl` | `systemd-analyze verify`; unit hardening score; policy tests with real uid/cgroup identities; audit signing with a key the engine cannot read | M |
| **L3 Image v0 (bootable VM)** | mkosi image boots in the VM, starts the services, serial login, `nexusctl status` | Automated boot test (serial-log assertions, under 30 s to `nexus.target`); the full Phase 1–3 suites run inside the booted image | M |
| **L4 Graphical session** | greetd → compositor → minimal shell (panel, launcher, notifications, AI bar), autologin in the VM | Headless-compositor protocol tests; golden-image screenshot tests of the booted VM; window-management behaviour tests | L |
| **L5 NEXUS AI in the OS** | `nexus-aid`, intents, approvals as native dialogs, agents as transient units | Real Claude task end to end inside the VM; capability-token negative tests; an agent cannot reach another agent's worktree or the network | L |
| **L6 First-party apps + voice** | Files, Settings, Terminal, resource panel, users, voice | App-sandbox tests; wake-word/STT latency and false-accept measurements; accessibility checks | XL |
| **L7 Hardening / immutability** | verity root, A/B updates, Secure Boot, TPM LUKS, signed and anchored audit | Tamper tests (a modified root fails to boot), rollback test, measured-boot attestation to the worker gateway | L |
| **L8 Installer + hardware** | `systemd-repart` installer, x86_64 image, compatibility list, update channel | Install on at least 3 physical machines; suspend/resume; Wi-Fi/GPU matrix | XL |
| **W Linux workers** (parallel from L1) | Headless `nexus-worker` image that auto-enrols | Phase 3 acceptance rerun **across a real VM boundary** (a different kernel) | M |

First big milestone = end of **L4 plus a minimal L5**: a bootable VM image that starts NEXUS Shell automatically, runs the Engine as a service and lets you use NEXUS AI.

## 7. Risks
Scale of the Shell; Apple-side VM graphics limits (no 3D in Virtualization.framework); disk space on the dev Mac; a Node-based Engine as an OS service
(mitigation: bundle with esbuild, no experimental flags, option to move hot paths to Rust later); Claude Code distribution and auth on a headless OS
(needs a device-code or API-key flow); Seatbelt-only assumptions in current tests; AI-driven desktop control is a large attack surface (hence capability tokens and portals).

## 8. Decisions I need from you
1. Approve **Debian 13 + mkosi** as the base and image builder (or choose NixOS).
2. Approve **aarch64 first (dev VM), x86_64 second**.
3. VM runner: **Virtualization.framework (no installs)** first, QEMU later — or install QEMU/Homebrew now?
4. Shell: **wlroots compositor + Qt6/QML shell first, own Smithay compositor later** — or commit to writing the compositor from the start?
5. **Re-send the futuristic design reference.**
6. Free disk space (at least 40 GB) or provide an external disk for images.
7. Confirm the AI default on a headless OS: Claude Code with the user's own login (device-code/API key), plus an optional local-model path.
