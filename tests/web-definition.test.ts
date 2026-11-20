import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportDefinition } from '../src/definition.ts';
import { defaultProfile, saveProfile } from '../src/profile.ts';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';
import { FILE_VIEW_LIMIT, safeTruncateUtf8 } from '../src/web-definition.ts';

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

function seedWorkstream(opts: { slug?: string; bigSkill?: boolean; verify?: string[] } = {}): { slug: string; digest: string } {
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
    verify: opts.verify ?? ["bun test 'a b'"],
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

  const unescapeHtml = (s: string) => s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  // Cada fichero exportado debe figurar en la web con su ruta y su contenido íntegro idéntico
  for (const relPath of exportedFiles) {
    expect(html).toContain(`<code>${relPath}</code>`);
    const fileId = `file-${encodeURIComponent(relPath)}`;
    const articleRegex = new RegExp(`<article id="${fileId}"[\\s\\S]*?<pre tabindex="0"><code>([\\s\\S]*?)<\\/code><\\/pre>`);
    const match = html.match(articleRegex);
    expect(match).not.toBeNull();
    const renderedContent = unescapeHtml(match![1] ?? '');
    const diskContent = readFileSync(join(exportTarget, relPath), 'utf8');
    expect(renderedContent).toBe(diskContent);
  }

  expect(html).toContain('skills/lint/SKILL.md');
  expect(html).toContain('instrucciones de lint');
  expect(html).toContain('workstream.json');
  expect(html).toContain('profile/profile.json');
});

test('el árbol no contiene rutas absolutas ni valores de entorno', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const CANARY_SECRET_ENV = 'CANARIO_ENVIROMENT_VALOR_SECRETO_987654321';
  process.env.CANARY_SECRET_ENV = CANARY_SECRET_ENV;
  try {
    const html = await getHtml('/definicion?ws=demo');

    // No debe contener rutas locales del host (repoDir, stateDir, dir, homedir)
    expect(html).not.toContain(repoDir);
    expect(html).not.toContain(stateDir);
    expect(html).not.toContain(dir);
    expect(html).not.toContain(homedir());

    // No debe contener valores de variables de entorno ni canarios
    expect(html).not.toContain(CANARY_SECRET_ENV);

    // Solo nombres de variables de entorno en profile.json, nunca valores secretos
    expect(html).toContain('GH_TOKEN');
    expect(html).toContain('API_KEY');
  } finally {
    delete process.env.CANARY_SECRET_ENV;
  }
});

test('error al generar definicion no filtra rutas locales ni el directorio home en el html', async () => {
  seedWorkstream();
  // Crear una skill que contiene una ruta local (el home del usuario)
  const leakSkillDir = join(repoDir, '.agents', 'skills', 'leak');
  mkdirSync(leakSkillDir, { recursive: true });
  writeFileSync(join(leakSkillDir, 'SKILL.md'), `Ruta del home: ${homedir()}`);

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).toContain('No se pudo generar el árbol de definición');
  expect(html).not.toContain(homedir());
  expect(html).not.toContain(repoDir);
});

test('ignora directorios de skills que sean symlinks para evitar directory traversal', async () => {
  seedWorkstream();
  // Crear un directorio externo con un SKILL.md
  const outsideDir = join(dir, 'outside-skill');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'SKILL.md'), 'contenido secreto exterior');

  // Crear un symlink en .agents/skills apuntando al directorio externo
  const symlinkSkill = join(repoDir, '.agents', 'skills', 'traversal-skill');
  symlinkSync(outsideDir, symlinkSkill);

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  // No debe incluir la skill externa que vino a través del symlink
  expect(html).not.toContain('traversal-skill');
  expect(html).not.toContain('contenido secreto exterior');
});

test('ignora skills si .agents es un symlink apuntando fuera del repo', async () => {
  seedWorkstream();
  const outside = join(dir, 'outside-agents');
  mkdirSync(join(outside, 'skills', 'evil-agents-skill'), { recursive: true });
  writeFileSync(join(outside, 'skills', 'evil-agents-skill', 'SKILL.md'), 'secreto en agents symlink');

  rmSync(join(repoDir, '.agents'), { recursive: true, force: true });
  symlinkSync(outside, join(repoDir, '.agents'));

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).not.toContain('evil-agents-skill');
  expect(html).not.toContain('secreto en agents symlink');
});

