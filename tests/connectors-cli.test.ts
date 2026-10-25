import { afterEach, expect, test } from 'bun:test';
import { Store, type Change } from '../src/store.ts';
import { connectorsMain, type ConnectorDeps } from '../src/connectors/cli.ts';
import { ChangeLinkStore } from '../src/connectors/links.ts';
import type { CommandRunner } from '../src/connectors/github.ts';
import { createGhGateway } from '../src/connectors/github.ts';
import type { PullRequestRef, TicketIssue } from '../src/connectors/types.ts';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const issue: TicketIssue = { ref: { system: 'jira', key: 'KAN-12', url: 'https://example.atlassian.net/browse/KAN-12' },
  summary: 'Título "citado" $(no-ejecutar)', description: 'Descripción\ncon saltos', status: 'Abierta', issueType: 'Historia', subtasks: [] };
function fixture() {
  const store = new Store(':memory:');
  stores.push(store);
  store.createWorkstream({ slug: 'demo', goal: 'g', repo: '/fixture/repo', requireApproval: false, requireChangeApproval: false });
  store.setWorkstreamState('demo', 'active');
  const links = new ChangeLinkStore(store.db);
  const output: string[] = [];
  const errors: string[] = [];
  const reads: string[][] = [];
  const opened: unknown[] = [];
  const comments: string[] = [];
  const run: CommandRunner = async cmd => {
    reads.push(cmd);
    if (cmd.slice(0, 4).join(' ') === 'git remote get-url origin') return { code: 0, stdout: 'git@github.com:owner/project.git\n', stderr: '' };
    if (cmd[0] === 'git' && cmd[1] === 'rev-list') return { code: 0, stdout: '2\n', stderr: '' };
    throw new Error(`Unexpected write or command: ${JSON.stringify(cmd)}`);
  };
  const deps: ConnectorDeps = { store, links, env: {}, run, log: s => output.push(s), error: s => errors.push(s),
    tickets: { getIssue: async () => issue, comment: async (_key, body) => { comments.push(body); } },
    prs: { find: async () => { throw new Error('Unexpected PR read'); }, comment: async () => { throw new Error('Unexpected PR comment'); },
      open: async input => { opened.push(input); return { repo: input.repo, number: 3, url: `https://github.com/${input.repo}/pull/3`, branch: input.branch, base: input.base }; } } };
  return { store, links, output, errors, reads, opened, comments, deps };
}
function implemented(store: Store, change?: Change): Change {
  change ??= store.createChange('demo', issue.summary, issue.description);
  const investigation = store.claimActivity('demo', 'worker')!;
  store.completeActivity(investigation.id, 'worker', 'Investigación de prueba\nSTATUS: done');
  const implementation = store.claimActivity('demo', 'worker')!;
  store.completeActivity(implementation.id, 'worker', 'STATUS: done');
  store.setChangeBranch(change.id, `fab/${change.id.slice(0, 8)}`);
  return store.getChange(change.id);
}

test('Jira show and import dry-run only read issue, without local or remote writes', async () => {
  const f = fixture();
  expect(await connectorsMain('jira', ['show', issue.ref.key], f.deps)).toBe(0);
  expect(await connectorsMain('jira', ['import', issue.ref.key, '--ws', 'demo', '--triage', '--dry-run'], f.deps)).toBe(0);
  expect(f.output.join('\n')).toContain('signal → change');
  expect(f.output.join('\n')).toContain(issue.ref.url);
  expect(f.store.listSignals('demo')).toHaveLength(0);
  expect(f.store.listChanges('demo')).toHaveLength(0);
  expect(f.comments).toHaveLength(0);
  expect(f.reads).toHaveLength(0);
});

test('Jira import → change → implementation → PR → HU comment uses only fake gateways', async () => {
  const f = fixture();
  expect(await connectorsMain('jira', ['import', issue.ref.key, '--ws', 'demo', '--triage'], f.deps)).toBe(0);
  const change = implemented(f.store, f.store.listChanges('demo')[0]!);
  expect(await connectorsMain('pr', ['open', change.id.slice(0, 8), '--draft'], f.deps)).toBe(0);
  expect(f.opened).toHaveLength(1);
  expect((f.opened[0] as any).body).toContain('Investigación de prueba');
  expect((f.opened[0] as any).title).toBe(`${issue.ref.key} ${issue.summary}`);
  expect((f.opened[0] as any).draft).toBe(true);
  expect(f.comments[0]).toContain('https://github.com/owner/project/pull/3');
  expect(f.links.get(change.id)?.pr?.number).toBe(3);
  expect(await connectorsMain('pr', ['show', change.id], f.deps)).toBe(0);
  expect(f.output.join('\n')).toContain(`HU: ${issue.ref.key}`);
  expect(await connectorsMain('jira', ['comment', change.id], f.deps)).toBe(0);
  expect(f.comments[1]).toContain('Estado: implemented');
});

