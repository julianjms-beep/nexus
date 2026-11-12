// NEXUS Search: the person's own search engine, inside the Navegador (browser/search.html).
//  - "En tu equipo": apps, Ajustes pages, files (files.ts) and the pages they have visited, found by their words.
//  - The visited pages live in a small full-text index of their own (BM25), only on this computer:
//    ~/.local/share/nexus/search/index.json. Pages with a password field or "noindex" are never kept (the browser
//    checks), nor private addresses, logins, payments or addresses that carry tokens (cleanPageUrl). The person can
//    turn it off, forget one page or wipe it all.
//  - "En la web": Wikipedia's summary (free, no key) here, and web results + a short answer with sources from
//    Claude's web search (the Engine, with the person's key: os.ts NexusAI.webSearch).
import fs from "node:fs";
import path from "node:path";

export type IndexedPage = { url: string; title: string; description: string; text: string; host: string; visits: number; first: string; last: string };
export type PageHit = { url: string; title: string; host: string; snippet: string; visits: number; last: string; score: number };

/** Lower case without accents, one character for one character (so a position in it is a position in the original). */
export function fold(s: string): string {
  let out = "";
  for (const c of s) {
    const b = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += b.length === c.length ? b : c.toLowerCase().length === c.length ? c.toLowerCase() : c;
  }
  return out;
}

const STOP = new Set(("de la el en y a los las del se que un una por con para es al lo como mas o pero sus le ya este esta son " +
  "the of and to in is for on it that with as are be this by at or from an was you your").split(" "));

/** The words of a text as the index sees them: folded, letters and digits only, no tiny or very common words. */
export function tokenize(s: string): string[] {
  return fold(String(s ?? "")).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && t.length <= 40 && !STOP.has(t));
}

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|[^.]+)$/i;
const PRIVATE_PATH = /\/(login|log-in|signin|sign-in|signup|logout|auth|oauth2?|account|cuenta|checkout|pago|payment|pay|billing|password|reset)(\/|$|\?)/i;
// other search engines' result pages: remembering them only adds noise (the pages they lead to are what counts)
const SEARCH_PAGE = /^(www\.)?(google\.[a-z.]+\/(search|url|webhp)|bing\.com\/search|duckduckgo\.com\/(\?|html|lite)|html\.duckduckgo\.com\/|search\.yahoo\.com\/|(www\.)?ecosia\.org\/search|search\.brave\.com\/search|(www\.)?startpage\.com\/(do|sp)\/search|yandex\.[a-z]+\/search|(www\.)?qwant\.com\/\?)/i;
const SECRET_PARAM = /(^|[?&])(token|access_token|id_token|key|api_key|apikey|code|session|sessionid|sid|auth|password|pass|pwd|sig|signature|secret|state|email|otp)=/i;

