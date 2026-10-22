import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatController, type ChatIO } from '../src/chat/controller.ts';
import { completions } from '../src/chat/commands.ts';
import { SessionStore } from '../src/agent/session.ts';
import { formatMissionEvent, MissionTracker, renderMissionPanel, type MissionProgressSnapshot } from '../src/chat/mission-view.ts';
import type { AgentOptions, AgentResult, ModelProvider } from '../src/agent/types.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

class MockIO implements ChatIO {
  output = '';
  answers: string[] = [];
  selection?: number;
  updatedState?: any;
  write(s: string) { this.output += s; }
  async question(_prompt: string, signal?: AbortSignal) { signal?.throwIfAborted(); return this.answers.shift() ?? ''; }
  async select(_prompt: string, _choices: string[], signal?: AbortSignal) { signal?.throwIfAborted(); return this.selection; }
  update(state: any) { this.updatedState = state; }
}

async function fixture(customRun?: typeof import('../src/agent/engine.ts').runCodingAgent) {
  const dir = await mkdtemp(join(tmpdir(), 'fab-mission-test-'));
  dirs.push(dir);
  const cwd = join(dir, 'workspace');
  const home = join(dir, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });

  const io = new MockIO();
  const provider: ModelProvider = {
    id: 'mock-provider',
    async complete() {
      return { text: 'Done', toolCalls: [], finishReason: 'stop' };
    },
  };

  const app = new ChatController({
    cwd,
    home,
    providerFor: () => provider,
    config: { model: 'fixture', autonomy: 'high', mode: 'auto', theme: 'plain' },
    run: customRun,
  }, io);

  return { dir, cwd, home, io, app, provider };
}

test('completions includes /mission subcommands', () => {
  const [opts] = completions('/mission ');
  expect(opts).toContain('/mission status');
  expect(opts).toContain('/mission pause');
  expect(opts).toContain('/mission resume');
  expect(opts).toContain('/mission workers');
  expect(opts).toContain('/mission log');
  expect(opts).toContain('/mission list');
});

test('positivo: panel y barra reflejan features, workers, tokens y eventos legibles', async () => {
  const sampleSnapshot: MissionProgressSnapshot = {
    missionId: 'm-alpha',
    title: 'Migración a SQLite',
    state: 'running',
    updatedAt: new Date().toISOString(),
    features: [
      { id: 'feat-schema', milestone: 'm1', status: 'completed', attempts: 1 },
      { id: 'feat-migration', milestone: 'm1', status: 'awaiting_validation', attempts: 2 },
      { id: 'feat-queries', milestone: 'm2', status: 'pending', attempts: 0 },
    ],
    milestones: [
      { id: 'm1', scrutiny: true, userTesting: false, verifiersPassed: true },
      { id: 'm2', scrutiny: false, userTesting: false, verifiersPassed: null },
    ],
    workers: [
      { workerSessionId: 'w-1', featureId: 'feat-schema', role: 'worker', status: 'completed', usage: { inputTokens: 500, outputTokens: 200 }, durationMs: 3200 },
      { workerSessionId: 'w-2', featureId: 'feat-migration', role: 'scrutiny', status: 'running', usage: { inputTokens: 300, outputTokens: 100 }, durationMs: 1400 },
    ],
    totals: {
      completed: 1,
      total: 3,
      usage: { inputTokens: 800, outputTokens: 300 },
      durationMs: 4600,
    },
  };

  const fakeRun = async (opts: AgentOptions): Promise<AgentResult> => {
    opts.onEvent?.({ type: 'mission_progress', sessionId: 's-1', missionId: 'm-alpha', snapshot: sampleSnapshot } as any);
    opts.onEvent?.({ type: 'mission_worker_started', sessionId: 's-1', workerSessionId: 'w-3', featureId: 'feat-queries', role: 'worker', milestone: 'm2' } as any);
    opts.onEvent?.({ type: 'mission_worker_completed', sessionId: 's-1', workerSessionId: 'w-3', featureId: 'feat-queries', role: 'worker', milestone: 'm2', exitCode: 0, hasHandoff: true, successState: 'success', usage: { inputTokens: 100, outputTokens: 50 }, durationMs: 900 } as any);
    opts.onEvent?.({ type: 'mission_milestone_validated', sessionId: 's-1', milestone: 'm1', passed: true, verifiers: [{ command: 'bun test', exitCode: 0 }] } as any);
    return {
      sessionId: 's-1',
      ok: true,
      text: 'Misión en progreso',
      turns: 1,
      toolCalls: 0,
      durationMs: 4600,
      usage: { inputTokens: 900, outputTokens: 350 },
      mission: { missionId: 'm-alpha', state: 'running', directory: '/tmp/m-alpha', completed: 2, total: 3 },
    };
  };

  const f = await fixture(fakeRun as any);
  await f.app.submit('Inicia la misión');

  // Eventos legibles en lugar de JSON crudo
  expect(f.io.output).toContain('[Misión] Progreso: 1/3 features completadas');
  expect(f.io.output).toContain('[Misión] Worker iniciado: feat-queries (worker, milestone m2)');
  expect(f.io.output).toContain('[Misión] Worker completado: feat-queries (worker) -> exit 0 (success)');
  expect(f.io.output).toContain('[Misión] Milestone m1: aprobado (1 verificadores)');
  expect(f.io.output).not.toContain('{"type":"mission_progress"');

  // Barra de estado
  expect(f.app.statusState.missionSummary).toBe('misión: running 1/3');

  // /mission status muestra el panel
  f.io.output = '';
  await f.app.submit('/mission status');
  expect(f.io.output).toContain('Mission Control: Migración a SQLite [running]');
  expect(f.io.output).toContain('Progreso: 1/3 completadas');
  expect(f.io.output).toContain('Milestone: m1');
  expect(f.io.output).toContain('feat-schema (intentos: 1) [completed]');
  expect(f.io.output).toContain('feat-migration (intentos: 2) [awaiting_validation]');
  expect(f.io.output).toContain('Workers:');
  expect(f.io.output).toContain('w-1');

  // /mission workers lista workers
  f.io.output = '';
  await f.app.submit('/mission workers');
  expect(f.io.output).toContain('Worker: w-1 · Feature: feat-schema');
});

