// Where the worker gateway may listen. Default: loopback only. Anything else needs explicit, separate opt-ins.
import net from "node:net";

export type Exposure = "loopback" | "private" | "wildcard" | "public";
export type BindDecision = { host: string; exposure: Exposure; warnings: string[] };

export function classify(host: string): Exposure {
  if (host === "0.0.0.0" || host === "::" || host === "::0") return "wildcard";
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return "private"; // RFC1918, link-local, CGNAT/Tailscale
    return "public";
  }
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    if (h === "::1") return "loopback";
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return "private";
    return "public";
  }
  throw new Error(`gateway host must be an IP literal (got "${host}")`);
}

/** Throws unless the requested bind is allowed by the environment's explicit opt-ins. */
export function resolveGatewayBind(hostIn: string | undefined, env: Record<string, string | undefined> = process.env): BindDecision {
  const host = !hostIn || hostIn === "localhost" ? "127.0.0.1" : hostIn;
  const exposure = classify(host);
  const warnings: string[] = [];
  if (exposure === "loopback") return { host, exposure, warnings };
  if (env.NEXUS_GATEWAY_ALLOW_NON_LOOPBACK !== "1") throw new Error(`refusing to bind the gateway to ${host} (${exposure}): set NEXUS_GATEWAY_ALLOW_NON_LOOPBACK=1 to allow non-loopback binds`);
  if (exposure === "wildcard") {
    if (env.NEXUS_GATEWAY_ALLOW_WILDCARD !== "1") throw new Error("refusing wildcard bind: set NEXUS_GATEWAY_ALLOW_WILDCARD=1 as well (binds every interface)");
    warnings.push("gateway listens on ALL interfaces; make sure a firewall/VPN limits who can reach it");
  }
  if (exposure === "public") {
    if (env.NEXUS_GATEWAY_ALLOW_PUBLIC !== "I_UNDERSTAND_THIS_EXPOSES_THE_GATEWAY_TO_THE_INTERNET") throw new Error("refusing public address: the gateway is not exposed to the Internet by default");
    warnings.push("gateway is reachable from the public Internet; mTLS is the only protection");
  }
  if (exposure === "private") warnings.push("gateway listens on a private-network address: restrict access with a VPN or firewall");
  return { host, exposure, warnings };
}
