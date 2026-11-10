// Archivos' file operations (core/src/files.ts) in a throwaway home: Papelera per the freedesktop.org spec, the
// home-only / no-hidden-paths / no-following-links rules, Recientes, search, Favoritos, new folder and rename.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFiles, validName, STANDARD_FOLDERS, exifDate, typeOf, groupLabel } from "../src/files.ts";

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-files-")));
  const home = path.join(dir, "home"), outside = path.join(dir, "outside");
  for (const d of [home, outside, path.join(home, "Documentos"), path.join(home, ".config"), path.join(home, ".ssh")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "key");
  const f = createFiles({ home, configDir: path.join(home, ".config", "nexus") });
  const p = (...parts: string[]) => path.join(f.home, ...parts);
  const write = (rel: string, text = "x", mtime?: number) => {
    fs.mkdirSync(path.dirname(p(rel)), { recursive: true }); fs.writeFileSync(p(rel), text);
    if (mtime) fs.utimesSync(p(rel), mtime / 1000, mtime / 1000);
    return p(rel);
  };
  return { dir, home: f.home, outside, f, p, write };
}

test("Papelera: a file goes to Trash/files with a spec .trashinfo, and comes back to where it was", () => {
  const { f, p, write } = setup();
  const file = write("Documentos/Examen de filosofía.txt", "apuntes");
  const { id } = f.trash(file);
  assert.equal(id, "Examen de filosofía.txt");
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(path.join(f.trashDir, "files", id), "utf8"), "apuntes");
  const info = fs.readFileSync(path.join(f.trashDir, "info", id + ".trashinfo"), "utf8");
  assert.match(info, /^\[Trash Info\]\nPath=.*\/Documentos\/Examen%20de%20filosof%C3%ADa\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
  assert.equal(fs.statSync(path.join(f.trashDir, "info", id + ".trashinfo")).mode & 0o777, 0o600);
  const list = f.listTrash();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Examen de filosofía.txt");
  assert.equal(list[0].path, file);
  assert.ok(Math.abs(list[0].deleted - Date.now()) < 5000);
  assert.deepEqual(f.restore(id), { path: file });
  assert.equal(fs.readFileSync(file, "utf8"), "apuntes");
  assert.deepEqual(f.listTrash(), []);
  assert.equal(fs.existsSync(path.join(f.trashDir, "info", id + ".trashinfo")), false);
  assert.ok(p("Documentos"));
});

test("Papelera: same names get numbered, folders keep their dots, a taken spot blocks restore, a gone folder is recreated", () => {
  const { f, p, write } = setup();
  const a1 = write("a.txt", "1"); assert.equal(f.trash(a1).id, "a.txt");
  const a2 = write("a.txt", "2"); assert.equal(f.trash(a2).id, "a.2.txt");
  fs.mkdirSync(p("Fotos.2024")); fs.mkdirSync(p("x")); fs.renameSync(p("Fotos.2024"), p("x", "Fotos.2024"));
  fs.mkdirSync(p("Fotos.2024"));
  assert.equal(f.trash(p("Fotos.2024")).id, "Fotos.2024");
  assert.equal(f.trash(p("x", "Fotos.2024")).id, "Fotos.2024.2");
  write("a.txt", "new");
  assert.throws(() => f.restore("a.txt"), /Ya hay algo llamado «a.txt» en su carpeta original/);
  const deep = write("Proyectos/2026/notas.md", "n");
  const { id } = f.trash(deep);
  fs.rmSync(p("Proyectos"), { recursive: true });
  f.restore(id);
  assert.equal(fs.readFileSync(deep, "utf8"), "n");
});

