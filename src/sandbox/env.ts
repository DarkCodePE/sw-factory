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

/** Lista fija de cada adaptador: lo que necesita para autenticarse o funcionar. */
function adapterVars(adapter: string, model?: string): string[] {
  if (adapter === 'claude') return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...(model ? [] : ['ANTHROPIC_MODEL'])];
  if (adapter === 'codex') return ['OPENAI_API_KEY'];
  if (adapter === 'droid') return ['FACTORY_AIRGAP_ENABLED', 'FACTORY_HOME_OVERRIDE', 'FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH'];
  return ['FABRICA_FAKE_SLEEP', 'FABRICA_FAKE_STATUS', 'FABRICA_FAKE_TOUCH'];
}

export function agentEnv(i: AgentEnvInput): { env: Record<string, string>; delivered: string[]; missing: string[]; denied: string[] } {
  const env: Record<string, string> = {};
  const take = (name: string) => { const v = i.host[name]; if (v !== undefined) env[name] = v; };
  if (i.wsAllow === null && !i.confined) {
    for (const [k, v] of Object.entries(i.host)) if (v !== undefined) env[k] = v;
    return { env, delivered: [], missing: [], denied: [] };
  }
  if (!i.confined) for (const k of Object.keys(i.host)) if (BASE.test(k)) take(k);
  for (const k of adapterVars(i.adapter, i.model)) take(k);
  if (i.wsAllow === null) return { env, delivered: [], missing: [], denied: [] };
  const declared = i.channel ? [] : [...new Set([...i.roleEnv, ...i.mcpRequired])];
  const denied = declared.filter(n => !i.wsAllow!.includes(n));
  const delivered = declared.filter(n => i.wsAllow!.includes(n));
  const missing = delivered.filter(n => i.host[n] === undefined);
  for (const n of delivered) take(n);
  return { env, delivered: delivered.filter(n => !missing.includes(n)), missing, denied };
}
