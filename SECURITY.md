# Security

NEXUS exists to make AI agents safe to run. If you find a way around it, that is the most useful thing you can
tell this project.

## Reporting a vulnerability

Please do **not** open a public issue for a way to escape the sandbox, read keys, or run something without the
person's approval. Use GitHub's private reporting instead: the **Security** tab of this repository →
**Report a vulnerability**. Say what you did, on which system (macOS or Linux version), and what you could reach.

This is a one-person project at preview stage: there is no bounty and no guaranteed response time, but every
report is read, and fixes are credited to whoever found the problem unless they prefer otherwise.

Everything else (a blocked command that should be allowed, a tool that does not start inside the sandbox) is an
ordinary issue.

## Threat model

**Who is the adversary.** An AI agent that stops doing what you asked: because a web page, a file or a
dependency fed it instructions, or because it simply made a bad decision. It runs as you, in one project folder,
and it is persistent and clever. NEXUS does not try to stop someone who already has your password, physical
access to the unlocked computer, or administrator rights.

**What must hold.**

1. The agent cannot read your keys, tokens, the rest of your home folder, other disks, the clipboard or the
   Keychain, and cannot control other apps or processes.
2. The agent cannot write outside its project folder and its own private home.
3. Nothing critical (pushing, deleting folders, publishing, deploying, database changes) happens without a click
   from you, on a dialog whose default is "Deny".
4. Your keys are reachable only by a command you approved, and only for that command.
5. Your API key never enters the sandbox.
6. The agent cannot approve its own requests: the approval channel needs a token it cannot read.
7. On macOS, the agent reaches the internet only through a list of sites.

**What does not hold, and you should know.**

- On Linux the network list is not enforced yet: a program that ignores proxy settings gets out directly.
- A site on the list can receive whatever the agent sends it. The project folder itself can leak that way.
- The agent can talk to services on your own computer (`localhost`).
- An approved command that is not `git` (for example `npm publish`) runs the project's own scripts with your keys.
- On macOS the sandbox is `sandbox-exec`, which Apple marks as deprecated.
- Files the agent writes in the project (scripts, hooks, build files) run later as you, if you run them.
- The risk rules are patterns. They catch well-known dangerous commands, not every one. The sandbox does not
  depend on them.
- The developer image of NEXUS OS ships with a known password, passwordless `sudo` and SSH enabled. It is for
  virtual machines in a lab, and the system says so on its security page.

**How it is checked.** `core/test/agent-platform.test.ts` and `core/test/standalone.test.ts` start a real sandbox
and attempt the escapes above; on macOS they are enforced by the kernel, not simulated. `nexus-agent doctor` runs
the same kind of attempts on your machine.
