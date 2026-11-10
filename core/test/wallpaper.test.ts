// Wallpapers (core/src/wallpaper.ts) against NEXUS's real collection (os/mkosi.extra/usr/share/nexus/wallpapers):
// what is on screen for each theme and hour, slideshows, the person's own pictures (home only), colours.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWallpapers, luminance } from "../src/wallpaper.ts";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "os", "mkosi.extra", "usr", "share", "nexus", "wallpapers");
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nexus-wall-")));

function make(prefs: Record<string, unknown>, at = new Date(2026, 10, 9, 12, 0), home = tmp()) {
  const p = { ...prefs };
  let clock = at;
  const w = createWallpapers({ dir: DIR, home, readPrefs: () => p, now: () => clock });
  return { w, p, home, setNow: (d: Date) => { clock = d; } };
}

test("the collection on disk is complete: every image, thumbnail and dynamic step exists", () => {
  const ix = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));
  assert.ok(ix.collection.length >= 8);
  for (const [id, im] of Object.entries<any>(ix.images)) {
    assert.ok(fs.existsSync(path.join(DIR, im.file)), id);
    assert.ok(fs.existsSync(path.join(DIR, im.thumb)), id + " thumb");
    assert.match(im.accent, /^#[0-9a-f]{6}$/);
    assert.ok(im.ink === "light" || im.ink === "dark");
  }
  for (const c of ix.collection) for (const id of [c.light, c.dark, ...(c.dynamic ?? []).map((d: any) => d[1])].filter(Boolean)) assert.ok(ix.images[id], `${c.id} → ${id}`);
});

