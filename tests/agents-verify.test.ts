import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  agentBinStatus,
  agentsMain,
  binaryVersion,
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
  // agy, droid y gemini no existen → no_instalado
  const estados = Object.fromEntries(verifyAgents(scope.home).map((s) => [s.agent, s.verdict]));
  expect(estados).toEqual({ claude: 'sin_pin', codex: 'sin_pin', agy: 'no_instalado', droid: 'no_instalado', gemini: 'no_instalado' });

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

test('T106-H11: binaryVersion ejecuta el binario con entorno mínimo sin tokens del operador', () => {
  const spy = stubBin('claude', `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "v1.0 gh=\${GH_TOKEN:-vacio} ant=\${ANTHROPIC_API_KEY:-vacio}"
  exit 0
fi
exit 0
`);
  // Proceso hijo con tokens del operador en su entorno de proceso
  const proc = Bun.spawnSync([
    process.execPath, '-e',
    `import { binaryVersion } from './src/agents-verify.ts'; console.log(binaryVersion("${spy}"));`,
  ], {
    env: {
      PATH: `${scope.binDir}:${scope.path}`,
      GH_TOKEN: 'ghp_secreto_operador_canario',
      ANTHROPIC_API_KEY: 'sk-ant-secreto-operador',
    },
  });
  const output = proc.stdout.toString().trim();
  expect(output).toBe('v1.0 gh=vacio ant=vacio');
  expect(output).not.toContain('ghp_secreto_operador_canario');
  expect(output).not.toContain('sk-ant-secreto-operador');
});

test('T106-H12: binaryVersion neutraliza controles Unicode/bidi y loadAgentVersions ignora claves desconocidas', () => {
  stubBin('claude', `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "v1.0\u202Erev\u200B"
  exit 0
fi
exit 0
`);
  const v = binaryVersion(join(scope.binDir, 'claude'));
  expect(v).toBe('v1.0rev');
  expect(v).not.toContain('\u202E');
  expect(v).not.toContain('\u200B');

  mkdirSync(scope.home, { recursive: true });
  writeFileSync(join(scope.home, 'agents.json'), JSON.stringify({
    agentBinaries: { claude: 'a'.repeat(64) },
    agentVersions: {
      claude: '2.5.0',
      clave_desconocida_xyz: 'invalido',
    },
  }));
  const versions = loadAgentVersions(scope.home);
  expect(versions.clave_desconocida_xyz).toBeUndefined();
  expect(Object.keys(versions)).toEqual(['claude']);
});

test('T106-H10: binaryVersion maneja errores, multilínea, caracteres de control, tope 40 y timeout (N17–N21)', () => {
  // N17: exit code != 0
  const binFail = stubBin('claude-fail', '#!/bin/sh\nexit 1\n');
  expect(binaryVersion(binFail)).toBeNull();

  // N18: caracteres de control C0 y DEL
  const binControl = stubBin('claude-ctrl', '#!/bin/sh\necho "v1.0\x07\x1b[31m\x7fok"\nexit 0\n');
  const vCtrl = binaryVersion(binControl);
  expect(vCtrl).toBe('v1.0[31mok');
  expect(vCtrl).not.toContain('\x07');
  expect(vCtrl).not.toContain('\x1b');
  expect(vCtrl).not.toContain('\x7f');

  // N19: tope de 40 caracteres
  const binLargo = stubBin('claude-long', '#!/bin/sh\necho "' + 'x'.repeat(100) + '"\nexit 0\n');
  const vLong = binaryVersion(binLargo);
  expect(vLong).not.toBeNull();
  expect(vLong!.length).toBe(40);

  // N20: solo primera línea
  const binMulti = stubBin('claude-multi', '#!/bin/sh\necho "primera linea"\necho "segunda linea"\nexit 0\n');
  expect(binaryVersion(binMulti)).toBe('primera linea');

  // N21: timeout (bucle infinito que supera 1s sin depender de binarios de PATH)
  const binSleep = stubBin('claude-sleep', '#!/bin/sh\nwhile true; do :; done\n');
  expect(binaryVersion(binSleep)).toBeNull();
});




