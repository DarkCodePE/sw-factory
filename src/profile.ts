// Perfil de instrucciones inmutable, identificado por digest sha256 del JSON canónico.
// Idea: ext/esf/internal/harnessprofile/profile.go@d901657 (MIT); reimplementado, sin copiar código.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_NAMES, MCP_AGENTS, MODEL_AGENTS } from './agents.ts';
import { CONFINABLE_AGENTS } from './sandbox/confine.ts';
import { COMMIT_LINE, DEFAULT_WORKER_TEMPLATES, type WorkerTemplates } from './prompts.ts';
import { DEFAULT_VALIDATOR_TEMPLATES, type ValidatorTemplates } from './validators/prompts.ts';

export const ROLES = ['investigate', 'implement', 'code_review', 'security_audit', 'qa'] as const;
export type Role = (typeof ROLES)[number];
/** `env` y `mcp` son solo nombres (D-K); el workstream pone el tope (T72). */
export interface RoleConfig { harness?: string; model?: string; env?: string[]; mcp?: string[] }

export interface Profile {
  schemaVersion: 1 | 2;
  /** Adaptador para el que se escribió el perfil; es identidad, no se impone al workstream. */
  harness: string;
  model?: string;
  repo?: string;
  worker: WorkerTemplates;
  validators: ValidatorTemplates;
  /** Solo v2: adaptador y modelo por rol; cada rol y cada campo son opcionales. */
  roles?: Partial<Record<Role, RoleConfig>>;
  /** Solo v2: jueces que clasifican ejecuciones terminadas. Son un aviso, nunca una puerta (T64). */
  scorers?: Record<string, ScorerDef>;
}

export const SCORER_SCOPES = [...ROLES, 'change'] as const;
export type ScorerScope = (typeof SCORER_SCOPES)[number];
export interface ScorerClass { label: string; score: number }
export interface ScorerDef { scope: ScorerScope; rubric: string; classes: ScorerClass[]; passing: number; sampling: number; harness?: string; model?: string }

const MAX_TEMPLATE = 32 * 1024;
const WORKER_KEYS = ['rules', 'investigate', 'implement'];
const VALIDATOR_KEYS = ['rules', 'code_review', 'security_audit', 'qa'];
const TOP_KEYS = ['schemaVersion', 'harness', 'model', 'repo', 'worker', 'validators'];
const TOP_KEYS_V2 = [...TOP_KEYS, 'roles', 'scorers'];
const SCORER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const CLASS_LABEL_RE = /^[a-z0-9_-]{1,24}$/;
const MAX_SCORERS = 8;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MCP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// Controlan el cargador, git o la propia fab: ningún perfil puede pedirlas.
const ENV_FORBIDDEN = /^(PATH|HOME|TMPDIR|NODE_OPTIONS)$|^(LD_|BUN_|GIT_CONFIG|FAB_|FABRICA_)/;
const MCP_RESERVED = 'fab';

/** Lista de nombres sin repetir; cada rechazo nombra el campo. */
function names(raw: unknown, where: string, max: number, re: RegExp, extra: (n: string) => string | null): void {
  if (!Array.isArray(raw)) throw new Error(`perfil inválido: ${where} debe ser una lista`);
  if (raw.length > max) throw new Error(`perfil inválido: ${where} admite hasta ${max} nombres`);
  for (const n of raw) {
    if (typeof n !== 'string' || !re.test(n)) throw new Error(`perfil inválido: ${where}: cada nombre debe cumplir ${re}`);
    const why = extra(n);
    if (why) throw new Error(`perfil inválido: ${where}: ${n} ${why}`);
  }
  if (new Set(raw).size !== raw.length) throw new Error(`perfil inválido: ${where} no admite nombres repetidos`);
}
const unit = (n: unknown): n is number => typeof n === 'number' && n >= 0 && n <= 1;
// El primer carácter no puede ser `-`: el modelo viaja como elemento de argv y no debe leerse como flag.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

