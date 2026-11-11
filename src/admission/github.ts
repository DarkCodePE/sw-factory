// Poller de issues de GitHub de solo lectura. Usa `gh api` (no `gh issue list`) porque la API REST expone
// `author_association`, que `gh issue list --json` no ofrece. Flags comprobados con `gh api --help` (gh 2.94):
// --paginate --slurp devuelve un array con una página por elemento; `since` es inclusivo y filtra por updated_at.
import { runCommand, validateRepo, type CommandRunner } from '../connectors/github.ts';
import type { Labeler } from './gate.ts';

export type IssueEvent = {
  repo: string; number: number; url: string; state: 'open' | 'closed'; updatedAt: string;
  author: string; authorAssociation: string; labels: string[];
};

const bad = (why: string) => new Error(`Respuesta de GitHub inválida: ${why}`);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export async function pollIssues(repo: string, since: string | undefined, run: CommandRunner = runCommand): Promise<IssueEvent[]> {
  validateRepo(repo);
  if (since !== undefined && !ISO.test(since)) throw new Error('Cursor inválido');
  const cmd = ['gh', 'api', '--paginate', '--slurp', '-X', 'GET', `repos/${repo}/issues`,
    '-f', 'state=all', '-f', 'sort=updated', '-f', 'direction=asc', '-f', 'per_page=100', ...(since ? ['-f', `since=${since}`] : [])];
  let result: Awaited<ReturnType<CommandRunner>>;
  try { result = await run(cmd, process.cwd()); } catch { throw new Error('No se pudo ejecutar gh'); }
  if (result.code !== 0) throw new Error(`gh api falló (código ${result.code})`);
  let pages: unknown;
  try { pages = JSON.parse(result.stdout); } catch { throw bad('no es JSON'); }
  if (!Array.isArray(pages)) throw bad('se esperaba un array de páginas');
  const events: IssueEvent[] = [];
  for (const item of pages.flat()) {
    if (!item || typeof item !== 'object') throw bad('elemento no es un objeto');
    const i = item as Record<string, any>;
    if (i.pull_request) continue; // la API de issues también lista PRs
    if (!Number.isSafeInteger(i.number) || i.number < 1 || typeof i.updated_at !== 'string' || !ISO.test(i.updated_at) ||
      (i.state !== 'open' && i.state !== 'closed') || typeof i.html_url !== 'string' || !Array.isArray(i.labels)) throw bad(`issue ${String(i.number)}`);
    events.push({ repo, number: i.number, url: i.html_url, state: i.state, updatedAt: i.updated_at,
      author: typeof i.user?.login === 'string' ? i.user.login : 'ghost',
      authorAssociation: typeof i.author_association === 'string' ? i.author_association : 'NONE',
      labels: i.labels.map((l: unknown) => typeof l === 'string' ? l : String((l as { name?: unknown })?.name ?? '')).filter(Boolean) });
  }
  return events.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.number - b.number);
}

async function ghJson(cmd: string[], run: CommandRunner): Promise<{ status: number; body: unknown }> {
  let result: Awaited<ReturnType<CommandRunner>>;
  try { result = await run(cmd, process.cwd()); } catch { throw new Error('No se pudo ejecutar gh'); }
  // gh api sale con 1 en un error HTTP y lo indica en stderr como «(HTTP 403)».
  if (result.code !== 0) return { status: Number(/\(HTTP (\d{3})\)/.exec(result.stderr)?.[1] ?? 0), body: null };
  try { return { status: 200, body: JSON.parse(result.stdout) }; } catch { throw bad('no es JSON'); }
}

/**
 * Quién puso la etiqueta `label` en el issue (el último evento `labeled` con ese nombre) y su rol en el repo.
 * Un bot cuenta como rol 'bot'. Si el token no puede ver permisos (403: hace falta acceso push), el rol es 'unknown'.
 * Ambos casos dejan la etiqueta sin verificar. Flags y respuestas comprobados contra la API real (gh 2.94).
 */
export async function labeler(repo: string, issue: number, label: string, run: CommandRunner = runCommand): Promise<Labeler> {
  validateRepo(repo);
  const events = await ghJson(['gh', 'api', '--paginate', '--slurp', `repos/${repo}/issues/${issue}/events?per_page=100`], run);
  if (events.status !== 200) throw new Error(`gh api falló al leer eventos del issue ${issue} (HTTP ${events.status})`);
  if (!Array.isArray(events.body)) throw bad('se esperaba un array de páginas');
  const last = (events.body.flat() as Record<string, any>[]).filter(e =>
    e?.event === 'labeled' && String(e.label?.name ?? '').toLowerCase() === label.toLowerCase()).at(-1);
  // La etiqueta está puesta pero su evento aún no aparece: la API de eventos puede ir con retraso, reintentar.
  if (!last) throw new Error(`issue ${issue}: no se encontró el evento labeled de «${label}»`);
  const login = typeof last.actor?.login === 'string' ? last.actor.login : 'ghost';
  const at = typeof last.created_at === 'string' && ISO.test(last.created_at) ? last.created_at : undefined;
  const renamed = (events.body.flat() as Record<string, any>[]).filter(e => e?.event === 'renamed' && typeof e.created_at === 'string' && ISO.test(e.created_at)).map(e => e.created_at as string).sort().at(-1);
  if (last.actor?.type === 'Bot' || login === 'ghost') return { login, role: last.actor?.type === 'Bot' ? 'bot' : 'none', at, renamedAt: renamed };
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw bad(`actor ${login}`);
  return { login, role: await collaboratorRole(repo, login, run), at, renamedAt: renamed };
}

