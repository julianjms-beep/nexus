// NEXUS Store: web apps as apps. A service you use in a browser tab (WhatsApp, GoHighLevel, Xbox Cloud Gaming…)
// becomes an app of its own: its own window (apps/WebApp.qml), its own session that stays signed in, kept apart from
// the browser's and from every other app's. Nothing is downloaded or run on the computer: an "installed" app is one
// line in ~/.config/nexus/webapps.json. The person can also add any https:// address of their own.
//
// The catalog only names services and where they live. Icons are a coloured tile with the name's first letter:
// NEXUS ships nobody's logo.
import fs from "node:fs";
import { createHash } from "node:crypto";

export type WebApp = { id: string; name: string; url: string; category: string; about: string; color: string; note?: string; custom?: boolean };
export const STORE_CATEGORIES = ["Comunicación", "Trabajo", "Programar", "Ocio"];
export const WEB_APPS: WebApp[] = [
  { id: "whatsapp", name: "WhatsApp", url: "https://web.whatsapp.com/", category: "Comunicación", about: "Tus chats del móvil en el ordenador. Se enlaza escaneando un código con el teléfono.", color: "#1fa855" },
  { id: "telegram", name: "Telegram", url: "https://web.telegram.org/", category: "Comunicación", about: "Mensajería en la nube, con todos tus chats sincronizados.", color: "#2a9fd8" },
  { id: "discord", name: "Discord", url: "https://discord.com/app", category: "Comunicación", about: "Servidores, canales de voz y chats con tus comunidades.", color: "#5865f2" },
  { id: "gmail", name: "Gmail", url: "https://mail.google.com/", category: "Comunicación", about: "El correo de Google en su propia ventana.", color: "#d9463c" },
  { id: "gohighlevel", name: "GoHighLevel", url: "https://app.gohighlevel.com/", category: "Trabajo", about: "El CRM: contactos, embudos, automatizaciones y campañas.", color: "#1f6feb" },
  { id: "notion", name: "Notion", url: "https://www.notion.so/", category: "Trabajo", about: "Notas, documentos y bases de datos del equipo.", color: "#5b5f6b" },
  { id: "calendar", name: "Google Calendar", url: "https://calendar.google.com/", category: "Trabajo", about: "Tu agenda y la de tu equipo.", color: "#3b7de9" },
  { id: "drive", name: "Google Drive", url: "https://drive.google.com/", category: "Trabajo", about: "Tus archivos en la nube de Google.", color: "#1e9e63" },
  { id: "canva", name: "Canva", url: "https://www.canva.com/", category: "Trabajo", about: "Diseños, presentaciones y publicaciones para redes.", color: "#7d2ae8" },
  { id: "figma", name: "Figma", url: "https://www.figma.com/files", category: "Trabajo", about: "Diseño de interfaces y prototipos, en equipo.", color: "#e4572e" },
  { id: "github", name: "GitHub", url: "https://github.com/", category: "Programar", about: "Tus repositorios, incidencias y revisiones de código.", color: "#3a3f4b" },
  { id: "vercel", name: "Vercel", url: "https://vercel.com/dashboard", category: "Programar", about: "Tus despliegues, dominios y registros.", color: "#22252e" },
  { id: "claude", name: "Claude", url: "https://claude.ai/", category: "Programar", about: "El asistente de Anthropic, en su propia ventana.", color: "#cf7a4d" },
  { id: "xcloud", name: "Xbox Cloud Gaming", url: "https://www.xbox.com/play", category: "Ocio", about: "Juegos de Xbox en streaming, con mando o teclado.", color: "#107c10", note: "Necesita una suscripción de Xbox y una buena conexión. Conecta el mando antes de abrirla." },
  { id: "youtube", name: "YouTube", url: "https://www.youtube.com/", category: "Ocio", about: "Vídeos, directos y música.", color: "#e62117" },
  { id: "twitch", name: "Twitch", url: "https://www.twitch.tv/", category: "Ocio", about: "Directos de juegos y creadores.", color: "#9146ff" },
  { id: "spotify", name: "Spotify", url: "https://open.spotify.com/", category: "Ocio", about: "Música y pódcast.", color: "#1db954", note: "La música con protección de copia puede no sonar todavía en NEXUS." },
];