/** The address a visited page is kept under, or null when it must not be kept at all. */
export function cleanPageUrl(u: unknown): string | null {
  let url: URL;
  try { url = new URL(String(u ?? "")); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (PRIVATE_HOST.test(url.hostname)) return null;
  if (PRIVATE_PATH.test(url.pathname)) return null;
  if (SEARCH_PAGE.test(url.hostname + url.pathname + url.search)) return null;
  url.hash = "";
  if (SECRET_PARAM.test(url.search)) url.search = "";
  const s = url.toString();
  return s.length > 600 ? null : s;
}

/** A few words of the text around the first query word it contains (the start of the text otherwise). */
export function snippet(text: string, terms: string[], len = 190): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const f = fold(t);
  let at = -1;
  for (const w of terms) { const i = f.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return t.length > len ? t.slice(0, len).replace(/\s\S*$/, "") + "…" : t;
  const start = Math.max(0, at - 60);
  let s = t.slice(start, start + len);
  if (start > 0) s = "…" + s.replace(/^\S*\s/, "");
  if (start + len < t.length) s = s.replace(/\s\S*$/, "") + "…";
  return s;
}

type Doc = IndexedPage & { tf: Map<string, number>; length: number };

export class PageIndex {
  private docs = new Map<string, Doc>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly maxPages: number;
  private readonly maxText: number;
  private readonly now: () => Date;

  constructor(private file: string, opts: { maxPages?: number; maxText?: number; now?: () => Date } = {}) {
    this.maxPages = opts.maxPages ?? 2000;
    this.maxText = opts.maxText ?? 2500;
    this.now = opts.now ?? (() => new Date());
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      // pages kept by an older version are checked again with today's rules
      for (const p of Array.isArray(j?.pages) ? j.pages : []) if (p && typeof p.url === "string" && cleanPageUrl(p.url) === p.url) this.put(p as IndexedPage);
    } catch { /* first time, or unreadable: start empty */ }
  }

  private put(p: IndexedPage) {
    const tf = new Map<string, number>();
    // the title counts three times: a page is first of all what it says it is
    const words = [...tokenize(p.title), ...tokenize(p.title), ...tokenize(p.title), ...tokenize(p.description), ...tokenize(p.text), ...tokenize(p.host.replace(/^www\./, "").split(".")[0])];
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    this.docs.set(p.url, { ...p, tf, length: words.length || 1 });
  }

  /** Keeps (or refreshes) a visited page. Returns false when it is not kept (see cleanPageUrl). */
  add(page: { url: unknown; title?: unknown; description?: unknown; text?: unknown }): boolean {
    const url = cleanPageUrl(page.url);
    if (!url) return false;
    const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    const title = clip(page.title, 200), description = clip(page.description, 400), text = clip(page.text, this.maxText);
    if (!title && !text) return false;
    const stamp = this.now().toISOString();
    const old = this.docs.get(url);
    this.docs.delete(url); // re-inserted last: the Map's order is the order of last visit
    this.put({ url, title: title || old?.title || "", description, text, host: new URL(url).hostname, visits: (old?.visits ?? 0) + 1, first: old?.first ?? stamp, last: stamp });
    while (this.docs.size > this.maxPages) this.docs.delete(this.docs.keys().next().value!); // the longest unvisited goes first
    this.scheduleSave();
    return true;
  }

  search(q: string, limit = 8): PageHit[] {
    const terms = [...new Set(tokenize(q))].slice(0, 12);
    if (!terms.length || !this.docs.size) return [];
    const n = this.docs.size;
    let total = 0; for (const d of this.docs.values()) total += d.length;
    const avg = total / n, k1 = 1.2, b = 0.75;
    const last = terms[terms.length - 1];
    const df = new Map<string, number>();
    const matches = (d: Doc, t: string): number => {
      const exact = d.tf.get(t) ?? 0;
      if (exact || t !== last || t.length < 3) return exact;
      // the last word may still be being typed: its longer forms count a little
      let pre = 0; for (const [w, c] of d.tf) if (w.startsWith(t)) pre += c;
      return pre * 0.6;
    };
    for (const t of terms) { let c = 0; for (const d of this.docs.values()) if (matches(d, t) > 0) c++; df.set(t, c); }
    const hits: PageHit[] = [];
    for (const d of this.docs.values()) {
      let score = 0, found = 0;
      for (const t of terms) {
        const f = matches(d, t); if (!f) continue;
        found++;
        const idf = Math.log(1 + (n - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
      }
      if (!found) continue;
      score *= (found / terms.length) ** 2;           // pages with every word first
      score *= 1 + 0.15 * Math.log2(1 + d.visits);     // and the ones they go back to
      hits.push({ url: d.url, title: d.title || d.host, host: d.host, snippet: snippet(d.description && (!d.text || terms.some((t) => fold(d.description).includes(t))) ? d.description : d.text || d.description, terms), visits: d.visits, last: d.last, score: Math.round(score * 1000) / 1000 });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(limit, 50)));
  }

  /** While they type in the address bar: the site to complete inline (Safari's "top hit": the most visited site whose
   *  address starts with what they typed) and the visited pages that match the words. */
  suggest(typed: string, limit = 3): { top: { url: string; completion: string; title: string } | null; pages: { url: string; title: string; host: string }[] } {
    const t = String(typed ?? "").trim().toLowerCase();
    let top: { url: string; completion: string; title: string; visits: number } | null = null;
    if (t && !/\s/.test(t) && t.length <= 200) {
      const byHost = new Map<string, { visits: number; url: string; title: string; host: string }>();
      // a site matches when its name starts with what they typed ("kom" → komgo2go.com), or one of its parts does
      // ("wiki" → es.wikipedia.org; shown first but not completed inline, since the text would not start the same)
      const labelHit = (host: string) => !t.includes("/") && t.length >= 2 && host.toLowerCase().split(".").slice(1, -1).some((l) => l.startsWith(t));
      for (const d of this.docs.values()) {
        const bare = d.url.replace(/^https?:\/\/(www\.)?/i, "");
        if (!bare.toLowerCase().startsWith(t) && !d.host.toLowerCase().startsWith(t) && !labelHit(d.host)) continue;
        if (t.includes("/")) { // a path was typed: complete to the most visited page under it
          if (!top || d.visits > top.visits) top = { url: d.url, completion: bare.replace(/\/$/, ""), title: d.title, visits: d.visits };
          continue;
        }
        const h = byHost.get(d.host) ?? { visits: 0, url: `${new URL(d.url).origin}/`, title: "", host: d.host };
        h.visits += d.visits; if (!h.title || d.url === h.url) h.title = d.title;
        byHost.set(d.host, h);
      }
      let best = -1;
      for (const h of byHost.values()) {
        const bare = h.host.replace(/^www\./i, "");
        const completion = h.host.toLowerCase().startsWith(t) ? h.host : bare;
        const score = h.visits + (completion.toLowerCase().startsWith(t) ? 1e6 : 0);   // sites that start with it come first
        if (score > best) { best = score; top = { url: h.url, completion, title: h.title, visits: h.visits }; }
      }
    }
    const pages = this.search(t, limit + 1).filter((p) => !top || p.url !== top.url).slice(0, limit).map(({ url, title, host }) => ({ url, title, host }));
    return { top: top ? { url: top.url, completion: top.completion, title: top.title } : null, pages };
  }

  /** The pages they open most (the new tab's "Visitadas a menudo"). */
  frequent(limit = 8): { url: string; title: string; host: string; visits: number }[] {
    return [...this.docs.values()].sort((a, b) => b.visits - a.visits || b.last.localeCompare(a.last)).slice(0, limit)
      .map((d) => ({ url: d.url, title: d.title || d.host, host: d.host, visits: d.visits }));
  }

  forget(url: unknown): boolean {
    const u = String(url ?? "");
    const ok = this.docs.delete(u) || this.docs.delete(cleanPageUrl(u) ?? "");
    if (ok) this.scheduleSave();
    return ok;
  }
  clear() { this.docs.clear(); this.dirty = true; this.flush(); }
  stats() { return { pages: this.docs.size }; }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 3000);
    this.saveTimer.unref?.();
  }
  /** Writes the index now if anything changed (also on exit and in tests). */
  flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.dirty) return;
    this.dirty = false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const pages = [...this.docs.values()].map(({ tf, length, ...p }) => p);
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ version: 1, pages }), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
}

