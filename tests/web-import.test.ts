// T105: importar un perfil o una definición empaquetada desde la web.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDefinition, buildDefinition, exportDefinition, readDefinition } from '../src/definition.ts';
import { defaultProfile, DEFAULT_DIGEST, listProfiles, profileDigest } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { ACTIONS } from '../src/web-actions.ts';
import { DEFAULT_PROTECTED_PATHS } from '../src/validators/integrity.ts';

let dir: string, repo: string, store: Store, server: ReturnType<typeof startWeb>, cookie: string, csrf: string;
const base = () => `http://${server.host ?? '127.0.0.1'}:${server.port}`;
const req = (path: string, init?: RequestInit) => fetch(base() + path, { redirect: 'manual', ...init });
async function login() {
  const r = await fetch(server.loginUrl!, { redirect: 'manual' });
  cookie = r.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([^"]+)"/.exec(await (await req('/perfiles', { headers: { cookie } })).text())![1]!;
}
beforeEach(async () => {
  dir = mkdtempSync('/tmp/fab-web-import-'); repo = join(dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
  store = new Store(join(dir, 'fabrica.db'));
  store.createWorkstream({ slug: 'prueba', goal: 'g', repo });
  server = startWeb(dir, 0, { write: true }); await login();
});
afterEach(() => { server?.stop(true); store?.close(); rmSync(dir, { recursive: true, force: true }); });

// ---- ayudas ------------------------------------------------------------------------------------------------------
type Entry = { name: string; data?: string | Uint8Array; type?: string; prefix?: string; linkname?: string };
function tar(entries: Entry[], opts: { badSum?: boolean; trailing?: boolean } = {}): Uint8Array {
  const out: Uint8Array[] = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? Buffer.from(e.data) : Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write(e.type ?? '0', 156); if (e.linkname) h.write(e.linkname, 157, 'latin1');
    h.write('ustar\0', 257); h.write('00', 263); if (e.prefix) h.write(e.prefix, 345, 'latin1');
    h.fill(32, 148, 156);
    const sum = h.reduce((a, b) => a + b, 0) + (opts.badSum ? 1 : 0);
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    out.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  if (opts.trailing) out.push(Buffer.from('basura'.padEnd(512, 'x')));
  return new Uint8Array(Buffer.concat(out));
}
const treeOf = (files: Map<string, string>): Entry[] => [...files].map(([name, data]) => ({ name, data }));
const goodFiles = () => {
  const p = defaultProfile();
  const f = new Map<string, string>();
  f.set('workstream.json', JSON.stringify({ slug: 'importado', goal: 'meta importada', agent: 'native' }));
  const { worker, validators, ...rest } = p;
  f.set('profile/profile.json', JSON.stringify(rest));
  for (const [k, v] of Object.entries(worker)) f.set(`profile/worker/${k}.md`, v);
  for (const [k, v] of Object.entries(validators)) f.set(`profile/validators/${k}.md`, v);
  return f;
};
const goodTar = (edit?: (f: Map<string, string>) => void) => { const f = goodFiles(); edit?.(f); return tar(treeOf(f)); };

const upload = (path: string, fields: Record<string, string>, file?: Uint8Array | null, extra?: (fd: FormData) => void, headers: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.set('csrf', csrf); for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set('package', new Blob([file as BlobPart]), 'paquete');
  extra?.(fd);
  return req(path, { method: 'POST', headers: { cookie, origin: base(), ...headers }, body: fd });
};
const confirmFrom = async (preview: Response, path: string, over: Record<string, string> = {}) => {
  const html = await preview.text();
  const inputs = Object.fromEntries([...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!.replace(/&amp;/g, '&')]));
  return req(path, { method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...inputs, confirm: 'yes', ...over }) });
};
const profileJson = (over: Record<string, unknown> = {}) => { const p = defaultProfile(); return new TextEncoder().encode(JSON.stringify({ ...p, worker: { ...p.worker, investigate: p.worker.investigate + '\nRegla importada.' }, ...over })); };
const events = () => store.db.query('SELECT actor, message FROM events ORDER BY id').all() as { actor: string; message: string }[];
const snapshot = () => JSON.stringify([listProfiles(dir), store.listWorkstreams().map(w => w.slug), events().length]);

