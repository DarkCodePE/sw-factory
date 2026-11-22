// Qué entorno recibe el proceso del agente. Función pura: solo nombres y valores del `host` que se le pasa (T72d, D-K).

export type AgentEnvInput = {
  adapter: string; confined: boolean; channel: boolean;
  /** `null` = modo anterior (sin declarar). */
  wsAllow: string[] | null; roleEnv: string[]; mcpRequired: string[];
  host: NodeJS.ProcessEnv;
  /** Con modelo de rol resuelto no se copia `ANTHROPIC_MODEL` (T57 A6). */
  model?: string;
};

const BASE = /^(PATH|HOME|USER|LANG|LC_.*|TERM|TMPDIR|SHELL|XDG_.*)$/;
/** Solo sin confinar: las pone el pool para el proceso de captura (sonda de egress y nombres a limpiar), nunca el dueño. */
const CAPTURE = new Set(['FABRICA_EGRESS_PROBE_FILE', 'FABRICA_SCRUB_NAMES']);

export const NATIVE_VARS = ['FABRICA_LLM_API_KEY', 'FABRICA_LLM_BASE_URL', 'FABRICA_LLM_MODEL', 'FABRICA_HOME'];

/** Lista fija de cada adaptador: lo que necesita para autenticarse o funcionar. */
function adapterVars(adapter: string, model?: string): string[] {
  if (adapter === 'claude') return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...(model ? [] : ['ANTHROPIC_MODEL'])];
  if (adapter === 'codex') return ['OPENAI_API_KEY'];
  if (adapter === 'droid') return ['FACTORY_AIRGAP_ENABLED', 'FACTORY_HOME_OVERRIDE', 'FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH'];
  // `native` y `agy` no los pueden declarar (FABRICA_* está prohibido, B10): sin ellos pierden modelo y estado (T72e-H1).
  if (adapter === 'native' || adapter === 'agy') return NATIVE_VARS;
  return ['FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH', 'FABRICA_FAKE_ECHO'];
}

export function agentEnv(i: AgentEnvInput): { env: Record<string, string>; delivered: string[]; missing: string[]; denied: string[] } {
  const env: Record<string, string> = {};
  const take = (name: string) => { const v = i.host[name]; if (v !== undefined) env[name] = v; };
  if (i.wsAllow === null && !i.confined) {
    for (const [k, v] of Object.entries(i.host)) if (v !== undefined) env[k] = v;
    return { env, delivered: [], missing: [], denied: [] };
  }
  if (!i.confined) for (const k of Object.keys(i.host)) if (BASE.test(k) || CAPTURE.has(k)) take(k);
  for (const k of adapterVars(i.adapter, i.model)) take(k);
  if (i.wsAllow === null) return { env, delivered: [], missing: [], denied: [] };
  const declared = i.channel ? [] : [...new Set([...i.roleEnv, ...i.mcpRequired])];
  const denied = declared.filter(n => !i.wsAllow!.includes(n));
  const delivered = declared.filter(n => i.wsAllow!.includes(n));
  const missing = delivered.filter(n => i.host[n] === undefined);
  for (const n of delivered) take(n);
  return { env, delivered: delivered.filter(n => !missing.includes(n)), missing, denied };
}

/** Sustituye cada valor de 8 o más caracteres por `[REDACTED:NOMBRE]`. Limpia el caso accidental, no una salida codificada (R4); va antes de `redact`. */
export function scrubValues(text: string, values: Record<string, string>): string {
  // Los más largos primero: un valor que contiene a otro no deja resto.
  for (const [name, value] of Object.entries(values).sort((a, b) => b[1].length - a[1].length))
    if (value.length >= 8) text = text.replaceAll(value, `[REDACTED:${name}]`);
  return text;
}
