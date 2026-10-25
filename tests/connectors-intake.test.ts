import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Store } from '../src/store.ts';
import { ChangeLinkStore } from '../src/connectors/links.ts';
import { importIssue, issueToSignal, pullRequestBody, ticketComment } from '../src/connectors/intake.ts';
import type { TicketGateway, TicketIssue } from '../src/connectors/types.ts';

let store: Store;
let links: ChangeLinkStore;
const issue: TicketIssue = { ref: { system: 'jira', key: 'KAN-12', url: 'https://example.atlassian.net/browse/KAN-12' }, summary: 'Prueba de ingreso',
  description: 'Descripción', status: 'Abierta', issueType: 'Historia', acceptance: '- Criterio', subtasks: ['Una subtarea'] };
const tickets: TicketGateway = { getIssue: async () => issue, comment: async () => { throw new Error('No debe publicar'); } };
beforeEach(() => {
  store = new Store(':memory:');
  store.createWorkstream({ slug: 'demo', repo: '/fixture/repo', goal: 'goal', requireChangeApproval: false, requireApproval: false });
  links = new ChangeLinkStore(store.db);
});
afterEach(() => store.close());

test('issue signal preserves acceptance, subtasks and source URL at the end', () => {
  const signal = issueToSignal(issue);
  expect(signal.title).toBe('KAN-12 Prueba de ingreso');
  expect(signal.body).toContain('## Criterios de aceptación\n\n- Criterio');
  expect(signal.body).toContain('- Una subtarea');
  expect(signal.body.endsWith(issue.ref.url)).toBe(true);
});

test('triage import is atomic and idempotent, including concurrent imports', async () => {
  const opts = { key: 'KAN-12', workstream: 'demo', triage: true };
  const [a, b] = await Promise.all([importIssue(store, links, tickets, opts), importIssue(store, links, tickets, opts)]);
  expect(a.changeId).toBe(b.changeId);
  expect([a.reused, b.reused].sort()).toEqual([false, true]);
  expect(store.listSignals('demo')).toHaveLength(1);
  expect(store.listChanges('demo')).toHaveLength(1);
  expect(links.findBySource('jira', issue.ref.key)?.source).toEqual(issue.ref);
  let fetched = false;
  const reused = await importIssue(store, links, { ...tickets, getIssue: async () => { fetched = true; throw new Error('unexpected'); } }, opts);
  expect(reused).toMatchObject({ signalId: a.signalId, changeId: a.changeId, reused: true });
  expect(fetched).toBe(false);
});

test('untriaged signal is reused, then triaged on a later import', async () => {
  const first = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: false });
  expect(first.changeId).toBeUndefined();
  const repeated = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: false });
  expect(repeated).toMatchObject({ signalId: first.signalId, reused: true });
  const triaged = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: true });
  expect(triaged.signalId).toBe(first.signalId);
  expect(triaged.changeId).toBeDefined();
  expect(links.lookup(triaged.changeId!)?.source?.key).toBe(issue.ref.key);
  expect(store.listSignals('demo')).toHaveLength(1);
});

test('failed triage rolls back signal and intake mapping', async () => {
  store.createWorkstream({ slug: 'full', repo: '/fixture/repo', goal: 'goal', taskLimit: 0 });
  await expect(importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'full', triage: true })).rejects.toThrow();
  expect(store.listSignals('full')).toHaveLength(0);
  expect(links.importedSignal(issue.ref.key)).toBeUndefined();
});

test('an imported signal keeps its Jira source when triaged by the generic pipeline', async () => {
  const first = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: false });
  const change = store.triageSignal(first.signalId);
  expect(links.get(change.id)?.source).toEqual(issue.ref);
  expect(links.findBySource('jira', issue.ref.key)?.changeId).toBe(change.id);
  const imported = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: false });
  expect(imported).toEqual({ signalId: first.signalId, changeId: change.id, reused: true });
  expect(links.get(change.id)?.source).toEqual(issue.ref);
});

test('links preserve source and PR independently, enforce source uniqueness, and lookup is bound', () => {
  const change = store.createChange('demo', 't', 'd');
  const second = store.createChange('demo', 't2', 'd');
  const pr = { repo: 'owner/repo', number: 2, url: 'https://github.com/owner/repo/pull/2', branch: 'fab/a', base: 'main' };
  links.setPullRequest(change.id, pr);
  links.setSource(change.id, issue.ref);
  links.setPullRequest(change.id, { ...pr, number: 3 });
  expect(links.get(change.id)?.source).toEqual(issue.ref);
  const lookup = links.lookup;
  expect(lookup(change.id)?.pr?.number).toBe(3);
  expect(() => links.setSource(second.id, issue.ref)).toThrow();
  expect(links.get('missing')).toBeUndefined();
});

test('import source cannot be remapped or stolen from a pending signal', async () => {
  const imported = await importIssue(store, links, tickets, { key: issue.ref.key, workstream: 'demo', triage: false });
  const other = store.createChange('demo', 'another', 'd');
  expect(() => links.setSource(other.id, issue.ref)).toThrow('reservada');
  const change = store.triageSignal(imported.signalId);
  expect(() => links.setSource(change.id, { ...issue.ref, key: 'KAN-99' })).toThrow('no se puede reemplazar');
  expect(links.findBySource('jira', issue.ref.key)?.source?.key).toBe(issue.ref.key);
  expect(links.findBySource('jira', 'KAN-99')).toBeUndefined();
  expect(links.get(other.id)).toBeUndefined();
});

test('PR and ticket bodies include source, truncated investigation and closure marker', () => {
  const change = store.createChange('demo', 'Título "x" $(no)', 'd');
  store.setWorkstreamState('demo', 'active');
  const investigation = store.claimActivity('demo', 'worker')!;
  store.completeActivity(investigation.id, 'worker', 'R'.repeat(4500));
  links.setSource(change.id, issue.ref);
  const pr = { repo: 'owner/repo', number: 2, url: 'https://github.com/owner/repo/pull/2', branch: 'fab/a', base: 'main' };
  links.setPullRequest(change.id, pr);
  const body = pullRequestBody(change, links.get(change.id), store.listActivities({ changeId: change.id }));
  expect(body).toContain(change.title);
  expect(body).toContain(issue.ref.url);
  expect(body).toContain('recortado');
  expect(body).not.toContain('R'.repeat(4001));
  expect(body).toContain(`Cerrado por fab change ${change.id.slice(0, 8)}`);
  for (const kind of ['pr_opened', 'merged', 'status'] as const) expect(ticketComment(kind, change, links.get(change.id)!, 'Extra')).toContain(pr.url);
});
