import type { Message, ModelProvider, ModelRequest } from '../types.ts';
import type { RouterCandidate, RoutingContext } from './types.ts';

/**
 * Builds the prompt messages and configuration for candidate classification.
 * The prompt asks the classifier model to rate the suitability of each candidate
 * on a scale of 0.0 to 1.0 without revealing candidate costs.
 */
export function buildClassifierRequest(
  cands: RouterCandidate[],
  ctx: RoutingContext,
): { messages: Message[]; maxOutputTokens: number } {
  const systemPrompt = `You are an evaluation engine for an AI model routing system.
Your task is to evaluate the suitability of candidate models for a given user request and operational context.

For each candidate model, assign a suitability score between 0.0 and 1.0:
- 0.0 = Model cannot handle this task (too complex, lacks capability, or high risk of failure).
- 1.0 = Model is fully capable and more than sufficient for the task.

Candidate models have different capabilities (reasoning effort, vision support, general description).
DO NOT consider cost; evaluate ONLY task feasibility and capability fit.

You must respond with ONLY a JSON object (raw or in a \`\`\`json markdown block) matching this schema:
{
  "scores": {
    "<modelId>": <number between 0.0 and 1.0>
  },
  "reasoning": "<concise explanation of ratings>"
}`;

  const candidateCards = cands
    .map(c => {
      const parts = [
        `- Candidate ID: "${c.modelId}"`,
        `  Description: ${c.description || 'General-purpose model'}`,
        `  Supports Images: ${c.supportsImages ? 'yes' : 'no'}`,
      ];
      if (c.reasoningEffort) {
        parts.push(`  Reasoning Effort: ${c.reasoningEffort}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  const toolSummary = ctx.toolNames.length > 0 ? ctx.toolNames.join(', ') : 'None';

  const userPrompt = `# Candidate Models
${candidateCards}

# Routing Context
- User Request: ${ctx.userMessage || '(empty)'}
- Turn Number: ${ctx.turnNumber}
- Execution Surface: ${ctx.surface}
- Is Subagent: ${ctx.isSubagent ? 'yes' : 'no'}
- Images Present: ${ctx.imagesPresent ? 'yes' : 'no'}
- Prior Failed Tool Calls: ${ctx.hasFailedToolCalls ? 'yes' : 'no'}
- Available Tools: ${toolSummary}

Evaluate and assign scores between 0.0 and 1.0 for each candidate model ID.`;

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxOutputTokens: 4096,
  };
}

/**
 * Parses and validates the classifier model output.
 * Accepts bare JSON or JSON wrapped in markdown code fences.
 * Clamps scores to [0, 1], initializes missing candidate IDs to 0, and ignores unknown IDs.
 * Returns undefined if output is not valid or cannot be parsed.
 */
export function parseClassifierOutput(
  text: string,
  ids: string[],
): { scores: Record<string, number>; rationale?: string } | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }

  let cleaned = text.trim();

  // Try extracting from markdown code block if present
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch && codeBlockMatch[1] !== undefined) {
    cleaned = codeBlockMatch[1].trim();
  } else {
    // If there is commentary before/after the JSON object, extract between first '{' and last '}'
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (!obj.scores || typeof obj.scores !== 'object' || Array.isArray(obj.scores)) {
    return undefined;
  }

  const rawScores = obj.scores as Record<string, unknown>;
  const scores: Record<string, number> = {};

  // Missing IDs count as 0, unknown IDs are ignored
  for (const id of ids) {
    const val = rawScores[id];
    if (typeof val === 'number' && !Number.isNaN(val)) {
      scores[id] = Math.max(0, Math.min(1, val));
    } else {
      scores[id] = 0;
    }
  }

  const rationale =
    typeof obj.reasoning === 'string'
      ? obj.reasoning
      : typeof obj.rationale === 'string'
        ? obj.rationale
        : undefined;

  return { scores, rationale };
}

/**
 * Executes a classification call against the classifier provider.
 * Implements a strict timeout deadline and ensures external abort signal propagation.
 * Any classifier failure (timeout, network error, invalid JSON) resolves to undefined.
 */
export async function classify(
  provider: ModelProvider,
  cands: RouterCandidate[],
  ctx: RoutingContext,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<{ scores: Record<string, number>; rationale?: string } | undefined> {
  if (opts.signal.aborted) {
    throw (opts.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
  }

  const { messages, maxOutputTokens } = buildClassifierRequest(cands, ctx);
  const request: ModelRequest = {
    messages,
    tools: [],
    maxOutputTokens,
  };

  const timeoutController = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    timeoutController.abort(opts.signal.reason);
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  const timeoutPromise = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      timeoutController.abort(new DOMException('Classifier timeout exceeded', 'TimeoutError'));
      resolve(undefined);
    }, opts.timeoutMs);
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (opts.signal.aborted) {
      reject(opts.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          reject(opts.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        },
        { once: true },
      );
    }
  });

  const providerPromise = (async () => {
    try {
      const turn = await provider.complete(request, timeoutController.signal);
      const candIds = cands.map(c => c.modelId);
      return parseClassifierOutput(turn.text, candIds);
    } catch (err) {
      if (opts.signal.aborted) {
        throw (opts.signal.reason ?? err);
      }
      return undefined;
    }
  })();

  try {
    return await Promise.race([providerPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    opts.signal.removeEventListener('abort', onAbort);
  }
}