test("only inside home, never hidden paths, never the home itself, links are not followed", () => {
  const { f, p, home, outside, write } = setup();
  const msg = { outside: /dentro de tu carpeta personal/, hidden: /carpeta oculta/, home: /Eso no se puede hacer con tu carpeta personal$/, path: /Ruta no válida/ };
  assert.throws(() => f.trash(path.join(outside, "secret.txt")), msg.outside);
  assert.throws(() => f.trash("/etc/passwd"), msg.outside);
  assert.throws(() => f.trash(p("Documentos", "..", "..", "outside", "secret.txt")), msg.outside);
  assert.throws(() => f.trash("Documentos/a.txt"), msg.path);
  assert.throws(() => f.trash(p(".ssh", "id_ed25519")), msg.hidden);
  assert.throws(() => f.trash(p(".config")), msg.hidden);
  assert.throws(() => f.trash(home), msg.home);
  assert.throws(() => f.trash(home + "/"), msg.home);
  assert.throws(() => f.trash(p("no-existe.txt")), /ya no existe/);
  // a link inside home that points outside: what is behind it is out of reach, the link itself can be binned
  fs.symlinkSync(outside, p("atajo"));
  assert.throws(() => f.trash(p("atajo", "secret.txt")), msg.outside);
  assert.throws(() => f.mkdir(p("atajo"), "nueva"), msg.outside);
  assert.throws(() => f.search(p("atajo"), "secret"), msg.outside);
  const { id } = f.trash(p("atajo"));
  assert.equal(fs.lstatSync(path.join(f.trashDir, "files", id)).isSymbolicLink(), true);
  f.remove(id);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside"); // the target is untouched
  assert.equal(fs.readFileSync(p(".ssh", "id_ed25519"), "utf8"), "key");
  // a .trashinfo that claims a path outside home is never restored there
  const t = write("b.txt"); const r = f.trash(t);
  fs.writeFileSync(path.join(f.trashDir, "info", r.id + ".trashinfo"), `[Trash Info]\nPath=${outside}/b.txt\nDeletionDate=2026-11-09T01:00:00\n`);
  assert.throws(() => f.restore(r.id), msg.outside);
  assert.equal(fs.existsSync(path.join(outside, "b.txt")), false);
  for (const bad of ["", ".", "..", "../x", "a/b", "nope"]) assert.throws(() => f.restore(bad), /ya no está en la papelera/);
});

test("delete for good and empty the bin; links inside are removed without touching their targets", () => {
  const { f, outside, write, p } = setup();
  const one = f.trash(write("uno.txt")).id;
  f.trash(write("dos.txt"));
  fs.mkdirSync(p("carpeta")); write("carpeta/dentro.txt"); f.trash(p("carpeta"));
  fs.symlinkSync(path.join(outside, "secret.txt"), p("enlace")); f.trash(p("enlace"));
  f.remove(one);
  assert.equal(f.listTrash().length, 3);
  assert.deepEqual(f.empty(), { removed: 3 });
  assert.deepEqual(f.listTrash(), []);
  assert.deepEqual(fs.readdirSync(path.join(f.trashDir, "info")), []);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside");
  assert.deepEqual(f.empty(), { removed: 0 });
});

test("new folder and rename: names are checked, clashes refused, favourites follow a rename", () => {
  const { f, p, write } = setup();
  assert.deepEqual(f.mkdir(f.home, "  Waterpolo   2026 "), { path: p("Waterpolo 2026") });
  assert.throws(() => f.mkdir(f.home, "Waterpolo 2026"), /Ya existe «Waterpolo 2026» aquí/);
  for (const [bad, re] of [["", /Escribe un nombre/], ["..", /Escribe un nombre/], ["a/b", /«\/»/], [".oculta", /punto/], ["x".repeat(121), /largo/]] as const) {
    assert.throws(() => validName(bad), re);
  }
  assert.throws(() => f.mkdir(p(".config"), "x"), /oculta/);
  const doc = write("Waterpolo 2026/goles.txt");
  f.setFavorite(p("Waterpolo 2026"), true); f.setFavorite(doc, true);
  assert.deepEqual(f.rename(p("Waterpolo 2026"), "Waterpolo"), { path: p("Waterpolo") });
  assert.deepEqual(f.favorites().map((e) => e.path), [p("Waterpolo"), p("Waterpolo", "goles.txt")]);
  write("otro.txt");
  assert.throws(() => f.rename(p("otro.txt"), "Waterpolo"), /Ya existe «Waterpolo» aquí/);
  assert.throws(() => f.rename(p("otro.txt"), ".bashrc"), /punto/);
});

test("Recientes: newest files first, no folders, nothing hidden; search ignores case and accents, inside the folder", () => {
  const { f, p, write } = setup();
  const t = Date.now();
  write("Documentos/Filosofía.pdf", "x", t - 60_000);
  write("Imágenes/gol.jpg", "x", t - 1000);
  write("viejo.txt", "x", t - 86_400_000);
  write(".config/nexus/prefs.json", "{}", t);
  write(".bashrc", "", t);
  assert.deepEqual(f.recent().map((e) => e.name), ["gol.jpg", "Filosofía.pdf", "viejo.txt"]);
  assert.equal(f.recent(1).length, 1);
  const r = f.recent()[0];
  assert.equal(r.dir, false); assert.equal(r.size, 1); assert.equal(r.path, p("Imágenes", "gol.jpg"));
  assert.deepEqual(f.search(f.home, "FILOSOFIA").map((e) => e.name), ["Filosofía.pdf"]);
  assert.deepEqual(f.search(p("Imágenes"), "filo"), []);
  assert.deepEqual(f.search(f.home, "ima").map((e) => [e.name, e.dir]), [["Imágenes", true]]);
  assert.deepEqual(f.search(f.home, "prefs"), []);       // hidden folders are never searched
  assert.deepEqual(f.search(f.home, "   "), []);
  assert.throws(() => f.search(f.home, "x".repeat(101)), /demasiado larga/);
});

