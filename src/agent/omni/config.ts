import type { LeafDescriptor, OmniConfig, Profile, Tos } from './contracts.ts';
import { effectiveTos } from './policy.ts';

/**
 * Check if a hostname represents a local loopback address.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(host)) return true;
  return false;
}

const ALLOWED_CONFIG_KEYS = new Set([
  'version',
  'allowPaid',
  'maxAttempts',
  'maxWaitMs',
  'requestTimeoutMs',
  'profiles',
]);

const ALLOWED_PROFILE_KEYS = new Set([
  'modelId',
  'providerId',
  'accountId',
  'quotaGroup',
  'costTier',
  'tos',
  'acknowledgeTos',
  'supportsTools',
  'supportsImages',
  'contextWindow',
  'priority',
]);

const ALLOWED_TOS = new Set<Tos>(['ok', 'caution', 'ambiguous', 'avoid', 'unknown']);

/**
 * Validate and normalize an Omni router configuration against its leaf models.
 *
 * Enforces:
 * - Version 1 and reject unknown fields
 * - 1 to 32 profiles with unique modelIds referencing existing customModels
 * - Reserved identifier "omni" cannot be shadowed
 * - Only leaves with provider "generic-chat-completion-api"
 * - Explicit baseUrl with HTTPS or loopback HTTP, no userinfo, query, or fragment
 * - Keys must use ${ENV_NAME} convention; missing keys only permitted on loopback
 * - Numeric boundaries (maxAttempts: 1..8, maxWaitMs: 0..60000, requestTimeoutMs: 1..120000,
 *   contextWindow: >0, priority: 0..1000)
 * - Pure function: no environment variable resolution, no network access
 */
