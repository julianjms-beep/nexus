// NEXUS Update: signed, verified and reversible updates of NEXUS OS itself (Ajustes → Actualizaciones).
//
// A release is everything NEXUS puts on top of Debian: os/mkosi.extra plus what os/build.sh stages (the engine, the
// node runtime, Claude Code, the VERSION file) and NEXUS's own Debian packages (labwc with the window animations).
// buildRelease() describes every file of that tree in a manifest (path → sha256 + mode, or a link's target) and packs
// the files that changed since each earlier release into a bundle:
//     bundle.tar = bundle.json {version, from, manifest, post?} + files/<path> + debs/<name>.deb (+ post.sh)
// The channel is a plain HTTP(S) folder: latest.json names the newest version and its bundles (with their sha256), and
// latest.json.sig is its ed25519 signature. Nothing is trusted before that signature checks against NEXUS's public key;
// the bundle must then match its signed sha256 and every file its sha256 in the bundle's manifest. A version older than
// (or equal to) the installed one is never installed: going back is only the local, saved copy ("Deshacer").
//
// Installing (createUpdater().install, run as root by nexus-updated): save a copy of every file it will replace or
// remove, put the new files in place one by one (write + rename, so a file is never half-written), install the
// packages, restart what changed and check the system is healthy; if anything fails, put everything back exactly as
// it was. A journal on disk makes an install cut short (power cut, crash) roll back on the next start, and an update
// that needs a restart is checked after it: if NEXUS does not come back healthy twice, the previous version returns.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type FileEntry = { path: string; type: "file"; sha256: string; mode: number; size: number };
export type LinkEntry = { path: string; type: "link"; target: string };
export type Entry = FileEntry | LinkEntry;
export type Deb = { package: string; version: string; sha256: string; file: string };
export type Manifest = { version: string; files: Entry[]; debs: Deb[] };
export type BundleInfo = { from: string; file: string; sha256: string; size: number };   // from: a version, or "*" (everything)
export type Latest = { version: string; released: string; notes: string[]; bundles: BundleInfo[] };
export type BundleHeader = { version: string; from: string; manifest: Manifest; post?: string };
export type HistoryItem = { version: string; from: string; at: string; result: "installed" | "rolled-back" | "undone" | "failed" | "repaired"; detail?: string; kind?: "nexus" | "debian" };
export type State = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "verifying" | "reboot" | "error";
export type Status = {
  state: State;
  installed: string;
  available?: { version: string; notes: string[]; size: number; released: string; failedBefore?: boolean };   // failedBefore: it was undone by itself here once
  progress?: number;                 // 0..1 while downloading or installing
  lastCheck?: string;                // ISO time of the last successful check
  message?: string;                  // what happened, in words for Ajustes
  checkFailed?: boolean;             // the last check did not reach the channel (or did not like what it got)
  canUndo?: { version: string };     // the saved copy "Deshacer" goes back to
  autoDownload: boolean;
};

export const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DEB_NAME = /^[a-z0-9][a-z0-9+.-]{0,99}$/;
const DEB_VERSION = /^[A-Za-z0-9.+:~-]{1,100}$/;
const DEB_FILE = /^[A-Za-z0-9._+~-]{1,200}\.deb$/;
// Only /usr and /etc belong to a release: never the person's home, /var (state), /boot (Debian's kernel) or /run.
export const RELEASE_ROOTS = ["usr", "etc"];
// Never part of a release: the file that describes the installation itself, and the dev image's SSH keys (each
// machine keeps its own).
const NOT_IN_RELEASE = new Set(["/usr/lib/nexus/update/factory.json"]);
export const notInRelease = (p: string) => NOT_IN_RELEASE.has(p) || p.startsWith("/etc/ssh/authorized_keys/");
// The packages whose new version needs a restart of the computer to take effect.
const REBOOT_PACKAGES = /^(labwc|linux-image.*|systemd|libc6|greetd)$/;

export function cmpVersion(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function safePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length > 1024 || /[\0\n\r]/.test(p)) return false;
  if (path.posix.normalize(p) !== p || p.endsWith("/")) return false;
  const parts = p.split("/");
  return parts[0] === "" && RELEASE_ROOTS.includes(parts[1]) && parts.length > 2 && !parts.includes("..") && !parts.includes(".");
}

