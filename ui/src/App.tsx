import { useCallback, useEffect, useState } from "react";

type Task = { id: string; project: string; prompt: string; status: string; result?: string; reason?: string; createdAt: string };
type Step = { id: string; agent: string; prompt: string; dependsOn: string[] };
type Plan = { goal: string; steps: Step[] };
type Iter = { n: number; ok: boolean; remote?: boolean; worker?: string; summary: { tests?: number; failed: string[] }; killedBy?: string };
type Integration = { branch: string; commit: string | null; files: string[]; verified: boolean; conflicts: string[]; state: string; note?: string };
type Run = { id: string; goal: string; status: string; execution?: string; isolated?: boolean; integration?: Integration; steps: { id: string; agent: string; status: string; reason?: string; iterations?: Iter[] }[] };
type Bucket = { costUsd: number; tasks: number; tokens: number };
type Usage = { total: Bucket; byAgent: Record<string, Bucket>; byProject: Record<string, Bucket>; byRun: Record<string, Bucket>; budgets: { perRunUsd: number; perProjectUsd: number; totalUsd: number }; spent: number;
  exhaustions: { seq: number; ts: string; data: { reason: string } }[]; billing: { mode: string; subscriptionType?: string; note: string }; recent: { taskId: string; agent: string; costUsd: number; status: string }[] };
type Worker = { id: string; name: string; status: string; online: boolean; lastSeen: string | null; platform?: string; isolation?: { available: boolean; mechanism: string; reason?: string }; kinds: string[]; projects: number; certNotAfter?: string; caGen?: number };
type RJob = { id: string; kind: string; status: string; worker?: string; attempt: number; reason?: string; fence?: number; runId?: string };
type State = { workers: Worker[]; gatewayInfo: { enabled: boolean; address?: { host: string; port: number } | null }; remoteJobs: RJob[]; usage: Usage; sandbox: { available: boolean; runners: { id: string; available: boolean }[] }; runs: Run[]; roles: { id: string; title: string; writes: boolean }[]; agents: { id: string; installed: boolean; version?: string }[]; projects: { name: string; path: string }[]; tasks: Task[];
  approvals: { id: string; action: unknown }[]; audit: { seq: number; ts: string; type: string }[]; auditIntegrity: { ok: boolean } };

