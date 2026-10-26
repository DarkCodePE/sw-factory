/**
 * Snapshot of provider ToS classifications.
 *
 * Attributed snapshot from OmniRoute (ext/omniroute),
 * revision 866c46d2339175a1aafc5455b8c3949910b2bd30, dated 2026-06-05, MIT license.
 * Reference: open-sse/config/freeTierCatalog.ts:40-58.
 *
 * This classification represents reference catalog data for routing policy,
 * not a formal legal opinion. No network synchronization is performed at runtime.
 */

export const AVOID_SNAPSHOT_REVISION = '866c46d2339175a1aafc5455b8c3949910b2bd30';
export const AVOID_SNAPSHOT_DATE = '2026-06-05';

/**
 * 17 providers whose terms prohibit self-hosted proxy routing, non-personal use,
 * or scraping interfaces.
 */
export const AVOID_PROVIDERS: readonly string[] = Object.freeze([
  'duckduckgo-web',
  'agy',
  'antigravity',
  'kiro',
  'amazon-q',
  'muse-spark-web',
  't3-web',
  'modal',
  'nlpcloud',
  'blackbox',
  'completions',
  'fireworks',
  'featherless-ai',
  'friendliai',
  'ai21',
  'iflytek',
  'coze',
]);

const AVOID_SET: ReadonlySet<string> = new Set(AVOID_PROVIDERS);

/**
 * Canonical alias mappings for known provider identifiers.
 */
export const AVOID_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'agy': 'agy',
  'antigravity': 'agy',
  'duckduckgo': 'duckduckgo-web',
  'duckduckgo-web': 'duckduckgo-web',
  'ddg': 'duckduckgo-web',
  'kiro': 'kiro',
  'xkiro': 'kiro',
  'amazon-q': 'amazon-q',
  'amazonq': 'amazon-q',
  'q-developer': 'amazon-q',
  'aws-q': 'amazon-q',
  'muse-spark-web': 'muse-spark-web',
  'musespark': 'muse-spark-web',
  'muse-spark': 'muse-spark-web',
  't3-web': 't3-web',
  't3': 't3-web',
  'modal': 'modal',
  'modal-labs': 'modal',
  'nlpcloud': 'nlpcloud',
  'nlp-cloud': 'nlpcloud',
  'blackbox': 'blackbox',
  'blackbox-ai': 'blackbox',
  'completions': 'completions',
  'fireworks': 'fireworks',
  'fireworks-ai': 'fireworks',
  'featherless-ai': 'featherless-ai',
  'featherless': 'featherless-ai',
  'friendliai': 'friendliai',
  'friendli-ai': 'friendliai',
  'friendli': 'friendliai',
  'ai21': 'ai21',
  'ai21-labs': 'ai21',
  'iflytek': 'iflytek',
  'xfyun': 'iflytek',
  'sparkdesk': 'iflytek',
  'coze': 'coze',
});

/**
 * Known domains and host patterns associated with avoid providers.
 */
export const AVOID_HOSTS: readonly string[] = Object.freeze([
  'duckduckgo.com',
  'modal.com',
  'nlpcloud.com',
  'nlpcloud.io',
  'blackbox.ai',
  'fireworks.ai',
  'featherless.ai',
  'friendli.ai',
  'ai21.com',
  'xfyun.cn',
  'sparkdesk.cn',
  'coze.com',
  'kiro.ai',
  'q.aws',
]);

/**
 * Normalize a provider or model identifier for comparison.
 */
export function normalizeIdentifier(id: string): string {
  return id.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Resolve canonical provider ID if known in alias mappings.
 */
export function resolveCanonicalProvider(id: string): string {
  const normalized = normalizeIdentifier(id);
  return AVOID_ALIASES[normalized] ?? normalized;
}

/**
 * Check if a provider identifier matches a known avoid provider or alias.
 */
export function isAvoidProvider(id: string | undefined): boolean {
  if (!id || typeof id !== 'string') return false;
  const normalized = normalizeIdentifier(id);
  if (AVOID_SET.has(normalized)) return true;
  if (AVOID_ALIASES[normalized] && AVOID_SET.has(AVOID_ALIASES[normalized]!)) return true;

  // Check prefix before slash (e.g. "fireworks/llama-3")
  const slashIdx = normalized.indexOf('/');
  if (slashIdx !== -1) {
    const prefix = normalized.slice(0, slashIdx);
    if (AVOID_SET.has(prefix) || (AVOID_ALIASES[prefix] && AVOID_SET.has(AVOID_ALIASES[prefix]!))) {
      return true;
    }
  }

  // Check prefix before hyphen against avoid set (e.g. "fireworks-api")
  for (const avoid of AVOID_PROVIDERS) {
    if (normalized === avoid || normalized.startsWith(`${avoid}-`)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if an endpoint URL or hostname matches a known avoid host pattern.
 */
export function isAvoidEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint || typeof endpoint !== 'string') return false;
  let hostname = endpoint.trim().toLowerCase();
  try {
    const url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
    hostname = url.hostname.toLowerCase();
  } catch {
    hostname = hostname.replace(/^[a-z]+:\/\//i, '').split('/')[0]!.split(':')[0]!;
  }

  // Remove bracket formatting for IPv6 if any
  hostname = hostname.replace(/^\[|\]$/g, '');

  for (const pattern of AVOID_HOSTS) {
    if (hostname === pattern || hostname.endsWith(`.${pattern}`)) {
      return true;
    }
  }

  return false;
}