/** JSON con claves ordenadas y sin espacios: misma semántica, mismos bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const profileDigest = (p: Profile): string => createHash('sha256').update(canonicalJson(p)).digest('hex');

export function defaultProfile(): Profile {
  return { schemaVersion: 1, harness: 'native', worker: { ...DEFAULT_WORKER_TEMPLATES }, validators: { ...DEFAULT_VALIDATOR_TEMPLATES } };
}

function templates(raw: unknown, keys: string[], where: string): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`perfil inválido: ${where} debe ser un objeto`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`perfil inválido: clave desconocida ${where}.${k}`);
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`perfil inválido: ${where}.${k} debe ser un texto no vacío`);
    if (v.length > MAX_TEMPLATE) throw new Error(`perfil inválido: ${where}.${k} supera ${MAX_TEMPLATE} caracteres`);
  }
}

function validateScorers(raw: unknown, profileHarness: string, modelOk: (m: unknown, adapter: string, where: string) => void): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('perfil inválido: scorers debe ser un objeto');
  const entries = Object.entries(raw);
  if (entries.length > MAX_SCORERS) throw new Error(`perfil inválido: scorers admite como mucho ${MAX_SCORERS} jueces`);
  for (const [name, def] of entries) {
    const at = `scorers.${name}`;
    if (!SCORER_NAME_RE.test(name)) throw new Error(`perfil inválido: ${at} debe cumplir ${SCORER_NAME_RE}`);
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error(`perfil inválido: ${at} debe ser un objeto`);
    const d = def as Record<string, unknown>;
    for (const k of Object.keys(d)) if (!['scope', 'rubric', 'classes', 'passing', 'sampling', 'harness', 'model'].includes(k)) throw new Error(`perfil inválido: clave desconocida ${at}.${k}`);
    if (!(SCORER_SCOPES as readonly unknown[]).includes(d.scope)) throw new Error(`perfil inválido: ${at}.scope debe ser uno de ${SCORER_SCOPES.join(', ')}`);
    if (typeof d.rubric !== 'string' || !d.rubric.trim()) throw new Error(`perfil inválido: ${at}.rubric debe ser un texto no vacío`);
    if (d.rubric.length > MAX_TEMPLATE) throw new Error(`perfil inválido: ${at}.rubric supera ${MAX_TEMPLATE} caracteres`);
    if (!Array.isArray(d.classes) || d.classes.length < 2 || d.classes.length > 7) throw new Error(`perfil inválido: ${at}.classes debe ser una lista de 2 a 7 clases`);
    const seen = new Set<string>();
    d.classes.forEach((c: unknown, i: number) => {
      const cat = `${at}.classes[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`perfil inválido: ${cat} debe ser un objeto`);
      const k = c as Record<string, unknown>;
      for (const key of Object.keys(k)) if (key !== 'label' && key !== 'score') throw new Error(`perfil inválido: clave desconocida ${cat}.${key}`);
      if (typeof k.label !== 'string' || !CLASS_LABEL_RE.test(k.label)) throw new Error(`perfil inválido: ${cat}.label debe cumplir ${CLASS_LABEL_RE}`);
      if (seen.has(k.label)) throw new Error(`perfil inválido: ${at}.classes: etiqueta repetida ${k.label}`);
      seen.add(k.label);
      if (!unit(k.score)) throw new Error(`perfil inválido: ${cat}.score debe ser un número entre 0 y 1`);
    });
    for (const k of ['passing', 'sampling'] as const) if (!unit(d[k])) throw new Error(`perfil inválido: ${at}.${k} debe ser un número entre 0 y 1`);
    // El juez corre siempre confinado: su adaptador (propio o el del perfil) debe poder confinarse.
    const adapter = d.harness ?? profileHarness;
    if (typeof adapter !== 'string' || !AGENT_NAMES.includes(adapter) || !CONFINABLE_AGENTS.includes(adapter)) throw new Error(`perfil inválido: ${at}.harness debe ser un adaptador confinable (${CONFINABLE_AGENTS.join(', ')})`);
    modelOk(d.model, adapter, `${at}.model`);
  }
}

/** Valida esquema y plantillas. Lanza con un mensaje que nombra el campo. */
export function validateProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('perfil inválido: debe ser un objeto JSON');
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1 && o.schemaVersion !== 2) throw new Error('perfil inválido: schemaVersion debe ser 1 o 2');
  const v2 = o.schemaVersion === 2;
  for (const k of Object.keys(o)) if (!(v2 ? TOP_KEYS_V2 : TOP_KEYS).includes(k)) throw new Error(`perfil inválido: clave desconocida ${k}`);
  if (typeof o.harness !== 'string' || !AGENT_NAMES.includes(o.harness)) throw new Error(`perfil inválido: harness debe ser uno de ${AGENT_NAMES.join(', ')}`);
  for (const k of ['model', 'repo'] as const) if (o[k] !== undefined && (typeof o[k] !== 'string' || !o[k])) throw new Error(`perfil inválido: ${k} debe ser un texto no vacío`);
  const modelOk = (m: unknown, adapter: string, where: string) => {
    if (m === undefined) return;
    if (typeof m !== 'string' || !MODEL_RE.test(m)) throw new Error(`perfil inválido: ${where} debe cumplir ${MODEL_RE}`);
    if (!MODEL_AGENTS.includes(adapter)) throw new Error(`perfil inválido: ${where}: el adaptador ${adapter} no admite modelo`);
  };
  if (v2) {
    modelOk(o.model, o.harness, 'model');
    if (o.roles !== undefined) {
      if (!o.roles || typeof o.roles !== 'object' || Array.isArray(o.roles)) throw new Error('perfil inválido: roles debe ser un objeto');
      for (const [role, cfg] of Object.entries(o.roles)) {
        if (!(ROLES as readonly string[]).includes(role)) throw new Error(`perfil inválido: clave desconocida roles.${role}`);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`perfil inválido: roles.${role} debe ser un objeto`);
        const c = cfg as RoleConfig;
        for (const k of Object.keys(c)) if (!['harness', 'model', 'env', 'mcp'].includes(k)) throw new Error(`perfil inválido: clave desconocida roles.${role}.${k}`);
        if (c.harness !== undefined && (typeof c.harness !== 'string' || !AGENT_NAMES.includes(c.harness))) throw new Error(`perfil inválido: roles.${role}.harness debe ser uno de ${AGENT_NAMES.join(', ')}`);
        modelOk(c.model, c.harness ?? o.harness, `roles.${role}.model`);
        if (c.env !== undefined) names(c.env, `roles.${role}.env`, 16, ENV_NAME_RE, n => ENV_FORBIDDEN.test(n) ? 'es un nombre prohibido (controla el cargador, git o la fab)' : null);
        if (c.mcp !== undefined) {
          names(c.mcp, `roles.${role}.mcp`, 8, MCP_NAME_RE, n => n === MCP_RESERVED ? 'está reservado (servidor de report)' : null);
          const adapter = c.harness ?? (o.harness as string);
          if (c.mcp.length && !MCP_AGENTS.includes(adapter)) throw new Error(`perfil inválido: roles.${role}.mcp: el adaptador ${adapter} no admite MCP por rol`);
        }
      }
    }
  }
  if (v2 && o.scorers !== undefined) validateScorers(o.scorers, o.harness as string, modelOk);
  templates(o.worker, WORKER_KEYS, 'worker');
  templates(o.validators, VALIDATOR_KEYS, 'validators');
  const w = o.worker as Record<string, string>, v = o.validators as Record<string, string>;
  // Sin estas marcas el pool no puede leer el resultado del agente, así que se rechaza al importar.
  if (!w.rules!.includes('STATUS:')) throw new Error('perfil inválido: worker.rules debe exigir la línea STATUS:');
  if (!v.rules!.includes('STATUS:') || !v.rules!.includes('VERDICT:')) throw new Error('perfil inválido: validators.rules debe exigir STATUS: y VERDICT:');
  if (!w.implement!.includes(COMMIT_LINE)) throw new Error('perfil inválido: worker.implement debe conservar la línea de commit (la fábrica la sustituye para agentes sin acceso a .git)');
  return o as unknown as Profile;
}