const q = new URLSearchParams(location.search);
if (q.get("token")) { sessionStorage.setItem("nexus-token", q.get("token")!); history.replaceState(null, "", "/"); }
const token = () => sessionStorage.getItem("nexus-token") ?? "";
async function api(p: string, method = "GET", body?: unknown) {
  const r = await fetch(p, { method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error ?? r.statusText); return j;
}

export default function App() {
  const [s, setS] = useState<State>(); const [err, setErr] = useState(""); const [proj, setProj] = useState(""); const [prompt, setPrompt] = useState("");
  const [goal, setGoal] = useState(""); const [plan, setPlan] = useState<Plan>(); const [planErr, setPlanErr] = useState("");
  const [name, setName] = useState(""); const [execution, setExecution] = useState("local"); const [wName, setWName] = useState(""); const [wAgent, setWAgent] = useState(false); const [bundle, setBundle] = useState(""); const [path, setPath] = useState("");
  const load = useCallback(() => api("/api/state").then(setS).catch((e) => setErr(String(e.message))), []);
  useEffect(() => { load(); const i = setInterval(load, 2000); return () => clearInterval(i); }, [load]);
  const run = async (f: () => Promise<unknown>) => { setErr(""); try { await f(); await load(); } catch (e: any) { setErr(e.message); } };
  if (!s) return <main><h1>NEXUS</h1><p className="muted">{err || "Conectando…"} {!token() && "Abre http://127.0.0.1:7777/?token=<contenido del fichero token> (el servidor nunca imprime el token)."}</p></main>;
  const claude = s.agents.find((a) => a.id === "claude-code");
  return (
    <main>
      <header><h1>NEXUS</h1><span className={`pill ${claude?.installed ? "ok" : "bad"}`}>Claude Code {claude?.installed ? claude.version : "no detectado"}</span>
        <span className={`pill ${s.sandbox.available ? "ok" : "bad"}`}>sandbox {s.sandbox.available ? "Seatbelt activo" : "no disponible"}</span>
        <span className={`pill ${s.auditIntegrity.ok ? "ok" : "bad"}`}>auditoría {s.auditIntegrity.ok ? "íntegra" : "ALTERADA"}</span></header>
      {err && <p className="err">{err}</p>}
      <section><h2>Proyectos autorizados</h2>
        <ul>{s.projects.map((p) => <li key={p.path}><b>{p.name}</b> <code>{p.path}</code></li>)}{!s.projects.length && <li className="muted">Ninguno. NEXUS no puede tocar nada hasta que autorices una carpeta.</li>}</ul>
        <form onSubmit={(e) => { e.preventDefault(); run(() => api("/api/projects", "POST", { name, path })); }}>
          <input placeholder="nombre" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="/ruta/absoluta" value={path} onChange={(e) => setPath(e.target.value)} required /><button>Autorizar carpeta</button></form></section>
      <section><h2>NEXUS AI · nueva tarea</h2>
        <form onSubmit={(e) => { e.preventDefault(); run(async () => { await api("/api/tasks", "POST", { project: proj || s.projects[0]?.path, prompt }); setPrompt(""); }); }}>
          <select value={proj} onChange={(e) => setProj(e.target.value)}>{s.projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}</select>
          <input className="wide" placeholder="Describe la tarea de código…" value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          <button disabled={!s.projects.length || !claude?.installed}>Ejecutar con Claude Code</button></form></section>
      {s.approvals.length > 0 && <section><h2>Aprobaciones pendientes</h2>{s.approvals.map((a) => <div key={a.id}><code>{JSON.stringify(a.action)}</code>
        <button onClick={() => run(() => api("/api/approvals", "POST", { id: a.id, approve: true }))}>Aprobar</button>
        <button onClick={() => run(() => api("/api/approvals", "POST", { id: a.id, approve: false }))}>Rechazar</button></div>)}</section>}
      <section><h2>Plan multi-agente</h2>
        <form onSubmit={(e) => { e.preventDefault(); setPlan(undefined); setPlanErr(""); run(async () => { const r = await api("/api/plans", "POST", { project: proj || s.projects[0]?.path, goal }); if (r.plan) setPlan(r.plan); else setPlanErr(r.errors.join("; ")); }); }}>
          <input className="wide" placeholder="Objetivo (el Planner propone pasos; nada se ejecuta hasta que lo apruebes)" value={goal} onChange={(e) => setGoal(e.target.value)} required />
          <button disabled={!s.projects.length || !claude?.installed}>Proponer plan</button></form>
        {planErr && <p className="err">{planErr}</p>}
        {plan && <div><ul>{plan.steps.map((st) => <li key={st.id}><b>{st.id}</b> · {st.agent} {st.dependsOn.length > 0 && <span className="muted">← {st.dependsOn.join(", ")}</span>}<br /><span className="muted">{st.prompt}</span></li>)}</ul>
          <select value={execution} onChange={(e) => setExecution(e.target.value)} title="Dónde se ejecuta el plan"><option value="local">ejecución local</option><option value="remote">en worker remoto (sin fallback)</option><option value="auto">auto (remoto si hay worker)</option></select>
          <button onClick={() => run(async () => { await api("/api/runs", "POST", { project: proj || s.projects[0]?.path, plan, execution }); setPlan(undefined); })}>Aprobar y ejecutar</button>
          <button onClick={() => setPlan(undefined)}>Descartar</button></div>}
        {s.runs.map((r) => <article key={r.id}><div><span className={`pill ${r.status}`}>{r.status}</span> {r.goal}
          {r.status === "running" && <button onClick={() => run(() => api(`/api/runs/${r.id}/cancel`, "POST"))}>Cancelar</button>}</div>
          <div className="steps">{r.steps.map((st) => <span key={st.id} className={`pill ${st.status}`} title={st.reason}>{st.id} · {st.agent} · {st.status}</span>)}</div>
          {r.steps.filter((st) => st.iterations?.length).map((st) => <div key={st.id} className="muted">Sandbox «{st.id}»: {st.iterations!.map((i) => <span key={i.n} className={i.ok ? "ok" : "bad"}>  #{i.n} {i.ok ? "✔ pasa" : `✖ ${i.summary.failed.length || ""} fallo(s)${i.killedBy ? " (" + i.killedBy + ")" : ""}`}{i.remote ? ` @${i.worker}` : ""}</span>)}</div>)}
          <div className="muted">Coste estimado: ${(s.usage.byRun[r.id]?.costUsd ?? 0).toFixed(4)} · {s.usage.byRun[r.id]?.tasks ?? 0} llamadas</div>
          {r.execution && r.execution !== "local" && <div className="muted">ejecución: {r.execution}</div>}
          {r.integration && <div><code>{r.integration.branch}</code> · {r.integration.files.length} archivo(s) · <span className={r.integration.verified ? "ok" : "bad"}>{r.integration.verified ? "verificado" : "NO verificado"}</span> · {r.integration.state}{r.integration.note && <span className="muted"> — {r.integration.note}</span>}
            {r.integration.state === "pending" && r.integration.commit && <>
              <button disabled={!r.integration.verified} title={r.integration.verified ? "" : "Solo se integra lo verificado por el sandbox"} onClick={() => run(() => api(`/api/runs/${r.id}/integrate`, "POST"))}>Integrar en el proyecto</button>
              <button onClick={() => run(() => api(`/api/runs/${r.id}/discard`, "POST"))}>Descartar rama</button></>}</div>}</article>)}</section>
      <section><h2>Workers remotos <span className="muted">(mTLS · TLS 1.3)</span></h2>
        {!s.gatewayInfo.enabled ? <p className="muted">El gateway está desactivado. Arranca el núcleo con <code>NEXUS_GATEWAY=1</code>; por defecto escucha solo en 127.0.0.1.</p> :
          <p className="muted">Gateway en <code>{s.gatewayInfo.address ? `${s.gatewayInfo.address.host}:${s.gatewayInfo.address.port}` : "…"}</code> — separado de la API local, solo habla el protocolo de workers.</p>}
        {s.gatewayInfo.enabled && <>
          <ul>{s.workers.map((w) => <li key={w.id}><span className={w.online ? "ok" : "bad"}>●</span> <b>{w.name}</b> <code>{w.id}</code> <span className={`pill ${w.status === "active" ? "ok" : w.status === "revoked" ? "bad" : "pending"}`}>{w.status}</span>
            {" "}{w.online ? "conectado" : "desconectado"} · {w.platform ?? "—"} · aislamiento: <span className={w.isolation?.available ? "ok" : "bad"}>{w.isolation ? (w.isolation.available ? w.isolation.mechanism : "NINGUNO — no ejecuta") : "—"}</span> · {w.kinds.join("+")} · {w.projects} proyecto(s)
            {w.certNotAfter && <span className="muted"> · cert hasta {w.certNotAfter.slice(0, 10)}</span>}
            {w.status !== "revoked" && <button onClick={() => run(() => api(`/api/workers/${w.id}/revoke`, "POST"))}>Revocar</button>}</li>)}
            {!s.workers.length && <li className="muted">Sin workers. Crea uno y copia el paquete de enrolamiento a la otra máquina.</li>}</ul>
          <form onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await api("/api/workers", "POST", { name: wName, kinds: wAgent ? ["sandbox", "agent"] : ["sandbox"], projects: proj ? [proj] : s.projects.slice(0, 1).map((p) => p.path) }); setBundle(JSON.stringify(r.bundle, null, 2)); setWName(""); }); }}>
            <input placeholder="nombre del worker" value={wName} onChange={(e) => setWName(e.target.value)} required />
            <label className="muted"><input type="checkbox" checked={wAgent} onChange={(e) => setWAgent(e.target.checked)} /> permitir trabajos de agente (Claude Code sin sandbox en el worker)</label>
            <button disabled={!s.projects.length}>Crear worker y paquete de enrolamiento</button></form>
          {bundle && <div><p className="err">Paquete de un solo uso (caduca en 15 min). No se vuelve a mostrar:</p><textarea readOnly rows={8} style={{ width: "100%", background: "#0a1028", color: "#b9c4ff" }} value={bundle} /><button onClick={() => setBundle("")}>Ya lo copié</button>
            <p className="muted">En el worker: <code>node worker-cli.ts enroll --bundle bundle.json --dir ~/nexus-worker</code> y luego <code>run --dir ~/nexus-worker</code>.</p></div>}
          {s.remoteJobs.length > 0 && <><h2>Trabajos remotos</h2><ul className="log">{s.remoteJobs.map((j) => <li key={j.id}><span className={`pill ${j.status}`}>{j.status}</span> {j.kind} · intento {j.attempt}{j.worker ? ` · ${j.worker}` : ""}{j.fence ? ` · fence ${j.fence}` : ""}{j.reason && <span className="muted"> — {j.reason}</span>}</li>)}</ul></>}</>}</section>
      <section><h2>Uso y costes <span className="muted">(estimados, no facturados)</span></h2>
        <p className={s.usage.billing.mode === "metered" ? "err" : "muted"}>Facturación: <b>{s.usage.billing.mode === "subscription" ? `suscripción ${s.usage.billing.subscriptionType ?? ""}` : s.usage.billing.mode === "metered" ? "de pago por uso (API)" : "desconocida"}</b>. {s.usage.billing.note}</p>
        <p>Total estimado: <b>${s.usage.total.costUsd.toFixed(4)}</b> · {s.usage.total.tasks} llamadas · {s.usage.total.tokens.toLocaleString()} tokens</p>
        <ul>{Object.entries(s.usage.byAgent).map(([k, v]) => <li key={k}>agente <b>{k}</b>: ${v.costUsd.toFixed(4)} <span className="muted">({v.tasks})</span></li>)}
          {Object.entries(s.usage.byProject).map(([k, v]) => <li key={k}>proyecto <code>{k.split("/").slice(-2).join("/")}</code>: ${v.costUsd.toFixed(4)}</li>)}</ul>
        <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => api("/api/budgets", "POST", { perRunUsd: f.get("r"), perProjectUsd: f.get("p"), totalUsd: f.get("t") })); }}>
          <label className="muted">por ejecución $<input name="r" size={4} defaultValue={s.usage.budgets.perRunUsd} /></label>
          <label className="muted">por proyecto $<input name="p" size={4} defaultValue={s.usage.budgets.perProjectUsd} /></label>
          <label className="muted">total $<input name="t" size={4} defaultValue={s.usage.budgets.totalUsd} /></label><button>Guardar presupuestos</button>
          <span className="muted"> gastado ${s.usage.spent.toFixed(4)} de ${s.usage.budgets.totalUsd}</span></form>
        {s.usage.exhaustions.map((x) => <p key={x.seq} className="err">⚠ presupuesto agotado {x.ts.slice(11, 19)}: {x.data.reason}</p>)}</section>
      <section><h2>Tareas</h2>{s.tasks.map((t) => <article key={t.id}><div><span className={`pill ${t.status}`}>{t.status}</span> {t.prompt}
        {t.status === "running" && <button onClick={() => run(() => api(`/api/tasks/${t.id}/cancel`, "POST"))}>Cancelar</button>}</div>
        {(t.result || t.reason) && <pre>{t.result || t.reason}</pre>}</article>)}{!s.tasks.length && <p className="muted">Sin tareas todavía.</p>}</section>
      <section><h2>Registro de auditoría</h2><ul className="log">{[...s.audit].reverse().slice(0, 30).map((e) => <li key={e.seq}><code>{e.ts.slice(11, 19)}</code> {e.type}</li>)}</ul></section>
    </main>);
}
