// Intent-based access control (IBAC) for agents, the fast local part: every command an agent asks NEXUS to run is
// classified before it runs. "block" never runs, "ask" waits for the person's click, "safe" runs in the sandbox.
// Rules, not a model: instant, predictable and testable. A command no rule knows is "safe" because it still runs
// isolated (only the project folder is writable, no NEXUS tokens, no desktop).
export type RiskLevel = "safe" | "ask" | "block";
export type Risk = { level: RiskLevel; reason: string; reasonEn: string; rule?: string };

const RM_RECURSIVE = String.raw`\brm\s+(?:-{1,2}[\w-]+\s+)*-[a-zA-Z]*[rR]`;

// Never: they damage the computer itself, or try to get more power than the sandbox gives.
const BLOCK: [string, RegExp, string, string][] = [
  ["rm-root", new RegExp(RM_RECURSIVE + String.raw`[a-zA-Z]*\s+(?:-{1,2}[\w-]+\s+)*(?:\/\*?|~\/?|\$\{?HOME\}?\/?)(?:\s|$|[;&|])`), "borra todo el disco o tu carpeta personal", "deletes the whole disk or your home folder"],
  ["mkfs", /\bmkfs(\.\w+)?\b|\bwipefs\b|\bfdisk\b|\bparted\b/, "formatea o reparte un disco", "formats or repartitions a disk"],
  ["dd-disk", /\bdd\b[^;&|]*\bof=\/dev\/(?!null\b)/, "escribe directamente sobre un disco", "writes straight onto a disk"],
  ["redirect-disk", />\s*\/dev\/(sd|nvme|vd|mmcblk|hd)\w*/, "escribe directamente sobre un disco", "writes straight onto a disk"],
  ["fork-bomb", /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "bomba de procesos", "fork bomb"],
  ["power", /(^|[;&|]\s*|\s)(shutdown|poweroff|reboot|halt|systemctl\s+(poweroff|reboot|halt|suspend))\b/, "apaga o reinicia el equipo", "shuts down or restarts the computer"],
  ["root", /(^|[;&|(]\s*|\s)(sudo|su|pkexec|doas)(\s|$)/, "pide permisos de administrador", "asks for administrator rights"],
  ["chmod-root", /\bch(mod|own)\s+(-\w+\s+)*\S+\s+\/(\s|$)/, "cambia los permisos de todo el sistema", "changes the permissions of the whole system"],
];

// Ask first: they publish, overwrite history or delete data, or run code downloaded from the internet.
const ASK: [string, RegExp, string, string][] = [
  ["git-push-force", /\bgit\s+push\b[^;&|]*(\s--force(-with-lease)?\b|\s-[a-zA-Z]*f\b|\s\+\S)/, "sobrescribe la historia del repositorio remoto (git push --force)", "overwrites the history of the remote repository (git push --force)"],
  ["git-push", /\bgit\s+push\b/, "publica commits en el repositorio remoto (git push)", "publishes commits to the remote repository (git push)"],
  ["git-reset-hard", /\bgit\s+reset\s+(\S+\s+)*--hard\b/, "descarta cambios sin guardar (git reset --hard)", "throws away unsaved changes (git reset --hard)"],
  ["git-clean", /\bgit\s+clean\s+(-\w*\s+)*-\w*f/, "borra archivos que git no sigue (git clean -f)", "deletes files git does not track (git clean -f)"],
  ["git-branch-delete", /\bgit\s+branch\s+(-\w+\s+)*-(D|-delete\s+--force)\b/, "borra una rama aunque no esté fusionada", "deletes a branch even if it is not merged"],
  ["git-commit", /\bgit\s+commit\b/, "hace un commit en tu repositorio", "makes a commit in your repository"],
  ["rm-recursive", new RegExp(RM_RECURSIVE), "borra carpetas enteras (rm -r)", "deletes whole folders (rm -r)"],
  ["find-delete", /\bfind\b[^;&|]*\s-delete\b/, "borra archivos en bloque (find -delete)", "deletes files in bulk (find -delete)"],
  ["sql-drop", /\b(drop\s+(table|database|schema|index|view)|truncate(\s+table)?\s+\w)/i, "borra datos de una base de datos (DROP/TRUNCATE)", "deletes data from a database (DROP/TRUNCATE)"],
  ["sql-delete-all", /\bdelete\s+from\s+[\w."`]+\s*(;|$|"|')/i, "borra todas las filas de una tabla (DELETE sin WHERE)", "deletes every row of a table (DELETE without WHERE)"],
  ["sql-update-all", /\bupdate\s+[\w."`]+\s+set\s+(?:(?!\bwhere\b)[^;])*(;|$)/i, "cambia todas las filas de una tabla (UPDATE sin WHERE)", "changes every row of a table (UPDATE without WHERE)"],
  ["db-migrate", /\b(prisma\s+(migrate\s+(deploy|reset)|db\s+push)|alembic\s+(upgrade|downgrade)|rails\s+db:(migrate|drop|reset)|manage\.py\s+(migrate|flush))\b/, "cambia el esquema o los datos de una base de datos", "changes the schema or the data of a database"],
  ["publish", /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\s+create\b/, "publica un paquete o una versión", "publishes a package or a release"],
  ["deploy", /\b(vercel|netlify)\b[^;&|]*--prod\b|\bfly\s+deploy\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(delete|apply|scale|rollout)\b|\bhelm\s+(install|upgrade|uninstall|delete)\b|\bgh\s+pr\s+merge\b/, "despliega o cambia infraestructura en producción", "deploys or changes production infrastructure"],
  ["docker-destroy", /\bdocker\s+(system\s+prune|volume\s+(rm|prune)|rm\s+-\w*f)/, "borra contenedores o volúmenes de Docker", "deletes Docker containers or volumes"],
  ["pipe-shell", /\b(curl|wget)\b[^;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/, "ejecuta un script descargado de internet sin revisarlo", "runs a script downloaded from the internet without review"],
  ["chmod-recursive", /\bch(mod|own)\s+(-\w*\s+)*-\w*R/, "cambia los permisos de muchos archivos a la vez", "changes the permissions of many files at once"],
  ["kill-all", /\b(pkill|killall)\b|\bkill\s+-9\s+-1\b/, "cierra procesos por nombre", "kills processes by name"],
  ["crontab", /\bcrontab\s+(-r|-e|\S+\.\w+)/, "cambia tareas programadas del sistema", "changes the system's scheduled tasks"],
];

/** Classify one shell command line. The first matching rule wins (BLOCK before ASK). */
export function classifyCommand(command: string): Risk {
  const c = String(command ?? "").replace(/\\\n/g, " ");
  if (!c.trim()) return { level: "block", reason: "el comando está vacío", reasonEn: "the command is empty", rule: "empty" };
  if (c.length > 8000) return { level: "block", reason: "el comando es demasiado largo para revisarlo", reasonEn: "the command is too long to review", rule: "too-long" };
  for (const [rule, re, reason, reasonEn] of BLOCK) if (re.test(c)) return { level: "block", reason, reasonEn, rule };
  for (const [rule, re, reason, reasonEn] of ASK) if (re.test(c)) return { level: "ask", reason, reasonEn, rule };
  return { level: "safe", reason: "se ejecuta aislado: solo puede escribir en la carpeta del proyecto", reasonEn: "runs isolated: it can only write in the project folder" };
}
