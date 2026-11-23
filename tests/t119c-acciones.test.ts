// T119c: las 37 acciones (+ perfiles guardar/asignar) en modo servidor, por rol (O A M V) y por vía (web y API).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { ACTIONS, serverWebAction } from '../src/web-actions.ts';
import { handleServerApi } from '../src/web-api.ts';
import { ACTION_CAPABILITIES } from '../src/policy.ts';
import { csrfToken } from '../src/web-auth.ts';
import { runnerCheckAction } from '../src/web-runner-check.ts';
import { jiraImportAction } from '../src/web-entrada.ts';
import { cloud, ORIGIN, ROLE_LIST, SECRET, type Cloud } from './helpers/cloud.ts';
import type { Role } from '../src/users.ts';

let c: Cloud;
beforeAll(() => { c = cloud(); });
afterAll(() => c.close());

/** Una ruta que cumple la expresión de la acción (`x1` hace de identificador). */
const pathOf = (name: string): string => name.startsWith('perfiles/') && !ACTIONS[name]
  ? `/${name}` : ACTIONS[name]!.path.source.replace(/\(\[\^\/\]\+\)/g, 'x1').replace(/[\^$]/g, '').replace(/\(([\w-]+)\)/g, '$1').replace(/\\\//g, '/');

const runner = runnerCheckAction('/nonexistent');
const jira = jiraImportAction('/nonexistent', { getIssue: async () => { throw new Error('sin red'); }, comment: async () => {} });

async function web(role: Role, name: string, write = true): Promise<number> {
  const p = c.web[role];
  const body = new URLSearchParams({ csrf: csrfToken(SECRET, p.sessionId!) });
  const req = new Request(`${ORIGIN}${pathOf(name)}`, { method: 'POST', body, headers: { origin: ORIGIN, host: 'fab.example.test', 'content-type': 'application/x-www-form-urlencoded' } });
  const res = await serverWebAction(req, c.stateDir, { principal: p, write, publicOrigin: ORIGIN, secret: SECRET }, runner, () => {}, jira);
  return res.status;
}

async function api(key: string, name: string, write = true): Promise<number> {
  const path = pathOf(name);
  const req = new Request(`${ORIGIN}/api/v1${path}`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } });
  const res = await handleServerApi(req, new URL(req.url), c.stateDir, write);
  // 404 de ruta (no existe la acción) se distingue del 404 del objeto inexistente, que prueba que la política pasó.
  return res.status === 404 && (await res.json() as { error: { message: string } }).error.message === 'ruta no encontrada' ? 999 : res.status;
}

const NAMES = Object.keys(ACTION_CAPABILITIES);
const letter: Record<Role, string> = { owner: 'O', admin: 'A', member: 'M', viewer: 'V' };

test('inventario: cada acción de ACTIONS y los dos formularios de perfiles tienen capacidad, y al revés', () => {
  const registered = Object.keys(ACTIONS);
  expect(NAMES.filter(n => !registered.includes(n)).sort()).toEqual(['perfiles/asignar', 'perfiles/guardar']);
  expect(registered.filter(n => !NAMES.includes(n))).toEqual([]);
  expect(registered.length).toBe(38);
});

// Las claves personales (`api-keys/*`) las sirve `/cuenta/claves` (T119b, con su test por rol); aquí la tabla local no se despacha.
const WEB = NAMES.filter(n => !n.startsWith('api-keys/'));
for (const name of WEB) {
  test(`web ${name}: solo ${ACTION_CAPABILITIES[name]!.roles} pasan la política`, async () => {
    for (const role of ROLE_LIST) {
      const status = await web(role, name);
      const allowed = ACTION_CAPABILITIES[name]!.roles.includes(letter[role]);
      if (allowed) expect([401, 403], `${role} debía pasar la política (${status})`).not.toContain(status);
      else expect(status, `${role} debía recibir 403`).toBe(403);
    }
  });
  test(`web ${name}: sin --write ninguna mutación pasa`, async () => {
    for (const role of ROLE_LIST) expect(await web(role, name, false)).toBe(403);
  });
}

for (const name of NAMES.filter(n => ACTIONS[n] && ACTIONS[n]!.api !== false)) {
  test(`API ${name}: rol vigente ∩ ámbito decide; el viewer no tiene API`, async () => {
    const allowed = ACTION_CAPABILITIES[name]!.roles;
    expect(ACTION_CAPABILITIES[name]!.api).toBe(true);
    for (const role of ['owner', 'admin', 'member'] as const) {
      const status = await api(c.keys[role].decide, name);
      if (allowed.includes(letter[role])) expect([401, 403, 405, 999], `${role} (${status})`).not.toContain(status);
      else expect(status, role).toBe(403);
      // La clave de solo lectura nunca muta.
      expect(await api(c.keys[role].read, name)).toBe(403);
      // Sin --write el servidor es de solo lectura.
      expect(await api(c.keys[role].decide, name, false)).toBe(405);
    }
  });
}

test('API: las acciones api:false no son rutas de la API, ni con la clave de un owner', async () => {
  for (const name of NAMES.filter(n => ACTIONS[n] && ACTIONS[n]!.api === false && !n.startsWith('api-keys/'))) {
    expect(await api(c.keys.owner.decide, name), name).toBe(999);
  }
});