test("Favoritos: stored 0600 in the person's config, the ones that disappear are not shown, removing works", () => {
  const { f, p, write } = setup();
  const a = write("a.txt"), b = write("b.txt");
  f.setFavorite(a, true); f.setFavorite(b, true); f.setFavorite(a, true); // no duplicates
  const file = path.join(f.home, ".config", "nexus", "favorites.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(f.favorites().map((e) => e.name), ["b.txt", "a.txt"]);
  fs.rmSync(b);
  assert.deepEqual(f.favorites().map((e) => e.name), ["a.txt"]);
  f.setFavorite(a, false);
  assert.deepEqual(f.favorites(), []);
  assert.throws(() => f.setFavorite(p("nada.txt"), true), /ya no existe/);
  assert.throws(() => f.setFavorite(p(".ssh"), true), /oculta/);
});

test("a new home gets Documentos, Descargas, Imágenes, Música and Vídeos; what is already there is left alone", () => {
  const { f, p, write } = setup();
  write("Documentos/mío.txt", "no tocar");
  f.standardFolders(); f.standardFolders();
  for (const n of STANDARD_FOLDERS) assert.equal(fs.statSync(p(n)).isDirectory(), true);
  assert.equal(fs.readFileSync(p("Documentos", "mío.txt"), "utf8"), "no tocar");
});

// a tiny JPEG whose EXIF says when the photo was taken (all exifDate needs; not a viewable picture)
function jpegTaken(date: string, le = true): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(n); else b.writeUInt16BE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  const str = Buffer.from(date + "\0", "latin1");
  // TIFF header (8) | IFD0 at 8 with the Exif pointer (18) | Exif IFD at 26 with DateTimeOriginal (18) | the date at 44
  const tiff = Buffer.concat([Buffer.from(le ? "II" : "MM", "latin1"), u16(42), u32(8),
    u16(1), u16(0x8769), u16(4), u32(1), u32(26), u32(0),
    u16(1), u16(0x9003), u16(2), u32(str.length), u32(44), u32(0), str]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2); len.writeUInt16BE(app1.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, app1, Buffer.from([0xff, 0xd9])]);
}
const at = (y: number, m = 6, d = 15) => new Date(y, m - 1, d, 12).getTime();

test("exifDate: when a photo was taken, in both byte orders; damaged or missing EXIF gives nothing", () => {
  assert.equal(exifDate(jpegTaken("2023:07:15 18:30:05"))?.getTime(), new Date(2023, 6, 15, 18, 30, 5).getTime());
  assert.equal(exifDate(jpegTaken("2024:01:02 09:00:00", false))?.getTime(), new Date(2024, 0, 2, 9, 0, 0).getTime());
  assert.equal(exifDate(jpegTaken("0000:00:00 00:00:00")), undefined); // what cameras write when the clock was not set
  assert.equal(exifDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), undefined);
  assert.equal(exifDate(Buffer.from("not a picture")), undefined);
  const whole = jpegTaken("2023:07:15 18:30:05");
  for (let n = 0; n < whole.length; n += 7) assert.doesNotThrow(() => exifDate(whole.subarray(0, n))); // cut anywhere
  assert.equal(typeOf("Horario.PDF"), "Documentos");
  assert.equal(typeOf("notas.xlsx"), "Hojas de cálculo");
  assert.equal(typeOf("raro.xyz"), "Otros");
  assert.equal(groupLabel("2025-03 marzo"), "marzo 2025");
});

