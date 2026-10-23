import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoutedProvider } from '../src/agent/providers/router.ts';
import { configuredProviders, loadExecSettings, resolveModelAlias } from '../src/agent/settings.ts';
import { ProviderError } from '../src/agent/provider.ts';
import type { AgentEvent, ModelProvider, ModelRequest, ModelTurn } from '../src/agent/types.ts';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function writeTempSettings(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fab-routing-test-'));
  tempDirs.push(dir);
  const path = join(dir, 'settings.json');
  await writeFile(path, JSON.stringify(content, null, 2));
  return path;
}

function mockProvider(
  id: string,
  fn: (req: ModelRequest, signal: AbortSignal, delta?: (text: string) => void) => Promise<ModelTurn>,
): ModelProvider {
  return { id, complete: fn };
}

describe('Model Routing and Aliases', () => {
  describe('positivo', () => {
    test('alias resuelve correctamente a través de configuredProviders y resolveModelAlias', async () => {
      const settings = {
        customModels: [
          { id: 'm1', model: 'mock-1', provider: 'generic-chat-completion-api' as const },
        ],
        modelAliases: {
          fast: 'm1',
          speed: 'fast',
        },
      };

      expect(resolveModelAlias('fast', settings.modelAliases)).toBe('m1');
      expect(resolveModelAlias('speed', settings.modelAliases)).toBe('m1');
      expect(resolveModelAlias('m1', settings.modelAliases)).toBe('m1');

      const configured = configuredProviders(settings, { model: 'speed' });
      expect(configured.defaultModelId).toBe('speed');
      expect(configured.providers.speed).toBeDefined();
      expect(configured.providers.fast).toBeDefined();
      expect(configured.providers.m1).toBeDefined();
      expect(configured.providers.speed).toBe(configured.providers.m1);
    });

    test('429 del primario responde el fallback con evento model_fallback', async () => {
      const events: AgentEvent[] = [];
      const primary = mockProvider('primary-model', async () => {
        throw new ProviderError('Model HTTP 429: Too Many Requests', true);
      });
      const fallback = mockProvider('fallback-model', async () => {
        return { text: 'fallback answer', toolCalls: [], finishReason: 'stop' };
      });

      const routed = createRoutedProvider(
        primary,
        [{ id: 'fallback-model', provider: fallback }],
        { on: ['rate_limit'] },
        e => events.push(e),
      );

      const res = await routed.complete({} as any, new AbortController().signal);
      expect(res.text).toBe('fallback answer');
      expect(events.length).toBe(1);
      expect(events[0]!.type as string).toBe('model_fallback');
      expect(events[0]!.from).toBe('primary-model');
      expect(events[0]!.to).toBe('fallback-model');
      expect(events[0]!.reason).toBe('rate_limit');
    });

    test('500 del primario responde el fallback con evento model_fallback', async () => {
      const events: AgentEvent[] = [];
      const primary = mockProvider('primary-model', async () => {
        throw new ProviderError('Model HTTP 500: Server Error', true);
      });
      const fallback = mockProvider('fallback-model', async () => {
        return { text: 'recovered from 500', toolCalls: [], finishReason: 'stop' };
      });

      const routed = createRoutedProvider(
        primary,
        [fallback],
        { on: ['server_error'] },
        e => events.push(e),
      );

      const res = await routed.complete({} as any, new AbortController().signal);
      expect(res.text).toBe('recovered from 500');
      expect(events.length).toBe(1);
      expect(events[0]!.type as string).toBe('model_fallback');
      expect(events[0]!.from).toBe('primary-model');
      expect(events[0]!.to).toBe('fallback-model');
      expect(events[0]!.reason).toBe('server_error');
    });

    test('cadena de dos fallbacks (429 -> 503 -> ok)', async () => {
      const events: AgentEvent[] = [];
      let callCount = { p: 0, fb1: 0, fb2: 0 };
      const primary = mockProvider('p', async () => {
        callCount.p++;
        throw new ProviderError('rate limit 429', true);
      });
      const fb1 = mockProvider('fb1', async () => {
        callCount.fb1++;
        throw new ProviderError('HTTP 503 Service Unavailable', true);
      });
      const fb2 = mockProvider('fb2', async () => {
        callCount.fb2++;
        return { text: 'fb2 final success', toolCalls: [], finishReason: 'stop' };
      });

      const routed = createRoutedProvider(
        primary,
        [fb1, fb2],
        { on: ['rate_limit', 'server_error'] },
        e => events.push(e),
      );

      const res = await routed.complete({} as any, new AbortController().signal);
      expect(res.text).toBe('fb2 final success');
      expect(callCount.p).toBe(1);
      expect(callCount.fb1).toBe(1);
      expect(callCount.fb2).toBe(1);
      expect(events.length).toBe(2);
      expect(events[0]!.from).toBe('p');
      expect(events[0]!.to).toBe('fb1');
      expect(events[0]!.reason).toBe('rate_limit');
      expect(events[1]!.from).toBe('fb1');
      expect(events[1]!.to).toBe('fb2');
      expect(events[1]!.reason).toBe('server_error');
    });
  });

  describe('negativo', () => {
    test('alias a modelo inexistente es rechazado en loadExecSettings', async () => {
      const path = await writeTempSettings({
        customModels: [{ id: 'm1', model: 'mock', provider: 'generic-chat-completion-api' }],
        modelAliases: {
          badAlias: 'unknown-model-id',
        },
      });

      await expect(loadExecSettings(path)).rejects.toThrow(/points to unknown model/);
    });

    test('ciclo de aliases es rechazado en loadExecSettings', async () => {
      const path = await writeTempSettings({
        customModels: [{ id: 'm1', model: 'mock', provider: 'generic-chat-completion-api' }],
        modelAliases: {
          a: 'b',
          b: 'a',
        },
      });

      await expect(loadExecSettings(path)).rejects.toThrow(/Cycle detected/);
    });

    test('on inválido en modelRouting es rechazado en loadExecSettings', async () => {
      const path = await writeTempSettings({
        customModels: [
          { id: 'm1', model: 'mock1', provider: 'generic-chat-completion-api' },
          { id: 'm2', model: 'mock2', provider: 'generic-chat-completion-api' },
        ],
        modelRouting: {
          m1: {
            fallback: ['m2'],
            on: ['non_existent_reason' as any],
          },
        },
      });

      await expect(loadExecSettings(path)).rejects.toThrow(/Invalid model routing 'on' reason/);
    });

    test('400 del primario no hace fallback', async () => {
      let fbCalled = false;
      const primary = mockProvider('p', async () => {
        throw new ProviderError('Model HTTP 400: Bad Request', false);
      });
      const fallback = mockProvider('fb', async () => {
        fbCalled = true;
        return { text: 'should not be called', toolCalls: [], finishReason: 'stop' };
      });

      const routed = createRoutedProvider(primary, [fallback]);
      await expect(routed.complete({} as any, new AbortController().signal)).rejects.toThrow(/HTTP 400/);
      expect(fbCalled).toBe(false);
    });

    test('error tras delta parcial no hace fallback', async () => {
      let fbCalled = false;
      const primary = mockProvider('p', async (_req, _sig, delta) => {
        delta?.('partial content start...');
        throw new ProviderError('Model HTTP 500: mid-stream crash', true);
      });
      const fallback = mockProvider('fb', async () => {
        fbCalled = true;
        return { text: 'fallback answer', toolCalls: [], finishReason: 'stop' };
      });

      const delivered: string[] = [];
      const routed = createRoutedProvider(primary, [fallback]);
      await expect(
        routed.complete({} as any, new AbortController().signal, t => delivered.push(t)),
      ).rejects.toThrow(/HTTP 500/);
      expect(delivered).toEqual(['partial content start...']);
      expect(fbCalled).toBe(false);
    });
  });

  describe('límite', () => {
    test('cadena de 8 saltos de alias es aceptada', () => {
      const aliases: Record<string, string> = {
        a1: 'a2',
        a2: 'a3',
        a3: 'a4',
        a4: 'a5',
        a5: 'a6',
        a6: 'a7',
        a7: 'a8',
        a8: 'target',
      };
      expect(resolveModelAlias('a1', aliases)).toBe('target');
    });

    test('cadena de 9 saltos de alias es rechazada', () => {
      const aliases: Record<string, string> = {
        a1: 'a2',
        a2: 'a3',
        a3: 'a4',
        a4: 'a5',
        a5: 'a6',
        a6: 'a7',
        a7: 'a8',
        a8: 'a9',
        a9: 'target',
      };
      expect(() => resolveModelAlias('a1', aliases)).toThrow(/exceeds 8 hops/);
    });
  });

  describe('cancelación', () => {
    test('abort durante el fallback no lanza el siguiente modelo', async () => {
      const controller = new AbortController();
      let fb2Called = false;

      const primary = mockProvider('p', async () => {
        throw new ProviderError('Model HTTP 429: Too Many Requests', true);
      });
      const fb1 = mockProvider('fb1', async (_req, signal) => {
        // Abort while handling fallback 1
        controller.abort(new Error('User aborted during fallback 1'));
        signal.throwIfAborted();
        return { text: 'never', toolCalls: [], finishReason: 'stop' };
      });
      const fb2 = mockProvider('fb2', async () => {
        fb2Called = true;
        return { text: 'never', toolCalls: [], finishReason: 'stop' };
      });

      const routed = createRoutedProvider(primary, [fb1, fb2]);
      await expect(routed.complete({} as any, controller.signal)).rejects.toThrow(/User aborted/);
      expect(fb2Called).toBe(false);
    });
  });
});
