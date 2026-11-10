// Automatizaciones + NEXUS Connect: "when something happens in a service" and "do something in a service".
// The Engine is a fake here (scripted polls and runs); core/test/connect.test.ts tests the real connectors.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Automations, validate, describe } from "../src/automations.ts";
import { CONNECTORS, describeConnector, type PollResult } from "../src/connect.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-autoc-")));
const APPS = { terminal: "Terminal" };
const catalog = (connected = ["wiwink", "ghl"]) => CONNECTORS.map((c) => describeConnector(c, connected.includes(c.id) ? { account: "cuenta", at: "2026-11-09T10:00:00Z" } : null));
const tick = () => new Promise((r) => setTimeout(r, 15));
const waitFor = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out"); await tick(); } };

type Call = { connector: string; op: string; input: Record<string, string>; event?: Record<string, unknown> };
function make(home: string, o: { polls?: (PollResult | Error)[]; run?: (c: Call) => Promise<Record<string, unknown>>; now?: () => Date; connected?: string[]; env?: NodeJS.ProcessEnv[] } = {}) {
  const notices: [string, string][] = []; const calls: Call[] = []; const pollStates: unknown[] = [];
  const polls = o.polls ?? [];
  const services = {
    catalog: () => catalog(o.connected),
    run: async (connector: string, op: string, input: Record<string, string>, event?: Record<string, unknown>) => {
      const c = { connector, op, input, event }; calls.push(c);
      return o.run ? o.run(c) : { ok: true, output: { contacto_id: "c1", nota_id: "n1" } };
    },
    poll: async (_c: string, _t: string, _i: Record<string, string>, state: unknown) => {
      pollStates.push(state);
      const next = polls.shift() ?? { events: [], state };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const a = new Automations({ configDir: path.join(home, ".config/nexus"), home, runtimeDir: path.join(home, "run"), apps: APPS,
    notice: (t, k) => notices.push([t, k]), changed: () => {}, launch: () => {}, hasSandbox: () => true, tickMs: 60_000, services,
    spawnFn: (argv, env) => { o.env?.push(env); return spawn("/bin/sh", ["-c", argv[argv.length - 1]], { cwd: argv[argv.indexOf("--chdir") + 1], env, stdio: ["ignore", "pipe", "pipe"] }); },
    ...(o.now ? { now: o.now } : {}) });
  return { a, notices, calls, pollStates };
}
const invoice = (n: string, cliente = "Farmacia Sol") => ({ id: n, label: `Factura ${n} · ${cliente}`, data: { factura: { numero: n, total: "121,00" }, cliente: { nombre: cliente, email: "sol@example.com" } } });
const RULE = {
  name: "Factura → nota en GHL",
  trigger: { kind: "service", connector: "wiwink", trigger: "factura", input: {} },
  action: { kind: "service", connector: "ghl", op: "nota", input: { email: "{{cliente.email}}", nota: "Factura {{factura.numero}}: {{factura.total}} €" } },
};

test("validate: service rules need a connected service, a known trigger/operation and the required fields", () => {
  const home = tmp();
  const a = validate(RULE, home, [], undefined, catalog());
  assert.deepEqual(a.trigger, { kind: "service", connector: "wiwink", trigger: "factura", input: {}, minutes: 10 }, "minutes default to the trigger's own");
  assert.deepEqual(a.action, { kind: "service", connector: "ghl", op: "nota", input: { email: "{{cliente.email}}", nota: "Factura {{factura.numero}}: {{factura.total}} €" } });
  const t2 = validate({ ...RULE, trigger: { kind: "service", connector: "ghl", trigger: "etiqueta", input: { etiqueta: " pedido " }, minutes: 15 } }, home, [], undefined, catalog());
  assert.deepEqual(t2.trigger, { kind: "service", connector: "ghl", trigger: "etiqueta", input: { etiqueta: "pedido" }, minutes: 15 });
  const bad: [any, RegExp, any?][] = [
    [{ ...RULE, trigger: { ...RULE.trigger, connector: "ghl" } }, /qué vigilar en GoHighLevel/],
    [{ ...RULE, trigger: { kind: "service", connector: "ghl", trigger: "etiqueta", input: {} } }, /rellena «Etiqueta»/],
    [{ ...RULE, action: { ...RULE.action, op: "borrar_todo" } }, /qué hacer en GoHighLevel/],
    [{ ...RULE, action: { kind: "service", connector: "ghl", op: "nota", input: { email: "x@y.es" } } }, /rellena «Nota»/],
    [{ ...RULE, trigger: { ...RULE.trigger, minutes: 0.5 } }, /entre 1 y 1440/],
    [{ ...RULE, trigger: { ...RULE.trigger, connector: "nada" } }, /elige el servicio/],
    [RULE, /GoHighLevel no está conectado: conéctalo primero en la app Conexiones/, catalog(["wiwink"])],
    [RULE, /el motor de NEXUS no responde/, null],
  ];
  for (const [input, re, cat] of bad) assert.throws(() => validate(input, home, [], undefined, cat === undefined ? catalog() : cat), re, JSON.stringify(input));
});

test("describe: what a service rule does, in plain Spanish", () => {
  const a = validate({ ...RULE, trigger: { kind: "service", connector: "ghl", trigger: "etiqueta", input: { etiqueta: "pedido" } } }, "/h", [], undefined, catalog());
  assert.deepEqual(describe(a, "/h", {}, catalog()), { when: "GoHighLevel: un contacto recibe una etiqueta («pedido»), lo mira cada 5 min", what: "GoHighLevel: añadir una nota a un contacto" });
  assert.equal(describe(a, "/h", {}, null).what, "ghl: nota", "without the catalog: the ids, never a crash");
});

test("first check only notes what exists; later each new invoice runs the action once, with its data", async () => {
  const home = tmp();
  const { a, notices, calls, pollStates } = make(home, { polls: [
    { events: [], state: { ready: true, seen: ["F1", "F2"] }, baseline: 2 },
    { events: [invoice("F3"), invoice("F4", "Farmacia Luna")], state: { ready: true, seen: ["F1", "F2", "F3", "F4"] } },
  ] });
  const r = a.save_(RULE);
  await waitFor(() => !a.view()[0].watch!.checking);
  assert.equal(calls.length, 0, "the baseline runs nothing");
  assert.deepEqual(notices, [["Factura → nota en GHL: vigilando. Ya había 2; solo actuará con lo nuevo", "info"]]);
  assert.equal(a.view()[0].watch!.baseline, 2);
  assert.equal(a.history(r.id).length, 0);
  // "Comprobar ahora" asks the service; the state from the last check goes back to the Engine
  assert.deepEqual(a.runNow(r.id), { started: true, checking: true });
  await waitFor(() => a.history(r.id).length === 2);
  assert.deepEqual(pollStates[1], { ready: true, seen: ["F1", "F2"] });
  assert.deepEqual(calls.map((c) => [c.connector, c.op, c.event?.factura]), [["ghl", "nota", { numero: "F3", total: "121,00" }], ["ghl", "nota", { numero: "F4", total: "121,00" }]], "one after another, oldest first");
  assert.equal(calls[0].input.nota, "Factura {{factura.numero}}: {{factura.total}} €", "the template is filled in by the Engine, with the event");
  const h = a.history(r.id);
  assert.deepEqual(h.map((x) => x.reason), ["Factura F4 · Farmacia Luna", "Factura F3 · Farmacia Sol"]);
  assert.ok(h.every((x) => x.ok)); assert.match(h[0].output, /contacto id: c1\nnota id: n1/);
  // saved: a restart does not see F3/F4 as new
  const st = JSON.parse(fs.readFileSync(path.join(home, ".config/nexus/automation-state.json"), "utf8"));
  assert.deepEqual(st[r.id].state, { ready: true, seen: ["F1", "F2", "F3", "F4"] });
  assert.equal(fs.statSync(path.join(home, ".config/nexus/automation-state.json")).mode & 0o777, 0o600);
  a.stop();
});

test("the timer: checks every N minutes of its own; a notice action fills in the event; a burst gives 3 notices + one summary", async () => {
  const home = tmp();
  let now = new Date("2026-11-09T10:00:00Z");
  const five = ["F3", "F4", "F5", "F6", "F7"].map((n) => invoice(n));
  const { a, notices } = make(home, { now: () => now, polls: [{ events: [], state: { ready: true, seen: [] }, baseline: 0 }, { events: five, state: { ready: true, seen: [] } }] });
  const r = a.save_({ ...RULE, action: { kind: "notify", text: "Nueva factura de {{cliente.nombre}}: {{factura.total}} €" } });
  await waitFor(() => notices.length === 1);
  now = new Date("2026-11-09T10:09:00Z"); a.check(); await tick();
  assert.equal(a.history(r.id).length, 0, "9 minutes: not yet");
  now = new Date("2026-11-09T10:10:00Z"); a.check();
  await waitFor(() => a.history(r.id).length === 5 && notices.length === 5);
  assert.deepEqual(notices.slice(1), [
    ["Nueva factura de Farmacia Sol: 121,00 €", "info"], ["Nueva factura de Farmacia Sol: 121,00 €", "info"], ["Nueva factura de Farmacia Sol: 121,00 €", "info"],
    ["Factura → nota en GHL: y 2 más (los tienes en Automatizaciones)", "info"],
  ]);
  assert.equal(a.view()[0].next, new Date("2026-11-09T10:20:00Z").toISOString());
  a.stop();
});

test("a command gets the event as JSON in $NEXUS_EVENTO, never pasted into the command line", async () => {
  const home = tmp(); fs.mkdirSync(path.join(home, "p"));
  const env: NodeJS.ProcessEnv[] = [];
  const evil = { id: "F9", label: "Factura F9", data: { cliente: { nombre: "$(touch PWNED)" } } };
  const { a } = make(home, { env, polls: [{ events: [], state: {}, baseline: 0 }, { events: [evil], state: {} }] });
  const r = a.save_({ ...RULE, action: { kind: "command", command: "printf '%s' \"$NEXUS_EVENTO\" > evento.json; echo \"$NEXUS_EVENTO_TITULO\"", cwd: "~/p" } });
  await waitFor(() => !a.view()[0].watch!.checking);
  a.runNow(r.id);
  await waitFor(() => a.history(r.id).length === 1);
  assert.equal(a.history(r.id)[0].ok, true); assert.equal(a.history(r.id)[0].output.trim(), "Factura F9");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "p/evento.json"), "utf8")), evil.data);
  assert.ok(!fs.existsSync(path.join(home, "p/PWNED")));
  assert.ok(!("NEXUS_TOKEN" in env[0]) && env[0].HOME === home);
  a.stop();
});

