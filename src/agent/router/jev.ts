import type { RouterCandidate, RoutingContext } from './types.ts';

export interface JevClassifierOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs: number;
  signal: AbortSignal;
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

type JevResponse = { answers?: Record<string, unknown> };

/** Score eligible candidates with one typed Noul question per candidate. */
export async function classifyWithJev(
  candidates: RouterCandidate[],
  context: RoutingContext,
  options: JevClassifierOptions,
): Promise<{ scores: Record<string, number>; rationale: string } | undefined> {
  if (options.signal.aborted) {
    throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return undefined;

  const questions: Record<string, { type: 'noul'; instructions: string }> = {};
  const answerIds = new Map<string, string>();
  candidates.forEach((candidate, index) => {
    const questionId = `candidate_${index}`;
    answerIds.set(candidate.modelId, questionId);
    questions[questionId] = {
      type: 'noul',
      instructions: `¿el candidato ${candidate.modelId} (${candidate.description || 'modelo de propósito general'}) basta para esta tarea?`,
    };
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', onAbort, { once: true });

  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('Classifier timeout exceeded', 'TimeoutError'));
      resolve(undefined);
    }, options.timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    options.signal.addEventListener('abort', () => {
      reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    }, { once: true });
  });

  const request = (async () => {
    try {
      const response = await (options.fetch ?? fetch)(options.baseUrl ?? 'https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model ?? 'jev-latest',
          state: context,
          questions,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return undefined;

      const payload = await response.json() as JevResponse;
      if (!payload || typeof payload !== 'object' || !payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers)) {
        return undefined;
      }

      const scores: Record<string, number> = {};
      for (const [modelId, answerId] of answerIds) {
        const answer = payload.answers[answerId];
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
        const answerFields = answer as Record<string, unknown>;
        if (answerFields.type !== 'noul') return undefined;
        const noul = answerFields.noul;
        if (typeof noul !== 'number' || !Number.isFinite(noul)) return undefined;
        scores[modelId] = Math.max(0, Math.min(1, noul));
      }
      const summary = Object.entries(scores).map(([id, score]) => `${id}=${score.toFixed(2)}`).join(', ');
      return { scores, rationale: `Jev fit: ${summary}` };
    } catch {
      if (options.signal.aborted) {
        throw options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
      }
      return undefined;
    }
  })();

  try {
    return await Promise.race([request, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}
