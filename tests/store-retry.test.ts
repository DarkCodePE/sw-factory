import { expect, test } from 'bun:test';
import { Store } from '../src/store.ts';

test('withRetry replays a multi-statement block whole: a busy error after the first write leaves no duplicate', () => {
  const store = new Store(':memory:');
  const ws = store.createWorkstream({ slug: 'r', repo: '/tmp/unused', goal: 'g', requireChangeApproval: false, requireApproval: false });
  const before = store.listEvents(ws.id, 1000).length;
  let calls = 0;
  store.withRetry(() => {
    store.event(ws.id, 'info', 'once');
    if (++calls === 1) throw new Error('database is locked');
  });
  expect(calls).toBe(2);
  expect(store.listEvents(ws.id, 1000).length - before).toBe(1);
});

test('withRetry gives up after a bounded number of busy attempts', () => {
  const store = new Store(':memory:');
  let calls = 0;
  expect(() => store.withRetry(() => { calls++; throw new Error('database is locked'); })).toThrow('locked');
  expect(calls).toBe(4);
});

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBusyError } from '../src/store.ts';

test('isBusyError recognises real SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT and SQLITE_LOCKED', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-busy-'));
  const p = join(dir, 'a.db');
  const a = new Database(p), b = new Database(p);
  a.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x)'); a.exec('PRAGMA busy_timeout=0'); b.exec('PRAGMA busy_timeout=0');
  const catchErr = (f: () => void) => { try { f(); } catch (e) { return e as any; } throw new Error('no error'); };
  try {
    a.exec('BEGIN IMMEDIATE');
    const busy = catchErr(() => b.exec('BEGIN IMMEDIATE'));
    expect(busy.code).toBe('SQLITE_BUSY'); expect(isBusyError(busy)).toBe(true);
    a.exec('ROLLBACK');
    b.exec('BEGIN'); b.query('SELECT * FROM t').all(); a.exec('INSERT INTO t VALUES (1)');
    const snap = catchErr(() => b.exec('INSERT INTO t VALUES (2)'));
    expect(snap.code).toBe('SQLITE_BUSY_SNAPSHOT'); expect(isBusyError(snap)).toBe(true);
    const m = new Database(':memory:'); m.exec('CREATE TABLE t(x); INSERT INTO t VALUES (1)');
    const it = m.query('SELECT * FROM t').iterate(); it.next();
    const locked = catchErr(() => m.exec('DROP TABLE t'));
    expect(locked.code).toBe('SQLITE_LOCKED'); expect(isBusyError(locked)).toBe(true);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('isBusyError ignores unrelated errors that merely mention busy', () => {
  expect(isBusyError(new Error('git failed at /tmp/busy-state/x'))).toBe(false);
  expect(isBusyError(new Error('EBUSY: resource busy or locked'))).toBe(false);
  expect(isBusyError('database is locked')).toBe(false);
});
