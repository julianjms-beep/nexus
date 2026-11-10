// The network of an agent, filtered: a small HTTP proxy of NEXUS's own, outside the sandbox, that lets traffic
// through only to the sites on a list (the agent's model, the package registries, what the person adds) and refuses
// everything else. The sandbox takes the direct way out of the agent (core/src/agent-platform.ts), so the proxy is
// the only door: what an agent can read — the project — it can no longer post to an arbitrary site.
//
// What it is not: it does not look inside the traffic (HTTPS stays end to end), so a site ON the list can still
// receive whatever the agent sends it. Keep the list short.
import http from "node:http";
import net from "node:net";

// Where a coding agent normally needs to go. Names only; a leading dot means "and everything under it".
export const DEFAULT_HOSTS = [
  // the model
  "api.anthropic.com", "console.anthropic.com", "claude.ai", ".claude.ai", "platform.claude.com", "statsig.anthropic.com",
  // packages
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io", "proxy.golang.org", "sum.golang.org",
  // code hosting, to read (pushing needs keys the agent does not have)
  "github.com", "api.github.com", "codeload.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
];

/** A host name the person adds with --allow-host: a plain name, optionally with a leading dot. Never an address. */
export function checkHost(h: unknown): string {
  const s = String(h ?? "").trim().toLowerCase();
  if (!/^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s) || s.length > 200 || /^\.?\d+(\.\d+){3}$/.test(s)) throw new Error(`not a host name: ${String(h).slice(0, 60)}`);
  return s;
}
/** Is this host on the list? Addresses (IPv4, IPv6) and "localhost" never are: the proxy is no way into this computer. */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.includes(":") || /^\d+(\.\d+){3}$/.test(h) || !/^[a-z0-9.-]+$/.test(h)) return false;
  return allow.some((a) => (a.startsWith(".") ? h.endsWith(a) || h === a.slice(1) : h === a));
}

export type NetFilter = { port: number; blocked: Map<string, number>; allowed: Map<string, number>; close: () => Promise<void> };
export type NetFilterOptions = { allow: string[]; onBlocked?: (host: string) => void; /** tests: where an allowed "host:port" really goes */ dial?: (host: string, port: number) => net.Socket };

/** Starts the proxy on 127.0.0.1 (a random port). CONNECT for HTTPS, absolute-URI requests for plain HTTP. */
export async function startNetFilter(o: NetFilterOptions): Promise<NetFilter> {
  const blocked = new Map<string, number>(), allowed = new Map<string, number>();
  const dial = o.dial ?? ((host, port) => net.connect({ host, port }));
  const deny = (host: string) => { if (!blocked.has(host)) o.onBlocked?.(host); blocked.set(host, (blocked.get(host) ?? 0) + 1); };
  const okPort = (p: number) => p === 443 || p === 80;
  const server = http.createServer((req, res) => {
    // plain HTTP through the proxy: "GET http://host/path"
    let u: URL | null = null; try { u = new URL(req.url ?? ""); } catch { u = null; }
    const port = u ? Number(u.port || 80) : 0;
    if (!u || u.protocol !== "http:" || !hostAllowed(u.hostname, o.allow) || !okPort(port)) {
      if (u) deny(u.hostname);
      res.writeHead(403, { "content-type": "text/plain", connection: "close" });
      return res.end(`NEXUS: ${u ? u.hostname : "this address"} is not on this agent's list of allowed sites.\n`);
    }
    allowed.set(u.hostname, (allowed.get(u.hostname) ?? 0) + 1);
    const headers = { ...req.headers }; delete headers["proxy-connection"]; delete headers["proxy-authorization"];
    const up = http.request({ host: u.hostname, port, path: u.pathname + u.search, method: req.method, headers, createConnection: () => dial(u!.hostname, port) }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on("connect", (req, client, head) => {
    const m = /^([^:\s]+|\[[^\]]+\]):(\d{1,5})$/.exec(req.url ?? "");
    const host = m ? m[1].replace(/^\[|\]$/g, "") : "", port = m ? Number(m[2]) : 0;
    client.on("error", () => {});
    if (!m || !hostAllowed(host, o.allow) || !okPort(port)) {
      if (host) deny(host);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nNEXUS: ${host || "this address"} is not on this agent's list of allowed sites.\n`);
      return;
    }
    allowed.set(host, (allowed.get(host) ?? 0) + 1);
    const up = dial(host, port);
    up.on("connect", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) up.write(head); up.pipe(client); client.pipe(up); });
    up.on("error", () => { client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n"); });
    client.on("close", () => up.destroy()); up.on("close", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { port, blocked, allowed, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** What makes programs use the proxy: curl, git, npm, pip and Claude Code read these; Node reads them with NODE_USE_ENV_PROXY. */
export function proxyEnv(port: number): Record<string, string> {
  const p = `http://127.0.0.1:${port}`, none = "127.0.0.1,localhost,::1";
  return { HTTPS_PROXY: p, HTTP_PROXY: p, ALL_PROXY: p, https_proxy: p, http_proxy: p, all_proxy: p, NO_PROXY: none, no_proxy: none, NODE_USE_ENV_PROXY: "1" };
}
