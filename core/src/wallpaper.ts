// Desktop wallpapers (Ajustes → Apariencia → Fondo): which picture, colour or slideshow is on screen right now.
// nexus-sessiond decides it (light/dark theme, time of day, slideshow interval) and tells the desktop and the lock
// screen, so both always agree. The collection is drawn by os/art/make-wallpapers.py into
// /usr/share/nexus/wallpapers (index.json: images + collection). The person's own pictures must be inside their home.
import fs from "node:fs";
import path from "node:path";

export type WallImage = { file: string; thumb: string; ink: "light" | "dark"; accent: string; name: string };
export type WallItem = { id: string; name: string; light?: string; dark?: string; dynamic?: [number, string][] };
export type WallIndex = { version: number; images: Record<string, WallImage>; collection: WallItem[] };
export type Fit = "fill" | "fit" | "center";
export type Resolved = {
  id: string;                       // what is chosen: a collection id, "color", "accent", "custom" or "slideshow"
  kind: "image" | "color" | "accent";
  file?: string;                    // absolute path of the picture (kind image)
  name?: string;
  color?: string;                   // kind color
  ink: "light" | "dark";            // the text colour that reads well over it (the desktop clock)
  accent?: string;                  // the accent colour that goes with it (collection pictures)
  fit: Fit;
  scrim: boolean;                   // one of the person's pictures: the middle is softened so the clock stays readable
};