test('positivo: /mission workers <id> muestra detalle de handoff, verificación e issues', async () => {
  const f = await fixture();
  const store = await SessionStore.create(f.app.sessionDir);
  const sessionId = 'test-session-workers';

  await store.acquire(sessionId);
  await store.save({
    id: sessionId,
    version: 1,
    cwd: f.cwd,
    provider: 'fixture',
    status: 'completed',
    turns: 1,
    messages: [{ role: 'user', content: 'test' }],
    pending: [],
    tags: [],
    mission: {
      version: 1,
      missionId: 'm-test',
      directory: join(f.dir, 'mission-m-test'),
      title: 'Misión Workers Test',
      proposal: 'Test',
      workingDirectory: f.cwd,
      state: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      features: {},
      validations: {},
      dismissals: [],
      attempts: [
        {
          workerSessionId: 'worker-xyz',
          featureId: 'feat-auth',
          role: 'worker',
          observed: [
            { command: 'bun test tests/auth.test.ts', exitCode: 0, isError: false },
          ],
          handoff: {
            successState: 'success',
            returnToOrchestrator: false,
            handoff: {
              salientSummary: 'Autenticación con tokens JWT validada con éxito',
              whatWasImplemented: 'Implementación de endpoint /token y middleware de verificación',
              whatWasLeftUndone: 'Rotación de refresh tokens pospuesta a fase 2',
              verification: {
                commandsRun: [{ command: 'bun test tests/auth.test.ts', exitCode: 0, observation: '3 tests passing' }],
              },
              tests: { added: [{ file: 'tests/auth.test.ts', cases: [{ name: 'jwt verification', verifies: 'valid signature' }] }], coverage: '90%' },
              discoveredIssues: [
                { severity: 'suggestion', description: 'Mejorar caché de claves públicas', suggestedFix: 'Usar Map en memoria con TTL' },
              ],
            },
          },
        },
      ],
    },
  });
  await store.close();

  await f.app.resume(sessionId);
  f.io.output = '';

  await f.app.submit('/mission workers worker-xyz');
  expect(f.io.output).toContain('Worker worker-xyz (worker, feature: feat-auth)');
  expect(f.io.output).toContain('Estado de éxito: success');
  expect(f.io.output).toContain('Resumen: Autenticación con tokens JWT validada con éxito');
  expect(f.io.output).toContain('Implementado: Implementación de endpoint /token y middleware de verificación');
  expect(f.io.output).toContain('Pendiente: Rotación de refresh tokens pospuesta a fase 2');
  expect(f.io.output).toContain('Verificación observada:');
  expect(f.io.output).toContain('[observado] bun test tests/auth.test.ts -> exit 0');
  expect(f.io.output).toContain('Issues detectados (1):');
  expect(f.io.output).toContain('[suggestion] Mejorar caché de claves públicas (fix: Usar Map en memoria con TTL)');
});