/** Rol de una activity, o null si no lanza agente con rol propio (gates, change_review humano, steward). */
export function roleOf(a: { kind: string; validator: string | null }): Role | null {
  if (a.validator) return (ROLES as readonly string[]).includes(a.validator) ? (a.validator as Role) : null;
  return a.kind === 'investigation' ? 'investigate' : a.kind === 'implementation' ? 'implement' : null;
}

/**
 * Adaptador y modelo de una activity: override de la CLI > rol del perfil v2 > workstream.
 * Un modelo solo vale para el adaptador con el que se declaró. Con v1 es siempre lo de antes.
 */
export function resolveRole(profile: Profile, role: Role | null, wsAgent: string, override?: string): { adapter: string; model: string | null; source: 'override' | 'role' | 'workstream' } {
  if (profile.schemaVersion !== 2) return { adapter: override ?? wsAgent, model: null, source: override ? 'override' : 'workstream' };
  const cfg = role ? profile.roles?.[role] : undefined;
  const adapter = override ?? cfg?.harness ?? wsAgent;
  const model = cfg?.model !== undefined && adapter === (cfg.harness ?? profile.harness) ? cfg.model
    : profile.model !== undefined && adapter === profile.harness ? profile.model : null;
  return { adapter, model, source: override ? 'override' : cfg?.harness ? 'role' : 'workstream' };
}

