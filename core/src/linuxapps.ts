// NEXUS Store → Linux apps. The programs people expect on a computer (Firefox, LibreOffice, GIMP, VLC…) come as
// Flatpak apps from Flathub, the catalogue of desktop Linux: each one is installed for this person only (no
// administrator password), runs inside its own sandbox, and says beforehand what it can reach.
//
// Two sources, kept apart:
//   - the catalogue (names, icons, screenshots, sizes, permissions) is read from Flathub's public API;
//   - installing, removing and listing is the `flatpak` program on this computer, always with --user.
// What Flathub sends is text from strangers: it is cut, stripped of markup and never run. An app id is checked
// against the shape of one before it gets anywhere near a command line.
//
// NEXUS says in plain words what an app can do (explainPermissions): "all your files" is not hidden behind
// "filesystems=host".

export const FLATHUB_API = "https://flathub.org/api/v2";
export const FLATHUB_REPO = "https://dl.flathub.org/repo/flathub.flatpakrepo";

export type LinuxApp = { id: string; name: string; summary: string; icon: string; developer: string; verified: boolean; category: string; installs: number };
export type Permission = { level: "alto" | "medio" | "bajo"; text: string };
export type LinuxAppDetails = LinuxApp & {
  description: string; screenshots: string[]; homepage: string; license: string; version: string;
  downloadBytes: number; installedBytes: number; permissions: Permission[]; risk: "alto" | "medio" | "bajo";
};
export type InstalledApp = { id: string; name: string; version: string; size: string };
export type Job = { id: string; action: "install" | "remove"; state: "running" | "done" | "failed"; percent: number; error?: string };

export type Run = (argv: string[], onLine?: (line: string) => void) => Promise<{ code: number; out: string }>;
export type LinuxAppsOptions = {
  run: Run;                                   // runs `flatpak …` and returns its output
  fetchFn?: typeof fetch;
  arch?: string;                              // Flathub's name for this computer: "aarch64" or "x86_64"
  available?: () => boolean;                  // is flatpak installed?
  onChange?: () => void;                      // a job moved, or the installed list changed
};

