// Definición de un workstream como árbol de ficheros versionable (T59): `fab definition export|import`.
// Una superficie más sobre Store y perfil: no añade reglas. El árbol solo lleva nombres de env/mcp (D-K), nunca valores
// ni rutas del dueño; importar crea un perfil y un workstream en draft nuevos, nunca muta el vigente.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAMES } from './agents.ts';
import { quoteName, readTar, TAR_MAX_BYTES } from './definition-tar.ts';
import { assertRoleMcpRegistered, resolveProfile, saveProfile, validateProfile, type Profile } from './profile.ts';
import { StoreError, type Store } from './store.ts';

const WORKER_KEYS = ['rules', 'investigate', 'implement'] as const;
const VALIDATOR_KEYS = ['rules', 'code_review', 'security_audit', 'qa'] as const;
const SKILL_NAME_RE = /^[\w-]+$/; // la misma regla que la herramienta Skill
const MAX_SKILL = 64 * 1024;
const SETTING_KEYS = ['slug', 'goal', 'agent', 'workerConcurrency', 'taskLimit', 'requireChangeApproval', 'requireApproval', 'protectedPaths', 'verify', 'verifySetup'];

/** argv → línea que `verifierArgv` devuelve a las mismas palabras. */
export function quoteArgv(argv: string[]): string {
  return argv.map(w => {
    if (/^[\w./=:@%+,-]+$/.test(w)) return w;
    if (!w.includes("'")) return `'${w}'`;
    if (/[$`]/.test(w)) throw new StoreError('invalid_input', `el verificador contiene comillas y expansión, no exportable: ${w}`);
    return `"${w.replace(/["\\]/g, '\\$&')}"`;
  }).join(' ');
}

/** Ficheros del árbol: ruta relativa → contenido. */
export function buildDefinition(store: Store, stateDir: string | undefined, slug: string): Map<string, string> {
  const ws = store.getWorkstream(slug);
  const { profile } = resolveProfile(stateDir, ws.profile);
  const files = new Map<string, string>();
  const json = (o: unknown) => JSON.stringify(o, null, 2) + '\n';
  files.set('workstream.json', json({
    slug: ws.slug, goal: ws.goal, agent: ws.agent, workerConcurrency: ws.workerConcurrency, taskLimit: ws.taskLimit,
    requireChangeApproval: ws.requireChangeApproval, requireApproval: ws.requireApproval, protectedPaths: ws.protectedPaths,
    verify: (ws.verify ?? []).map(quoteArgv), verifySetup: (ws.verifySetup ?? []).map(quoteArgv),
  }));
  const { worker, validators, ...rest } = profile;
  files.set('profile/profile.json', json(rest));
  for (const k of WORKER_KEYS) files.set(`profile/worker/${k}.md`, worker[k]);
  for (const k of VALIDATOR_KEYS) files.set(`profile/validators/${k}.md`, validators[k]);
  const dotAgents = join(ws.repo, '.agents');
  const skills = join(dotAgents, 'skills');
  if (existsSync(skills)) {
    try {
      const realRepo = realpathSync(ws.repo);
      const realSkills = realpathSync(skills);
      const isInsideRepo = realSkills.startsWith(realRepo.endsWith('/') ? realRepo : `${realRepo}/`);
      if (isInsideRepo && !lstatSync(dotAgents).isSymbolicLink() && !lstatSync(skills).isSymbolicLink()) {
        for (const name of readdirSync(skills).sort()) {
          const skillDir = join(skills, name);
          if (!SKILL_NAME_RE.test(name) || !existsSync(skillDir) || lstatSync(skillDir).isSymbolicLink() || !lstatSync(skillDir).isDirectory()) continue;
          try {
            const realSkillDir = realpathSync(skillDir);
            if (!realSkillDir.startsWith(realRepo.endsWith('/') ? realRepo : `${realRepo}/`)) continue;
          } catch {
            continue;
          }
          const f = join(skillDir, 'SKILL.md');
          if (!existsSync(f) || lstatSync(f).isSymbolicLink()) continue;
          try {
            const realF = realpathSync(f);
            if (!realF.startsWith(realRepo.endsWith('/') ? realRepo : `${realRepo}/`)) continue;
          } catch {
            continue;
          }
          const text = readFileSync(f, 'utf8');
          if (Buffer.byteLength(text) <= MAX_SKILL) files.set(`skills/${name}/SKILL.md`, text);
        }
      }
    } catch {
      // Ignorar si no se puede resolver la ruta real del repo o de las skills
    }
  }
  // Fail cerrado: ni rutas del dueño ni de la máquina en un árbol que va a un repo.
  for (const [path, text] of files) for (const leak of [ws.repo, homedir(), stateDir].filter((s): s is string => !!s && s.length > 1)) {
    if (text.includes(leak)) throw new StoreError('invalid_input', `${path} contiene una ruta local (${leak}); no se exporta`);
  }
  return files;
}

export function exportDefinition(store: Store, stateDir: string | undefined, slug: string, dir: string): string[] {
  const files = buildDefinition(store, stateDir, slug);
  if (existsSync(dir) && readdirSync(dir).length) throw new StoreError('invalid_input', `${dir} no está vacío`);
  for (const [path, text] of files) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return [...files.keys()];
}

/** Árbol en disco → ruta relativa → texto. Un symlink o cualquier otro tipo de entrada rechaza el árbol. */
function walkDefinition(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        // Antes de leer: ningún fichero admitido pasa de MAX_SKILL, y uno enorme no debe cargarse en memoria para rechazarlo (T105-H7).
        if (lstatSync(join(dir, p)).size > MAX_SKILL) throw new StoreError('invalid_input', `${quoteName(p)} supera ${MAX_SKILL} bytes`);
        files.set(p, readFileSync(join(dir, p), 'utf8'));
      }
      else throw new StoreError('invalid_input', `${p}: solo se admiten ficheros y directorios`); // symlinks fuera
    }
  };
  walk('');
  return files;
}

