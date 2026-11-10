// Conexiones personalizadas («＋ Añadir conexión»): any public HTTPS JSON API, described as DATA, never code.
//
// Trust model (on top of connect.ts)
//   * A custom connection is a description: base address, how the key is sent, a read-only check, actions (method + path
//     + body template) and lists to watch. The Engine turns it into an ordinary Connector; nothing in it is executed.
//   * The key only ever travels to the connection's own https origin. The base must be a public Internet host (checked
//     when saving AND before every request, as for webhooks). Changing the address or the way the key is sent forgets
//     the saved key, so a key can never be redirected to another host by editing the description.
//   * Values typed into a path are URL-encoded and "." / ".." are refused, so they cannot climb out of the base path.
//     Body templates are JSON: placeholders are replaced inside string values, never spliced into the JSON text.
//   * GET actions read; POST / PUT / PATCH change data (medium risk); DELETE is high risk. As for every connector, only
//     automations the person created can run actions that change data.
//   * NEXUS AI can draft a description from the service's official docs (os.ts draftConnector); the person reviews it
//     in Conexiones and saves it. A draft is never saved or used by itself.
import fs from "node:fs";
import path from "node:path";
import { ConnectError, newOnes, LIMITS, type Connector, type CredField, type Operation, type TriggerDef, type Param, type Input, type ConnectEvent } from "./connect.ts";

export type AuthKind = "bearer" | "header" | "query" | "basic" | "none";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type CustomParam = { key: string; label: string; required: boolean };
export type CustomOp = { id: string; name: string; description: string; method: HttpMethod; path: string; body: string; params: CustomParam[] };
export type CustomTrigger = { id: string; name: string; description: string; path: string; list: string; idField: string; labelField: string; fields: string[]; every: number; newestFirst: boolean };
export type CustomSpec = {
  id: string; name: string; description: string; docs: string; base: string;
  auth: { kind: AuthKind; name: string }; keyHelp: string; test: string;
  operations: CustomOp[]; triggers: CustomTrigger[];
  notices: string[]; sources: string[]; by: "persona" | "nexus-ai"; createdAt: string; updatedAt: string;
};

export const CUSTOM_LIMITS = { specs: 30, operations: 20, triggers: 10, params: 15, fields: 30, body: 4000, path: 300 };
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const AUTH: AuthKind[] = ["bearer", "header", "query", "basic", "none"];
const COLORS = ["#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#6366f1", "#84cc16", "#f97316"];
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie", "user-agent", "accept-encoding", "te", "upgrade", "proxy-authorization"]);
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,29})\s*\}\}/g;
const FIELD_PATH = /^[A-Za-z_]\w{0,40}(\.[A-Za-z_]\w{0,40}){0,4}$/;

const s = (v: unknown, max: number) => (v === undefined || v === null ? "" : String(v)).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const bad = (msg: string) => new ConnectError(msg, 400);
export const slug = (t: string, max = 24) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
const hostOf = (base: string) => { try { return new URL(base).host; } catch { return base; } };

/** A path relative to the base: starts with "/", no "//", no "." or ".." segment, no fragment. */
function checkPath(p: string, what: string): string {
  const v = s(p, CUSTOM_LIMITS.path + 1);
  if (!v) throw bad(`falta la ruta de ${what}`);
  if (v.length > CUSTOM_LIMITS.path) throw bad(`la ruta de ${what} es demasiado larga`);
  if (!/^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/{}?]*$/.test(v.replace(PLACEHOLDER, "x"))) throw bad(`la ruta de ${what} tiene caracteres no válidos (tiene que empezar por / y no llevar espacios)`);
  const pathPart = v.split("?")[0];
  if (pathPart.includes("//") || pathPart.split("/").some((seg) => /^(\.|\.\.|%2e|%2e%2e|\.%2e|%2e\.)$/i.test(seg))) throw bad(`la ruta de ${what} no puede llevar «//», «.» ni «..»`);
  return v;
}
function placeholders(t: string): string[] { return [...t.matchAll(PLACEHOLDER)].map((m) => m[1]); }