// ---- perfil ------------------------------------------------------------------------------------------------------
test('perfil: la vista previa no escribe nada y muestra digest y diferencias; confirmar guarda y audita con actor web', async () => {
  const before = snapshot();
  const preview = await upload('/perfiles/importar', { ws: 'prueba' }, profileJson());
  expect(preview.status).toBe(200);
  const html = await preview.clone().text();
  expect(html).toContain('Nuevo'); expect(html).toContain('worker.investigate'); expect(html).toContain('Regla importada.');
  expect(snapshot()).toBe(before);
  const done = await confirmFrom(preview, '/perfiles/importar');
  expect(done.status).toBe(303);
  const digest = /digest=([0-9a-f]{64})&nuevo=1/.exec(done.headers.get('location')!)![1]!;
  expect(listProfiles(dir)).toContain(digest);
  expect(store.getWorkstream('prueba').profile).toBeNull(); // no se asigna
  expect(events().at(-1)).toEqual({ actor: 'web', message: `perfil importado desde la web: ${digest}` });
});

test('perfil: reimportar el mismo digest es idempotente y se anota', async () => {
  await confirmFrom(await upload('/perfiles/importar', { ws: 'prueba' }, profileJson()), '/perfiles/importar');
  const again = await confirmFrom(await upload('/perfiles/importar', { ws: 'prueba' }, profileJson()), '/perfiles/importar');
  expect(again.headers.get('location')).toContain('nuevo=0');
  expect(events().at(-1)!.message).toContain('(ya existía)');
});

test('perfil inválido: 400 en la vista previa y al confirmar, sin escribir', async () => {
  const before = snapshot();
  const bads: Uint8Array[] = [new TextEncoder().encode('no es json'), new TextEncoder().encode('[]'), new Uint8Array([0xff, 0xfe]),
    profileJson({ schemaVersion: 9 }), profileJson({ harness: 'inexistente' }), profileJson({ extra: 1 }),
    new TextEncoder().encode(JSON.stringify({ ...defaultProfile(), worker: { ...defaultProfile().worker, rules: 'x'.repeat(40_000) } }))];
  for (const b of bads) expect((await upload('/perfiles/importar', { ws: 'prueba' }, b)).status).toBe(400);
  // El paso 2 no se fía de la vista previa: se vuelve a validar un payload manipulado.
  const good = await upload('/perfiles/importar', { ws: 'prueba' }, profileJson());
  for (const payload of [Buffer.from('{"schemaVersion":9}').toString('base64'), 'no-es-base64!', '']) {
    expect((await confirmFrom(good.clone(), '/perfiles/importar', { payload })).status).toBe(400);
  }
  expect((await confirmFrom(good.clone(), '/perfiles/importar', { payload: Buffer.from(profileJson({ model: undefined, harness: 'native' })).toString('base64'), digest: 'a'.repeat(64) })).status).toBe(400);
  expect(snapshot()).toBe(before);
});

test('perfil: workstream inexistente 404; confirmación, campos y partes inesperados 400, sin escribir', async () => {
  const before = snapshot();
  expect((await upload('/perfiles/importar', { ws: 'nada' }, profileJson())).status).toBe(404);
  const good = await upload('/perfiles/importar', { ws: 'prueba' }, profileJson());
  expect((await confirmFrom(good.clone(), '/perfiles/importar', { confirm: 'no' })).status).toBe(400);
  expect((await confirmFrom(good.clone(), '/perfiles/importar', { extra: 'x' })).status).toBe(400);
  expect((await upload('/perfiles/importar', { ws: 'prueba' }, null)).status).toBe(400);
  expect((await upload('/perfiles/importar', { ws: 'prueba' }, profileJson(), fd => fd.append('ws', 'otra'))).status).toBe(400);
  expect((await upload('/perfiles/importar', { ws: 'prueba' }, profileJson(), fd => fd.set('otra', 'x'))).status).toBe(400);
  expect((await upload('/perfiles/importar', { ws: 'prueba' }, profileJson(), fd => fd.append('package', new Blob(['x']), 'otro'))).status).toBe(400);
  expect((await upload('/perfiles/importar', { ws: 'prueba' }, new Uint8Array(600 * 1024))).status).toBe(413);
  expect(snapshot()).toBe(before);
});

