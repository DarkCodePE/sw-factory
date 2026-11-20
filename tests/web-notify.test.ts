import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { startWeb } from '../src/web.ts';

let dir: string, store: Store, server: ReturnType<typeof startWeb>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fab-notify-'));
  store = new Store(join(dir, 'fabrica.db'));
  server = startWeb(dir, 0);
});
afterEach(() => { server.stop(true); store.close(); rmSync(dir, { recursive: true, force: true }); });
const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);

// Ejecuta /notify.js contra un DOM y un Notification simulados.
async function harness(permission: string, stored: string | null, initial: Record<string, number>, requested = 'granted') {
  const script = await (await get('/notify.js')).text();
  const calls: { title: string; body: string }[] = [];
  let requests = 0;
  const store = new Map<string, string>(stored === null ? [] : [['fab.notify', stored]]);
  const main = (o: Record<string, number>) => ({ querySelector: () => ({ dataset: { inbox: JSON.stringify(o) } }) });
  const button: any = { hidden: true, textContent: '', onclick: null };
  const N: any = function (title: string, o: { body: string }) { calls.push({ title, body: o.body }); };
  N.permission = permission;
  N.requestPermission = async () => { requests++; N.permission = requested; return requested; };
  const win: any = {};
  const doc = { ...main(initial), getElementById: () => button };
  new Function('window', 'document', 'Notification', 'localStorage', script)(win, doc, N, { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
  return { win, calls, button, main, store, requests: () => requests };
}

test('con permiso y activado, bandeja de 1 a 2 avisa una vez con recuentos', async () => {
  const h = await harness('granted', '1', { 'Espera revisión': 1 });
  h.win.fabNotify(h.main({ 'Espera revisión': 2 }));
  h.win.fabNotify(h.main({ 'Espera revisión': 2 }));
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]!.body).toBe('2 en la bandeja: 2 Espera revisión');
});

test('no avisa si la bandeja baja, si el interruptor está apagado ni sin permiso', async () => {
  for (const [perm, st] of [['granted', '1'], ['granted', null], ['default', '1'], ['denied', '1']] as const) {
    const h = await harness(perm, st, { Fallido: 2 });
    h.win.fabNotify(h.main({ Fallido: 1 }));
    h.win.fabNotify(h.main({ Fallido: 3 }));
    expect(h.calls).toHaveLength(perm === 'granted' && st === '1' ? 1 : 0);
  }
});

test('el sondeo nunca pide permiso; solo el clic del interruptor', async () => {
  const h = await harness('default', null, {});
  h.win.fabNotify(h.main({ Fallido: 1 }));
  h.win.fabNotify(h.main({ Fallido: 2 }));
  expect(h.requests()).toBe(0);
  await h.button.onclick();
  expect(h.requests()).toBe(1);
  expect(h.store.get('fab.notify')).toBe('1');
  await h.button.onclick();
  expect(h.requests()).toBe(1);
  expect(h.store.get('fab.notify')).toBe('0');
});

test('si el navegador deniega el permiso, el interruptor no se activa', async () => {
  const h = await harness('default', null, {}, 'denied');
  await h.button.onclick();
  expect(h.store.get('fab.notify')).toBeUndefined();
});

test('el cuerpo del aviso no contiene títulos ni texto de terceros', async () => {
  store.createChange(store.createWorkstream({ slug: 'p', goal: 'g', repo: '/r' }).id, 'TITULO-SECRETO <b>', 'CUERPO-SECRETO');
  const html = await (await get('/')).text();
  const attr = /<main[^>]*data-inbox="([^"]*)"/.exec(html)![1]!;
  expect(attr).not.toMatch(/SECRETO/);
  const script = await (await get('/notify.js')).text();
  expect(script).not.toMatch(/SECRETO/);
});

test('el data-inbox de la bandeja refleja recuentos por estado por estado', async () => {
  const html = await (await get('/')).text();
  expect(html).toMatch(/<main[^>]*data-inbox="\{[^"]*\}"/);
  expect(html).toContain('id="fab-notify"');
});

test('la CSP sigue sin permitir script en línea y notify.js es externo', async () => {
  const r = await get('/');
  const csp = r.headers.get('content-security-policy')!;
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  const html = await r.text();
  expect(html).toContain('<script src="/notify.js" defer></script>');
  expect(html).not.toMatch(/<script(?![^>]*src=)[^>]*>/);
  expect((await get('/notify.js')).headers.get('content-type')).toContain('text/javascript');
});

test('el sondeo llama a fabNotify aunque la pestaña esté oculta', async () => {
  const poll = await (await get('/poll.js')).text();
  expect(poll).toContain('fabNotify');
  expect(poll.indexOf('fabNotify')).toBeLessThan(poll.indexOf('document.hidden'));
});

test('inboxCounts agrupa estados desconocidos como «Otros» y nunca usa el valor crudo', async () => {
  const { inboxCounts } = await import('../src/web-notify.ts');
  expect(inboxCounts(['failed', 'failed', 'raro<x>'], { failed: 'Fallido' })).toEqual({ Fallido: 2, Otros: 1 });
});