/** Checks and normalises a description typed by the person or drafted by NEXUS AI. Throws a ConnectError in Spanish. */
export function validateSpec(input: unknown, taken: string[], existing?: CustomSpec, now = new Date()): CustomSpec {
  const x = (input && typeof input === "object" ? input : {}) as Record<string, any>;
  const name = s(x.name, 41);
  if (name.length < 2) throw bad("ponle un nombre a la conexión");
  if (name.length > 40) throw bad("el nombre es demasiado largo (máximo 40 letras)");
  let id = existing?.id ?? "";
  if (!id) {
    const root = "x-" + (slug(name) || "conexion");
    id = root; for (let i = 2; taken.includes(id); i++) id = `${root.slice(0, 26)}-${i}`;
  }
  let base: URL;
  try { base = new URL(s(x.base, 301)); } catch { throw bad("la dirección de la API no es válida (tiene que ser como https://api.servicio.com/v1)"); }
  if (base.protocol !== "https:") throw bad("la dirección de la API tiene que empezar por https://");
  if (base.username || base.password) throw bad("la dirección de la API no puede llevar usuario ni contraseña: van en la clave");
  if (base.search || base.hash) throw bad("la dirección de la API no puede llevar «?» ni «#»: pon solo el principio común (https://api.servicio.com/v1)");
  if (base.href.length > 300) throw bad("la dirección de la API es demasiado larga");
  const baseStr = base.origin + base.pathname.replace(/\/+$/, "");
  const docs = s(x.docs, 301);
  if (docs && !/^https:\/\/\S{4,296}$/.test(docs)) throw bad("la dirección de la documentación tiene que empezar por https://");

  const a = (x.auth && typeof x.auth === "object" ? x.auth : {}) as Record<string, unknown>;
  const kind = AUTH.includes(a.kind as AuthKind) ? (a.kind as AuthKind) : null;
  if (!kind) throw bad("elige cómo se envía la clave");
  let authName = "";
  if (kind === "header") {
    authName = s(a.name, 61);
    if (!/^[A-Za-z][A-Za-z0-9-]{0,59}$/.test(authName)) throw bad("escribe el nombre de la cabecera donde va la clave (por ejemplo X-API-Key)");
    if (FORBIDDEN_HEADERS.has(authName.toLowerCase())) throw bad(`la clave no puede ir en la cabecera «${authName}»`);
  } else if (kind === "query") {
    authName = s(a.name, 61);
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(authName)) throw bad("escribe el nombre del parámetro de la dirección donde va la clave (por ejemplo api_key)");
  }

  const ops = Array.isArray(x.operations) ? x.operations : [];
  if (ops.length > CUSTOM_LIMITS.operations) throw bad(`como mucho ${CUSTOM_LIMITS.operations} acciones`);
  const opIds: string[] = [];
  const operations: CustomOp[] = ops.map((o: any, n: number) => {
    const oname = s(o?.name, 61);
    if (oname.length < 2) throw bad(`ponle un nombre a la acción ${n + 1}`);
    const method = METHODS.includes(String(o?.method).toUpperCase() as HttpMethod) ? (String(o.method).toUpperCase() as HttpMethod) : null;
    if (!method) throw bad(`elige el método de «${oname}» (GET, POST, PUT, PATCH o DELETE)`);
    const opath = checkPath(o?.path, `«${oname}»`);
    const rawParams = Array.isArray(o?.params) ? o.params : [];
    if (rawParams.length > CUSTOM_LIMITS.params) throw bad(`«${oname}» pide demasiados datos (máximo ${CUSTOM_LIMITS.params})`);
    const params: CustomParam[] = [];
    for (const p of rawParams) {
      const key = s(p?.key, 31).toLowerCase();
      if (!/^[a-z][a-z0-9_]{0,29}$/.test(key)) throw bad(`«${oname}»: «${s(p?.key, 31)}» no vale como nombre de dato (solo minúsculas, números y _)`);
      if (params.some((q) => q.key === key)) throw bad(`«${oname}» pide «${key}» dos veces`);
      params.push({ key, label: s(p?.label, 61) || key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), required: p?.required === true });
    }
    let body = method === "GET" || method === "DELETE" ? "" : String(o?.body ?? "").trim();
    if (body.length > CUSTOM_LIMITS.body) throw bad(`el cuerpo de «${oname}» es demasiado largo`);
    if (body) {
      let j: unknown;
      try { j = JSON.parse(body); } catch { throw bad(`el cuerpo de «${oname}» no es JSON válido (los datos van entre comillas: "{{email}}")`); }
      if (!j || typeof j !== "object") throw bad(`el cuerpo de «${oname}» tiene que ser un objeto o una lista JSON`);
      body = JSON.stringify(j);
    }
    for (const k of [...placeholders(opath), ...placeholders(body)])
      if (!params.some((p) => p.key === k)) throw bad(`«${oname}» usa {{${k}}}, pero no lo pide en «Datos que pide»`);
    let oid = slug(oname, 30).replace(/-/g, "_") || `accion_${n + 1}`;
    for (let i = 2; opIds.includes(oid); i++) oid = `${slug(oname, 26).replace(/-/g, "_")}_${i}`;
    opIds.push(oid);
    return { id: oid, name: oname, description: s(o?.description, 241), method, path: opath, body, params };
  });

  const trs = Array.isArray(x.triggers) ? x.triggers : [];
  if (trs.length > CUSTOM_LIMITS.triggers) throw bad(`como mucho ${CUSTOM_LIMITS.triggers} cosas que vigilar`);
  const trIds: string[] = [];
  const triggers: CustomTrigger[] = trs.map((t: any, n: number) => {
    const tname = s(t?.name, 61);
    if (tname.length < 2) throw bad(`ponle un nombre a lo que vigila (${n + 1})`);
    const tpath = checkPath(t?.path, `«${tname}»`);
    if (placeholders(tpath).length) throw bad(`«${tname}»: la ruta de algo que se vigila no puede pedir datos ({{…}})`);
    const list = s(t?.list, 120);
    if (list && !FIELD_PATH.test(list)) throw bad(`«${tname}»: «${list}» no vale como sitio de la lista (por ejemplo data o data.items)`);
    const idField = s(t?.idField, 120);
    if (!FIELD_PATH.test(idField)) throw bad(`«${tname}»: escribe el campo que identifica cada elemento (por ejemplo id)`);
    const labelField = s(t?.labelField, 120);
    if (labelField && !FIELD_PATH.test(labelField)) throw bad(`«${tname}»: «${labelField}» no vale como campo del nombre`);
    const rawFields = (Array.isArray(t?.fields) ? t.fields : String(t?.fields ?? "").split(",")).map((f: unknown) => s(f, 120)).filter(Boolean);
    if (rawFields.length > CUSTOM_LIMITS.fields) throw bad(`«${tname}» trae demasiados campos (máximo ${CUSTOM_LIMITS.fields})`);
    for (const f of rawFields) if (!FIELD_PATH.test(f)) throw bad(`«${tname}»: «${f}» no vale como campo (letras, números y _; con puntos para entrar: cliente.email)`);
    const fields = [...new Set([idField, ...(labelField ? [labelField] : []), ...rawFields])];
    const every = Math.round(Number(t?.every ?? 15));
    if (!Number.isFinite(every) || every < 5 || every > 1440) throw bad(`«${tname}»: mirar cada 5 a 1.440 minutos`);
    let tid = slug(tname, 30).replace(/-/g, "_") || `vigilar_${n + 1}`;
    for (let i = 2; trIds.includes(tid); i++) tid = `${slug(tname, 26).replace(/-/g, "_")}_${i}`;
    trIds.push(tid);
    return { id: tid, name: tname, description: s(t?.description, 241), path: tpath, list, idField, labelField, fields, every, newestFirst: t?.newestFirst !== false };
  });
  if (!operations.length && !triggers.length) throw bad("añade al menos una acción o algo que vigilar");

  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v : []).map((y) => s(y, max)).filter(Boolean).slice(0, n);
  return {
    id, name, description: s(x.description, 241), docs, base: baseStr, auth: { kind, name: authName },
    keyHelp: s(x.keyHelp, 301), test: checkPath(x.test, "la comprobación"),
    operations, triggers,
    notices: list(x.notices, 8, 300), sources: list(x.sources, 8, 300).filter((u) => /^https:\/\//.test(u)),
    by: x.by === "nexus-ai" ? "nexus-ai" : existing?.by ?? "persona",
    createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(),
  };
}

