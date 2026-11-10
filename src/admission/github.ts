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
  if (last.actor?.type === 'Bot' || login === 'ghost') return { login, role: last.actor?.type === 'Bot' ? 'bot' : 'none' };
  if (!/^[A-Za-z0-9-]+$/.test(login)) throw bad(`actor ${login}`);
  const perm = await ghJson(['gh', 'api', `repos/${repo}/collaborators/${login}/permission`], run);
  if (perm.status === 403) return { login, role: 'unknown' };
  if (perm.status === 404) return { login, role: 'none' };
  if (perm.status !== 200) throw new Error(`gh api falló al leer el permiso de ${login} (HTTP ${perm.status})`);
  const role = (perm.body as { role_name?: unknown })?.role_name;
  if (typeof role !== 'string') throw bad(`permiso de ${login}`);
  return { login, role };
}
