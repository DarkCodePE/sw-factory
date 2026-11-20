import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function fab(home: string, ...args: string[]) {
  const p = Bun.spawn([process.execPath, 'src/cli.ts', 'api-key', ...args], {
    cwd: join(import.meta.dir, '..'), env: { ...process.env, FABRICA_HOME: home }, stdout: 'pipe', stderr: 'pipe',
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}
const home = () => { const h = mkdtempSync(join(tmpdir(), 'fab-apikey-')); roots.push(h); return h; };
const KEY = /fabk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}/g;

test('create imprime la clave una sola vez y verifica; ni argv ni stderr la llevan', async () => {
  const h = home();
  const r = await fab(h, 'create', '--name', 'ci', '--scope', 'read');
  expect(r.code).toBe(0);
  const keys = r.out.match(KEY) ?? [];
  expect(keys.length).toBe(1);
  expect(r.err).not.toMatch(KEY);
  const store = new Store(join(h, 'fabrica.db'));
  try { expect(store.verifyApiKey(keys[0]!)).toMatchObject({ name: 'ci', scope: 'read' }); } finally { store.close(); }
});

test('list nunca imprime clave ni hash; revoke la deja inválida', async () => {
  const h = home();
  const key = (await fab(h, 'create', '--name', 'ci', '--scope', 'decide')).out.match(KEY)![0]!;
  const secret = key.split('_')[2]!;
  const list = await fab(h, 'list');
  expect(list.code).toBe(0);
  expect(list.out).toContain('ci');
  expect(list.out).toContain('decide');
  expect(list.out).not.toContain(secret);
  expect(list.out).not.toMatch(/[a-f0-9]{64}/);
  expect((await fab(h, 'revoke', 'ci')).code).toBe(0);
  expect((await fab(h, 'list')).out).toContain('revocada');
  const store = new Store(join(h, 'fabrica.db'));
  try { expect(store.verifyApiKey(key)).toBeNull(); } finally { store.close(); }
});

test('revoke de una clave inexistente sale con código distinto de 0', async () => {
  const r = await fab(home(), 'revoke', 'nadie');
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('not_found');
});

test('entradas inválidas fallan sin crear nada y sin imprimir clave', async () => {
  const h = home();
  for (const args of [['create', '--name', 'Mal Nombre', '--scope', 'read'], ['create', '--name', 'ok', '--scope', 'admin'], ['create', '--scope', 'read'], ['otra']]) {
    const r = await fab(h, ...args);
    expect(r.code).not.toBe(0);
    expect(r.out).not.toMatch(KEY);
  }
  expect((await fab(h, 'list')).out).not.toContain('ok');
});

test('el secreto no queda en ningún fichero de stateDir', async () => {
  const h = home();
  const secret = (await fab(h, 'create', '--name', 'ci', '--scope', 'read')).out.match(KEY)![0]!.split('_')[2]!;
  for (const f of readdirSync(h)) expect(readFileSync(join(h, f)).includes(secret)).toBe(false);
});