/** True when the edit must forget the saved key: another address or another way of sending it. */
export function keyMustReset(before: CustomSpec, after: CustomSpec): boolean {
  return new URL(before.base).origin !== new URL(after.base).origin || before.auth.kind !== after.auth.kind || before.auth.name.toLowerCase() !== after.auth.name.toLowerCase();
}

// ------------------------------------------------------------------ description → Connector
function getPath(o: any, p: string): any {
  if (!p) return o;
  let cur = o;
  for (const k of p.split(".")) { if (cur === null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}
function setPath(o: Record<string, any>, p: string, v: unknown) {
  const ks = p.split("."); let cur = o;
  for (const k of ks.slice(0, -1)) { if (!cur[k] || typeof cur[k] !== "object") cur[k] = {}; cur = cur[k]; }
  cur[ks[ks.length - 1]] = v;
}
function flat(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((y) => (y !== null && typeof y === "object" ? JSON.stringify(y) : String(y))).join(", ").slice(0, 500);
  if (typeof v === "object") return JSON.stringify(v).slice(0, 500);
  return String(v).slice(0, 500);
}
/** What an action answered, in a few plain lines for the automation's history (never the whole answer). */
function summary(r: unknown): Record<string, unknown> {
  if (Array.isArray(r)) return { elementos: r.length };
  if (!r || typeof r !== "object") return { respuesta: r === undefined || r === null || r === "" ? "hecho" : flat(r) };
  const out: Record<string, unknown> = {};
  const walk = (o: Record<string, unknown>, pre: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (Object.keys(out).length >= 12) return;
      if (v !== null && typeof v === "object" && !Array.isArray(v)) { if (depth < 2) walk(v as Record<string, unknown>, pre + k + ".", depth + 1); }
      else if (Array.isArray(v)) out[pre + k] = `${v.length} elementos`;
      else if (v !== null && v !== undefined && v !== "") out[pre + k] = String(v).slice(0, 200);
    }
  };
  walk(r as Record<string, unknown>, "", 0);
  return Object.keys(out).length ? out : { respuesta: "hecho" };
}
/** Placeholders in a path: URL-encoded; "." and ".." refused so a value cannot climb out of the base path. */
function fillPath(p: string, i: Input): string {
  return p.replace(PLACEHOLDER, (_m, k: string) => {
    const v = i[k] ?? "";
    if (v === "." || v === "..") throw new ConnectError(`«${k}» no puede ser «${v}»`, 400);
    return encodeURIComponent(v);
  });
}
/** Placeholders in a JSON body: replaced inside string values only. "{{x}}" alone becomes the value itself. */
function fillJson(v: unknown, i: Input): unknown {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([a-z][a-z0-9_]{0,29})\s*\}\}$/.exec(v);
    if (whole) return i[whole[1]] ?? "";
    return v.replace(PLACEHOLDER, (_m, k: string) => i[k] ?? "");
  }
  if (Array.isArray(v)) return v.map((y) => fillJson(y, i));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, y]) => [k, fillJson(y, i)]));
  return v;
}

