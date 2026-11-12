import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Notices, checkNotice } from "../src/notices.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nexus-notices-"));

test("notices are kept newest first, on disk, with unread counts and a cap", () => {
  const dir = tmp(); const file = path.join(dir, "nexus", "notices.json");
  let t = Date.parse("2026-11-12T10:00:00Z");
  const n = new Notices(file, 3, () => new Date(t));
  const a = n.add({ text: "NEXUS OS 0.2.18 instalada.", kind: "good" });
  t += 120_000;
  n.add({ text: "Tienes correo de Ana", app: "mail", title: "Ana García" });
  t += 120_000;
  n.add({ text: "El agente espera tu clic", kind: "warn", app: "agents" });
  assert.equal(n.unread(), 3);
  assert.deepEqual(n.list().map((x) => x.id), [3, 2, 1]);
  assert.equal(n.list()[1].title, "Ana García");
  assert.equal((fs.statSync(file).mode & 0o777), 0o600);
  // it survives a restart
  const again = new Notices(file, 3, () => new Date(t));
  assert.deepEqual(again.list().map((x) => x.text), ["El agente espera tu clic", "Tienes correo de Ana", "NEXUS OS 0.2.18 instalada."]);
  assert.equal(again.markRead(a.id), 1);
  assert.equal(again.unread(), 2);
  assert.equal(again.markRead(), 2);
  assert.equal(again.unread(), 0);
  // the cap keeps the newest
  t += 120_000; again.add({ text: "cuarto" });
  assert.equal(again.list().length, 3);
  assert.equal(again.list()[0].text, "cuarto");
  assert.equal(again.list()[0].id, 4);
  assert.equal(again.remove(4), true);
  assert.equal(again.remove(4), false);
  again.clear();
  assert.equal(again.list().length, 0);
  assert.equal(new Notices(file).list().length, 0);
});

test("the same notice twice within a minute is one notice (newer time, unread again)", () => {
  let t = Date.parse("2026-11-12T10:00:00Z");
  const n = new Notices(path.join(tmp(), "n.json"), 50, () => new Date(t));
  const a = n.add({ text: "El motor de NEXUS se está reiniciando…", kind: "warn" });
  n.markRead(a.id);
  t += 20_000;
  const b = n.add({ text: "El motor de NEXUS se está reiniciando…", kind: "warn" });
  assert.equal(b.id, a.id);
  assert.equal(n.list().length, 1);
  assert.equal(n.unread(), 1);
  t += 61_000;
  assert.notEqual(n.add({ text: "El motor de NEXUS se está reiniciando…", kind: "warn" }).id, a.id);
});

test("what comes in is checked: control characters out, lengths capped, unknown kinds become info, empty refused", () => {
  const c = checkNotice({ text: "hola\u0000 mundo\n\tx".padEnd(600, "y"), kind: "loud", app: "mail; rm -rf /", title: "  " });
  assert.equal(c.text.length, 500);
  assert.ok(c.text.startsWith("hola mundo\n x"));
  assert.equal(c.kind, "info");
  assert.equal(c.app, "mail rm -rf ");
  assert.equal(c.title, undefined);
  assert.throws(() => checkNotice({ text: "   " }));
  assert.deepEqual(checkNotice({ text: "", title: "Solo título" }), { text: "Solo título", kind: "info" });
});
