// NEXUS Archivos: the file operations the Files app asks nexus-sessiond for (Papelera, Recientes, Favoritos, search,
// new folder, rename). Everything stays inside the person's home folder and never touches hidden paths (dot-files and
// dot-folders: settings, keys, the Trash itself). Links are never followed: trashing a link moves only the link.
// Papelera follows the freedesktop.org Trash spec (~/.local/share/Trash/{files,info}), so other Linux apps share the bin.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Entry { name: string; path: string; dir: boolean; size: number; mtime: number }
export interface TrashEntry extends Entry { id: string; deleted: number }

const MAX_NAME = 120;
const MAX_FAVORITES = 100;
/** The folders a person expects in a new home (what xdg-user-dirs would make), in Spanish. */
export const STANDARD_FOLDERS = ["Documentos", "Descargas", "Imágenes", "Música", "Vídeos"];
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

const MESSAGES: Record<string, string> = {
  EACCES: "No tienes permiso para eso", EPERM: "No tienes permiso para eso", ENOENT: "Ese archivo ya no existe",
  EEXIST: "Ya existe algo con ese nombre", ENOTEMPTY: "Ya existe algo con ese nombre", ENOSPC: "No queda espacio en el disco",
  EXDEV: "Ese archivo está en otro disco y no puede ir a la papelera", ENOTDIR: "Eso no es una carpeta",
};
// system errors become a short Spanish sentence for the person; our own errors pass through
function friendly(e: any): Error { return e && typeof e.code === "string" ? new Error(MESSAGES[e.code] ?? "No se ha podido hacer") : e; }
function safe<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  return (...a: A) => { try { return fn(...a); } catch (e) { throw friendly(e); } };
}

/** A file or folder name the person typed: trimmed, no "/", not hidden, not "." or "..". */
export function validName(name: unknown): string {
  const n = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!n || n === "." || n === "..") throw new Error("Escribe un nombre");
  if (n.length > MAX_NAME) throw new Error("El nombre es demasiado largo");
  if (/[/\0]/.test(n)) throw new Error("El nombre no puede llevar «/»");
  if (n.startsWith(".")) throw new Error("El nombre no puede empezar por un punto");
  return n;
}