test('sesión, CSRF, Origin y --write: sin ellos no se importa', async () => {
  const fd = () => { const f = new FormData(); f.set('csrf', csrf); f.set('ws', 'prueba'); f.set('package', new Blob([profileJson() as BlobPart]), 'p'); return f; };
  expect((await req('/perfiles/importar', { method: 'POST', headers: { origin: base() }, body: fd() })).status).toBe(401);
  const bad = fd(); bad.set('csrf', 'x'.repeat(20));
  expect((await req('/perfiles/importar', { method: 'POST', headers: { cookie, origin: base() }, body: bad })).status).toBe(403);
  expect((await req('/perfiles/importar', { method: 'POST', headers: { cookie, origin: 'http://evil.test' }, body: fd() })).status).toBe(403);
  server.stop(true); server = startWeb(dir, 0);
  expect((await req('/definicion/importar', { method: 'POST', body: fd() })).status).toBe(405);
  expect(listProfiles(dir)).toEqual([]);
});

test('la API no expone la importación y la CLI puede lo mismo', () => {
  expect(ACTIONS['perfiles/importar']!.api).toBe(false); expect(ACTIONS['definicion/importar']!.api).toBe(false);
});

test('las páginas ofrecen los formularios con sesión de escritura y escapan lo del paquete', async () => {
  expect(await (await req('/perfiles', { headers: { cookie } })).text()).toContain('action="/perfiles/importar"');
  expect(await (await req('/definicion', { headers: { cookie } })).text()).toContain('action="/definicion/importar"');
  const xss = await upload('/definicion/importar', { repo, slug: '' }, goodTar(f => { f.set('workstream.json', JSON.stringify({ slug: 'x', goal: '<script>alert(1)</script>' })); }));
  const html = await xss.text();
  expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>alert');
});

// ---- definición --------------------------------------------------------------------------------------------------
test('definición: vista previa sin escribir; confirmar crea el workstream en borrador con perfil y auditoría web; nada se ejecuta', async () => {
  const canary = join(dir, 'CANARIO');
  const bytes = goodTar(f => { f.set('workstream.json', JSON.stringify({ slug: 'importado', goal: 'meta' })); f.set('skills/util/SKILL.md', 'texto'); });
  const before = snapshot();
  const preview = await upload('/definicion/importar', { repo, slug: '' }, bytes);
  expect(preview.status).toBe(200);
  const html = await preview.clone().text();
  expect(html).toContain('importado'); expect(html).toContain('skills/util/SKILL.md'); expect(html).toContain('no se escriben en el repo');
  expect(snapshot()).toBe(before);
  const done = await confirmFrom(preview, '/definicion/importar');
  expect(done.status).toBe(303);
  const ws = store.getWorkstream('importado');
  expect(ws).toMatchObject({ state: 'draft', repo, goal: 'meta' });
  expect(ws.profile).toBeNull() ; // perfil por defecto → sin fijar
  expect(existsSync(canary)).toBe(false);
  // La CLI sí admite verify; importar tampoco lo ejecuta.
  const cli = goodFiles(); cli.set('workstream.json', JSON.stringify({ slug: 'por-cli', goal: 'g', verify: [`touch ${canary}`] }));
  applyDefinition(store, dir, parseDefinition(cli), repo);
  expect(existsSync(canary)).toBe(false); expect(store.getWorkstream('por-cli').verify).toEqual([['touch', canary]]);
  expect(existsSync(join(repo, '.agents'))).toBe(false);
  const mine = events().filter(e => e.message.includes('importado') || e.message.includes('definición importada'));
  expect(mine.length).toBe(2); expect(mine.every(e => e.actor === 'web')).toBe(true);
});