test('pr open rejects nonimplemented, missing branch, and zero commits before publishing', async () => {
  const f = fixture();
  const initial = f.store.createChange('demo', 'title', 'description');
  expect(await connectorsMain('pr', ['open', initial.id], f.deps)).toBe(1);
  expect(f.errors.at(-1)).toContain('debe estar implemented');
  expect(f.reads).toHaveLength(0);
  const change = implemented(f.store, initial);
  f.store.db.query('UPDATE changes SET branch=NULL WHERE id=?').run(change.id);
  expect(await connectorsMain('pr', ['open', change.id], f.deps)).toBe(1);
  expect(f.errors.at(-1)).toContain('no tiene una rama');
  f.store.setChangeBranch(change.id, change.branch!);
  expect(await connectorsMain('pr', ['open', change.id, '--repo', 'owner/project'], { ...f.deps,
    run: async () => ({ code: 0, stdout: '0', stderr: '' }) })).toBe(1);
  expect(f.errors.at(-1)).toContain('no tiene commits propios');
  expect(f.opened).toHaveLength(0);
});

test('PR dry-run preserves body and calls no writing runner or gateway', async () => {
  const f = fixture();
  const change = implemented(f.store);
  f.links.setSource(change.id, issue.ref);
  expect(await connectorsMain('pr', ['open', change.id, '--dry-run'], f.deps)).toBe(0);
  expect(f.opened).toHaveLength(0);
  expect(f.comments).toHaveLength(0);
  expect(f.links.get(change.id)?.pr).toBeUndefined();
  expect(f.reads.every(cmd => ['remote', 'rev-list'].includes(cmd[1]!))).toBe(true);
  expect(f.output.join('\n')).toContain('$(no-ejecutar)');
  expect(f.output.join('\n')).toContain('Cerrado por fab change');
  expect(await connectorsMain('jira', ['comment', change.id, '--dry-run'], f.deps)).toBe(0);
  expect(f.comments).toHaveLength(0);
});

test('persist PR before Jira comment, then reuse it on retry after comment failure', async () => {
  const f = fixture();
  const change = implemented(f.store);
  f.links.setSource(change.id, issue.ref);
  let attempts = 0;
  f.deps.tickets = { getIssue: async () => issue, comment: async () => {
    expect(f.links.get(change.id)?.pr?.number).toBe(3);
    if (++attempts === 1) throw new Error('Fallo simulado del comentario');
  } };
  expect(await connectorsMain('pr', ['open', change.id], f.deps)).toBe(1);
  expect(f.links.get(change.id)?.pr?.number).toBe(3);
  expect(await connectorsMain('pr', ['open', change.id], f.deps)).toBe(0);
  expect(f.opened).toHaveLength(2);
  expect(attempts).toBe(2);
});

test('linked PR still pushes updated branch and reuses remote PR without create', async () => {
  const f = fixture();
  const change = implemented(f.store);
  const pr: PullRequestRef = { repo: 'owner/project', number: 4, url: 'https://github.com/owner/project/pull/4', branch: change.branch!, base: 'main' };
  f.links.setPullRequest(change.id, pr);
  const writes: string[][] = [];
  f.deps.prs = createGhGateway({ run: async cmd => {
    writes.push(cmd);
    if (cmd[0] === 'git' && cmd[1] === 'push') return { code: 0, stdout: '', stderr: '' };
    if (cmd.includes('view')) return { code: 0, stdout: JSON.stringify({ number: pr.number, url: pr.url, headRefName: pr.branch, baseRefName: pr.base, state: 'OPEN' }), stderr: '' };
    throw new Error('No debe crear otro PR');
  } });
  expect(await connectorsMain('pr', ['open', change.id, '--repo', pr.repo], f.deps)).toBe(0);
  expect(f.opened).toHaveLength(0);
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]?.[1]).toBe('rev-list');
  expect(writes[0]).toEqual(['git', 'push', '-u', 'origin', change.branch!]);
  expect(writes.some(cmd => cmd.includes('create'))).toBe(false);
  expect(f.links.get(change.id)?.pr?.number).toBe(4);
});

test('bad CLI inputs and missing credentials fail before outbound mutations', async () => {
  const f = fixture();
  for (const argv of [['import', 'KAN-12'], ['show', '../KAN-12'], ['show', 'KAN-12', '--triage'], ['unknown', 'KAN-12']]) {
    expect(await connectorsMain('jira', argv, f.deps)).toBe(1);
  }
  const change = implemented(f.store);
  expect(await connectorsMain('jira', ['comment', change.id], f.deps)).toBe(1);
  expect(f.errors.at(-1)).toContain('no tiene una HU');
  f.links.setSource(change.id, issue.ref);
  expect(await connectorsMain('pr', ['open', change.id], { ...f.deps, tickets: undefined, env: { JIRA_ENV_FILE: '/no-such-fixture.env' } })).toBe(1);
  expect(f.opened).toHaveLength(0);
});

test('top-level CLI dispatch exposes connector help without external I/O', async () => {
  for (const command of ['jira', 'pr']) {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', command, '--help'], { cwd: import.meta.dir + '/..', stdout: 'pipe', stderr: 'pipe' });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(out).toContain('Conectores SDLC de fab');
  }
});
