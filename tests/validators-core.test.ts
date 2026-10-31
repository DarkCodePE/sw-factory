import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VALIDATOR_KINDS, type ChangeLinks, type PullRequestGateway, type PullRequestRef, type ValidationSummary } from '../src/connectors/types.ts';
import { Store, StoreError } from '../src/store.ts';
import { buildValidatorPrompt } from '../src/validators/prompts.ts';
import { mergeBlocker, publishValidation, validationMarkdown } from '../src/validators/publish.ts';
import { parseVerdict } from '../src/validators/verdict.ts';

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-validators-core-'));
  store = new Store(join(dir, 'test.db'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('parseVerdict extracts verdict and summary under various markdown formats', () => {
  const sample1 = `STATUS: done
VERDICT: pass

This is a clean change with good tests.
No regressions observed.

Extra details here.`;
  const res1 = parseVerdict(sample1);
  expect(res1).toBeDefined();
  expect(res1?.verdict).toBe('pass');
  expect(res1?.summary).toBe('This is a clean change with good tests.\nNo regressions observed.');

  const sampleBold = `STATUS: done\n**VERDICT: fail**\n\nFound a critical SQL injection in query builder.`;
  const resBold = parseVerdict(sampleBold);
  expect(resBold?.verdict).toBe('fail');
  expect(resBold?.summary).toBe('Found a critical SQL injection in query builder.');

  const sampleHeading = `STATUS: done\n### **VERDICT:** needs_human\n\nArchitectural question about caching strategy.`;
  const resHeading = parseVerdict(sampleHeading);
  expect(resHeading?.verdict).toBe('needs_human');
  expect(resHeading?.summary).toBe('Architectural question about caching strategy.');

  const sampleUpper = `STATUS: done\nVERDICT: PASS\n\nAll green.`;
  const resUpper = parseVerdict(sampleUpper);
  expect(resUpper?.verdict).toBe('pass');

  expect(parseVerdict('')).toBeUndefined();
  expect(parseVerdict('STATUS: done\nNo verdict provided.')).toBeUndefined();
  expect(parseVerdict('VERDICT: maybe')).toBeUndefined();

  // Summary truncated to 600 characters
  const longParagraph = 'A'.repeat(800);
  const sampleLong = `STATUS: done\nVERDICT: pass\n\n${longParagraph}\n\nNext paragraph`;
  const resLong = parseVerdict(sampleLong);
  expect(resLong?.summary.length).toBe(600);
  expect(resLong?.summary).toBe('A'.repeat(600));
});

test('buildValidatorPrompt creates specialized prompts for all validator kinds', () => {
  const dummyChange = {
    id: '12345678-0000-0000-0000-000000000000',
    workstreamId: 'ws-1',
    title: 'Fix issue',
    description: 'Detailed description of fix',
    status: 'implemented',
    branch: 'fab/12345678',
    createdAt: 'now',
    updatedAt: 'now',
  } as const;

  for (const v of VALIDATOR_KINDS) {
    const prompt = buildValidatorPrompt(v, {
      change: dummyChange as any,
      diffStat: ' 1 file changed, 2 insertions(+)',
      base: 'main',
      branch: 'fab/12345678',
      worktree: '/tmp/worktree',
      history: [],
    });

    expect(prompt).toContain(dummyChange.title);
    expect(prompt).toContain(dummyChange.description);
    expect(prompt).toContain('fab/12345678');
    expect(prompt).toContain('VERDICT: pass | fail | needs_human');
    expect(prompt).toContain('Do NOT edit any files in the repository');

    if (v === 'code_review') {
      expect(prompt).toContain('CODE REVIEW');
      expect(prompt).toContain('file:line');
    } else if (v === 'security_audit') {
      expect(prompt).toContain('SECURITY AUDIT');
      expect(prompt).toContain('Injection risks');
      expect(prompt).toContain('severity level');
    } else if (v === 'qa') {
      expect(prompt).toContain('QUALITY ASSURANCE');
      expect(prompt).toContain('git status --porcelain must be empty');
    }
  }
});

test('idempotent migration adds validator column to legacy database without errors', () => {
  const legacyDbPath = join(dir, 'legacy.db');
  const legacyDb = new Database(legacyDbPath);
  // Create activities table WITHOUT validator column (like main branch schema)
  legacyDb.exec(`
    CREATE TABLE workstreams (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, goal TEXT NOT NULL, repo TEXT NOT NULL, state TEXT NOT NULL, agent TEXT NOT NULL, worker_concurrency INTEGER NOT NULL, task_limit INTEGER NOT NULL, require_change_approval INTEGER NOT NULL, require_approval INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE changes (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL, branch TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE activities (id TEXT PRIMARY KEY, workstream_id TEXT NOT NULL, change_id TEXT NOT NULL, parent_activity_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, review_status TEXT, review_comment TEXT, worker_id TEXT, result TEXT, error TEXT, retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, workstream_id TEXT NOT NULL, change_id TEXT, activity_id TEXT, severity TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  legacyDb.close();

  // Open with Store class: migration must run and succeed
  const legacyStore = new Store(legacyDbPath);
  const cols = legacyStore.db.query('PRAGMA table_info(activities)').all() as { name: string }[];
  expect(cols.some((c) => c.name === 'validator')).toBe(true);
  legacyStore.close();

  // Opening again must not fail (idempotency)
  const legacyStore2 = new Store(legacyDbPath);
  expect(legacyStore2.listWorkstreams()).toEqual([]);
  legacyStore2.close();
});

test('requestValidation throws on change not implemented', () => {
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, requireChangeApproval: false });
  const c = store.createChange(ws.id, 'Change in progress', 'desc');
  expect(c.status).toBe('pending');

  expect(() => {
    store.requestValidation(c.id, ['code_review']);
  }).toThrow(StoreError);
});

test('requestValidation queues pending activities without duplicates and preserves implemented status', () => {
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir, requireChangeApproval: false });
  const c = store.createChange(ws.id, 'Change ready', 'desc');

  // Move change to implemented
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  const acts = store.requestValidation(c.id, ['code_review', 'security_audit']);
  expect(acts.length).toBe(2);
  expect(acts.map((a) => a.validator)).toEqual(['code_review', 'security_audit']);
  expect(acts.every((a) => a.kind === 'change_review' && a.status === 'pending')).toBe(true);

  // Change remains in implemented status
  expect(store.getChange(c.id).status).toBe('implemented');

  // Requesting again with overlap: does not duplicate pending/in-progress validators
  const acts2 = store.requestValidation(c.id, ['code_review', 'qa']);
  expect(acts2.length).toBe(1);
  expect(acts2[0]!.validator).toBe('qa');

  // Still implemented
  expect(store.getChange(c.id).status).toBe('implemented');
});

test('completing a validator maps verdicts and keeps change in implemented status', () => {
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Target change', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  const [act] = store.requestValidation(c.id, ['code_review']);
  expect(act).toBeDefined();

  // Claim
  store.setWorkstreamState(ws.id, 'active');
  const claimed = store.claimActivity(ws.id, 'w1');
  expect(claimed?.id).toBe(act!.id);

  // Complete with pass verdict
  const report = 'STATUS: done\nVERDICT: pass\n\nCode review approved without defects.';
  const completed = store.completeActivity(claimed!.id, 'w1', report);
  expect(completed.status).toBe('completed');
  expect(completed.reviewStatus).toBe('approved');
  expect(completed.reviewComment).toBe('Code review approved without defects.');

  // Change MUST still be implemented, not completed
  expect(store.getChange(c.id).status).toBe('implemented');
});

test('verdict mapping: fail -> declined, needs_human -> commented', () => {
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Target change', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);
  store.setWorkstreamState(ws.id, 'active');

  // Test fail
  store.requestValidation(c.id, ['security_audit']);
  const claimedFail = store.claimActivity(ws.id, 'w1');
  const completedFail = store.completeActivity(claimedFail!.id, 'w1', 'STATUS: done\nVERDICT: fail\n\nFound vulnerability.');
  expect(completedFail.reviewStatus).toBe('declined');
  expect(completedFail.reviewComment).toBe('Found vulnerability.');

  // Test needs_human
  store.requestValidation(c.id, ['qa']);
  const claimedHuman = store.claimActivity(ws.id, 'w1');
  const completedHuman = store.completeActivity(claimedHuman!.id, 'w1', 'STATUS: done\nVERDICT: needs_human\n\nManual QA check advised.');
  expect(completedHuman.reviewStatus).toBe('commented');
  expect(completedHuman.reviewComment).toBe('Manual QA check advised.');
});

test('validationSummary: pending, fail, and pass states', () => {
  const ws = store.createWorkstream({ slug: 'ws', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Target change', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);
  store.setWorkstreamState(ws.id, 'active');

  store.requestValidation(c.id, ['code_review', 'security_audit', 'qa']);

  // Case 1: All pending
  const s1 = store.validationSummary(c.id);
  expect(s1.pending).toBe(true);
  expect(s1.passed).toBe(false);
  expect(s1.results.length).toBe(3);
  expect(s1.results.every((r) => r.verdict === undefined)).toBe(true);

  // Complete code_review with pass
  const w1 = store.claimActivity(ws.id, 'w1');
  store.completeActivity(w1!.id, 'w1', 'STATUS: done\nVERDICT: pass\n\nLooks good.');

  // Still pending because security_audit and qa are pending
  const s2 = store.validationSummary(c.id);
  expect(s2.pending).toBe(true);
  expect(s2.passed).toBe(false);

  // Complete security_audit with fail
  const w2 = store.claimActivity(ws.id, 'w1');
  store.completeActivity(w2!.id, 'w1', 'STATUS: done\nVERDICT: fail\n\nSecurity issue.');

  // Complete qa with pass
  const w3 = store.claimActivity(ws.id, 'w1');
  store.completeActivity(w3!.id, 'w1', 'STATUS: done\nVERDICT: pass\n\nTests passed.');

  // Case 2: One fail -> pending=false, passed=false
  const s3 = store.validationSummary(c.id);
  expect(s3.pending).toBe(false);
  expect(s3.passed).toBe(false);
  expect(s3.results.find((r) => r.validator === 'security_audit')?.verdict).toBe('fail');

  // Retry security_audit and pass it
  store.requestValidation(c.id, ['security_audit']);
  const w4 = store.claimActivity(ws.id, 'w1');
  store.completeActivity(w4!.id, 'w1', 'STATUS: done\nVERDICT: pass\n\nSecurity fix verified.');

  // Case 3: All pass -> pending=false, passed=true
  const s4 = store.validationSummary(c.id);
  expect(s4.pending).toBe(false);
  expect(s4.passed).toBe(true);
  expect(s4.results.every((r) => r.verdict === 'pass')).toBe(true);
});

test('validationMarkdown renders formatted table', () => {
  const summary: ValidationSummary = {
    changeId: 'c1234567-89ab-cdef-0123-456789abcdef',
    passed: true,
    pending: false,
    results: [
      { validator: 'code_review', activityId: 'a1', verdict: 'pass', summary: 'Clean diff.' },
      { validator: 'security_audit', activityId: 'a2', verdict: 'pass', summary: 'No CVEs.' },
      { validator: 'qa', activityId: 'a3', verdict: 'pass', summary: 'All tests green.' },
    ],
  };

  const md = validationMarkdown(summary);
  expect(md).toContain('### Validación de fab change `c1234567` [APROBADO]');
  expect(md).toContain('| Validador | Veredicto | Resumen |');
  expect(md).toContain('| `code_review` | **PASS** | Clean diff. |');
  expect(md).toContain('| `security_audit` | **PASS** | No CVEs. |');
  expect(md).toContain('| `qa` | **PASS** | All tests green. |');
});

test('publishValidation returns no_pr when no PR is linked, and publishes comment when linked', async () => {
  const comments: Array<{ pr: PullRequestRef; md: string }> = [];
  const fakePrs: PullRequestGateway = {
    async open() { throw new Error('not used'); },
    async find() { return undefined; },
    async comment(pr, md) { comments.push({ pr, md }); },
  };

  const summary: ValidationSummary = {
    changeId: 'c1',
    passed: true,
    pending: false,
    results: [{ validator: 'qa', activityId: 'a1', verdict: 'pass', summary: 'OK' }],
  };

  // Sin PR
  const lookupNoPr = () => ({ changeId: 'c1' });
  const res1 = await publishValidation(summary, { lookup: lookupNoPr, prs: fakePrs });
  expect(res1).toBe('no_pr');
  expect(comments.length).toBe(0);

  // Con PR
  const prRef: PullRequestRef = { repo: 'org/repo', number: 10, url: 'https://github.com/org/repo/pull/10', branch: 'fab/c1', base: 'main' };
  const lookupWithPr = () => ({ changeId: 'c1', pr: prRef });
  const res2 = await publishValidation(summary, { lookup: lookupWithPr, prs: fakePrs });
  expect(res2).toBe('published');
  expect(comments.length).toBe(1);
  expect(comments[0]!.pr).toEqual(prRef);
  expect(comments[0]!.md).toContain('Validador | Veredicto | Resumen');
});


function implementedChange() {
  const ws = store.createWorkstream({
    slug: 'implemented', goal: 'g', repo: dir,
    requireChangeApproval: false, requireApproval: false,
  });
  store.setWorkstreamState(ws.id, 'active');
  const change = store.createChange(ws.id, 'Target', 'desc');
  for (let i = 0; i < 2; i++) {
    store.completeActivity(store.claimActivity(ws.id, 'w1')!.id, 'w1', 'STATUS: done');
  }
  expect(store.getChange(change.id).status).toBe('implemented');
  return { ws, change };
}

test.each(['failed', 'completed'] as const)('merge blocks a %s validator without a verdict', (status) => {
  const { ws, change } = implementedChange();
  const [qa] = store.requestValidation(change.id, ['qa']);
  expect(mergeBlocker(store.validationSummary(change.id))).toBe('hay validadores pendientes o en curso');
  if (status === 'failed') {
    for (let i = 0; i < 3; i++) {
      expect(store.claimActivity(ws.id, 'w1')!.id).toBe(qa!.id);
      store.failActivity(qa!.id, 'w1', 'no verdict');
    }
  } else {
    store.completeActivity(store.claimActivity(ws.id, 'w1')!.id, 'w1', 'STATUS: done');
  }
  expect(store.getActivity(qa!.id).status).toBe(status);
  const summary = store.validationSummary(change.id);
  expect(summary.pending).toBe(false);
  expect(summary.results[0]!.verdict).toBeUndefined();
  expect(mergeBlocker(summary)).toBe('validadores sin veredicto: qa');
  expect(validationMarkdown(summary)).toContain(status === 'failed' ? '*sin veredicto (falló)*' : '*pendiente*');
});

test('merge keeps existing behavior for no validators and needs_human', () => {
  const { ws, change } = implementedChange();
  expect(mergeBlocker(store.validationSummary(change.id))).toBeUndefined();
  store.requestValidation(change.id, ['qa']);
  store.completeActivity(store.claimActivity(ws.id, 'w1')!.id, 'w1', 'STATUS: done\nVERDICT: needs_human');
  expect(mergeBlocker(store.validationSummary(change.id))).toBeUndefined();
});

test('retryChange retries failed QA rather than a newer validator and preserves its context', () => {
  const { ws, change } = implementedChange();
  const implementation = store.listActivities({ changeId: change.id }).find((a) => a.kind === 'implementation')!;
  const [qa] = store.requestValidation(change.id, ['qa']);
  // Non-null parent fixture verifies preservation beyond requestValidation's default null.
  store.db.query('UPDATE activities SET parent_activity_id = ? WHERE id = ?').run(implementation.id, qa!.id);
  for (let i = 0; i < 3; i++) {
    store.failActivity(store.claimActivity(ws.id, 'w1')!.id, 'w1', 'QA crashed');
  }
  expect(store.getActivity(qa!.id).status).toBe('failed');
  expect(store.getChange(change.id).status).toBe('implemented');
  // Force creation ordering explicitly, without relying on wall-clock resolution.
  const [newer] = store.requestValidation(change.id, ['security_audit']);
  store.db.query('UPDATE activities SET created_at = ? WHERE id = ?').run('9999-01-01', newer!.id);

  const retry = store.retryChange(change.id);
  expect(retry.id).not.toBe(qa!.id);
  expect(retry.validator).toBe('qa');
  expect(retry.kind).toBe(qa!.kind);
  expect(retry.parentActivityId).toBe(implementation.id);
  expect(retry.retryCount).toBe(0);
  expect(retry.status).toBe('pending');
  expect(store.getChange(change.id).status).toBe('implemented');
  expect(() => store.retryChange(change.id)).toThrow(StoreError);

  const claimed = store.claimActivity(ws.id, 'w1')!;
  expect(claimed.id).toBe(retry.id);
  expect(() => store.retryChange(change.id)).toThrow(StoreError);
  store.completeActivity(claimed.id, 'w1', 'STATUS: done\nVERDICT: pass');
  expect(store.getChange(change.id).status).toBe('implemented');
  expect(store.validationSummary(change.id).results.find((r) => r.validator === 'qa')!.verdict).toBe('pass');
});
