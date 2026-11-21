import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

// B de INT-O1: `fab ws agent` cambia el adaptador con las mismas guardas que la web.
let dir: string;
const fab = (...args: string[]) => Bun.spawnSync(['bun', 'src/cli.ts', ...args], { env: { ...process.env, FABRICA_HOME: dir } });
const agent = () => { const s = new Store(join(dir, 'fabrica.db')); try { return s.getWorkstream('p').agent; } finally { s.close(); } };
beforeEach(() => {
  dir = mkdtempSync('/tmp/fab-cli-agent-'); const s = new Store(join(dir, 'fabrica.db'));
  s.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo', requireChangeApproval: false }); s.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('cambia el adaptador de un workstream existente y deja el evento con el actor (C90-H3)', () => {
  const r = Bun.spawnSync(['bun', 'src/cli.ts', 'ws', 'agent', 'p', 'claude'], { env: { ...process.env, FABRICA_HOME: dir, FAB_ACTOR: 'dueño-cli' } });
  expect(r.exitCode).toBe(0); expect(r.stdout.toString()).toContain('native -> claude');
  expect(agent()).toBe('claude');
  const s = new Store(join(dir, 'fabrica.db'));
  try { expect(s.listEvents('p', -1).some(e => e.actor === 'dueño-cli' && String(e.message).includes('native → claude'))).toBe(true); } finally { s.close(); }
});
test('adaptador desconocido, mismo adaptador o sin argumentos: código distinto de 0 y nada cambia', () => {
  for (const args of [['p', 'no-existe'], ['p', 'native'], ['p'], []]) expect(fab('ws', 'agent', ...args).exitCode).not.toBe(0);
  expect(agent()).toBe('native');
});
test('con trabajo vivo se rechaza como en la web', () => {
  const s = new Store(join(dir, 'fabrica.db'));
  s.setWorkstreamState('p', 'active'); s.createChange(s.getWorkstream('p').id, 'C', 'd'); s.claimActivity(s.getWorkstream('p').id, 'w'); s.close();
  const r = fab('ws', 'agent', 'p', 'claude');
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain('trabajo vivo');
  expect(agent()).toBe('native');
});