test("Organizar por año: the plan moves nothing; confirming moves exactly those files; Deshacer puts them back", () => {
  const { f, p, write, outside } = setup();
  write("Imágenes/Waterpolo/gol.jpg", "", at(2026)); fs.writeFileSync(p("Imágenes/Waterpolo/gol.jpg"), jpegTaken("2023:05:20 11:00:00"));
  fs.utimesSync(p("Imágenes/Waterpolo/gol.jpg"), at(2026) / 1000, at(2026) / 1000); // copied this year, taken in 2023
  fs.writeFileSync(p("Imágenes/Waterpolo/partido.jpg"), jpegTaken("2024:11:02 17:45:00"));
  write("Imágenes/Waterpolo/equipo.png", "png", at(2025));
  write("Imágenes/Waterpolo/final.jpg", "sin exif", at(2026));
  write("Imágenes/Waterpolo/.miniatura.jpg", "hidden", at(2022));
  write("Imágenes/Waterpolo/Viejas/2019.jpg", "in a subfolder", at(2019));
  write("Imágenes/Waterpolo/convocatoria.txt", "not a photo", at(2024));
  fs.symlinkSync(path.join(outside, "secret.txt"), p("Imágenes/Waterpolo/enlace.jpg"));
  write("Documentos/Waterpolo/horario.pdf", "pdf", at(2026));

  const plan = f.organizePlan({ target: "waterpolo", what: "photos", by: "year" });
  assert.equal(plan.folder, p("Imágenes/Waterpolo")); // the photos one, not Documentos/Waterpolo
  assert.equal(plan.place, "Imágenes › Waterpolo");
  assert.equal(plan.total, 4);
  assert.deepEqual(plan.groups.map((g) => [g.name, g.count]), [["2023", 1], ["2024", 1], ["2025", 1], ["2026", 1]]);
  assert.equal(plan.text, "En Imágenes › Waterpolo hay 4 fotos sueltas. Puedo repartirlas en 4 carpetas por año (2023–2026). No muevo nada hasta que lo confirmes.");
  assert.equal(fs.existsSync(p("Imágenes/Waterpolo/2023")), false); // nothing happened yet
  assert.equal(fs.existsSync(p("Imágenes/Waterpolo/gol.jpg")), true);

  const r = f.organizeApply(plan.id);
  assert.equal(r.moved, 4); assert.equal(r.created, 4); assert.equal(r.skipped, 0);
  assert.equal(r.text, "Hecho. He creado 4 carpetas (2023–2026) y he movido 4 fotos.");
  assert.deepEqual(r.show, { path: p("Imágenes/Waterpolo/2026"), label: "2026" });
  for (const [y, n] of [["2023", "gol.jpg"], ["2024", "partido.jpg"], ["2025", "equipo.png"], ["2026", "final.jpg"]]) assert.ok(fs.existsSync(p("Imágenes/Waterpolo", y, n)), `${y}/${n}`);
  for (const stay of [".miniatura.jpg", "Viejas/2019.jpg", "convocatoria.txt"]) assert.ok(fs.existsSync(p("Imágenes/Waterpolo", stay)), stay);
  assert.ok(fs.lstatSync(p("Imágenes/Waterpolo/enlace.jpg")).isSymbolicLink()); // links stay, never followed
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside");
  assert.throws(() => f.organizeApply(plan.id), /ya no está disponible/); // a plan runs once

  const u = f.organizeUndo(plan.id);
  assert.deepEqual([u.restored, u.failed], [4, 0]);
  assert.deepEqual([...u.removed].sort(), ["2023", "2024", "2025", "2026"].map((y) => p("Imágenes/Waterpolo", y)));
  assert.equal(u.text, "Deshecho: 4 fotos han vuelto a Imágenes › Waterpolo.");
  for (const n of ["gol.jpg", "partido.jpg", "equipo.png", "final.jpg"]) assert.ok(fs.existsSync(p("Imágenes/Waterpolo", n)), n);
  for (const y of ["2023", "2024", "2025", "2026"]) assert.equal(fs.existsSync(p("Imágenes/Waterpolo", y)), false, y);
  assert.equal(fs.readFileSync(p("Imágenes/Waterpolo/partido.jpg")).subarray(0, 2).toString("hex"), "ffd8");
  assert.throws(() => f.organizeUndo(plan.id), /ya no se puede deshacer/);
  // asked for documents, the same name picks the Documentos one
  assert.equal(f.organizePlan({ target: "Waterpolo", what: "docs", by: "type" }).folder, p("Documentos/Waterpolo"));
});

