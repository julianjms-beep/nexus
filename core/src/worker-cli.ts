// Worker process entry point.
//   node worker-cli.ts enroll --bundle <file> --dir <dir> [--allow-agent-jobs]
//   node worker-cli.ts run --dir <dir> [--reconnect-ms N] [--simulate-platform P]
// Prints one JSON object per line (events) so supervisors/tests can follow it. Never prints keys or tokens.
import fs from "node:fs";
import { WorkerNode } from "./worker.ts";

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n: string) => args.includes(`--${n}`);
const out = (o: object) => console.log(JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...o }));

const dir = opt("dir");
if (!dir) { console.error("--dir required"); process.exit(2); }

if (cmd === "enroll") {
  const bundleFile = opt("bundle"); if (!bundleFile) { console.error("--bundle required"); process.exit(2); }
  const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
  const policy: any = {}; if (flag("allow-agent-jobs")) { policy.allowAgentJobs = true; policy.allowKinds = ["sandbox", "agent"]; }
  try { await WorkerNode.enroll(bundle, dir, policy); out({ event: "enrolled", workerId: bundle.workerId }); process.exit(0); }
  catch (e: any) { out({ event: "enroll-failed", error: e.message }); process.exit(1); }
} else if (cmd === "run") {
  const w = new WorkerNode(dir, { reconnectMs: Number(opt("reconnect-ms") ?? 1000), renewCheckMs: Number(opt("renew-check-ms") ?? 60_000), simulatePlatform: opt("simulate-platform"), claudeBin: opt("claude-bin") });
  for (const ev of ["connected", "disconnected", "revoked", "renewed"]) w.on(ev, () => out({ event: ev }));
  w.on("error-log", (m: string) => out({ event: "log", message: m }));
  w.start(); out({ event: "started", isolation: w.isolation.mechanism, platform: opt("simulate-platform") ?? process.platform });
  const bye = () => w.stop().then(() => process.exit(0)); process.on("SIGTERM", bye); process.on("SIGINT", bye);
  process.stdin.on("data", (d) => { if (String(d).trim() === "renew") w.renewNow(); });
} else { console.error("usage: worker-cli.ts enroll|run --dir <dir> ..."); process.exit(2); }