test('positivo: /mission log lee progress_log.jsonl acotado a 200 líneas', async () => {
  const f = await fixture();
  const missionDir = join(f.dir, 'missions', 'test-log-mission');
  await mkdir(missionDir, { recursive: true });

  const logEntries: string[] = [];
  for (let i = 1; i <= 250; i++) {
    logEntries.push(JSON.stringify({ timestamp: new Date().toISOString(), type: `step_${i}`, details: `entry ${i}` }));
  }
  await writeFile(join(missionDir, 'progress_log.jsonl'), logEntries.join('\n') + '\n');

  f.app.missionTracker.directory = missionDir;
  f.app.missionTracker.state = 'running';

  f.io.output = '';
  await f.app.submit('/mission log 10');
  expect(f.io.output).toContain('Últimas 10 entradas de progress_log.jsonl:');
  expect(f.io.output).toContain('step_250');
  expect(f.io.output).toContain('step_241');
  expect(f.io.output).not.toContain('step_240');

  // Acotado a máximo 200 líneas aunque se pida 300
  f.io.output = '';
  await f.app.submit('/mission log 300');
  expect(f.io.output).toContain('Últimas 200 entradas de progress_log.jsonl:');
});

test('positivo: /mission list enumera sesiones con misión y permite reanudarlas', async () => {
  const f = await fixture();
  const store = await SessionStore.create(f.app.sessionDir);

  // Sesión 1 con misión
  await store.acquire('sess-m1');
  await store.save({
    id: 'sess-m1', version: 1, cwd: f.cwd, provider: 'fixture', turns: 1, messages: [{ role: 'user', content: 'm1' }],
    status: 'completed', pending: [], tags: [],
    mission: { version: 1, missionId: 'm1', directory: '/tmp/m1', title: 'Misión Primera', proposal: 'p1', workingDirectory: f.cwd, state: 'completed', createdAt: '', updatedAt: '', features: {}, validations: {}, dismissals: [], attempts: [] },
  });
  await store.close();

  // Sesión 2 sin misión
  await store.acquire('sess-nomiss');
  await store.save({
    id: 'sess-nomiss', version: 1, cwd: f.cwd, provider: 'fixture', turns: 1, messages: [{ role: 'user', content: 'nomiss' }],
    status: 'completed', pending: [], tags: [],
  });
  await store.close();

  // Selección interactiva de la primera misión
  f.io.selection = 0;
  f.io.output = '';
  await f.app.submit('/mission list');

  expect(f.app.sessionId).toBe('sess-m1');
  expect(f.app.missionTracker.state).toBe('completed');
  expect(f.io.output).toContain('sess-m1');
  expect(f.io.output).not.toContain('sess-nomiss');
});

test('negativo: pause sin run, resume en estado running o no pausado', async () => {
  const f = await fixture();

  // pause sin run activo: aviso sin throw
  f.io.output = '';
  await f.app.submit('/mission pause');
  expect(f.io.output).toContain('No hay una misión en ejecución activa para pausar.');

  // resume cuando el estado no es paused ni orchestrator_turn
  f.app.missionTracker.state = 'completed';
  await expect(f.app.submit('/mission resume')).rejects.toThrow('Solo se puede reanudar una misión en estado paused u orchestrator_turn');

  // resume cuando está en estado running (pero sin prompt activo)
  f.app.missionTracker.state = 'running';
  await expect(f.app.submit('/mission resume')).rejects.toThrow('Solo se puede reanudar una misión en estado paused u orchestrator_turn');
});

test('negativo: eventos malformados no rompen el render ni el tracker', () => {
  const tracker = new MissionTracker();

  // Eventos incompletos o malformados
  tracker.handleEvent(null as any);
  tracker.handleEvent({} as any);
  tracker.handleEvent({ type: 'mission_progress' });
  tracker.handleEvent({ type: 'mission_feature_updated' });
  tracker.handleEvent({ type: 'mission_worker_started', workerSessionId: null });
  tracker.handleEvent({ type: 'mission_worker_completed', exitCode: 'invalid' as any });
  tracker.handleEvent({ type: 'mission_milestone_validated', passed: 'yes' as any });

  // Format de evento malformado
  expect(formatMissionEvent(null as any)).toContain('[Misión]');
  expect(formatMissionEvent({ type: 'mission_feature_updated' })).toContain('[Misión] Feature desconocida');

  // Render seguro
  const rendered = tracker.renderPanel(80, true);
  expect(rendered).toContain('Mission Control');
  expect(rendered).toContain('Sin snapshot de misión disponible.');
});

