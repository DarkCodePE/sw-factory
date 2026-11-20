import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProfile, saveProfile, type ScorerDef } from '../src/profile.ts';
import { abortOnSigint, scoreMain } from '../src/scorers-cli.ts';
import { ensureSchema } from '../src/scorers.ts';
import { Store } from '../src/store.ts';

let dir: string, repo: string, store: Store;
const def = (extra: Partial<ScorerDef> = {}): ScorerDef => ({ scope: 'implement', rubric: 'Evalúa.', classes: [{ label: 'ok', score: 1 }, { label: 'mal', score: 0 }], passing: 0.5, sampling: 1, ...extra });

function seed(scorers: Record<string, ScorerDef>, slug = 'ws') {
  const digest = saveProfile(dir, { ...defaultProfile(), schemaVersion: 2, harness: 'fake', scorers } as any).digest;
  const ws = store.createWorkstream({ slug, goal: 'g', repo, agent: 'fake', requireChangeApproval: false, profile: digest });
  const c = store.createChange(slug, 'Título', 'Descripción');
  const inv = store.listActivities({ changeId: c.id })[0]!;
  const impl = (store as any).insertActivity(ws.id, c.id, inv.id, 'implementation', 'pending', null);
  const implId = impl.id ?? impl;
  for (const id of [inv.id, implId]) store.db.query(`UPDATE activities SET status='completed', result='r', profile_digest=?, completed_at=?, started_at=? WHERE id=?`).run(digest, store.now(), store.now(), id);
  return { ws, c, inv, implId: implId as string };
}
async function cli(...argv: string[]) {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const code = await scoreMain(argv, store, dir);
    return { code, out: log.mock.calls.map((c) => c.join(' ')).join('\n'), err: err.mock.calls.map((c) => c.join(' ')).join('\n') };
  } finally { log.mockRestore(); err.mockRestore(); }
}
const rows = () => store.db.query('SELECT * FROM scores ORDER BY created_at, id').all() as any[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-scorers-cli-'));
  repo = join(dir, 'repo');
  mkdirSync(repo);
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  store = new Store(join(dir, 'f.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

test('run --once sin jueces en el perfil: sale con 0 y no crea filas', async () => {
  seed({});
  const r = await cli('run', 'ws', '--once');
  expect(r.code).toBe(0);
  expect(rows()).toHaveLength(0);
});

test('add sobre una activity no terminada: invalid_transition', async () => {
  const { implId } = seed({ j: def() });
  store.db.query(`UPDATE activities SET status='running' WHERE id=?`).run(implId);
  const r = await cli('add', implId, '--scorer', 'j');
  expect(r.code).toBe(1);
  expect(r.err).toContain('invalid_transition');
  expect(rows()).toHaveLength(0);
});

test('add encola con origin manual y no ejecuta', async () => {
  const { implId } = seed({ j: def() });
  expect((await cli('add', implId, '--scorer', 'j')).code).toBe(0);
  expect(rows().map((x) => [x.status, x.origin])).toEqual([['pending', 'manual']]);
});

test('list: «sin puntuar» para NULL y la explicación solo sale con --json (A6)', async () => {
  const { ws, c, implId } = seed({ j: def() });
  await cli('add', implId, '--scorer', 'j');
  store.db.query(`UPDATE scores SET rationale='EXPLICACION-NO-CONFIABLE'`).run();
  const text = await cli('list', 'ws');
  expect(text.out).toContain('sin puntuar');
  expect(text.out).not.toContain('EXPLICACION');
  expect((await cli('list', 'ws', '--change', c.id)).out).toContain('sin puntuar');
  expect((await cli('list', 'ws', '--change', 'otro')).out).toBe('');
  expect((await cli('list', 'ws', '--json')).out).toContain('EXPLICACION-NO-CONFIABLE');
  expect(ws.id).toBeTruthy();
});

test('backfill sin --yes: vista previa con nº de ejecuciones y «No medido»; no encola nada', async () => {
  seed({ j: def(), k: def({ scope: 'investigate' }) });
  const r = await cli('backfill', 'ws');
  expect(r.code).toBe(0);
  expect(r.out).toContain('2 ejecuciones');
  expect(r.out).toContain('No medido');
  expect(r.out).toContain('repite con --yes');
  expect(store.db.query("SELECT 1 FROM sqlite_master WHERE name='scores'").get()).toBeNull();
});

test('backfill: el coste estimado sale del historial del juez y --yes encola como backfill', async () => {
  const { implId } = seed({ j: def() });
  const done = seed({ j: def() }, 'otro');
  ensureSchema(store.db);
  store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, cost_usd, created_at)
    VALUES ('h','j','x','implement','h','h','h',0,'sample','done',0.25,'t')`).run();
  const p = await cli('backfill', 'ws');
  expect(p.out).toContain('1 ejecuciones sin puntuar, coste estimado $0.2500');
  expect(rows().filter((x) => x.origin === 'backfill')).toHaveLength(0);
  const y = await cli('backfill', 'ws', '--yes');
  expect(y.out).toContain('1 encoladas');
  expect(rows().filter((x) => x.origin === 'backfill').map((x) => [x.subject_activity_id, x.status])).toEqual([[implId, 'pending']]);
  // Las ya puntuadas o en cola se saltan: repetir no encola más, y no toca otros workstreams.
  expect((await cli('backfill', 'ws', '--yes')).out).toContain('0 ejecuciones');
  expect(rows().filter((x) => x.workstream_id === done.ws.id)).toHaveLength(0);
});

test('backfill respeta --scorer y --since', async () => {
  seed({ j: def(), k: def() });
  expect((await cli('backfill', 'ws', '--scorer', 'k')).out).toContain('1 ejecuciones');
  expect((await cli('backfill', 'ws', '--since', '2999-01-01')).out).toContain('0 ejecuciones');
});

test('argumentos inválidos: error claro y salida 1', async () => {
  seed({ j: def() });
  expect((await cli('run', 'ws', '--once', '--max', '0')).err).toContain('--max');
  expect((await cli('run', 'ws', '--agent', 'nope')).err).toContain('unknown agent');
  expect((await cli('nada')).code).toBe(1);
  expect((await cli('add', 'x')).err).toContain('--scorer');
});

test('H1: SIGINT aborta y el manejador sobrevive al primer Ctrl-C; al soltar no queda ninguno', () => {
  // Se compara por identidad: el runner de tests puede tener sus propios manejadores de SIGINT (en la CI, de un solo uso).
  const before = new Set(process.listeners('SIGINT'));
  const ac = new AbortController();
  const dispose = abortOnSigint(ac);
  const mine = process.listeners('SIGINT').filter(l => !before.has(l));
  expect(mine.length).toBe(1);
  const h = mine[0]!;
  process.emit('SIGINT');
  expect(ac.signal.aborted).toBe(true);
  // Con `once` el segundo Ctrl-C no tendría manejador y mataría el proceso sin pasar por el finally de judge.
  expect(process.listeners('SIGINT')).toContain(h);
  dispose();
  expect(process.listeners('SIGINT')).not.toContain(h);
});

test('H2: si a algún juez le falta historial, el total es «No medido», no una suma parcial', async () => {
  seed({ j: def(), k: def({ scope: 'investigate' }) });
  ensureSchema(store.db);
  const hist = (id: string, status: string, cost: number) => store.db.query(`INSERT INTO scores (id, scorer, profile_digest, scope, subject_activity_id, change_id, workstream_id, round, origin, status, cost_usd, created_at)
    VALUES (?,'j','x','implement',?,'h','h',0,'sample',?,?,'t')`).run(id, id, status, cost);
  hist('h1', 'done', 0.25);
  hist('h2', 'failed', 9); // una fila fallida no cuenta para la media (D10)
  const out = (await cli('backfill', 'ws')).out;
  expect(out).toContain('2 ejecuciones sin puntuar, coste estimado No medido');
  expect(out).toContain('j: 1 × $0.2500');
  expect(out).toContain('k: 1 × No medido');
});

test('H2: sin historial de ningún juez, el total no es 0', async () => {
  seed({ j: def() });
  expect((await cli('backfill', 'ws')).out).toContain('coste estimado No medido');
});

test('H3: list no enseña filas de otro workstream (D5)', async () => {
  const a = seed({ j: def() });
  const b = seed({ j: def() }, 'otro');
  await cli('add', a.implId, '--scorer', 'j');
  await cli('add', b.implId, '--scorer', 'j');
  const out = (await cli('list', 'ws')).out;
  expect(out).toContain(a.c.id);
  expect(out).not.toContain(b.c.id);
});

test('H3: run sin --once termina al abortar la señal (D11)', async () => {
  seed({});
  const ac = new AbortController();
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    const t = scoreMain(['run', 'ws'], store, dir, ac.signal);
    setTimeout(() => ac.abort(), 0);
    expect(await t).toBe(0);
  } finally { log.mockRestore(); }
});
