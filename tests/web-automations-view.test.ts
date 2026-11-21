import { afterEach, beforeEach, expect, test } from 'bun:test';
import { automationRevision, Store } from '../src/store.ts';
import * as views from '../src/web-automations.ts';

let store: Store;
beforeEach(() => { store = new Store(':memory:'); });
afterEach(() => store.close());

test('formulario de alta ofrece workstream, cuatro horarios UTC y campos etiquetados', () => {
  const ws = store.createWorkstream({ slug: 'demo', goal: 'g', repo: '/repo' });
  const { body } = views.automationEditor(store, 'csrf', { values: { ws: ws.id } });
  expect(body).toContain('action="/automations/create"');
  expect(body).toContain(`value="${ws.id}" selected`);
  for (const mode of ['hour', 'day', 'week', 'cron']) expect(body).toContain(`value="${mode}"`);
  for (const field of ['ws', 'name', 'schedule', 'at', 'weekday', 'cron', 'title', 'body']) {
    expect(body).toContain(`for="automation-${field}"`);
    expect(body).toContain(`name="${field}"`);
  }
  expect(body).toContain('UTC');
  expect(body).not.toContain('name="confirm"');
  expect(body).not.toContain('name="stage"');
});


test('formulario de edición conserva el destino, carga cron antiguo como texto y confirma acciones por separado', () => {
  const ws = store.createWorkstream({ slug: 'demo', goal: 'g', repo: '/repo' });
  const row = store.createAutomation({ workstream: ws.id, name: 'diaria', cron: '0 * * * *', title: 't', body: 'b' });
  store.db.query('UPDATE automations SET cron = ?, title = ?, body = ?, name = ? WHERE id = ?')
    .run('mal"><img>', '"comillas" <img>', '\n</textarea><script>', 'diaria" <img>', row.id);
  const automation = store.getAutomation(row.id);
  const { body } = views.automationEditor(store, 'csrf', { automation });
  expect(body).toContain('value="cron" selected');
  expect(body).toContain('mal&quot;&gt;&lt;img&gt;');
  expect(body).toContain('value="diaria&quot; &lt;img&gt;"');
  expect(body).toContain('&quot;comillas&quot; &lt;img&gt;');
  expect(body).toContain('\n\n&lt;/textarea&gt;&lt;script&gt;');
  expect(body).toContain('Workstream <strong>demo</strong>');
  expect(body).not.toContain('name="ws"');
  expect(body).not.toContain('<img>');
  expect(body).not.toContain('<script>');
  for (const verb of ['update', 'delete']) expect(body).toContain(`action="/automations/${row.id}/${verb}"`);
  expect(body.match(/name="confirm" value="yes" required/g)).toHaveLength(2);
  expect(body.match(new RegExp(`value="${automationRevision(automation)}"`, 'g'))).toHaveLength(2);
  expect(body).toContain('vencimientos');
  expect(body).toContain('señales históricas');
});
