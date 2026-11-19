import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

test('las vistas integradas comparten navegación y sesión; sus rutas nuevas solo se leen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-web-preview-test-'));
  const dbPath = join(dir, 'fabrica.db');
  let server: ReturnType<typeof startWeb> | undefined;
  try {
    const store = new Store(dbPath);
    try { store.createWorkstream({ slug: 'preview', goal: 'Vista de prueba', repo: '/synthetic' }); }
    finally { store.close(); }
    const files = readdirSync(dir).sort();
    const before = readFileSync(dbPath);
    server = startWeb(dir, 0, { write: true });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(server.loginUrl!, { redirect: 'manual' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, origin: base };
    for (const path of ['/', '/metricas', '/config', '/experimentos']) {
      const response = await fetch(base + path, { headers });
      expect(response.status).toBe(200);
      const html = await response.text();
      for (const link of ['/metricas', '/config', '/experimentos']) {
        expect(html).toContain(`href="${link}"`);
      }
      expect(html).toContain('Escritura habilitada');
      if (path === '/metricas' || path === '/config') {
        expect(html).not.toContain('/poll.js');
      } else {
        for (const script of ['/poll.js', '/inbox.js', '/notify.js']) expect(html).toContain(`src="${script}"`);
      }
    }
    for (const path of ['/metricas', '/config', '/experimentos', '/experimentos/sin-experimento', '/metrics.css', '/inbox.js', '/notify.js']) {
      const head = await fetch(base + path, { method: 'HEAD', headers });
      expect(head.status).toBe(path.endsWith('sin-experimento') ? 404 : 200);
      expect(await head.text()).toBe('');
      const post = await fetch(base + path, { method: 'POST', headers });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
    }
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  } finally {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