// ---- "Organiza mis fotos de waterpolo por año": sort the loose files of one folder into subfolders
export type OrganizeWhat = "photos" | "videos" | "music" | "docs" | "all";
export type OrganizeBy = "year" | "month" | "type";
export const ORGANIZE_WHAT: OrganizeWhat[] = ["photos", "videos", "music", "docs", "all"];
export const ORGANIZE_BY: OrganizeBy[] = ["year", "month", "type"];
const TYPES: [string, RegExp][] = [
  ["Imágenes", /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg|avif|dng|cr2|nef|arw)$/i],
  ["Vídeos", /\.(mp4|mov|m4v|mkv|webm|avi|wmv|3gp)$/i],
  ["Música", /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i],
  ["Documentos", /\.(pdf|docx?|odt|rtf|txt|md|epub|pages)$/i],
  ["Hojas de cálculo", /\.(xlsx?|ods|csv|numbers)$/i],
  ["Presentaciones", /\.(pptx?|odp|key)$/i],
  ["Comprimidos", /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|zst)$/i],
  ["Programas", /\.(deb|appimage|flatpakref|sh|run|exe|msi|dmg|apk)$/i],
];
/** The Archivos type folder a file name belongs to ("Imágenes", "Documentos"… or "Otros"). */
export const typeOf = (name: string) => TYPES.find(([, re]) => re.test(name))?.[0] ?? "Otros";
const WANTS: Record<OrganizeWhat, (t: string) => boolean> = {
  photos: (t) => t === "Imágenes", videos: (t) => t === "Vídeos", music: (t) => t === "Música",
  docs: (t) => t === "Documentos" || t === "Hojas de cálculo" || t === "Presentaciones", all: () => true,
};
// where to look when the person names no folder
const HOME_OF: Record<OrganizeWhat, string> = { photos: "Imágenes", videos: "Vídeos", music: "Música", docs: "Documentos", all: "Descargas" };
const NOUN: Record<OrganizeWhat, [string, string, boolean]> = { // singular, plural, feminine
  photos: ["foto", "fotos", true], videos: ["vídeo", "vídeos", false], music: ["canción", "canciones", true],
  docs: ["documento", "documentos", false], all: ["archivo", "archivos", false],
};
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const count = (k: number, w: OrganizeWhat) => `${k} ${NOUN[w][k === 1 ? 0 : 1]}`;
const folders = (k: number) => k === 1 ? "1 carpeta" : `${k} carpetas`;
/** How a group folder reads in a sentence: "2025-03 marzo" → "marzo 2025". */
export const groupLabel = (g: string) => { const m = /^(\d{4})-\d{2} (\p{L}+)$/u.exec(g); return m ? `${m[2]} ${m[1]}` : g; };
function span(names: string[], by: OrganizeBy) {
  if (by === "type") return names.slice(0, 3).join(", ") + (names.length > 3 ? "…" : "");
  return names.length === 1 ? groupLabel(names[0]) : `${groupLabel(names[0])}–${groupLabel(names[names.length - 1])}`;
}
const BY_WORD: Record<OrganizeBy, string> = { year: "año", month: "mes", type: "tipo" };
export function planText(place: string, what: OrganizeWhat, by: OrganizeBy, total: number, groups: string[]) {
  const [, plural, fem] = NOUN[what];
  if (!total) return `En ${place} no hay ${plural} suelt${fem ? "as" : "os"} que ordenar: ya está organizado.`;
  const end = "No muevo nada hasta que lo confirmes.";
  if (total === 1) return `En ${place} hay 1 ${NOUN[what][0]} suelt${fem ? "a" : "o"}. Puedo ${fem ? "moverla" : "moverlo"} a la carpeta «${groups[0]}». ${end}`;
  if (groups.length === 1) return `En ${place} hay ${count(total, what)} suelt${fem ? "as" : "os"}. Puedo ${fem ? "moverlas" : "moverlos"} a la carpeta «${groups[0]}». ${end}`;
  return `En ${place} hay ${count(total, what)} suelt${fem ? "as" : "os"}. Puedo ${fem ? "repartirlas" : "repartirlos"} en ${folders(groups.length)} por ${BY_WORD[by]} (${span(groups, by)}). ${end}`;
}
export function doneText(what: OrganizeWhat, by: OrganizeBy, moved: number, groups: string[], created: number, skipped: number) {
  if (!moved) return `No he movido nada: ${NOUN[what][2] ? "las" : "los"} ${NOUN[what][1]} ya no estaban o habían cambiado.`;
  const s = span(groups, by);
  let t = created === groups.length ? `Hecho. He creado ${folders(created)} (${s}) y he movido ${count(moved, what)}.`
    : created === 0 ? `Hecho. He movido ${count(moved, what)} a ${folders(groups.length)} (${s}).`
    : `Hecho. He movido ${count(moved, what)} a ${folders(groups.length)} (${s}); ${created === 1 ? "1 es nueva" : `${created} son nuevas`}.`;
  if (skipped) t += ` ${skipped === 1 ? "1 no se ha podido mover" : `${skipped} no se han podido mover`}.`;
  return t;
}
export function undoText(what: OrganizeWhat, place: string, restored: number, failed: number) {
  let t = `Deshecho: ${restored === 1 ? `1 ${NOUN[what][0]} ha vuelto` : `${count(restored, what)} han vuelto`} a ${place}.`;
  if (failed) t += ` ${failed === 1 ? "1 no ha podido volver" : `${failed} no han podido volver`} porque algo ocupa su sitio.`;
  return t;
}

