// When NEXUS AI cannot answer, the person gets a plain sentence that says WHAT failed and WHOSE fault it is (almost
// never theirs), plus what to do. Every place that talks to Claude (the panel, `ai` in the terminal, the browser's
// search, agents) maps its failure through here, so the words are the same everywhere.
export type AiFix = "settings-ai" | "retry" | "network" | "shorter" | "wait" | "none";
export type AiTrouble = { why: string; title: string; text: string; fix: AiFix; mine: boolean };

/** `why` is the Engine's short code (no_key, auth, rate_limit, overloaded, offline, api_<status>, timeout, engine_down, refusal, error). */
export function describeAiError(why: string, detail = ""): AiTrouble {
  const d = String(detail ?? "").toLowerCase();
  switch (why) {
    case "no_key": case "not_configured": return { why, title: "NEXUS AI todavía no tiene clave", text: "Para usar NEXUS AI hace falta una clave de Claude. Pégala en Ajustes → NEXUS AI (se queda en este equipo).", fix: "settings-ai", mine: false };
    case "auth": return { why, title: "Claude no acepta la clave", text: "La clave de Claude guardada no vale (está mal copiada, caducada o la has revocado). Pon otra en Ajustes → NEXUS AI.", fix: "settings-ai", mine: false };
    case "rate_limit":
      if (/credit|balance|billing|quota|saldo/.test(d)) return { why: "credits", title: "La cuenta de Claude no tiene saldo", text: "Tu cuenta de Claude se ha quedado sin crédito. Añade saldo en console.anthropic.com y vuelve a intentarlo. NEXUS no ha fallado.", fix: "none", mine: false };
      return { why, title: "Demasiadas peticiones seguidas", text: "Claude está limitando el ritmo de tu cuenta ahora mismo. No es un fallo tuyo: espera unos segundos y vuelve a intentarlo.", fix: "wait", mine: false };
    case "overloaded": case "api_529": return { why: "overloaded", title: "Claude está saturado", text: "Los servidores de Claude van sobrecargados ahora mismo. No es cosa tuya ni de NEXUS: inténtalo de nuevo en un momento.", fix: "retry", mine: false };
    case "offline": return { why, title: "Sin conexión con Claude", text: "No llego a los servidores de Claude. Comprueba que este equipo tiene Internet (Ajustes → Wi-Fi).", fix: "network", mine: false };
    case "timeout": return { why, title: "Claude ha tardado demasiado", text: "La respuesta no ha llegado a tiempo. Suele ser cosa de la red o de Claude: vuelve a intentarlo.", fix: "retry", mine: false };
    case "engine_down": return { why, title: "El motor de NEXUS no responde", text: "El servicio de NEXUS AI está parado o reiniciándose. Espera unos segundos; si sigue así, reinicia el equipo. No es culpa tuya.", fix: "wait", mine: false };
    case "refusal": return { why, title: "Claude no quiere responder a eso", text: "Claude ha rechazado esta petición por sus normas. Prueba a formularla de otra manera.", fix: "none", mine: true };
    case "api_400": case "too_long": return { why: "too_long", title: "He mandado demasiado texto", text: "Lo que te pedía Claude era demasiado largo (texto, página o salida de la terminal). Prueba con menos cosas a la vez.", fix: "shorter", mine: false };
    case "api_403": return { why, title: "Claude no permite esta clave aquí", text: "La clave existe pero no tiene permiso para este uso (organización, modelo o región). Revísala en console.anthropic.com.", fix: "settings-ai", mine: false };
    case "api_404": return { why, title: "El modelo no está disponible", text: "Claude dice que el modelo que pide NEXUS no existe para tu cuenta. Es cosa de NEXUS o de Anthropic, no tuya: avisa y mientras tanto inténtalo más tarde.", fix: "none", mine: false };
    case "api_413": return describeAiError("too_long");
    case "api_500": case "api_502": case "api_503": case "api_504": return { why: "api_5xx", title: "Claude ha fallado en su lado", text: "Los servidores de Claude han devuelto un error. No es cosa tuya: inténtalo de nuevo en un momento.", fix: "retry", mine: false };
    default: return { why: why || "error", title: "No he podido hablar con Claude", text: "Algo ha fallado al pedirle la respuesta a Claude. No parece cosa tuya: inténtalo otra vez y, si sigue, mira Ajustes → NEXUS AI.", fix: "retry", mine: false };
  }
}

/** What the Anthropic SDK threw, as the Engine's short code. */
export function whyFromError(e: unknown, isAuth: boolean, isRate: boolean, isConn: boolean, status?: number): string {
  if (isAuth) return "auth";
  if (isRate) return "rate_limit";
  if (isConn) return /timeout|timed out|ETIMEDOUT|aborted/i.test(String((e as Error)?.message ?? "")) ? "timeout" : "offline";
  if (status === 529) return "overloaded";
  if (status) return `api_${status}`;
  return "error";
}