test("errors: a failed action says why; a failing check is written down once, not every 10 minutes", async () => {
  const home = tmp();
  let now = new Date("2026-11-09T10:00:00Z");
  const { a, notices } = make(home, { now: () => now,
    run: async () => { throw new Error("GoHighLevel no encuentra ese contacto (404)"); },
    polls: [{ events: [], state: {}, baseline: 0 }, { events: [invoice("F3")], state: {} }, new Error("Wiwink no acepta la clave (401)"), new Error("Wiwink no acepta la clave (401)"), new Error("Wiwink no acepta la clave (401)")] });
  const r = a.save_(RULE);
  await waitFor(() => notices.length === 1);
  a.runNow(r.id);
  await waitFor(() => a.history(r.id).length === 1);
  const h = a.history(r.id)[0];
  assert.equal(h.ok, false); assert.equal(h.output, "No se ha hecho: GoHighLevel no encuentra ese contacto (404)");
  assert.deepEqual(notices[1], ["Factura → nota en GHL: no se ha hecho (GoHighLevel no encuentra ese contacto (404))", "warn"]);
  now = new Date("2026-11-09T10:10:00Z"); a.check();
  await waitFor(() => a.history(r.id).length === 2);
  assert.equal(a.history(r.id)[0].output, "No se ha podido comprobar: Wiwink no acepta la clave (401)");
  assert.equal(a.view()[0].watch!.error, "Wiwink no acepta la clave (401)");
  now = new Date("2026-11-09T10:20:00Z"); a.check(); await tick(); await tick();
  assert.equal(a.history(r.id).length, 2, "the same problem 10 minutes later: not written down again");
  now = new Date("2026-11-09T16:30:00Z"); a.check();
  await waitFor(() => a.history(r.id).length === 3);
  assert.equal(notices.filter((n) => /no se ha podido comprobar/.test(n[0])).length, 2, "…but again after 6 hours");
  a.stop();
});