/** When a JPEG photo was taken, from its EXIF data (DateTimeOriginal, else DateTimeDigitized, else DateTime). */
export function exifDate(b: Buffer): Date | undefined {
  try {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / image data: no EXIF before it
      const len = b.readUInt16BE(i + 2);
      if (marker === 0xe1 && b.toString("latin1", i + 4, i + 10) === "Exif\0\0") return tiffDate(b.subarray(i + 10, Math.min(b.length, i + 2 + len)));
      i += 2 + len;
    }
  } catch { /* damaged file */ }
  return undefined;
}
function tiffDate(t: Buffer): Date | undefined {
  const order = t.toString("latin1", 0, 2);
  if (order !== "II" && order !== "MM") return undefined;
  const le = order === "II";
  const u16 = (o: number) => le ? t.readUInt16LE(o) : t.readUInt16BE(o);
  const u32 = (o: number) => le ? t.readUInt32LE(o) : t.readUInt32BE(o);
  const tags = (ifd: number) => { // tag → where its 12-byte entry starts
    const m = new Map<number, number>();
    if (ifd + 2 > t.length) return m;
    for (let k = 0, n = u16(ifd); k < n && ifd + 14 + 12 * k <= t.length; k++) m.set(u16(ifd + 2 + 12 * k), ifd + 2 + 12 * k);
    return m;
  };
  const ascii = (e?: number) => {
    if (e === undefined) return undefined;
    const n = u32(e + 4), at = n <= 4 ? e + 8 : u32(e + 8);
    return at + n <= t.length ? t.toString("latin1", at, at + n) : undefined;
  };
  const ifd0 = tags(u32(4)), ptr = ifd0.get(0x8769);
  const exif = ptr === undefined ? new Map<number, number>() : tags(u32(ptr + 8));
  const s = ascii(exif.get(0x9003)) ?? ascii(exif.get(0x9004)) ?? ascii(ifd0.get(0x0132));
  const m = s ? /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s) : null;
  if (!m || +m[1] < 1900 || +m[2] < 1 || +m[2] > 12) return undefined; // cameras write "0000:00:00 00:00:00" when unset
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(d.getTime()) ? d : undefined;
}
/** When a file was made: the photo's EXIF date for JPEGs, else when it was last changed. The EXIF block sits at the
 *  start of the file and is at most 64 KB, so only the first 72 KB are read (a folder of thousands of photos stays quick). */
export function fileDate(full: string, mtimeMs: number): Date {
  if (/\.jpe?g$/i.test(full)) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(full, "r");
      const buf = Buffer.alloc(73_728), n = fs.readSync(fd, buf, 0, buf.length, 0);
      const d = exifDate(buf.subarray(0, n));
      if (d) return d;
    } catch { /* unreadable: fall back */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return new Date(mtimeMs);
}

