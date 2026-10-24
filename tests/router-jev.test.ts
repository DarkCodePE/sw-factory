import { describe, expect, test } from 'bun:test';
import { classifyWithJev } from '../src/agent/router/jev.ts';
import { route } from '../src/agent/router/index.ts';
import type { RouterCandidate, RoutingContext } from '../src/agent/router/types.ts';

const candidates: RouterCandidate[] = [
  { modelId: 'hermes', description: 'tareas sencillas', relativeCost: 1, supportsImages: false },
  { modelId: 'qwen', description: 'refactors complejos', relativeCost: 5, supportsImages: true },
];
const context: RoutingContext = {
  userMessage: 'Corrige el parser y añade pruebas',
  turnNumber: 2,
  surface: 'exec',
  isSubagent: false,
  imagesPresent: false,
  hasFailedToolCalls: true,
  toolNames: ['Read', 'Edit'],
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Jev classifier', () => {
  test('sends one Noul question per candidate, context state, and bearer auth', async () => {
    let request: RequestInit | undefined;
    let url = '';
    const result = await classifyWithJev(candidates, context, {
      apiKey: 'secret-je v',
      signal: new AbortController().signal,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        url = String(input);
        request = init;
        return response({ answers: { candidate_0: { type: 'noul', noul: 0.91 }, candidate_1: { type: 'noul', noul: 0.22 } } });
      }) as unknown as typeof fetch,
      timeoutMs: 100,
    });

    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('authorization')).toBe('Bearer secret-je v');
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual(context);
    expect(Object.keys(body.questions)).toEqual(['candidate_0', 'candidate_1']);
    expect(body.questions.candidate_0).toMatchObject({ type: 'noul' });
    expect(body.questions.candidate_0.instructions).toContain('hermes (tareas sencillas)');
    expect(result).toEqual({
      scores: { hermes: 0.91, qwen: 0.22 },
      rationale: 'Jev fit: hermes=0.91, qwen=0.22',
    });
    expect(JSON.stringify(result)).not.toContain('secret-je v');
  });

  test('supports overrides and clamps Noul probabilities', async () => {
    let sentUrl = '';
    const result = await classifyWithJev(candidates.slice(0, 1), context, {
      apiKey: 'test-key', model: 'jev-1.14.0', baseUrl: 'https://example.test/decision', timeoutMs: 100,
      signal: new AbortController().signal,
      fetch: (async (input: RequestInfo | URL) => {
        sentUrl = String(input);
        return response({ answers: { candidate_0: { type: 'noul', noul: 1.4 } } });
      }) as unknown as typeof fetch,
    });
    expect(sentUrl).toBe('https://example.test/decision');
    expect(result?.scores.hermes).toBe(1);
  });

  test('returns undefined for missing key, HTTP errors, malformed JSON and invalid answers', async () => {
    expect(await classifyWithJev(candidates, context, {
      signal: new AbortController().signal, timeoutMs: 100,
    })).toBeUndefined();

    for (const fetcher of [
      (async () => response({}, 401)) as unknown as typeof fetch,
      (async () => response({}, 500)) as unknown as typeof fetch,
      (async () => new Response('not json')) as unknown as typeof fetch,
      (async () => response({ answers: { candidate_0: { type: 'noul', noul: 'high' }, candidate_1: { type: 'noul', noul: 0.8 } } })) as unknown as typeof fetch,
      (async () => response({ answers: { candidate_0: { type: 'score', noul: 0.8 }, candidate_1: { noul: 0.8 } } })) as unknown as typeof fetch,
    ]) {
      expect(await classifyWithJev(candidates, context, {
        apiKey: 'private-test-key', signal: new AbortController().signal, timeoutMs: 100, fetch: fetcher,
      })).toBeUndefined();
    }
  });

  test('times out as undefined and only propagates an external abort', async () => {
    const timedOut = await classifyWithJev(candidates, context, {
      apiKey: 'private-test-key', timeoutMs: 5, signal: new AbortController().signal,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private-test-key')));
      })) as unknown as typeof fetch,
    });
    expect(timedOut).toBeUndefined();

    const abort = new AbortController();
    const reason = new Error('external abort');
    const pending = classifyWithJev(candidates, context, {
      apiKey: 'private-test-key', timeoutMs: 1000, signal: abort.signal,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('private-test-key')));
      })) as unknown as typeof fetch,
    });
    abort.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  test('does not surface credentials in failures or rationale', async () => {
    const credential = 'never-print-this';
    const result = await classifyWithJev(candidates, context, {
      apiKey: credential, signal: new AbortController().signal, timeoutMs: 100,
      fetch: (async () => { throw new Error(credential); }) as unknown as typeof fetch,
    });
    expect(result).toBeUndefined();
    expect(String(JSON.stringify(result))).not.toContain(credential);
  });

  test('missing API key produces classifier_failed and a single generic notice', async () => {
    const previousJev = process.env.JEV_API_KEY;
    const previousTypeSafe = process.env.TYPESAFE_API_KEY;
    const warn = console.warn;
    const notices: string[] = [];
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    console.warn = (message?: unknown) => { notices.push(String(message)); };
    try {
      const config = { classifier: { kind: 'jev' as const }, candidates };
      const first = await route(config, undefined, context, new AbortController().signal);
      const second = await route(config, undefined, context, new AbortController().signal);
      expect(first.reason).toBe('classifier_failed');
      expect(second.reason).toBe('classifier_failed');
      expect(notices).toHaveLength(1);
      expect(notices[0]).not.toContain('secret');
    } finally {
      console.warn = warn;
      if (previousJev === undefined) delete process.env.JEV_API_KEY;
      else process.env.JEV_API_KEY = previousJev;
      if (previousTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previousTypeSafe;
    }
  });

  test('removes its abort listener after resolving, so a later abort rejects nothing', async () => {
    const controller = new AbortController();
    const live = new Set<EventListenerOrEventListenerObject>();
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'abort') live.add(listener);
      add(type, listener, opts as AddEventListenerOptions);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'abort') live.delete(listener);
      remove(type, listener, opts as EventListenerOptions);
    }) as typeof controller.signal.removeEventListener;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      for (let turn = 0; turn < 3; turn++) {
        const result = await classifyWithJev(candidates, context, {
          apiKey: 'secret',
          signal: controller.signal,
          fetch: (async () => response({ answers: { candidate_0: { type: 'noul', noul: 0.9 }, candidate_1: { type: 'noul', noul: 0.2 } } })) as unknown as typeof fetch,
          timeoutMs: 100,
        });
        expect(result?.scores.hermes).toBe(0.9);
      }
      expect(live.size).toBe(0);

      controller.abort(new Error('session closed'));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('still rejects with the external reason when aborted mid-request', async () => {
    const controller = new AbortController();
    const pending = classifyWithJev(candidates, context, {
      apiKey: 'secret',
      signal: controller.signal,
      fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const reason = new Error('ctrl-c');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
