import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentBinStatus,
  agentsMain,
  factoryHome,
  loadAgentVersions,
  loadPins,
  resolveBinary,
  savePins,
  sha256Of,
  verifyAgents,
  verifyAgentStart,
} from '../src/agents-verify.ts';
import { runPool } from '../src/pool.ts';
import { Store } from '../src/store.ts';

type Scope = {
  dir: string;
  home: string;
  binDir: string;
  path: string;
  factoryHome: string;
  restore: () => void;
};

let scope: Scope;
let store: Store;

function stubBin(name: string, content: string): string {
  const path = join(scope.binDir, name);
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'fab-agents-verify-'));
  scope = {
    dir,
    home: join(dir, 'home'),
    binDir: join(dir, 'bin'),
    path: process.env.PATH ?? '',
    factoryHome: process.env.FABRICA_HOME ?? '',
    restore: () => { if (scope.path) process.env.PATH = scope.path; else delete process.env.PATH; if (scope.factoryHome) process.env.FABRICA_HOME = scope.factoryHome; else delete process.env.FABRICA_HOME; rmSync(dir, { recursive: true, force: true }); },
  };
  mkdirSync(scope.binDir, { recursive: true });
  // PATH aislado: solo el binDir de la prueba (y un dir inexistente para lo demás).
  process.env.PATH = `${scope.binDir}:${join(dir, 'nada')}`;
  process.env.FABRICA_HOME = scope.home;
  store = new Store(join(dir, 'fab.db'));
});

afterEach(() => {
  store.close();
  scope.restore();
});

test('resolveBinary encuentra el binario ejecutable más a la izquierda del PATH', () => {
  expect(resolveBinary('definitivamente-no-existe-xyz')).toBe(null);
  const path = stubBin('claude', 'claude stub');
  expect(resolveBinary('claude')).toBe(path);
  expect(resolveBinary('codex')).toBe(null);
});

test('sin pines todos están sin_pin o no_instalado; --pin fija el sha256 actual', () => {
  const claude = stubBin('claude', 'claude-1.0');
  stubBin('codex', 'codex-1.0');
  // agy y droid no existen → no_instalado
  const estados = Object.fromEntries(verifyAgents(scope.home).map((s) => [s.agent, s.verdict]));
  expect(estados).toEqual({ claude: 'sin_pin', codex: 'sin_pin', agy: 'no_instalado', droid: 'no_instalado' });

  savePins({ claude: sha256Of(claude), codex: 'a'.repeat(64) }, scope.home);
  expect(Object.keys(loadPins(scope.home)).sort()).toEqual(['claude', 'codex']);
  expect(agentBinStatus('claude', scope.home).verdict).toBe('ok');
  expect(agentBinStatus('codex', scope.home).verdict).toBe('distinto');
  expect(agentBinStatus('agy', scope.home).verdict).toBe('no_instalado');
});

test('loadPins ignora claves desconocidas y pines que no son sha256', () => {
  stubBin('claude', 'claude-binario');
  savePins({ claude: 'borrar-esto', native: 'z'.repeat(64) } as Record<string, string>, scope.home);
  expect(loadPins(scope.home)).toEqual({});
  expect(agentBinStatus('claude', scope.home).verdict).toBe('sin_pin');
});

test('verifyAgentStart: sin pin avisa y no bloquea; pin distinto viola y pin igual pasa', () => {
  stubBin('claude', 'claude-contenido');
  const sinPin = verifyAgentStart('claude', scope.home);
  expect(sinPin.ok).toBe(true);
  expect(sinPin.warning).toContain('sin pin');

  savePins({ claude: sha256Of(join(scope.binDir, 'claude')) }, scope.home);
  expect(verifyAgentStart('claude', scope.home)).toEqual({ ok: true });

  stubBin('claude', 'claude-modificado');
  const distinto = verifyAgentStart('claude', scope.home);
  expect(distinto.ok).toBe(false);
  expect(distinto.violation).toContain('sha256 distinto');

  // los adaptadores sin binario externo no se punean
  expect(verifyAgentStart('fake', scope.home)).toEqual({ ok: true });
  expect(verifyAgentStart('native', scope.home)).toEqual({ ok: true });
});