// ---- Ajustes pages a search can open (Settings.qml sections) and the words that lead to them
export const SETTINGS_PAGES: { page: string; title: string; words: string }[] = [
  { page: "apariencia", title: "Apariencia", words: "apariencia tema oscuro claro modo color acento tamano interfaz escala letra reloj 24 horas animaciones escritorio barra clasico dock" },
  { page: "fondo", title: "Fondo de escritorio", words: "fondo pantalla wallpaper imagen foto pantera presentacion cambiar fondo escritorio" },
  { page: "wifi", title: "Wi-Fi", words: "wifi wi-fi red redes internet conexion inalambrica contrasena conectar olvidar cable ethernet" },
  { page: "bluetooth", title: "Bluetooth", words: "bluetooth auriculares altavoz raton teclado emparejar dispositivos inalambrico" },
  { page: "bateria", title: "Batería", words: "bateria energia carga cargando ahorro consumo rendimiento modo bajo consumo suspender" },
  { page: "sonido", title: "Sonido", words: "sonido volumen audio altavoces auriculares silencio salida microfono" },
  { page: "pantalla", title: "Pantalla", words: "pantalla brillo resolucion tamano monitor hz escala interfaz" },
  { page: "teclado", title: "Teclado e idioma", words: "teclado idioma distribucion layout espanol ingles teclas region" },
  { page: "cuenta", title: "Cuenta", words: "cuenta usuario foto avatar imagen perfil nombre persona" },
  { page: "ai", title: "NEXUS AI", words: "ia inteligencia artificial nexus ai claude clave api key asistente" },
  { page: "actualizaciones", title: "Actualizaciones", words: "actualizaciones actualizar update version sistema paquetes debian apt volver anterior" },
  { page: "buscador", title: "Buscador", words: "buscador busqueda buscar search web resultados brave tavily clave resumen historial paginas recordar" },
  { page: "terminal", title: "Terminal", words: "terminal consola shell letra fuente tamano tema colores cursor pestanas paneles sugerencias historial zsh saludo" },
  { page: "seguridad", title: "Privacidad y seguridad", words: "privacidad seguridad cortafuegos firewall contraseña clave password bloqueo bloquear pantalla ssh acceso remoto sudo administrador historial proteccion escudo" },
  { page: "acerca", title: "Acerca de este equipo", words: "acerca equipo informacion version memoria disco procesador cpu sistema nexus os" },
];
export function settingsMatches(q: string): { page: string; title: string }[] {
  const terms = tokenize(q);
  if (!terms.length) return [];
  return SETTINGS_PAGES.filter((s) => {
    const words = tokenize(s.title + " " + s.words);
    return terms.every((t) => words.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
  }).map(({ page, title }) => ({ page, title }));
}

// ---- search suggestions while typing (DuckDuckGo's autocomplete, the one browsers use; nothing else is sent)
export function suggestUrl(q: string): string {
  return `https://duckduckgo.com/ac/?q=${encodeURIComponent(String(q).slice(0, 120))}&kl=es-es&type=list`;
}
export function parseSuggest(q: string, j: any): string[] {
  const raw: unknown[] = Array.isArray(j) && Array.isArray(j[1]) ? j[1] : Array.isArray(j) ? j.map((x: any) => x?.phrase) : [];
  const seen = new Set([fold(String(q).trim())]), out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const p = r.replace(/\s+/g, " ").trim().slice(0, 120), k = fold(p);
    if (!p || seen.has(k)) continue;
    seen.add(k); out.push(p);
  }
  return out.slice(0, 6);
}

