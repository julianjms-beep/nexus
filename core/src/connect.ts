// NEXUS Connect (fase 6 del prompt maestro): conectores con servicios de fuera, por sus APIs oficiales.
//
// Trust model
//   * Runs inside the Engine (system user nexus-engine). Credentials live in <data>/connect.json (mode 0600). They are
//     never returned by the API, never logged, never given to NEXUS AI, agents or apps: they only travel in the
//     headers of a request to the connector's own https origin.
//   * Every connector declares its provider, documentation, how its endpoints were verified, the permissions (scopes)
//     it needs, the data it touches, and each operation's kind (read / write) and risk. Nothing else can be called:
//     no free URLs, except the Webhook connector's single address, which the person types in (never a local network).
//   * The desktop, the automations and NEXUS AI only name a connector, an operation and its inputs. Writes run only for
//     automations the person created and reviewed (nexus-sessiond says so); NEXUS AI can only draft an automation.
//   * Every call is audited (connector, operation, method, HTTP status, time), never the inputs, answers or tokens.
//   * Rate limits: one request at a time per connector, at least `gapMs` apart; 429 (and, for reads, 502/503/504 and
//     network errors) are retried up to 3 times honouring Retry-After (at most 20 s).
//   * Triggers are polled: the first poll only notes what already exists (nothing fires for old invoices or contacts);
//     later polls return what is new, oldest first, at most MAX_EVENTS at a time (the rest come in the next poll).
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import type { Audit } from "./audit.ts";
import { validateSpec, keyMustReset, toConnector, CUSTOM_LIMITS, type CustomConnections, type CustomSpec } from "./connect-custom.ts";

export type Param = { key: string; label: string; help?: string; required?: boolean; list?: boolean; example?: string };
export type CredField = { key: string; label: string; help: string; secret: boolean; pattern: RegExp; example?: string; optional?: boolean };
export type EventField = { key: string; label: string };
export type ConnectEvent = { id: string; label: string; data: Record<string, unknown> };
export type Input = Record<string, string>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Http = (method: Method, where: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown }) => Promise<any>;
export type Ctx = { cred: Record<string, string>; http: Http; event?: Record<string, unknown> };
export type Operation = {
  id: string; name: string; description: string; kind: "read" | "write"; risk: "baja" | "media" | "alta";
  params: Param[]; run: (c: Ctx, input: Input) => Promise<Record<string, unknown>>;
};
export type PollResult = { events: ConnectEvent[]; state: unknown; baseline?: number };
export type TriggerDef = {
  id: string; name: string; description: string; params: Param[]; fields: EventField[]; every: number;
  poll: (c: Ctx, input: Input, state: any) => Promise<PollResult>;
};
export type Connector = {
  id: string; name: string; provider: string; description: string; version: string; color: string;
  docs: string; verified: string; scopes: string[]; data: string;
  fields: CredField[];
  base: (cred: Record<string, string>) => string;
  headers: (cred: Record<string, string>) => Record<string, string>;
  /** A read-only check; returns what the account is, in a few words. */
  test: (c: Ctx) => Promise<string>;
  operations: Operation[]; triggers: TriggerDef[];
  /** Query parameters every request carries (a custom connection whose key goes in the address). */
  query?: (cred: Record<string, string>) => Record<string, string>;
  /** Webhook and custom connections: the address may only be on the Internet, never this computer or the local network. */
  publicOnly?: boolean;
  /** Custom connections («＋ Añadir conexión», connect-custom.ts): what NEXUS AI warned about and where it read it. */
  custom?: { notices: string[]; sources: string[]; by: "persona" | "nexus-ai"; host: string };
};

export const LIMITS = { input: 2000, listItems: 20, events: 20, response: 5 << 20, timeoutMs: 30_000, retryWaitMs: 20_000 };
const UA = "NEXUS-OS/0.2 (NEXUS Connect)";

export class ConnectError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

// ------------------------------------------------------------------ helpers shared by the connectors
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const fmtN = (n: number) => n.toLocaleString("es-ES");
const GHL_TAG_MAX = 1000;
const list = (s: string | undefined) => str(s).split(",").map((x) => x.trim()).filter(Boolean).slice(0, LIMITS.listItems);

