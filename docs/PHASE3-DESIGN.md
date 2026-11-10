# Phase 3 — Remote workers: audit and security design

## Audit of the pre-Phase-3 architecture
- Only listener: local API on 127.0.0.1 (token + Host/Origin checks). It must never be exposed.
- Process execution: Claude CLI, Seatbelt sandbox, git — all local, argv fixed by NEXUS.
- No notion of machine or user identity; projects are absolute local paths; sandbox is macOS-only (`sandbox-exec`).
- Usage ledger/budgets only see local tasks.
- Tools available: openssl (LibreSSL 3.3.6), Node TLS. No new dependencies are needed.

## Threat model
Assets: the control host (files, Claude login, usage), other projects, worker hosts, the audit trail.
Adversaries: (1) a network attacker, (2) a rogue/compromised worker, (3) a compromised control plane towards workers,
(4) hostile code produced by an agent, (5) a stale/duplicated worker replaying results.

## Architecture
```
 NEXUS control (core)                         worker host
 ├ local API 127.0.0.1:7777  (unchanged)      ├ own data dir, own keypair (never leaves)
 └ gateway  :7778  mTLS only  <───TLS 1.3───> ├ local policy (ceilings, allowed kinds)
    registry · enrollment · dispatcher        ├ local audit chain
    heartbeat monitor · recovery              └ isolation provider (per platform) → sandbox
```
- **PKI:** NEXUS-owned CA (EC P-256, key 0600). Gateway cert signed by it (SAN = configured names). Each worker creates its own key
  and CSR; control signs it (CN = worker id). The worker pins the CA fingerprint from the enrollment bundle.
- **Enrollment:** admin creates worker → one-time token (256-bit, 15 min, stored hashed, consumed on use) inside an enrollment bundle
  (CA public cert, gateway address, worker id). Connections without a valid client cert may only send `enroll`.
- **Authorization:** the control plane accepts a job channel only if the client cert chains to the CA, its SHA-256 fingerprint
  matches an `active` registry record, and the id matches. Revocation closes the socket immediately.
- **Protocol:** newline-delimited JSON frames, ≤256 KiB each, strict type whitelist and field validation, snapshots chunked and
  SHA-256 checked, per-connection frame-rate limit, idle timeout, TLS ≥ 1.3.
- **Least information:** a job contains `{jobId, attempt, kind, projectAlias, runner|role, prompt?, limits, snapshot}`. No paths,
  credentials, budgets, other projects, user identity or worker list.
- **Separation:** workers are granted projects explicitly (`allowedProjects`) and kinds (`sandbox`, `agent`). Each job runs in its own
  scratch directory under the worker's work root, removed afterwards. Snapshots exclude `.git`, `node_modules`, `.nexus`,
  secrets (`.env*`, keys, `.ssh`), symlinks and anything over size limits. Returned files are re-validated before being applied.
- **Defence in depth:** the worker clamps limits to its local ceilings and refuses kinds its policy does not allow, regardless of what
  the server says. Path traversal, absolute paths and symlinks in bundles are rejected on both sides.
- **Isolation per platform:** `isolation.ts` returns a provider only where a mechanism is implemented. Today: macOS Seatbelt.
  Linux/Windows workers report `isolation: none` and refuse every execution job (the control plane also refuses to assign).
  Seatbelt is never "ported" implicitly.
- **Agent jobs:** optional, off by default, enabled in the worker's own policy. Claude Code is NOT sandboxed (same as local), uses
  the worker's own Claude login, has no Bash, runs in a scratch dir containing only the snapshot, with env scrubbed.
- **Liveness/recovery:** heartbeat 5 s; offline after 3 misses; its jobs become `lost`; re-queued on another eligible worker while
  `attempt < maxAttempts` (2), else failed with a reason. Results from superseded attempts are rejected; a returning worker is told
  to kill stale jobs. Never silently fall back to local when `execution: "remote"`.
- **Cancel/limits:** `cancel` frame kills the job's process group on the worker; limits (cpu, memory, wall-clock, output) enforced by
  the worker's sandbox; offline workers get the cancel on reconnect.
- **Audit:** control chain records `worker.enrolled/revoked/connected/disconnected`, `remote.job.dispatched/result/lost/requeued/cancelled`;
  workers keep their own hash chain.
- **No SSH as an execution channel.**

