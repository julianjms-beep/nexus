// Adversarial tests: hostile Python "tests" run inside the platform's REAL isolation provider (no mocks):
// Seatbelt on macOS, bubblewrap + cgroup v2 on Linux (run under a delegated cgroup: `npm run test:linux`).
// Each attack prints ESCAPED if it succeeded; we also verify host-side effects independently.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Audit } from "../src/audit.ts";
import { Security } from "../src/security.ts";
import { Sandbox, Sandbox as SB } from "../src/sandbox.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-sbx-t-")));
function setup(limits = {}) {
  const base = tmp(); const work = path.join(base, "work"); fs.mkdirSync(work);
  const data = path.join(base, "data"); fs.mkdirSync(data);
  const audit = new Audit(path.join(data, "audit.jsonl")); const sec = new Security(audit);
  sec.allowRoot(work);
  const sb = new Sandbox(data, audit, sec, { cpuSeconds: 20, memoryMb: 512, timeoutMs: 20_000, maxProcesses: 64, maxOutputBytes: 200_000, maxFileMb: 32, ...limits });
  const canary = path.join(base, "canary.txt"); fs.writeFileSync(canary, "TOP-SECRET-CANARY");
  const attack = (body: string) => fs.writeFileSync(path.join(work, "test_attack.py"), `import unittest, os, sys, subprocess, socket\nclass T(unittest.TestCase):\n    def test_attack(self):\n${body.split("\n").map((l) => "        " + l).join("\n")}\n`);
  const run = (over = {}) => sb.run(work, "python-unittest", over).done;
  return { base, work, data, audit, sec, sb, canary, attack, run };
}
const all = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

const LINUX = process.platform === "linux";
test("an isolation provider is available on this machine", () => {
  assert.ok(SB.available(), "no isolation provider (macOS: sandbox-exec; Linux: bwrap + delegated cgroup)");
});

test("the adversarial self-test passes and gates availability", async () => {
  const { sb, audit } = setup();
  const iso = await sb.selfTest();
  assert.equal(iso.available, true, iso.reason); assert.equal(iso.mechanism, LINUX ? "linux-bwrap" : "seatbelt");
  assert.ok(audit.read().some((e) => e.type === "sandbox.selftest" && e.data.available === true));
});