test("Organizar por tipo: never overwrites, skips a name taken by a file, and undo keeps what is new", () => {
  const { f, p, write } = setup();
  for (const n of ["informe.pdf", "notas.xlsx", "fotos.zip", "cancion.mp3", "raro.xyz", "foto.jpg"]) write("Descargas/" + n, n, at(2025));
  write("Descargas/Documentos/informe.pdf", "the old one", at(2024));     // already sorted before: must survive
  write("Descargas/Imágenes", "a FILE called Imágenes", at(2024));          // so foto.jpg has nowhere to go (this loose file is "Otros")
  const plan = f.organizePlan({ target: "", what: "all", by: "type" });  // no folder named: Descargas
  assert.equal(plan.folder, p("Descargas"));
  assert.deepEqual(plan.groups.map((g) => [g.name, g.count, g.exists]), [["Comprimidos", 1, false], ["Documentos", 1, true], ["Hojas de cálculo", 1, false], ["Música", 1, false], ["Otros", 2, false]]);
  assert.equal(plan.total, 6);
  const r = f.organizeApply(plan.id);
  assert.equal(r.text, "Hecho. He movido 6 archivos a 5 carpetas (Comprimidos, Documentos, Hojas de cálculo…); 4 son nuevas.");
  assert.equal(fs.readFileSync(p("Descargas/Documentos/informe.pdf"), "utf8"), "the old one");
  assert.equal(fs.readFileSync(p("Descargas/Documentos/informe (2).pdf"), "utf8"), "informe.pdf");
  assert.equal(r.show?.label, "Otros"); // by type, "Enséñame" goes to the biggest group
  assert.ok(fs.existsSync(p("Descargas/foto.jpg")));
  write("Descargas/Comprimidos/nuevo.zip", "arrived after", at(2026)); // something new inside a folder the plan made
  write("Descargas/notas.xlsx", "a new file took the old name", at(2026));
  const u = f.organizeUndo(plan.id);
  assert.deepEqual([u.restored, u.failed], [5, 1]);
  assert.match(u.text, /^Deshecho: 5 archivos han vuelto a Descargas\. 1 no ha podido volver porque algo ocupa su sitio\.$/);
  assert.equal(fs.readFileSync(p("Descargas/notas.xlsx"), "utf8"), "a new file took the old name"); // not overwritten
  assert.ok(fs.existsSync(p("Descargas/Hojas de cálculo/notas.xlsx")));
  assert.ok(fs.existsSync(p("Descargas/Comprimidos/nuevo.zip")));   // that folder is kept
  assert.equal(fs.existsSync(p("Descargas/Música")), false);         // emptied ones are gone
  assert.equal(fs.readFileSync(p("Descargas/Documentos/informe.pdf"), "utf8"), "the old one");
});

test("Organizar: unknown or hidden folders, nothing to sort, months, a file gone before confirming", () => {
  const { f, p, write, outside } = setup();
  assert.throws(() => f.organizePlan({ target: "cocina", what: "all", by: "year" }), /^Error: No encuentro ninguna carpeta que se llame «cocina»$/);
  assert.throws(() => f.organizePlan({ target: "ssh", what: "all", by: "year" }), /No encuentro/);   // ~/.ssh is hidden
  fs.symlinkSync(outside, p("Enlace"));
  assert.throws(() => f.organizePlan({ target: "enlace", what: "all", by: "year" }), /No encuentro/); // links are not followed
  assert.throws(() => f.organizePlan({ target: "Documentos", what: "all" }), /por año, por mes o por tipo/);
  assert.throws(() => f.organizePlan({ target: "", what: "photos", by: "year" }), /No encuentro tu carpeta Imágenes/);
  const none = f.organizePlan({ target: "documentos", what: "photos", by: "year" });
  assert.equal(none.total, 0);
  assert.equal(none.text, "En Documentos no hay fotos sueltas que ordenar: ya está organizado.");
  assert.throws(() => f.organizeApply(none.id), /ya no está disponible/);
  write("Vídeos/clip.mp4", "v", at(2025, 3, 10));
  const one = f.organizePlan({ target: "videos", what: "videos", by: "month" });
  assert.deepEqual(one.groups.map((g) => [g.name, g.label]), [["2025-03 marzo", "marzo 2025"]]);
  assert.equal(one.text, "En Vídeos hay 1 vídeo suelto. Puedo moverlo a la carpeta «2025-03 marzo». No muevo nada hasta que lo confirmes.");
  write("Vídeos/otro.mp4", "v", at(2025, 4, 1));
  const two = f.organizePlan({ target: "videos", what: "videos", by: "month" });
  fs.rmSync(p("Vídeos/otro.mp4")); // gone between the plan and the click
  const r = f.organizeApply(two.id);
  assert.deepEqual([r.moved, r.skipped], [1, 1]);
  assert.equal(r.text, "Hecho. He creado 1 carpeta (marzo 2025) y he movido 1 vídeo. 1 no se ha podido mover.");
  assert.ok(fs.existsSync(p("Vídeos/2025-03 marzo/clip.mp4")));
});