/** {{cliente.email}} → the value in the event (empty when missing). Only dotted names: no expressions. */
export function render(template: string, data: Record<string, unknown> | undefined): string {
  return str(template).replace(/\{\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\}\}/g, (_m, key: string) => {
    let v: any = data;
    for (const part of key.split(".")) v = v && typeof v === "object" && Object.hasOwn(v, part) ? v[part] : undefined;
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Keeps the declared parameters only, as trimmed strings. */
export function cleanInput(params: Param[], input: unknown): Input {
  const src = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const out: Input = {};
  for (const p of params) {
    const v = str(src[p.key]).replace(/\r\n?/g, "\n").trim();
    if (v.length > LIMITS.input) throw new ConnectError(`«${p.label}» es demasiado largo`);
    if (v) out[p.key] = v;
  }
  return out;
}

/** First poll: remember what exists, fire nothing. Later: what is new, oldest first, at most `max` (the rest wait). */
export function newOnes<T>(state: any, items: T[], key: (x: T) => string, cap: number, max = LIMITS.events, order?: (a: T, b: T) => number) {
  const ready = state?.ready === true;
  const seen = new Set<string>(Array.isArray(state?.seen) ? state.seen.map(String) : []);
  let fresh = ready ? items.filter((x) => !seen.has(key(x))) : [];
  if (order) fresh = [...fresh].sort(order);
  const later = new Set(fresh.slice(max).map(key));
  fresh = fresh.slice(0, max);
  for (const x of items) if (!later.has(key(x))) { seen.delete(key(x)); seen.add(key(x)); }
  return { fresh, state: { ready: true, seen: [...seen].slice(-cap) }, baseline: ready ? undefined : items.length };
}

function isPrivateIp(ip: string): boolean {
  const v4 = (s: string) => {
    const [a, b] = s.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  };
  if (net.isIPv4(ip)) return v4(ip);
  const s = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4(mapped[1]);
  return s === "::" || s === "::1" || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
}

// ------------------------------------------------------------------ GoHighLevel (API v2)
// Verified 09-11-2026 against the official OpenAPI spec (github.com/GoHighLevel/highlevel-api-docs, apps/contacts.json and
// apps/opportunities.json) and against working code that already used these APIs.
const ghlName = (c: any) => str(c?.contactName || c?.name || [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.companyName || c?.email || c?.phone).trim();
const ghlContact = (c: any) => ({
  id: str(c?.id), nombre: ghlName(c), email: str(c?.email), telefono: str(c?.phone), empresa: str(c?.companyName),
  etiquetas: Array.isArray(c?.tags) ? c.tags.join(", ") : "", alta: str(c?.dateAdded),
});
const WHO: Param[] = [
  { key: "email", label: "Email del contacto", example: "{{cliente.email}}" },
  { key: "telefono", label: "Teléfono del contacto", help: "Con el email basta; si no hay email, el teléfono." },
];
async function ghlUpsert(c: Ctx, i: Input): Promise<{ id: string; nuevo: boolean }> {
  if (!i.email && !i.telefono) throw new ConnectError("hace falta el email o el teléfono del contacto (han llegado vacíos)");
  const body: Record<string, unknown> = { locationId: c.cred.locationId };
  if (i.email) body.email = i.email;
  if (i.telefono) body.phone = i.telefono;
  if (i.nombre) body.firstName = i.nombre;
  if (i.apellidos) body.lastName = i.apellidos;
  if (i.empresa) body.companyName = i.empresa;
  if (i.ciudad) body.city = i.ciudad;
  if (i.origen) body.source = i.origen;
  // never `tags` here: in an upsert they REPLACE every tag the contact had (GoHighLevel's spec). Tags go through
  // POST /contacts/{id}/tags, which only adds.
  const r = await c.http("POST", "/contacts/upsert", { body });
  const id = str(r?.contact?.id ?? r?.id);
  if (!id) throw new ConnectError("GoHighLevel no ha devuelto el contacto");
  return { id, nuevo: r?.new === true };
}
async function ghlAddTags(c: Ctx, id: string, tags: string[]) {
  if (tags.length) await c.http("POST", `/contacts/${encodeURIComponent(id)}/tags`, { body: { tags } });
}
const ghlSearchTag = (c: Ctx, tag: string, page: number, pageLimit: number) =>
  c.http("POST", "/contacts/search", { body: { locationId: c.cred.locationId, page, pageLimit, filters: [{ field: "tags", operator: "contains", value: [tag] }] } });
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const GHL: Connector = {
  id: "ghl", name: "GoHighLevel", provider: "HighLevel Inc. · API v2 (services.leadconnectorhq.com)", version: "1", color: "#1d6bff",
  description: "Tu CRM: contactos, etiquetas, notas y embudos de venta.",
  docs: "https://marketplace.gohighlevel.com/docs/",
  verified: "Rutas, cuerpos y permisos comprobados con la especificación OpenAPI oficial de GoHighLevel (GitHub, 9-11-2026) y con tus propias rutinas, que ya las usan.",
  scopes: ["contacts.readonly", "contacts.write", "opportunities.readonly", "opportunities.write"],
  data: "Lee y escribe contactos de la subcuenta (nombre, email, teléfono, empresa, etiquetas y notas) y crea oportunidades en sus embudos.",
  fields: [
    { key: "token", label: "Token de integración privada", secret: true, pattern: /^[A-Za-z0-9._-]{20,4000}$/, example: "pit-…",
      help: "En GoHighLevel: Ajustes → Integraciones privadas → Crear. Dale permiso para ver y editar contactos y oportunidades." },
    { key: "locationId", label: "ID de la subcuenta (Location ID)", secret: false, pattern: /^[A-Za-z0-9]{10,40}$/,
      help: "En GoHighLevel: Ajustes → Perfil de la empresa → Location ID." },
  ],
  base: () => "https://services.leadconnectorhq.com",
  headers: (cred) => ({ authorization: `Bearer ${cred.token}`, version: "2021-07-28", accept: "application/json" }),
  test: async (c) => {
    const parts: string[] = []; let ok = false; let last: unknown = null;
    try {
      const s = await c.http("POST", "/contacts/search", { body: { locationId: c.cred.locationId, page: 1, pageLimit: 1 } });
      const t = Number(s?.total ?? s?.count); ok = true;
      if (Number.isFinite(t)) parts.push(`${fmtN(t)} contactos`);
    } catch (e: any) { if (e?.status === 401) throw e; last = e; if (e?.status === 403) parts.push("sin permiso para ver contactos"); }
    try {
      const p = await c.http("GET", "/opportunities/pipelines", { query: { locationId: c.cred.locationId } });
      const n = Array.isArray(p?.pipelines) ? p.pipelines.length : 0; ok = true;
      parts.push(`${n} ${n === 1 ? "embudo" : "embudos"}`);
    } catch (e: any) { if (e?.status === 401) throw e; last = e; if (e?.status === 403) parts.push("sin permiso para ver embudos"); }
    if (!ok) throw last;
    return `Subcuenta ${c.cred.locationId} · ${parts.join(" · ")}`;
  },
  operations: [
    {
      id: "contacto", name: "Crear o actualizar un contacto", kind: "write", risk: "media",
      description: "Si ya existe (mismo email o teléfono) lo actualiza; si no, lo crea. Las etiquetas se añaden, nunca se quitan las que tenía.",
      params: [...WHO, { key: "nombre", label: "Nombre", example: "{{cliente.nombre}}" }, { key: "apellidos", label: "Apellidos" },
        { key: "empresa", label: "Empresa", example: "{{cliente.nombre}}" }, { key: "ciudad", label: "Ciudad", example: "{{cliente.ciudad}}" },
        { key: "origen", label: "Origen", example: "Wiwink" }, { key: "etiquetas", label: "Etiquetas que añadir", list: true, example: "cliente, wiwink" }],
      run: async (c, i) => {
        const r = await ghlUpsert(c, i); const tags = list(i.etiquetas);
        await ghlAddTags(c, r.id, tags);
        return { contacto_id: r.id, nuevo: r.nuevo, etiquetas_anadidas: tags.join(", ") };
      },
    },
    {
      id: "etiquetas", name: "Añadir etiquetas a un contacto", kind: "write", risk: "baja",
      description: "Busca el contacto por email o teléfono (si no existe, lo crea) y le añade etiquetas sin quitar las que ya tenía.",
      params: [...WHO, { key: "etiquetas", label: "Etiquetas", list: true, required: true, example: "cliente" }],
      run: async (c, i) => {
        const tags = list(i.etiquetas); if (!tags.length) throw new ConnectError("faltan las etiquetas");
        const r = await ghlUpsert(c, i); await ghlAddTags(c, r.id, tags);
        return { contacto_id: r.id, nuevo: r.nuevo, etiquetas_anadidas: tags.join(", ") };
      },
    },
    {
      id: "nota", name: "Añadir una nota a un contacto", kind: "write", risk: "baja",
      description: "Busca el contacto por email o teléfono (si no existe, lo crea) y le deja una nota.",
      params: [...WHO, { key: "nota", label: "Nota", required: true, example: "Factura {{factura.numero}}: {{factura.total}} €" }],
      run: async (c, i) => {
        const r = await ghlUpsert(c, i);
        const n = await c.http("POST", `/contacts/${encodeURIComponent(r.id)}/notes`, { body: { body: i.nota } });
        return { contacto_id: r.id, nota_id: str(n?.note?.id ?? n?.id) };
      },
    },
    {
      id: "oportunidad", name: "Crear una oportunidad en un embudo", kind: "write", risk: "media",
      description: "Crea una oportunidad abierta para el contacto (si no existe, lo crea) en el embudo y la etapa que digas, por nombre.",
      params: [...WHO, { key: "embudo", label: "Embudo", required: true, help: "Su nombre tal como sale en GoHighLevel." },
        { key: "etapa", label: "Etapa", help: "Vacío: la primera etapa del embudo." },
        { key: "titulo", label: "Título", required: true, example: "Pedido {{factura.numero}}" },
        { key: "valor", label: "Valor (€)", example: "{{factura.base}}" }],
      run: async (c, i) => {
        const p = await c.http("GET", "/opportunities/pipelines", { query: { locationId: c.cred.locationId } });
        const pipes: any[] = Array.isArray(p?.pipelines) ? p.pipelines : [];
        const pipe = pipes.find((x) => x?.id === i.embudo) ?? pipes.find((x) => fold(str(x?.name)) === fold(i.embudo));
        if (!pipe) throw new ConnectError(`no hay ningún embudo «${i.embudo}» (hay: ${pipes.map((x) => str(x?.name)).join(", ") || "ninguno"})`);
        const stages: any[] = Array.isArray(pipe.stages) ? pipe.stages : [];
        const stage = i.etapa ? stages.find((s) => s?.id === i.etapa) ?? stages.find((s) => fold(str(s?.name)) === fold(i.etapa)) : stages[0];
        if (!stage) throw new ConnectError(`el embudo «${str(pipe.name)}» no tiene la etapa «${i.etapa ?? ""}» (tiene: ${stages.map((s) => str(s?.name)).join(", ")})`);
        const value = i.valor ? Number(i.valor.replace(/\s|€/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".")) : undefined;
        if (i.valor && !Number.isFinite(value)) throw new ConnectError(`el valor «${i.valor}» no es un número`);
        const who = await ghlUpsert(c, i);
        const body: Record<string, unknown> = { pipelineId: pipe.id, locationId: c.cred.locationId, name: i.titulo, pipelineStageId: stage.id, status: "open", contactId: who.id };
        if (value !== undefined) body.monetaryValue = value;
        const r = await c.http("POST", "/opportunities/", { body });
        return { oportunidad_id: str(r?.opportunity?.id ?? r?.id), contacto_id: who.id, embudo: str(pipe.name), etapa: str(stage.name) };
      },
    },
    {
      id: "buscar", name: "Buscar contactos con una etiqueta", kind: "read", risk: "baja",
      description: "Cuenta los contactos que tienen la etiqueta y enseña los primeros 10.",
      params: [{ key: "etiqueta", label: "Etiqueta", required: true }],
      run: async (c, i) => {
        const r = await ghlSearchTag(c, i.etiqueta, 1, 10);
        const contacts = (Array.isArray(r?.contacts) ? r.contacts : []).map(ghlContact);
        return { total: Number(r?.total ?? r?.count ?? contacts.length) || 0, contactos: contacts };
      },
    },
  ],
  triggers: [
    {
      id: "etiqueta", name: "Un contacto recibe una etiqueta", every: 5,
      description: "Avisa por cada contacto que tenga la etiqueta y antes no la tenía (los que ya la tenían al crear la automatización no cuentan).",
      params: [{ key: "etiqueta", label: "Etiqueta", required: true, example: "pedido" }],
      fields: [{ key: "contacto.nombre", label: "Nombre" }, { key: "contacto.email", label: "Email" }, { key: "contacto.telefono", label: "Teléfono" },
        { key: "contacto.empresa", label: "Empresa" }, { key: "contacto.etiquetas", label: "Etiquetas" }, { key: "contacto.id", label: "ID" }],
      poll: async (c, i, state) => {
        // Every contact with the tag must be read on every check: reading only part of a big list (the search has no
        // stable order) would make old contacts look new and fire false actions. So: at most 1.000, or a clear error.
        const all: any[] = [];
        for (let page = 1; page <= 10; page++) {
          const r = await ghlSearchTag(c, i.etiqueta, page, 100);
          const total = Number(r?.total);
          if (page === 1 && Number.isFinite(total) && total > GHL_TAG_MAX)
            throw new ConnectError(`la etiqueta «${i.etiqueta}» la tienen ${fmtN(total)} contactos y NEXUS solo puede vigilar etiquetas de hasta ${fmtN(GHL_TAG_MAX)} (usa una más concreta, por ejemplo una que pongas al hacer un pedido)`);
          const got = Array.isArray(r?.contacts) ? r.contacts : [];
          all.push(...got); if (got.length < 100) break;
          if (page === 10) throw new ConnectError(`la etiqueta «${i.etiqueta}» la tienen más de ${fmtN(GHL_TAG_MAX)} contactos y NEXUS solo puede vigilar etiquetas de hasta ${fmtN(GHL_TAG_MAX)}`);
        }
        const n = newOnes(state, all.filter((x) => x?.id), (x) => str(x.id), 10_000, LIMITS.events, (a, b) => str(a?.dateAdded).localeCompare(str(b?.dateAdded)));
        return { state: n.state, baseline: n.baseline, events: n.fresh.map((x) => { const k = ghlContact(x); return { id: k.id, label: k.nombre || k.email || k.id, data: { contacto: k } }; }) };
      },
    },
  ],
};

// ------------------------------------------------------------------ Wiwink (developers.wiwink.com)
// Customers and contacts: the official documentation (wiwink.readme.io, OpenAPI 3.1, 09-11-2026). /billing is not in the
// public documentation; the person's daily synchronisation routine reads it every day (latest 100 invoices, headers only).
const wwName = (c: any) => str(c?.corporate_name || c?.trade_name).replace(/^\*+/, "").trim();
const wwCustomer = (c: any) => ({
  id: str(c?.id), nombre: wwName(c), nombre_comercial: str(c?.trade_name), email: str(c?.email), telefono: str(c?.phone),
  nif: str(c?.vat), direccion: str(c?.address), ciudad: str(c?.city), cp: str(c?.zipcode), alta: str(c?.date),
});
const wwBill = (b: any) => ({
  numero: str(b?.full_number), fecha: str(b?.emission_at), vencimiento: str(b?.expiration_at), cliente_id: str(b?.customer_id),
  base: str(b?.taxable_amount), impuestos: str(b?.tax_amount), total: str(b?.full_amount),
});
const CUSTOMER_FIELDS: EventField[] = [
  { key: "cliente.nombre", label: "Nombre del cliente" }, { key: "cliente.email", label: "Email" }, { key: "cliente.telefono", label: "Teléfono" },
  { key: "cliente.nif", label: "NIF" }, { key: "cliente.ciudad", label: "Ciudad" }, { key: "cliente.cp", label: "Código postal" },
  { key: "cliente.direccion", label: "Dirección" }, { key: "cliente.id", label: "ID en Wiwink" },
];
const dateDaysAgo = (n: number, now = new Date()) => { const d = new Date(now); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

export const WIWINK: Connector = {
  id: "wiwink", name: "Wiwink", provider: "Wiwink · API (developers.wiwink.com)", version: "1", color: "#f0603c",
  description: "Tu facturación: clientes y facturas; también contactos del CRM de Wiwink.",
  docs: "https://wiwink.readme.io/",
  verified: "Clientes y contactos: documentación oficial de Wiwink (9-11-2026). Facturas: no salen en la documentación pública, pero tu rutina diaria de sincronización las lee cada día.",
  scopes: ["clave de API de la cuenta (acceso completo de la cuenta)"],
  data: "Lee clientes (nombre, NIF, email, teléfono, dirección) y facturas (número, fechas e importes; sin líneas de producto) y crea contactos.",
  fields: [
    { key: "token", label: "Clave de la API de Wiwink", secret: true, pattern: /^[\x21-\x7e]{20,4000}$/,
      help: "La clave de API de tu cuenta de Wiwink (la misma que usa tu rutina de sincronización). Si no la tienes, pídela al soporte de Wiwink." },
  ],
  base: () => "https://developers.wiwink.com/api",
  headers: (cred) => ({ authorization: `Bearer ${cred.token}`, accept: "application/json" }),
  test: async (c) => {
    const r = await c.http("GET", "/customers");
    const total = Number(r?.meta?.total);
    return Number.isFinite(total) ? `${fmtN(total)} clientes` : "Cuenta conectada";
  },
  operations: [
    {
      id: "buscar_cliente", name: "Buscar un cliente", kind: "read", risk: "baja",
      description: "Busca un cliente por email, NIF o teléfono (el primero que coincida).",
      params: [{ key: "email", label: "Email" }, { key: "nif", label: "NIF" }, { key: "telefono", label: "Teléfono" }],
      run: async (c, i) => {
        const query = i.email ? { email: i.email } : i.nif ? { vat: i.nif } : i.telefono ? { phone: i.telefono } : null;
        if (!query) throw new ConnectError("pon el email, el NIF o el teléfono");
        const r = await c.http("GET", "/customers", { query });
        const first = Array.isArray(r?.data) ? r.data[0] : undefined;
        return first ? { encontrado: true, cliente: wwCustomer(first) } : { encontrado: false };
      },
    },
    {
      id: "crear_contacto", name: "Crear un contacto en el CRM", kind: "write", risk: "media",
      description: "Crea un contacto (no un cliente de facturación) en Wiwink.",
      params: [{ key: "nombre", label: "Nombre", required: true, example: "{{contacto.nombre}}" }, { key: "email", label: "Email", example: "{{contacto.email}}" },
        { key: "telefono", label: "Teléfono", example: "{{contacto.telefono}}" }, { key: "empresa", label: "Empresa (razón social)", example: "{{contacto.empresa}}" },
        { key: "ciudad", label: "Ciudad" }, { key: "descripcion", label: "Descripción", example: "Lead de GoHighLevel" }],
      run: async (c, i) => {
        const body: Record<string, unknown> = { name: i.nombre };
        if (i.email) body.email = i.email; if (i.telefono) body.phone = i.telefono; if (i.empresa) body.corporate_name = i.empresa;
        if (i.ciudad) body.city = i.ciudad; if (i.descripcion) body.description = i.descripcion;
        const r = await c.http("POST", "/contacts", { body });
        return { contacto_id: str(r?.data?.id) };
      },
    },
  ],
  triggers: [
    {
      id: "factura", name: "Factura nueva", every: 10,
      description: "Avisa por cada factura que aparezca en Wiwink, con los datos de su cliente (las que ya había al crear la automatización no cuentan).",
      params: [],
      fields: [{ key: "factura.numero", label: "Número de factura" }, { key: "factura.fecha", label: "Fecha" }, { key: "factura.base", label: "Base imponible" },
        { key: "factura.impuestos", label: "Impuestos" }, { key: "factura.total", label: "Total" }, { key: "factura.vencimiento", label: "Vencimiento" }, ...CUSTOMER_FIELDS],
      poll: async (c, _i, state) => {
        const r = await c.http("GET", "/billing");
        const bills = (Array.isArray(r?.data) ? r.data : []).filter((b: any) => b?.full_number);
        const n = newOnes(state, bills, (b: any) => str(b.full_number), 3000, LIMITS.events,
          (a: any, b: any) => str(a.emission_at).localeCompare(str(b.emission_at)) || str(a.full_number).localeCompare(str(b.full_number)));
        const customers = new Map<string, Record<string, string>>();
        const events: ConnectEvent[] = [];
        for (const b of n.fresh as any[]) {
          const cid = str(b.customer_id);
          if (cid && !customers.has(cid)) {
            try { customers.set(cid, wwCustomer((await c.http("GET", `/customers/${encodeURIComponent(cid)}`))?.data)); }
            catch (e: any) { if (e?.status !== 404) throw e; customers.set(cid, { id: cid }); } // a deleted customer must not block the rest
          }
          const cl = customers.get(cid) ?? {};
          events.push({ id: str(b.full_number), label: `Factura ${str(b.full_number)}${cl.nombre ? " · " + cl.nombre : ""}`, data: { factura: wwBill(b), cliente: cl } });
        }
        return { events, state: n.state, baseline: n.baseline };
      },
    },
    {
      id: "cliente", name: "Cliente nuevo", every: 30,
      description: "Avisa por cada cliente nuevo dado de alta en Wiwink en los últimos 30 días (los que ya había al crear la automatización no cuentan).",
      params: [],
      fields: CUSTOMER_FIELDS,
      poll: async (c, _i, state) => {
        const since = dateDaysAgo(30);
        const all: any[] = [];
        for (let page = 1; page <= 5; page++) {
          const r = await c.http("GET", "/customers", { query: { since, page } });
          all.push(...(Array.isArray(r?.data) ? r.data : []));
          if (page >= (Number(r?.meta?.last_page) || 1)) break;
        }
        const n = newOnes(state, all.filter((x) => x?.id !== undefined), (x) => str(x.id), 5000, LIMITS.events, (a, b) => Number(a.id) - Number(b.id));
        return { state: n.state, baseline: n.baseline, events: n.fresh.map((x) => { const k = wwCustomer(x); return { id: k.id, label: k.nombre || k.email || k.id, data: { cliente: k } }; }) };
      },
    },
  ],
};

// ------------------------------------------------------------------ Webhook (any service with incoming webhooks)
export const WEBHOOK: Connector = {
  id: "webhook", name: "Webhook", provider: "Cualquier servicio con webhooks de entrada (Slack, Make, n8n, Zapier…)", version: "1", color: "#8b5cf6",
  description: "Envía un mensaje y los datos del evento a una dirección web.",
  docs: "https://api.slack.com/messaging/webhooks",
  verified: "Envía un POST con JSON {text, datos} a la dirección que pongas. Nunca a este equipo ni a tu red local.",
  scopes: ["ninguno: solo la dirección que pongas"],
  data: "Envía el mensaje que escribas y los datos del evento que disparó la automatización.",
  fields: [
    { key: "url", label: "Dirección del webhook (https)", secret: true, pattern: /^https:\/\/\S{8,2000}$/,
      help: "La dirección que te da el servicio (Slack: Incoming Webhooks; Make, n8n o Zapier: un disparador «Webhook»). Trátala como una contraseña." },
    { key: "secreto", label: "Clave para la cabecera Authorization (opcional)", secret: true, optional: true, pattern: /^[\x21-\x7e]{8,500}$/,
      help: "Solo si el servicio la pide: se envía como «Authorization: Bearer …»." },
  ],
  base: (cred) => cred.url,
  headers: (cred) => (cred.secreto ? { authorization: `Bearer ${cred.secreto}` } : {}),
  publicOnly: true,
  test: async (c) => `Enviará a ${new URL(c.cred.url).host} (no se envía nada hasta que una automatización lo use)`,
  operations: [
    {
      id: "enviar", name: "Enviar un mensaje", kind: "write", risk: "baja",
      description: "Envía el mensaje y los datos del evento como JSON {text, datos}.",
      params: [{ key: "texto", label: "Mensaje", required: true, example: "Factura nueva de {{cliente.nombre}}: {{factura.total}} €" }],
      run: async (c, i) => { await c.http("POST", "", { body: { text: i.texto, datos: c.event ?? null } }); return { enviado: true }; },
    },
  ],
  triggers: [],
};

export const CONNECTORS: Connector[] = [GHL, WIWINK, WEBHOOK];

/** What the desktop and NEXUS AI may know about a connector (never a credential). */
export function describeConnector(c: Connector, saved?: { account?: string; at?: string } | null) {
  return {
    id: c.id, name: c.name, provider: c.provider, description: c.description, version: c.version, color: c.color,
    docs: c.docs, verified: c.verified, scopes: c.scopes, data: c.data,
    fields: c.fields.map(({ key, label, help, secret, optional, example }) => ({ key, label, help, secret, optional: optional === true, example: example ?? "" })),
    connected: !!saved, account: saved?.account ?? "", connectedAt: saved?.at ?? null,
    operations: c.operations.map(({ id, name, description, kind, risk, params }) => ({ id, name, description, kind, risk, params })),
    triggers: c.triggers.map(({ id, name, description, params, fields, every }) => ({ id, name, description, params, fields, every })),
    custom: c.custom ? { ...c.custom } : null,
  };
}
export type ConnectorInfo = ReturnType<typeof describeConnector>;

// ------------------------------------------------------------------ the service (inside the Engine)
type Saved = { values: Record<string, string>; account: string; at: string };
export type ConnectOptions = {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  lookup?: (host: string) => Promise<string[]>;
  gapMs?: number;
  connectors?: Connector[];
  /** The person's own connections (connect-custom.ts); they join the catalog after the built-in ones. */
  custom?: CustomConnections;
};

export class Connect {
  private file: string;
  private lanes = new Map<string, { last: number; chain: Promise<unknown> }>();
  private builtins: Connector[];
  constructor(dataDir: string, private audit: Audit, private o: ConnectOptions = {}) {
    this.file = path.join(dataDir, "connect.json");
    this.builtins = o.connectors ?? CONNECTORS;
  }
  get catalog(): Connector[] {
    const own = this.o.custom?.connectors() ?? [];
    return own.length ? [...this.builtins, ...own.filter((c) => !this.builtins.some((b) => b.id === c.id))] : this.builtins;
  }
  private read(): Record<string, Saved> {
    try { const v = JSON.parse(fs.readFileSync(this.file, "utf8")); return v && typeof v.connectors === "object" ? v.connectors : {}; } catch { return {}; }
  }
  private write(all: Record<string, Saved>) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, connectors: all }), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  private get(id: string): Connector {
    const c = this.catalog.find((x) => x.id === id);
    if (!c) throw new ConnectError(`no hay ningún conector «${id}»`, 404);
    return c;
  }
  private sleep(ms: number) { return this.o.sleep ? this.o.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)); }

  view() { const saved = this.read(); return { connectors: this.catalog.map((c) => describeConnector(c, saved[c.id])) }; }

  /** Checks the values, makes a read-only call with them and only then keeps them. */
  async connect(id: string, values: unknown) {
    const c = this.get(id);
    const src = values && typeof values === "object" ? (values as Record<string, unknown>) : {};
    const prev = this.read()[id]?.values ?? {};
    const v: Record<string, string> = {};
    for (const f of c.fields) {
      let s = str(src[f.key]).trim();
      if (!s && f.secret && prev[f.key] && !f.optional) s = prev[f.key]; // reconnecting: a blank secret keeps the saved one
      if (!s) { if (f.optional) continue; throw new ConnectError(`falta «${f.label}»`, 400); }
      if (!f.pattern.test(s)) throw new ConnectError(`«${f.label}» no tiene el formato esperado`, 400);
      v[f.key] = s;
    }
    if (c.publicOnly) await this.checkPublic(new URL(c.base(v)));
    const account = await c.test(this.ctx(c, v, "probar"));
    const all = this.read();
    all[id] = { values: v, account: account.slice(0, 200), at: new Date().toISOString() };
    this.write(all);
    this.audit.record("connect.connected", { connector: id }); // never the values
    return describeConnector(c, all[id]);
  }
  disconnect(id: string) {
    const c = this.get(id); const all = this.read();
    if (all[id]) { delete all[id]; this.write(all); this.audit.record("connect.disconnected", { connector: id }); }
    return describeConnector(c, null);
  }
  private saved(c: Connector): Saved {
    const s = this.read()[c.id];
    if (!s) throw new ConnectError(`${c.name} no está conectado: conéctalo en la app Conexiones`, 409);
    return s;
  }
  async test(id: string) {
    const c = this.get(id); const s = this.saved(c);
    const account = await c.test(this.ctx(c, s.values, "probar"));
    const all = this.read(); if (all[id]) { all[id].account = account.slice(0, 200); this.write(all); }
    return { ok: true, account };
  }
  /** Runs one operation. Writes only for automations (the person created and reviewed them). */
  async run(id: string, opId: string, input: unknown, event: Record<string, unknown> | undefined, origin: "automation" | "app") {
    const c = this.get(id);
    const op = c.operations.find((x) => x.id === opId);
    if (!op) throw new ConnectError(`${c.name} no sabe hacer «${opId}»`, 404);
    if (op.kind === "write" && origin !== "automation") throw new ConnectError("las operaciones que cambian datos solo se ejecutan desde una automatización que hayas creado", 403);
    const raw = cleanInput(op.params, input);
    const ready: Input = {};
    for (const p of op.params) {
      const v = raw[p.key] !== undefined ? render(raw[p.key], event).trim() : "";
      if (v) ready[p.key] = v;
      else if (p.required) throw new ConnectError(raw[p.key] ? `«${p.label}» ha quedado vacío: el evento no traía ${raw[p.key]}` : `falta «${p.label}»`, 400);
    }
    const s = this.saved(c);
    const output = await op.run({ ...this.ctx(c, s.values, op.id), event }, ready);
    return { ok: true, output };
  }
  async poll(id: string, triggerId: string, input: unknown, state: unknown): Promise<PollResult> {
    const c = this.get(id);
    const t = c.triggers.find((x) => x.id === triggerId);
    if (!t) throw new ConnectError(`${c.name} no puede vigilar «${triggerId}»`, 404);
    const i = cleanInput(t.params, input);
    for (const p of t.params) if (p.required && !i[p.key]) throw new ConnectError(`falta «${p.label}»`, 400);
    const s = this.saved(c);
    return t.poll(this.ctx(c, s.values, "vigilar:" + t.id), i, state);
  }

  private async checkPublic(u: URL) {
    if (u.protocol !== "https:") throw new ConnectError("la dirección tiene que empezar por https://", 400);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (/^localhost$|\.(local|localhost|internal|lan|home)$/i.test(host)) throw new ConnectError(LOCAL_ONLY, 400);
    const addrs = net.isIP(host) ? [host] : await (this.o.lookup ?? (async (h: string) => (await dns.lookup(h, { all: true })).map((a) => a.address)))(host).catch(() => []);
    if (!addrs.length) throw new ConnectError(`no encuentro ${host} en Internet`, 400);
    if (addrs.some(isPrivateIp)) throw new ConnectError(LOCAL_ONLY, 400);
  }

  // ---- the person's own connections («＋ Añadir conexión»)
  private customStore(): CustomConnections {
    if (!this.o.custom) throw new ConnectError("este equipo no admite conexiones personalizadas", 404);
    return this.o.custom;
  }
  /** The description of one of the person's connections, to edit it (it never holds a key). */
  customSpec(id: string): CustomSpec {
    const sp = this.customStore().get(id);
    if (!sp) throw new ConnectError(`no hay ninguna conexión personalizada «${id}»`, 404);
    return sp;
  }
  /** Creates or updates one. A new address or a new way of sending the key forgets the saved key. */
  async saveCustom(input: unknown) {
    const store = this.customStore();
    const specs = store.list();
    const wanted = String((input as any)?.id ?? "");
    const existing = wanted ? specs.find((x) => x.id === wanted) : undefined;
    if (wanted && !existing) throw new ConnectError("esa conexión ya no existe", 404);
    if (!existing && specs.length >= CUSTOM_LIMITS.specs) throw new ConnectError(`ya tienes ${CUSTOM_LIMITS.specs} conexiones personalizadas: borra alguna antes`, 400);
    const taken = [...this.builtins.map((b) => b.id), ...specs.map((x) => x.id)];
    const sp = validateSpec(input, taken, existing);
    await this.checkPublic(new URL(sp.base));
    toConnector(sp); // must build
    const reset = !!existing && keyMustReset(existing, sp);
    store.write(existing ? specs.map((x) => (x.id === sp.id ? sp : x)) : [...specs, sp]);
    const all = this.read();
    if (reset && all[sp.id]) { delete all[sp.id]; this.write(all); this.audit.record("connect.disconnected", { connector: sp.id, why: "address-changed" }); }
    this.audit.record(existing ? "connect.custom.updated" : "connect.custom.created", { connector: sp.id, host: new URL(sp.base).host, by: sp.by, operations: sp.operations.length, triggers: sp.triggers.length });
    return { ...describeConnector(this.get(sp.id), reset ? null : all[sp.id]), keyReset: reset };
  }
  removeCustom(id: string) {
    const store = this.customStore();
    const specs = store.list();
    if (!specs.some((x) => x.id === id)) throw new ConnectError(`no hay ninguna conexión personalizada «${id}»`, 404);
    store.write(specs.filter((x) => x.id !== id));
    const all = this.read();
    if (all[id]) { delete all[id]; this.write(all); }
    this.audit.record("connect.custom.removed", { connector: id });
    return { removed: true };
  }
  /** A draft from NEXUS AI: what is wrong with it (if anything), so the form can say it before saving. */
  async checkDraft(input: unknown): Promise<string | null> {
    try {
      const taken = [...this.builtins.map((b) => b.id), ...(this.o.custom?.list() ?? []).map((x) => x.id)];
      const sp = validateSpec(input, taken);
      await this.checkPublic(new URL(sp.base));
      return null;
    } catch (e: any) { return String(e?.message ?? e); }
  }

  /** The only way a connector reaches the network: its own https origin, its own headers, one request at a time. */
  private ctx(c: Connector, cred: Record<string, string>, opName: string): Ctx {
    const fetchFn = this.o.fetchFn ?? fetch;
    const base = c.base(cred).replace(/\/+$/, "");
    const origin = new URL(base).origin;
    const http: Http = async (method, where, opts = {}) => {
      const u = new URL(base + where);
      if (u.origin !== origin || u.protocol !== "https:") throw new ConnectError("dirección no permitida para este conector");
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") u.searchParams.set(k, String(v));
      for (const [k, v] of Object.entries(c.query?.(cred) ?? {})) u.searchParams.set(k, v);
      if (c.publicOnly) await this.checkPublic(u);
      const headers: Record<string, string> = { "user-agent": UA, ...c.headers(cred) };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      return this.lane(c.id, async () => {
        for (let attempt = 1; ; attempt++) {
          const t0 = Date.now();
          let r: Response;
          try {
            r = await fetchFn(u, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(LIMITS.timeoutMs) });
          } catch (e: any) {
            this.audit.record("connect.call", { connector: c.id, op: opName, method, host: u.host, status: 0, ms: Date.now() - t0 });
            if (method === "GET" && attempt < 3) { await this.sleep(1500 * attempt); continue; }
            throw new ConnectError(`no he podido llegar a ${c.name} (${e?.name === "TimeoutError" ? "no responde" : "sin conexión"})`);
          }
          const text = await r.text();
          this.audit.record("connect.call", { connector: c.id, op: opName, method, host: u.host, status: r.status, ms: Date.now() - t0 });
          if (text.length > LIMITS.response) throw new ConnectError(`${c.name} ha respondido demasiados datos`);
          let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
          if (r.ok) return json ?? {};
          const retry = r.status === 429 || (method === "GET" && [502, 503, 504].includes(r.status));
          if (retry && attempt < 3) {
            const ra = Number(r.headers.get("retry-after"));
            await this.sleep(Math.min(LIMITS.retryWaitMs, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * attempt));
            continue;
          }
          throw new ConnectError(explain(c, r.status, apiMessage(json)), r.status);
        }
      });
    };
    return { cred, http };
  }
  private lane<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const l = this.lanes.get(id) ?? { last: 0, chain: Promise.resolve() };
    this.lanes.set(id, l);
    const p = l.chain.then(async () => {
      const wait = l.last + (this.o.gapMs ?? 150) - Date.now();
      if (wait > 0) await this.sleep(wait);
      try { return await fn(); } finally { l.last = Date.now(); }
    });
    l.chain = p.catch(() => undefined);
    return p;
  }
}

