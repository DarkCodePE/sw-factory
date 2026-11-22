// T110-H4: el origen de una señal lo fija el punto de entrada (web, CLI, Jira); nunca un campo del formulario.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ChangeLinkStore } from '../src/connectors/links.ts';
import { importIssue } from '../src/connectors/intake.ts';
import type { TicketGateway, TicketIssue } from '../src/connectors/types.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-origins-'));
  store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'prueba', goal: 'g', repo: '/repo', requireChangeApproval: false });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const origin = (title: string) => {
  const signal = store.listSignals('prueba').find(s => s.title === title)!;
  return store.getChangeOrigin(store.triageSignal(signal.id).id);
};

test('M40: fab signal add registra origen cli y el actor de FAB_ACTOR', () => {
  const r = Bun.spawnSync(['bun', 'src/cli.ts', 'signal', 'add', 'prueba', 'desde cli'], { env: { ...process.env, FABRICA_HOME: dir, FAB_ACTOR: 'dueño' } });
  expect(r.exitCode).toBe(0);
  expect(origin('desde cli')).toEqual({ source: 'cli', actorId: 'dueño' });
});

test('M41: importar una HU de Jira registra origen jira sin usuario', async () => {
  const issue: TicketIssue = { ref: { system: 'jira', key: 'KAN-1', url: 'https://example.atlassian.net/browse/KAN-1' }, summary: 'HU', description: 'd', status: 'Abierta', issueType: 'Historia', acceptance: '', subtasks: [] };
  const tickets: TicketGateway = { getIssue: async () => issue, comment: async () => { throw new Error('no debe publicar'); } };
  const done = await importIssue(store, new ChangeLinkStore(store.db), tickets, { key: 'KAN-1', workstream: 'prueba', triage: true });
  expect(store.getChangeOrigin(done.changeId!)).toEqual({ source: 'jira', actorId: null });
});

test('M39: un formulario web registra origen web con el usuario del proceso, no el de los campos', async () => {
  const server = startWeb(dir, 0, { write: true });
  try {
    const base = `http://${server.host ?? '127.0.0.1'}:${server.port}`;
    const login = await fetch(server.loginUrl!, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${base}/signals`, { headers: { cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    expect(csrf).toBeTruthy();
    const r = await fetch(`${base}/signals`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: csrf!, workstream: 'prueba', title: 'desde web', body: 'b', source: 'cli', actorId: 'intruso' }),
    });
    expect(r.status).toBe(303);
    expect(origin('desde web')).toEqual({ source: 'web', actorId: userInfo().username });
  } finally { server.stop(true); }
});