test('definición: el paquete exportado por la CLI se importa igual que el directorio', async () => {
  const out = join(dir, 'tree');
  exportDefinition(store, dir, 'prueba', out);
  const files = new Map<string, string>(); for (const f of readdirSync(out, { recursive: true, withFileTypes: true })) if (f.isFile()) { const p = join(f.parentPath, f.name); files.set(p.slice(out.length + 1), readFileSync(p, 'utf8')); }
  const tarPath = join(dir, 'def.tar'); writeFileSync(tarPath, tar(treeOf(files)));
  expect(readDefinition(tarPath)).toEqual(readDefinition(out)); // paridad CLI: dir y .tar dan lo mismo
  const done = await confirmFrom(await upload('/definicion/importar', { repo, slug: 'copia' }, readFileSync(tarPath)), '/definicion/importar');
  expect(done.status).toBe(303);
  expect(buildDefinition(store, dir, 'copia').get('profile/profile.json')).toBe(buildDefinition(store, dir, 'prueba').get('profile/profile.json'));
  expect(profileDigest(readDefinition(out).profile)).toBe(DEFAULT_DIGEST);
});

const hostile: [string, Uint8Array][] = [
  ['symlink', tar([...treeOf(goodFiles()), { name: 'skills/x/SKILL.md', type: '2', linkname: '/etc/passwd' }])],
  ['symlink a ancestro', tar([{ name: 'skills', type: '2', linkname: '/etc' }, ...treeOf(goodFiles())])],
  ['hardlink', tar([...treeOf(goodFiles()), { name: 'skills/x/SKILL.md', type: '1', linkname: 'workstream.json' }])],
  ['ruta absoluta', tar([...treeOf(goodFiles()), { name: '/etc/cron.d/x', data: 'x' }])],
  ['..', tar([...treeOf(goodFiles()), { name: '../fuera.md', data: 'x' }])],
  ['.. interno', tar([...treeOf(goodFiles()), { name: 'skills/../../fuera/SKILL.md', data: 'x' }])],
  ['barra invertida', tar([...treeOf(goodFiles()), { name: 'skills\\..\\x', data: 'x' }])],
  ['directorio con ..', tar([{ name: '../', type: '5' }, ...treeOf(goodFiles())])],
  ['cabecera pax', tar([{ name: 'pax', type: 'x', data: '30 mtime=1\n' }, ...treeOf(goodFiles())])],
  ['nombre largo GNU', tar([{ name: '././@LongLink', type: 'L', data: 'x'.repeat(200) }, ...treeOf(goodFiles())])],
  ['prefijo ustar', tar([{ name: 'a.md', prefix: '../..', data: 'x' }, ...treeOf(goodFiles())])],
  ['dispositivo', tar([...treeOf(goodFiles()), { name: 'dev', type: '3' }])],
  ['checksum roto', tar(treeOf(goodFiles()), { badSum: true })],
  ['datos tras el final', tar(treeOf(goodFiles()), { trailing: true })],
  ['truncado', goodTar().subarray(0, 512 * 3)],
  ['no es tar', new TextEncoder().encode('hola'.padEnd(2048, ' '))],
  ['repetido', tar([...treeOf(goodFiles()), { name: 'workstream.json', data: '{}' }])],
  ['fichero desconocido', tar([...treeOf(goodFiles()), { name: 'run.sh', data: 'rm -rf /' }])],
  ['falta un fichero', tar(treeOf(goodFiles()).slice(1))],
  ['UTF-8 roto', tar([...treeOf(goodFiles()).slice(0, 3), { name: 'profile/worker/rules.md', data: new Uint8Array([0xff, 0xfe]) }, ...treeOf(goodFiles()).slice(4)])],
  ['demasiadas entradas', tar([...treeOf(goodFiles()), ...Array.from({ length: 60 }, (_, i) => ({ name: `skills/s${i}/SKILL.md`, data: 'x' }))])],
  ['skill enorme', tar([...treeOf(goodFiles()), { name: 'skills/x/SKILL.md', data: 'x'.repeat(65_537) }])],
];
test.each(hostile)('definición hostil (%s): 400 en la vista previa y al confirmar, sin escribir', async (_n, bytes) => {
  const before = snapshot();
  expect((await upload('/definicion/importar', { repo, slug: '' }, bytes)).status).toBe(400);
  // Un payload manipulado en el paso 2 se revalida igual.
  const good = await upload('/definicion/importar', { repo, slug: '' }, goodTar());
  expect((await confirmFrom(good, '/definicion/importar', { payload: Buffer.from(bytes).toString('base64') })).status).toBe(400);
  expect(snapshot()).toBe(before);
});