export type ParsedDefinition = { settings: Record<string, any>; profile: Profile; skills: string[] };

/** Lee y valida el árbol entero sin tocar nada: un directorio o un .tar (T105). */
export function readDefinition(path: string): ParsedDefinition {
  if (existsSync(path) && lstatSync(path).isFile()) {
    if (lstatSync(path).size > TAR_MAX_BYTES) throw new StoreError('invalid_input', `${quoteName(path)} supera ${TAR_MAX_BYTES} bytes`);
    return parseDefinition(readTar(readFileSync(path)));
  }
  if (!existsSync(path) || !lstatSync(path).isDirectory()) throw new StoreError('invalid_input', `${path} no es un directorio`);
  return parseDefinition(walkDefinition(path));
}

/** Valida el contenido (ruta → texto) con las reglas de la CLI. Rechaza cualquier fichero fuera del esquema. */
export function parseDefinition(files: Map<string, string>): ParsedDefinition {
  const found = [...files.keys()];
  const allowed = new Set(['workstream.json', 'profile/profile.json', ...WORKER_KEYS.map(k => `profile/worker/${k}.md`), ...VALIDATOR_KEYS.map(k => `profile/validators/${k}.md`)]);
  const skills: string[] = [];
  for (const p of found) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m && SKILL_NAME_RE.test(m[1]!)) { skills.push(m[1]!); if (Buffer.byteLength(files.get(p)!) > MAX_SKILL) throw new StoreError('invalid_input', `${p} supera ${MAX_SKILL} bytes`); }
    else if (!allowed.has(p)) throw new StoreError('invalid_input', `fichero desconocido en la definición: ${quoteName(p)}`);
  }
  for (const p of allowed) if (!found.includes(p)) throw new StoreError('invalid_input', `falta ${p} en la definición`);
  const read = (p: string) => files.get(p)!;
  const parse = (p: string) => { try { return JSON.parse(read(p)); } catch { throw new StoreError('invalid_input', `${p} no es JSON válido`); } };
  const settings = parse('workstream.json');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new StoreError('invalid_input', 'workstream.json debe ser un objeto');
  for (const k of Object.keys(settings)) if (!SETTING_KEYS.includes(k)) throw new StoreError('invalid_input', `workstream.json: clave desconocida ${k}`);
  if (typeof settings.slug !== 'string' || typeof settings.goal !== 'string') throw new StoreError('invalid_input', 'workstream.json: slug y goal son texto');
  if (settings.agent !== undefined && !AGENT_NAMES.includes(settings.agent)) throw new StoreError('invalid_input', `workstream.json: agent desconocido ${settings.agent}`);
  // Tipos exactos: el Store aplica `valor ?? true`, así que un 0 o un "" bajaría una aprobación sin ser `false` (T105-H1, H5).
  const typed = (k: string, ok: (v: unknown) => boolean, what: string) => { if (settings[k] !== undefined && !ok(settings[k])) throw new StoreError('invalid_input', `workstream.json: ${k} debe ser ${what}`); };
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string');
  for (const k of ['requireChangeApproval', 'requireApproval']) typed(k, v => typeof v === 'boolean', 'true o false');
  for (const k of ['workerConcurrency', 'taskLimit']) typed(k, Number.isInteger, 'un entero');
  for (const k of ['protectedPaths', 'verify', 'verifySetup']) typed(k, strings, 'una lista de textos');
  const raw = parse('profile/profile.json');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new StoreError('invalid_input', 'profile/profile.json debe ser un objeto');
  const profile = (() => {
    try {
      return validateProfile({ ...raw,
        worker: Object.fromEntries(WORKER_KEYS.map(k => [k, read(`profile/worker/${k}.md`)])),
        validators: Object.fromEntries(VALIDATOR_KEYS.map(k => [k, read(`profile/validators/${k}.md`)])) });
    } catch (e) { throw new StoreError('invalid_input', (e as Error).message); }
  })();
  return { settings, profile, skills };
}

/** Crea el perfil y un workstream en draft. Si el slug existe o algo falla, el estado queda como estaba. */
export function importDefinition(store: Store, stateDir: string, dir: string, repo: string, slugOverride?: string): { slug: string; digest: string; skills: string[] } {
  return applyDefinition(store, stateDir, readDefinition(dir), repo, slugOverride);
}

export function applyDefinition(store: Store, stateDir: string, { settings: s, profile, skills }: ParsedDefinition, repo: string, slugOverride?: string): { slug: string; digest: string; skills: string[] } {
  const slug = slugOverride ?? s.slug;
  if (store.listWorkstreams().some(w => w.slug === slug)) throw new StoreError('invalid_input', `el workstream ${slug} ya existe; importar no lo modifica`);
  assertRoleMcpRegistered(stateDir, profile);
  const { digest, created } = saveProfile(stateDir, profile);
  try {
    store.createWorkstream({
      slug, goal: s.goal, repo, agent: s.agent, workerConcurrency: s.workerConcurrency, taskLimit: s.taskLimit,
      requireChangeApproval: s.requireChangeApproval, requireApproval: s.requireApproval,
      protectedPaths: s.protectedPaths, protectNone: Array.isArray(s.protectedPaths) && s.protectedPaths.length === 0 ? true : undefined,
      verify: s.verify, verifySetup: s.verifySetup, profile: digest,
    });
  } catch (e) {
    if (created) rmSync(join(stateDir, 'profiles', `${digest}.json`), { force: true });
    throw e;
  }
  return { slug, digest, skills };
}