const CUSTOM_COLORS = ["#7c6cff", "#0ea5c4", "#22b573", "#ff8f2e", "#e0457b", "#3b7de9"];
/** A web address the person adds themselves → an app entry. Only https, only a real host name. Errors in Spanish. */
export function customApp(input: { name?: unknown; url?: unknown }): WebApp {
  const name = String(input?.name ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!name) throw new Error("Ponle un nombre a la app.");
  let raw = String(input?.url ?? "").trim();
  if (raw && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = "https://" + raw;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Esa dirección no es válida."); }
  if (u.protocol !== "https:") throw new Error("Solo se pueden añadir direcciones seguras (https://).");
  if (u.username || u.password) throw new Error("La dirección no puede llevar usuario ni contraseña.");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || /^\d+(\.\d+){3}$/.test(u.hostname)) throw new Error("Escribe la dirección de una web, como app.ejemplo.com.");
  const url = u.href.slice(0, 500);
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "app";
  const h = createHash("sha256").update(url).digest("hex");
  return { id: `web-${slug}-${h.slice(0, 6)}`, name, url, category: "Tus webs", about: u.hostname.replace(/^www\./, ""), color: CUSTOM_COLORS[parseInt(h.slice(6, 8), 16) % CUSTOM_COLORS.length], custom: true };
}

export class Store {
  private installed: string[] = [];
  private custom: WebApp[] = [];
  private file: string;
  constructor(file: string) {
    this.file = file;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(j?.custom)) for (const c of j.custom.slice(0, 60)) { try { const a = customApp(c); if (!this.custom.some((x) => x.id === a.id)) this.custom.push(a); } catch { /* a line someone edited by hand */ } }
      if (Array.isArray(j?.installed)) this.installed = [...new Set((j.installed as unknown[]).map(String))].filter((id) => !!this.find(id));
    } catch { /* nothing installed yet */ }
  }
  private find(id: string): WebApp | undefined { return WEB_APPS.find((a) => a.id === id) ?? this.custom.find((a) => a.id === id); }
  private save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify({ installed: this.installed, custom: this.custom.map(({ id, name, url }) => ({ id, name, url })) }, null, 2), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
  /** The catalog and the person's own webs, each with whether it is installed. */
  view() {
    const on = new Set(this.installed);
    const apps = [...WEB_APPS, ...this.custom].map((a) => ({ ...a, installed: on.has(a.id), letter: (a.name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(), host: new URL(a.url).hostname.replace(/^www\./, "") }));
    return { apps, categories: [...STORE_CATEGORIES, ...(this.custom.length ? ["Tus webs"] : [])], installed: this.installed.length };
  }
  /** An installed app (what "open" starts), or undefined. */
  get(id: unknown): WebApp | undefined { return typeof id === "string" && this.installed.includes(id) ? this.find(id) : undefined; }
  install(id: unknown) {
    const a = typeof id === "string" ? this.find(id) : undefined;
    if (!a) throw new Error("Esa app no está en la tienda.");
    if (!this.installed.includes(a.id)) { this.installed.push(a.id); this.save(); }
    return this.view();
  }
  /** Adds a web of the person's own and installs it. */
  add(input: { name?: unknown; url?: unknown }) {
    const a = customApp(input);
    if (this.custom.length >= 60 && !this.custom.some((x) => x.id === a.id)) throw new Error("Ya tienes demasiadas webs añadidas.");
    if (!this.custom.some((x) => x.id === a.id)) this.custom.push(a);
    if (!this.installed.includes(a.id)) this.installed.push(a.id);
    this.save();
    return this.view();
  }
  /** Uninstalls; a web the person added disappears with it. Returns the app so its saved session can be removed. */
  remove(id: unknown): { view: ReturnType<Store["view"]>; removed: WebApp | undefined } {
    const a = typeof id === "string" ? this.find(id) : undefined;
    if (a) { this.installed = this.installed.filter((x) => x !== a.id); this.custom = this.custom.filter((x) => x.id !== a.id); this.save(); }
    return { view: this.view(), removed: a };
  }
}
/** The folder name of an app's own browser profile (apps/WebApp.qml uses the same rule). */
export const profileName = (id: string) => "webapp-" + id.replace(/[^a-z0-9-]/g, "");
