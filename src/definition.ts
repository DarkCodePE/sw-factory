// Definición de un workstream como árbol de ficheros versionable (T59): `fab definition export|import`.
// Una superficie más sobre Store y perfil: no añade reglas. El árbol solo lleva nombres de env/mcp (D-K), nunca valores
// ni rutas del dueño; importar crea un perfil y un workstream en draft nuevos, nunca muta el vigente.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAMES } from './agents.ts';
import { resolveProfile, saveProfile, validateProfile, type Profile } from './profile.ts';
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
  const skills = join(ws.repo, '.agents', 'skills');
  if (existsSync(skills) && !lstatSync(skills).isSymbolicLink()) {
    for (const name of readdirSync(skills).sort()) {
      const skillDir = join(skills, name);
      if (!SKILL_NAME_RE.test(name) || !existsSync(skillDir) || lstatSync(skillDir).isSymbolicLink() || !lstatSync(skillDir).isDirectory()) continue;
      const f = join(skillDir, 'SKILL.md');
      if (!existsSync(f) || lstatSync(f).isSymbolicLink()) continue;
      const text = readFileSync(f, 'utf8');
      if (Buffer.byteLength(text) <= MAX_SKILL) files.set(`skills/${name}/SKILL.md`, text);
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

/** Lee y valida el árbol entero sin tocar nada. Rechaza cualquier fichero fuera del esquema. */
export function readDefinition(dir: string): { settings: Record<string, any>; profile: Profile; skills: string[] } {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new StoreError('invalid_input', `${dir} no es un directorio`);
  const found: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p); else if (e.isFile()) found.push(p);
      else throw new StoreError('invalid_input', `${p}: solo se admiten ficheros y directorios`); // symlinks fuera
    }
  };
  walk('');
  const allowed = new Set(['workstream.json', 'profile/profile.json', ...WORKER_KEYS.map(k => `profile/worker/${k}.md`), ...VALIDATOR_KEYS.map(k => `profile/validators/${k}.md`)]);
  const skills: string[] = [];
  for (const p of found) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(p);
    if (m && SKILL_NAME_RE.test(m[1]!)) { skills.push(m[1]!); if (readFileSync(join(dir, p)).length > MAX_SKILL) throw new StoreError('invalid_input', `${p} supera ${MAX_SKILL} bytes`); }
    else if (!allowed.has(p)) throw new StoreError('invalid_input', `fichero desconocido en la definición: ${p}`);
  }
  for (const p of allowed) if (!found.includes(p)) throw new StoreError('invalid_input', `falta ${p} en la definición`);
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');
  const parse = (p: string) => { try { return JSON.parse(read(p)); } catch { throw new StoreError('invalid_input', `${p} no es JSON válido`); } };
  const settings = parse('workstream.json');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new StoreError('invalid_input', 'workstream.json debe ser un objeto');
  for (const k of Object.keys(settings)) if (!SETTING_KEYS.includes(k)) throw new StoreError('invalid_input', `workstream.json: clave desconocida ${k}`);
  if (typeof settings.slug !== 'string' || typeof settings.goal !== 'string') throw new StoreError('invalid_input', 'workstream.json: slug y goal son texto');
  if (settings.agent !== undefined && !AGENT_NAMES.includes(settings.agent)) throw new StoreError('invalid_input', `workstream.json: agent desconocido ${settings.agent}`);
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
  const { settings: s, profile, skills } = readDefinition(dir);
  const slug = slugOverride ?? s.slug;
  if (store.listWorkstreams().some(w => w.slug === slug)) throw new StoreError('invalid_input', `el workstream ${slug} ya existe; importar no lo modifica`);
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