test('definición: D-F, sin bajar aprobaciones ni vaciar rutas protegidas desde la web', async () => {
  const before = snapshot();
  for (const extra of [{ requireApproval: false }, { requireChangeApproval: false }, { protectedPaths: [] }]) {
    const bytes = goodTar(f => { f.set('workstream.json', JSON.stringify({ slug: 'x', goal: 'g', ...extra })); });
    expect((await upload('/definicion/importar', { repo, slug: '' }, bytes)).status).toBe(400);
  }
  expect(snapshot()).toBe(before);
  const ok = goodTar(f => { f.set('workstream.json', JSON.stringify({ slug: 'x', goal: 'g', requireApproval: true, requireChangeApproval: true, workerConcurrency: 2, taskLimit: 20, verify: [], verifySetup: [], protectedPaths: [...DEFAULT_PROTECTED_PATHS] })); });
  expect((await upload('/definicion/importar', { repo, slug: '' }, ok)).status).toBe(200);
});

test('definición: destino inválido (repo, slug) o slug ya existente no crea nada', async () => {
  const before = snapshot();
  const bytes = goodTar();
  for (const fields of [{ repo: 'relativa', slug: '' }, { repo: join(dir, 'no-existe'), slug: '' }, { repo: dir, slug: '' }, { repo, slug: 'Mal Slug' }]) {
    expect((await upload('/definicion/importar', fields, bytes)).status).toBe(400);
  }
  // Slug existente: la vista previa lo avisa y no ofrece confirmar; forzar el paso 2 da 400.
  const taken = await upload('/definicion/importar', { repo, slug: 'prueba' }, bytes);
  const html = await taken.clone().text();
  expect(html).toContain('Ya existe un workstream'); expect(html).not.toContain('Confirmar importación');
  expect((await confirmFrom(await upload('/definicion/importar', { repo, slug: 'otro' }, bytes), '/definicion/importar', { slug: 'prueba' })).status).toBe(400);
  expect(snapshot()).toBe(before);
});

// ---- lector de tar: cada regla por sí sola (la vista previa tiene una segunda línea de defensa en el esquema) ------------
import { readTar } from '../src/definition-tar.ts';
test.each([
  ['ruta absoluta', [{ name: '/a.md', data: 'x' }]], ['barra invertida', [{ name: 'a\\b.md', data: 'x' }]], ['segmento vacío', [{ name: 'a//b.md', data: 'x' }]],
  ['.. final', [{ name: 'a/..', data: 'x' }]], ['prefijo ustar', [{ name: 'a.md', prefix: 'p', data: 'x' }]], ['repetido', [{ name: 'a.md', data: 'x' }, { name: 'a.md', data: 'y' }]],
  ['fichero grande', [{ name: 'a.md', data: 'x'.repeat(65_537) }]], ['UTF-8 roto', [{ name: 'a.md', data: new Uint8Array([0xff]) }]], ['NUL', [{ name: 'a.md', data: 'a\0b' }]],
] as [string, Entry[]][])('readTar rechaza %s', (_n, entries) => { expect(() => readTar(tar(entries))).toThrow(/paquete|ruta|supera|repetido|UTF-8|texto|prefijo/); });
test('readTar acepta ./ y directorios y devuelve ruta → texto', () => {
  expect([...readTar(tar([{ name: './', type: '5' }, { name: './a/', type: '5' }, { name: './a/b.md', data: 'hola ñ' }]))]).toEqual([['a/b.md', 'hola ñ']]);
});

test('confirmar una definición distinta de la vista previa (digest) o con campos repetidos da 400', async () => {
  const before = snapshot();
  const other = goodTar(f => { const p = JSON.parse(f.get('profile/profile.json')!); p.model = undefined; f.set('profile/worker/rules.md', f.get('profile/worker/rules.md')! + '\nOtra regla.'); });
  const preview = await upload('/definicion/importar', { repo, slug: '' }, goodTar());
  expect((await confirmFrom(preview, '/definicion/importar', { payload: Buffer.from(other).toString('base64') })).status).toBe(400);
  expect((await upload('/definicion/importar', { repo, slug: '' }, goodTar(), fd => fd.append('repo', repo))).status).toBe(400);
  expect(snapshot()).toBe(before);
});

