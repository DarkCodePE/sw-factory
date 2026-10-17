import { afterEach, beforeEach, expect, test } from 'bun:test';

import { Store } from '../src/store.ts';
import { handleKey, newTuiState, render, stripAnsi } from '../src/tui.ts';

let store: Store;
let wsId: string;

beforeEach(() => {
  store = new Store(':memory:');
  wsId = store.createWorkstream({ slug: 'demo', goal: 'keep calc correct', repo: '/tmp/demo' }).id;
  store.setWorkstreamState(wsId, 'active');
});
afterEach(() => store.close());

const screen = (state = newTuiState(), w = 100, h = 20) => render(store, wsId, state, w, h).map(stripAnsi);

test('renders header, rows and a fixed-size screen', () => {
  store.createChange(wsId, 'add() subtracts', 'calc.add(2,3) returns -1');
  const lines = screen();
  expect(lines).toHaveLength(20);
  expect(lines.every((l) => l.length === 100)).toBe(true);
  expect(lines[0]).toContain('demo [active]');
  expect(lines[0]).toContain('bandeja: 1');
  expect(lines.join('\n')).toContain('add() subtracts');
  expect(lines.join('\n')).toContain('change_review:completed');
  expect(lines.at(-1)).toContain('a aprobar');
});

test('approve from the list moves the change to the worker queue', () => {
  const c = store.createChange(wsId, 'fix it', 'd');
  const state = newTuiState();
  expect(handleKey(store, wsId, state, 'a')).toBe(true);
  expect(state.flash).toContain('aprobado');
  expect(store.getChange(c.id).status).toBe('pending');
  expect(store.claimActivity(wsId, 'w1')?.kind).toBe('investigation');
});

test('comment mode collects text and re-queues with the comment', () => {
  store.createChange(wsId, 'fix it', 'd');
  const state = newTuiState();
  handleKey(store, wsId, state, '\r');
  expect(state.mode).toBe('detail');
  handleKey(store, wsId, state, 'c');
  expect(state.mode).toBe('comment');
  for (const ch of 'mas tests') handleKey(store, wsId, state, ch);
  expect(screen(state).join('\n')).toContain('comentario: mas tests');
  handleKey(store, wsId, state, '\r');
  expect(state.mode).toBe('detail');
  expect(store.inbox(wsId)[0]?.kind).toBe('change_review');
  expect(store.listActivities({ workstream: wsId }).some((a) => a.reviewComment === 'mas tests')).toBe(true);
});

test('navigation is clamped and q quits', () => {
  store.createChange(wsId, 'one', 'd');
  store.createChange(wsId, 'two', 'd');
  const state = newTuiState();
  handleKey(store, wsId, state, '\x1b[B');
  handleKey(store, wsId, state, '\x1b[B');
  expect(state.selected).toBe(1);
  handleKey(store, wsId, state, '\x1b[A');
  expect(state.selected).toBe(0);
  expect(handleKey(store, wsId, state, 'q')).toBe(false);
});

test('actions that do not apply only show a message', () => {
  const c = store.createChange(wsId, 'x', 'd');
  store.resolveReview(store.inbox(wsId)[0]!.id, 'approve');
  const state = newTuiState();
  handleKey(store, wsId, state, 'a');
  expect(state.flash).toContain('no espera revisión');
  handleKey(store, wsId, state, 'r');
  expect(state.flash).toContain('fallidos');
  expect(store.getChange(c.id).status).toBe('pending');
});