export const SLIDESHOW_MINUTES = [1, 5, 10, 30, 60, 1440];
export const WALL_COLORS = ["#0b0e17", "#1b2033", "#2b2d42", "#3a2e5f", "#1f3b4d", "#0f4c5c", "#2d6a4f", "#7c6cff", "#b83b5e", "#e07a5f", "#f2cc8f", "#eef1f8"];
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;
const UNSAFE = /[\n\r"\\]/;   // never in a path that ends up in the lock screen's CSS

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function createWallpapers(o: { dir: string; home: string; readPrefs: () => Record<string, unknown>; now?: () => Date; maxFolderImages?: number }) {
  const now = o.now ?? (() => new Date());
  let cached: { mtime: number; index: WallIndex } | null = null;
  const index = (): WallIndex => {
    const f = path.join(o.dir, "index.json");
    try {
      const mtime = fs.statSync(f).mtimeMs;
      if (!cached || cached.mtime !== mtime) {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        cached = { mtime, index: { version: Number(j.version) || 1, images: j.images ?? {}, collection: Array.isArray(j.collection) ? j.collection : [] } };
      }
      return cached.index;
    } catch { return { version: 1, images: {}, collection: [] }; }
  };
  let offset = 0;   // "Siguiente fondo" during a slideshow

  // an existing picture / folder inside the person's home, also after following links
  const inHome = (p: unknown, kind: "file" | "dir"): string | null => {
    if (typeof p !== "string" || !path.isAbsolute(p) || p.length > 4096 || UNSAFE.test(p)) return null;
    try {
      const real = fs.realpathSync(p);
      const home = fs.realpathSync(o.home);
      if (real !== home && !real.startsWith(home + path.sep)) return null;
      if (UNSAFE.test(real)) return null;
      const st = fs.statSync(real);
      if (kind === "file" ? !st.isFile() || !IMAGE_EXT.test(real) : !st.isDirectory()) return null;
      return real;
    } catch { return null; }
  };

  const validate: Record<string, (v: unknown) => boolean> = {
    wallpaper: (v) => typeof v === "string" && (["accent", "color", "custom", "slideshow"].includes(v) || index().collection.some((c) => c.id === v)),
    wallpaperColor: (v) => typeof v === "string" && HEX.test(v),
    wallpaperFile: (v) => inHome(v, "file") !== null,
    wallpaperFit: (v) => v === "fill" || v === "fit" || v === "center",
    slideshowEvery: (v) => typeof v === "number" && SLIDESHOW_MINUTES.includes(v),
    slideshowFolder: (v) => v === "" || inHome(v, "dir") !== null,
    accentAuto: (v) => typeof v === "boolean",   // the accent colour follows the wallpaper
  };

  const variant = (item: WallItem, dark: boolean, hour: number): string | undefined => {
    if (item.dynamic?.length) {
      const steps = [...item.dynamic].sort((a, b) => a[0] - b[0]);
      let pick = steps[steps.length - 1][1];   // before the first step of the day it is still the last one (night)
      for (const [h, id] of steps) if (hour >= h) pick = id;
      return pick;
    }
    return dark ? item.dark ?? item.light : item.light ?? item.dark;
  };
  const fromImage = (id: string, imageId: string | undefined, fit: Fit): Resolved | null => {
    const im = imageId ? index().images[imageId] : undefined;
    if (!im || typeof im.file !== "string" || UNSAFE.test(im.file) || im.file.includes("..")) return null;
    return { id, kind: "image", file: path.join(o.dir, im.file), name: im.name, ink: im.ink === "dark" ? "dark" : "light",
      accent: typeof im.accent === "string" && HEX.test(im.accent) ? im.accent : undefined, fit, scrim: false };
  };
  const listFolder = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.startsWith(".") && IMAGE_EXT.test(d.name) && !UNSAFE.test(d.name))
        .map((d) => path.join(dir, d.name)).sort((a, b) => a.localeCompare(b, "es")).slice(0, o.maxFolderImages ?? 2000);
    } catch { return []; }
  };

  const resolve = (): Resolved => {
    const p = o.readPrefs();
    const dark = p.theme !== "light";
    const d = now();
    const fit: Fit = p.wallpaperFit === "fit" || p.wallpaperFit === "center" ? p.wallpaperFit : "fill";
    const choice = typeof p.wallpaper === "string" ? p.wallpaper : "";
    if (choice === "accent") return { id: "accent", kind: "accent", ink: dark ? "light" : "dark", fit, scrim: false };
    if (choice === "color") {
      const c = typeof p.wallpaperColor === "string" && HEX.test(p.wallpaperColor) ? p.wallpaperColor : dark ? "#0b0e17" : "#eef1f8";
      return { id: "color", kind: "color", color: c, ink: luminance(c) > 0.6 ? "dark" : "light", fit, scrim: false };
    }
    if (choice === "custom") {
      const f = inHome(p.wallpaperFile, "file");
      if (f) return { id: "custom", kind: "image", file: f, name: path.basename(f), ink: "light", fit, scrim: true };
    }
    if (choice === "slideshow") {
      const every = typeof p.slideshowEvery === "number" && SLIDESHOW_MINUTES.includes(p.slideshowEvery) ? p.slideshowEvery : 30;
      const slot = Math.floor(d.getTime() / 60_000 / every) + offset;   // from the clock: no state to keep
      const pick = <T>(list: T[]) => list[((slot % list.length) + list.length) % list.length];
      const folder = p.slideshowFolder ? inHome(p.slideshowFolder, "dir") : null;
      const own = folder ? listFolder(folder) : [];
      if (own.length) { const f = pick(own); return { id: "slideshow", kind: "image", file: f, name: path.basename(f), ink: "light", fit, scrim: true }; }
      const ix = index();
      const ids = [...new Set(ix.collection.filter((c) => !c.dynamic?.length).map((c) => variant(c, dark, d.getHours())))]
        .filter((x): x is string => !!x && !!ix.images[x]);
      if (ids.length) { const r = fromImage("slideshow", pick(ids), fit); if (r) return r; }
    }
    const item = index().collection.find((c) => c.id === choice);
    if (item) { const r = fromImage(item.id, variant(item, dark, d.getHours()), fit); if (r) return r; }
    // nothing chosen yet (or it is gone): Pantera with the dark theme (the NEXUS look), Cristal with the light one
    return (dark ? fromImage("pantera", "pantera", "fill") : fromImage("cristal", "cristal-claro", "fill")) ?? fromImage("aurora", "aurora", "fill")
      ?? { id: "accent", kind: "accent", ink: dark ? "light" : "dark", fit: "fill", scrim: false };
  };

  // what Ajustes shows: the collection (each with its thumbnail for the current theme), the colours, what is on screen
  const gallery = () => {
    const p = o.readPrefs();
    const dark = p.theme !== "light";
    const hour = now().getHours();
    const ix = index();
    return {
      collection: ix.collection.map((c) => {
        const im = ix.images[variant(c, dark, hour) ?? ""];
        return { id: c.id, name: c.name, dynamic: !!c.dynamic?.length, thumb: im && !UNSAFE.test(im.thumb) ? path.join(o.dir, im.thumb) : "", accent: im?.accent ?? "" };
      }).filter((c) => c.thumb),
      colors: WALL_COLORS,
      slideshowMinutes: SLIDESHOW_MINUTES,
      current: resolve(),
    };
  };

  return {
    index, validate, resolve, gallery,
    next: () => { offset++; return resolve(); },
    folderImages: (dir: string) => { const d = inHome(dir, "dir"); return d ? listFolder(d) : []; },
  };
}
