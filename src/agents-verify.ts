// Verificación (pin sha256) de los binarios externos que invoca la fábrica:
// claude, codex, agy, droid (idea: cmd/factory/release.go:171,226-265@d901657).
// El pin vive en <FABRICA_HOME>/agents.json y se verifica al arrancar el pool.
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Adaptadores externos cuyo binario se puede fijar/pinar. */
export const PINNED_AGENTS = ['claude', 'codex', 'agy', 'droid'];

export const factoryHome = (): string =>
  resolve(process.env.FABRICA_HOME ?? resolve(process.env.HOME ?? '.', '.fabrica'));

export const pinsFile = (home: string = factoryHome()): string => join(home, 'agents.json');

export type AgentBinVerdict = 'ok' | 'distinto' | 'no_instalado' | 'sin_pin';

export interface AgentBinStatus {
  agent: string;
  found: boolean;
  path: string | null;
  digest: string | null;
  pin: string | null;
  verdict: AgentBinVerdict;
}

export interface AgentStartCheck {
  ok: boolean;
  warning?: string;
  violation?: string;
}

const isHexSha256 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);

/** Pin persistente de binarios de agente (agents.json), en el home de fab. */
export function loadPins(home: string = factoryHome()): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(pinsFile(home), 'utf8'));
    const pins = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { agentBinaries?: unknown }).agentBinaries : undefined;
    if (pins && typeof pins === 'object' && !Array.isArray(pins)) {
      return Object.fromEntries(
        Object.entries(pins).filter(([k, v]) => PINNED_AGENTS.includes(k) && isHexSha256(v))
      ) as Record<string, string>;
    }
  } catch { /* sin archivo o JSON inválido: sin pines (aviso, no bloqueo). */ }
  return {};
}

/** Guarda los pines con escritura atómica, siguiendo la convención de chat.json (0600 + rename). */
export function savePins(pins: Record<string, string>, home: string = factoryHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = pinsFile(home);
  const temp = join(home, `agents.json.${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify({ agentBinaries: pins }, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

/** Resuelve el binario por nombre buscando en PATH; null si no está instalado. */
export function resolveBinary(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = resolve(dir, name);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Estado de un binario de agente: ok, distinto, no instalado o sin pin. */
export function agentBinStatus(agent: string, home: string = factoryHome()): AgentBinStatus {
  const pin = home ? loadPins(home)[agent] ?? null : null;
  const path = resolveBinary(agent);
  const digest = path ? sha256Of(path) : null;
  let verdict: AgentBinVerdict;
  if (!path) verdict = 'no_instalado';
  else if (pin && digest !== pin) verdict = 'distinto';
  else if (!pin) verdict = 'sin_pin';
  else verdict = 'ok';
  return { agent, found: !!path, path, digest, pin, verdict };
}

/** Estado de todos los binarios puneables. */
export function verifyAgents(home: string = factoryHome()): AgentBinStatus[] {
  return PINNED_AGENTS.map((a) => agentBinStatus(a, home));
}

const short = (v: string | null): string => (v ? `${v.slice(0, 12)}…` : '—');

function rowDetail(s: AgentBinStatus): string {
  if (!s.found) return '—';
  if (!s.pin) return `sha ${short(s.digest)} (sin pin)`;
  return s.verdict === 'ok' ? `sha ${short(s.digest)} coincide con el pin` : `pin ${short(s.pin)}, actual ${short(s.digest)}`;
}

/** `fab agents verify [--pin]`: lista el estado de cada binario; --pin guarda los pines actuales. */
export async function agentsMain(argv: string[]): Promise<number> {
  const pin = argv.includes('--pin') || argv.includes('-p');
  const home = factoryHome();
  if (pin) {
    const pins = loadPins(home);
    let written = 0;
    for (const agent of PINNED_AGENTS) {
      const path = resolveBinary(agent);
      if (!path) { console.log(`${agent.padEnd(8)} no instalado, sin pin`); continue; }
      pins[agent] = sha256Of(path);
      written += 1;
      console.log(`${agent.padEnd(8)} pin ${pins[agent]}`);
    }
    savePins(pins, home);
    console.log(`pines escritos: ${written} (archivo ${pinsFile(home)})`);
    return 0;
  }
  const estados = verifyAgents(home);
  for (const s of estados) console.log(`${s.agent.padEnd(8)} ${s.verdict.padEnd(13)} ${rowDetail(s)}`);
  const orden: AgentBinVerdict[] = ['ok', 'distinto', 'no_instalado', 'sin_pin'];
  const resumen = Object.fromEntries(orden.map((v) => [v, estados.filter((s) => s.verdict === v).length])) as Record<AgentBinVerdict, number>;
  console.log('resumen agents verify: ' + orden.map((v) => `${v}=${resumen[v]}`).join(' '));
  if (resumen.distinto > 0) console.log('aviso: binarios distintos al pin; fab run no arranca salvo --accept-agent-binaries');
  return 0;
}

/**
 * Comprobación única al arrancar el pool (runPool): el adaptador del workstream
 * con pin y binario distinto impide arrancar; sin pin → aviso, no bloqueo.
 */
export function verifyAgentStart(agentName: string, home: string = factoryHome()): AgentStartCheck {
  if (!PINNED_AGENTS.includes(agentName)) return { ok: true };
  const status = agentBinStatus(agentName, home);
  if (!status.found) return { ok: true, warning: `aviso: agente "${agentName}" no está en PATH; no se puede verificar el pin` };
  if (!status.pin) return { ok: true, warning: `aviso: agente "${agentName}" sin pin en ${pinsFile(home)} (fija con "fab agents verify --pin")` };
  if (status.digest === status.pin) return { ok: true };
  return {
    ok: false,
    violation: `agent "${agentName}" binario "${status.path}" sha256 distinto al pin fijado (${status.pin}); instálalo de nuevo o usa --accept-agent-binaries`,
  };
}