test('límite: 100 features acotadas y nombres largos truncados', () => {
  const features: any[] = [];
  for (let i = 0; i < 120; i++) {
    features.push({
      id: `feature-con-nombre-extremadamente-largo-que-supera-con-creces-los-limites-razonables-del-terminal-${i}`,
      milestone: i % 2 === 0 ? 'milestone-uno' : 'milestone-dos',
      status: i < 50 ? 'completed' : 'pending',
      attempts: i,
    });
  }

  const snapshot: MissionProgressSnapshot = {
    missionId: 'm-large',
    title: 'Misión Masiva de Prueba con Título Extenso',
    state: 'running',
    updatedAt: new Date().toISOString(),
    features,
    milestones: [
      { id: 'milestone-uno', scrutiny: true, userTesting: false, verifiersPassed: true },
      { id: 'milestone-dos', scrutiny: false, userTesting: false, verifiersPassed: null },
    ],
    workers: [],
    totals: { completed: 50, total: 120, usage: { inputTokens: 1000, outputTokens: 500 }, durationMs: 10000 },
  };

  const rendered = renderMissionPanel(snapshot, 80, true);
  const lines = rendered.split('\n');

  // Cada línea debe ajustarse al ancho de forma controlada
  for (const line of lines) {
    expect(line.length).toBeLessThan(120);
  }

  // Verifica que las features no sobrepasen 100
  const featureLines = lines.filter(l => l.includes('(intentos: '));
  expect(featureLines.length).toBe(100);
});

test('cancelación: /mission pause aborta la señal de pausa y encola el mensaje; Ctrl+C sigue abortando el turno', async () => {
  let pauseSignalReceived: AbortSignal | undefined;
  let mailboxMessages: string[] = [];
  let startedResolve: () => void;
  const started = new Promise<void>(r => { startedResolve = r; });

  const longRun = async (opts: AgentOptions): Promise<AgentResult> => {
    pauseSignalReceived = (opts as any).mission?.pauseSignal;
    startedResolve();
    return new Promise(resolve => {
      const onAbort = () => {
        mailboxMessages = opts.receiveMessages?.() ?? [];
        resolve({
          sessionId: 's-pause',
          ok: true,
          text: 'Pausado por host',
          turns: 1,
          toolCalls: 0,
          durationMs: 100,
          usage: { inputTokens: 100, outputTokens: 50 },
          mission: { missionId: 'm-pause', state: 'paused', directory: '/tmp/m-pause', completed: 0, total: 2 },
        });
      };
      if (pauseSignalReceived?.aborted) {
        onAbort();
      } else {
        pauseSignalReceived?.addEventListener('abort', onAbort);
      }
    });
  };

  const f = await fixture(longRun as any);

  // Iniciar tarea
  const promise = f.app.submit('Empezar misión');
  await started;

  // Enviar comando /mission pause con mensaje de redirección mientras corre
  await f.app.submit('/mission pause reenfocar en auth primero');

  const result = await promise;
  expect(result).toBe(true);
  expect(pauseSignalReceived?.aborted).toBe(true);
  expect(mailboxMessages).toContain('reenfocar en auth primero');
  expect(f.app.missionTracker.state).toBe('paused');
  expect(f.io.output).toContain('Pausa solicitada al orquestador: reenfocar en auth primero');

  // Ahora comprobar Ctrl+C (app.interrupt) abortando el turno
  let abortSignalReceived: AbortSignal | undefined;
  let started2Resolve: () => void;
  const started2 = new Promise<void>(r => { started2Resolve = r; });

  const cancellableRun = async (opts: AgentOptions): Promise<AgentResult> => {
    abortSignalReceived = opts.signal;
    started2Resolve();
    return new Promise(resolve => {
      const onAbort = () => resolve({
        sessionId: 's-abort',
        ok: false,
        text: '',
        error: { type: 'aborted', message: 'Interrumpido por el usuario' },
        turns: 1,
        toolCalls: 0,
        durationMs: 50,
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener('abort', onAbort);
    });
  };

  const f2 = await fixture(cancellableRun as any);
  const promise2 = f2.app.submit('Segunda misión');
  await started2;
  f2.app.interrupt();
  await promise2;
  expect(abortSignalReceived?.aborted).toBe(true);
  expect(f2.io.output).toContain('Interrumpido por el usuario');
});

test('atajo Ctrl+T alterna el panel cuando hay misión y no hace nada sin misión', () => {
  const f = { app: new ChatController({ cwd: '/tmp', home: '/tmp' }, new MockIO()), io: new MockIO() };

  // Sin misión: no hace nada
  f.app.toggleMissionPanel();
  expect(f.app.missionTracker.panelVisible).toBe(false);

  // Con misión: alterna panel
  f.app.missionTracker.state = 'running';
  f.app.toggleMissionPanel();
  expect(f.app.missionTracker.panelVisible).toBe(true);
  f.app.toggleMissionPanel();
  expect(f.app.missionTracker.panelVisible).toBe(false);
});

test('/mode mission sigue exigiendo /auto high', async () => {
  const f = await fixture();
  f.app.config.autonomy = 'low';
  await expect(f.app.submit('/mode mission')).rejects.toThrow('high');

  f.app.config.autonomy = 'high';
  await f.app.submit('/mode mission');
  expect(f.app.config.mode).toBe('mission');
});
