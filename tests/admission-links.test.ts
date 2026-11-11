import { afterEach, expect, test } from 'bun:test';
import { ChangeLinkStore } from '../src/connectors/links.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { dbPath, issue, open, REPO } from './helpers/admission.ts';
import { claimed } from './helpers/live.ts';

const open_ = new Set<{ close(): void }>();
afterEach(() => { open_.forEach(s => s.close()); open_.clear(); });
const track = <T extends { store: { close(): void } }>(x: T): T => { open_.add(x.store); return x; };
const T1 = `github:${REPO}#1`, T2 = `github:${REPO}#2`;
const thread = (adm: any, id: string) => adm.db.query('INSERT OR IGNORE INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(id, `github:${REPO}`, 'x');

test('el primer hilo fija el ExternalRef github del change; el segundo (el PR) se une sin reemplazarlo', () => {
  const { store, adm, change } = claimed(), links = new ThreadLinks(adm);
  thread(adm, T1); thread(adm, T2);
  links.link(T1, change.id); links.link(T2, change.id);
  expect(links.threadsOf(change.id)).toEqual([T1, T2]);
  expect(links.changeOf(T2)).toBe(change.id);
  expect(new ChangeLinkStore(store.db).get(change.id)?.source).toEqual({ system: 'github', key: `${REPO}#1`, url: `https://github.com/${REPO}/issues/1` });
  expect(new ChangeLinkStore(store.db).findBySource('github', `${REPO}#1`)?.changeId).toBe(change.id);
});

test('unir es idempotente, y un hilo no puede pertenecer a dos changes', () => {
  const { store, adm, change } = claimed(), links = new ThreadLinks(adm);
  thread(adm, T1);
  links.link(T1, change.id); links.link(T1, change.id);
  expect(adm.db.query('SELECT COUNT(*) n FROM adm_thread_changes').get()).toEqual({ n: 1 });
  const other = store.triageSignal(store.addSignal('ws', 'otro', 'x').id);
  expect(() => links.link(T1, other.id)).toThrow(/ya está unido/);
});

test('hilo inválido: se rechaza', () => {
  const { adm, change } = claimed();
  expect(() => new ThreadLinks(adm).link('jira:KAN-1', change.id)).toThrow(/hilo inválido/);
});

test('una clave github no choca con las de Jira y dos changes no comparten origen', () => {
  const { store, change } = claimed(), cl = new ChangeLinkStore(store.db);
  cl.setSource(change.id, { system: 'github', key: `${REPO}#9`, url: 'u' });
  const other = store.triageSignal(store.addSignal('ws', 'otro', 'x').id);
  expect(() => cl.setSource(other.id === change.id ? '' : other.id, { system: 'github', key: `${REPO}#9`, url: 'u' })).toThrow(/ya enlazada/);
});

test('un hilo ya admitido no vuelve a admitirse: los triggers siguientes quedan registrados como thread-already-admitted', async () => {
  const issues = [issue(1, '2026-01-01T10:00:00Z', { labels: ['fab'] })];
  const { store, resident } = track(open(dbPath(), {}, issues));
  await resident.run({ once: true });
  const ws = store.createWorkstream({ slug: 'w', goal: 'g', repo: '/tmp/x', agent: 'fake' });
  const change = store.triageSignal(store.addSignal(ws.slug, 't', 'b').id);
  new ThreadLinks(resident.adm).link(T1, change.id);
  issues[0] = issue(1, '2026-01-02T10:00:00Z', { labels: ['fab'] });
  resident.lock.acquire(); await resident.cycle();
  const last = store.db.query("SELECT would_admit w, reasons r FROM adm_decisions WHERE trigger_key LIKE '%#1@2026-01-02%'").get();
  expect(last).toEqual({ w: 0, r: JSON.stringify(['thread-already-admitted', `change:${change.id}`]) });
});

test('los eventos del actor de la fab se descartan (no se dispara a sí misma)', async () => {
  const { store, resident } = track(open(dbPath(), { selfLogin: 'Fab-Bot' }, [issue(1, '2026-01-01T10:00:00Z', { labels: ['fab'], user: { login: 'fab-bot' } })]));
  await resident.run({ once: true });
  expect(store.db.query('SELECT would_admit w, reasons r FROM adm_decisions').get()).toEqual({ w: 0, r: JSON.stringify(['self-authored']) });
});