// ---- Wikipedia's summary for the side panel (only when the article really is what was searched)
export function wikiQueryUrl(q: string, lang = "es"): string {
  const p = new URLSearchParams({ action: "query", format: "json", formatversion: "2", generator: "search", gsrsearch: String(q).slice(0, 200), gsrlimit: "1",
    prop: "extracts|pageimages|info", exintro: "1", explaintext: "1", exsentences: "3", piprop: "thumbnail", pithumbsize: "400", inprop: "url", redirects: "1" });
  return `https://${lang}.wikipedia.org/w/api.php?${p}`;
}
export type WikiCard = { title: string; extract: string; url: string; image: string };
export function parseWiki(q: string, j: any): WikiCard | null {
  const page = Array.isArray(j?.query?.pages) ? j.query.pages[0] : undefined;
  if (!page || typeof page.title !== "string" || typeof page.extract !== "string" || !page.extract.trim()) return null;
  const qt = tokenize(q), tt = tokenize(page.title.replace(/\(.*?\)/g, ""));
  if (!qt.length || !tt.length) return null;
  // "einstein" → "Albert Einstein" yes; "cómo hacer tortilla" → "Tortilla de patatas" no
  const same = qt.every((t) => tt.includes(t)) || tt.every((t) => qt.includes(t));
  if (!same) return null;
  const url = typeof page.fullurl === "string" && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(page.fullurl) ? page.fullurl : "";
  const image = typeof page.thumbnail?.source === "string" && /^https:\/\/upload\.wikimedia\.org\//.test(page.thumbnail.source) ? page.thumbnail.source : "";
  return { title: page.title.slice(0, 120), extract: page.extract.replace(/\s+/g, " ").trim().slice(0, 700), url, image };
}
