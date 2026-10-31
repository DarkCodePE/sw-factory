import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { activityLog, atomicEvidence, gitEvidence, redact, runDirectory, writeManifest } from '../src/manifest.ts';
import { getAgent } from '../src/agents.ts';
import { processActivity } from '../src/pool.ts';
import { commitWorktree, ensureWorktree, GIT_SAFE_FLAGS } from '../src/worktrees.ts';
import { mergeRecoverably } from '../src/validators/publish.ts';

let dir: string, repo: string, store: Store, ws: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-manifest-'));
  repo = join(dir, 'repo');
  Bun.spawnSync(['git', 'init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'base');
  Bun.spawnSync(['git', '-C', repo, 'add', '.']);
  Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=test', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  store = new Store(join(dir, 'fabrica.db'));
  ws = store.createWorkstream({ slug: 'test', goal: 'test', repo, agent: 'fake', requireApproval: false, requireChangeApproval: false }).id;
  store.setWorkstreamState(ws, 'active');
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const manifest = (id: string) => JSON.parse(readFileSync(join(runDirectory(dir, id), 'run.json'), 'utf8'));

for (const status of ['completed', 'failed', 'blocked', 'quarantined', 'canceled']) {
  test(`manifest on terminal transition ${status}`, () => {
    const c = store.createChange(ws, status, '');
    // Exercise the single transition owner, including the future quarantine caller.
    (store as any).setChangeStatus(c.id, status);
    expect(manifest(c.id).status).toBe(status);
    expect(manifest(c.id).activities[0].status).toBe('canceled');
  });
}
test('actual completed activity, blocked reason and exhausted failure write snapshots', () => {
  const c = store.createChange(ws, 'work', '');
  let a = store.claimActivity(ws, 'w')!;
  store.completeActivity(a.id, 'w', 'STATUS: done');
  expect(manifest(c.id).activities[0].status).toBe('completed');
  a = store.claimActivity(ws, 'w')!;
  store.blockActivity(a.id, 'w', 'human reason');
  expect(manifest(c.id).activities.find((x: any) => x.id === a.id).reason).toBe('human reason');
  store.retryChange(c.id);
  for (let i = 0; i < 3; i++) {
    a = store.claimActivity(ws, 'w')!;
    store.failActivity(a.id, 'w', 'failure reason');
  }
  expect(manifest(c.id).status).toBe('failed');
  expect(manifest(c.id).activities.at(-1).retryCount).toBe(3);
});

test('eight secret families disappear from manifest and complete logs', async () => {
  const secrets = [
    'sk-' + 'a'.repeat(30), 'bearer-' + 'b'.repeat(25),
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
    'AKIA' + 'A'.repeat(16), 'ghp_' + 'c'.repeat(30), 'xoxb-' + 'd'.repeat(25),
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature', 'user:password',
  ];
  const text = `STATUS: done\n${secrets[0]}\nAuthorization: Bearer ${secrets[1]}\n${secrets.slice(2,7).join('\n')}\nhttps://${secrets[7]}@example.test\n`;
  const c = store.createChange(ws, 'secrets', '');
  const a = store.claimActivity(ws, 'w')!;
  const fake = getAgent('fake'), original = fake.command;
  const fixture = join(dir, 'output.txt'); writeFileSync(fixture, text + 'L'.repeat(26000) + '\nEND-STDOUT');
  fake.command = () => ['sh', '-c', 'cat "$1"; printf "END-STDERR" >&2', 'fixture', fixture];
  try { await processActivity(store, a, 'w', { workstream: ws, stateDir: dir, log: () => {} }); }
  finally { fake.command = original; }
  const log = readFileSync(activityLog(dir, c.id, a.id), 'utf8');
  const json = readFileSync(join(runDirectory(dir,c.id), 'run.json'), 'utf8');
  for (const secret of secrets) { expect(log).not.toContain(secret); expect(json).not.toContain(secret); }
  expect(log).not.toContain('private-material');
  expect(log).toContain('L'.repeat(26000));
  expect(log).toContain('END-STDOUT'); expect(log).toContain('END-STDERR');
  expect(store.getActivity(a.id).result!.length).toBeLessThanOrEqual(20000);
  expect(manifest(c.id).activities[0].isolation.adapter).toBe('fake');
  expect(redact(text).match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(8);
});

test('atomic writes and evidence path validation', () => {
  const path = join(dir, 'runs', 'atomic.log');
  atomicEvidence(path, 'first'); atomicEvidence(path, 'second');
  expect(readFileSync(path, 'utf8')).toBe('second');
  expect(() => runDirectory(dir, '../escape')).toThrow();
});

async function implemented() {
  const c = store.createChange(ws, 'merge', '');
  let a = store.claimActivity(ws, 'w')!;
  store.completeActivity(a.id, 'w', 'STATUS: done');
  a = store.claimActivity(ws, 'w')!;
  const wt = await ensureWorktree(repo, dir, c.id);
  store.setChangeBranch(c.id, wt.branch); store.setChangeBase(c.id, wt.baseSha);
  writeFileSync(join(wt.path, 'feature.txt'), 'feature');
  await commitWorktree(wt.path, 'feature');
  store.completeActivity(a.id, 'w', 'STATUS: done');
  return { c, wt };
}

test('recover after git merge and after cleanup without repeating merge', async () => {
  const { c, wt } = await implemented();
  const head = gitEvidence(repo, 'rev-parse', wt.branch)!;
  store.event(ws, 'info', `merge_started ${JSON.stringify({ head, branch: wt.branch, target: 'refs/heads/main' })}`, c.id);
  const p = Bun.spawnSync(['git', ...GIT_SAFE_FLAGS, 'merge', '--no-edit', head], { cwd: repo });
  expect(p.exitCode).toBe(0);
  const mergedHead = gitEvidence(repo, 'rev-parse', 'HEAD');
  expect(await mergeRecoverably(store, dir, c.id)).toContain('recuperado');
  expect(store.getChange(c.id).status).toBe('completed');
  expect(manifest(c.id).head).toBe(head);
  expect(manifest(c.id).cleanup).toEqual({worktree:'absent', branch:'absent'});
  await mergeRecoverably(store, dir, c.id);
  expect(gitEvidence(repo, 'rev-parse', 'HEAD')).toBe(mergedHead);
});

test('merge rejects active worker, validators without verdict, and changed target', async () => {
  const { c } = await implemented();
  store.requestValidation(c.id, ['qa']);
  await expect(mergeRecoverably(store, dir, c.id)).rejects.toThrow('validadores');
  const a = store.claimActivity(ws, 'w')!;
  await expect(mergeRecoverably(store, dir, c.id, true)).rejects.toThrow('operación');
  store.completeActivity(a.id, 'w', 'STATUS: done\nVERDICT: pass - fine');
  const head = gitEvidence(repo, 'rev-parse', store.getChange(c.id).branch!)!;
  store.event(ws, 'info', `merge_started ${JSON.stringify({head, branch: store.getChange(c.id).branch, target:'refs/heads/other'})}`, c.id);
  await expect(mergeRecoverably(store, dir, c.id)).rejects.toThrow('destino original');
});

test('canceling an active agent keeps emitted stdout and stderr', async () => {
  const c = store.createChange(ws, 'cancel active', '');
  const a = store.claimActivity(ws, 'w')!;
  const fake = getAgent('fake'), original = fake.command;
  const marker = join(dir, 'started');
  fake.command = () => ['sh', '-c', 'printf "before-cancel"; printf "stderr-before-cancel" >&2; touch "$1"; sleep 60', 'fixture', marker];
  const controller = new AbortController();
  const running = processActivity(store, a, 'w', { workstream: ws, stateDir: dir, log: () => {} }, controller);
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(marker)).toBe(true);
    store.closeChange(c.id, 'canceled');
    controller.abort();
    await running;
    const log = readFileSync(activityLog(dir, c.id, a.id), 'utf8');
    expect(log).toContain('before-cancel'); expect(log).toContain('stderr-before-cancel');
    expect(manifest(c.id).status).toBe('canceled');
    expect(manifest(c.id).activities[0].status).toBe('canceled');
  } finally { controller.abort(); await running; fake.command = original; }
});

test('terminal evidence survives an unavailable repository', () => {
  store.db.query('UPDATE workstreams SET repo = ? WHERE id = ?').run(join(dir, 'unavailable'), ws);
  const c = store.createChange(ws, 'unmounted repo', '');
  store.closeChange(c.id, 'canceled');
  expect(manifest(c.id).status).toBe('canceled');
  expect(manifest(c.id).head).toBeNull();
});