test("a new setup or switching it back on starts from a new baseline; pending things survive a restart", async () => {
  const home = tmp();
  const { a, pollStates } = make(home, { polls: [{ events: [], state: { v: 1 }, baseline: 1 }, { events: [], state: { v: 2 }, baseline: 1 }, { events: [], state: { v: 3 }, baseline: 1 }] });
  const r = a.save_(RULE);
  await waitFor(() => pollStates.length === 1 && !a.view()[0].watch!.checking);
  a.save_({ ...RULE, id: r.id, trigger: { kind: "service", connector: "wiwink", trigger: "cliente", input: {} } });
  await waitFor(() => pollStates.length === 2 && !a.view()[0].watch!.checking);
  assert.equal(pollStates[1], undefined, "another trigger: the old state is not used");
  a.setEnabled(r.id, false); a.setEnabled(r.id, true);
  await waitFor(() => pollStates.length === 3);
  assert.equal(pollStates[2], undefined, "back on: what happened while it was off is not replayed");
  a.stop();
  // things found and not yet run when the session stopped are run after the restart
  const f = path.join(home, ".config/nexus/automation-state.json");
  const st = JSON.parse(fs.readFileSync(f, "utf8")); st[r.id].pending = [{ id: "C9", label: "Cliente C9", data: { cliente: { email: "c9@example.com" } } }];
  fs.writeFileSync(f, JSON.stringify(st));
  const again = make(home);
  again.a.start();
  await waitFor(() => again.a.history(r.id).length === 1);
  assert.equal(again.calls[0].event?.cliente && (again.calls[0].event.cliente as any).email, "c9@example.com");
  again.a.stop();
});