/** An application id as Flathub writes them: org.gimp.GIMP. Nothing else ever reaches a command line. */
export function checkAppId(id: unknown): string {
  const s = String(id ?? "");
  if (s.length > 120 || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*){2,}$/.test(s)) throw new Error("Esa app no existe en el catálogo.");
  return s;
}
const clean = (v: unknown, max: number) => String(v ?? "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, max);
const httpsUrl = (v: unknown, hosts?: string[]) => { try { const u = new URL(String(v ?? "")); return u.protocol === "https:" && (!hosts || hosts.includes(u.hostname)) ? u.href : ""; } catch { return ""; } };
const MEDIA = ["dl.flathub.org", "flathub.org"];
const CATEGORY: Record<string, string> = {
  audiovideo: "Música y vídeo", development: "Programar", education: "Educación", game: "Juegos", graphics: "Imagen y diseño",
  network: "Internet", office: "Oficina", science: "Ciencia", system: "Sistema", utility: "Utilidades",
};

/** What an app can reach, in plain words, most serious first. `perms` is Flathub's "permissions" object. */
export function explainPermissions(perms: unknown): Permission[] {
  const p = (perms && typeof perms === "object" ? perms : {}) as Record<string, unknown>;
  const list = (k: string) => (Array.isArray(p[k]) ? (p[k] as unknown[]).map(String) : []);
  const fs = list("filesystems"), shared = list("shared"), devices = list("devices"), sockets = list("sockets");
  const bus = (k: string) => { const b = p[k] as Record<string, unknown> | undefined; return b && typeof b === "object" ? [...(Array.isArray(b.talk) ? b.talk : []), ...(Array.isArray(b.own) ? b.own : [])].map(String) : []; };
  const out: Permission[] = [];
  const bare = (f: string) => f.replace(/:(ro|rw|create)$/, "");
  const ro = (f: string) => f.endsWith(":ro");
  const whole = fs.filter((f) => ["host", "host-os", "host-etc"].includes(bare(f)));
  const home = fs.filter((f) => ["home", "~"].includes(bare(f)));
  if (whole.length) out.push({ level: "alto", text: whole.every(ro) ? "Puede leer todos los archivos del equipo" : "Puede leer y cambiar todos los archivos del equipo" });
  else if (home.length) out.push({ level: "alto", text: home.every(ro) ? "Puede leer toda tu carpeta personal" : "Puede leer y cambiar toda tu carpeta personal" });
  else {
    const FOLDERS: Record<string, string> = { "xdg-download": "Descargas", "xdg-documents": "Documentos", "xdg-pictures": "Imágenes", "xdg-music": "Música", "xdg-videos": "Vídeos", "xdg-desktop": "Escritorio" };
    const named = [...new Set(fs.map((f) => FOLDERS[bare(f).split("/")[0]]).filter(Boolean))];
    if (named.length) out.push({ level: "medio", text: "Puede usar tus carpetas: " + named.join(", ") });
  }
  if (devices.includes("all")) out.push({ level: "alto", text: "Puede usar la cámara, el micrófono y otros dispositivos" });
  if (bus("system-bus").length || bus("session-bus").some((n) => n === "org.freedesktop.Flatpak" || n === "*")) out.push({ level: "alto", text: "Puede hablar con partes del sistema fuera de su aislamiento" });
  if (shared.includes("network")) out.push({ level: "medio", text: "Puede usar Internet" });
  if (sockets.includes("x11")) out.push({ level: "medio", text: "Usa el sistema de ventanas antiguo, que deja ver lo que haces en otras ventanas" });
  if (sockets.includes("pulseaudio")) out.push({ level: "bajo", text: "Puede reproducir y grabar sonido" });
  if (!out.length) out.push({ level: "bajo", text: "No pide nada fuera de su propio espacio" });
  const order = { alto: 0, medio: 1, bajo: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

/** A size for people: 269117952 → "257 MB". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(1).replace(".", ",") + " GB" : Math.max(1, Math.round(mb)) + " MB";
}

/** `flatpak list --columns=application,name,version,size`: tab-separated lines. */
export function parseInstalled(out: string): InstalledApp[] {
  const apps: InstalledApp[] = [];
  for (const line of out.split("\n")) {
    const [id, name, version, size] = line.split("\t").map((s) => (s ?? "").trim());
    if (!id) continue;
    try { apps.push({ id: checkAppId(id), name: clean(name, 80) || id, version: clean(version, 40), size: clean(size, 20) }); } catch { /* not an app line */ }
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export class LinuxApps {
  private o: LinuxAppsOptions;
  private fetchFn: typeof fetch;
  private arch: string;
  private jobs = new Map<string, Job>();
  private remoteReady = false;
  constructor(o: LinuxAppsOptions) {
    this.o = o;
    this.fetchFn = o.fetchFn ?? fetch;
    this.arch = o.arch ?? (process.arch === "arm64" ? "aarch64" : "x86_64");
  }

  /** Is flatpak on this computer? Without it the Store still shows the catalogue and says what is missing. */
  available(): boolean { return this.o.available ? this.o.available() : true; }

  private async api(pathname: string, body?: unknown): Promise<any> {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await this.fetchFn(FLATHUB_API + pathname, body === undefined ? { signal: ctl.signal } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(r.status === 404 ? "Esa app no existe en el catálogo." : "El catálogo de apps no responde ahora mismo.");
      return await r.json();
    } catch (e) {
      if (e instanceof Error && /catálogo/.test(e.message)) throw e;
      throw new Error("No hay conexión con el catálogo de apps. Comprueba Internet.");
    } finally { clearTimeout(timer); }
  }
  private hit(h: any): LinuxApp | null {
    let id: string; try { id = checkAppId(h?.app_id); } catch { return null; }
    if (h?.type && h.type !== "desktop-application") return null;
    if (Array.isArray(h?.arches) && !h.arches.includes(this.arch)) return null;   // not built for this computer
    return {
      id, name: clean(h?.name, 60) || id, summary: clean(h?.summary, 140), icon: httpsUrl(h?.icon, MEDIA), developer: clean(h?.developer_name, 60),
      verified: h?.verification_verified === true || h?.verification_verified === "True",
      category: CATEGORY[String(h?.main_categories ?? "").toLowerCase()] ?? "Otras", installs: Number(h?.installs_last_month) || 0,
    };
  }
  private hits(d: any): LinuxApp[] { return (Array.isArray(d?.hits) ? d.hits : []).map((h: any) => this.hit(h)).filter((a: LinuxApp | null): a is LinuxApp => a !== null); }

  /** Apps whose name or description match. An empty search gives the most installed ones. */
  async search(q: unknown): Promise<LinuxApp[]> {
    const query = String(q ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
    if (!query) return this.popular();
    return this.hits(await this.api("/search", { query, hits_per_page: 40 })).slice(0, 30);
  }
  async popular(): Promise<LinuxApp[]> { return this.hits(await this.api("/collection/popular?page=1&per_page=40")).slice(0, 30); }

  /** Everything the Store shows before installing: what it is, how much it weighs, what it can reach. */
  async details(idIn: unknown): Promise<LinuxAppDetails> {
    const id = checkAppId(idIn);
    const [a, s] = await Promise.all([this.api("/appstream/" + id), this.api("/summary/" + id).catch(() => null)]);
    if (s && Array.isArray(s.arches) && !s.arches.includes(this.arch)) throw new Error("Esta app no está hecha para este tipo de ordenador.");
    const shots: string[] = [];
    for (const sc of Array.isArray(a?.screenshots) ? a.screenshots : []) {
      const sizes = (Array.isArray(sc?.sizes) ? sc.sizes : []).filter((z: any) => Number(z?.width) <= 1300).sort((x: any, y: any) => Number(y.width) - Number(x.width));
      const src = httpsUrl(sizes[0]?.src, MEDIA); if (src) shots.push(src);
      if (shots.length === 6) break;
    }
    const permissions = explainPermissions(s?.metadata?.permissions);
    const cats = Array.isArray(a?.categories) ? a.categories.map((c: unknown) => String(c).toLowerCase()) : [];
    return {
      id, name: clean(a?.name, 60) || id, summary: clean(a?.summary, 140), icon: httpsUrl(a?.icon, MEDIA), developer: clean(a?.developer_name, 60),
      verified: a?.metadata?.["flathub::verification::verified"] === true, category: CATEGORY[cats.find((c: string) => CATEGORY[c]) ?? ""] ?? "Otras", installs: 0,
      description: clean(a?.description, 1500), screenshots: shots, homepage: httpsUrl(a?.urls?.homepage), license: clean(a?.project_license, 60),
      version: clean(Array.isArray(a?.releases) ? a.releases[0]?.version : "", 30),
      downloadBytes: Number(s?.download_size) || 0, installedBytes: Number(s?.installed_size) || 0,
      permissions, risk: permissions[0].level,
    };
  }

  /** The Linux apps installed for this person. */
  async installed(): Promise<InstalledApp[]> {
    if (!this.available()) return [];
    const r = await this.o.run(["flatpak", "list", "--user", "--app", "--columns=application,name,version,size"]);
    return r.code === 0 ? parseInstalled(r.out) : [];
  }
  jobList(): Job[] { return [...this.jobs.values()]; }
  private busy() { return [...this.jobs.values()].some((j) => j.state === "running"); }

  private async ensureRemote() {
    if (this.remoteReady) return;
    const r = await this.o.run(["flatpak", "remote-add", "--user", "--if-not-exists", "flathub", FLATHUB_REPO]);
    if (r.code !== 0) throw new Error("No se ha podido conectar con Flathub.");
    this.remoteReady = true;
  }
  private track(job: Job, argv: string[], failure: string): Promise<Job> {
    this.jobs.set(job.id, job); this.o.onChange?.();
    return (async () => {
      try {
        if (job.action === "install") await this.ensureRemote();
        const r = await this.o.run(argv, (line) => {
          // flatpak prints "… 37%  1,2 MB/s" while it downloads; several parts, so the number never goes back
          const m = /(\d{1,3})\s?%/.exec(line);
          if (m) { const p = Math.min(99, Number(m[1])); if (p > job.percent) { job.percent = p; this.o.onChange?.(); } }
        });
        if (r.code !== 0) throw new Error(/No space left|ENOSPC|not enough.*space/i.test(r.out) ? "No queda espacio en el disco para esta app." : /Unable to load|resolve|network|Temporary failure/i.test(r.out) ? "No hay conexión con Flathub. Comprueba Internet." : failure);
        job.state = "done"; job.percent = 100;
      } catch (e) { job.state = "failed"; job.error = e instanceof Error ? e.message : failure; }
      this.o.onChange?.();
      return job;
    })();
  }

  /** Starts installing (one app at a time). The returned promise settles when it ends; `job` moves meanwhile. */
  install(idIn: unknown): { job: Job; done: Promise<Job> } {
    const id = checkAppId(idIn);
    if (!this.available()) throw new Error("A este equipo le falta el instalador de apps de Linux (flatpak). Llega con la próxima actualización de NEXUS.");
    if (this.busy()) throw new Error("Ya se está instalando otra app. Espera a que termine.");
    const job: Job = { id, action: "install", state: "running", percent: 0 };
    return { job, done: this.track(job, ["flatpak", "install", "--user", "--noninteractive", "-y", "flathub", id], "No se ha podido instalar la app.") };
  }
  /** Removes an app; with `data`, also what it saved (its settings and files inside its own space). */
  remove(idIn: unknown, data = false): { job: Job; done: Promise<Job> } {
    const id = checkAppId(idIn);
    if (this.busy()) throw new Error("Hay otra instalación en marcha. Espera a que termine.");
    const job: Job = { id, action: "remove", state: "running", percent: 0 };
    return { job, done: this.track(job, ["flatpak", "uninstall", "--user", "--noninteractive", "-y", ...(data ? ["--delete-data"] : []), id], "No se ha podido quitar la app.") };
  }
  /** The command that opens an installed app (nexus-sessiond starts it). */
  launchArgv(idIn: unknown): string[] { return ["flatpak", "run", checkAppId(idIn)]; }
  /** Takes away the widest permission: the app keeps only its own space and what the person picks in a file dialog. */
  restrictArgv(idIn: unknown): string[] { return ["flatpak", "override", "--user", "--nofilesystem=host", "--nofilesystem=home", checkAppId(idIn)]; }
  unrestrictArgv(idIn: unknown): string[] { return ["flatpak", "override", "--user", "--reset", checkAppId(idIn)]; }
}