/** Rol de `login` en el repo (`role_name`); 'unknown' si el token no puede verlo (403), 'none' si no es colaborador (404). */
export async function collaboratorRole(repo: string, login: string, run: CommandRunner = runCommand): Promise<string> {
  validateRepo(repo);
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw bad(`actor ${login}`);
  const perm = await ghJson(['gh', 'api', `repos/${repo}/collaborators/${login}/permission`], run);
  if (perm.status === 403) return 'unknown';
  if (perm.status === 404) return 'none';
  if (perm.status !== 200) throw new Error(`gh api falló al leer el permiso de ${login} (HTTP ${perm.status})`);
  const role = (perm.body as { role_name?: unknown })?.role_name;
  if (typeof role !== 'string') throw bad(`permiso de ${login}`);
  return role;
}

export type CommentEvent = {
  repo: string; number: number; id: number; url: string; author: string; authorType: string; authorAssociation: string;
  createdAt: string; updatedAt: string; body: string;
};

/**
 * Comentarios de issues y PRs del repo, de solo lectura (T21). `since` filtra por updated_at (inclusivo). Cada comentario es
 * un evento con su actor y su id: la identidad es el id del comentario, no el `updated_at` del issue.
 */
export async function pollComments(repo: string, since: string | undefined, run: CommandRunner = runCommand): Promise<CommentEvent[]> {
  validateRepo(repo);
  if (since !== undefined && !ISO.test(since)) throw new Error('Cursor inválido');
  const r = await ghJson(['gh', 'api', '--paginate', '--slurp', '-X', 'GET', `repos/${repo}/issues/comments`,
    '-f', 'sort=updated', '-f', 'direction=asc', '-f', 'per_page=100', ...(since ? ['-f', `since=${since}`] : [])], run);
  if (r.status !== 200) throw new Error(`gh api falló al leer comentarios (HTTP ${r.status})`);
  if (!Array.isArray(r.body)) throw bad('se esperaba un array de páginas');
  const events: CommentEvent[] = [];
  for (const item of (r.body as unknown[]).flat()) {
    if (!item || typeof item !== 'object') throw bad('comentario no es un objeto');
    const c = item as Record<string, any>, number = Number(/\/issues\/(\d+)$/.exec(String(c.issue_url))?.[1]);
    if (!Number.isSafeInteger(c.id) || !Number.isSafeInteger(number) || typeof c.created_at !== 'string' || !ISO.test(c.created_at) ||
      typeof c.updated_at !== 'string' || !ISO.test(c.updated_at) || typeof c.body !== 'string' || typeof c.html_url !== 'string') throw bad(`comentario ${String(c.id)}`);
    events.push({ repo, number, id: c.id, url: c.html_url, body: c.body, createdAt: c.created_at, updatedAt: c.updated_at,
      author: typeof c.user?.login === 'string' ? c.user.login : 'ghost', authorType: typeof c.user?.type === 'string' ? c.user.type : 'User',
      authorAssociation: typeof c.author_association === 'string' ? c.author_association : 'NONE' });
  }
  return events.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id);
}

export type IssueContent = { title: string; body: string; /** `lastEditedAt` de GraphQL: null si nunca se editó. */ lastEditedAt: string | null };

/**
 * Título, cuerpo y última edición del issue (T20). La API REST no expone cuándo se editó el cuerpo, GraphQL sí
 * (`lastEditedAt`); `gh api graphql` es el único camino sin token adicional. [I: que `lastEditedAt` cubra también el
 * título no está comprobado; por eso la admisión compara además el hash del contenido, ver Resident.admit.]
 */
export async function issueContent(repo: string, issue: number, run: CommandRunner = runCommand): Promise<IssueContent> {
  validateRepo(repo);
  const [owner, name] = repo.split('/');
  const r = await ghJson(['gh', 'api', 'graphql', '-f', 'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){title body lastEditedAt}}}',
    '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${issue}`], run);
  if (r.status !== 200) throw new Error(`gh api graphql falló al leer el issue ${issue} (HTTP ${r.status})`);
  const i = (r.body as { data?: { repository?: { issue?: Record<string, unknown> } } })?.data?.repository?.issue;
  if (!i || typeof i.title !== 'string' || typeof i.body !== 'string' || (i.lastEditedAt !== null && (typeof i.lastEditedAt !== 'string' || !ISO.test(i.lastEditedAt)))) throw bad(`contenido del issue ${issue}`);
  return { title: i.title, body: i.body, lastEditedAt: i.lastEditedAt as string | null };
}