test('runPool: pin distinto del adaptador del workstream impide arrancar; con --accept-agent-binaries arranca', async () => {
  stubBin('claude', 'claude-malicioso');
  savePins({ claude: sha256Of(join(scope.binDir, 'claude')) }, scope.home);
  stubBin('claude', 'claude-reemplazado');

  const ws = store.createWorkstream({ slug: 'pin-ws', goal: 'g', repo: scope.dir, agent: 'claude', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');

  expect(runPool(store, { workstream: ws.id, stateDir: scope.dir, untilIdle: true, log: () => {} }))
    .rejects.toThrow('--accept-agent-binaries');

  // Aceptando explícitamente el binario distinto el pool arranca (y termina: no hay trabajo pendiente).
  await expect(runPool(store, { workstream: ws.id, stateDir: scope.dir, untilIdle: true, acceptAgentBinaries: true, log: () => {} })).resolves.toBeUndefined();
});

test('runPool: sin pin solo avisa y no arranca bloqueado (el pool sigue)', async () => {
  stubBin('agy', 'agy-sin-pin');
  const ws = store.createWorkstream({ slug: 'nopin-ws', goal: 'g', repo: scope.dir, agent: 'agy', requireChangeApproval: false });
  store.setWorkstreamState(ws.id, 'active');
  const avisos: string[] = [];
  await expect(runPool(store, { workstream: ws.id, stateDir: scope.dir, untilIdle: true, log: (m) => avisos.push(m) })).resolves.toBeUndefined();
  expect(avisos.join('\n')).toContain('sin pin');
});

test('factoryHome respeta FABRICA_HOME', () => {
  expect(factoryHome()).toBe(scope.home);
});

test('loadAgentVersions lee versiones registradas de agents.json', () => {
  expect(loadAgentVersions(scope.home)).toEqual({});
  mkdirSync(scope.home, { recursive: true });
  writeFileSync(join(scope.home, 'agents.json'), JSON.stringify({
    agentBinaries: { claude: 'a'.repeat(64) },
    agentVersions: {
      claude: { version: '2.5.0', sha256: 'a'.repeat(64) },
      codex: '1.0.0', // soporte de formato simple retrocompatible
    },
  }));
  expect(loadAgentVersions(scope.home)).toEqual({
    claude: { version: '2.5.0', sha256: 'a'.repeat(64) },
    codex: { version: '1.0.0' },
  });
});

test('T106-H4: savePins no conserva claves numéricas si el archivo previo no es un objeto', () => {
  mkdirSync(scope.home, { recursive: true });
  writeFileSync(join(scope.home, 'agents.json'), '[1, 2, 3]');
  savePins({ claude: 'a'.repeat(64) }, scope.home);
  const raw = JSON.parse(readFileSync(join(scope.home, 'agents.json'), 'utf8'));
  expect(raw).toEqual({ agentBinaries: { claude: 'a'.repeat(64) } });
  expect(Object.keys(raw)).toEqual(['agentBinaries']);
});

test('T106-H3: fab agents verify --pin escribe agentVersions en agents.json', async () => {
  stubBin('claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude v2.5.0"; exit 0; fi\nexit 0\n');
  stubBin('codex', '#!/bin/sh\nexit 1\n'); // no responde a --version

  const log = console.log;
  console.log = () => {};
  try {
    const code = await agentsMain(['--pin']);
    expect(code).toBe(0);
  } finally {
    console.log = log;
  }

  const versions = loadAgentVersions(scope.home);
  expect(versions.claude?.version).toBe('claude v2.5.0');
  expect(versions.claude?.sha256).toBe(loadPins(scope.home).claude);
  expect(versions.codex).toBeUndefined();
  expect(loadPins(scope.home).claude).toBe(sha256Of(join(scope.binDir, 'claude')));
});

test('T106-H8: la versión registrada queda ligada al sha y se descarta si pin cambia o --version no responde (escenario N1)', async () => {
  // 1. claude inicial con versión 1.0.0
  stubBin('claude', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "claude 1.0.0"; exit 0; fi\nexit 0\n');
  const log = console.log;
  console.log = () => {};
  try {
    await agentsMain(['--pin']);
  } finally {
    console.log = log;
  }
  const v1 = loadAgentVersions(scope.home).claude;
  expect(v1?.version).toBe('claude 1.0.0');
  expect(v1?.sha256).toBe(loadPins(scope.home).claude);

  // 2. Se reemplaza claude por un binario cuyo --version falla (exit 3)
  stubBin('claude', '#!/bin/sh\nexit 3\n');
  const newSha = sha256Of(join(scope.binDir, 'claude'));
  expect(newSha).not.toBe(v1?.sha256);

  console.log = () => {};
  try {
    await agentsMain(['--pin']);
  } finally {
    console.log = log;
  }

  // 3. El nuevo pin está registrado, pero la versión vieja DEBE haberse descartado
  expect(loadPins(scope.home).claude).toBe(newSha);
  const v2 = loadAgentVersions(scope.home).claude;
  expect(v2).toBeUndefined(); // Se descartó porque --version no respondió con éxito
});