test('ignora skills si .agents/skills es un symlink apuntando fuera del repo', async () => {
  seedWorkstream();
  const outsideSkills = join(dir, 'outside-skills-dir');
  mkdirSync(join(outsideSkills, 'evil-skills-skill'), { recursive: true });
  writeFileSync(join(outsideSkills, 'evil-skills-skill', 'SKILL.md'), 'secreto en skills symlink');

  rmSync(join(repoDir, '.agents', 'skills'), { recursive: true, force: true });
  symlinkSync(outsideSkills, join(repoDir, '.agents', 'skills'));

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).not.toContain('evil-skills-skill');
  expect(html).not.toContain('secreto en skills symlink');
});

test('ignora archivo SKILL.md si la propia hoja es un symlink a un archivo exterior', async () => {
  seedWorkstream();
  const outsideFile = join(dir, 'outside-secret.md');
  writeFileSync(outsideFile, 'secreto en hoja symlink');

  const leafDir = join(repoDir, '.agents', 'skills', 'leaf-symlink-skill');
  mkdirSync(leafDir, { recursive: true });
  symlinkSync(outsideFile, join(leafDir, 'SKILL.md'));

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).not.toContain('leaf-symlink-skill');
  expect(html).not.toContain('secreto en hoja symlink');
});

test('error genérico no relacionado con rutas locales muestra mensaje neutro', async () => {
  const { digest } = seedWorkstream();
  // Borrar el perfil en stateDir para forzar fallo que no sea de ruta local
  rmSync(join(stateDir, 'profiles', `${digest}.json`), { force: true });

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).toContain('No se pudo generar el árbol de definición: referencia no exportable o error de definición.');
  expect(html).not.toContain('contiene rutas locales');
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

test('el truncado de ficheros grandes respeta la frontera de caracter utf8 sin producir U+FFFD', async () => {
  seedWorkstream();
  // Crear una skill con caracteres multibyte justo en la frontera de FILE_VIEW_LIMIT (32 KiB)
  const padding = 'a'.repeat(FILE_VIEW_LIMIT - 1); // 32767 bytes
  const multibyte = 'ñ'.repeat(10); // 20 bytes (cada 'ñ' ocupa 2 bytes)
  const skillContent = padding + multibyte;

  const utf8SkillDir = join(repoDir, '.agents', 'skills', 'utf8-boundary');
  mkdirSync(utf8SkillDir, { recursive: true });
  writeFileSync(join(utf8SkillDir, 'SKILL.md'), skillContent);

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).toContain('skills/utf8-boundary/SKILL.md');
  expect(html).toContain('Fichero grande truncado para visualización');
  expect(html).not.toContain('\uFFFD');
});

test('safeTruncateUtf8 corta correctamente caracteres multibyte de 2, 3 y 4 bytes en el borde sin corromper utf8 ni U+FFFD', () => {
  // 1. Caracteres de 3 bytes: '€' (0xE2, 0x82, 0xAC)
  const buf3 = Buffer.from('a'.repeat(9) + '€€');
  // Límite en 10 u 11 bytes: solo cabe 1 o 2 bytes de '€', debe cortar en 9
  expect(safeTruncateUtf8(buf3, 10)).toBe('a'.repeat(9));
  expect(safeTruncateUtf8(buf3, 11)).toBe('a'.repeat(9));
  // Límite en 12 bytes: cabe exactamente el primer '€' (9 + 3 = 12)
  expect(safeTruncateUtf8(buf3, 12)).toBe('a'.repeat(9) + '€');
  expect(safeTruncateUtf8(buf3, 12)).not.toContain('\uFFFD');

  // 2. Caracteres de 4 bytes: '🦀' (0xF0, 0x9F, 0xA6, 0x80)
  const buf4 = Buffer.from('a'.repeat(9) + '🦀🦀');
  // Límite en 10, 11 o 12 bytes: solo caben 1, 2 o 3 bytes de '🦀', debe cortar en 9
  expect(safeTruncateUtf8(buf4, 10)).toBe('a'.repeat(9));
  expect(safeTruncateUtf8(buf4, 11)).toBe('a'.repeat(9));
  expect(safeTruncateUtf8(buf4, 12)).toBe('a'.repeat(9));
  // Límite en 13 bytes: cabe exactamente el primer '🦀' (9 + 4 = 13)
  expect(safeTruncateUtf8(buf4, 13)).toBe('a'.repeat(9) + '🦀');
  expect(safeTruncateUtf8(buf4, 13)).not.toContain('\uFFFD');
});