test("benign tests run, pass, are parsed, persisted and audited", async () => {
  const { work, run, sb, audit } = setup();
  fs.writeFileSync(path.join(work, "test_ok.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(2+2,4)\n    def test_b(self): open('made.txt','w').write('x')\n");
  const r = await run();
  assert.equal(r.ok, true, all(r)); assert.equal(r.summary.tests, 2);
  assert.ok(fs.existsSync(path.join(work, "made.txt")), "may write inside workdir");
  assert.equal(sb.getResult(r.id)?.ok, true);
  assert.ok(audit.read().some((e) => e.type === "sandbox.run") && audit.verify().ok);
});

test("failing tests are reported with structured names", async () => {
  const { work, run } = setup();
  fs.writeFileSync(path.join(work, "test_bad.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_a(self): self.assertEqual(1,2)\n");
  const r = await run();
  assert.equal(r.ok, false); assert.equal(r.summary.failures, 1);
  assert.ok(r.summary.failed[0].includes("test_a"));
});

test("cannot read files outside the workdir", async () => {
  const { attack, run, canary } = setup();
  attack(`print(open(${JSON.stringify(canary)}).read()); print("ESC"+"APED")`);
  const r = await run(); assert.ok(!all(r).includes("TOP-SECRET-CANARY") && !all(r).includes("ESCAPED")); assert.equal(r.ok, false);
});

test("cannot write outside the workdir", async () => {
  const { attack, run, base } = setup();
  const evil = path.join(base, "evil.txt");
  attack(`open(${JSON.stringify(evil)},'w').write('x'); print("ESC"+"APED")`);
  await run(); assert.equal(fs.existsSync(evil), false);
});

test("cannot read host credentials in the real home directory", async () => {
  const { attack, run } = setup();
  const home = os.homedir();
  attack(`for d in [${JSON.stringify(home + "/.ssh")}, ${JSON.stringify(home + "/.claude")}, ${JSON.stringify(home + "/Library/Keychains")}, ${JSON.stringify(home)}]:\n    try:\n        print("ESC"+"APED", d, os.listdir(d)[:3])\n    except Exception as e:\n        print("blocked", type(e).__name__)`);
  const r = await run(); assert.ok(!all(r).includes("ESCAPED"), all(r)); assert.ok(all(r).includes("blocked"));
});

test("environment is scrubbed: no host secrets, HOME is private", async () => {
  process.env.AWS_SECRET_ACCESS_KEY = "leak-me"; process.env.ANTHROPIC_API_KEY = "leak-me-too";
  const { attack, run } = setup();
  attack(`print("ENV", sorted(os.environ)); print("HOME", os.environ.get("HOME"))`);
  const r = await run(); const o = all(r);
  assert.ok(!o.includes("AWS_SECRET") && !o.includes("ANTHROPIC") && !o.includes("leak-me"));
  assert.ok(!o.includes(`HOME ${os.homedir()}`));
});

test("no network: connections to a local server are impossible", async () => {
  const { attack, run } = setup();
  let hits = 0; const srv = http.createServer((_q, s) => { hits++; s.end("hi"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const port = (srv.address() as any).port;
  attack(`s = socket.create_connection(("127.0.0.1", ${port}), 3); s.send(b"GET / HTTP/1.0\\r\\n\\r\\n"); print("ESC"+"APED")`);
  const r = await run(); srv.close();
  assert.equal(hits, 0); assert.ok(!all(r).includes("ESCAPED")); assert.equal(r.ok, false);
});

test("symlink inside the workdir pointing outside cannot be followed", async () => {
  const { attack, run, work, canary } = setup();
  fs.symlinkSync(canary, path.join(work, "link.txt"));
  attack(`print(open("link.txt").read()); print("ESC"+"APED")`);
  const r = await run(); assert.ok(!all(r).includes("TOP-SECRET-CANARY"));
});

test("dangerous system binaries are neutralised", async () => {
  const { attack, run, base } = setup();
  const marker = path.join(base, "escape-ran.txt");
  const cmds = LINUX
    ? [["/usr/bin/sudo", "-n", "touch", marker], ["/usr/bin/su", "-c", `touch ${marker}`], ["/usr/bin/systemctl", "poweroff"], ["/usr/bin/curl", "-sS", "-m", "3", "http://example.com"], ["/usr/bin/unshare", "-U", "true"]]
    : [["/usr/bin/osascript", "-e", `do shell script "touch ${marker}"`], ["/usr/bin/security", "find-generic-password", "-s", "x"], ["/usr/bin/open", "-a", "Calculator"], ["/usr/bin/curl", "-sS", "-m", "3", "http://example.com"]];
  attack(`cmds = ${JSON.stringify(cmds)}\nfor c in cmds:\n    try:\n        r = subprocess.run(c, capture_output=True, text=True, timeout=20)\n        print("RC", c[0], r.returncode)\n        if r.returncode == 0: print("ESC"+"APED", c[0])\n    except Exception as e:\n        print("blocked", c[0], type(e).__name__)`);
  const r = await run(); assert.ok(!all(r).includes("ESCAPED"), all(r)); assert.equal(fs.existsSync(marker), false);
});

test("wall-clock timeout kills the run and leaves no orphan processes", async () => {
  const { attack, run } = setup();
  attack(`subprocess.Popen(["/bin/sleep","31337"])\nwhile True: pass`);
  const r = await run({ timeoutMs: 1500 });
  assert.equal(r.timedOut, true); assert.equal(r.ok, false);
  await new Promise((x) => setTimeout(x, 300));
  assert.notEqual(spawnSync("/usr/bin/pgrep", ["-f", "sleep 31337"]).status, 0, "orphan sleep still alive");
});

test("memory limit kills a memory hog", async () => {
  const { attack, run } = setup();
  attack(`import time\nkeep = []\nfor i in range(40):\n    keep.append(b"a" * (25 * 1024 * 1024)); time.sleep(0.05)\nprint("ESC"+"APED", len(keep))`);
  const r = await run({ memoryMb: 150 }); assert.match(r.killedBy ?? "", /memory limit/); assert.ok(!all(r).includes("ESCAPED"));
});

test("CPU limit kills a busy loop", async () => {
  const { attack, run } = setup();
  attack(`while True: pass`);
  const r = await run({ cpuSeconds: 1, timeoutMs: 15000 }); assert.equal(r.ok, false); assert.equal(r.timedOut, false); assert.match(r.killedBy ?? "", /cpu limit/);
});

test("process-count limit stops a fork bomb", async () => {
  const { attack, run } = setup();
  attack(`for _ in range(400): subprocess.Popen(["/bin/sleep","31338"])\nimport time; time.sleep(5)`);
  const r = await run({ maxProcesses: 20, timeoutMs: 15000 }); assert.match(r.killedBy ?? "", /process limit/);
  await new Promise((x) => setTimeout(x, 300));
  assert.notEqual(spawnSync("/usr/bin/pgrep", ["-f", "sleep 31338"]).status, 0);
});

test("output is capped", async () => {
  const { attack, run } = setup({ maxOutputBytes: 50_000 });
  attack(`sys.stdout.write("A" * 5_000_000)`);
  const r = await run(); assert.equal(r.outputTruncated, true); assert.ok(r.stdout.length <= 50_000);
});

test("file size limit stops disk filling", async () => {
  const { attack, run, work } = setup();
  attack(`open("big.bin","wb").write(b"0" * (20 * 1024 * 1024)); print("ESC"+"APED")`);
  const r = await run({ maxFileMb: 1 }); assert.ok(!all(r).includes("ESCAPED")); assert.ok(!fs.existsSync(path.join(work, "big.bin")) || fs.statSync(path.join(work, "big.bin")).size <= 1024 * 1024);
});

test("cancellation stops a running sandbox", async () => {
  const { attack, sb, work } = setup();
  attack(`while True: pass`);
  const h = sb.run(work, "python-unittest"); setTimeout(() => h.cancel(), 500);
  const r = await h.done; assert.equal(r.cancelled, true); assert.equal(r.ok, false);
});

test("unauthorized workdir, unknown runner are refused and never spawn", async () => {
  const { base, sb, audit } = setup();
  const other = path.join(base, "other"); fs.mkdirSync(other);
  assert.equal((await sb.run(other, "python-unittest").done).ok, false);
  assert.match((await sb.run(other, "python-unittest").done).stderr, /not authorized/);
  assert.match((await sb.run(path.join(base, "work"), "bash -c 'id'").done).stderr, /unknown runner/);
  assert.ok(!audit.read().some((e) => e.type === "sandbox.started"));
});

// ------------------------------------------------------------------ Linux-only: properties the bubblewrap + cgroup provider adds
test("linux: the job sees only its own processes, not the host's", { skip: !LINUX }, async () => {
  const { attack, run } = setup();
  attack(`pids = [p for p in os.listdir("/proc") if p.isdigit()]\nprint("PIDS", len(pids))\nif len(pids) > 8: print("ESC"+"APED", len(pids))`);
  const r = await run(); assert.ok(!all(r).includes("ESCAPED"), all(r)); assert.match(all(r), /PIDS \d/);
});

test("linux: no capabilities, no new privileges, nested namespaces refused", { skip: !LINUX }, async () => {
  const { attack, run } = setup();
  attack(`st = open("/proc/self/status").read()\nprint([l for l in st.splitlines() if l.startswith(("CapEff","NoNewPrivs"))])\nassert "CapEff:\\t0000000000000000" in st\nassert "NoNewPrivs:\\t1" in st\ntry:\n    os.unshare(os.CLONE_NEWUSER); print("ESC"+"APED")\nexcept OSError as e: print("blocked", e.errno)`);
  const r = await run(); assert.ok(!all(r).includes("ESCAPED"), all(r)); assert.equal(r.ok, true, all(r));
});

test("linux: memory is enforced by the kernel (cgroup), not by polling", { skip: !LINUX }, async () => {
  const { attack, run } = setup();
  attack(`x = bytearray(400 * 1024 * 1024)\nprint("ESC"+"APED")`); // a single allocation: a 50 ms poll could miss it, the kernel cannot
  const r = await run({ memoryMb: 100 }); assert.match(r.killedBy ?? "", /memory limit/); assert.ok(!all(r).includes("ESCAPED"));
});

test("linux: job cgroups are removed after each run", { skip: !LINUX }, async () => {
  const { work, run } = setup();
  fs.writeFileSync(path.join(work, "test_ok.py"), "import unittest\nclass T(unittest.TestCase):\n    def test_a(self): pass\n");
  const { cgroupRoot } = await import("../src/iso-linux.ts");
  const root = cgroupRoot().root!; const jobs = () => fs.readdirSync(root).filter((d) => d.startsWith("nexus-job-")).length;
  const before = jobs(); const r = await run(); assert.equal(r.ok, true, all(r));
  assert.equal(jobs(), before);
});
