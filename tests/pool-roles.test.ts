import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdmissionDb } from '../src/admission/db.ts';
import { ThreadLinks } from '../src/admission/links.ts';
import { ReportStore } from '../src/admission/reports.ts';
import { savePins } from '../src/agents-verify.ts';
import { activityLog, runDirectory } from '../src/manifest.ts';
import { runPool, type PoolOptions } from '../src/pool.ts';
import { defaultProfile, saveProfile, type Profile } from '../src/profile.ts';
import { confineAgent } from '../src/sandbox/confine.ts';
import { Store } from '../src/store.ts';
import { fakeLive } from './helpers/live.ts';

let dir: string, repo: string, store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-roles-'));
  repo = join(dir, 'repo');
  for (const argv of [['init', '-q', '-b', 'main', repo],
    ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=t@local', 'commit', '-qm', 'init', '--allow-empty']]) {
    expect(Bun.spawnSync(['git', ...argv]).exitCode).toBe(0);
  }
  store = new Store(join(dir, 'fabrica.db'));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const v2 = (roles: Profile['roles']): Profile =>
  ({ ...defaultProfile(), schemaVersion: 2, harness: 'fake', roles });
function setup(profile: Profile, agent = 'fake') {
  const { digest } = saveProfile(dir, profile);
  const ws = store.createWorkstream({ slug: 'roles', goal: 'test', repo, agent, profile: digest,
    requireChangeApproval: false, requireApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Cambio sintético', 'Prueba local');
  const pool = (extra: Partial<PoolOptions> = {}) => runPool(store,
    { workstream: ws.id, stateDir: dir, untilIdle: true, log: () => {}, ...extra });
  const activity = (kind: string) => store.listActivities({ changeId: change.id }).find(a => a.kind === kind)!;
  return { ws, change, pool, activity, digest };
}

function stubBinary(name: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // El stub solo detecta lanzamientos inesperados. Durante la prueba A6 no se ejecuta el argv devuelto.
  writeFileSync(join(bin, name), `#!/bin/sh\nexit ${name === 'bwrap' ? 0 : 97}\n`, { mode: 0o755 });
  return bin;
}

async function withEnv(values: Record<string, string>, run: () => void | Promise<void>) {
  const previous = Object.keys(values).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, values);
  try { await run(); }
  finally {
    for (const [key, val] of previous) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

test('T57d: solo implementación pide m1 y lo deja en Store, metadata, log, evento y fab show', async () => {
  const { pool, change, activity, ws, digest } = setup(v2({ implement: { model: 'm1' } }));
  await pool();
  const inv = activity('investigation'), impl = activity('implementation');
  expect(inv).toMatchObject({ agent: 'fake', model: null, status: 'completed' });
  expect(impl).toMatchObject({ agent: 'fake', model: 'm1', status: 'completed', profileDigest: digest });
  const meta = JSON.parse(readFileSync(join(runDirectory(dir, change.id), impl.id + '.json'), 'utf8'));
  expect(meta).toMatchObject({ adapter: 'fake', model: 'm1' });
  expect(readFileSync(activityLog(dir, change.id, impl.id), 'utf8')).toContain('model=m1');
  expect(store.listEvents(ws.id).filter(e => String(e.message).startsWith('rol ')).map(e => [e.severity, e.message]))
    .toEqual([['info', `rol implement: adaptador fake, modelo m1 (perfil ${digest.slice(0, 8)})`]]);
  const show = Bun.spawnSync([process.execPath, resolve('src/cli.ts'), 'show', change.id], { env: { ...process.env, FABRICA_HOME: dir } });
  expect(show.exitCode).toBe(0);
  expect(show.stdout.toString()).toContain('agent=fake model=m1');
});

test('T57d: v1 conserva el argv y no añade evento de rol', async () => {
  const { pool, change, ws } = setup({ ...defaultProfile(), harness: 'fake', model: 'solo-identidad' });
  await pool();
  for (const a of store.listActivities({ changeId: change.id })) {
    expect(a).toMatchObject({ agent: 'fake', model: null, status: 'completed' });
    expect(readFileSync(activityLog(dir, change.id, a.id), 'utf8')).not.toContain('model=');
  }
  expect(store.listEvents(ws.id).some(e => String(e.message).startsWith('rol '))).toBe(false);
});

test('T57d: --agent gana al rol y descarta el modelo de otro adaptador', async () => {
  const { pool, activity } = setup(v2({ implement: { harness: 'native', model: 'otro' } }));
  await pool({ agentOverride: 'fake' });
  expect(activity('implementation')).toMatchObject({ agent: 'fake', model: null, status: 'completed' });
});

test('T57d A1: un rol no confinable bloquea el trabajo de canal antes de lanzar', async () => {
  const { ws, change, pool, activity } = setup(v2({ implement: { harness: 'native' } }), 'claude');
  const inv = store.claimActivity(ws.id, 'fixture')!;
  store.completeActivity(inv.id, 'fixture', 'spec sintética');
  const adm = new AdmissionDb(store), thread = 'github:demo/t57#1';
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(thread, 'github:demo/t57', 'x');
  new ThreadLinks(adm).link(thread, change.id);
  const backend = fakeLive([], { name: 'native' });
  const bin = stubBinary('bwrap');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir },
    async () => {
      for (const confine of [false, true]) {
        if (confine) store.retryChange(change.id);
        await pool({ live: true, liveBackends: { native: backend }, confine });
        const impl = store.listActivities({ changeId: change.id }).at(-1)!;
        expect(impl).toMatchObject({ kind: 'implementation', status: 'blocked', error: expect.stringContaining('CHANNEL_NOT_CONFINABLE') });
        expect(impl.agent).toBeNull();
        expect(backend.turns).toHaveLength(0);
        expect(adm.db.query('SELECT count(*) AS n FROM adm_sessions').get()).toEqual({ n: 0 });
      }
    });
  expect(activity('investigation').status).toBe('completed');
});

test('T57d A4: un pin distinto bloquea solo el adaptador del rol, salvo aceptación explícita', async () => {
  const { pool, activity, change } = setup(v2({ code_review: { harness: 'codex' } }), 'claude');
  const bin = stubBinary('codex');
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf \'STATUS: done\\n\'\ncase "$PWD" in */worktrees/*) git -c user.name=test -c user.email=t@local commit -qm sintético --allow-empty || true;; esac\n', { mode: 0o755 });
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir }, async () => {
    savePins({ codex: '0'.repeat(64) }, dir);
    await pool();
    expect(activity('implementation')).toMatchObject({ agent: 'claude', status: 'completed' });
    store.requestValidation(change.id, ['code_review']);
    await pool();
    const review = store.listActivities({ changeId: change.id }).at(-1)!;
    expect(review).toMatchObject({ status: 'blocked', agent: null, error: expect.stringContaining('AGENT_BINARY_MISMATCH') });
    store.retryChange(change.id);
    await pool({ acceptAgentBinaries: true });
    expect(store.listActivities({ changeId: change.id }).at(-1)).toMatchObject({ status: 'failed', agent: 'codex', error: expect.stringContaining('exit 97') });
  });
});

