// The notification centre's memory: every notice the desktop showed (NEXUS Update, NEXUS AI, Mail, agents, an
// automation that failed…), newest first, kept on disk so nothing is lost when a toast fades or the shell restarts.
// nexus-sessiond adds one for each "notice" event it sends (core/src/sessiond.ts `push`), the shell reads them for the
// bell in the bar and the centre (shell/NotificationCenter.qml). Only this computer's own notices: nothing goes out.
import fs from "node:fs";
import path from "node:path";

export const NOTICE_KINDS = ["info", "good", "warn"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];
export type Notice = {
  id: number; text: string; kind: NoticeKind; at: string; read: boolean;
  app?: string;     // catalog id ("mail", "agents"…) or a program's name: the centre shows its icon and name
  title?: string;   // a first line in bold (what a Linux app sends as "summary"); the text is the body
};
export type NoticeInput = { text: unknown; kind?: unknown; app?: unknown; title?: unknown };

/** What the desktop and the D-Bus bridge may add: checked, trimmed, never longer than the centre can show. */
export function checkNotice(input: NoticeInput): { text: string; kind: NoticeKind; app?: string; title?: string } {
  const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").trim().slice(0, max);
  const text = clean(input.text, 500), title = clean(input.title, 120);
  if (!text && !title) throw new Error("empty notice");
  const kind = (NOTICE_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as NoticeKind) : "info";
  const app = clean(input.app, 40).replace(/[^\w .-]/g, "");
  const body = text || title;
  return { text: body, kind, ...(app ? { app } : {}), ...(title && title !== body ? { title } : {}) };
}

export class Notices {
  private items: Notice[] = [];
  private nextId = 1;
  constructor(private file: string, private max = 200, private now: () => Date = () => new Date()) { this.load(); }

  private load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(j?.items)) this.items = j.items.filter((n: any) => n && typeof n.id === "number" && typeof n.text === "string").slice(0, this.max);
      this.nextId = Math.max(1, ...this.items.map((n) => n.id + 1));
    } catch { this.items = []; }
  }
  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify({ items: this.items }), { mode: 0o600 });
      fs.renameSync(this.file + ".tmp", this.file);
    } catch { /* a read-only home: the centre still works until the session ends */ }
  }
  /** Adds a notice (newest first) and returns it with its id and time. The same text twice within a minute is one notice. */
  add(input: NoticeInput): Notice {
    const c = checkNotice(input);
    const at = this.now().toISOString();
    const last = this.items[0];
    if (last && last.text === c.text && last.kind === c.kind && last.app === c.app && last.title === c.title && Date.parse(at) - Date.parse(last.at) < 60_000) {
      last.at = at; last.read = false; this.save(); return last;
    }
    const n: Notice = { id: this.nextId++, ...c, at, read: false };
    this.items.unshift(n);
    if (this.items.length > this.max) this.items.length = this.max;
    this.save();
    return n;
  }
  list(): Notice[] { return this.items.map((n) => ({ ...n })); }
  unread(): number { return this.items.filter((n) => !n.read).length; }
  /** Marks one notice (by id) or every notice as read. */
  markRead(id?: number): number {
    let changed = 0;
    for (const n of this.items) if ((id === undefined || n.id === id) && !n.read) { n.read = true; changed++; }
    if (changed) this.save();
    return changed;
  }
  remove(id: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((n) => n.id !== id);
    if (this.items.length === before) return false;
    this.save(); return true;
  }
  clear(): void { if (this.items.length) { this.items = []; this.save(); } }
}