test('el truncado en web con caracteres de 3 y 4 bytes en el borde de 32 KiB no genera U+FFFD', async () => {
  seedWorkstream();
  // Colocar caracteres de 3 bytes ('€') y 4 bytes ('🦀') justo en el límite de 32 KiB
  const padding3 = 'b'.repeat(FILE_VIEW_LIMIT - 2); // 32766 bytes
  const skill3Content = padding3 + '€€€'; // '€' empieza en 32766 y ocupa 3 bytes -> se corta en 32768
  const skill3Dir = join(repoDir, '.agents', 'skills', 'utf8-3byte');
  mkdirSync(skill3Dir, { recursive: true });
  writeFileSync(join(skill3Dir, 'SKILL.md'), skill3Content);

  const padding4 = 'c'.repeat(FILE_VIEW_LIMIT - 2); // 32766 bytes
  const skill4Content = padding4 + '🦀🦀🦀'; // '🦀' empieza en 32766 y ocupa 4 bytes -> se corta en 32768
  const skill4Dir = join(repoDir, '.agents', 'skills', 'utf8-4byte');
  mkdirSync(skill4Dir, { recursive: true });
  writeFileSync(join(skill4Dir, 'SKILL.md'), skill4Content);

  server = startWeb(stateDir, 0);
  const html = await getHtml('/definicion?ws=demo');

  expect(html).toContain('skills/utf8-3byte/SKILL.md');
  expect(html).toContain('skills/utf8-4byte/SKILL.md');
  expect(html).not.toContain('\uFFFD');
});

test('usa las clases css especificas de definicion en el html y estan definidas en la hoja de estilos', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const html = await getHtml('/definicion?ws=demo');
  expect(html).toContain('class="definition-file"');
  expect(html).toContain('definition-summary');
  expect(html).toContain('definition-nav');
  expect(html).toContain('definition-tree');

  const cssRes = await fetch(`http://127.0.0.1:${server.port}/style.css`);
  expect(cssRes.status).toBe(200);
  const css = await cssRes.text();
  expect(css).toContain('.definition-file');
  expect(css).toContain('.definition-summary');
  expect(css).toContain('.definition-nav');
});

test('la pagina de definicion no contiene estilos en linea style= que violen la csp', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const html = await getHtml('/definicion?ws=demo');
  expect(html).not.toMatch(/style=["'][^"']*["']/);
});

test('aclara en la definicion que los secretos detectados se muestran redactados', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const html = await getHtml('/definicion?ws=demo');
  expect(html).toContain('secretos o credenciales detectados se muestran redactados');
});

test('la página no escribe en disco', async () => {
  seedWorkstream();
  server = startWeb(stateDir, 0);

  const recursiveSnapshot = (baseDir: string): { path: string; size: number; mtime: number }[] => {
    const results: { path: string; size: number; mtime: number }[] = [];
    const walk = (curr: string, rel: string) => {
      if (!existsSync(curr)) return;
      for (const entry of readdirSync(curr, { withFileTypes: true })) {
        const full = join(curr, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(full, relPath);
        } else if (entry.isFile()) {
          const s = statSync(full);
          results.push({ path: relPath, size: s.size, mtime: s.mtimeMs });
        }
      }
    };
    walk(baseDir, '');
    return results.sort((a, b) => a.path.localeCompare(b.path));
  };

  const beforeState = recursiveSnapshot(stateDir);
  const beforeRepo = recursiveSnapshot(repoDir);

  // Hacer múltiples peticiones
  await getHtml('/definicion');
  await getHtml('/definicion?ws=demo');
  await getHtml('/definicion?ws=demo#file-workstream.json');

  const afterState = recursiveSnapshot(stateDir);
  const afterRepo = recursiveSnapshot(repoDir);

  expect(afterState).toEqual(beforeState);
  expect(afterRepo).toEqual(beforeRepo);

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