const profilesDir = (stateDir: string) => join(stateDir, 'profiles');
const fileFor = (stateDir: string, digest: string) => join(profilesDir(stateDir), `${digest}.json`);
const isDigest = (s: string) => /^[0-9a-f]{64}$/.test(s);

/** Guarda el perfil direccionado por contenido. Reimportar el mismo es idempotente. */
export function saveProfile(stateDir: string, raw: unknown): { digest: string; created: boolean } {
  const profile = validateProfile(raw);
  const digest = profileDigest(profile);
  const path = fileFor(stateDir, digest);
  if (existsSync(path)) { loadProfile(stateDir, digest); return { digest, created: false }; } // verifica integridad
  mkdirSync(profilesDir(stateDir), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, canonicalJson(profile) + '\n', { flag: 'wx', mode: 0o444 });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
  return { digest, created: true };
}

/** Carga y re-verifica: el contenido en disco debe producir el digest con el que se pidió. */
export function loadProfile(stateDir: string, digest: string): Profile {
  if (!isDigest(digest)) throw new Error(`digest de perfil inválido: ${digest}`);
  const path = fileFor(stateDir, digest);
  if (!existsSync(path)) throw new Error(`perfil desconocido: ${digest} (impórtalo con fab profile import)`);
  const profile = validateProfile(JSON.parse(readFileSync(path, 'utf8')));
  if (profileDigest(profile) !== digest) throw new Error(`perfil corrupto: ${digest} no coincide con su contenido`);
  return profile;
}

export function listProfiles(stateDir: string): string[] {
  return existsSync(profilesDir(stateDir)) ? readdirSync(profilesDir(stateDir)).filter(f => f.endsWith('.json') && isDigest(f.slice(0, -5))).map(f => f.slice(0, -5)).sort() : [];
}

export const DEFAULT_DIGEST = profileDigest(defaultProfile());

/** Perfil de un workstream: el pinned por digest o el por defecto. */
export function resolveProfile(stateDir: string | undefined, digest: string | null | undefined): { digest: string; profile: Profile } {
  if (!digest || digest === DEFAULT_DIGEST) return { digest: DEFAULT_DIGEST, profile: defaultProfile() };
  if (!stateDir) throw new Error('perfil fijado en un store sin directorio de estado');
  return { digest, profile: loadProfile(stateDir, digest) };
}

/** sha de fab: FAB_SHA si lo fija el empaquetado; si no, el HEAD del checkout del que corre; si no, null. */
let cachedSha: string | null | undefined;
export function fabSha(): string | null {
  if (process.env.FAB_SHA) return process.env.FAB_SHA;
  if (cachedSha !== undefined) return cachedSha;
  try {
    const p = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' });
    return (cachedSha = p.exitCode === 0 ? p.stdout.toString().trim() : null);
  } catch { return (cachedSha = null); }
}
