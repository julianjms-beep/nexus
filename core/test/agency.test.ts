// Agencias: teams of AI workers on a schedule. Workers only read (web, the person's services, the agency folder),
// write notes and deliver documents into the agency folder; budgets stop them; NEXUS AI only drafts a team.
// Everything talks to a fake Claude and fake services, never to real ones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agencies, AgencyError, validateAgency, marketingTemplate, fromAgencyDraft, safeName } from "../src/agency.ts";
import { createApp } from "../src/server.ts";
import { createSession } from "../src/sessiond.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-agency-")));
const MONDAY_0931 = new Date(2026, 10, 9, 9, 31); // lunes 9 de noviembre de 2026
const USAGE = { input_tokens: 10_000, output_tokens: 2_000 }; // Sonnet 5.5: 0,02 + 0,02 = 0,04 US$
const CATALOG = [
  { id: "wiwink", name: "Wiwink", connected: true, operations: [
    { id: "facturas", name: "Ver facturas", kind: "read", params: [{ key: "desde", label: "Desde" }] },
    { id: "crear_cliente", name: "Crear un cliente", kind: "write", params: [] }] },
  { id: "ghl", name: "GoHighLevel", connected: false, operations: [{ id: "buscar", name: "Buscar", kind: "read", params: [] }] },
] as any[];

type Reply = { content: any[]; stop_reason: string; usage?: any; model?: string };
function setup(script: (body: any, n: number) => Reply | Promise<Reply>, extra: Record<string, unknown> = {}) {
  const dir = tmp(); const home = path.join(dir, "home"); fs.mkdirSync(home);
  const calls: any[] = []; const reads: any[] = []; const notices: { text: string; kind?: string }[] = []; const changed: string[] = [];
  const clock = { now: MONDAY_0931 };
  const make = () => new Agencies({
    home, configDir: path.join(dir, "cfg"), dataDir: path.join(dir, "data"), tickMs: 0, now: () => clock.now,
    claude: async (body, _ms, signal) => {
      calls.push(JSON.parse(JSON.stringify(body)));
      const r = await script(body, calls.length);
      if (signal?.aborted) throw new Error("aborted");
      return { status: 200, json: { model: body.model, usage: USAGE, ...r } };
    },
    readService: async (c, op, input) => { reads.push({ c, op, input }); return { facturas: [{ numero: "F-1", total: 120 }] }; },
    catalog: () => CATALOG,
    notice: (text, kind) => notices.push({ text, kind }),
    changed: (id) => changed.push(id),
    ...extra,
  });
  return { dir, home, calls, reads, notices, changed, clock, make, ag: make() };
}
const worker = (over: Record<string, unknown> = {}) => ({ name: "Leo", role: "Tendencias", web: true, connections: ["wiwink", "ghl"],
  tasks: [{ title: "Tendencias del día", instructions: "Busca 3 tendencias de hoy.", days: [1, 2, 3, 4, 5], time: "09:30" }], ...over });
const agencyInput = (over: Record<string, unknown> = {}) => ({ name: "Agencia de marketing", purpose: "Marketing de KOMGO", budgetUsd: 10, taskUsd: 0.5,
  workers: [{ name: "Carla", role: "Directora", boss: true, tasks: [{ title: "Parte del día", instructions: "Resume el día del equipo.", days: [1, 2, 3, 4, 5], time: "19:00" }] }, worker()], ...over });
const deliver = (titulo = "Tendencias", propuestas: string[] = []) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu_d", name: "entregar", input: { titulo, resumen: "Tres tendencias.", documento: "## 1. Skincare coreano\nEnlace: https://example.com", propuestas } }] });

