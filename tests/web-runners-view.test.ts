import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { runnersPage } from '../src/web-runners.ts';
import { workstreamsBody } from '../src/web-ws.ts';

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-web-runner-view-'));
  store = new Store(join(dir, 'fabrica.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('el inventario empieza vacío y solo ofrece comprobar SSH habilitado', () => {
  expect(runnersPage(store, 'csrf').body).toContain('No hay runners configurados.');
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-canario', options: { maxBundleMb: 987 } });
  store.createRunner({ name: 'pausado', kind: 'ssh', target: 'alias-pausado' });
  store.setRunnerEnabled('pausado', false);
  store.createRunner({ name: 'casa', kind: 'local' });
  const html = runnersPage(store, 'csrf').body;
  expect(html).toContain('<td>Local</td><td>Activado</td>');
  expect(html).toContain('<td>SSH</td><td>Pausado</td>');
  expect(html).toContain('Sin comprobar');
  expect(html.match(/action="[^"]+\/comprobar"/g)).toEqual(['action="/config/runners/torre/comprobar"']);
  expect(html).not.toMatch(/alias-canario|alias-pausado|value="987"/);
});

test('la tarjeta muestra la asignación pausada y permite seleccionar runner o predeterminado con confirmación', () => {
  const w = store.createWorkstream({ slug: 'prueba', goal: 'prueba', repo: '/repo' });
  store.createRunner({ name: 'actual', kind: 'local' });
  store.setWorkstreamRunner(w.id, 'actual');
  store.setRunnerEnabled('actual', false);
  store.createRunner({ name: 'torre', kind: 'ssh', target: 'alias-canario' });
  store.createRunner({ name: 'otra-pausada', kind: 'local' });
  store.setRunnerEnabled('otra-pausada', false);
  const ui = { badge: (state: string) => state };
  const html = workstreamsBody(store, ui, 'csrf');
  expect(html).toContain(`action="/workstreams/${w.id}/runner"`);
  expect(html).toContain('Runner: actual (Pausado)');
  expect(html).toContain('name="expected" value="actual"');
  // T85-H4: un <select> con la opción deshabilitada seleccionada no envía el campo `runner`.
  expect(html).toContain('disabled>actual (Pausado)</option>');
  expect(html).not.toMatch(/disabled selected/);
  expect(html).toContain('<option value="">Predeterminado</option>');
  expect(html).toContain('<option value="torre">torre (SSH)</option>');
  expect(html).toContain('name="confirm" value="yes" required');
  expect(html).toContain('name="confirm_ssh" value="yes"');
  expect(html).toContain('enviar código y prompt');
  expect(html).toContain('--live');
  expect(html).not.toMatch(/alias-canario|otra-pausada/);
  expect(workstreamsBody(store, ui)).not.toContain(`action="/workstreams/${w.id}/runner"`);
  store.setWorkstreamState(w.id, 'archived');
  const archived = workstreamsBody(store, ui, 'csrf');
  expect(archived).toContain('Runner: actual (Pausado)');
  expect(archived).not.toContain(`action="/workstreams/${w.id}/runner"`);
});

test('las dos vistas escapan nombres de runners de filas antiguas o anómalas', () => {
  const w = store.createWorkstream({ slug: 'prueba', goal: 'prueba', repo: '/repo' });
  const name = 'fuera"<img>&';
  store.createRunner({ name: 'viejo', kind: 'local' });
  store.db.query("UPDATE runners SET name = ? WHERE name = 'viejo'").run(name);
  store.setWorkstreamRunner(w.id, name);
  const html = runnersPage(store, 'csrf').body + workstreamsBody(store, { badge: () => '' }, 'csrf');
  expect(html).toContain('fuera&quot;&lt;img&gt;&amp;');
  expect(html).not.toContain(name);
});

test('T101-H7: cada tipo de alta tiene solo sus campos y conserva la validación nativa', () => {
  const html = runnersPage(store, 'csrf').body;
  const forms = html.match(/<form action="\/config\/runners\/alta"[^>]*>[\s\S]*?<\/form>/g) ?? [];
  expect(forms).toHaveLength(2);
  const local = forms.find(form => form.includes('name="kind" value="local"'))!;
  const ssh = forms.find(form => form.includes('name="kind" value="ssh"'))!;
  expect(local).toContain('name="confine"');
  expect(local).not.toMatch(/name="(?:target|maxBundleMb)"/);
  expect(ssh).not.toContain('name="confine"');
  expect(ssh).toMatch(/name="target"[^>]* required/);
  expect(ssh).toContain('name="maxBundleMb"');
});
