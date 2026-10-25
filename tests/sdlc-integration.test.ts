import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Change } from '../src/store.ts';
import { connectorsMain, type ConnectorDeps } from '../src/connectors/cli.ts';
import { ChangeLinkStore } from '../src/connectors/links.ts';
import { mergeBlocker } from '../src/validators/publish.ts';

const stores: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function implementedChange(store: Store): Change {
  store.createWorkstream({ slug: 'demo', goal: 'g', repo: '/fixture/repo', requireApproval: false, requireChangeApproval: false });
  store.setWorkstreamState('demo', 'active');
  const change = store.createChange('demo', 'title', 'description');
  for (const result of ['Investigación\nSTATUS: done', 'STATUS: done']) {
    const a = store.claimActivity('demo', 'worker')!;
    store.completeActivity(a.id, 'worker', result);
  }
  store.setChangeBranch(change.id, `fab/${change.id.slice(0, 8)}`);
  return store.getChange(change.id);
}

function finishNext(store: Store, verdict: string): void {
  const a = store.claimActivity('demo', 'worker')!;
  expect(a.validator).not.toBeNull();
  store.completeActivity(a.id, 'worker', `STATUS: done\nVERDICT: ${verdict}\n\nResumen ${verdict}.`);
}

test('merge gate: unvalidated passes, pending and fail block, needs_human and pass allow', () => {
  const store = new Store(':memory:');
  stores.push(store);
  const change = implementedChange(store);
  expect(mergeBlocker(store.validationSummary(change.id))).toBeUndefined();

  store.requestValidation(change.id, ['code_review', 'security_audit', 'qa']);
  expect(mergeBlocker(store.validationSummary(change.id))).toContain('pendientes');

  finishNext(store, 'pass');
  finishNext(store, 'fail');
  finishNext(store, 'needs_human');
  expect(store.getChange(change.id).status).toBe('implemented');
  const blocked = mergeBlocker(store.validationSummary(change.id));
  expect(blocked).toContain('fail');
  expect(blocked).not.toContain('code_review');

  // A re-run of the failed validator supersedes the earlier verdict.
  store.requestValidation(change.id, ['security_audit']);
  finishNext(store, 'pass');
  expect(mergeBlocker(store.validationSummary(change.id))).toBeUndefined();
});

test('pr open --validate queues every validator after linking the PR; dry-run queues none', async () => {
  const store = new Store(':memory:');
  stores.push(store);
  const change = implementedChange(store);
  const links = new ChangeLinkStore(store.db);
  const output: string[] = [];
  const deps: ConnectorDeps = {
    store, links, env: {}, log: (s) => output.push(s), error: (s) => output.push(s),
    run: async (cmd) => {
      if (cmd.slice(0, 4).join(' ') === 'git remote get-url origin') return { code: 0, stdout: 'https://github.com/owner/project.git\n', stderr: '' };
      if (cmd[1] === 'rev-list') return { code: 0, stdout: '1\n', stderr: '' };
      throw new Error(`Unexpected command ${JSON.stringify(cmd)}`);
    },
    prs: {
      find: async () => undefined,
      comment: async () => { throw new Error('Unexpected PR comment'); },
      open: async (i) => ({ repo: i.repo, number: 7, url: `https://github.com/${i.repo}/pull/7`, branch: i.branch, base: i.base }),
    },
  };

  expect(await connectorsMain('pr', ['open', change.id, '--validate', '--dry-run'], deps)).toBe(0);
  expect(output.join('\n')).toContain('encolaría validadores');
  expect(store.validationSummary(change.id).results).toHaveLength(0);

  expect(await connectorsMain('pr', ['open', change.id, '--validate'], deps)).toBe(0);
  expect(links.get(change.id)?.pr?.number).toBe(7);
  const summary = store.validationSummary(change.id);
  expect(summary.results.map((r) => r.validator).sort()).toEqual(['code_review', 'qa', 'security_audit']);
  expect(summary.pending).toBe(true);
  expect(store.getChange(change.id).status).toBe('implemented');
});

async function fab(home: string, args: string[]) {
  const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
    cwd: join(import.meta.dir, '..'), env: { ...process.env, FABRICA_HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}

test('top-level fab validate and fab merge are wired to the store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fab-sdlc-'));
  dirs.push(home);
  const seed = new Store(join(home, 'fabrica.db'));
  const change = implementedChange(seed);
  seed.close();

  const queued = await fab(home, ['validate', change.id.slice(0, 8), '--only', 'code_review']);
  expect(queued.code).toBe(0);
  expect(queued.out).toContain('Encolados 1 validadores');

  const status = await fab(home, ['validate', 'status', change.id]);
  expect(status.code).toBe(0);
  expect(status.out).toContain('| `code_review` |');

  const merge = await fab(home, ['merge', change.id.slice(0, 8)]);
  expect(merge.code).toBe(1);
  expect(merge.err).toContain('validadores pendientes');
  expect(merge.err).toContain('--force');

  const publish = await fab(home, ['validate', 'publish', change.id, '--dry-run']);
  expect(publish.code).toBe(0);
  expect(publish.out).toContain('Sin PR enlazado');
});