test('T57d A6: el modelo resuelto excluye ANTHROPIC_MODEL del entorno confinado', async () => {
  const bin = stubBinary('bwrap');
  // T98-H4(b): el lanzador ya no expone env ni argv; se comprueba lo que de verdad recibe el proceso, con un bwrap que lo vuelca.
  const dump = (name: string) => join(dir, name);
  writeFileSync(join(bin, 'bwrap'), `#!/bin/sh\nprintf '%s\\0' "$@" > ${dump('argv.dump')}\nenv > ${dump('env.dump')}\nexit 0\n`, { mode: 0o755 });
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_MODEL: 'canario-t57' }, async () => {
    for (const model of [undefined, 'm1']) {
      const c = confineAgent('claude', ['sh', ...(model ? ['--model', model] : [])], repo, {}, undefined, undefined, model);
      try {
        expect(c.inspection.envNames.includes('ANTHROPIC_MODEL')).toBe(model === undefined);
        expect(await c.spawn('ignore').exited).toBe(0);
        const env = readFileSync(dump('env.dump'), 'utf8').split('\n');
        expect(env.includes('ANTHROPIC_MODEL=canario-t57')).toBe(model === undefined); // el valor llega solo cuando no hay modelo resuelto
        expect(readFileSync(dump('argv.dump'), 'utf8').includes('canario-t57')).toBe(false); // T72d: ningún valor en argv
      } finally { c.cleanup(); }
    }
  });
});

