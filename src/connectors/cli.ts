import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store, StoreError, type Change } from '../store.ts';
import { createGhGateway, repoSlugFromRemote, runCommand, validateBranch, validateRepo, type CommandRunner } from './github.ts';
import { createJiraGateway, loadJiraEnv, validateJiraKey } from './jira.ts';
import { ChangeLinkStore } from './links.ts';
import { importIssue, issueToSignal, pullRequestBody, ticketComment } from './intake.ts';
import { VALIDATOR_KINDS, type PullRequestGateway, type TicketGateway } from './types.ts';

export interface ConnectorDeps {
  store?: Store;
  links?: ChangeLinkStore;
  tickets?: TicketGateway;
  prs?: PullRequestGateway;
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  cwd?: string;
  stateDir?: string;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

const HELP = `Conectores SDLC de fab
  fab jira show <KEY>
  fab jira import <KEY> --ws <slug> [--triage] [--dry-run]
  fab jira comment <changeId> [--dry-run]
  fab pr open <changeId> [--base main] [--draft] [--repo owner/name] [--validate] [--dry-run]
  fab pr show <changeId>

--dry-run muestra los comandos y cuerpos sin publicar ni modificar signals o enlaces.`;

export async function connectorsMain(cmd: 'jira' | 'pr', argv: string[], deps: ConnectorDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stateDir = deps.stateDir ?? resolve(env.FABRICA_HOME ?? resolve(env.HOME ?? '.', '.fabrica'));
  const run = deps.run ?? runCommand;
  let ownedStore: Store | undefined;
  let store = deps.store;
  let links = deps.links;
  let tickets = deps.tickets;
  let prs = deps.prs;
  try {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs({ args: argv, allowPositionals: true, options: {
        ws: { type: 'string' }, triage: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
        base: { type: 'string' }, draft: { type: 'boolean' }, repo: { type: 'string' }, validate: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      } });
    } catch { throw new Error(`Argumentos inválidos.\n${HELP}`); }
    const { values, positionals } = parsed;
    if (values.help || !positionals.length) { log(HELP); return 0; }
    const [action, id] = positionals;
    const valid = cmd === 'jira' ? ['show', 'import', 'comment'] : ['show', 'open'];
    if (!valid.includes(action!) || !id || positionals.length !== 2) throw new Error(`Uso inválido.\n${HELP}`);
    const allowed = action === 'import' ? ['ws', 'triage', 'dry-run'] : action === 'open' ? ['base', 'draft', 'repo', 'validate', 'dry-run'] : action === 'comment' ? ['dry-run'] : [];
    if (Object.keys(values).some(key => !allowed.includes(key))) throw new Error(`Opciones incompatibles con ${cmd} ${action}`);
    const dry = values['dry-run'] === true;
    function getStore(): Store {
      if (!store) {
        const path = resolve(stateDir, 'fabrica.db');
        if (dry && !existsSync(path)) throw new Error('No existe una base local para consultar el change');
        if (!dry) mkdirSync(stateDir, { recursive: true });
        store = ownedStore = new Store(path);
      }
      return store;
    }
    function getLinks(create = false): ChangeLinkStore | undefined {
      if (!links) {
        const db = getStore().db;
        if (create || db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='change_links'").get()) links = new ChangeLinkStore(db);
      }
      return links;
    }
    function getTickets(): TicketGateway {
      return tickets ??= createJiraGateway(loadJiraEnv(env, cwd));
    }
    function getPrs(): PullRequestGateway { return prs ??= createGhGateway({ run }); }
    function changeByPrefix(prefix: string): Change {
      const db = getStore();
      const matches = db.listWorkstreams().flatMap(w => db.listChanges(w.id)).filter(c => c.id.startsWith(prefix));
      if (matches.length !== 1) throw new Error(`Change ${prefix}: se esperaba una coincidencia y hay ${matches.length}`);
      return matches[0]!;
    }
    async function readGit(args: string[], repoCwd: string): Promise<string> {
      try {
        const result = await run(['git', ...args], repoCwd);
        if (result.code === 0) return result.stdout.trim();
      } catch { /* Do not relay command diagnostics that may contain remote credentials. */ }
      throw new Error(`No se pudo leer Git (${args[0]}) en el repositorio del workstream`);
    }

    if (cmd === 'jira' && (action === 'show' || action === 'import')) {
      validateJiraKey(id);
      if (action === 'import' && (typeof values.ws !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(values.ws))) throw new Error('Falta --ws <slug> válido para importar la HU');
      if (action === 'show' || dry) {
        const issue = await getTickets().getIssue(id);
        const signal = issueToSignal(issue);
        log(`${dry ? 'DRY-RUN · ' : ''}${signal.title}\nEstado: ${issue.status}\nTipo: ${issue.issueType}\n\n${signal.body}`);
        if (dry) log(`Destino: workstream ${values.ws}; ${values.triage ? 'signal → change' : 'signal (sin triage)'}`);
      } else {
        const result = await importIssue(getStore(), getLinks(true)!, getTickets(), { key: id, workstream: values.ws as string, triage: values.triage === true });
        log(`${result.reused ? 'HU reutilizada' : 'HU importada'}: signal ${result.signalId.slice(0, 8)}${result.changeId ? ` → change ${result.changeId.slice(0, 8)}` : ''}`);
      }
      return 0;
    }
    const change = changeByPrefix(id);
    const linked = getLinks()?.get(change.id);
    if (cmd === 'pr' && action === 'show') {
      log(linked?.pr ? `PR: ${linked.pr.url}` : 'Sin PR enlazado');
      log(linked?.source ? `HU: ${linked.source.key} · ${linked.source.url}` : 'Sin HU de origen');
      return 0;
    }
    if (cmd === 'jira' && action === 'comment') {
      if (!linked?.source) throw new Error('El change no tiene una HU Jira enlazada');
      const body = ticketComment('status', change, linked);
      if (dry) log(`DRY-RUN · comentario en ${linked.source.key}\n${body}`);
      else { await getTickets().comment(linked.source.key, body); log(`Comentario publicado en ${linked.source.key}`); }
      return 0;
    }
    if (change.status !== 'implemented') throw new Error(`El change debe estar implemented; estado actual: ${change.status}`);
    if (!change.branch) throw new Error('El change no tiene una rama de implementación');
    const base = typeof values.base === 'string' ? values.base : 'main';
    validateBranch(change.branch); validateBranch(base);
    const ws = getStore().getWorkstream(change.workstreamId);
    const repo = typeof values.repo === 'string' ? values.repo : repoSlugFromRemote(await readGit(['remote', 'get-url', 'origin'], ws.repo));
    if (!repo) throw new Error('El remoto origin no es GitHub; indica --repo owner/name');
    validateRepo(repo);
    const commits = await readGit(['rev-list', '--count', `${base}..${change.branch}`], ws.repo);
    if (!/^\d+$/.test(commits) || Number(commits) < 1) throw new Error(`La rama ${change.branch} no tiene commits propios frente a ${base}`);
    const body = pullRequestBody(change, linked, getStore().listActivities({ changeId: change.id }));
    if (dry) {
      log(`DRY-RUN · ${JSON.stringify(['git', 'push', '-u', 'origin', change.branch])}`);
      log(`DRY-RUN · ${JSON.stringify(['gh', 'pr', 'view', change.branch, '--repo', repo, '--json', 'number,url,headRefName,baseRefName,state'])}`);
      log(`DRY-RUN · si no existe: ${JSON.stringify(['gh', 'pr', 'create', '--repo', repo, '--head', change.branch, '--base', base, '--title', change.title, '--body-file', '<archivo temporal>', ...(values.draft ? ['--draft'] : [])])}\n${body}`);
      if (linked?.source) log(`DRY-RUN · comentario en ${linked.source.key}: enlace al PR resultante\n${ticketComment('pr_opened', change, linked, 'PR: <URL resultante>')}`);
      if (values.validate) log(`DRY-RUN · encolaría validadores: ${VALIDATOR_KINDS.join(', ')}`);
      return 0;
    }
    // Resolve Jira credentials before pushing, but publish only after persisting the PR.
    if (linked?.source) getTickets();
    const pr = await getPrs().open({ cwd: ws.repo, repo, branch: change.branch, base, title: change.title, body, draft: values.draft === true });
    if (pr.repo !== repo || pr.branch !== change.branch) throw new Error('El PR recibido no corresponde al change');
    getLinks(true)!.setPullRequest(change.id, pr);
    if (linked?.source) await getTickets().comment(linked.source.key, ticketComment('pr_opened', change, { ...linked, pr }));
    log(`PR enlazado: ${pr.url}${linked?.source ? ` · HU ${linked.source.key} comentada` : ''}`);
    if (values.validate) {
      const queued = getStore().requestValidation(change.id, [...VALIDATOR_KINDS]);
      log(`Validadores encolados: ${queued.length} (${VALIDATOR_KINDS.join(', ')}); ejecútalos con fab run`);
    }
    return 0;
  } catch (err) {
    const message = err instanceof StoreError ? ({ not_found: 'No se encontró el recurso local solicitado', invalid_transition: 'Transición local no permitida', conflict: 'El estado local cambió; vuelve a consultar', limit_reached: 'El workstream alcanzó su límite de changes', invalid_input: 'Entrada local inválida' }[err.code]) : err instanceof Error ? err.message : 'Error de conector';
    error(`error: ${message}`);
    return 1;
  } finally { ownedStore?.close(); }
}
