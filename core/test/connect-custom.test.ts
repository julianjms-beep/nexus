// «＋ Añadir conexión»: the person's own connections are descriptions (data), checked before saving; the key only goes
// to the description's own public https host; editing the address forgets the key; drafts from NEXUS AI are only drafts.
// Everything talks to a fake fetch and a fake Claude client, never to real services.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Connect } from "../src/connect.ts";
import { CustomConnections, validateSpec, fromDraft } from "../src/connect-custom.ts";
import { createApp } from "../src/server.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-custom-"));
const KEY = "hk_live_0123456789abcdefSECRET";
type Req = { method: string; url: URL; headers: Record<string, string>; body: any };
type Rep = { status?: number; json?: unknown };
function fakeFetch(route: (r: Req) => Rep) {
  const calls: Req[] = [];
  const f = async (u: URL | string, init: any = {}) => {
    const r: Req = { method: init.method ?? "GET", url: new URL(String(u)), headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(r);
    const rep = route(r);
    return new Response(rep.json === undefined ? "" : JSON.stringify(rep.json), { status: rep.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetchFn: f as unknown as typeof fetch, calls };
}
let lookups: Record<string, string[]> = {};
function make(route: (r: Req) => Rep) {
  const dir = tmp();
  const audit = new Audit(path.join(dir, "audit.jsonl"));
  const { fetchFn, calls } = fakeFetch(route);
  lookups = {};
  const c = new Connect(dir, audit, { fetchFn, sleep: async () => {}, gapMs: 0, custom: new CustomConnections(dir), lookup: async (h) => lookups[h] ?? ["93.184.216.34"] });
  return { c, calls, dir };
}
const HOLDED = {
  name: "Holded", description: "Facturación y CRM.", docs: "https://developers.holded.com/reference",
  base: "https://api.holded.com/api/", auth: { kind: "header", name: "key" }, keyHelp: "Holded → Configuración → Desarrolladores.",
  test: "/invoicing/v1/contacts?limit=1",
  operations: [
    { name: "Ver un contacto", method: "GET", path: "/invoicing/v1/contacts/{{id}}", params: [{ key: "id", label: "ID", required: true }, { key: "extra", label: "Extra" }] },
    { name: "Crear un contacto", method: "POST", path: "/invoicing/v1/contacts", body: '{"name":"{{nombre}}","email":"{{email}}","tags":["nexus","{{origen}}"],"type":"client"}',
      params: [{ key: "nombre", label: "Nombre", required: true }, { key: "email", label: "Email" }, { key: "origen", label: "Origen" }] },
  ],
  triggers: [{ name: "Factura nueva", path: "/invoicing/v1/documents/invoice?sort=created-desc", list: "", idField: "id", labelField: "docNumber", fields: ["total", "contact.name"], every: 10, newestFirst: true }],
  notices: ["Hace falta el plan Básico o superior."], sources: ["https://developers.holded.com/reference/list-documents-1"], by: "nexus-ai",
};

test("validateSpec: Spanish errors for every unsafe or broken description; normalises what is fine", () => {
  const ok = validateSpec(HOLDED, []);
  assert.equal(ok.id, "x-holded"); assert.equal(ok.base, "https://api.holded.com/api");
  assert.deepEqual(ok.operations.map((o) => o.id), ["ver_un_contacto", "crear_un_contacto"]);
  assert.deepEqual(ok.triggers[0].fields, ["id", "docNumber", "total", "contact.name"], "id and label always travel with the event");
  assert.equal(ok.by, "nexus-ai");
  assert.equal(validateSpec(HOLDED, ["x-holded"]).id, "x-holded-2", "a second one with the same name gets its own id");
  const cases: [unknown, RegExp][] = [
    [{ ...HOLDED, name: "" }, /ponle un nombre/],
    [{ ...HOLDED, base: "http://api.holded.com" }, /https:\/\//],
    [{ ...HOLDED, base: "https://user:pw@api.holded.com" }, /usuario ni contraseña/],
    [{ ...HOLDED, base: "https://api.holded.com/api?key=1" }, /«\?» ni «#»/],
    [{ ...HOLDED, auth: { kind: "header", name: "Host" } }, /no puede ir en la cabecera «Host»/],
    [{ ...HOLDED, auth: { kind: "header", name: "" } }, /nombre de la cabecera/],
    [{ ...HOLDED, auth: { kind: "magic" } }, /cómo se envía la clave/],
    [{ ...HOLDED, test: "invoicing" }, /tiene que empezar por \//],
    [{ ...HOLDED, operations: [{ name: "Subir", method: "GET", path: "/a/../admin", params: [] }] }, /«\.\.»/],
    [{ ...HOLDED, operations: [{ name: "Raro", method: "GET", path: "/a b", params: [] }] }, /caracteres no válidos/],
    [{ ...HOLDED, operations: [{ name: "Crear", method: "POST", path: "/c", body: '{"a":"{{falta}}"}', params: [] }] }, /usa \{\{falta\}\}, pero no lo pide/],
    [{ ...HOLDED, operations: [{ name: "Crear", method: "POST", path: "/c", body: "{a:1}", params: [] }] }, /no es JSON válido/],
    [{ ...HOLDED, operations: [{ name: "Crear", method: "TRACE", path: "/c", params: [] }] }, /elige el método/],
    [{ ...HOLDED, operations: [{ name: "Ver", method: "GET", path: "/c", params: [{ key: "Mal Dato" }] }] }, /no vale como nombre de dato/],
    [{ ...HOLDED, triggers: [{ name: "Nuevos", path: "/x/{{id}}", idField: "id" }] }, /no puede pedir datos/],
    [{ ...HOLDED, triggers: [{ name: "Nuevos", path: "/x", idField: "" }] }, /campo que identifica/],
    [{ ...HOLDED, triggers: [{ name: "Nuevos", path: "/x", idField: "id", fields: ["a-b"] }] }, /no vale como campo/],
    [{ ...HOLDED, triggers: [{ name: "Nuevos", path: "/x", idField: "id", every: 1 }] }, /cada 5 a 1\.440/],
    [{ ...HOLDED, operations: [], triggers: [] }, /al menos una acción/],
  ];
  for (const [input, why] of cases) assert.throws(() => validateSpec(input, []), why, JSON.stringify(input).slice(0, 120));
});

test("a custom connection: saved, connected with a read, actions fill path and body safely, the key only goes to its host", async () => {
  const { c, calls, dir } = make((r) => {
    if (r.url.pathname === "/api/invoicing/v1/contacts" && r.method === "GET") return { json: [{ id: "c1" }] };
    if (r.url.pathname.startsWith("/api/invoicing/v1/contacts/") && r.method === "GET") return { json: { id: "c1", name: "Farmacia Sol", address: { city: "Murcia" }, tags: ["a", "b"] } };
    if (r.url.pathname === "/api/invoicing/v1/contacts" && r.method === "POST") return { status: 201, json: { status: 1, id: "NEW1", info: "Created" } };
    return { status: 404, json: { info: "Not found" } };
  });
  const saved = await c.saveCustom(HOLDED);
  assert.equal(saved.id, "x-holded"); assert.equal(saved.connected, false); assert.equal(saved.custom!.host, "api.holded.com");
  assert.equal(saved.provider, "Conexión personalizada · api.holded.com");
  assert.deepEqual(saved.fields.map((f) => [f.key, f.secret]), [["token", true]]);
  assert.deepEqual(saved.operations.map((o) => [o.id, o.kind, o.risk]), [["ver_un_contacto", "read", "baja"], ["crear_un_contacto", "write", "media"]]);
  assert.equal((fs.statSync(path.join(dir, "connect-custom.json")).mode & 0o777), 0o600);

  const info = await c.connect("x-holded", { token: KEY });
  assert.equal(info.connected, true); assert.match(info.account, /Conectado a api\.holded\.com · la comprobación devuelve 1 elemento/);
  assert.equal(calls[0].url.href, "https://api.holded.com/api/invoicing/v1/contacts?limit=1");
  assert.equal(calls[0].headers.key, KEY); assert.equal(calls[0].headers.authorization, undefined);

  const read = await c.run("x-holded", "ver_un_contacto", { id: "{{cliente.id}}", extra: "sí" }, { cliente: { id: "c 1/2" } }, "app");
  assert.equal(calls[1].url.pathname, "/api/invoicing/v1/contacts/c%201%2F2", "a value cannot add path segments");
  assert.equal(calls[1].url.searchParams.get("extra"), "sí", "GET: data not in the path goes in the query");
  assert.deepEqual(read.output, { id: "c1", name: "Farmacia Sol", "address.city": "Murcia", tags: "2 elementos" });
  await assert.rejects(c.run("x-holded", "ver_un_contacto", { id: ".." }, undefined, "app"), /no puede ser «\.\.»/);

  await assert.rejects(c.run("x-holded", "crear_un_contacto", { nombre: "Ana" }, undefined, "app"), (e: any) => e.status === 403, "writes only from automations");
  const w = await c.run("x-holded", "crear_un_contacto", { nombre: "{{cliente.nombre}}", email: "ana@x.es", origen: "wiwink" }, { cliente: { nombre: 'Ana "la de" Gil' } }, "automation");
  const post = calls[calls.length - 1];
  assert.deepEqual(post.body, { name: 'Ana "la de" Gil', email: "ana@x.es", tags: ["nexus", "wiwink"], type: "client" }, "placeholders fill string values; quotes cannot break the JSON");
  assert.deepEqual(w.output, { status: "1", id: "NEW1", info: "Created" });

  for (const r of calls) assert.equal(r.url.host, "api.holded.com");
  assert.ok(!JSON.stringify(c.view()).includes(KEY));
  assert.ok(!fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").includes(KEY));
  assert.ok(!fs.readFileSync(path.join(dir, "connect-custom.json"), "utf8").includes(KEY), "the description never holds the key");
});

test("key in the address and HTTP Basic; an action cannot overwrite the key parameter", async () => {
  const { c, calls } = make(() => ({ json: { ok: true } }));
  await c.saveCustom({ name: "Tiempo", base: "https://api.tiempo.example/v2", auth: { kind: "query", name: "api_key" }, test: "/yo",
    operations: [{ name: "Previsión", method: "GET", path: "/prevision", params: [{ key: "ciudad", required: true }, { key: "api_key" }] }] });
  await c.connect("x-tiempo", { token: KEY });
  await c.run("x-tiempo", "prevision", { ciudad: "Madrid", api_key: "otra" }, undefined, "app");
  const u = calls[calls.length - 1].url;
  assert.equal(u.searchParams.get("ciudad"), "Madrid"); assert.deepEqual(u.searchParams.getAll("api_key"), [KEY]);

  await c.saveCustom({ name: "Tienda", base: "https://tienda.example/wp-json/wc/v3", auth: { kind: "basic" }, test: "/system_status",
    operations: [{ name: "Pedidos", method: "GET", path: "/orders", params: [] }] });
  await c.connect("x-tienda", { usuario: "ck_123", token: "cs_456" });
  assert.equal(calls[calls.length - 1].headers.authorization, "Basic " + Buffer.from("ck_123:cs_456").toString("base64"));
});

test("watching a list: first look remembers, then only new items (oldest first, with their fields); a sudden mass of unseen items re-bases", async () => {
  let invoices: any = Array.from({ length: 20 }, (_, i) => ({ id: `F${20 - i}`, docNumber: `F-${20 - i}`, total: 100 + i, contact: { name: "Sol", nif: "x" } })); // newest first
  const { c } = make((r) => (r.url.pathname.endsWith("/documents/invoice") ? { json: invoices } : { json: [] }));
  await c.saveCustom(HOLDED);
  await c.connect("x-holded", { token: KEY });
  const p1 = await c.poll("x-holded", "factura_nueva", {}, undefined);
  assert.equal(p1.baseline, 20); assert.deepEqual(p1.events, []);
  invoices = [{ id: "F22", docNumber: "F-22", total: 7, contact: { name: "Luna", nif: "y" } }, { id: "F21", docNumber: "F-21", total: 5, contact: { name: "Mar", nif: "z" } }, ...invoices.slice(0, 18)];
  const p2 = await c.poll("x-holded", "factura_nueva", {}, p1.state);
  assert.deepEqual(p2.events.map((e) => [e.id, e.label]), [["F21", "F-21"], ["F22", "F-22"]], "oldest first");
  assert.deepEqual(p2.events[0].data, { elemento: { id: "F21", docNumber: "F-21", total: "5", contact: { name: "Mar" } } }, "only the declared fields travel");
  invoices = Array.from({ length: 20 }, (_, i) => ({ id: `Z${i}`, docNumber: `Z-${i}`, total: 1, contact: { name: "?" } }));
  const p3 = await c.poll("x-holded", "factura_nueva", {}, p2.state);
  assert.deepEqual(p3.events, [], "20 unseen out of 20: not trusted as new"); assert.equal(p3.baseline, 20);
  const p4 = await c.poll("x-holded", "factura_nueva", {}, p3.state);
  assert.deepEqual(p4.events, []);
  invoices = { data: [] };
  await assert.rejects(c.poll("x-holded", "factura_nueva", {}, p4.state), /no trae una lista en «la raíz»/);
});

test("editing: a new address forgets the key, a new name keeps it; removing deletes key and description; local hosts refused", async () => {
  const { c } = make(() => ({ json: [] }));
  await c.saveCustom(HOLDED);
  await c.connect("x-holded", { token: KEY });
  const renamed = await c.saveCustom({ ...HOLDED, id: "x-holded", name: "Holded (tienda)" });
  assert.equal(renamed.connected, true); assert.equal(renamed.keyReset, false); assert.equal(renamed.id, "x-holded", "the id stays");
  const moved = await c.saveCustom({ ...HOLDED, id: "x-holded", base: "https://evil.example.com/api" });
  assert.equal(moved.connected, false); assert.equal(moved.keyReset, true);
  await c.connect("x-holded", { token: KEY });
  const header = await c.saveCustom({ ...HOLDED, id: "x-holded", base: "https://evil.example.com/api", auth: { kind: "header", name: "X-Otra" } });
  assert.equal(header.keyReset, true, "another header also forgets the key");
  await assert.rejects(c.saveCustom({ ...HOLDED, id: "x-nada" }), /ya no existe/);
  lookups["intranet.example.com"] = ["10.0.0.5"];
  await assert.rejects(c.saveCustom({ ...HOLDED, name: "Intranet", base: "https://intranet.example.com" }), /red local/);
  await assert.rejects(c.saveCustom({ ...HOLDED, name: "Router", base: "https://router.local" }), /red local/);
  assert.deepEqual(c.removeCustom("x-holded"), { removed: true });
  assert.ok(!c.view().connectors.some((x) => x.id === "x-holded"));
  assert.throws(() => c.customSpec("x-holded"), /no hay ninguna/);
  assert.throws(() => c.removeCustom("ghl"), /no hay ninguna/, "built-in connectors cannot be removed");
});

test("NEXUS AI drafts: fromDraft maps the tool answer; checkDraft says what is wrong before saving", async () => {
  const d = fromDraft({ nombre: "Holded", descripcion: "x", documentacion: "https://developers.holded.com", base: "https://api.holded.com/api/", auth_tipo: "header", auth_nombre: "key", clave_ayuda: "Ajustes",
    comprobacion: "/invoicing/v1/contacts", acciones: [{ nombre: "Crear contacto", descripcion: "", metodo: "POST", ruta: "/invoicing/v1/contacts", cuerpo: '{"name":"{{nombre}}"}', datos: [{ clave: "nombre", etiqueta: "Nombre", obligatorio: true }] }],
    vigilar: [{ nombre: "Contacto nuevo", descripcion: "", ruta: "/invoicing/v1/contacts", lista: "", campo_id: "id", campo_nombre: "name", campos: ["email"], minutos: 2, nuevos_primero: false }],
    avisos: ["Plan de pago"], fuentes: ["https://developers.holded.com/reference", "http://inseguro.example"] });
  assert.equal(d.base, "https://api.holded.com/api"); assert.equal((d.triggers as any)[0].every, 5); assert.deepEqual(d.sources, ["https://developers.holded.com/reference"]);
  const { c } = make(() => ({ json: [] }));
  assert.equal(await c.checkDraft(d), null);
  assert.match(String(await c.checkDraft({ ...d, operations: [{ name: "Mal", method: "POST", path: "/x", body: '{"a":"{{b}}"}', params: [] }] })), /usa \{\{b\}\}/);
});

test("Engine routes: save / read / remove a description, and a NEXUS AI draft (fake Claude: one pause, then the tool)", async () => {
  const dir = tmp();
  const { fetchFn } = fakeFetch(() => ({ json: [] }));
  const replies: any[] = [
    { stop_reason: "pause_turn", model: "claude-sonnet-5-5", usage: { input_tokens: 20_000, output_tokens: 1_000, server_tool_use: { web_search_requests: 2 } }, content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "holded api" } }] },
    { stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: { input_tokens: 30_000, output_tokens: 3_000 }, content: [{ type: "tool_use", id: "t1", name: "guardar_conexion", input: {
      nombre: "Holded", descripcion: "Facturación", documentacion: "https://developers.holded.com", base: "https://api.holded.com/api", auth_tipo: "header", auth_nombre: "key", clave_ayuda: "", comprobacion: "/invoicing/v1/contacts",
      acciones: [{ nombre: "Contactos", descripcion: "", metodo: "GET", ruta: "/invoicing/v1/contacts", cuerpo: "", datos: [] }], vigilar: [], avisos: [], fuentes: [] } }] },
  ];
  const sent: any[] = [];
  const aiClient = () => ({ beta: { messages: { create: async (req: any) => { sent.push(structuredClone(req)); return replies.shift(); } } } }) as any;
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ anthropicApiKey: "sk-ant-test0123456789012345678901" }));
  const app = createApp(dir, {}, { aiClient, connect: { fetchFn, gapMs: 0, sleep: async () => {}, lookup: async () => ["93.184.216.34"] } });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as any).port;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const draft = await call("POST", "/api/connect-custom/draft", { service: "Holded", notes: "ver contactos" });
    assert.equal(draft.status, 200); assert.equal(draft.json.problem, null); assert.equal(draft.json.spec.name, "Holded"); assert.equal(draft.json.spec.by, "nexus-ai");
    assert.equal(draft.json.searches, 2); assert.ok(draft.json.usd > 0.15 && draft.json.usd < 0.3, String(draft.json.usd));
    assert.equal(sent.length, 2); assert.equal(sent[1].messages.length, 2, "pause_turn: the turn goes on with the assistant's content");
    assert.ok(sent[0].tools.some((t: any) => t.name === "guardar_conexion" && t.strict === true));
    assert.match(sent[0].messages[0].content, /<servicio>Holded<\/servicio>/);
    assert.ok(!fs.existsSync(path.join(dir, "connect-custom.json")), "a draft is never saved by itself");

    const saved = await call("POST", "/api/connect-custom", { spec: draft.json.spec });
    assert.equal(saved.status, 200); assert.equal(saved.json.id, "x-holded");
    assert.ok((await call("GET", "/api/connect")).json.connectors.some((x: any) => x.id === "x-holded" && x.custom?.by === "nexus-ai"));
    assert.equal((await call("GET", "/api/connect-custom/x-holded")).json.spec.base, "https://api.holded.com/api");
    assert.equal((await call("POST", "/api/connect-custom", { spec: { name: "" } })).status, 400);
    assert.equal((await call("DELETE", "/api/connect-custom/x-holded")).json.removed, true);
    assert.equal((await call("GET", "/api/connect-custom/x-holded")).status, 404);
  } finally { app.server.close(); }
});