const LOCAL_ONLY = "esa dirección es de este equipo o de tu red local: NEXUS solo se conecta a servicios de Internet";

function apiMessage(j: any): string {
  const m = j?.message ?? j?.error?.message ?? j?.error ?? j?.msg ?? "";
  const s = Array.isArray(m) ? m.join("; ") : typeof m === "string" ? m : "";
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}
function explain(c: Connector, status: number, msg: string): string {
  const m = msg ? ` («${msg}»)` : "";
  if (status === 401) return `${c.name} no acepta la clave (401)${m}: puede estar mal copiada o haber caducado. Vuelve a conectarlo en Conexiones.`;
  if (status === 403) return `${c.name} no deja hacer esto con esta clave (403)${m}. Revisa que tenga estos permisos: ${c.scopes.join(", ")}.`;
  if (status === 404) return `${c.name} dice que eso no existe (404)${m}.`;
  if (status === 400 || status === 422) return `${c.name} no acepta los datos (${status})${m}.`;
  if (status === 429) return `${c.name} pide ir más despacio (429): demasiadas peticiones seguidas. Se volverá a intentar en la próxima vuelta.`;
  if (status >= 500) return `${c.name} tiene un problema ahora mismo (${status})${m}. Se volverá a intentar.`;
  return `${c.name} ha respondido ${status}${m}.`;
}
