import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { readEvidence, redact, redactField } from '../src/evidence.ts';

// Los once casos de H4, con valores sintéticos. `valor` es lo que no debe salir.
const V = 'zq9Xv7hunterK3';
const CASOS: [string, string][] = [
  ['Authorization: Basic', `Authorization: Basic ${V}==`], ['authorization en minúsculas', `authorization: basic ${V}==`],
  ['Cookie', `Cookie: sid=${V}; theme=dark`], ['COOKIE en mayúsculas', `COOKIE: sid=${V}`],
  ['glpat-', `token glpat-${V}AbCdEf0123`], ['npm_', `//registry/:_authToken=npm_${V}AbCdEf0123456`],
  ['passwd=', `passwd=${V}`], ['pwd:', `pwd: ${V}`], ['--token', `npm publish --token ${V}`], ['--token=', `npm publish --token=${V}`],
  ['curl -u', `curl -u admin:${V} https://x.test`], ['private_key_id', `private_key_id: ${V}`],
  ['PGP privada', `-----BEGIN PGP PRIVATE KEY BLOCK-----\n${V}\n-----END PGP PRIVATE KEY BLOCK-----`],
  ['JSON authorization', `{"authorization": "Basic ${V}", "otro": "visible"}`], ['JSON pass', `{"pass": "${V} con espacio", "otro": "visible"}`],
  ['valor con comillas y escapes', `{"password": "a\\"${V}"}`],
];
const INOCUO = ['npm publish --token', 'npm publish --token --dry-run', 'curl -s https://x.test -o out', 'tar -u archivo.tar', 'bypass: true', 'pass/fail 3/4', 'pwd', 'Cookie banner aceptado',
  '-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----', '{"nota": "pasa", "n": 3}'];

let dir: string, store: Store, server: ReturnType<typeof startWeb>, activity: string, change: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-redact-')); store = new Store(join(dir, 'fabrica.db'));
  const ws = store.createWorkstream({ slug: 'p', goal: 'g', repo: '/repo' });
  change = store.createChange(ws.id, 't', 'd').id; activity = store.listActivities({ changeId: change })[0]!.id;
  mkdirSync(join(dir, 'runs', change), { recursive: true });
  server = startWeb(dir, 0);
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

test.each(CASOS)('T77a: %s sale redactado en texto, es idempotente y se sirve por HTTP', async (_n, texto) => {
  const out = redact(texto);
  expect(out).not.toContain(V); expect(out).toContain('[REDACTED]'); expect(redact(out)).toBe(out);
  writeFileSync(join(dir, 'runs', change, `${activity}.log`), `antes\n${texto}\ndespués`);
  const page = await (await fetch(`http://127.0.0.1:${server.port}/activities/${activity}`)).text();
  expect(page).not.toContain(V); expect(page).toContain('antes');
});

test('T77a: el texto inocuo y las claves públicas no cambian', () => {
  for (const t of INOCUO) expect(redact(t)).toBe(t);
});

test('T77a: el JSON conserva su forma y los campos vecinos', () => {
  const out = redact(`{"authorization": "Basic ${V}", "otro": "visible"}`);
  expect(JSON.parse(out)).toEqual({ authorization: '[REDACTED]', otro: 'visible' });
  expect(JSON.parse(redact(`{"password": "a\\"${V}", "x": 1}`))).toEqual({ password: '[REDACTED]', x: 1 });
  expect(redactField('pass', V)).toBe('[REDACTED]'); expect(redactField('nota', 'bypass')).toBe('bypass');
});

test('T77a: evidencia JSON histórica y truncada', () => {
  writeFileSync(join(dir, 'h.json'), JSON.stringify({ Authorization: `Basic ${V}`, set_cookie: 'x', 'Set-Cookie': V, pass: V, private_key_id: V, nota: 'bypass' }));
  const j = readEvidence(dir, 'h.json')!.text;
  expect(j).not.toContain(V); expect(j).toContain('bypass');
  writeFileSync(join(dir, 'pgp.log'), '-----BEGIN PGP PRIVATE KEY BLOCK-----\n' + `${V}\n`.repeat(40000));
  const t = readEvidence(dir, 'pgp.log')!;
  expect(t.truncated).toBe(true); expect(t.text).not.toContain(V);
  writeFileSync(join(dir, 'c.log'), 'Cookie: ' + 'a'.repeat(300 * 1024));
  expect(readEvidence(dir, 'c.log')!.text).not.toContain('aaaa');
});

test('T77a: redact es lineal con entradas largas', () => {
  const t0 = performance.now();
  redact('curl ' + 'curl -x '.repeat(20000)); redact('"' + 'a\\'.repeat(100000)); redact('password: ' + '"'.repeat(100000));
  expect(performance.now() - t0).toBeLessThan(5000);
});

test('T77-H1: rachas largas de guiones y de palabras con guion no son cuadráticas (tiempo acotado)', () => {
  for (const t of ['-'.repeat(256 * 1024), '--a'.repeat(80000), 'a-'.repeat(128 * 1024), '--token'.repeat(30000), 'x_token-'.repeat(30000)]) {
    const t0 = performance.now(); redact(t);
    expect(performance.now() - t0).toBeLessThan(1500);
  }
});

test('T77-H2: los contadores de tokens de un log stream-json no se redactan; los textos secretos sí', () => {
  const linea = '{"usage":{"input_tokens":1234,"output_tokens":56},"max_tokens":8,"stop":true,"token":"zq9Xv7hunterK3"}';
  const out = redact(linea);
  expect(JSON.parse(out)).toEqual({ usage: { input_tokens: 1234, output_tokens: 56 }, max_tokens: 8, stop: true, token: '[REDACTED]' });
  expect(redact('token=12345678')).toBe('token=[REDACTED]'); // fuera de JSON, un valor numérico sí es secreto
});

test.each([
  ['comilla sin cierre', 'password: "zq9Xv7hunterK3 con resto'], ['comilla simple sin cierre', "token='zq9Xv7hunterK3"],
  ['salto de línea dentro', 'secret="zq9Xv7hunterK3\nresto"'], ['valor de más de 4096', `password="${'zq9Xv7hunterK3'.repeat(400)}"`],
])('T77-H3: %s no deja salir el valor', (_n, texto) => {
  const out = redact(texto);
  expect(out).not.toContain('zq9Xv7'); expect(out).toContain('[REDACTED]'); expect(redact(out)).toBe(out);
});

test('T77-H4: el texto corriente de logs, perfiles y configuración MCP no cambia', () => {
  for (const t of ['PWD=$(pwd)', 'pwd: /repo', 'pass: 12 fail: 0', 'PASS: tests/x.test.ts', 'cookie: accepted', 'authorization: required', '--max-tokens 4096',
    '--password-stdin < f', 'curl https://x.test && tar -u f', 'cd "$PWD"', 'tokenizer: wordpiece']) expect(redact(t)).toBe(t);
  for (const t of ['pwd: zq9Xv7hunterK3', 'pass=zq9Xv7hunterK3', '--token zq9Xv7hunterK3', 'Cookie: sid=zq9Xv7hunterK3']) expect(redact(t)).not.toContain('zq9Xv7');
});