test('T57d: la rama viva elige el backend resuelto por el rol', async () => {
  const { pool, activity } = setup(v2({ investigate: { harness: 'claude' } }));
  const claude = fakeLive([{ reports: [{ state: 'blocked', summary: 'backend de rol' }] }], { name: 'claude' });
  const fake = fakeLive([]);
  await withEnv({ FABRICA_HOME: dir }, () => pool({ live: true, liveBackends: { claude, fake } }));
  expect(claude.turns).toHaveLength(1);
  expect(fake.turns).toHaveLength(0);
  expect(activity('investigation')).toMatchObject({ agent: 'claude', error: 'backend de rol' });
});

// ---- arreglos tras verificación (T57 verif H1, H4, H5) ----

test('T57 H1: con perfil v1 una activity bloqueada antes de lanzar conserva profile_digest', async () => {
  const { ws, change, pool, digest } = setup({ ...defaultProfile(), harness: 'native' }, 'native');
  const inv = store.claimActivity(ws.id, 'fixture')!;
  store.completeActivity(inv.id, 'fixture', 'spec sintética');
  const adm = new AdmissionDb(store), thread = 'github:demo/t57#2';
  adm.db.query('INSERT INTO adm_threads(id, source, first_seen) VALUES (?,?,?)').run(thread, 'github:demo/t57', 'x');
  new ThreadLinks(adm).link(thread, change.id);
  const bin = stubBinary('bwrap');
  await withEnv({ PATH: `${bin}:${process.env.PATH}`, FABRICA_HOME: dir }, () =>
    pool({ live: true, liveBackends: { native: fakeLive([], { name: 'native' }) } }));
  const impl = store.listActivities({ changeId: change.id }).at(-1)!;
  expect(impl).toMatchObject({ kind: 'implementation', status: 'blocked', error: expect.stringContaining('CHANNEL_NOT_CONFINABLE'), profileDigest: digest });
});

test('T57 H4: un report huérfano conserva la procedencia, y sin agent (fila anterior a T57) usa el adaptador resuelto', async () => {
  for (const legacy of [false, true]) {
    const { change, pool, activity } = setup(v2({}));
    const a = activity('investigation');
    if (!legacy) store.setActivityProvenance(a.id, 'previo', null, { agent: 'claude', model: 'm1' });
    const adm = new AdmissionDb(store);
    new ReportStore(adm).recorder(a.id, 'att-huerfano')({ state: 'blocked', summary: 'huérfano' });
    const backend = fakeLive([]);
    await withEnv({ FABRICA_HOME: dir }, () => pool({ live: true, liveBackends: { fake: backend } }));
    expect(backend.turns).toHaveLength(0);
    const after = store.listActivities({ changeId: change.id }).find(x => x.id === a.id)!;
    const meta = JSON.parse(readFileSync(join(runDirectory(dir, change.id), a.id + '.json'), 'utf8'));
    expect(after).toMatchObject(legacy ? { agent: null, model: null } : { agent: 'claude', model: 'm1' });
    expect(meta).toMatchObject(legacy ? { adapter: 'fake', model: null } : { adapter: 'claude', model: 'm1' });
    store.close(); rmSync(join(dir, 'fabrica.db'), { force: true }); store = new Store(join(dir, 'fabrica.db'));
  }
});

test('T57 H5c: el aislamiento de la metadata sale del adaptador del rol, no del workstream', async () => {
  const { pool, change, activity } = setup(v2({ investigate: { harness: 'fake' }, implement: { harness: 'fake' } }), 'native');
  await pool();
  const impl = activity('implementation');
  const meta = JSON.parse(readFileSync(join(runDirectory(dir, change.id), impl.id + '.json'), 'utf8'));
  expect(meta.adapter).toBe('fake');
  expect(meta.isolation.adapter).toBe('fake');
});
