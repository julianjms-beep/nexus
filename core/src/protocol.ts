// Wire protocol between the NEXUS gateway and workers: newline-delimited JSON frames over TLS 1.3 (mTLS).
// Strict whitelist of message types and fields, hard limits on frame size and rate. Everything received is untrusted input.
import type { Socket } from "node:net";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_FRAMES_PER_10S = 600;

type FieldType = "string" | "number" | "boolean" | "array" | "object";
type Schema = Record<string, FieldType | `${FieldType}?`>;

// worker -> gateway
export const WORKER_MESSAGES: Record<string, Schema> = {
  enroll: { workerId: "string", token: "string", csrPem: "string", platform: "string" },
  hello: { version: "number", platform: "string", isolation: "object", kinds: "array", running: "array" },
  heartbeat: { running: "array", active: "number" },
  renew: { csrPem: "string" },
  accepted: { jobId: "string", executionId: "string", fence: "number" },
  rejected: { jobId: "string", executionId: "string", fence: "number", reason: "string" },
  result: { jobId: "string", executionId: "string", fence: "number", status: "string", "sandbox": "object?", "agent": "object?", "files": "object?", "error": "string?" },
  blob: { jobId: "string", executionId: "string", fence: "number", seq: "number", last: "boolean", data: "string" },
};
// gateway -> worker
export const GATEWAY_MESSAGES: Record<string, Schema> = {
  "enroll.ok": { certPem: "string", caPems: "array" },
  "enroll.denied": { reason: "string" },
  "hello.ok": { heartbeatMs: "number", leaseMs: "number" },
  "renew.ok": { certPem: "string", caPems: "array" },
  "renew.denied": { reason: "string" },
  offer: { jobId: "string", executionId: "string", fence: "number", spec: "object", manifest: "object", archive: "object" },
  blob: { jobId: "string", executionId: "string", fence: "number", seq: "number", last: "boolean", data: "string" },
  cancel: { jobId: "string", executionId: "string", fence: "number" },
  kill: { jobId: "string", executionId: "string?" },
  bye: { reason: "string" },
};

const MAX_STRING = 200_000;
export type Frame = { type: string; [k: string]: any };

/** Returns an error string, or undefined when the frame is acceptable for `table`. */
export function validateFrame(msg: unknown, table: Record<string, Schema>): string | undefined {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return "frame must be an object";
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== "string" || !Object.hasOwn(table, m.type)) return `unknown message type`;
  const schema = table[m.type];
  for (const [k, spec] of Object.entries(schema)) {
    const optional = spec.endsWith("?"); const t = optional ? spec.slice(0, -1) : spec;
    const v = m[k];
    if (v === undefined || v === null) { if (optional) continue; return `missing field ${k}`; }
    const ok = t === "array" ? Array.isArray(v) : t === "object" ? typeof v === "object" && !Array.isArray(v) : typeof v === t;
    if (!ok) return `field ${k} must be ${t}`;
    if (typeof v === "string" && v.length > MAX_STRING) return `field ${k} too long`;
    if (typeof v === "number" && !Number.isFinite(v)) return `field ${k} must be finite`;
  }
  for (const k of Object.keys(m)) if (k !== "type" && !(k in schema)) return `unexpected field ${k}`;
  return undefined;
}

/** Splits a socket's byte stream into JSON frames, enforcing size and rate limits. */
export class FrameReader {
  private buf = ""; private stamps: number[] = [];
  constructor(socket: Socket, private onFrame: (f: Frame) => void, private onError: (reason: string) => void) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.push(chunk));
  }
  private push(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return this.onError("frame too large");
      if (!line.trim()) continue;
      const now = Date.now(); this.stamps = this.stamps.filter((t) => now - t < 10_000); this.stamps.push(now);
      if (this.stamps.length > MAX_FRAMES_PER_10S) return this.onError("rate limit exceeded");
      let f: unknown;
      try { f = JSON.parse(line); } catch { return this.onError("malformed JSON"); }
      this.onFrame(f as Frame);
    }
    if (Buffer.byteLength(this.buf) > MAX_FRAME_BYTES) this.onError("frame too large");
  }
}

export function sendFrame(socket: Socket, frame: Frame): boolean {
  if (socket.destroyed || !socket.writable) return false;
  const line = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error("frame exceeds MAX_FRAME_BYTES");
  return socket.write(line);
}

/** Strips control characters (except \n and \t) and caps length: used for everything a worker reports back. */
export function sanitizeText(v: unknown, max = 20_000): string {
  const s = typeof v === "string" ? v : "";
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
}
export function clampNumber(v: unknown, min: number, max: number, dflt = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(max, Math.max(min, n));
}

/** Splits a buffer into base64 `blob` frames' payloads that fit comfortably under the frame limit. */
export const BLOB_CHUNK_BYTES = 128 * 1024;
export function chunkBuffer(buf: Buffer): string[] {
  const out: string[] = [];
  for (let o = 0; o < buf.length || o === 0; o += BLOB_CHUNK_BYTES) out.push(buf.subarray(o, o + BLOB_CHUNK_BYTES).toString("base64"));
  return out;
}
