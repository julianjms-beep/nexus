// Local control API. Binds to 127.0.0.1 only, requires a bearer token (file mode 0600),
// rejects foreign Host/Origin headers (DNS-rebinding / CSRF), and exposes no shell endpoint.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Audit } from "./audit.ts";
import { Security } from "./security.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ClaudeCodeAdapter } from "./adapter.ts";
import { WorkflowEngine } from "./workflow.ts";
import { Sandbox } from "./sandbox.ts";
import { Worktrees } from "./worktree.ts";
import { UsageLedger } from "./usage.ts";
import { Gateway, type GatewayOptions } from "./gateway.ts";
import { RemoteExecutor, type ExecutorOptions } from "./remote.ts";
import { resolveReal } from "./security.ts";
import { ShellBus, NexusAI, systemStatus, APPS, type ClientFactory } from "./os.ts";
import { Connect, ConnectError, type ConnectOptions } from "./connect.ts";
import { CustomConnections, fromDraft } from "./connect-custom.ts";

export function createApp(dataDir: string, adapters = { "claude-code": new ClaudeCodeAdapter() } as Record<string, any>, extra: { gateway?: GatewayOptions; remote?: ExecutorOptions; aiClient?: ClientFactory; connect?: ConnectOptions } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tokenFile = path.join(dataDir, "token");
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const audit = new Audit(path.join(dataDir, "audit.jsonl"));
  const security = new Security(audit);
  const usage = new UsageLedger(dataDir, audit);
  const orch = new Orchestrator(dataDir, audit, security, adapters, undefined, undefined, usage);
  const sandbox = new Sandbox(dataDir, audit, security);
  const worktrees = new Worktrees(dataDir, audit, security);
  // Remote workers are OFF unless explicitly enabled. The gateway is a separate listener, never this API.
  const gateway = extra.gateway ? new Gateway(path.join(dataDir, "gateway"), audit, extra.gateway) : undefined;
  const remote = gateway ? new RemoteExecutor(gateway, audit, dataDir, extra.remote) : undefined;
  const wf = new WorkflowEngine(dataDir, orch, security, audit, sandbox, worktrees, remote);
  // NEXUS OS desktop integration (shell event bus + NEXUS AI). See os.ts for the trust model.
  const bus = new ShellBus(audit);
  const ai = new NexusAI(dataDir, audit, bus, extra.aiClient);
  // NEXUS Connect (connect.ts): outside services through their official APIs; their keys stay in this process
  const connect = new Connect(dataDir, audit, { custom: new CustomConnections(dataDir), ...extra.connect });
  const aliasOf = (projectPath: string) => { const real = resolveReal(projectPath); if (!orch.listProjects().some((p) => p.path === real)) throw new Error("project is not registered"); return gateway!.registry.alias(real); };

  const authed = (req: http.IncomingMessage, url: URL) => {
    const given = (req.headers.authorization ?? "").replace(/^Bearer /, "") || url.searchParams.get("token") || "";
    const a = Buffer.from(given), b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const body = (req: http.IncomingMessage) => new Promise<any>((res, rej) => {
    let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e6) rej(new Error("too large")); });
    req.on("end", () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
  });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    try {
      const host = (req.headers.host ?? "").split(":")[0];
      if (host !== "127.0.0.1" && host !== "localhost") return send(403, { error: "bad host" });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(403, { error: "bad origin" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;

      if (!p.startsWith("/api/")) return serveStatic(res, p);
      if (!authed(req, url)) return send(401, { error: "unauthorized" });

      if (req.method === "GET" && p === "/api/state") {
        return send(200, { agents: orch.agents(), projects: orch.listProjects(), tasks: orch.listTasks(),
          approvals: security.pendingApprovals(), runs: wf.listRuns(), workers: gateway?.listWorkers() ?? [], gatewayInfo: gateway ? { enabled: true, address: gateway.address ?? null } : { enabled: false }, remoteJobs: remote?.listJobs(15) ?? [], usage: usage.summary(), sandbox: { available: sandbox.isolation().available, isolation: sandbox.isolation(), runners: sandbox.runners() }, roles: orch.registry.list().map(({ id, title, tools, writes }) => ({ id, title, tools, writes })), audit: audit.read().slice(-100), auditIntegrity: audit.verify() });
      }
      // ---- NEXUS OS: desktop shell + NEXUS AI
      if (req.method === "GET" && p === "/api/system") return send(200, { ...systemStatus(), engine: { isolation: sandbox.isolation(), ai: ai.settings(), shellHead: bus.head } });
      if (req.method === "GET" && p === "/api/apps") return send(200, APPS);
      if (req.method === "GET" && p === "/api/shell/events") {
        const since = Number(url.searchParams.get("since") ?? 0), wait = Math.min(Number(url.searchParams.get("wait") ?? 25_000), 25_000);
        return send(200, await bus.poll(Number.isFinite(since) ? since : 0, Number.isFinite(wait) ? Math.max(0, wait) : 0));
      }
      if (req.method === "POST" && p === "/api/shell/confirm") { const b = await body(req); return send(200, bus.decide(String(b.id), b.approve === true)); }
      if (req.method === "POST" && p === "/api/shell/launch") {
        const b = await body(req); const app = String(b.app);
        if (!Object.hasOwn(APPS, app)) return send(400, { error: `unknown app; catalog: ${Object.keys(APPS).join(", ")}` });
        return send(200, bus.push("launch", { app, by: "api" }));
      }
      if (req.method === "POST" && p === "/api/shell/theme") {
        const b = await body(req); if (b.mode !== "dark" && b.mode !== "light") return send(400, { error: "mode must be dark or light" });
        return send(200, bus.push("theme", { mode: b.mode, by: "api" }));
      }
      if (req.method === "POST" && p === "/api/ai/ask") { const b = await body(req); return send(200, await ai.ask(String(b.text ?? ""), b.history, b.context)); }
      if (req.method === "POST" && p === "/api/ai/review") { const b = await body(req); return send(200, await ai.review(String(b.diff ?? ""), String(b.role ?? ""))); }
      // NEXUS Search (the browser's own search page, via nexus-sessiond): web results + a short answer with sources
      if (req.method === "POST" && p === "/api/ai/search") { const b = await body(req); return send(200, await ai.webSearch(String(b.q ?? ""))); }
      // the Automatizaciones box: a description in the person's words → a draft of the form (custom connections included)
      if (req.method === "POST" && p === "/api/ai/draft-automation") {
        const b = await body(req); const v = connect.view().connectors;
        return send(200, await ai.draftAutomation(String(b.text ?? ""), connect.catalog, v.filter((c) => c.connected).map((c) => c.id),
          Array.isArray(b.folders) ? b.folders.map((x: unknown) => String(x).slice(0, 120)).slice(0, 80) : []));
      }
      if (req.method === "GET" && p === "/api/ai/settings") return send(200, ai.settings());
      // Agents' Claude traffic (via nexus-sessiond's /llm proxy): the person's key is added here, never handed out
      const fwd = /^\/api\/ai\/anthropic(\/v1\/(?:messages(?:\/count_tokens)?|models))$/.exec(p);
      if (fwd && (req.method === "POST" || req.method === "GET")) {
        const chunks: Buffer[] = []; let size = 0;
        for await (const ch of req) { size += (ch as Buffer).length; if (size > 32 << 20) return send(413, { type: "error", error: { type: "request_too_large", message: "too large" } }); chunks.push(ch as Buffer); }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        let up: Response;
        try { up = await ai.forward(fwd[1] + url.search, req.method, headers, req.method === "GET" ? undefined : Buffer.concat(chunks)); }
        catch { return send(502, { type: "error", error: { type: "api_error", message: "NEXUS could not reach api.anthropic.com" } }); }
        const out: Record<string, string> = {};
        up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
        res.writeHead(up.status, out);
        if (up.body) for await (const ch of up.body as any) res.write(ch);
        return res.end();
      }
      if (req.method === "POST" && p === "/api/ai/key") { const b = await body(req); return send(200, ai.setKey(String(b.key ?? ""))); }
      // ---- NEXUS Connect: GET the catalog (never a key), connect / disconnect / test, run an operation, poll a trigger
      if (p === "/api/connect" || p.startsWith("/api/connect/")) {
        try {
          if (req.method === "GET" && p === "/api/connect") return send(200, connect.view());
          const cm = /^\/api\/connect\/([a-z0-9-]{1,30})(?:\/(test|run|poll))?$/.exec(p);
          if (!cm) return send(404, { error: "not found" });
          const [, id, verb] = cm;
          if (!verb && req.method === "POST") { const b = await body(req); return send(200, await connect.connect(id, b.values)); }
          if (!verb && req.method === "DELETE") return send(200, connect.disconnect(id));
          if (verb === "test" && req.method === "POST") return send(200, await connect.test(id));
          // `origin` is said by nexus-sessiond: "automation" only for a rule the person created; anything else is an app
          if (verb === "run" && req.method === "POST") { const b = await body(req); return send(200, await connect.run(id, String(b.op ?? ""), b.input, b.event && typeof b.event === "object" ? b.event : undefined, b.origin === "automation" ? "automation" : "app")); }
          if (verb === "poll" && req.method === "POST") { const b = await body(req); return send(200, await connect.poll(id, String(b.trigger ?? ""), b.input, b.state)); }
          return send(404, { error: "not found" });
        } catch (e: any) {
          if (e instanceof ConnectError) return send(e.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e.message, status: e.status ?? null });
          throw e;
        }
      }
      // ---- the person's own connections: save / read / remove a description; NEXUS AI drafts one (never saved by itself)
      if (p === "/api/connect-custom" || p.startsWith("/api/connect-custom/")) {
        try {
          if (req.method === "POST" && p === "/api/connect-custom") { const b = await body(req); return send(200, await connect.saveCustom(b.spec)); }
          if (req.method === "POST" && p === "/api/connect-custom/draft") {
            const b = await body(req);
            const d = await ai.draftConnector(String(b.service ?? ""), String(b.notes ?? ""));
            if (!d.draft) return send(200, { spec: null, problem: null, usd: d.usd, error: d.error ?? "no_draft" });
            const spec = fromDraft(d.draft);
            return send(200, { spec, problem: await connect.checkDraft(spec), usd: d.usd, model: d.model, searches: d.searches });
          }
          const cm = /^\/api\/connect-custom\/(x-[a-z0-9-]{1,30})$/.exec(p);
          if (cm && req.method === "GET") return send(200, { spec: connect.customSpec(cm[1]) });
          if (cm && req.method === "DELETE") return send(200, connect.removeCustom(cm[1]));
          return send(404, { error: "not found" });
        } catch (e: any) {
          if (e instanceof ConnectError) return send(e.status && e.status >= 400 && e.status < 500 ? e.status : 502, { error: e.message, status: e.status ?? null });
          throw e;
        }
      }
      if (req.method === "DELETE" && p === "/api/ai/key") return send(200, ai.clearKey());

      if (req.method === "POST" && p === "/api/projects") {
        const b = await body(req); return send(200, orch.addProject(String(b.name), String(b.path)));
      }
      if (req.method === "POST" && p === "/api/tasks") {
        const b = await body(req); return send(200, orch.submit(String(b.project), String(b.prompt), b.agent));
      }
      if (req.method === "POST" && p === "/api/plans") { const b = await body(req); return send(200, await wf.proposePlan(String(b.project), String(b.goal))); }
      if (req.method === "POST" && p === "/api/runs") { const b = await body(req); return send(200, wf.run(String(b.project), b.plan, { isolate: b.isolate, execution: b.execution })); }
      const rm = p.match(/^\/api\/runs\/([\w-]+)(\/cancel)?$/);
      if (rm && req.method === "GET" && !rm[2]) { const r = wf.getRun(rm[1]); return r ? send(200, r) : send(404, { error: "not found" }); }
      if (rm && req.method === "POST" && rm[2]) return send(200, { cancelled: wf.cancel(rm[1]) });
      const im = p.match(/^\/api\/runs\/([\w-]+)\/(integrate|discard)$/);
      if (im && req.method === "POST") return send(200, im[2] === "integrate" ? wf.integrate(im[1]) : wf.discard(im[1]));
      if (p === "/api/workers" || p.startsWith("/api/workers/") || p.startsWith("/api/pki/")) {
        if (!gateway) return send(409, { error: "remote workers are not enabled (start with NEXUS_GATEWAY=1)" });
        if (req.method === "GET" && p === "/api/workers") return send(200, { address: gateway.address, workers: gateway.listWorkers(), jobs: remote!.listJobs(30) });
        if (req.method === "POST" && p === "/api/workers") { const b = await body(req);
          const { worker, bundle } = gateway.createWorker({ name: String(b.name), kinds: b.kinds, projects: (Array.isArray(b.projects) ? b.projects : []).map((x: unknown) => aliasOf(String(x))), ceilings: b.ceilings, maxConcurrent: b.maxConcurrent });
          return send(200, { worker: gateway.listWorkers().find((w) => w.id === worker.id), bundle, note: "the enrollment bundle contains a one-time token; it is shown only now and expires in 15 minutes" }); }
        const wm = p.match(/^\/api\/workers\/(w-[0-9a-f]{10})\/(revoke|grant)$/);
        if (wm && req.method === "POST") { if (wm[2] === "revoke") { gateway.revokeWorker(wm[1], "revoked by administrator via API"); return send(200, { ok: true }); }
          const b = await body(req); return send(200, { alias: gateway.grantProject(wm[1], resolveReal(String(b.project))) }); }
        if (req.method === "POST" && p === "/api/pki/rotate") return send(200, { generation: gateway.rotateCa() });
        if (req.method === "POST" && p === "/api/pki/complete") { const b = await body(req); gateway.completeCaRotation(b.force === true); return send(200, { ok: true }); }
        return send(404, { error: "not found" });
      }
      const rjm = p.match(/^\/api\/remote\/jobs\/([\w-]+)$/);
      if (rjm && req.method === "GET") { const r = remote?.getResult(rjm[1]); return r ? send(200, r) : send(404, { error: "not found" }); }
      const sm = p.match(/^\/api\/sandbox\/([\w-]+)$/);
      if (sm && req.method === "GET") { const r = sandbox.getResult(sm[1]) ?? remote?.getResult(sm[1]); return r ? send(200, r) : send(404, { error: "not found" }); }
      if (req.method === "GET" && p === "/api/usage") return send(200, usage.summary());
      if (req.method === "POST" && p === "/api/budgets") { const b = await body(req); return send(200, usage.setBudgets(b)); }
      const m = p.match(/^\/api\/tasks\/([\w-]+)(\/cancel)?$/);
      if (m && req.method === "GET" && !m[2]) { const t = orch.getTask(m[1]); return t ? send(200, t) : send(404, { error: "not found" }); }
      if (m && req.method === "POST" && m[2]) return send(200, { cancelled: orch.cancel(m[1]) });
      if (req.method === "POST" && p === "/api/approvals") {
        const b = await body(req); return send(200, { ok: security.decide(String(b.id), b.approve === true) });
      }
      if (req.method === "GET" && p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
        const onTask = (t: unknown) => res.write(`data: ${JSON.stringify({ task: t })}\n\n`);
        orch.on("event", onEvent); orch.on("task", onTask);
        req.on("close", () => { orch.off("event", onEvent); orch.off("task", onTask); });
        return;
      }
      send(404, { error: "not found" });
    } catch (e: any) {
      send(400, { error: String(e?.message ?? e) });
    }
  });
  return { server, orch, wf, security, audit, token, usage, sandbox, worktrees, gateway, remote, bus, ai, connect };
}