test("nothing chosen: the Pantera with the dark theme, Cristal with the light one; a collection item follows the theme", () => {
  const { w, p } = make({});
  assert.equal(path.basename(w.resolve().file!), "pantera.jpg");
  p.theme = "light";
  assert.equal(path.basename(w.resolve().file!), "cristal-claro.jpg");
  assert.equal(w.resolve().ink, "dark", "a light picture gets dark text");
  p.wallpaper = "dunas";
  assert.equal(path.basename(w.resolve().file!), "dunas-dia.jpg");
  p.theme = "dark";
  assert.equal(path.basename(w.resolve().file!), "dunas-noche.jpg");
  assert.equal(w.resolve().ink, "light");
  assert.match(w.resolve().accent!, /^#[0-9a-f]{6}$/);
});

test("'Cumbres según la hora' changes with the time of day, whatever the theme", () => {
  const { w, setNow } = make({ wallpaper: "cumbres-hora", theme: "light" });
  const at = (h: number) => { setNow(new Date(2026, 10, 9, h, 30)); return path.basename(w.resolve().file!, ".jpg"); };
  assert.equal(at(3), "cumbres-noche");
  assert.equal(at(7), "cumbres-amanecer");
  assert.equal(at(12), "cumbres-dia");
  assert.equal(at(19), "cumbres-atardecer");
  assert.equal(at(23), "cumbres-noche");
});

test("a solid colour: the clock's ink comes from how light the colour is; Acento stays with the theme", () => {
  const { w, p } = make({ wallpaper: "color", wallpaperColor: "#f2cc8f" });
  assert.deepEqual([w.resolve().kind, w.resolve().color, w.resolve().ink], ["color", "#f2cc8f", "dark"]);
  p.wallpaperColor = "#1f3b4d";
  assert.equal(w.resolve().ink, "light");
  assert.ok(luminance("#ffffff") > 0.99 && luminance("#000000") < 0.01);
  p.wallpaper = "accent"; p.theme = "light";
  assert.deepEqual([w.resolve().kind, w.resolve().ink], ["accent", "dark"]);
});

test("the person's own picture: only an existing image inside their home, never a link out of it", () => {
  const { w, p, home } = make({});
  fs.mkdirSync(path.join(home, "Imágenes"));
  const mine = path.join(home, "Imágenes", "playa.jpg");
  fs.writeFileSync(mine, "jpeg");
  assert.equal(w.validate.wallpaperFile(mine), true);
  assert.equal(w.validate.wallpaperFile("/etc/passwd"), false);
  assert.equal(w.validate.wallpaperFile(path.join(home, "Imágenes", "nota.txt")), false);
  assert.equal(w.validate.wallpaperFile(path.join(home, "Imágenes", "no-existe.jpg")), false);
  assert.equal(w.validate.wallpaperFile("Imágenes/playa.jpg"), false, "relative paths are refused");
  const outside = path.join(tmp(), "fuera.jpg"); fs.writeFileSync(outside, "x");
  fs.symlinkSync(outside, path.join(home, "Imágenes", "enlace.jpg"));
  assert.equal(w.validate.wallpaperFile(path.join(home, "Imágenes", "enlace.jpg")), false, "a link that leaves the home");
  const quoted = path.join(home, "Imágenes", 'a"b.jpg'); fs.writeFileSync(quoted, "x");
  assert.equal(w.validate.wallpaperFile(quoted), false, "never a quote: the path goes into the lock screen's CSS");
  Object.assign(p, { wallpaper: "custom", wallpaperFile: mine, wallpaperFit: "fit" });
  assert.deepEqual([w.resolve().file, w.resolve().fit, w.resolve().scrim], [mine, "fit", true]);
  fs.rmSync(mine);
  assert.equal(path.basename(w.resolve().file!), "pantera.jpg", "the picture is gone: back to the default");
});

test("slideshow: the person's folder in order, a new picture every N minutes, 'Siguiente' skips ahead", () => {
  const { w, p, home, setNow } = make({});
  const dir = path.join(home, "Imágenes", "Viaje"); fs.mkdirSync(dir, { recursive: true });
  for (const f of ["b.png", "a.jpg", "c.webp", ".oculta.jpg", "notas.txt"]) fs.writeFileSync(path.join(dir, f), "x");
  assert.equal(w.validate.slideshowFolder(dir), true);
  assert.equal(w.validate.slideshowFolder("/etc"), false);
  assert.equal(w.validate.slideshowEvery(7), false);
  Object.assign(p, { wallpaper: "slideshow", slideshowFolder: dir, slideshowEvery: 10 });
  const t0 = new Date(Math.floor(Date.UTC(2026, 10, 9, 12) / 600_000) * 600_000);   // the start of a 10-minute slot
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) { setNow(new Date(t0.getTime() + i * 600_000 + 1000)); seen.push(path.basename(w.resolve().file!)); }
  assert.equal(new Set(seen.slice(0, 3)).size, 3, "three pictures, each once");
  assert.equal(seen[3], seen[0], "and round again");
  assert.ok(seen.every((f) => ["a.jpg", "b.png", "c.webp"].includes(f)), "hidden files and non-pictures are skipped");
  setNow(new Date(t0.getTime() + 1000));
  const before = w.resolve().file;
  assert.notEqual(w.next().file, before);
  // without a folder: NEXUS's own collection, the variants of the current theme
  p.slideshowFolder = "";
  assert.ok(w.resolve().file!.startsWith(DIR));
});

test("gallery for Ajustes: thumbnails for the current theme, colours, intervals and what is on screen", () => {
  const { w, p } = make({ theme: "light" });
  const g = w.gallery();
  const cumbres = g.collection.find((c) => c.id === "cumbres")!;
  assert.equal(path.basename(cumbres.thumb), "cumbres-dia.jpg");
  assert.ok(g.collection.find((c) => c.id === "cumbres-hora")!.dynamic);
  assert.ok(g.colors.length >= 8 && g.slideshowMinutes.includes(30));
  p.theme = "dark";
  assert.equal(path.basename(w.gallery().collection.find((c) => c.id === "cumbres")!.thumb), "cumbres-noche.jpg");
  assert.equal(w.validate.wallpaper("cumbres"), true);
  assert.equal(w.validate.wallpaper("../../etc/passwd"), false);
});