export function validManifest(m: unknown): m is Manifest {
  if (!m || typeof m !== "object") return false;
  const x = m as Manifest;
  if (typeof x.version !== "string" || !VERSION_RE.test(x.version) || !Array.isArray(x.files) || !Array.isArray(x.debs)) return false;
  const seen = new Set<string>();
  for (const e of x.files) {
    if (!e || !safePath(e.path) || seen.has(e.path) || notInRelease(e.path)) return false;
    seen.add(e.path);
    if (e.type === "file") {
      if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256) || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777 || !Number.isInteger(e.size) || e.size < 0) return false;
    } else if (e.type === "link") {
      if (typeof e.target !== "string" || !e.target || e.target.length > 1024 || /[\0\n]/.test(e.target)) return false;
    } else return false;
  }
  const pk = new Set<string>();
  for (const d of x.debs) {
    if (!d || typeof d.package !== "string" || !DEB_NAME.test(d.package) || pk.has(d.package)) return false;
    if (typeof d.version !== "string" || !DEB_VERSION.test(d.version) || typeof d.sha256 !== "string" || !HEX64.test(d.sha256)) return false;
    if (typeof d.file !== "string" || !DEB_FILE.test(d.file)) return false;
    pk.add(d.package);
  }
  return true;
}

function validLatest(l: unknown): l is Latest {
  if (!l || typeof l !== "object") return false;
  const x = l as Latest;
  return typeof x.version === "string" && VERSION_RE.test(x.version) && typeof x.released === "string"
    && Array.isArray(x.notes) && x.notes.every((n) => typeof n === "string" && n.length < 500) && x.notes.length < 60
    && Array.isArray(x.bundles) && x.bundles.length > 0 && x.bundles.every((b) => b && (b.from === "*" || VERSION_RE.test(b.from))
      && typeof b.file === "string" && /^[A-Za-z0-9._-]{1,120}\.tar$/.test(b.file) && HEX64.test(b.sha256) && Number.isInteger(b.size) && b.size > 0);
}

// ---------------------------------------------------------------- signatures (ed25519, keys in PEM)
export function sign(text: string, privateKeyPem: string): string {
  return crypto.sign(null, Buffer.from(text), crypto.createPrivateKey(privateKeyPem)).toString("base64");
}
export function verify(text: string, sigB64: string, publicKeyPem: string): boolean {
  try {
    const sig = Buffer.from(sigB64.trim(), "base64");
    return sig.length === 64 && crypto.verify(null, Buffer.from(text), crypto.createPublicKey(publicKeyPem), sig);
  } catch { return false; }
}