test("validateAgency: Spanish errors, one boss, times need days, unique ids and folders; the template is valid", () => {
  const bad = (x: unknown, re: RegExp) => assert.throws(() => validateAgency(x, []), (e: any) => e instanceof AgencyError && re.test(e.message));
  bad({ name: "" }, /nombre a la agencia/);
  bad({ name: "Mi agencia", workers: [] }, /al menos un trabajador/);
  bad(agencyInput({ workers: [{ name: "A", boss: true }, { name: "B", boss: true }] }), /una persona al mando/);
  bad(agencyInput({ workers: [{ name: "Ana" }, { name: "ana" }] }), /dos trabajadores/);
  bad(agencyInput({ workers: [worker({ tasks: [{ title: "Algo", instructions: "Hacer algo", days: [1], time: "9:30" }] })] }), /09:30/);
  bad(agencyInput({ workers: [worker({ tasks: [{ title: "Algo", instructions: "Hacer algo", days: [], time: "09:30" }] })] }), /qué días/);
  bad(agencyInput({ budgetUsd: 0 }), /presupuesto/);
  const a = validateAgency(agencyInput(), []);
  assert.equal(a.id, "agencia-de-marketing"); assert.equal(a.folder, "Agencias/Agencia de marketing");
  assert.deepEqual(a.workers.map((w) => w.id), ["carla", "leo"]);
  const b = validateAgency(agencyInput(), [a]);
  assert.equal(b.id, "agencia-de-marketing-2"); assert.equal(b.folder, "Agencias/Agencia de marketing 2");
  // a task without time only runs when the person asks: no days kept
  const c = validateAgency(agencyInput({ workers: [worker({ tasks: [{ title: "A mano", instructions: "Solo cuando lo pida", days: [1, 2], time: "" }] })] }), []);
  assert.deepEqual(c.workers[0].tasks[0].days, []);
  // the marketing office template, with and without services
  for (const conns of [[], ["wiwink", "ghl"]]) {
    const t = validateAgency(marketingTemplate(conns), []);
    assert.equal(t.workers.filter((w) => w.boss).length, 1);
    assert.deepEqual(t.workers.find((w) => w.id === "julio")!.connections, conns);
  }
  assert.equal(safeName("../x/y"), "x y"); assert.equal(safeName("..\\x:y"), "x y");
});