export function toConnector(spec: CustomSpec): Connector {
  const host = hostOf(spec.base);
  const color = COLORS[[...spec.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
  const keyField = (label: string): CredField => ({ key: "token", label, secret: true, pattern: /^[\x21-\x7e]{6,4000}$/, help: spec.keyHelp || `La clave de la API de ${spec.name}. NEXUS solo la envía a ${host}.` });
  const fields: CredField[] = spec.auth.kind === "none" ? []
    : spec.auth.kind === "basic" ? [
      { key: "usuario", label: "Usuario", secret: false, pattern: /^[\x20-\x7e]{1,200}$/, help: spec.keyHelp || `Tu usuario de la API de ${spec.name}.` },
      { key: "token", label: "Contraseña o clave", secret: true, pattern: /^[\x20-\x7e]{1,4000}$/, help: `NEXUS solo la envía a ${host}.` },
    ]
    : [keyField(spec.auth.kind === "header" ? `Clave (va en la cabecera ${spec.auth.name})` : spec.auth.kind === "query" ? `Clave (va en la dirección como ${spec.auth.name})` : "Clave o token de la API")];
  const operations: Operation[] = spec.operations.map((o) => {
    const params: Param[] = o.params.map((p) => ({ key: p.key, label: p.label, required: p.required }));
    const inPath = new Set(placeholders(o.path)), inBody = new Set(placeholders(o.body));
    return {
      id: o.id, name: o.name, description: o.description || `${o.method} ${o.path.split("?")[0]}`,
      kind: o.method === "GET" ? "read" : "write", risk: o.method === "GET" ? "baja" : o.method === "DELETE" ? "alta" : "media",
      params,
      run: async (c, i) => {
        const where = fillPath(o.path, i);
        const rest = Object.fromEntries(o.params.filter((p) => !inPath.has(p.key) && !inBody.has(p.key) && i[p.key] !== undefined).map((p) => [p.key, i[p.key]]));
        const r = o.method === "GET" || o.method === "DELETE"
          ? await c.http(o.method, where, { query: rest })
          : await c.http(o.method, where, { body: o.body ? fillJson(JSON.parse(o.body), i) : rest });
        return summary(r);
      },
    };
  });
  const triggers: TriggerDef[] = spec.triggers.map((t) => ({
    id: t.id, name: t.name, description: t.description || `Avisa por cada elemento nuevo de ${t.path.split("?")[0]} (los que ya había al crear la automatización no cuentan).`,
    params: [], every: t.every,
    fields: t.fields.map((f) => ({ key: `elemento.${f}`, label: f })),
    poll: async (c, _i, state) => {
      const r = await c.http("GET", t.path);
      const arr = getPath(r, t.list);
      if (!Array.isArray(arr)) throw new ConnectError(`${spec.name}: la respuesta de «${t.name}» no trae una lista en «${t.list || "la raíz"}». Revisa «La lista está en» en Conexiones.`);
      const key = (x: any) => flat(getPath(x, t.idField));
      const items = arr.filter((x) => x && typeof x === "object" && key(x) !== "");
      // Order unknown to NEXUS: if suddenly most of a full page is unseen, the API did not answer in a stable order
      // (or the person changed it). Acting on that would fire for old things: take it as a new starting point instead.
      const seen = new Set<string>(Array.isArray(state?.seen) ? state.seen.map(String) : []);
      const unseen = state?.ready === true ? items.filter((x) => !seen.has(key(x))).length : 0;
      if (unseen >= 10 && unseen > items.length / 2) { const n = newOnes(undefined, items, key, 5000); return { events: [], state: n.state, baseline: items.length }; }
      const n = newOnes(state, t.newestFirst ? [...items].reverse() : items, key, 5000, LIMITS.events);
      const events: ConnectEvent[] = n.fresh.map((x: any) => {
        const el: Record<string, any> = {};
        for (const f of t.fields) { const v = getPath(x, f); if (v !== undefined && v !== null) setPath(el, f, flat(v)); }
        return { id: key(x), label: flat(getPath(x, t.labelField)).slice(0, 120) || key(x), data: { elemento: el } };
      });
      return { events, state: n.state, baseline: n.baseline };
    },
  }));
  const reads = operations.filter((o) => o.kind === "read").length;
  return {
    id: spec.id, name: spec.name, provider: `Conexión personalizada · ${host}`, version: spec.updatedAt.slice(0, 10), color,
    description: spec.description || `Tu conexión con ${spec.name}.`, docs: spec.docs,
    verified: spec.by === "nexus-ai"
      ? `La preparó NEXUS AI leyendo la documentación oficial${spec.sources.length ? " (" + spec.sources.map(hostOf).filter((v, i, a) => a.indexOf(v) === i).join(", ") + ")" : ""} y la revisaste tú. Compruébala con «Probar la conexión».`
      : "La creaste tú a mano. Compruébala con «Probar la conexión».",
    scopes: spec.auth.kind === "none" ? ["ninguna clave"] : [`la clave que pongas, que solo se envía a ${host}`],
    data: `Solo habla con ${host}. ${reads} ${reads === 1 ? "acción lee" : "acciones leen"}; ${operations.length - reads} ${operations.length - reads === 1 ? "cambia" : "cambian"} datos (solo desde automatizaciones que crees tú).`,
    fields,
    base: () => spec.base,
    headers: (cred) => spec.auth.kind === "bearer" ? { authorization: `Bearer ${cred.token}` }
      : spec.auth.kind === "header" ? { [spec.auth.name.toLowerCase()]: cred.token }
      : spec.auth.kind === "basic" ? { authorization: "Basic " + Buffer.from(`${cred.usuario}:${cred.token}`).toString("base64") } : {},
    query: spec.auth.kind === "query" ? (cred) => ({ [spec.auth.name]: cred.token }) : undefined,
    publicOnly: true,
    custom: { notices: spec.notices, sources: spec.sources, by: spec.by, host },
    test: async (c) => {
      const r = await c.http("GET", spec.test);
      const arr = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : Array.isArray(r?.items) ? r.items : Array.isArray(r?.results) ? r.results : null;
      return `Conectado a ${host}` + (arr ? ` · la comprobación devuelve ${arr.length} ${arr.length === 1 ? "elemento" : "elementos"}` : "");
    },
    operations, triggers,
  };
}

// ------------------------------------------------------------------ NEXUS AI draft (os.ts) → description
/** JSON schema of the tool NEXUS AI fills (strict): Spanish keys, everything required. */
export const DRAFT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["nombre", "descripcion", "documentacion", "base", "auth_tipo", "auth_nombre", "clave_ayuda", "comprobacion", "acciones", "vigilar", "avisos", "fuentes"],
  properties: {
    nombre: { type: "string" }, descripcion: { type: "string" }, documentacion: { type: "string" }, base: { type: "string" },
    auth_tipo: { type: "string", enum: AUTH }, auth_nombre: { type: "string" }, clave_ayuda: { type: "string" }, comprobacion: { type: "string" },
    acciones: { type: "array", items: { type: "object", additionalProperties: false, required: ["nombre", "descripcion", "metodo", "ruta", "cuerpo", "datos"], properties: {
      nombre: { type: "string" }, descripcion: { type: "string" }, metodo: { type: "string", enum: METHODS }, ruta: { type: "string" }, cuerpo: { type: "string" },
      datos: { type: "array", items: { type: "object", additionalProperties: false, required: ["clave", "etiqueta", "obligatorio"], properties: { clave: { type: "string" }, etiqueta: { type: "string" }, obligatorio: { type: "boolean" } } } },
    } } },
    vigilar: { type: "array", items: { type: "object", additionalProperties: false, required: ["nombre", "descripcion", "ruta", "lista", "campo_id", "campo_nombre", "campos", "minutos", "nuevos_primero"], properties: {
      nombre: { type: "string" }, descripcion: { type: "string" }, ruta: { type: "string" }, lista: { type: "string" }, campo_id: { type: "string" }, campo_nombre: { type: "string" },
      campos: { type: "array", items: { type: "string" } }, minutos: { type: "integer" }, nuevos_primero: { type: "boolean" },
    } } },
    avisos: { type: "array", items: { type: "string" } }, fuentes: { type: "array", items: { type: "string" } },
  },
} as const;

/** NEXUS AI's answer (Spanish keys) → the description the form edits. Not validated here: the person reviews it first. */
export function fromDraft(d: any): Record<string, unknown> {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    name: s(d?.nombre, 40), description: s(d?.descripcion, 240), docs: s(d?.documentacion, 300), base: s(d?.base, 300).replace(/\/+$/, ""),
    auth: { kind: AUTH.includes(d?.auth_tipo) ? d.auth_tipo : "bearer", name: s(d?.auth_nombre, 60) }, keyHelp: s(d?.clave_ayuda, 300), test: s(d?.comprobacion, 300),
    operations: arr(d?.acciones).slice(0, CUSTOM_LIMITS.operations).map((o: any) => ({
      name: s(o?.nombre, 60), description: s(o?.descripcion, 240), method: METHODS.includes(o?.metodo) ? o.metodo : "GET", path: s(o?.ruta, 300), body: String(o?.cuerpo ?? "").slice(0, CUSTOM_LIMITS.body),
      params: arr(o?.datos).slice(0, CUSTOM_LIMITS.params).map((p: any) => ({ key: s(p?.clave, 30).toLowerCase(), label: s(p?.etiqueta, 60), required: p?.obligatorio === true })),
    })),
    triggers: arr(d?.vigilar).slice(0, CUSTOM_LIMITS.triggers).map((t: any) => ({
      name: s(t?.nombre, 60), description: s(t?.descripcion, 240), path: s(t?.ruta, 300), list: s(t?.lista, 120), idField: s(t?.campo_id, 120), labelField: s(t?.campo_nombre, 120),
      fields: arr(t?.campos).map((f: unknown) => s(f, 120)).filter(Boolean).slice(0, CUSTOM_LIMITS.fields), every: Math.min(1440, Math.max(5, Math.round(Number(t?.minutos) || 15))), newestFirst: t?.nuevos_primero !== false,
    })),
    notices: arr(d?.avisos).map((v: unknown) => s(v, 300)).filter(Boolean).slice(0, 8),
    sources: arr(d?.fuentes).map((v: unknown) => s(v, 300)).filter((u: string) => /^https:\/\//.test(u)).slice(0, 8),
    by: "nexus-ai",
  };
}

// ------------------------------------------------------------------ the store (inside the Engine)
export class CustomConnections {
  private file: string;
  private cache: { mtime: number; specs: CustomSpec[] } | null = null;
  constructor(dataDir: string) { this.file = path.join(dataDir, "connect-custom.json"); }
  list(): CustomSpec[] {
    let mtime = 0; try { mtime = fs.statSync(this.file).mtimeMs; } catch { return []; }
    if (this.cache && this.cache.mtime === mtime) return this.cache.specs;
    let specs: CustomSpec[] = [];
    try { const v = JSON.parse(fs.readFileSync(this.file, "utf8")); specs = Array.isArray(v?.specs) ? v.specs : []; } catch { specs = []; }
    this.cache = { mtime, specs };
    return specs;
  }
  get(id: string) { return this.list().find((x) => x.id === id); }
  connectors(): Connector[] {
    const out: Connector[] = [];
    for (const sp of this.list()) { try { out.push(toConnector(sp)); } catch { /* a damaged entry is skipped, never fatal */ } }
    return out;
  }
  write(specs: CustomSpec[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, specs }, null, 1), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
    this.cache = null;
  }
}