test("stopping a service action, and without NEXUS Connect a service rule never runs anything", async () => {
  const home = tmp();
  let release!: () => void;
  const { a } = make(home, { polls: [{ events: [], state: {}, baseline: 0 }, { events: [invoice("F3"), invoice("F4")], state: {} }],
    run: () => new Promise((r) => { release = () => r({ ok: true, output: {} }); }) });
  const r = a.save_(RULE);
  await waitFor(() => !a.view()[0].watch!.checking);
  a.runNow(r.id);
  await waitFor(() => a.view()[0].running);
  assert.equal(a.view()[0].watch!.queued, 1);
  assert.deepEqual(a.stopRun(r.id), { ok: true });
  await waitFor(() => a.history(r.id).length === 1);
  assert.equal(a.history(r.id)[0].killed, "stopped"); assert.match(a.history(r.id)[0].output, /puede que el servicio la haya hecho/);
  release();
  await tick();
  assert.equal(a.history(r.id).length, 1, "the late answer is ignored, and F4 was dropped");
  a.stop();
  const b = new Automations({ configDir: path.join(home, "b"), home, runtimeDir: path.join(home, "rb"), apps: APPS, notice: () => {}, changed: () => {}, launch: () => {}, hasSandbox: () => true });
  assert.throws(() => b.save_(RULE), /el motor de NEXUS no responde/);
});
