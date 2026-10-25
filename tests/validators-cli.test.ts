import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PullRequestGateway, PullRequestRef } from '../src/connectors/types.ts';
import { Store } from '../src/store.ts';
import { validateMain } from '../src/validators/cli.ts';

let dir: string;
let store: Store;
let logs: string[];
let errors: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fabrica-validators-cli-'));
  store = new Store(join(dir, 'test.db'));
  logs = [];
  errors = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('validateMain shows help when no args or --help is passed', async () => {
  const code1 = await validateMain([], { store, stateDir: dir });
  expect(code1).toBe(0);
  expect(logs.some((l) => l.includes('fab validate'))).toBe(true);

  logs = [];
  const code2 = await validateMain(['--help'], { store, stateDir: dir });
  expect(code2).toBe(0);
  expect(logs.some((l) => l.includes('Uso:'))).toBe(true);
});

test('validateMain queues validators by changeId or prefix', async () => {
  const ws = store.createWorkstream({ slug: 'ws-cli', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Change for validation', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  // Queue default 3 validators
  const code = await validateMain([c.id.slice(0, 8)], { store, stateDir: dir });
  expect(code).toBe(0);
  expect(logs.some((l) => l.includes(`Encolados 3 validadores para change ${c.id.slice(0, 8)}`))).toBe(true);

  const acts = store.listActivities({ changeId: c.id });
  expect(acts.filter((a) => a.validator !== null).length).toBe(3);
});

test('validateMain --only filters requested validators and rejects unknown kinds', async () => {
  const ws = store.createWorkstream({ slug: 'ws-cli-only', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Change for validation', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  const codeInvalid = await validateMain([c.id, '--only', 'code_review,unknown_thing'], { store, stateDir: dir });
  expect(codeInvalid).toBe(1);
  expect(errors.some((e) => e.includes('Validador desconocido "unknown_thing"'))).toBe(true);

  const codeValid = await validateMain([c.id, '--only', 'code_review,qa'], { store, stateDir: dir });
  expect(codeValid).toBe(0);
  expect(logs.some((l) => l.includes('code_review, qa'))).toBe(true);

  const acts = store.listActivities({ changeId: c.id }).filter((a) => a.validator !== null);
  expect(acts.map((a) => a.validator)).toEqual(['code_review', 'qa']);
});

test('validateMain status prints formatted summary table', async () => {
  const ws = store.createWorkstream({ slug: 'ws-cli-status', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Change status test', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  store.requestValidation(c.id, ['code_review', 'qa']);
  store.setWorkstreamState(ws.id, 'active');

  const claimed = store.claimActivity(ws.id, 'w1');
  store.completeActivity(claimed!.id, 'w1', 'STATUS: done\nVERDICT: pass\n\nCode review approved.');

  const code = await validateMain(['status', c.id.slice(0, 8)], { store, stateDir: dir });
  expect(code).toBe(0);
  expect(logs.some((l) => l.includes('| Validador | Veredicto | Resumen |'))).toBe(true);
  expect(logs.some((l) => l.includes('`code_review`'))).toBe(true);
  expect(logs.some((l) => l.includes('PENDIENTE'))).toBe(true);
});

test('validateMain publish: dry-run and actual comment', async () => {
  const ws = store.createWorkstream({ slug: 'ws-cli-pub', goal: 'g', repo: dir });
  const c = store.createChange(ws.id, 'Change publish test', 'desc');
  store.db.query(`UPDATE changes SET status = 'implemented' WHERE id = ?`).run(c.id);

  store.requestValidation(c.id, ['qa']);
  store.setWorkstreamState(ws.id, 'active');
  const claimed = store.claimActivity(ws.id, 'w1');
  store.completeActivity(claimed!.id, 'w1', 'STATUS: done\nVERDICT: pass\n\nQA passed.');

  const publishedComments: string[] = [];
  const prRef: PullRequestRef = { repo: 'acme/repo', number: 101, url: 'https://github.com/acme/repo/pull/101', branch: 'fab/1234', base: 'main' };
  const fakePrs: PullRequestGateway = {
    async open() { throw new Error('not used'); },
    async find() { return undefined; },
    async comment(_pr, md) { publishedComments.push(md); },
  };

  // 1. Dry run without PR
  const lookupNoPr = () => ({ changeId: c.id });
  const code1 = await validateMain(['publish', c.id, '--dry-run'], { store, stateDir: dir, lookup: lookupNoPr, prs: fakePrs });
  expect(code1).toBe(0);
  expect(logs.some((l) => l.includes('Sin PR enlazado'))).toBe(true);
  expect(publishedComments.length).toBe(0);

  // 2. Dry run with PR
  logs = [];
  const lookupWithPr = () => ({ changeId: c.id, pr: prRef });
  const code2 = await validateMain(['publish', c.id, '--dry-run'], { store, stateDir: dir, lookup: lookupWithPr, prs: fakePrs });
  expect(code2).toBe(0);
  expect(logs.some((l) => l.includes('[dry-run] Comentario para PR #101'))).toBe(true);
  expect(publishedComments.length).toBe(0);

  // 3. Real publish with PR
  logs = [];
  const code3 = await validateMain(['publish', c.id], { store, stateDir: dir, lookup: lookupWithPr, prs: fakePrs });
  expect(code3).toBe(0);
  expect(logs.some((l) => l.includes('Validación publicada en el PR'))).toBe(true);
  expect(publishedComments.length).toBe(1);
  expect(publishedComments[0]).toContain('### Validación de fab change');
});
