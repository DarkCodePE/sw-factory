import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDefinition } from '../src/definition.ts';
import { defaultProfile, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { FILE_VIEW_LIMIT } from '../src/web-definition.ts';

let dir: string;
let stateDir: string;
let repoDir: string;
let store: Store;
let server: ReturnType<typeof startWeb> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-def-test-'));
  stateDir = join(dir, 'state');
  repoDir = join(dir, 'repo');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(repoDir, '.agents', 'skills', 'lint'), { recursive: true });
  writeFileSync(join(repoDir, '.agents', 'skills', 'lint', 'SKILL.md'), 'instrucciones de lint');
  store = new Store(join(stateDir, 'fabrica.db'));
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedWorkstream(opts: { slug?: string; bigSkill?: boolean } = {}): { slug: string; digest: string } {
  const slug = opts.slug ?? 'demo';
  if (opts.bigSkill) {
    mkdirSync(join(repoDir, '.agents', 'skills', 'grande'), { recursive: true });
    writeFileSync(
      join(repoDir, '.agents', 'skills', 'grande', 'SKILL.md'),
      '# Skill grande\n' + 'B'.repeat(FILE_VIEW_LIMIT + 5000),
    );
  }
  const prof: any = {
    ...defaultProfile(),
    schemaVersion: 2,
    harness: 'claude',
    roles: { implement: { harness: 'claude', env: ['GH_TOKEN', 'API_KEY'], mcp: ['docs-server'] } },
    worker: {
      ...defaultProfile().worker,
      rules: defaultProfile().worker.rules + '\n# Reglas específicas del worker\nNo romper tests.',
    },
  };
  const { digest } = saveProfile(stateDir, prof);
  store.createWorkstream({
    slug,
    goal: 'Construir plataforma',
    repo: repoDir,
    profile: digest,
    verify: ["bun test 'a b'"],
    protectedPaths: ['src/seguridad/**'],
  });
  return { slug, digest };
}

async function request(path = '/definicion', method = 'GET'): Promise<Response> {
  return fetch(`http://127.0.0.1:${server!.port}${path}`, { method, redirect: 'manual' });
}

async function getHtml(path = '/definicion'): Promise<string> {
  const res = await request(path);
  expect(res.status).toBe(200);
  return res.text();
}

test('coincide exactamente con fab definition export y muestra el contenido de cada fichero', async () => {
  const { slug } = seedWorkstream();
  server = startWeb(stateDir, 0);

  // Exportar con fab definition export a un directorio en disco
  const exportTarget = join(dir, 'exported-tree');
  const exportedFiles = exportDefinition(store, stateDir, slug, exportTarget);

  // Leer la página web
  const html = await getHtml(`/definicion?ws=${slug}`);

  expect(html).toContain('Árbol de definición · demo');
  expect(html).toContain(`Ficheros en el árbol: <strong>${exportedFiles.length}</strong>`);

  // Cada fichero exportado debe figurar en la web con su ruta y su contenido idéntico
  for (const relPath of exportedFiles) {
    expect(html).toContain(`<code>${relPath}</code>`);
    const diskContent = readFileSync(join(exportTarget, relPath), 'utf8');
    // El contenido escapado debe estar en el HTML
    const sample = diskContent.slice(0, 40).replace(/"/g, '&quot;').trim();
    if (sample) expect(html).toContain(sample);
  }

  expect(html).toContain('skills/lint/SKILL.md');
  expect(html).toContain('instrucciones de lint');
  expect(html).toContain('workstream.json');
  expect(html).toContain('profile/profile.json');
});

test('el árbol no contiene rutas absolutas ni valores de entorno', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const html = await getHtml('/definicion?ws=demo');

  // No debe contener rutas locales del host (repoDir, stateDir, ni dir)
  expect(html).not.toContain(repoDir);
  expect(html).not.toContain(stateDir);
  expect(html).not.toContain(dir);

  // Solo nombres de variables de entorno en profile.json, nunca valores secretos
  expect(html).toContain('GH_TOKEN');
  expect(html).toContain('API_KEY');
});

test('un fichero grande se trunca con aviso', async () => {
  seedWorkstream({ bigSkill: true });
  server = startWeb(stateDir, 0);

  const html = await getHtml('/definicion?ws=demo');

  expect(html).toContain('Fichero grande truncado para visualización');
  expect(html).toContain(`mostrando ${Math.round(FILE_VIEW_LIMIT / 1024)} KiB`);
  expect(html).toContain('El fichero íntegro se conserva en <code>fab definition export</code>');
  // No debe contener los 5000 bytes extra pasados del corte
  expect(html).not.toContain('B'.repeat(FILE_VIEW_LIMIT + 100));
});

test('la página no escribe en disco', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const getSnapshot = () => ({
    stateFiles: readdirSync(stateDir).sort(),
    repoFiles: readdirSync(repoDir).sort(),
  });

  const before = getSnapshot();

  // Hacer múltiples peticiones
  await getHtml('/definicion');
  await getHtml('/definicion?ws=demo');
  await getHtml('/definicion?ws=demo#file-workstream.json');

  const after = getSnapshot();

  expect(after).toEqual(before);
  // Verificar que no se creó ninguna carpeta de exportación en stateDir ni repoDir
  expect(existsSync(join(stateDir, 'workstream.json'))).toBe(false);
  expect(existsSync(join(repoDir, 'workstream.json'))).toBe(false);
});

test('solo lectura: POST devuelve 405', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const res = await request('/definicion', 'POST');
  expect(res.status).toBe(405);
  expect(res.headers.get('allow')).toBe('GET, HEAD');

  // Con sesión de escritura sigue siendo 405
  server.stop(true);
  server = startWeb(stateDir, 0, { write: true });
  const resWrite = await fetch(`http://${server.host}:${server.port}/definicion`, {
    method: 'POST',
    headers: { host: `${server.host}:${server.port}` },
  });
  expect(resWrite.status).toBe(405);
  expect(resWrite.headers.get('allow')).toBe('GET, HEAD');
});

test('sin workstreams muestra mensaje vacío', async () => {
  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion');
  expect(html).toContain('No hay workstreams');
});

test('workstream desconocido muestra aviso adecuado', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=fantasma');
  expect(html).toContain('Workstream no encontrado: fantasma');
  expect(html).toContain('Volver a la definición por defecto');
});

test('/definition redirige 301 a /definicion', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);
  const res = await request('/definition?ws=demo');
  expect(res.status).toBe(301);
  expect(res.headers.get('location')).toBe('/definicion?ws=demo');
});

test('/config enlaza al árbol de definición del workstream seleccionado', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);
  const html = await getHtml('/config?ws=demo');
  expect(html).toContain('href="/definicion?ws=demo"');
  expect(html).toContain('Ver árbol de definición (demo)');
});