export function validateOmniConfig(raw: unknown, leaves: readonly LeafDescriptor[]): OmniConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Omni config must be a non-null object');
  }

  // Handle case where root settings object with single 'omniRouter' key is passed
  let cfg = raw as Record<string, unknown>;
  if ('omniRouter' in cfg && !('version' in cfg)) {
    const candidate = cfg.omniRouter;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('omniRouter section must be a non-null object');
    }
    cfg = candidate as Record<string, unknown>;
  }

  // Reject unknown top-level keys
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error(`Unknown field in omni config: "${key}"`);
    }
  }

  // Version must be 1
  if (cfg.version !== 1) {
    throw new Error(`Omni config version must be 1, got ${JSON.stringify(cfg.version)}`);
  }

  // allowPaid: strict boolean, default false
  let allowPaid = false;
  if (cfg.allowPaid !== undefined) {
    if (typeof cfg.allowPaid !== 'boolean') {
      throw new Error('allowPaid must be a boolean');
    }
    allowPaid = cfg.allowPaid;
  }

  // maxAttempts: integer 1..8, default 4
  let maxAttempts = 4;
  if (cfg.maxAttempts !== undefined) {
    if (typeof cfg.maxAttempts !== 'number' || !Number.isSafeInteger(cfg.maxAttempts) || cfg.maxAttempts < 1 || cfg.maxAttempts > 8) {
      throw new Error('maxAttempts must be an integer between 1 and 8');
    }
    maxAttempts = cfg.maxAttempts;
  }

  // maxWaitMs: integer 0..60000, default 15000
  let maxWaitMs = 15000;
  if (cfg.maxWaitMs !== undefined) {
    if (typeof cfg.maxWaitMs !== 'number' || !Number.isSafeInteger(cfg.maxWaitMs) || cfg.maxWaitMs < 0 || cfg.maxWaitMs > 60000) {
      throw new Error('maxWaitMs must be an integer between 0 and 60000');
    }
    maxWaitMs = cfg.maxWaitMs;
  }

  // requestTimeoutMs: integer 1..120000, default 30000
  let requestTimeoutMs = 30000;
  if (cfg.requestTimeoutMs !== undefined) {
    if (typeof cfg.requestTimeoutMs !== 'number' || !Number.isSafeInteger(cfg.requestTimeoutMs) || cfg.requestTimeoutMs < 1 || cfg.requestTimeoutMs > 120000) {
      throw new Error('requestTimeoutMs must be an integer between 1 and 120000');
    }
    requestTimeoutMs = cfg.requestTimeoutMs;
  }

  // profiles array
  if (!Array.isArray(cfg.profiles)) {
    throw new Error('profiles must be an array');
  }
  if (cfg.profiles.length < 1 || cfg.profiles.length > 32) {
    throw new Error(`profiles must contain between 1 and 32 entries, got ${cfg.profiles.length}`);
  }

  // Validate leaves
  if (!Array.isArray(leaves)) {
    throw new Error('leaves must be an array');
  }

  const leavesById = new Map<string, LeafDescriptor>();
  for (const leaf of leaves) {
    if (!leaf || typeof leaf !== 'object') {
      throw new Error('Leaf descriptor must be a non-null object');
    }
    if (typeof leaf.id !== 'string' || !leaf.id) {
      throw new Error('Leaf id must be a non-empty string');
    }
    if (leaf.id.toLowerCase() === 'omni' || (typeof leaf.provider === 'string' && leaf.provider.toLowerCase() === 'omni')) {
      throw new Error('Model ID or provider "omni" is reserved and cannot be shadowed');
    }
    if (leavesById.has(leaf.id)) {
      throw new Error(`Duplicate leaf id: "${leaf.id}"`);
    }
    leavesById.set(leaf.id, leaf);
  }

  const seenModelIds = new Set<string>();
  const validatedProfiles: Profile[] = [];

  for (let i = 0; i < cfg.profiles.length; i++) {
    const rawProfile = cfg.profiles[i];
    if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
      throw new Error(`Profile at index ${i} must be a non-null object`);
    }

    const p = rawProfile as Record<string, unknown>;

    // Reject unknown profile fields
    for (const key of Object.keys(p)) {
      if (!ALLOWED_PROFILE_KEYS.has(key)) {
        throw new Error(`Unknown field in profile at index ${i}: "${key}"`);
      }
    }

    // modelId
    if (typeof p.modelId !== 'string' || !p.modelId.trim()) {
      throw new Error(`Profile at index ${i} must specify a non-empty modelId`);
    }
    if (p.modelId.toLowerCase() === 'omni') {
      throw new Error(`Profile at index ${i} cannot use reserved modelId "omni"`);
    }
    if (seenModelIds.has(p.modelId)) {
      throw new Error(`Duplicate profile modelId "${p.modelId}" at index ${i}`);
    }
    seenModelIds.add(p.modelId);

    // Check referenced leaf
    const leaf = leavesById.get(p.modelId);
    if (!leaf) {
      throw new Error(`Profile at index ${i} references unconfigured leaf model "${p.modelId}"`);
    }

    // Leaf provider must be generic-chat-completion-api
    if (leaf.provider !== 'generic-chat-completion-api') {
      throw new Error(`Leaf "${leaf.id}" has unsupported provider "${leaf.provider}". Only "generic-chat-completion-api" is allowed`);
    }

    // Leaf baseUrl validation
    if (typeof leaf.baseUrl !== 'string' || !leaf.baseUrl.trim()) {
      throw new Error(`Leaf "${leaf.id}" must specify an explicit non-empty baseUrl`);
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(leaf.baseUrl);
    } catch {
      throw new Error(`Leaf "${leaf.id}" has invalid baseUrl`);
    }

    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(`Leaf "${leaf.id}" baseUrl must use https or http protocol`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error(`Leaf "${leaf.id}" baseUrl must not include userinfo or credentials`);
    }
    if (parsedUrl.search) {
      throw new Error(`Leaf "${leaf.id}" baseUrl must not include query parameters`);
    }
    if (parsedUrl.hash) {
      throw new Error(`Leaf "${leaf.id}" baseUrl must not include fragment`);
    }

    const isLoopback = isLoopbackHost(parsedUrl.hostname);
    if (parsedUrl.protocol === 'http:' && !isLoopback) {
      throw new Error(`Leaf "${leaf.id}" remote baseUrl must use HTTPS; HTTP is only permitted on loopback`);
    }

    // Key conventions on leaf
    if (leaf.apiKeyHelper !== undefined) {
      throw new Error(`Leaf "${leaf.id}" must not use apiKeyHelper; Omni leaves require \${ENV_NAME}`);
    }
    if (leaf.authFile !== undefined) {
      throw new Error(`Leaf "${leaf.id}" must not use authFile; Omni leaves require \${ENV_NAME}`);
    }

    if (leaf.apiKey !== undefined) {
      if (typeof leaf.apiKey !== 'string' || !/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.test(leaf.apiKey)) {
        throw new Error(`Leaf "${leaf.id}" apiKey must use \${ENV_NAME} convention; literal keys are prohibited`);
      }
    } else {
      if (!isLoopback) {
        throw new Error(`Leaf "${leaf.id}" requires an apiKey using \${ENV_NAME}; missing apiKey is only permitted on loopback`);
      }
    }

    // providerId
    if (typeof p.providerId !== 'string' || !p.providerId.trim()) {
      throw new Error(`Profile at index ${i} must specify a non-empty providerId`);
    }
    if (p.providerId.toLowerCase() === 'omni') {
      throw new Error(`Profile at index ${i} cannot use reserved providerId "omni"`);
    }

    // accountId
    if (typeof p.accountId !== 'string' || !p.accountId.trim()) {
      throw new Error(`Profile at index ${i} must specify a non-empty accountId`);
    }

    // quotaGroup
    if (typeof p.quotaGroup !== 'string' || !p.quotaGroup.trim()) {
      throw new Error(`Profile at index ${i} must specify a non-empty quotaGroup`);
    }

    // costTier
    if (p.costTier !== 'free' && p.costTier !== 'paid') {
      throw new Error(`Profile at index ${i} costTier must be 'free' or 'paid', got ${JSON.stringify(p.costTier)}`);
    }

    // tos
    if (typeof p.tos !== 'string' || !ALLOWED_TOS.has(p.tos as Tos)) {
      throw new Error(`Profile at index ${i} tos must be one of 'ok'|'caution'|'ambiguous'|'avoid'|'unknown', got ${JSON.stringify(p.tos)}`);
    }

    // acknowledgeTos
    if (p.acknowledgeTos !== undefined && typeof p.acknowledgeTos !== 'boolean') {
      throw new Error(`Profile at index ${i} acknowledgeTos must be a boolean`);
    }

    // supportsTools
    if (typeof p.supportsTools !== 'boolean') {
      throw new Error(`Profile at index ${i} supportsTools must be a boolean`);
    }

    // supportsImages
    if (typeof p.supportsImages !== 'boolean') {
      throw new Error(`Profile at index ${i} supportsImages must be a boolean`);
    }

    // contextWindow
    if (typeof p.contextWindow !== 'number' || !Number.isSafeInteger(p.contextWindow) || p.contextWindow <= 0) {
      throw new Error(`Profile at index ${i} contextWindow must be a positive integer`);
    }

    // priority
    if (typeof p.priority !== 'number' || !Number.isSafeInteger(p.priority) || p.priority < 0 || p.priority > 1000) {
      throw new Error(`Profile at index ${i} priority must be an integer between 0 and 1000`);
    }

    const candidateProfile: Profile = {
      modelId: p.modelId,
      providerId: p.providerId,
      accountId: p.accountId,
      quotaGroup: p.quotaGroup,
      costTier: p.costTier,
      tos: p.tos as Tos,
      ...(p.acknowledgeTos !== undefined ? { acknowledgeTos: p.acknowledgeTos } : {}),
      supportsTools: p.supportsTools,
      supportsImages: p.supportsImages,
      contextWindow: p.contextWindow,
      priority: p.priority,
    };

    // Calculate effective ToS against catalog and endpoint
    const resolvedTos = effectiveTos(candidateProfile, leaf.baseUrl);
    candidateProfile.tos = resolvedTos;

    validatedProfiles.push(Object.freeze(candidateProfile));
  }

  return Object.freeze({
    version: 1,
    allowPaid,
    maxAttempts,
    maxWaitMs,
    requestTimeoutMs,
    profiles: Object.freeze(validatedProfiles),
  });
}
