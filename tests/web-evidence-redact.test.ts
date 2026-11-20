import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { RULES, readEvidence, redact, redactField } from '../src/evidence.ts';

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

test.each([
  ['Authorization: Negotiate', 'Authorization: Negotiate zq9Xv7hunterK3abc'], ['Authorization: ApiKey', 'Authorization: ApiKey zq9Xv7hunterK3'],
  ['Authorization: esquema propio', 'Authorization: Custom zq9Xv7hunterK3'], ['curl -sSu', 'curl -sSu admin:zq9Xv7hunterK3 https://x.test'],
  ['cookie como clave JSON en texto', '{"cookie": "sid=zq9Xv7hunterK3; a=b", "n": 1}'], ['Set-Cookie JSON', '{"set-cookie": "zq9Xv7hunterK3"}'],
])('T77-H5: %s', (_n, texto) => {
  const out = redact(texto);
  expect(out).not.toContain('zq9Xv7'); expect(redact(out)).toBe(out);
});

// Entradas patológicas para regexes con retroceso. Cada regla de RULES se mide sola: con 4× la entrada, un coste lineal tarda ~4× y uno cuadrático ~16×.
const PATOLOGICAS: Record<string, (n: number) => string> = {
  guiones: n => '-'.repeat(n), 'a-': n => 'a-'.repeat(n / 2), '--a': n => '--a'.repeat(n / 3), '--token': n => '--token'.repeat(n / 7), 'x_token-': n => 'x_token-'.repeat(n / 8),
  espacios: n => ' '.repeat(n), 'Cookie: + espacios': n => 'Cookie:' + ' '.repeat(n), 'Cookie: x repetido': n => 'Cookie: x '.repeat(n / 10),
  'token=': n => 'token='.repeat(n / 6), comillas: n => '"'.repeat(n), 'comilla escapada': n => '\\"'.repeat(n / 2), curl: n => 'curl '.repeat(n / 5), 'curl -x': n => 'curl -x '.repeat(n / 8),
  'url con :': n => 'http://a:a'.repeat(n / 10), 'url con :a:a': n => 'http://' + 'a:'.repeat(n / 2), 'PEM sin cierre': n => '-----BEGIN PRIVATE KEY-----\n'.repeat(n / 28),
  'authorization:': n => 'authorization:'.repeat(n / 14), 'authorization + espacios': n => 'authorization:' + ' '.repeat(n), 'pwd=': n => 'pwd='.repeat(n / 4), 'pass:': n => 'pass:'.repeat(n / 5),
  Bearer: n => 'Bearer '.repeat(n / 7), letras: n => 'a'.repeat(n), jwt: n => 'eyJ' + 'a.'.repeat(n / 2), 'clave larga': n => 'a_'.repeat(n / 2) + 'token',
  "password: '": n => "password: '".repeat(n / 11), 'valor con salto': n => 'password="a\n'.repeat(n / 12),
};
const mejor = (f: () => void) => { let t = Infinity; for (let i = 0; i < 2; i++) { const t0 = performance.now(); f(); t = Math.min(t, performance.now() - t0); } return t; };

test('T77-H1/P2-H1: ninguna regla de RULES es cuadrática con entradas patológicas (crece con la entrada, no con su cuadrado)', () => {
  const lentas: string[] = [];
  RULES.forEach((regla, i) => {
    for (const [nombre, gen] of Object.entries(PATOLOGICAS)) {
      const pequena = gen(16384), grande = gen(65536);
      const t1 = mejor(() => regla(pequena)), t4 = mejor(() => regla(grande));
      // Por debajo de 50 ms no hay nada que medir; por encima, 4× la entrada no puede costar más de ~9×.
      if (t4 > 50 && t4 / Math.max(t1, 2) > 9) lentas.push(`regla ${i} · ${nombre}: ${t1.toFixed(0)} ms → ${t4.toFixed(0)} ms`);
    }
  });
  expect(lentas).toEqual([]);
});

test.each([
  ['URL con &', 'curl "https://api.x/v1?a=1&b=2" -u admin:zq9Xv7hunterK3'], ['cabecera con ;', 'curl -H "Accept: text/html;q=0.9" -u admin:zq9Xv7hunterK3 https://x'],
  ['comilla con |', "curl 'https://x/?f=a|b' --user admin:zq9Xv7hunterK3"],
])('P2-H2: curl -u con %s no deja salir la credencial', (_n, texto) => {
  expect(redact(texto)).not.toContain('zq9Xv7');
});
test('P2-H2: un -u de otro comando tras && o | no se toca', () => {
  for (const t of ['curl https://x.test && tar -u f', 'curl https://x.test | sort -u', 'curl https://x.test ; cp -u a b']) expect(redact(t)).toBe(t);
});