export function sha256File(f: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(f, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

// ---------------------------------------------------------------- the release tree
/** Every file and link under <tree>/usr and <tree>/etc, sorted by path (directories are implied by their files). */
export function scanTree(tree: string): Entry[] {
  const out: Entry[] = [];
  const walk = (dir: string, rel: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name), p = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(abs, p);
      else if (d.isSymbolicLink()) { if (!notInRelease(p)) out.push({ path: p, type: "link", target: fs.readlinkSync(abs) }); }
      else if (d.isFile()) {
        if (notInRelease(p)) continue;
        const st = fs.statSync(abs);
        out.push({ path: p, type: "file", sha256: sha256File(abs), mode: st.mode & 0o7777, size: st.size });
      }
    }
  };
  for (const r of RELEASE_ROOTS) if (fs.existsSync(path.join(tree, r))) walk(path.join(tree, r), `/${r}`);
  for (const e of out) if (!safePath(e.path)) throw new Error(`a release cannot contain ${JSON.stringify(e.path)}`);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const sameEntry = (a: Entry | undefined, b: Entry) => !!a && a.type === b.type
  && (a.type === "file" ? a.sha256 === (b as FileEntry).sha256 && a.mode === (b as FileEntry).mode : a.target === (b as LinkEntry).target);
/** What going from `from` to `to` changes: entries to write, paths to delete, packages to install. */
export function changedEntries(to: Manifest, from: Manifest | null) {
  const old = new Map((from?.files ?? []).map((e) => [e.path, e]));
  const now = new Set(to.files.map((e) => e.path));
  const debsOld = new Map((from?.debs ?? []).map((d) => [d.package, d]));
  return {
    write: to.files.filter((e) => !sameEntry(old.get(e.path), e)),
    remove: (from?.files ?? []).filter((e) => !now.has(e.path)).map((e) => e.path),
    debs: to.debs.filter((d) => debsOld.get(d.package)?.sha256 !== d.sha256),
  };
}

/** Make release `version` from `tree` in the channel folder: its manifest, a bundle from each earlier release (the
 *  newest five) and one with everything, then the signed latest.json. `debs`: NEXUS's own packages (path + name +
 *  version, read by the caller with dpkg-deb). `tar(args, cwd)` runs tar (GNU or BSD). */
export function buildRelease(o: {
  tree: string; version: string; channel: string; privateKeyPem: string; notes: string[];
  debs?: { path: string; package: string; version: string }[]; post?: string; full?: boolean;
  tar: (args: string[], cwd: string) => void; now?: () => Date;
}): Latest {
  if (!VERSION_RE.test(o.version)) throw new Error(`version must look like 1.2.3, not ${o.version}`);
  const relDir = path.join(o.channel, "releases"), bunDir = path.join(o.channel, "bundles");
  fs.mkdirSync(relDir, { recursive: true }); fs.mkdirSync(bunDir, { recursive: true });
  const earlier = fs.readdirSync(relDir).filter((v) => VERSION_RE.test(v)).sort(cmpVersion);
  if (earlier.some((v) => cmpVersion(v, o.version) >= 0)) throw new Error(`the channel already has ${earlier.at(-1)}: a new release must be newer`);
  const debs: Deb[] = (o.debs ?? []).map((d) => ({ package: d.package, version: d.version, sha256: sha256File(d.path), file: path.basename(d.path) }));
  const manifest: Manifest = { version: o.version, files: scanTree(o.tree), debs };
  if (!validManifest(manifest)) throw new Error("the release tree does not make a valid manifest");
  fs.mkdirSync(path.join(relDir, o.version));
  fs.writeFileSync(path.join(relDir, o.version, "manifest.json"), JSON.stringify(manifest));
  const postHash = o.post ? sha256File(o.post) : undefined;

  const pack = (from: string, base: Manifest | null): BundleInfo => {
    const c = changedEntries(manifest, base);
    const stage = fs.mkdtempSync(path.join(o.channel, ".stage-"));
    try {
      const header: BundleHeader = { version: o.version, from, manifest, ...(postHash ? { post: postHash } : {}) };
      fs.writeFileSync(path.join(stage, "bundle.json"), JSON.stringify(header));
      for (const e of c.write) if (e.type === "file") {
        const dst = path.join(stage, "files", e.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(path.join(o.tree, e.path), dst);
      }
      for (const d of c.debs) {
        fs.mkdirSync(path.join(stage, "debs"), { recursive: true });
        fs.copyFileSync(o.debs!.find((x) => path.basename(x.path) === d.file)!.path, path.join(stage, "debs", d.file));
      }
      if (o.post) fs.copyFileSync(o.post, path.join(stage, "post.sh"));
      const file = `nexus-${o.version}-from-${from === "*" ? "any" : from}.tar`;
      o.tar(["-cf", path.join(bunDir, file), "."], stage);
      const f = path.join(bunDir, file);
      return { from, file, sha256: sha256File(f), size: fs.statSync(f).size };
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  };
  const bundles: BundleInfo[] = [];
  for (const v of earlier.slice(-5)) {
    const m = JSON.parse(fs.readFileSync(path.join(relDir, v, "manifest.json"), "utf8"));
    if (validManifest(m)) bundles.push(pack(v, m));
  }
  if (o.full !== false || bundles.length === 0) bundles.push(pack("*", null));   // the first release: only "everything"
  const latest: Latest = { version: o.version, released: (o.now ?? (() => new Date()))().toISOString(), notes: o.notes, bundles };
  const text = JSON.stringify(latest, null, 2);
  fs.writeFileSync(path.join(o.channel, "latest.json.tmp"), text);
  fs.writeFileSync(path.join(o.channel, "latest.json.sig.tmp"), sign(text, o.privateKeyPem) + "\n");
  fs.renameSync(path.join(o.channel, "latest.json.sig.tmp"), path.join(o.channel, "latest.json.sig"));
  fs.renameSync(path.join(o.channel, "latest.json.tmp"), path.join(o.channel, "latest.json"));
  return latest;
}

/** os-release after an update: the version in PRETTY_NAME, VERSION, VERSION_ID and IMAGE_VERSION becomes the new one. */
export function bumpOsRelease(text: string, version: string): string {
  const out = text.replace(/^(PRETTY_NAME|VERSION|VERSION_ID|IMAGE_VERSION)=(.*)$/gm, (_l, k: string, v: string) => `${k}=${v.replace(/\d+\.\d+(\.\d+)?/, version)}`);
  return /^IMAGE_VERSION=/m.test(out) ? out : out.replace(/\n?$/, `\nIMAGE_VERSION="${version}"\n`);
}

// ---------------------------------------------------------------- the updater (root, nexus-updated)
export type RunFn = (cmd: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number; cwd?: string }) => Promise<{ code: number; out: string }>;
export type UpdaterOptions = {
  root?: string;                       // "/" for real; a temporary folder in the tests
  stateDir: string;                    // /var/lib/nexus-update: installed.json, history, journal, the saved copy, packages
  cacheDir: string;                    // /var/cache/nexus-update: downloads
  publicKeyPem: string;
  factoryManifest: string;             // /usr/lib/nexus/update/factory.json (what the image came with)
  channel: () => string;               // base URL of the channel, ending in "/"
  fetchFn?: typeof fetch;
  run: RunFn;                          // tar, dpkg, the post-install script
  restart: (changed: string[]) => Promise<void>;   // restart the services that use these paths
  healthy: () => Promise<boolean>;     // NEXUS works: engine answering, session and desktop up and not crashing
  bootId?: () => string;               // tells a restart of the daemon from a restart of the computer
  reboot?: () => Promise<void>;
  now?: () => Date;
  healthTries?: number;                // checks before giving up on an update (each check takes its own time)
  onStatus?: (s: Status) => void;
};

export function createUpdater(o: UpdaterOptions) {
  const root = o.root ?? "/";
  const now = o.now ?? (() => new Date());
  const fetchFn = o.fetchFn ?? fetch;
  const bootId = o.bootId ?? (() => { try { return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { return "?"; } });
  const abs = (p: string) => path.join(root, p);
  const sd = (...p: string[]) => path.join(o.stateDir, ...p);
  fs.mkdirSync(o.stateDir, { recursive: true, mode: 0o700 }); fs.mkdirSync(o.cacheDir, { recursive: true, mode: 0o700 });

  const readJson = <T>(f: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return fallback; } };
  const writeJson = (f: string, v: unknown) => { fs.writeFileSync(f + ".tmp", JSON.stringify(v, null, 1), { mode: 0o600 }); fs.renameSync(f + ".tmp", f); };
  const installed = (): Manifest => {
    for (const f of [sd("installed.json"), o.factoryManifest]) { const m = readJson<unknown>(f, null); if (validManifest(m)) return m; }
    return { version: "0.0.0", files: [], debs: [] };
  };
  const settings = () => readJson<{ autoDownload?: boolean }>(sd("settings.json"), {});
  const history = (): HistoryItem[] => readJson<HistoryItem[]>(sd("history.json"), []);
  const addHistory = (h: HistoryItem) => writeJson(sd("history.json"), [h, ...history()].slice(0, 50));
  const backupInfo = () => readJson<{ from: string; to: string } | null>(sd("backup", "backup.json"), null);

  let st: Status = { state: "idle", installed: installed().version, autoDownload: settings().autoDownload !== false };
  let latest: Latest | null = readJson<Latest | null>(sd("latest.json"), null);
  const set = (p: Partial<Status>) => {
    const b = backupInfo();
    st = { ...st, ...p, installed: installed().version, autoDownload: settings().autoDownload !== false, canUndo: b ? { version: b.from } : undefined };
    o.onStatus?.(st);
    return st;
  };
  {
    const last = readJson<{ lastCheck?: string }>(sd("checked.json"), {});
    const ready = readJson<{ version?: string } | null>(sd("ready.json"), null);
    if (latest && validLatest(latest) && cmpVersion(latest.version, installed().version) > 0) {
      const a = { version: latest.version, notes: latest.notes, size: 0, released: latest.released };
      st = { ...st, state: ready?.version === latest.version ? "ready" : "available", available: a };
    }
    if (last.lastCheck) st.lastCheck = last.lastCheck;
    set({});
  }
  // one operation at a time, in the order asked: a check that comes while a download is finishing waits its turn
  // instead of failing (and an "install" asked the moment the download says "ready" is never lost to a "busy")
  let busy = false;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => { busy = true; try { return await fn(); } finally { busy = false; } });
    queue = run.catch(() => {});
    return run;
  };

  // ------------------------------------------------ check
  // network trouble in words (fetch only says "fetch failed"); anything else as it came
  const why = (e: unknown) => {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code ?? "";
    if (err.name === "TimeoutError" || err.name === "AbortError") return "el canal de actualizaciones no ha contestado a tiempo";
    if (/^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ECONNRESET|EAI_AGAIN)$/.test(code)) return "no hay conexión con el canal de actualizaciones";
    return err.message;
  };
  const check = () => exclusive(async () => {
    const prev = st.state;
    set({ state: "checking", message: undefined });
    try {
      const base = o.channel();
      const get = async (name: string) => {
        const r = await fetchFn(new URL(name, base), { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`el canal respondió ${r.status} a ${name}`);
        return r.text();
      };
      const [text, sig] = await Promise.all([get("latest.json"), get("latest.json.sig")]);
      if (!verify(text, sig, o.publicKeyPem)) throw new Error("la firma del canal no es válida: no se instala nada");
      const l = JSON.parse(text);
      if (!validLatest(l)) throw new Error("el canal ha enviado un índice que no se entiende");
      latest = l; writeJson(sd("latest.json"), l);
      const lastCheck = now().toISOString(); writeJson(sd("checked.json"), { lastCheck });
      const mine = installed().version;
      if (cmpVersion(l.version, mine) <= 0) return set({ state: "idle", available: undefined, lastCheck, checkFailed: undefined, message: `Estás al día: NEXUS OS ${mine}.` });
      const b = pickBundle(l, mine);
      const ready = readJson<{ version?: string } | null>(sd("ready.json"), null);
      return set({ state: ready?.version === l.version ? "ready" : "available", lastCheck, message: undefined, checkFailed: undefined,
        available: { version: l.version, notes: l.notes, size: b?.size ?? 0, released: l.released, ...(failedHere().includes(l.version) ? { failedBefore: true } : {}) } });
    } catch (e) {
      return set({ state: prev === "checking" || prev === "error" ? "idle" : prev, checkFailed: true, message: `No se ha podido buscar actualizaciones: ${why(e)}.` });
    }
  });
  const pickBundle = (l: Latest, from: string) => l.bundles.find((b) => b.from === from) ?? l.bundles.find((b) => b.from === "*") ?? null;

  // ------------------------------------------------ download + verify
  const stagingOf = (v: string) => path.join(o.cacheDir, v, "staging");
  const download = () => exclusive(async () => {
    if (!latest || !st.available) throw new Error("No hay ninguna actualización que descargar.");
    const l = latest, mine = installed();
    const b = pickBundle(l, mine.version);
    if (!b) throw new Error("Esta actualización no se puede instalar desde tu versión.");
    const dir = path.join(o.cacheDir, l.version);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { if (fs.statfsSync(o.cacheDir).bavail * fs.statfsSync(o.cacheDir).bsize < b.size * 3 + 64e6) throw new Error("No hay espacio libre suficiente para descargarla."); } catch (e) { if ((e as Error).message.startsWith("No hay")) throw e; }
    set({ state: "downloading", progress: 0, message: undefined });
    try {
      const tarFile = path.join(dir, "bundle.tar");
      const r = await fetchFn(new URL(`bundles/${b.file}`, o.channel()), { signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok || !r.body) throw new Error(`el canal respondió ${r.status}`);
      const h = crypto.createHash("sha256");
      const fd = fs.openSync(tarFile + ".part", "w", 0o600);
      let got = 0, lastPush = 0;
      try {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          got += chunk.length;
          if (got > b.size) throw new Error("la descarga es más grande de lo anunciado");
          h.update(chunk); fs.writeSync(fd, chunk);
          if (got - lastPush > b.size / 50) { lastPush = got; set({ progress: got / b.size * 0.9 }); }
        }
      } finally { fs.closeSync(fd); }
      if (got !== b.size || h.digest("hex") !== b.sha256) throw new Error("la descarga no coincide con la firmada (se ha borrado)");
      fs.renameSync(tarFile + ".part", tarFile);
      const staging = stagingOf(l.version);
      fs.mkdirSync(staging, { mode: 0o700 });
      const t = await o.run("tar", ["-xf", tarFile, "-C", staging, "--no-same-owner", "--no-same-permissions"], { timeoutMs: 10 * 60_000 });
      if (t.code !== 0) throw new Error(`no se ha podido abrir el paquete (${t.out.trim().slice(0, 200)})`);
      fs.rmSync(tarFile);
      set({ progress: 0.95 });
      verifyStaging(staging, l.version, mine);
      writeJson(sd("ready.json"), { version: l.version });
      return set({ state: "ready", progress: undefined, message: undefined });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      return set({ state: "error", progress: undefined, message: `No se ha podido descargar NEXUS OS ${l.version}: ${(e as Error).message}.` });
    }
  });
  /** The unpacked bundle is exactly what the signed index promised: the right version, a valid manifest, only plain
   *  files, and every file and package the update needs present with its sha256. */
  const verifyStaging = (staging: string, version: string, mine: Manifest): BundleHeader => {
    const header = readJson<BundleHeader | null>(path.join(staging, "bundle.json"), null);
    if (!header || header.version !== version || !validManifest(header.manifest) || header.manifest.version !== version) throw new Error("el paquete no describe esta versión");
    if (header.from !== "*" && header.from !== mine.version) throw new Error("el paquete es para otra versión de partida");
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (!e.isFile()) throw new Error("el paquete contiene algo que no es un archivo normal"); } };
    walk(staging);
    const c = changedEntries(header.manifest, mine);
    for (const e of c.write) if (e.type === "file") {
      const f = path.join(staging, "files", e.path);
      if (!fs.existsSync(f) || sha256File(f) !== e.sha256) throw new Error(`falta o no cuadra ${e.path}`);
    }
    for (const d of c.debs) { const f = path.join(staging, "debs", d.file); if (!fs.existsSync(f) || sha256File(f) !== d.sha256) throw new Error(`falta o no cuadra el paquete ${d.package}`); }
    if (header.post) { const f = path.join(staging, "post.sh"); if (!fs.existsSync(f) || sha256File(f) !== header.post) throw new Error("falta o no cuadra el script de instalación"); }
    return header;
  };

  // ------------------------------------------------ install, with a saved copy of everything it touches
  const B = (...p: string[]) => sd("backup", ...p);
  type Backup = { from: string; to: string; at: string; saved: string[]; created: string[]; debs: { package: string; prev: string | null; prevFile: string | null }[]; hadInstalled: boolean; touched: string[]; kept: string[] };
  const save = (p: string, bk: Backup) => {
    let s: fs.Stats; try { s = fs.lstatSync(abs(p)); } catch { bk.created.push(p); return; }
    const dst = B("files", p);
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    if (s.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(abs(p)), dst);
    else if (s.isFile()) { fs.copyFileSync(abs(p), dst); fs.chmodSync(dst, s.mode & 0o7777); }
    else throw new Error(`${p} es una carpeta y la actualización quiere poner un archivo`);
    bk.saved.push(p);
  };
  const putFile = (src: string, p: string, mode: number) => {
    const dst = abs(p), tmp = `${dst}.nexus-tmp`;
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
    fs.rmSync(tmp, { force: true });
    fs.copyFileSync(src, tmp); fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, dst);
  };
  const putLink = (target: string, p: string) => {
    const dst = abs(p), tmp = `${dst}.nexus-tmp`;
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(target, tmp); fs.renameSync(tmp, dst);
  };
  const debVersion = async (pkg: string) => {
    const r = await o.run("dpkg-query", ["-W", "-f=${Version}", pkg]);
    return r.code === 0 && r.out.trim() ? r.out.trim() : null;
  };
  // the updater keeps each NEXUS package it installs, so "Deshacer" can put the previous one back
  const debStore = (file: string) => sd("debs", file);

  const install = () => exclusive(async () => {
    if (st.state !== "ready" || !latest) throw new Error("Primero hay que descargar la actualización.");
    const mine = installed(), version = latest.version;
    if (cmpVersion(version, mine.version) <= 0) throw new Error("Esa versión no es más nueva que la instalada.");
    const staging = stagingOf(version);
    let header: BundleHeader;
    try { header = verifyStaging(staging, version, mine); } catch (e) {
      fs.rmSync(sd("ready.json"), { force: true });
      return set({ state: "available", message: `Hay que volver a descargarla: ${(e as Error).message}.` });
    }
    const c = changedEntries(header.manifest, mine);
    set({ state: "installing", progress: 0, message: undefined });
    fs.rmSync(B(), { recursive: true, force: true }); fs.mkdirSync(B("files"), { recursive: true, mode: 0o700 });
    const bk: Backup = { from: mine.version, to: version, at: now().toISOString(), saved: [], created: [], debs: [], hadInstalled: fs.existsSync(sd("installed.json")), touched: [], kept: [] };
    writeJson(sd("journal.json"), { phase: "installing", version, from: mine.version, at: bk.at, boot: bootId() });
    let reboot = false;
    try {
      if (bk.hadInstalled) fs.copyFileSync(sd("installed.json"), B("installed.json"));
      const oldByPath = new Map(mine.files.map((e) => [e.path, e]));
      // /etc: a setting the person changed is kept; NEXUS's new version goes next to it as <file>.nexus-nuevo
      const personChanged = (p: string) => {
        const was = oldByPath.get(p);
        if (!p.startsWith("/etc/") || !was || was.type !== "file") return false;
        try { return sha256File(abs(p)) !== was.sha256; } catch { return false; }
      };
      // (unless the person's file is already exactly NEXUS's new version: then there is nothing to keep apart)
      const sameAsNew = (e: Entry) => { try { return e.type === "file" && sha256File(abs(e.path)) === e.sha256; } catch { return false; } };
      const plan = c.write.map((e) => ({ e, to: personChanged(e.path) && !sameAsNew(e) ? `${e.path}.nexus-nuevo` : e.path }));
      const removals = c.remove.filter((p) => !personChanged(p));
      for (const x of plan) { save(x.to, bk); if (x.to !== x.e.path) bk.kept.push(x.e.path); }
      for (const p of removals) save(p, bk);
      const osRelease = "/usr/lib/os-release";
      const touchesOsRelease = fs.existsSync(abs(osRelease)) && !plan.some((x) => x.to === osRelease);
      if (touchesOsRelease) save(osRelease, bk);
      bk.touched = [...plan.map((x) => x.to), ...removals];
      writeJson(B("backup.json"), bk);

      let n = 0; const total = plan.length + removals.length + c.debs.length + 1;
      const step = () => { n++; if (n % 25 === 0 || n === total) set({ progress: n / total * 0.8 }); };
      for (const x of plan) {
        if (x.e.type === "file") putFile(path.join(staging, "files", x.e.path), x.to, x.e.mode); else putLink(x.e.target, x.to);
        step();
      }
      for (const p of removals) { fs.rmSync(abs(p), { force: true }); step(); }
      if (touchesOsRelease) {
        fs.writeFileSync(abs(osRelease) + ".nexus-tmp", bumpOsRelease(fs.readFileSync(abs(osRelease), "utf8"), version));
        fs.renameSync(abs(osRelease) + ".nexus-tmp", abs(osRelease));
      }
      fs.mkdirSync(sd("debs"), { recursive: true, mode: 0o700 });
      for (const d of c.debs) {
        const prev = await debVersion(d.package);
        const prevDeb = mine.debs.find((x) => x.package === d.package);
        bk.debs.push({ package: d.package, prev, prevFile: prevDeb && fs.existsSync(debStore(prevDeb.file)) ? prevDeb.file : null });
        writeJson(B("backup.json"), bk);
        fs.copyFileSync(path.join(staging, "debs", d.file), debStore(d.file));
        const r = await o.run("dpkg", ["-i", debStore(d.file)], { timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
        if (r.code !== 0) throw new Error(`no se ha podido instalar ${d.package}: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
        if (REBOOT_PACKAGES.test(d.package)) reboot = true;
        step();
      }
      if (header.post) {
        const r = await o.run("sh", [path.join(staging, "post.sh")], { timeoutMs: 5 * 60_000, cwd: staging, env: { NEXUS_UPDATE_FROM: mine.version, NEXUS_UPDATE_TO: version } });
        if (r.code !== 0) throw new Error(`el paso final de la instalación ha fallado: ${r.out.trim().split("\n").slice(-2).join(" ")}`);
      }
      writeJson(sd("installed.json"), header.manifest);
      step();
    } catch (e) {
      await rollback(bk, `No se ha podido instalar NEXUS OS ${version}: ${(e as Error).message}. Todo ha vuelto a como estaba.`, "failed");
      return st;
    }
    fs.rmSync(sd("ready.json"), { force: true });
    fs.rmSync(path.join(o.cacheDir, version), { recursive: true, force: true });
    const detail = bk.kept.length ? `Se han conservado tus cambios en ${bk.kept.join(", ")} (la versión nueva está al lado, terminada en .nexus-nuevo).` : undefined;
    if (reboot) {
      writeJson(sd("journal.json"), { phase: "reboot", version, from: mine.version, at: bk.at, boot: bootId(), tries: 0, detail });
      return set({ state: "reboot", progress: undefined, available: undefined, message: `NEXUS OS ${version} está instalada. Reinicia el ordenador para terminar.` });
    }
    writeJson(sd("journal.json"), { phase: "verifying", version, from: mine.version, at: bk.at, boot: bootId() });
    set({ state: "verifying", progress: 0.9 });
    try { await o.restart(bk.touched); } catch { /* the health check decides */ }
    if (!(await healthyWithin())) {
      await rollback(bk, `NEXUS OS ${version} no arrancaba bien, así que se ha deshecho sola. Tu sistema vuelve a estar en ${mine.version}.`, "rolled-back");
      return st;
    }
    return finish(version, mine.version, detail);
  });
  const healthyWithin = async () => {
    for (let i = 0; i < (o.healthTries ?? 6); i++) if (await o.healthy().catch(() => false)) return true;
    return false;
  };
  const finish = (version: string, from: string, detail?: string) => {
    fs.rmSync(sd("journal.json"), { force: true });
    addHistory({ version, from, at: now().toISOString(), result: "installed", kind: "nexus", ...(detail ? { detail } : {}) });
    return set({ state: "idle", progress: undefined, available: undefined, message: `NEXUS OS ${version} instalada.${detail ? " " + detail : ""}` });
  };

  /** Put back everything the install touched, from the saved copy; `result` says why for the history. */
  // the versions that did not start well on this machine (undone by themselves): never downloaded by themselves again
  const failedHere = () => readJson<string[]>(sd("failed.json"), []);
  const rollback = async (bk: Backup, message: string, result: HistoryItem["result"]) => {
    if (result === "rolled-back" && !failedHere().includes(bk.to)) writeJson(sd("failed.json"), [...failedHere(), bk.to].slice(-20));
    set({ state: "installing", message: "Volviendo a la versión anterior…" });
    const problems: string[] = [];
    for (const p of bk.saved) {
      try {
        const src = B("files", p), s = fs.lstatSync(src);
        if (s.isSymbolicLink()) putLink(fs.readlinkSync(src), p); else putFile(src, p, s.mode & 0o7777);
      } catch (e) { problems.push(`${p}: ${(e as Error).message}`); }
    }
    for (const p of bk.created) try { fs.rmSync(abs(p), { force: true }); } catch (e) { problems.push(`${p}: ${(e as Error).message}`); }
    for (const d of [...bk.debs].reverse()) {
      if (!d.prevFile) { if (d.prev) problems.push(`${d.package}: no hay copia de la versión ${d.prev}`); continue; }
      const r = await o.run("dpkg", ["-i", debStore(d.prevFile)], { timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
      if (r.code !== 0) problems.push(`${d.package}: ${r.out.trim().split("\n").at(-1)}`);
    }
    if (bk.hadInstalled && fs.existsSync(B("installed.json"))) fs.copyFileSync(B("installed.json"), sd("installed.json"));
    else fs.rmSync(sd("installed.json"), { force: true });
    try { await o.restart(bk.touched); } catch { /* nothing more to do */ }
    fs.rmSync(sd("journal.json"), { force: true });
    fs.rmSync(sd("ready.json"), { force: true });
    fs.rmSync(path.join(o.cacheDir, bk.to), { recursive: true, force: true });
    fs.rmSync(B(), { recursive: true, force: true });
    const detail = problems.length ? `No se ha podido restaurar todo: ${problems.slice(0, 3).join("; ")}` : undefined;
    addHistory({ version: bk.to, from: bk.from, at: now().toISOString(), result, kind: "nexus", ...(detail ? { detail } : {}) });
    // after a failed or undone update the channel's version may still be offered: the person decides again
    const offer = latest && cmpVersion(latest.version, installed().version) > 0;
    set({ state: result === "undone" ? "idle" : "error", progress: undefined, message: detail ? `${message} ${detail}` : message,
      available: offer ? { version: latest!.version, notes: latest!.notes, size: pickBundle(latest!, installed().version)?.size ?? 0, released: latest!.released,
        ...(failedHere().includes(latest!.version) ? { failedBefore: true } : {}) } : undefined });
    if (offer && result === "undone") set({ state: "available" });
  };

  /** "Deshacer": back to the version before the last update (its saved copy). */
  const undo = () => exclusive(async () => {
    const bk = readJson<Backup | null>(B("backup.json"), null);
    if (!bk || fs.existsSync(sd("journal.json"))) throw new Error("No hay ninguna actualización que deshacer.");
    await rollback(bk, `Has vuelto a NEXUS OS ${bk.from}.`, "undone");
    return st;
  });

  /** NEXUS's own packages must be the versions its manifest says. An image built wrong, or someone's apt, can leave
   *  another one (Debian's labwc instead of NEXUS's, with no window animations): each is put back from the updater's
   *  own verified copy (the image ships it in the state folder). Nothing is downloaded and nothing else is touched. */
  const repairPackages = async () => {
    const mine = installed(), fixed: string[] = [];
    for (const d of mine.debs) {
      if (await debVersion(d.package) === d.version) continue;
      const f = debStore(d.file);
      if (!fs.existsSync(f) || sha256File(f) !== d.sha256) continue;
      const r = await o.run("dpkg", ["-i", f], { timeoutMs: 10 * 60_000, env: { DEBIAN_FRONTEND: "noninteractive" } });
      if (r.code === 0) fixed.push(d.package);
    }
    if (!fixed.length) return;
    const restart = fixed.some((p) => REBOOT_PACKAGES.test(p)) ? " Se usará a partir del próximo inicio de sesión." : "";
    addHistory({ version: mine.version, from: mine.version, at: now().toISOString(), result: "repaired", kind: "nexus",
      detail: `${fixed.join(", ")} ${fixed.length === 1 ? "no era la versión de NEXUS y se ha puesto la buena" : "no eran las versiones de NEXUS y se han puesto las buenas"}.${restart}` });
    set({});
  };

  /** At start: finish what a cut-short install or a restart left pending (or, with nothing pending, check NEXUS's
   *  own packages). */
  const recover = () => exclusive(async () => {
    const j = readJson<{ phase: string; version: string; from: string; boot?: string; tries?: number; detail?: string } | null>(sd("journal.json"), null);
    if (!j) { await repairPackages(); return st; }
    const bk = readJson<Backup | null>(B("backup.json"), null);
    if (!bk) { fs.rmSync(sd("journal.json"), { force: true }); return st; }
    if (j.phase === "installing") { await rollback(bk, `La instalación de NEXUS OS ${j.version} se cortó a medias, así que se ha deshecho.`, "rolled-back"); return st; }
    if (j.phase === "reboot" && j.boot === bootId()) return set({ state: "reboot", message: `NEXUS OS ${j.version} está instalada. Reinicia el ordenador para terminar.` });
    // after the restart (or a verify that was cut short): is NEXUS healthy on the new version?
    set({ state: "verifying", message: undefined });
    if (await healthyWithin()) return finish(j.version, j.from, j.detail);
    const tries = (j.tries ?? 0) + 1;
    if (j.phase === "reboot" && tries < 2) {
      writeJson(sd("journal.json"), { ...j, tries, boot: bootId() });
      set({ state: "error", message: `NEXUS OS ${j.version} no ha arrancado bien; se vuelve a intentar con otro reinicio.` });
      await o.reboot?.();
      return st;
    }
    await rollback(bk, `NEXUS OS ${j.version} no arrancaba bien, así que se ha deshecho sola. Tu sistema vuelve a estar en ${j.from}.`, "rolled-back");
    if (bk.debs.some((d) => REBOOT_PACKAGES.test(d.package))) await o.reboot?.();
    return st;
  });

  const setAutoDownload = (on: boolean) => { writeJson(sd("settings.json"), { ...settings(), autoDownload: on }); return set({}); };
  const noteHistory = (h: HistoryItem) => { addHistory(h); return set({}); };

  return { status: () => st, check, download, install, undo, recover, history, setAutoDownload, noteHistory, installed, isBusy: () => busy };
}
export type Updater = ReturnType<typeof createUpdater>;