const UI_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
function serveStatic(res: http.ServerResponse, p: string) {
  const rel = p === "/" ? "index.html" : p.slice(1);
  const file = path.resolve(UI_DIST, rel);
  const inside = path.relative(UI_DIST, file);
  if (inside.startsWith("..") || path.isAbsolute(inside) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end("not found");
  }
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.NEXUS_DATA ?? path.join(process.cwd(), ".nexus");
  const port = Number(process.env.NEXUS_PORT ?? 7777);
  const env = process.env;
  const { server, gateway, token } = createApp(dataDir, undefined, env.NEXUS_GATEWAY === "1" ? { gateway: { host: env.NEXUS_GATEWAY_HOST, port: Number(env.NEXUS_GATEWAY_PORT ?? 7778), env } } : {});
  // NEXUS OS: hand the token to the desktop shell (group nexus-shell, mode 0640, in a tmpfs runtime directory).
  if (env.NEXUS_SHELL_TOKEN_FILE) {
    const f = env.NEXUS_SHELL_TOKEN_FILE, tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o640 }); fs.chmodSync(tmp, 0o640); fs.renameSync(tmp, f);
  }
  if (gateway) { const a = await gateway.start(); console.log(`Worker gateway (TLS 1.3 + mTLS) on ${a.host}:${a.port}`); }
  // When launched by the desktop shell, die with it (pipe closes if the parent is killed).
  if (process.env.NEXUS_EXIT_ON_STDIN_CLOSE) { process.stdin.resume(); process.stdin.on("end", () => process.exit(0)); }
  server.listen(port, "127.0.0.1", () => {
    // Never print the token: under systemd stdout goes to the journal, which persists and is readable by other users.
    console.log(`NEXUS core on http://127.0.0.1:${port}  (API token in ${path.join(dataDir, "token")}, mode 600)`);
  });
}
