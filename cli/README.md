# nexus-agent

Run an AI coding agent — Claude Code, or any program — **isolated in one project**, on Linux or macOS.

```sh
cd ~/projects/web
nexus-agent -- claude
```

The agent gets the project folder, a private home of its own and your tools. It does **not** get your SSH keys,
your tokens, the rest of your home folder, other disks, the clipboard, the Keychain or other apps. Whatever needs
your keys or is critical (`git push`, `rm -r`, `DROP TABLE`, a deploy…) it has to ask NEXUS for, and NEXUS asks
**you** — with a dialog whose default button is "Deny".

It is the agent engine of [NEXUS OS](../README.md), running on its own: no desktop, no daemon, nothing
installed system-wide. One process, alive only while the agent runs.

## Try it in one minute

```sh
nexus-agent doctor
```

`doctor` starts a real sandbox on your computer and tries what a hostile agent would try — list your home, read
your SSH keys, write to your shell's start-up files, control other apps — and shows each attempt being blocked.

```sh
nexus-agent            # a shell inside the sandbox: look around, see what the agent sees
```

## What happens when the agent wants something critical

Inside the sandbox the agent has no keys, so `git push` simply cannot work there. NEXUS is connected to the agent
as an MCP server; its `run_command` tool is the only way out, and every command that goes through it is classified
first:

| | Examples | What NEXUS does |
|---|---|---|
| **Blocked** | `rm -rf ~`, `sudo …`, `mkfs`, `dd of=/dev/…`, shutdown | Never runs. |
| **Ask** | `git push`, `git reset --hard`, `rm -r`, `DROP TABLE`, `npm publish`, `terraform apply`, `curl … \| sh` | Waits for your answer (5 minutes; no answer = no). |
| **Everything else** | `npm test`, `cargo build`, `git status` | Runs, isolated: only the project is writable, and **without your keys**. |

Your SSH keys are reachable only by a command **you approved**, and only for that command.

No desktop (a server, SSH)? Run `nexus-agent approvals` in another terminal and answer there.

## The network

The agent's traffic goes through a small proxy that `nexus-agent` runs outside the sandbox, and the sandbox closes
every other way out (no direct connections, no DNS lookups). The proxy lets through only a short list: the model's
API, the package registries (npm, PyPI, crates.io, Go) and GitHub for reading. Anything else is refused and listed
when the run ends:

```
◆ NEXUS blocked connections to: example.com (1). To allow a site: --allow-host NAME
```

`--allow-host api.example.com` adds a site (`.example.com` = it and everything under it); `--open-network` turns
the filter off. Addresses and `localhost` are never a destination for the proxy: it is no way into your computer.
A command you approved (a `git push`) keeps the direct network: you saw it and said yes.

## Options

```
nexus-agent [options] -- <program> [arguments]

--folder DIR     the project (default: the current folder; it must be inside your home)
--read DIR       another folder the agent may read (repeatable)
--goal TEXT      what this run is for (shown in the log)
--allow-host H   let the agent reach one more site (repeatable)
--open-network   do not filter the agent's network
--max-usd N      spending cap in US$ (needs ANTHROPIC_API_KEY; default 5)
--check CMD      the project's check, run after the agent's changes (default: detected from the project)
```

With `ANTHROPIC_API_KEY` set, the key **stays outside the sandbox**: the agent gets a placeholder, and NEXUS adds
the real key on the way out while counting tokens and dollars against the cap. With a Claude subscription instead
of a key, log in once inside the sandbox (`/login`); that login lives in the agent's private home.

## How the isolation works

- **Linux** — [bubblewrap](https://github.com/containers/bubblewrap): the system is read-only, a private home
  stands where yours was, `/tmp` is empty, your session's sockets (D-Bus, SSH agent) are gone, and the agent has
  its own process namespace. The folders where developers keep tools inside the home (nvm, cargo, pyenv…) come
  back read-only.
- **macOS** — the kernel sandbox (Seatbelt, `sandbox-exec`) with a profile that denies writing everywhere but the
  project and the agent's home; hides `/Users`, `/Volumes` and the shared temp folders; allows by name only the
  system services a command-line tool needs (so no clipboard, Keychain, LaunchServices or window server); and
  denies Apple Events, signals to other processes and other programs' local sockets.

State lives in `~/.nexus-agent` (mode 0700), which the sandbox cannot read.

## Limits you should know

This narrows what an agent can damage or take. It is not a virtual machine, and it has not had an independent
security review yet.

- **The network filter is a list, not an inspector.** On macOS the agent can only reach the sites on the list (see
  "The network" above), and no longer an arbitrary one. But a site that IS on the list can receive whatever the
  agent sends it, and the agent can still reach services on this computer itself (`localhost`). **On Linux the
  filter is not enforced yet**: programs are pointed at it, but one that ignores the proxy settings gets out.
  Do not point an agent at a folder with secrets in it.
- **An approved command is trusted with your keys.** For `git`, NEXUS switches off what the repository would run
  on its own (hooks, `core.sshCommand`, `core.fsmonitor`…) and shows you, before you approve, anything it cannot
  switch off (a credential helper, a rewritten URL, filters). Other tools are not covered: an approved
  `npm publish` still runs the project's own scripts. Read what you approve.
- **macOS** relies on `sandbox-exec`, which Apple marks as deprecated (it still ships and is what other tools use).
  `/tmp` is not available to the agent there; it gets its own `$TMPDIR`.
- **Linux** needs bubblewrap and unprivileged user namespaces (`nexus-agent doctor` tells you). On an X11 desktop
  the X server's socket is not hidden by the network namespace; the agent has no X authority cookie, which is what
  keeps it out.
- The risk rules are patterns, not a model: they catch the well-known dangerous commands, not every possible one.
  That is why the sandbox does not depend on them.
- Some log texts are still in Spanish (the project started there).

## Build from source

```sh
git clone https://github.com/julianjms-beep/nexus && cd nexus
npm install
npx esbuild cli/nexus-agent.ts --bundle --platform=node --format=esm --target=node20 --outfile=cli/dist/nexus-agent.mjs
npm install -g ./cli        # or: node cli/dist/nexus-agent.mjs doctor
npm test                    # includes the sandbox escaping tests, enforced for real on macOS
```

Node 20 or newer. No dependencies at run time: the bundle is one file.