test("a task: reads its folder, notes, reads a connected service (only reads, only its connections), delivers a document with proposals", async () => {
  const s = setup((body, n) => {
    if (n === 1) return { stop_reason: "tool_use", content: [
      { type: "text", text: "Miro primero." },
      { type: "tool_use", id: "t1", name: "leer_documentos", input: {} },
      { type: "tool_use", id: "t2", name: "consultar_servicio", input: { conexion: "wiwink", accion: "facturas", datos: { desde: "2026-11-01", "Bad Key": "x" } } },
      { type: "tool_use", id: "t3", name: "consultar_servicio", input: { conexion: "wiwink", accion: "crear_cliente" } },
      { type: "tool_use", id: "t4", name: "consultar_servicio", input: { conexion: "ghl", accion: "buscar" } },
      { type: "tool_use", id: "t5", name: "consultar_servicio", input: { conexion: "holded", accion: "x" } },
      { type: "tool_use", id: "t6", name: "apuntar_en_el_tablon", input: { nota: "Las facturas suben." } },
    ] };
    if (n === 2) return { stop_reason: "pause_turn", content: [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "tendencias k-beauty" } }] };
    return deliver("Tendencias del lunes", ["Publicar un reel sobre skincare", "Llamar a la revista X"]);
  });
  const a = s.ag.save(agencyInput());
  fs.writeFileSync(path.join(s.home, a.folder, "nota previa.md"), "hola");
  assert.deepEqual(s.ag.runNow(a.id, "leo", "tendencias-del-dia"), { queued: true });
  assert.equal(s.ag.runNow(a.id, "leo", "tendencias-del-dia").queued, false); // already on it
  await s.ag.idle();
  // the request: the person's model, adaptive thinking, caching, web tools only because web: true, entregar
  const first = s.calls[0];
  assert.equal(first.model, "claude-sonnet-5-5"); assert.deepEqual(first.thinking, { type: "adaptive" }); assert.deepEqual(first.cache_control, { type: "ephemeral" });
  assert.equal(first.system[0].cache_control.type, "ephemeral");
  assert.match(first.system[0].text, /Eres Leo, Tendencias de la agencia «Agencia de marketing»/);
  assert.match(first.system[0].text, /no órdenes/);
  const names = first.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["web_search", "web_fetch", "leer_documentos", "apuntar_en_el_tablon", "consultar_servicio", "entregar"]);
  const cs = first.tools.find((t: any) => t.name === "consultar_servicio");
  assert.match(cs.description, /wiwink \(Wiwink\): facturas = Ver facturas \[datos: desde\]/);
  assert.doesNotMatch(cs.description, /crear_cliente|ghl/); // writes and disconnected services are not offered
  assert.match(first.messages[0].content, /Tarea: Tendencias del día\nBusca 3 tendencias de hoy\./);
  // tool results went back in order
  const results = s.calls[1].messages[2].content;
  assert.equal(results.length, 6);
  assert.match(results[0].content, /nota previa\.md/);
  assert.match(results[1].content, /F-1/);
  assert.equal(results[2].is_error, true); assert.match(results[2].content, /no es una lectura/);
  assert.equal(results[3].is_error, true); assert.match(results[3].content, /no está conectado/);
  assert.equal(results[4].is_error, true); assert.match(results[4].content, /no tienes acceso/);
  assert.deepEqual(s.reads, [{ c: "wiwink", op: "facturas", input: { desde: "2026-11-01" } }]); // only the read, bad keys dropped
  // pause_turn: the paused turn is sent back as is
  assert.equal(s.calls[2].messages.at(-1).role, "assistant");
  // the delivery
  const d = s.ag.detail(a.id);
  const run = d.runs[0];
  assert.equal(run.status, "done"); assert.equal(run.title, "Tendencias del lunes"); assert.equal(run.steps, 3);
  assert.ok(Math.abs(run.usd - 0.12) < 1e-9, String(run.usd));
  assert.ok(Math.abs(d.spentMonth - 0.12) < 1e-9);
  assert.equal(run.file, "Agencias/Agencia de marketing/Leo/2026-11-09 0931 Tendencias del lunes.md");
  const text = fs.readFileSync(path.join(s.home, run.file!), "utf8");
  assert.match(text, /^# Tendencias del lunes\n\n\*Leo · Tendencias · lunes 9 de noviembre de 2026, 09:31\*/);
  assert.match(text, /## Propuestas para ti\n\n- Publicar un reel sobre skincare\n- Llamar a la revista X/);
  assert.deepEqual(d.proposals.map((p: any) => [p.who, p.status]), [["Leo", "pending"], ["Leo", "pending"]]);
  assert.deepEqual(d.board.map((n: any) => n.text), ["Ha entregado «Tendencias del lunes»: Tres tendencias.", "Las facturas suben."]);
  assert.ok(s.notices.some((n) => n.kind === "ok" && /Leo ha terminado «Tendencias del lunes» \(2 propuestas para ti\)/.test(n.text)));
  // the person marks a proposal done; files are 0600
  s.ag.setProposal(a.id, d.proposals[0].id, "done");
  assert.equal(s.ag.view().items[0].pending, 1);
  assert.equal(fs.statSync(path.join(s.dir, "cfg", "agencias.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(s.dir, "data", "agencias", a.id + ".json")).mode & 0o777, 0o600);
  // a second delivery in the same minute does not overwrite the first
  s.ag.runNow(a.id, "leo", "tendencias-del-dia"); await s.ag.idle();
  assert.ok(fs.existsSync(path.join(s.home, "Agencias/Agencia de marketing/Leo/2026-11-09 0931 Tendencias del lunes (2).md")));
  // the app reads the document by its path
  assert.match(s.ag.doc(a.id, run.file!).text, /Skincare coreano/);
  assert.throws(() => s.ag.doc(a.id, "../../secret"), /ruta no válida/);
});

test("files stay inside the agency folder: no '..', no symlinks out", async () => {
  const s = setup((_b, n) => n === 1 ? { stop_reason: "tool_use", content: [
    { type: "tool_use", id: "a", name: "leer_documentos", input: { archivo: "../../secret.txt" } },
    { type: "tool_use", id: "b", name: "leer_documentos", input: { archivo: "enlace/secret.txt" } },
    { type: "tool_use", id: "c", name: "leer_documentos", input: { archivo: "/etc/passwd" } },
  ] } : deliver());
  const a = s.ag.save(agencyInput());
  fs.writeFileSync(path.join(s.home, "secret.txt"), "SECRETO");
  fs.symlinkSync(s.home, path.join(s.home, a.folder, "enlace"));
  s.ag.runNow(a.id, "leo", "tendencias-del-dia"); await s.ag.idle();
  const res = s.calls[1].messages[2].content;
  assert.equal(res.length, 3);
  for (const r of res) { assert.equal(r.is_error, true); assert.doesNotMatch(r.content, /SECRETO|root:/); }
});

test("budgets: the per-task cap and the month's budget stop the work; a schedule over budget warns once", async () => {
  // each answer: 50.000 tokens in + 5.000 out with Sonnet 5.5 = 0,10 + 0,05 = 0,15 US$
  const s = setup(() => ({ stop_reason: "tool_use", usage: { input_tokens: 50_000, output_tokens: 5_000 }, content: [{ type: "tool_use", id: "x", name: "apuntar_en_el_tablon", input: { nota: "sigo" } }] }));
  const a = s.ag.save(agencyInput({ taskUsd: 0.2, budgetUsd: 1 }));
  s.ag.runNow(a.id, "leo", "tendencias-del-dia"); await s.ag.idle();
  let run = s.ag.detail(a.id).runs[0];
  assert.equal(run.status, "failed"); assert.match(run.error!, /límite de 0,20 US\$ por tarea/);
  assert.equal(s.calls.length, 2); // 0,15 + 0,15 ≥ 0,20: the cap is checked before each answer
  assert.ok(s.notices.some((n) => n.kind === "error" && /Leo no ha podido hacer «Tendencias del día»/.test(n.text)));
  // spend the month's budget, then nothing more runs
  s.ag.save({ ...agencyInput({ budgetUsd: 1, taskUsd: 5 }), id: a.id });
  s.ag.runNow(a.id, "leo", "tendencias-del-dia"); await s.ag.idle();
  run = s.ag.detail(a.id).runs[0];
  assert.match(run.error!, /presupuesto del mes/);
  assert.ok(s.ag.detail(a.id).spentMonth >= 1);
  assert.throws(() => s.ag.runNow(a.id, "leo", "tendencias-del-dia"), /se ha acabado el presupuesto de este mes \(1,00 US\$\)/);
  const before = s.calls.length;
  s.clock.now = new Date(2026, 10, 9, 19, 1); s.ag.tick(); s.ag.tick(); await s.ag.idle();
  assert.equal(s.calls.length, before);
  assert.equal(s.notices.filter((n) => /se ha acabado el presupuesto de este mes/.test(n.text)).length, 1);
  // next month the budget is fresh
  s.clock.now = new Date(2026, 11, 1, 9, 30); assert.equal(s.ag.detail(a.id).spentMonth, 0);
});

test("schedule: runs within 5 minutes of its time, once per slot, not when late or disabled, one task at a time per agency", async () => {
  const s = setup(() => deliver());
  const a = s.ag.save(agencyInput({ workers: [
    { name: "Carla", boss: true, tasks: [{ title: "Parte", instructions: "Resume el día.", days: [1], time: "09:30" }] },
    worker({ web: false }),
  ] }));
  s.ag.tick();
  const live = s.ag.view().items[0].live;
  assert.deepEqual(Object.values(live).map((l: any) => l.status).sort(), ["queued", "running"]); // one runs, the other waits
  await s.ag.idle();
  assert.equal(s.ag.detail(a.id).runs.length, 2);
  assert.ok(s.ag.detail(a.id).runs.every((r: any) => r.why === "horario"));
  s.clock.now = new Date(2026, 10, 9, 9, 34); s.ag.tick(); await s.ag.idle();
  assert.equal(s.ag.detail(a.id).runs.length, 2); // same slot
  s.clock.now = new Date(2026, 10, 10, 9, 40); s.ag.tick(); await s.ag.idle();
  assert.equal(s.ag.detail(a.id).runs.length, 2); // 10 minutes late: skipped
  s.clock.now = new Date(2026, 10, 11, 9, 30); s.ag.setEnabled(a.id, false); s.ag.tick(); await s.ag.idle();
  assert.equal(s.ag.detail(a.id).runs.length, 2); // paused
  s.ag.setEnabled(a.id, true); s.ag.tick(); await s.ag.idle();
  assert.equal(s.ag.detail(a.id).runs.length, 3); // Wednesday: Leo only (Carla's task is on Mondays)
  // the app shows when each worker works next
  const leo = s.ag.view().items[0].workers.find((w: any) => w.id === "leo");
  assert.equal(new Date(leo.next.at).getDate(), 12); assert.equal(leo.last.status, "done");
  // the boss sees the team's deliveries of the last 7 days
  s.clock.now = new Date(2026, 10, 16, 9, 30); s.ag.tick(); await s.ag.idle();
  const bossCall = s.calls.filter((c) => /Eres Carla/.test(c.system[0].text)).at(-1);
  assert.ok(bossCall); assert.match(bossCall.messages[0].content, /Lo que ha entregado el equipo estos 7 días:\n- 2026-11-09 09:31 Leo: «Tendencias» — Tres tendencias\. \(archivo: Leo\/2026-11-09 0931 Tendencias\.md\)\n- 2026-11-11 09:30 Leo/);
  assert.ok(!bossCall.tools.some((t: any) => t.name === "web_search")); // Carla has no web
});

test("stop: the person stops a running task; a restart marks unfinished runs as failed", async () => {
  let release!: () => void;
  const s = setup(() => new Promise<Reply>((r) => { release = () => r(deliver()); }));
  const a = s.ag.save(agencyInput());
  s.ag.runNow(a.id, "leo", "tendencias-del-dia");
  await new Promise((r) => setTimeout(r, 20));
  const runId = (s.ag.view().items[0].live as any).leo.run;
  assert.deepEqual(s.ag.stopRun(a.id, runId), { stopped: 1 });
  release(); await s.ag.idle();
  const run = s.ag.detail(a.id).runs[0];
  assert.equal(run.status, "stopped"); assert.equal(run.error, "la detuviste tú");
  assert.ok(!fs.existsSync(path.join(s.home, a.folder, "Leo"))); // nothing delivered
  // a run cut by a restart
  const f = path.join(s.dir, "data", "agencias", a.id + ".json");
  const st = JSON.parse(fs.readFileSync(f, "utf8")); st.runs.push({ ...st.runs[0], id: "cortada", status: "running", ended: undefined }); fs.writeFileSync(f, JSON.stringify(st));
  const again = s.make();
  assert.equal(again.detail(a.id).runs.find((r: any) => r.id === "cortada").status, "failed");
});

test("Claude errors become Spanish messages; refusals and no delivery end the run", async () => {
  const errs: [number, any, RegExp][] = [
    [401, { error: { message: "NEXUS AI has no Claude key yet" } }, /no tiene clave de Claude/],
    [429, { error: { message: "rate" } }, /más despacio/],
    [529, { error: { message: "overloaded" } }, /saturado/],
  ];
  for (const [status, json, re] of errs) {
    const t = setup(() => deliver(), { claude: async () => ({ status, json }) });
    const b = t.ag.save(agencyInput()); t.ag.runNow(b.id, "leo", "tendencias-del-dia"); await t.ag.idle();
    assert.match(t.ag.detail(b.id).runs[0].error!, re);
  }
  // no tool call twice: the second plain text becomes the document
  const u = setup((_b, n) => ({ stop_reason: "end_turn", content: [{ type: "text", text: n === 1 ? "Hecho." : "Aquí va el informe completo." }] }));
  const c = u.ag.save(agencyInput()); u.ag.runNow(c.id, "leo", "tendencias-del-dia"); await u.ag.idle();
  assert.equal(u.calls[1].messages.at(-1).content, "Entrega ahora tu trabajo con la herramienta entregar.");
  const r = u.ag.detail(c.id).runs[0];
  assert.equal(r.status, "done"); assert.match(fs.readFileSync(path.join(u.home, r.file!), "utf8"), /Aquí va el informe completo/);
  const v = setup(() => ({ stop_reason: "refusal", content: [] }));
  const d = v.ag.save(agencyInput()); v.ag.runNow(d.id, "leo", "tendencias-del-dia"); await v.ag.idle();
  assert.match(v.ag.detail(d.id).runs[0].error!, /no ha querido/);
});

test("chat with a worker: short history, the same read tools but no delivery, the cost counts", async () => {
  const s = setup((_body, n) => n === 1
    ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "q", name: "consultar_servicio", input: { conexion: "wiwink", accion: "facturas" } }] }
    : { stop_reason: "end_turn", content: [{ type: "text", text: n === 2 ? "Hay una factura de 120 €." : "De nada." }] });
  const a = s.ag.save(agencyInput());
  const r1 = await s.ag.chat(a.id, "leo", "¿Cómo van las facturas?");
  assert.equal(r1.reply, "Hay una factura de 120 €."); assert.ok(Math.abs(r1.usd - 0.08) < 1e-9);
  assert.ok(!s.calls[0].tools.some((t: any) => t.name === "entregar"));
  assert.match(s.calls[0].system, /chat de la agencia/);
  await s.ag.chat(a.id, "leo", "Gracias");
  const last = s.calls.at(-1);
  assert.deepEqual(last.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.equal(last.messages[0].content, "¿Cómo van las facturas?");
  assert.deepEqual(s.ag.detail(a.id).chats.leo.map((m: any) => m.text), ["¿Cómo van las facturas?", "Hay una factura de 120 €.", "Gracias", "De nada."]);
  assert.ok(Math.abs(s.ag.detail(a.id).spentMonth - 0.12) < 1e-9);
  await assert.rejects(s.ag.chat(a.id, "nadie", "hola"), /ese trabajador no existe/);
});

test("NEXUS AI drafts a team: forced strict tool, only known connections, the person reviews before creating", async () => {
  const s = setup((body) => {
    assert.deepEqual(body.tool_choice, { type: "auto" }); assert.equal(body.thinking, undefined); assert.equal(body.tools[0].strict, true);
    assert.match(body.messages[0].content, /<descripcion>Una agencia para vender patatas en Madrid<\/descripcion>/);
    assert.match(body.messages[0].content, /wiwink: Wiwink \(lee: Ver facturas\)/);
    assert.doesNotMatch(body.messages[0].content, /ghl/); // not connected
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "c", name: "crear_agencia", input: {
      nombre: "Patatas Madrid", proposito: "Vender más patatas", presupuesto_mes: 7.2,
      trabajadores: [
        { nombre: "Marta", puesto: "Jefa", emoji: "🧑‍💼", color: "#112233", encargo: "Dirige.", jefe: true, web: false, conexiones: [], tareas: [{ titulo: "Parte del día", instrucciones: "Resume el día.", dias: [1, 2, 3, 4, 5], hora: "19:00" }] },
        { nombre: "Pablo", puesto: "Ventas", emoji: "📊", color: "#445566", encargo: "Mira ventas.", jefe: false, web: false, conexiones: ["wiwink", "holded"], tareas: [{ titulo: "Ventas", instrucciones: "Mira las facturas.", dias: [1], hora: "17:00" }] },
      ] } }] };
  });
  const r = await s.ag.draft("Una agencia para vender <patatas> en Madrid");
  assert.equal(r.problem, null); assert.equal(r.agency.name, "Patatas Madrid"); assert.equal(r.agency.budgetUsd, 8);
  assert.deepEqual((r.agency.workers as any[])[1].connections, ["wiwink"]);
  assert.ok(r.usd > 0);
  assert.equal(s.ag.view().items.length, 0); // only a draft
  const made = s.ag.save(r.agency);
  assert.equal(made.workers[0].boss, true);
  await assert.rejects(s.ag.draft("hi"), /cuenta en una frase/);
  assert.deepEqual(fromAgencyDraft({}).workers, []);
});