test('confirmar con un campo urlencoded repetido da 400', async () => {
  const preview = await (await upload('/definicion/importar', { repo, slug: '' }, goodTar())).text();
  const hidden = Object.fromEntries([...preview.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  const body = new URLSearchParams({ ...hidden, confirm: 'yes' }); body.append('repo', join(dir, 'otro'));
  const r = await req('/definicion/importar', { method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body });
  expect(r.status).toBe(400); expect(store.listWorkstreams().map(w => w.slug)).toEqual(['prueba']);
});

// ---- T105-H1 / H5: el tipo de cada ajuste se valida en parseDefinition; la web solo admite ausente o true -----------------
import { parseDefinition } from '../src/definition.ts';
const withSettings = (extra: Record<string, unknown>) => { const f = goodFiles(); f.set('workstream.json', JSON.stringify({ slug: 'x', goal: 'g', ...extra })); return f; };
const BAD_TYPES: Record<string, unknown>[] = [
  { requireApproval: 0 }, { requireApproval: '' }, { requireApproval: 'false' }, { requireApproval: null }, { requireChangeApproval: 0 }, { requireChangeApproval: 'no' },
  { protectedPaths: {} }, { protectedPaths: 'x' }, { protectedPaths: [1] }, { workerConcurrency: '2' }, { taskLimit: 1.5 }, { verify: 'bun test' }, { verifySetup: [null] },
];
test.each(BAD_TYPES)('parseDefinition rechaza el tipo de %j (también la CLI)', extra => {
  expect(() => parseDefinition(withSettings(extra))).toThrow(/workstream\.json/);
});
test.each(BAD_TYPES.slice(0, 6))('la web rechaza %j con 400 y no crea el workstream (T105-H1)', async extra => {
  const before = snapshot();
  const bytes = tar(treeOf(withSettings(extra)));
  expect((await upload('/definicion/importar', { repo, slug: '' }, bytes)).status).toBe(400);
  const good = await upload('/definicion/importar', { repo, slug: '' }, goodTar());
  expect((await confirmFrom(good, '/definicion/importar', { payload: Buffer.from(bytes).toString('base64') })).status).toBe(400);
  expect(snapshot()).toBe(before);
});

// ---- T105-H8: la web no fija por importación lo que el asistente web no ofrece (D-F); eso es solo de la CLI -----------------
test.each([{ verify: ['bun test'] }, { verifySetup: ['bun install'] }, { protectedPaths: ['secrets/**'] }, { workerConcurrency: 8 }, { taskLimit: 500 }, { agent: 'fake', verify: ['x'] }] as Record<string, unknown>[])(
  'la web rechaza %j (solo por CLI) y la CLI lo acepta', async extra => {
    const before = snapshot();
    const files = withSettings(extra);
    expect((await upload('/definicion/importar', { repo, slug: '' }, tar(treeOf(files)))).status).toBe(400);
    expect(() => parseDefinition(files)).not.toThrow(); // la CLI sigue pudiendo
    expect(snapshot()).toBe(before);
  });

// ---- T105-H2: la confirmación queda ligada a lo que la vista previa mostró (sello del servidor sobre paquete, repo y slug) ---
const hiddenOf = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
const post2 = (path: string, fields: Record<string, string>) => req(path, { method: 'POST', headers: { cookie, origin: base(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
test('H2: otro paquete, otro repo u otro slug con el sello de otra vista previa dan 400; sin vista previa también', async () => {
  const before = snapshot();
  const otherRepo = join(dir, 'otro-repo'); mkdirSync(join(otherRepo, '.git'), { recursive: true });
  const a = goodTar(), b = goodTar(f => { f.set('workstream.json', JSON.stringify({ slug: 'importado', goal: 'OTRA META' })); });
  const h = hiddenOf(await (await upload('/definicion/importar', { repo, slug: '' }, a)).text());
  const b64 = (x: Uint8Array) => Buffer.from(x).toString('base64');
  expect((await post2('/definicion/importar', { ...h, confirm: 'yes', payload: b64(b) })).status).toBe(400); // mismo perfil, otro workstream.json
  expect((await post2('/definicion/importar', { ...h, confirm: 'yes', repo: otherRepo })).status).toBe(400);
  expect((await post2('/definicion/importar', { ...h, confirm: 'yes', slug: 'otro-slug' })).status).toBe(400);
  expect((await post2('/definicion/importar', { csrf, repo, slug: '', payload: b64(a), digest: profileDigest(defaultProfile()), confirm: 'yes' })).status).toBe(400); // sin vista previa
  const p = hiddenOf(await (await upload('/perfiles/importar', { ws: 'prueba' }, profileJson())).text());
  expect((await post2('/perfiles/importar', { ...p, confirm: 'yes', payload: b64(profileJson({ model: undefined, harness: 'native', repo: 'x' })) })).status).toBe(400);
  expect(snapshot()).toBe(before);
  expect((await post2('/definicion/importar', { ...h, confirm: 'yes' })).status).toBe(303); // el sello propio sí vale
});
test('H2: un repo con comillas no rompe el atributo oculto y se importa', async () => {
  const odd = join(dir, 'a"b<c'); mkdirSync(join(odd, '.git'), { recursive: true });
  const preview = await upload('/definicion/importar', { repo: odd, slug: '' }, goodTar());
  const html = await preview.clone().text();
  expect(html).toContain('a&quot;b&lt;c');
  expect((await confirmFrom(preview, '/definicion/importar', { repo: odd })).status).toBe(303);
  expect(store.getWorkstream('importado').repo).toBe(odd);
});

// ---- T105-H3: la vista previa enseña lo que se importa (prompts del perfil y skills), completo y escapado ------------------
test('H3: la vista previa de una definición muestra los cambios del perfil y el texto de las skills', async () => {
  const bytes = goodTar(f => {
    f.set('profile/worker/rules.md', f.get('profile/worker/rules.md')! + '\nINSTRUCCION-NUEVA <b>x</b>');
    f.set('skills/util/SKILL.md', 'CUERPO-DE-SKILL <i>y</i>');
  });
  const html = await (await upload('/definicion/importar', { repo, slug: '' }, bytes)).text();
  expect(html).toContain('INSTRUCCION-NUEVA &lt;b&gt;x&lt;/b&gt;'); expect(html).toContain('CUERPO-DE-SKILL &lt;i&gt;y&lt;/i&gt;');
  expect(html).not.toContain('<b>x</b>'); expect(html).not.toContain('<i>y</i>');
});
test('H3: un cambio pasado el carácter 2000 de una plantilla se ve en la vista previa del perfil', async () => {
  const p = defaultProfile(); p.worker.rules = 'palabra '.repeat(400) + '\nFINAL-ESCONDIDO\n' + defaultProfile().worker.rules;
  const html = await (await upload('/perfiles/importar', { ws: 'prueba' }, new TextEncoder().encode(JSON.stringify(p)))).text();
  expect(html).toContain('FINAL-ESCONDIDO');
});

// ---- T105-H4: el texto del paquete no llega crudo a la terminal por la CLI ---------------------------------------------------
test.each(['a\x1b]0;TITULO\x07\x1b[2J.md', 'c\u009b31m.md', 'd‮.md', 'e\x7f.md'])('H4: un nombre hostil %j no sale crudo en el error de readTar', name => {
  for (const entry of [{ name, type: '2', linkname: 'x' }, { name, data: 'x' }, { name: 'a.md', prefix: name, data: 'x' }] as Entry[]) {
    let msg = ''; try { readTar(tar([entry])); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toBe(''); expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮]/);
  }
});
test('H4: un fichero desconocido con nombre hostil en un directorio tampoco sale crudo (CLI)', () => {
  const d = join(dir, 'hostil'); mkdirSync(d); for (const [p, t] of goodFiles()) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), t); }
  writeFileSync(join(d, 'x\x1b[2J.md'), 'x');
  let msg = ''; try { readDefinition(d); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain('desconocido'); expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
});
