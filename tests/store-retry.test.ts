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
