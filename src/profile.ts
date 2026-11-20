// Perfil de instrucciones inmutable, identificado por digest sha256 del JSON canónico.
// Idea: ext/esf/internal/harnessprofile/profile.go@d901657 (MIT); reimplementado, sin copiar código.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_NAMES, MODEL_AGENTS } from './agents.ts';
import { COMMIT_LINE, DEFAULT_WORKER_TEMPLATES, type WorkerTemplates } from './prompts.ts';
import { DEFAULT_VALIDATOR_TEMPLATES, type ValidatorTemplates } from './validators/prompts.ts';

export const ROLES = ['investigate', 'implement', 'code_review', 'security_audit', 'qa'] as const;
export type Role = (typeof ROLES)[number];
export interface RoleConfig { harness?: string; model?: string }

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
}

const MAX_TEMPLATE = 32 * 1024;
const WORKER_KEYS = ['rules', 'investigate', 'implement'];
const VALIDATOR_KEYS = ['rules', 'code_review', 'security_audit', 'qa'];
const TOP_KEYS = ['schemaVersion', 'harness', 'model', 'repo', 'worker', 'validators'];
const TOP_KEYS_V2 = [...TOP_KEYS, 'roles'];
// El primer carácter no puede ser `-`: el modelo viaja como elemento de argv y no debe leerse como flag.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

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

/** Valida esquema y plantillas. Lanza con un mensaje que nombra el campo. */
export function validateProfile(raw: unknown): Profile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('perfil inválido: debe ser un objeto JSON');
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== 1 && o.schemaVersion !== 2) throw new Error('perfil inválido: schemaVersion debe ser 1 o 2');
  const v2 = o.schemaVersion === 2;
  for (const k of Object.keys(o)) if (!(v2 ? TOP_KEYS_V2 : TOP_KEYS).includes(k)) throw new Error(`perfil inválido: clave desconocida ${k}`);
  if (typeof o.harness !== 'string' || !AGENT_NAMES.includes(o.harness)) throw new Error(`perfil inválido: harness debe ser uno de ${AGENT_NAMES.join(', ')}`);
  for (const k of ['model', 'repo'] as const) if (o[k] !== undefined && (typeof o[k] !== 'string' || !o[k])) throw new Error(`perfil inválido: ${k} debe ser un texto no vacío`);
  if (v2) {
    const modelOk = (m: unknown, adapter: string, where: string) => {
      if (m === undefined) return;
      if (typeof m !== 'string' || !MODEL_RE.test(m)) throw new Error(`perfil inválido: ${where} debe cumplir ${MODEL_RE}`);
      if (!MODEL_AGENTS.includes(adapter)) throw new Error(`perfil inválido: ${where}: el adaptador ${adapter} no admite modelo`);
    };
    modelOk(o.model, o.harness, 'model');
    if (o.roles !== undefined) {
      if (!o.roles || typeof o.roles !== 'object' || Array.isArray(o.roles)) throw new Error('perfil inválido: roles debe ser un objeto');
      for (const [role, cfg] of Object.entries(o.roles)) {
        if (!(ROLES as readonly string[]).includes(role)) throw new Error(`perfil inválido: clave desconocida roles.${role}`);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`perfil inválido: roles.${role} debe ser un objeto`);
        const c = cfg as RoleConfig;
        for (const k of Object.keys(c)) if (k !== 'harness' && k !== 'model') throw new Error(`perfil inválido: clave desconocida roles.${role}.${k}`);
        if (c.harness !== undefined && (typeof c.harness !== 'string' || !AGENT_NAMES.includes(c.harness))) throw new Error(`perfil inválido: roles.${role}.harness debe ser uno de ${AGENT_NAMES.join(', ')}`);
        modelOk(c.model, c.harness ?? o.harness, `roles.${role}.model`);
      }
    }
  }
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