## Non-goals of this first version (documented limitations)
Cross-host testing (acceptance uses a separate OS process with separate home/data dir and real TLS on this machine), certificate
rotation, Windows/Linux isolation providers, worker-side Claude sandboxing, multi-tenant users (the data model carries an `owner`
field and per-project grants, but there is one human user today).

---
# Amendments (accepted before implementing the gateway)

## A1. Cryptography
- TLS **1.3 only** (`minVersion: "TLSv1.3"`) with mutual authentication, using Node's `tls` and the system `openssl` CLI
  for X.509 issuance. No custom cryptographic primitives anywhere (no home-made ciphers, MACs, KDFs or protocols).
- **Issuance:** control CA signs worker CSRs (the worker's private key never leaves the worker). Default worker cert lifetime 7 days.
- **Renewal:** the worker renews over its authenticated channel (`renew` frame with a fresh CSR, i.e. new key = key rotation) when
  less than 1/3 of the lifetime remains, or on demand. The registry switches the active fingerprint; the previous one stays valid
  only for a short grace window, then is removed.
- **Revocation:** registry status `revoked` + immediate socket close + fingerprint denylist. The gateway authorises against an
  allowlist of active fingerprints (stronger than a CRL, which a client could ignore).
- **CA rotation:** a new CA generation is created, the trust set is `[old, new]` during an overlap, new certs are signed by the new
  CA, workers receive the new CA bundle over the authenticated channel with their renewed cert; the old CA is retired when no
  worker still presents a cert from it. Gateway server cert is reissued under the active CA.

## A2. Project transfer
- Sender builds an **explicit manifest** `[{path,size,sha256}]` from an allowlist walk (no `.git`, `node_modules`, `.nexus`, hidden
  secrets files, symlinks, devices); limits: at most 1000 files (the manifest travels in a single 256 KiB frame), 2 MiB per file, 20 MiB total.
- **Secret detection** on names and contents (private-key blocks, cloud/API/token patterns, `.env`-style assignments with
  high-entropy values). A hit **blocks the dispatch**; the report names file and rule, never the secret.
- Receiver accepts only manifest files, verifies every size and hash, validates every path (relative, no `..`, no absolute, safe charset,
  no reserved names), writes with mode 0644/0755 only.
- **Everything the worker returns is untrusted data:** results are schema-validated, numbers clamped, strings length-capped and
  stripped of control characters, returned files pass the same manifest/path/size/secret checks and are never executed or interpreted
  as instructions; worker-reported costs are recorded as `workerReported` and capped by the job budget.

## A3. Recovery: unique execution ids, leases, fencing
- Each dispatch creates an **execution** with a unique `executionId` (UUID) and a globally monotonic **fencing token**.
- The worker holds a **lease** (default 15 s) renewed by heartbeats that name the executions it is running. If the lease expires the
  execution is `expired` and its fence is dead; **results (and progress) from an expired or superseded execution are rejected and
  audited**, even if no new attempt started yet.
- Applying a result to the project requires `executionId` and fence to equal the job's current ones at apply time.
- Workers ignore commands carrying a lower fence than one they have already seen for that job.
- **Retry policy by effect class:** `none` (sandbox test runs: confined, no network, no persistent output) may be retried
  automatically (max 2 attempts). `unknown`/`external` (agent jobs, anything that can touch the outside world, future deploys) are
  **never retried automatically**: a lost one is failed with `needs-manual-decision`.

## A4. Audit
- The hash chain detects accidental corruption and naive edits but is **not by itself a tamper-proof log**: an attacker with write
  access can recompute the whole chain, truncate it, or roll it back. Real immutability needs external anchoring.
- Architecture prepared for **signed records**: `Audit` accepts a pluggable `AuditSigner` (signature over each record hash,
  `keyId` recorded); a file-based Ed25519 signer (Node `crypto`) is provided. Production should keep the key off the audited host
  (HSM / remote signer) and periodically anchor the head hash externally (append-only store, transparency log).

## A5. Network exposure
- The gateway binds to **127.0.0.1 by default**. Any non-loopback bind requires an explicit opt-in; wildcard binds and public
  (non-private) addresses need additional, separate opt-ins; the startup log states the exposure. The local API is never on this port.

## Milestones
1. Two independent processes on this Mac authenticate over TLS 1.3 mTLS (enroll, hello, heartbeat). Demonstrate, including rejection of
   unauthenticated, wrong-CA, revoked and expired credentials.
2. Real job execution on a separate worker with isolation, limits, cancellation, revocation and recovery after disconnect.
