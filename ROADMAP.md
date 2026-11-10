# Roadmap

Where NEXUS OS stands, measured against what a general-purpose operating system needs. Nothing here counts as done
because a document says so: every "done" names the code and the test that show it.

**Done** = implemented, with tests or a recorded real-world check. **Partial** = works, with a stated gap.
**Missing** = not started. **Inherited** = provided by the Linux kernel and Debian, which NEXUS is built on;
NEXUS's job there is to configure, test and not break it.

## The goal

The operating system where letting an AI agent work on your computer is safe by design. The way there: win one
group first (developers running coding agents, through [`nexus-agent`](cli/README.md)), then run on real hardware,
then widen.

## Next, in order

| # | What | Why now |
|---|---|---|
| 1 | Network filter enforced on Linux (today only macOS) | The largest known hole in the agent sandbox on NEXUS OS itself. |
| 2 | Installer for real hardware, with full-disk encryption | Today NEXUS OS only runs in virtual machines. Nobody adopts a system they cannot install. |
| 3 | A release image: no default password, no passwordless sudo, no lab SSH key | The developer image is weak on purpose; a release must not be. |
| 4 | Recovery mode and Secure Boot | Booting safely and getting back from a bad state come before features. |
| 5 | First tested laptops and a hardware list | "Works in a VM" is not "works". |
| 6 | Linux applications through Flatpak | The Store has web apps only. |
| 7 | English interface, then other languages; accessibility | The interface is Spanish only. |
| 8 | Backups and restore | No way to get your data back today. |
| 9 | An independent security review | NEXUS promises security; someone who did not write it has to try to break it. |

## Status by area

| Area | Status | Evidence, or what is missing |
|---|---|---|
| Kernel, system calls, scheduler, memory, IPC | Inherited | Linux (Debian 13). Hardening on top: `os/mkosi.extra/usr/lib/sysctl.d/70-nexus-hardening.conf`. |
| File system, permissions, journaling | Inherited | ext4. **Missing:** disk encryption, snapshots, backups. |
| Drivers (Wi-Fi, Bluetooth, sound, power) | Partial | Controlled from the desktop (`core/src/devices.ts`, `core/test/devices.test.ts`), checked on simulated radios. **Missing:** any real hardware. |
| Boot | Partial | UEFI, systemd-boot, unified kernel image (`os/mkosi.conf`). **Missing:** Secure Boot, recovery mode, installer, dual boot. |
| Desktop | Done | Own shell and apps in `os/mkosi.extra/usr/share/nexus/`. **Missing:** accessibility, languages other than Spanish, virtual desktops, screen recording. |
| Applications | Partial | Files, Notes, Browser, Mail, Store (web apps), Automations, Connections, Monitor, Settings; VS Code. **Missing:** native Linux apps (Flatpak), office suite, calendar, SDK. Mail has not been verified with a real account. |
| Network | Partial | Firewall up before the network (`os/mkosi.extra/usr/lib/nexus/nexus-firewall`), DNS over TLS when offered, LLMNR/mDNS off. **Missing:** VPN, file sharing, printing. |
| Security of the system | Partial | Guard daemon with six fixed operations (`core/src/guard.ts`, `core/test/guard.test.ts`), automatic lock, kernel hardening, a settings page that scores and fixes. **Missing:** Secure Boot, disk encryption, MAC policy (AppArmor), outside audit. |
| Security of agents | Partial | Sandbox per agent, risk rules, human approval, keys only for approved commands, safe git, budgets (`core/src/agentd.ts`, `core/src/agent-platform.ts`, `core/test/agentd.test.ts`, `core/test/agent-platform.test.ts`, `core/test/standalone.test.ts`: escape attempts enforced for real on macOS). **Gaps:** network filter not enforced on Linux; relies on `sandbox-exec` on macOS; approved non-git commands run the project's own scripts. |
| Updates | Done | Signed (ed25519), delta bundles, health check, automatic rollback (`core/src/update.ts`, `core/test/update.test.ts`). **Missing:** release channels, LTS policy, firmware updates. |
| First-run experience | Partial | First-boot assistant for release images (`core/src/setup.ts`). **Missing:** installer, data migration, sync, backups, help. |
| AI | Partial | Assistant, agents, agencies, automations, MCP server, cost and token limits, model routing. **Missing:** local models, drift detection. Works without AI or internet: yes. |
| Development | Done | git, compilers, Node, Python, terminal, VS Code in the image. **Missing:** containers, SDK. |
| Quality | Partial | 357 automated tests, run on every change on macOS 15 (all of them, with the real sandbox) and on Linux (all but the five suites that need a NEXUS lab machine) (`.github/workflows/test.yml`). Known: the job stalls on macOS 14, not yet investigated. **Missing:** real-hardware tests, fuzzing, long-run stability, performance benchmarks. |
| Project | Partial | Public repository, this roadmap, [SECURITY.md](SECURITY.md). **Missing:** license, contribution guide, outside contributors. |

## What NEXUS will not build

Its own kernel, file system or driver model. Linux does those well, and rebuilding them would spend years
without making agents any safer.