test("edit keeps id and folder; delete keeps the documents", async () => {
  const s = setup(() => deliver());
  const a = s.ag.save(agencyInput());
  const b = s.ag.save({ ...agencyInput({ name: "Otro nombre" }), id: a.id });
  assert.equal(b.id, a.id); assert.equal(b.folder, a.folder); assert.equal(b.createdAt, a.createdAt);
  s.ag.runNow(a.id, "leo", "tendencias-del-dia"); await s.ag.idle();
  const file = s.ag.detail(a.id).runs[0].file!;
  assert.deepEqual(s.ag.remove(a.id), { removed: true });
  assert.ok(fs.existsSync(path.join(s.home, file)));
  assert.equal(s.ag.view().items.length, 0);
  assert.throws(() => s.ag.detail(a.id), /ya no existe/);
  assert.throws(() => s.ag.save({ ...agencyInput(), id: "no-existe" }), /ya no existe/);
});

test("sessiond: /agencias routes; Claude goes through the Engine with the person's key", async () => {
  const dir = tmp();
  const engine = createApp(path.join(dir, "engine"), {}, {});
  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  (engine.ai as any).fetchFn = async (u: string, init: any) => {
    seen.push({ url: String(u), headers: init.headers, body: JSON.parse(init.body.toString("utf8")) });
    return new Response(JSON.stringify({ model: "claude-sonnet-5-5", usage: USAGE, ...deliver("Desde la sesión") }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const home = path.join(dir, "home"); fs.mkdirSync(home);
  const sess = createSession({ engineUrl: `http://127.0.0.1:${(engine.server.address() as any).port}`, engineToken: () => engine.token,
    runtimeDir: path.join(dir, "run"), configDir: path.join(dir, "cfg"), port: 0, homeDir: home, dataDir: path.join(dir, "data"), agencyTickMs: 0,
    spawnFn: () => ({ pid: 1, onExit: () => {} }), focusFn: async () => false, listFn: async () => [], windowPollMs: 60_000,
    fetchJson: async () => ({}), weatherEveryMs: 3_600_000, reconfigureFn: () => {}, displayFn: () => {}, updateSocket: path.join(dir, "no.sock") } as any);
  const port = await sess.start();
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) { const runs = (await call("GET", `/agencias/${id}`)).json.runs; if (runs.length && runs[0].status !== "running") return runs[0]; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error("timeout");
  };
  try {
    assert.equal((await call("GET", "/agencias/plantilla")).json.agency.name, "Agencia de marketing");
    const bad = await call("POST", "/agencias", { agency: { name: "" } });
    assert.equal(bad.status, 400); assert.match(bad.json.error, /nombre/);
    const made = await call("POST", "/agencias", { agency: agencyInput({ workers: [worker({ web: false, connections: [] })] }) });
    assert.equal(made.status, 200);
    const id = made.json.id;
    assert.equal((await call("GET", "/agencias")).json.items[0].id, id);
    assert.equal((await call("GET", "/agencias/no-existe")).status, 404);
    // no key yet: the run fails with the Spanish hint and nothing reaches Anthropic
    assert.deepEqual((await call("POST", `/agencias/${id}/run`, { worker: "leo", task: "tendencias-del-dia" })).json, { queued: true });
    assert.match((await settle(id)).error, /no tiene clave de Claude/);
    assert.equal(seen.length, 0);
    engine.ai.setKey("sk-ant-api03-" + "x".repeat(90));
    await call("POST", `/agencias/${id}/run`, { worker: "leo", task: "tendencias-del-dia" });
    await new Promise((r) => setTimeout(r, 30));
    const run = await settle(id);
    assert.equal(run.status, "done", JSON.stringify(run));
    assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.ok(seen[0].headers["x-api-key"].startsWith("sk-ant-")); // added by the Engine, never by the session
    assert.equal(seen[0].body.model, "claude-sonnet-5-5");
    const doc = await call("GET", `/agencias/${id}/doc?file=${encodeURIComponent(run.file)}`);
    assert.match(doc.json.text, /^# Desde la sesión/);
    assert.equal((await call("GET", `/agencias/${id}/doc?file=..%2F..%2Fx`)).status, 400);
    const ev = (await call("GET", "/events?since=0&wait=0")).json.events as any[];
    assert.ok(ev.some((e) => e.kind === "agency" && e.data.id === id));
    assert.ok(ev.some((e) => e.kind === "notice" && /ha terminado «Desde la sesión»/.test(e.data.text)));
    assert.equal((await call("POST", `/agencias/${id}/delete`, {})).json.removed, true);
  } finally {
    await sess.stop(); engine.server.closeAllConnections(); await new Promise<void>((r) => engine.server.close(() => r()));
  }
});

test("«Escríbelo con tus palabras»: drafts of an agent and of an automation from a prompt (nothing is created)", async () => {
  const dir = tmp();
  const home = path.join(dir, "home"); fs.mkdirSync(path.join(home, "proyectos", "web"), { recursive: true }); fs.mkdirSync(path.join(home, ".secreto"));
  fs.mkdirSync(path.join(dir, "engine"));
  fs.writeFileSync(path.join(dir, "engine", "credentials.json"), JSON.stringify({ anthropicApiKey: "sk-ant-test0123456789012345678901" }));
  // the automation draft: the Engine's own Claude client (first answer names a service that does not exist → one retry)
  const sdkSent: any[] = [];
  const sdkReplies: any[] = [
    { stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: USAGE, content: [{ type: "tool_use", id: "a1", name: "create_automation", input: { name: "x", when: "service", minutes: 0, time: "", path: "", do: "notify", service_trigger: "holded.factura", service_action: "", inputs_json: "{}", command: "", cwd: "", text: "", app: "", notify: "failure" } }] },
    { stop_reason: "tool_use", model: "claude-sonnet-5-5", usage: USAGE, content: [{ type: "tool_use", id: "a2", name: "create_automation", input: { name: "Tests de la web", when: "files", minutes: 0, time: "", path: "~/proyectos/web", do: "command", service_trigger: "", service_action: "", inputs_json: "{}", command: "npm test", cwd: "~/proyectos/web", text: "", app: "", notify: "failure" } }] },
  ];
  const aiClient = () => ({ beta: { messages: { create: async (req: any) => { sdkSent.push(structuredClone(req)); return sdkReplies.shift(); } } } }) as any;
  const engine = createApp(path.join(dir, "engine"), {}, { aiClient });
  // the agent draft: through the Engine's Claude proxy
  const seen: any[] = [];
  (engine.ai as any).fetchFn = async (_u: string, init: any) => {
    seen.push({ headers: init.headers, body: JSON.parse(init.body.toString("utf8")) });
    return new Response(JSON.stringify({ model: "claude-sonnet-5-5", usage: USAGE, stop_reason: "tool_use", content: [{ type: "tool_use", id: "g", name: "crear_agente", input: {
      nombre: "Arreglatests", carpeta: "~/proyectos/web", encargo: "Haz que pasen los tests de la web sin tocar la configuración.", permisos: ["escribir", "ejecutar"], comprobacion: "npm test", limite_usd: 4, comite: true } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await new Promise<void>((r) => engine.server.listen(0, "127.0.0.1", r));
  const sess = createSession({ engineUrl: `http://127.0.0.1:${(engine.server.address() as any).port}`, engineToken: () => engine.token,
    runtimeDir: path.join(dir, "run"), configDir: path.join(dir, "cfg"), port: 0, homeDir: home, dataDir: path.join(dir, "data"), agencyTickMs: 0,
    spawnFn: () => ({ pid: 1, onExit: () => {} }), focusFn: async () => false, listFn: async () => [], windowPollMs: 60_000,
    fetchJson: async () => ({}), weatherEveryMs: 3_600_000, reconfigureFn: () => {}, displayFn: () => {}, updateSocket: path.join(dir, "no.sock") } as any);
  const port = await sess.start();
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: `Bearer ${sess.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  try {
    // agent
    const ag = await call("POST", "/agents/draft", { texto: "un agente que arregle los tests de mi web" });
    assert.equal(ag.status, 200, JSON.stringify(ag.json));
    assert.deepEqual(ag.json.draft, { id: "", name: "Arreglatests", folderShort: "~/proyectos/web", brief: "Haz que pasen los tests de la web sin tocar la configuración.", check: "npm test",
      council: true, maxCalls: 400, maxMinutes: 240, maxTokens: 2_000_000, maxUsd: 4, perms: ["write", "exec", "read"] });
    assert.ok(ag.json.usd > 0);
    const req = seen[0].body;
    assert.deepEqual(req.tool_choice, { type: "auto" }); assert.equal(req.thinking, undefined);
    assert.match(req.messages[0].content, /<quiere>un agente que arregle los tests de mi web<\/quiere>/);
    assert.match(req.messages[0].content, /~\/proyectos\/web/); assert.doesNotMatch(req.messages[0].content, /secreto/); // hidden folders are not sent
    assert.ok(seen[0].headers["x-api-key"]); // the Engine added the key
    assert.equal((await call("GET", "/agents")).json.agents.length, 0); // only a draft
    // the brief is saved with the agent and reaches the program's instructions
    const saved = await call("POST", "/agents", { name: "Arreglatests", folder: "~/proyectos/web", brief: "Haz que pasen los tests.", scopes: ["fs://read/~/proyectos/web"] });
    assert.equal(saved.json.brief, "Haz que pasen los tests.");
    assert.equal((await call("POST", "/agents/draft", { texto: "ya" })).status, 400);
    // automation
    const au = await call("POST", "/automations/draft-text", { texto: "cada vez que guarde en mi web pasa los tests" });
    assert.equal(au.status, 200, JSON.stringify(au.json));
    assert.deepEqual(au.json.draft, { name: "Tests de la web", notify: "failure", trigger: { kind: "files", minutes: 0, time: "", path: "~/proyectos/web" }, action: { kind: "command", command: "npm test", cwd: "~/proyectos/web", text: "", app: "" } });
    assert.equal(sdkSent.length, 2);
    assert.deepEqual(sdkSent[0].tool_choice, { type: "auto" }); assert.equal(sdkSent[0].thinking, undefined);
    assert.match(sdkSent[0].system, /Their folders: .*~\/proyectos\/web/);
    assert.equal(sdkSent[1].messages.at(-1).content[0].is_error, true); assert.match(sdkSent[1].messages.at(-1).content[0].content, /service_trigger must be one of/);
    assert.equal((await call("GET", "/automations")).json.items.length, 0); // only a draft
  } finally {
    await sess.stop(); engine.server.closeAllConnections(); await new Promise<void>((r) => engine.server.close(() => r()));
  }
});