export function createFiles(o: { home: string; configDir: string; dataDir?: string; walkLimit?: number }) {
  const home = fs.realpathSync(o.home);
  const trashDir = path.join(o.dataDir ?? path.join(home, ".local", "share"), "Trash");
  const tFiles = path.join(trashDir, "files"), tInfo = path.join(trashDir, "info");
  const favFile = path.join(o.configDir, "favorites.json");
  const walkLimit = o.walkLimit ?? 20_000;

  // `full` is already free of links in its folders: it must be inside home and have no hidden part
  const check = (full: string, allowHome: boolean): string => {
    if (full === home) { if (allowHome) return home; throw new Error("Eso no se puede hacer con tu carpeta personal"); }
    const rel = path.relative(home, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Solo se puede trabajar dentro de tu carpeta personal");
    if (rel.split(path.sep).some((c) => c.startsWith("."))) throw new Error("Esa es una carpeta oculta del sistema");
    return full;
  };
  // an absolute path from the app: its folders are resolved (links included), its last part is not followed
  const resolve = (p: unknown, allowHome = false): string => {
    const s = String(p ?? "");
    if (!s.startsWith("/") || s.includes("\0")) throw new Error("Ruta no válida");
    const norm = path.normalize(s).replace(/(.)\/+$/, "$1");
    let dir: string;
    try { dir = fs.realpathSync(path.dirname(norm)); } catch { throw new Error("Esa carpeta ya no existe"); }
    return check(norm === "/" ? "/" : path.join(dir, path.basename(norm)), allowHome);
  };
  // a folder to work in (search root, parent of a new folder): fully resolved, so a link cannot lead outside home
  const realDir = (p: unknown): string => {
    const full = fs.realpathSync(resolve(p, true));
    check(full, true);
    if (!fs.statSync(full).isDirectory()) throw new Error("Eso no es una carpeta");
    return full;
  };
  const entry = (full: string): Entry | null => {
    try {
      const st = fs.lstatSync(full);
      return { name: path.basename(full), path: full, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) };
    } catch { return null; }
  };
  // visible entries below `base`, links not followed, at most walkLimit of them
  const walk = (base: string, visit: (full: string, d: fs.Dirent) => void, depth = 8) => {
    let seen = 0;
    const go = (dir: string, left: number) => {
      let list: fs.Dirent[];
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const d of list) {
        if (seen >= walkLimit) return;
        if (d.name.startsWith(".")) continue;
        seen++;
        const full = path.join(dir, d.name);
        visit(full, d);
        if (d.isDirectory() && left > 0) go(full, left - 1);
      }
    };
    go(base, depth);
  };

  // ---- Recientes and search
  const recent = (limit = 40): Entry[] => {
    const out: Entry[] = [];
    walk(home, (full, d) => { if (d.isFile()) { const e = entry(full); if (e) out.push(e); } });
    return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  };
  const search = (base: unknown, q: unknown, limit = 200): Entry[] => {
    const root = realDir(base);
    const needle = fold(String(q ?? "").trim());
    if (!needle) return [];
    if (needle.length > 100) throw new Error("La búsqueda es demasiado larga");
    const out: Entry[] = [];
    walk(root, (full, d) => { if (out.length < limit && fold(d.name).includes(needle)) { const e = entry(full); if (e) out.push(e); } });
    return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "es"));
  };

  // ---- Papelera (freedesktop.org Trash spec)
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
  const decodePath = (p: string) => p.split("/").map((c) => decodeURIComponent(c)).join("/");
  const readInfo = (id: string): { path: string; deleted: number } | null => {
    try {
      const t = fs.readFileSync(path.join(tInfo, id + ".trashinfo"), "utf8");
      const p = /^Path=(.*)$/m.exec(t), d = /^DeletionDate=(.*)$/m.exec(t);
      const deleted = d ? Date.parse(d[1]) : NaN;
      return { path: p ? decodePath(p[1].trim()) : "", deleted: Number.isFinite(deleted) ? deleted : 0 };
    } catch { return null; }
  };
  const validId = (x: unknown): string => {
    const id = String(x ?? "");
    if (!id || id === "." || id === ".." || /[/\0]/.test(id) || !exists(path.join(tFiles, id))) throw new Error("Ese elemento ya no está en la papelera");
    return id;
  };

  const trash = (p: unknown) => {
    const full = resolve(p);
    const st = fs.lstatSync(full);
    fs.mkdirSync(tFiles, { recursive: true, mode: 0o700 }); fs.mkdirSync(tInfo, { recursive: true, mode: 0o700 });
    const base = path.basename(full);
    const ext = st.isDirectory() ? "" : path.extname(base);
    const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
    for (let n = 1; n < 10_000; n++) {
      const id = n === 1 ? base : `${stem}.${n}${ext}`;
      const info = path.join(tInfo, id + ".trashinfo");
      let fd: number;
      try { fd = fs.openSync(info, "wx", 0o600); } catch (e: any) { if (e.code === "EEXIST") continue; throw e; } // reserves the name (spec)
      if (exists(path.join(tFiles, id))) { fs.closeSync(fd); fs.rmSync(info, { force: true }); continue; }
      fs.writeSync(fd, `[Trash Info]\nPath=${encodePath(full)}\nDeletionDate=${stamp(new Date())}\n`); fs.closeSync(fd);
      try { fs.renameSync(full, path.join(tFiles, id)); } catch (e) { fs.rmSync(info, { force: true }); throw e; }
      return { id };
    }
    throw new Error("Hay demasiados archivos con ese nombre en la papelera");
  };
  const listTrash = (): TrashEntry[] => {
    let ids: string[];
    try { ids = fs.readdirSync(tFiles); } catch { return []; }
    const out: TrashEntry[] = [];
    for (const id of ids) {
      const e = entry(path.join(tFiles, id)); if (!e) continue;
      const info = readInfo(id);
      out.push({ ...e, id, name: path.basename(info?.path || id), path: info?.path ?? "", deleted: info?.deleted || e.mtime });
    }
    return out.sort((a, b) => b.deleted - a.deleted);
  };
  // folders are created one by one under the nearest existing one, which must itself be inside home
  const ensureDir = (dir: string) => {
    const missing: string[] = []; let cur = dir;
    while (!exists(cur)) { missing.unshift(path.basename(cur)); cur = path.dirname(cur); }
    let at = check(fs.realpathSync(cur), true);
    for (const m of missing) { at = path.join(at, m); check(at, false); fs.mkdirSync(at); }
  };
  const restore = (x: unknown) => {
    const id = validId(x);
    const info = readInfo(id);
    if (!info || !info.path.startsWith("/")) throw new Error("No se sabe dónde estaba este elemento");
    const lexical = path.normalize(info.path);
    check(lexical, false);
    ensureDir(path.dirname(lexical));
    const dest = resolve(lexical);
    if (exists(dest)) throw new Error(`Ya hay algo llamado «${path.basename(dest)}» en su carpeta original`);
    fs.renameSync(path.join(tFiles, id), dest);
    fs.rmSync(path.join(tInfo, id + ".trashinfo"), { force: true });
    return { path: dest };
  };
  const remove = (x: unknown) => {
    const id = validId(x);
    fs.rmSync(path.join(tFiles, id), { recursive: true, force: true }); // a link is removed, never its target
    fs.rmSync(path.join(tInfo, id + ".trashinfo"), { force: true });
    return { ok: true };
  };
  const empty = () => {
    let ids: string[] = [];
    try { ids = fs.readdirSync(tFiles); } catch { /* no bin yet */ }
    for (const id of ids) fs.rmSync(path.join(tFiles, id), { recursive: true, force: true });
    try { for (const f of fs.readdirSync(tInfo)) if (f.endsWith(".trashinfo")) fs.rmSync(path.join(tInfo, f), { force: true }); } catch { /* none */ }
    fs.rmSync(path.join(trashDir, "directorysizes"), { force: true });
    return { removed: ids.length };
  };

  // ---- new folder, rename
  const mkdir = (parent: unknown, name: unknown) => {
    const target = path.join(realDir(parent), validName(name));
    if (exists(target)) throw new Error(`Ya existe «${path.basename(target)}» aquí`);
    fs.mkdirSync(target);
    return { path: target };
  };
  const rename = (p: unknown, name: unknown) => {
    const full = resolve(p);
    if (!exists(full)) throw new Error("Ese archivo ya no existe");
    const target = path.join(path.dirname(full), validName(name));
    if (target === full) return { path: full };
    if (exists(target)) throw new Error(`Ya existe «${path.basename(target)}» aquí`);
    fs.renameSync(full, target);
    const favs = readFav();
    if (favs.some((f) => f === full || f.startsWith(full + "/"))) saveFav(favs.map((f) => f === full ? target : f.startsWith(full + "/") ? target + f.slice(full.length) : f));
    return { path: target };
  };

  // ---- Favoritos: ~/.config/nexus/favorites.json, absolute paths; the ones that no longer exist are not shown
  function readFav(): string[] {
    try { const a = JSON.parse(fs.readFileSync(favFile, "utf8")); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; }
  }
  function saveFav(a: string[]) {
    fs.mkdirSync(o.configDir, { recursive: true });
    fs.writeFileSync(favFile + ".tmp", JSON.stringify(a, null, 2), { mode: 0o600 }); fs.renameSync(favFile + ".tmp", favFile);
  }
  const favorites = (): Entry[] => {
    const out: Entry[] = [];
    for (const f of readFav()) { try { const e = entry(resolve(f)); if (e) out.push(e); } catch { /* moved out of reach */ } }
    return out;
  };
  const setFavorite = (p: unknown, on: boolean) => {
    const full = resolve(p);
    if (on && !exists(full)) throw new Error("Ese archivo ya no existe");
    const rest = readFav().filter((f) => f !== full);
    if (on && rest.length >= MAX_FAVORITES) throw new Error(`Ya tienes ${MAX_FAVORITES} favoritos`);
    saveFav(on ? [...rest, full] : rest);
    return { ok: true, favorite: on };
  };

  // made once when missing (never touches what is there; a read-only home is fine)
  const standardFolders = () => {
    for (const n of STANDARD_FOLDERS) { const d = path.join(home, n); if (!exists(d)) { try { fs.mkdirSync(d); } catch { /* skip */ } } }
  };

  // ---- Organizar (asked through NEXUS AI). Three steps, each its own request:
  //   plan   — find the folder, decide where each loose file would go, keep that plan under an id. Nothing moves.
  //   apply  — only after the person clicked "Organizar": move the files of that exact plan, never overwriting anything.
  //   undo   — put every moved file back and remove the folders the plan made (when they are empty again).
  type Plan = { id: string; folder: string; what: OrganizeWhat; by: OrganizeBy; moves: { name: string; group: string }[]; groups: string[]; at: number };
  type Done = { id: string; folder: string; what: OrganizeWhat; moves: { from: string; to: string }[]; created: string[] };
  const plans = new Map<string, Plan>(), done = new Map<string, Done>();
  const PLAN_TTL = 15 * 60_000, MAX_ORGANIZE = 10_000;
  const place = (dir: string) => dir === home ? "tu carpeta personal" : path.relative(home, dir).split(path.sep).join(" › ");
  const keep = <T>(m: Map<string, T>, id: string, v: T) => { m.set(id, v); while (m.size > 10) m.delete(m.keys().next().value!); };

  // the folder the person means: "waterpolo" → ~/Imágenes/Waterpolo (exact name first, then the one under the usual
  // folder for that kind of file, then the shallowest); no name → the usual folder (photos → Imágenes, all → Descargas)
  const findFolder = (target: string, what: OrganizeWhat): string => {
    const t = fold(target).replace(/\s+/g, " ").trim();
    if (!t) {
      const d = path.join(home, HOME_OF[what]);
      if (!exists(d)) throw new Error(`No encuentro tu carpeta ${HOME_OF[what]}`);
      return realDir(d);
    }
    const prefer = path.join(home, HOME_OF[what]) + path.sep;
    const found: { full: string; exact: boolean }[] = [];
    walk(home, (full, d) => { if (d.isDirectory()) { const n = fold(d.name); if (n === t || n.includes(t)) found.push({ full, exact: n === t }); } });
    if (!found.length) throw new Error(`No encuentro ninguna carpeta que se llame «${target.trim()}»`);
    const depth = (p: string) => p.split(path.sep).length;
    found.sort((a, b) => Number(b.exact) - Number(a.exact) || Number(b.full.startsWith(prefer)) - Number(a.full.startsWith(prefer)) || depth(a.full) - depth(b.full) || a.full.localeCompare(b.full, "es"));
    return realDir(found[0].full);
  };
  const groupOf = (full: string, mtimeMs: number, by: OrganizeBy) => {
    if (by === "type") return typeOf(path.basename(full));
    const d = fileDate(full, mtimeMs);
    return by === "year" ? String(d.getFullYear()) : `${d.getFullYear()}-${two(d.getMonth() + 1)} ${MONTHS[d.getMonth()]}`;
  };
  const view = (p: Plan) => {
    const counts = new Map<string, number>();
    for (const m of p.moves) counts.set(m.group, (counts.get(m.group) ?? 0) + 1);
    const groups = p.groups.map((name) => ({ name, label: groupLabel(name), count: counts.get(name) ?? 0, exists: exists(path.join(p.folder, name)) }));
    return { id: p.id, folder: p.folder, place: place(p.folder), what: p.what, by: p.by, total: p.moves.length, groups, text: planText(place(p.folder), p.what, p.by, p.moves.length, p.groups) };
  };

  const organizePlan = (q: { target?: unknown; what?: unknown; by?: unknown }) => {
    const what = ORGANIZE_WHAT.includes(q.what as OrganizeWhat) ? q.what as OrganizeWhat : "all";
    const by = ORGANIZE_BY.includes(q.by as OrganizeBy) ? q.by as OrganizeBy : undefined;
    if (!by) throw new Error("Dime si lo ordeno por año, por mes o por tipo");
    const target = String(q.target ?? "").slice(0, 80);
    const folder = findFolder(target, what);
    const moves: Plan["moves"] = [];
    for (const d of fs.readdirSync(folder, { withFileTypes: true })) {
      if (d.name.startsWith(".") || !d.isFile()) continue; // folders, links and hidden files stay where they are
      if (!WANTS[what](typeOf(d.name))) continue;
      if (moves.length >= MAX_ORGANIZE) throw new Error("Hay demasiados archivos para ordenarlos de una vez (más de 10.000)");
      const full = path.join(folder, d.name), st = fs.lstatSync(full);
      const group = groupOf(full, st.mtimeMs, by);
      const g = path.join(folder, group);
      if (exists(g) && !fs.lstatSync(g).isDirectory()) continue; // a file already has that folder's name: leave these alone
      moves.push({ name: d.name, group });
    }
    const groups = [...new Set(moves.map((m) => m.group))].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
    const plan: Plan = { id: randomBytes(6).toString("hex"), folder, what, by, moves, groups, at: Date.now() };
    for (const [id, p] of plans) if (Date.now() - p.at > PLAN_TTL) plans.delete(id);
    if (moves.length) keep(plans, plan.id, plan);
    return view(plan);
  };

  // hard link + unlink: the move fails instead of replacing a file that appeared at the destination meanwhile
  const moveNoClobber = (from: string, to: string) => {
    try { fs.linkSync(from, to); } catch (e: any) {
      if (e.code === "EEXIST" || exists(to)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      fs.renameSync(from, to); return; // a disk without hard links (a USB stick): the plain move
    }
    try { fs.unlinkSync(from); } catch (e) { fs.rmSync(to, { force: true }); throw e; }
  };
  const freeName = (dir: string, name: string) => {
    if (!exists(path.join(dir, name))) return path.join(dir, name);
    const ext = path.extname(name), stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
    for (let n = 2; n < 1000; n++) { const c = path.join(dir, `${stem} (${n})${ext}`); if (!exists(c)) return c; }
    throw new Error(`Hay demasiados archivos llamados «${name}»`);
  };

  const organizeApply = (x: unknown) => {
    const p = plans.get(String(x ?? ""));
    if (!p || Date.now() - p.at > PLAN_TTL) throw new Error("Ese plan ya no está disponible. Pídemelo otra vez");
    plans.delete(p.id); // a plan runs once
    if (realDir(p.folder) !== p.folder) throw new Error("La carpeta ha cambiado de sitio. Pídemelo otra vez");
    const moved: Done["moves"] = [], created: string[] = [];
    let skipped = 0;
    for (const m of p.moves) {
      try {
        const from = path.join(p.folder, m.name), st = fs.lstatSync(from);
        if (!st.isFile()) { skipped++; continue; }
        const dir = path.join(p.folder, m.group);
        if (!exists(dir)) { fs.mkdirSync(dir); created.push(dir); } else if (!fs.lstatSync(dir).isDirectory()) { skipped++; continue; }
        for (let tries = 0; ; tries++) {
          const to = freeName(dir, m.name);
          try { moveNoClobber(from, to); moved.push({ from, to }); break; } catch (e: any) { if (e.code !== "EEXIST" || tries > 5) throw e; }
        }
      } catch { skipped++; } // gone, renamed or locked meanwhile: the rest still move
    }
    keep(done, p.id, { id: p.id, folder: p.folder, what: p.what, moves: moved, created });
    const groups = p.groups.filter((g) => moved.some((m) => path.dirname(m.to) === path.join(p.folder, g)));
    const counts = groups.map((g) => moved.filter((m) => path.dirname(m.to) === path.join(p.folder, g)).length);
    // the folder to show first: the newest year/month, or the biggest type
    const show = p.by === "type" ? groups[counts.indexOf(Math.max(...counts))] : groups[groups.length - 1];
    return {
      id: p.id, folder: p.folder, place: place(p.folder), what: p.what, by: p.by, moved: moved.length, skipped, created: created.length,
      groups: groups.map((g, i) => ({ name: g, label: groupLabel(g), count: counts[i] })),
      show: show ? { path: path.join(p.folder, show), label: groupLabel(show) } : null,
      text: doneText(p.what, p.by, moved.length, groups, created.length, skipped),
    };
  };
  const organizeUndo = (x: unknown) => {
    const j = done.get(String(x ?? ""));
    if (!j) throw new Error("Eso ya no se puede deshacer");
    done.delete(j.id);
    let restored = 0, failed = 0;
    for (const m of [...j.moves].reverse()) {
      try { if (!fs.lstatSync(m.to).isFile()) throw new Error("changed"); moveNoClobber(m.to, m.from); restored++; } catch { failed++; }
    }
    const removed: string[] = [];
    for (const d of j.created) { try { fs.rmdirSync(d); removed.push(d); } catch { /* not empty: something new is inside, keep it */ } }
    return { restored, failed, removed, folder: j.folder, place: place(j.folder), text: undoText(j.what, place(j.folder), restored, failed) };
  };
  const organizeCancel = (x: unknown) => ({ ok: plans.delete(String(x ?? "")) });
  // a folder for Archivos to show (from NEXUS AI's "Enséñame 2026")
  const folder = (p: unknown) => realDir(p);

  return {
    home, trashDir, standardFolders,
    recent: safe(recent), search: safe(search), favorites: safe(favorites), setFavorite: safe(setFavorite),
    trash: safe(trash), listTrash: safe(listTrash), restore: safe(restore), remove: safe(remove), empty: safe(empty),
    mkdir: safe(mkdir), rename: safe(rename), folder: safe(folder),
    organizePlan: safe(organizePlan), organizeApply: safe(organizeApply), organizeUndo: safe(organizeUndo), organizeCancel,
  };
}
