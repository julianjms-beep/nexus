// NEXUS Connect: the connectors talk to stand-ins for GoHighLevel, Wiwink and a webhook (a fake fetch), never to the
// real services. Checks the request each operation sends (paths, headers, bodies from the official specs), that keys
// never leave the Engine (view, audit, errors), rate-limit retries, trigger polling and the Engine's HTTP routes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Audit } from "../src/audit.ts";
import { Connect, render, cleanInput, newOnes, ConnectError } from "../src/connect.ts";
import { createApp } from "../src/server.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-connect-"));
const GHL_TOKEN = "pit-1234567890abcdef1234567890abcdef";
const LOC = "LocAbc1234567890";
const WW_TOKEN = "12|wiwinkSecretToken0123456789";
type Req = { method: string; url: URL; headers: Record<string, string>; body: any };
type Rep = { status?: number; json?: unknown; headers?: Record<string, string> };
function fakeFetch(route: (r: Req) => Rep) {
  const calls: Req[] = [];
  const f = async (u: URL | string, init: any = {}) => {
    const r: Req = { method: init.method ?? "GET", url: new URL(String(u)), headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(r);
    const rep = route(r);
    return new Response(rep.json === undefined ? "" : JSON.stringify(rep.json), { status: rep.status ?? 200, headers: { "content-type": "application/json", ...(rep.headers ?? {}) } });
  };
  return { fetchFn: f as unknown as typeof fetch, calls };
}
function make(route: (r: Req) => Rep, extra: Record<string, unknown> = {}) {
  const dir = tmp();
  const audit = new Audit(path.join(dir, "audit.jsonl"));
  const slept: number[] = [];
  const { fetchFn, calls } = fakeFetch(route);
  const c = new Connect(dir, audit, { fetchFn, sleep: async (ms) => { slept.push(ms); }, gapMs: 0, lookup: async () => ["93.184.216.34"], ...extra });
  return { c, calls, slept, dir, audit };
}
const ghlOk = (r: Req): Rep => {
  const p = r.url.pathname;
  if (p === "/contacts/search") return { json: { contacts: [], total: r.body?.filters ? 0 : 1234 } };
  if (p === "/opportunities/pipelines") return { json: { pipelines: [{ id: "P1", name: "Captación Farmacias", stages: [{ id: "S1", name: "Nuevo" }, { id: "S2", name: "Pedido hecho" }] }] } };
  if (p === "/contacts/upsert") return { json: { new: true, contact: { id: "C1" } } };
  if (/^\/contacts\/C1\/tags$/.test(p)) return { status: 201, json: { tags: r.body.tags } };
  if (/^\/contacts\/C1\/notes$/.test(p)) return { status: 201, json: { note: { id: "N1" } } };
  if (p === "/opportunities/") return { status: 201, json: { opportunity: { id: "O1" } } };
  return { status: 404, json: { message: "not found" } };
};

test("render, cleanInput, newOnes: templates are plain lookups; only declared params; first poll fires nothing", () => {
  assert.equal(render("Hola {{cliente.nombre}} ({{ cliente.email }}) {{falta.x}} {{a}}", { cliente: { nombre: "Farmacia Sol", email: "s@x.es" }, a: 3 }), "Hola Farmacia Sol (s@x.es)  3");
  assert.equal(render("{{constructor}} {{__proto__.x}}", {}), " ", "only the event's own fields");
  assert.deepEqual(cleanInput([{ key: "a", label: "A" }, { key: "b", label: "B" }], { a: "  x ", b: "", evil: "y" }), { a: "x" });
  assert.throws(() => cleanInput([{ key: "a", label: "A" }], { a: "x".repeat(2001) }), /demasiado largo/);
  const items = [{ id: "1" }, { id: "2" }];
  const first = newOnes(undefined, items, (x) => x.id, 10);
  assert.deepEqual(first.fresh, []); assert.equal(first.baseline, 2);
  const second = newOnes(first.state, [...items, { id: "3" }, { id: "4" }, { id: "5" }], (x) => x.id, 10, 2);
  assert.deepEqual(second.fresh.map((x) => x.id), ["3", "4"], "at most `max`, the rest wait");
  const third = newOnes(second.state, [...items, { id: "3" }, { id: "4" }, { id: "5" }], (x) => x.id, 10, 2);
  assert.deepEqual(third.fresh.map((x) => x.id), ["5"]);
});

test("GoHighLevel: connecting tests read-only with the official headers; the token never comes back or reaches the audit", async () => {
  const { c, calls, dir } = make(ghlOk);
  const info = await c.connect("ghl", { token: GHL_TOKEN, locationId: LOC });
  assert.equal(info.connected, true);
  assert.match(info.account, /1234 contactos · 1 embudo/, "Spanish: no thousands dot below 10.000");
  assert.deepEqual(calls.map((x) => `${x.method} ${x.url.pathname}`), ["POST /contacts/search", "GET /opportunities/pipelines"]);
  for (const x of calls) {
    assert.equal(x.url.origin, "https://services.leadconnectorhq.com");
    assert.equal(x.headers.authorization, `Bearer ${GHL_TOKEN}`);
    assert.equal(x.headers.version, "2021-07-28");
    assert.match(x.headers["user-agent"], /NEXUS/, "GoHighLevel's Cloudflare refuses requests without a User-Agent");
  }
  assert.equal(calls[1].url.searchParams.get("locationId"), LOC);
  const file = path.join(dir, "connect.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const view = JSON.stringify(c.view());
  assert.ok(!view.includes(GHL_TOKEN) && !view.includes(GHL_TOKEN.slice(4, 20)), "the catalog never carries a key");
  assert.ok(!fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8").includes(GHL_TOKEN), "the audit never carries a key");
  await assert.rejects(c.connect("ghl", { token: "short", locationId: LOC }), /formato/);
  await assert.rejects(c.connect("ghl", { token: GHL_TOKEN }), /falta «ID de la subcuenta/);
});

test("GoHighLevel: contact upsert never sends tags (they would replace the old ones); tags are added apart; templates use the event", async () => {
  const { c, calls } = make(ghlOk);
  await c.connect("ghl", { token: GHL_TOKEN, locationId: LOC });
  calls.length = 0;
  const event = { cliente: { nombre: "Farmacia Sol", email: "sol@farmacia.es", ciudad: "Murcia" } };
  const r = await c.run("ghl", "contacto", { email: "{{cliente.email}}", nombre: "{{cliente.nombre}}", ciudad: "{{cliente.ciudad}}", etiquetas: "cliente, wiwink", origen: "Wiwink" }, event, "automation");
  assert.deepEqual(r.output, { contacto_id: "C1", nuevo: true, etiquetas_anadidas: "cliente, wiwink" });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.url.pathname}`), ["POST /contacts/upsert", "POST /contacts/C1/tags"]);
  assert.deepEqual(calls[0].body, { locationId: LOC, email: "sol@farmacia.es", firstName: "Farmacia Sol", city: "Murcia", source: "Wiwink" });
  assert.equal(calls[0].body.tags, undefined);
  assert.deepEqual(calls[1].body, { tags: ["cliente", "wiwink"] });
  // a write asked for by anything but an automation is refused before any request
  calls.length = 0;
  await assert.rejects(c.run("ghl", "etiquetas", { email: "a@b.es", etiquetas: "x" }, undefined, "app"), (e: any) => e instanceof ConnectError && e.status === 403);
  assert.equal(calls.length, 0);
  // a required field that the event left empty says which template it was
  await assert.rejects(c.run("ghl", "nota", { email: "a@b.es", nota: "{{factura.numero}}" }, {}, "automation"), /«Nota» ha quedado vacío: el evento no traía \{\{factura\.numero\}\}/);
  await assert.rejects(c.run("ghl", "contacto", { email: "{{cliente.email}}" }, { cliente: {} }, "automation"), /email o el teléfono/);
});

test("GoHighLevel: an opportunity finds its pipeline and stage by name (accents and case ignored) and reads Spanish amounts", async () => {
  const { c, calls } = make(ghlOk);
  await c.connect("ghl", { token: GHL_TOKEN, locationId: LOC });
  calls.length = 0;
  const r = await c.run("ghl", "oportunidad", { email: "a@b.es", embudo: "captacion farmacias", etapa: "PEDIDO HECHO", titulo: "Pedido {{factura.numero}}", valor: "1.234,50" }, { factura: { numero: "F-7" } }, "automation");
  assert.deepEqual(r.output, { oportunidad_id: "O1", contacto_id: "C1", embudo: "Captación Farmacias", etapa: "Pedido hecho" });
  const post = calls.find((x) => x.url.pathname === "/opportunities/")!;
  assert.deepEqual(post.body, { pipelineId: "P1", locationId: LOC, name: "Pedido F-7", pipelineStageId: "S2", status: "open", contactId: "C1", monetaryValue: 1234.5 });
  await assert.rejects(c.run("ghl", "oportunidad", { email: "a@b.es", embudo: "Otro", titulo: "x" }, {}, "automation"), /no hay ningún embudo «Otro» \(hay: Captación Farmacias\)/);
});

test("rate limits and errors: 429 waits Retry-After and retries; 401 explains itself; reads retry 503, writes do not", async () => {
  let n = 0;
  const { c, slept, calls } = make((r) => {
    if (r.url.pathname === "/api/customers" && n++ < 2) return { status: 429, json: { message: "Too Many Requests" }, headers: { "retry-after": "3" } };
    return { json: { data: [], meta: { total: 997, last_page: 1 } } };
  });
  const info = await c.connect("wiwink", { token: WW_TOKEN });
  assert.equal(info.account, "997 clientes");
  assert.deepEqual(slept, [3000, 3000]); assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.authorization, `Bearer ${WW_TOKEN}`);
  assert.equal(calls[0].url.href, "https://developers.wiwink.com/api/customers");

  const bad = make(() => ({ status: 401, json: { message: "Unauthenticated." } }));
  await assert.rejects(bad.c.connect("wiwink", { token: WW_TOKEN }), (e: any) => e.status === 401 && /Wiwink no acepta la clave \(401\) \(«Unauthenticated\.»\)/.test(e.message) && !e.message.includes(WW_TOKEN));
  assert.deepEqual(bad.c.view().connectors.find((x) => x.id === "wiwink")!.connected, false, "a key that fails the test is not kept");

  let up = 0;
  const flaky = make((r) => (r.method === "GET" && up++ === 0 ? { status: 503, json: {} } : r.method === "POST" ? { status: 503, json: { message: "down" } } : { json: { data: [{ id: 9, corporate_name: "*Farmacia Luna", email: "l@x.es" }], meta: { total: 1 } } }));
  await flaky.c.connect("wiwink", { token: WW_TOKEN });
  assert.equal(up, 2, "the 503 on a read was retried");
  await assert.rejects(flaky.c.run("wiwink", "crear_contacto", { nombre: "X" }, undefined, "automation"), /Wiwink tiene un problema ahora mismo \(503\)/);
  assert.equal(flaky.calls.filter((x) => x.method === "POST").length, 1, "a write is never repeated on a 5xx (it could duplicate)");
  const found = await flaky.c.run("wiwink", "buscar_cliente", { nif: "B123" }, undefined, "app");
  assert.deepEqual((found.output as any).cliente.nombre, "Farmacia Luna", "leading asterisks dropped, as the sync routine does");
  assert.equal(flaky.calls.at(-1)!.url.searchParams.get("vat"), "B123");
});

test("Wiwink «Factura nueva»: the first poll only remembers; then new invoices, oldest first, each with its customer", async () => {
  let bills: any[] = [{ full_number: "F-1", emission_at: "2026-11-01", customer_id: 1, full_amount: "121.00" }];
  const { c, calls } = make((r) => {
    if (r.url.pathname === "/api/customers") return { json: { data: [], meta: { total: 3 } } };
    if (r.url.pathname === "/api/billing") return { json: { data: bills } };
    if (r.url.pathname === "/api/customers/7") return { json: { data: { id: 7, corporate_name: "Farmacia Sol", email: "sol@x.es", vat: "B1" } } };
    if (r.url.pathname === "/api/customers/8") return { status: 404, json: { message: "Not found" } };
    return { status: 500, json: {} };
  });
  await c.connect("wiwink", { token: WW_TOKEN });
  calls.length = 0;
  const p1 = await c.poll("wiwink", "factura", {}, undefined);
  assert.deepEqual(p1.events, []); assert.equal(p1.baseline, 1);
  assert.equal(calls.length, 1, "no customer is fetched for invoices that already existed");
  bills = [{ full_number: "F-3", emission_at: "2026-11-09", customer_id: 7, full_amount: "50" }, { full_number: "F-2", emission_at: "2026-11-08", customer_id: 7, taxable_amount: "100", full_amount: "121" }, { full_number: "F-4", emission_at: "2026-11-09", customer_id: 8 }, ...bills];
  const p2 = await c.poll("wiwink", "factura", {}, p1.state);
  assert.deepEqual(p2.events.map((e) => e.id), ["F-2", "F-3", "F-4"]);
  assert.equal(p2.events[0].label, "Factura F-2 · Farmacia Sol");
  assert.deepEqual((p2.events[0].data as any).factura, { numero: "F-2", fecha: "2026-11-08", vencimiento: "", cliente_id: "7", base: "100", impuestos: "", total: "121" });
  assert.equal((p2.events[0].data as any).cliente.email, "sol@x.es");
  assert.deepEqual((p2.events[2].data as any).cliente, { id: "8" }, "a deleted customer does not block the rest");
  assert.equal(calls.filter((x) => x.url.pathname === "/api/customers/7").length, 1, "one request per customer per poll");
  const p3 = await c.poll("wiwink", "factura", {}, p2.state);
  assert.deepEqual(p3.events, []);
});

test("GoHighLevel «recibe una etiqueta»: pages of 100 until a short one; the tag filter is the spec's", async () => {
  let tagged = Array.from({ length: 130 }, (_, i) => ({ id: `K${i}`, firstName: "N" + i, email: `n${i}@x.es`, tags: ["pedido"], dateAdded: `2026-11-0${(i % 9) + 1}` }));
  const { c, calls } = make((r) => {
    if (r.url.pathname === "/opportunities/pipelines") return { json: { pipelines: [] } };
    if (r.url.pathname === "/contacts/search") {
      if (r.body.pageLimit === 1) return { json: { contacts: [], total: 1 } };
      const from = (r.body.page - 1) * r.body.pageLimit;
      return { json: { contacts: tagged.slice(from, from + r.body.pageLimit), total: tagged.length } };
    }
    return { status: 404, json: {} };
  });
  await c.connect("ghl", { token: GHL_TOKEN, locationId: LOC });
  calls.length = 0;
  const p1 = await c.poll("ghl", "etiqueta", { etiqueta: "pedido" }, undefined);
  assert.equal(p1.baseline, 130); assert.deepEqual(p1.events, []);
  assert.deepEqual(calls.map((x) => x.body.page), [1, 2]);
  assert.deepEqual(calls[0].body.filters, [{ field: "tags", operator: "contains", value: ["pedido"] }]);
  tagged = [...tagged, { id: "NEW", firstName: "Ana", lastName: "Gil", email: "ana@x.es", tags: ["pedido", "vip"], dateAdded: "2026-11-09" } as any];
  const p2 = await c.poll("ghl", "etiqueta", { etiqueta: "pedido" }, p1.state);
  assert.deepEqual(p2.events.map((e) => [e.id, e.label]), [["NEW", "Ana Gil"]]);
  assert.equal((p2.events[0].data as any).contacto.etiquetas, "pedido, vip");
  await assert.rejects(c.poll("ghl", "etiqueta", {}, undefined), /falta «Etiqueta»/);
  // a tag on more contacts than one check can read would make old contacts look new: refuse instead
  tagged = Array.from({ length: 1001 }, (_, i) => ({ id: `B${i}`, firstName: "B", tags: ["pedido"] }));
  calls.length = 0;
  await assert.rejects(c.poll("ghl", "etiqueta", { etiqueta: "pedido" }, p2.state), /la tienen 1001 contactos y NEXUS solo puede vigilar etiquetas de hasta 1000 \(usa una más concreta/);
  assert.equal(calls.length, 1, "stops after the first page");
});

test("Webhook: only https addresses on the Internet; sends {text, datos}; the address is a secret", async () => {
  const lookups: Record<string, string[]> = { "hooks.slack.com": ["3.3.3.3"], "router.example.com": ["192.168.1.1"], "evil.example.com": ["127.0.0.1"] };
  const { c, calls } = make(() => ({ json: { ok: true } }), { lookup: async (h: string) => lookups[h] ?? [] });
  for (const [url, why] of [["http://hooks.slack.com/x/y/z", /formato|https/], ["https://router.example.com/hook", /red local/], ["https://evil.example.com/hook", /red local/],
    ["https://192.168.1.20/hook", /red local/], ["https://[::1]/hook", /red local/], ["https://printer.local/hook", /red local/], ["https://nadie.example.com/hook", /no encuentro/]] as const) {
    await assert.rejects(c.connect("webhook", { url }), why, url);
  }
  const url = "https://hooks.slack.com/services/T000/B000/SECRETSECRET";
  const info = await c.connect("webhook", { url });
  assert.equal(info.account, "Enviará a hooks.slack.com (no se envía nada hasta que una automatización lo use)");
  assert.equal(calls.length, 0, "connecting a webhook sends nothing");
  assert.ok(!JSON.stringify(c.view()).includes("SECRETSECRET"));
  await c.run("webhook", "enviar", { texto: "Factura {{factura.numero}}" }, { factura: { numero: "F-9" } }, "automation");
  assert.equal(calls[0].url.href, url);
  assert.deepEqual(calls[0].body, { text: "Factura F-9", datos: { factura: { numero: "F-9" } } });
  // a later DNS change to a local address is caught on every send, not only when connecting
  lookups["hooks.slack.com"] = ["10.0.0.5"];
  await assert.rejects(c.run("webhook", "enviar", { texto: "x" }, {}, "automation"), /red local/);
});

test("Engine routes: catalog without keys, connect, writes refused unless from an automation, poll, errors with status", async () => {
  const dir = tmp();
  const { fetchFn } = fakeFetch(ghlOk);
  const app = createApp(dir, {}, { connect: { fetchFn, gapMs: 0, sleep: async () => {} } });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  const port = (app.server.address() as any).port;
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${app.token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    const list = await call("GET", "/api/connect");
    assert.deepEqual(list.json.connectors.map((x: any) => [x.id, x.connected]), [["ghl", false], ["wiwink", false], ["webhook", false]]);
    assert.equal(list.json.connectors[0].fields.find((f: any) => f.key === "token").secret, true);
    assert.equal((await call("POST", "/api/connect/ghl/run", { op: "buscar", input: { etiqueta: "x" } })).status, 409, "not connected yet");
    const con = await call("POST", "/api/connect/ghl", { values: { token: GHL_TOKEN, locationId: LOC } });
    assert.equal(con.status, 200); assert.equal(con.json.connected, true);
    assert.ok(!JSON.stringify((await call("GET", "/api/connect")).json).includes(GHL_TOKEN));
    const denied = await call("POST", "/api/connect/ghl/run", { op: "etiquetas", input: { email: "a@b.es", etiquetas: "x" } });
    assert.equal(denied.status, 403);
    const ok = await call("POST", "/api/connect/ghl/run", { op: "etiquetas", input: { email: "a@b.es", etiquetas: "x" }, origin: "automation" });
    assert.equal(ok.status, 200); assert.equal(ok.json.output.contacto_id, "C1");
    const poll = await call("POST", "/api/connect/ghl/poll", { trigger: "etiqueta", input: { etiqueta: "pedido" } });
    assert.equal(poll.status, 200); assert.deepEqual(poll.json.events, []);
    assert.equal((await call("POST", "/api/connect/nada/test")).status, 404);
    assert.equal((await call("DELETE", "/api/connect/ghl")).json.connected, false);
    const audit = fs.readFileSync(path.join(dir, "audit.jsonl"), "utf8");
    assert.match(audit, /connect\.connected/); assert.match(audit, /connect\.call/);
    assert.ok(!audit.includes(GHL_TOKEN) && !audit.includes("a@b.es"), "the audit has neither keys nor the data sent");
  } finally { app.server.close(); }
});
