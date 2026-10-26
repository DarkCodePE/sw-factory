import { describe, expect, test } from 'bun:test';
import type { LeafDescriptor } from '../src/agent/omni/contracts.ts';
import { validateOmniConfig, isLoopbackHost } from '../src/agent/omni/config.ts';

function validLeaf(overrides: Partial<LeafDescriptor> & { apiKey?: string; apiKeyHelper?: unknown; authFile?: unknown } = {}): LeafDescriptor {
  return {
    id: 'model-a',
    model: 'gpt-4o-mini',
    provider: 'generic-chat-completion-api',
    baseUrl: 'https://api.example.com/v1',
    apiKey: '${MODEL_A_KEY}',
    ...overrides,
  };
}

function validProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'model-a',
    providerId: 'provider-a',
    accountId: 'account-1',
    quotaGroup: 'group-1',
    costTier: 'free',
    tos: 'ok',
    acknowledgeTos: true,
    supportsTools: true,
    supportsImages: false,
    contextWindow: 32768,
    priority: 10,
    ...overrides,
  };
}

describe('Omni Config Validation', () => {
  test('valid config with defaults populated and frozen structure', () => {
    const raw = {
      version: 1,
      profiles: [validProfile()],
    };
    const leaves = [validLeaf()];

    const config = validateOmniConfig(raw, leaves);
    expect(config.version).toBe(1);
    expect(config.allowPaid).toBe(false);
    expect(config.maxAttempts).toBe(4);
    expect(config.maxWaitMs).toBe(15000);
    expect(config.requestTimeoutMs).toBe(30000);
    expect(config.profiles.length).toBe(1);
    expect(config.profiles[0]!.modelId).toBe('model-a');
    expect(config.profiles[0]!.tos).toBe('ok');

    // Immutability
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.profiles)).toBe(true);
    expect(Object.isFrozen(config.profiles[0])).toBe(true);
  });

  test('accepts unwrapped omniRouter property from root settings', () => {
    const raw = {
      omniRouter: {
        version: 1,
        allowPaid: true,
        maxAttempts: 2,
        maxWaitMs: 5000,
        requestTimeoutMs: 10000,
        profiles: [validProfile()],
      },
    };
    const leaves = [validLeaf()];

    const config = validateOmniConfig(raw, leaves);
    expect(config.allowPaid).toBe(true);
    expect(config.maxAttempts).toBe(2);
    expect(config.maxWaitMs).toBe(5000);
    expect(config.requestTimeoutMs).toBe(10000);
  });

  test('rejects non-object or array config', () => {
    expect(() => validateOmniConfig(null, [])).toThrow('Omni config must be a non-null object');
    expect(() => validateOmniConfig(undefined, [])).toThrow('Omni config must be a non-null object');
    expect(() => validateOmniConfig([], [])).toThrow('Omni config must be a non-null object');
    expect(() => validateOmniConfig('invalid', [])).toThrow('Omni config must be a non-null object');
  });

  test('rejects unknown fields at config level', () => {
    const raw = {
      version: 1,
      unknownField: true,
      profiles: [validProfile()],
    };
    expect(() => validateOmniConfig(raw, [validLeaf()])).toThrow('Unknown field in omni config: "unknownField"');
  });

  test('rejects version other than 1', () => {
    expect(() => validateOmniConfig({ version: 2, profiles: [validProfile()] }, [validLeaf()]))
      .toThrow('Omni config version must be 1');
    expect(() => validateOmniConfig({ profiles: [validProfile()] }, [validLeaf()]))
      .toThrow('Omni config version must be 1');
  });

  test('validates allowPaid strict boolean', () => {
    expect(() => validateOmniConfig({ version: 1, allowPaid: 'true', profiles: [validProfile()] }, [validLeaf()]))
      .toThrow('allowPaid must be a boolean');
    expect(() => validateOmniConfig({ version: 1, allowPaid: 1, profiles: [validProfile()] }, [validLeaf()]))
      .toThrow('allowPaid must be a boolean');
  });

  test('validates maxAttempts boundaries (1..8 integer)', () => {
    const mk = (maxAttempts: unknown) => ({ version: 1, maxAttempts, profiles: [validProfile()] });
    expect(() => validateOmniConfig(mk(0), [validLeaf()])).toThrow('maxAttempts must be an integer between 1 and 8');
    expect(() => validateOmniConfig(mk(9), [validLeaf()])).toThrow('maxAttempts must be an integer between 1 and 8');
    expect(() => validateOmniConfig(mk(-1), [validLeaf()])).toThrow('maxAttempts must be an integer between 1 and 8');
    expect(() => validateOmniConfig(mk(3.5), [validLeaf()])).toThrow('maxAttempts must be an integer between 1 and 8');
    expect(() => validateOmniConfig(mk('4'), [validLeaf()])).toThrow('maxAttempts must be an integer between 1 and 8');

    expect(validateOmniConfig(mk(1), [validLeaf()]).maxAttempts).toBe(1);
    expect(validateOmniConfig(mk(8), [validLeaf()]).maxAttempts).toBe(8);
  });

  test('validates maxWaitMs boundaries (0..60000 integer)', () => {
    const mk = (maxWaitMs: unknown) => ({ version: 1, maxWaitMs, profiles: [validProfile()] });
    expect(() => validateOmniConfig(mk(-1), [validLeaf()])).toThrow('maxWaitMs must be an integer between 0 and 60000');
    expect(() => validateOmniConfig(mk(60001), [validLeaf()])).toThrow('maxWaitMs must be an integer between 0 and 60000');
    expect(() => validateOmniConfig(mk(10.5), [validLeaf()])).toThrow('maxWaitMs must be an integer between 0 and 60000');

    expect(validateOmniConfig(mk(0), [validLeaf()]).maxWaitMs).toBe(0);
    expect(validateOmniConfig(mk(60000), [validLeaf()]).maxWaitMs).toBe(60000);
  });

  test('validates requestTimeoutMs boundaries (1..120000 integer)', () => {
    const mk = (requestTimeoutMs: unknown) => ({ version: 1, requestTimeoutMs, profiles: [validProfile()] });
    expect(() => validateOmniConfig(mk(0), [validLeaf()])).toThrow('requestTimeoutMs must be an integer between 1 and 120000');
    expect(() => validateOmniConfig(mk(120001), [validLeaf()])).toThrow('requestTimeoutMs must be an integer between 1 and 120000');
    expect(() => validateOmniConfig(mk(-5), [validLeaf()])).toThrow('requestTimeoutMs must be an integer between 1 and 120000');

    expect(validateOmniConfig(mk(1), [validLeaf()]).requestTimeoutMs).toBe(1);
    expect(validateOmniConfig(mk(120000), [validLeaf()]).requestTimeoutMs).toBe(120000);
  });

  test('validates profiles array length (1..32)', () => {
    expect(() => validateOmniConfig({ version: 1, profiles: [] }, [validLeaf()]))
      .toThrow('profiles must contain between 1 and 32 entries');

    const tooMany = Array.from({ length: 33 }, (_, i) => validProfile({ modelId: `m-${i}` }));
    const tooManyLeaves = Array.from({ length: 33 }, (_, i) => validLeaf({ id: `m-${i}` }));
    expect(() => validateOmniConfig({ version: 1, profiles: tooMany }, tooManyLeaves))
      .toThrow('profiles must contain between 1 and 32 entries');
  });

  test('rejects duplicate modelId across profiles', () => {
    const raw = {
      version: 1,
      profiles: [
        validProfile({ modelId: 'model-a', priority: 10 }),
        validProfile({ modelId: 'model-a', priority: 20 }),
      ],
    };
    expect(() => validateOmniConfig(raw, [validLeaf()])).toThrow('Duplicate profile modelId "model-a"');
  });

  test('rejects unconfigured leaf model reference', () => {
    const raw = {
      version: 1,
      profiles: [validProfile({ modelId: 'non-existent' })],
    };
    expect(() => validateOmniConfig(raw, [validLeaf()]))
      .toThrow('references unconfigured leaf model "non-existent"');
  });

  test('reserves modelId and provider "omni"', () => {
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ modelId: 'omni' })] }, [validLeaf({ id: 'omni' })]))
      .toThrow('Model ID or provider "omni" is reserved');

    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ providerId: 'omni' })] }, [validLeaf()]))
      .toThrow('cannot use reserved providerId "omni"');

    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile()] }, [validLeaf({ provider: 'omni' })]))
      .toThrow('Model ID or provider "omni" is reserved');
  });

  test('rejects unknown fields in profile object', () => {
    const raw = {
      version: 1,
      profiles: [validProfile({ extraField: 'bad' })],
    };
    expect(() => validateOmniConfig(raw, [validLeaf()])).toThrow('Unknown field in profile at index 0: "extraField"');
  });

  test('validates profile fields and types', () => {
    // costTier
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ costTier: 'cheap' })] }, [validLeaf()]))
      .toThrow("costTier must be 'free' or 'paid'");

    // tos
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ tos: 'unacceptable' })] }, [validLeaf()]))
      .toThrow("tos must be one of 'ok'|'caution'|'ambiguous'|'avoid'|'unknown'");

    // acknowledgeTos
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ acknowledgeTos: 'yes' })] }, [validLeaf()]))
      .toThrow('acknowledgeTos must be a boolean');

    // supportsTools
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ supportsTools: 'true' })] }, [validLeaf()]))
      .toThrow('supportsTools must be a boolean');

    // supportsImages
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ supportsImages: 1 })] }, [validLeaf()]))
      .toThrow('supportsImages must be a boolean');

    // contextWindow
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ contextWindow: 0 })] }, [validLeaf()]))
      .toThrow('contextWindow must be a positive integer');
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ contextWindow: -500 })] }, [validLeaf()]))
      .toThrow('contextWindow must be a positive integer');
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ contextWindow: 12.5 })] }, [validLeaf()]))
      .toThrow('contextWindow must be a positive integer');

    // priority
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ priority: -1 })] }, [validLeaf()]))
      .toThrow('priority must be an integer between 0 and 1000');
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ priority: 1001 })] }, [validLeaf()]))
      .toThrow('priority must be an integer between 0 and 1000');
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile({ priority: 5.5 })] }, [validLeaf()]))
      .toThrow('priority must be an integer between 0 and 1000');
  });

  test('validates leaf provider must be generic-chat-completion-api', () => {
    const leaf = validLeaf({ provider: 'openai' });
    expect(() => validateOmniConfig({ version: 1, profiles: [validProfile()] }, [leaf]))
      .toThrow('Only "generic-chat-completion-api" is allowed');
  });

  test('validates leaf baseUrl: protocol, userinfo, search, hash', () => {
    const raw = { version: 1, profiles: [validProfile()] };

    // Missing or empty baseUrl
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: '' })]))
      .toThrow('must specify an explicit non-empty baseUrl');

    // Invalid URL
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'not-a-url' })]))
      .toThrow('has invalid baseUrl');

    // Disallowed protocol (e.g. ftp)
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'ftp://api.example.com/v1' })]))
      .toThrow('baseUrl must use https or http protocol');

    // Disallowed HTTP remote (non-loopback)
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'http://api.remote.com/v1' })]))
      .toThrow('remote baseUrl must use HTTPS; HTTP is only permitted on loopback');

    // Allowed HTTP loopback
    expect(validateOmniConfig(raw, [validLeaf({ baseUrl: 'http://127.0.0.1:20128/v1' })])).toBeDefined();
    expect(validateOmniConfig(raw, [validLeaf({ baseUrl: 'http://localhost:11434/v1' })])).toBeDefined();
    expect(validateOmniConfig(raw, [validLeaf({ baseUrl: 'http://[::1]:8080/v1' })])).toBeDefined();

    // Userinfo forbidden
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'https://user:pass@api.example.com/v1' })]))
      .toThrow('must not include userinfo or credentials');

    // Query parameters forbidden
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'https://api.example.com/v1?api_key=secret' })]))
      .toThrow('must not include query parameters');

    // Fragment forbidden
    expect(() => validateOmniConfig(raw, [validLeaf({ baseUrl: 'https://api.example.com/v1#frag' })]))
      .toThrow('must not include fragment');
  });

  test('validates leaf key conventions: ${ENV_NAME} required, literal keys prohibited', () => {
    const raw = { version: 1, profiles: [validProfile()] };

    // Literal key rejected
    expect(() => validateOmniConfig(raw, [validLeaf({ apiKey: 'sk-secret-12345' })]))
      .toThrow('apiKey must use ${ENV_NAME} convention; literal keys are prohibited');

    // Empty or malformed ${} rejected
    expect(() => validateOmniConfig(raw, [validLeaf({ apiKey: '${}' })]))
      .toThrow('apiKey must use ${ENV_NAME} convention; literal keys are prohibited');

    // apiKeyHelper rejected
    expect(() => validateOmniConfig(raw, [validLeaf({ apiKeyHelper: 'my-helper' })]))
      .toThrow('must not use apiKeyHelper');

    // authFile rejected
    expect(() => validateOmniConfig(raw, [validLeaf({ authFile: '/path/to/sa.json' })]))
      .toThrow('must not use authFile');

    // Remote model missing apiKey rejected
    expect(() => validateOmniConfig(raw, [validLeaf({ apiKey: undefined, baseUrl: 'https://api.example.com/v1' })]))
      .toThrow('requires an apiKey using ${ENV_NAME}; missing apiKey is only permitted on loopback');

    // Loopback model missing apiKey allowed
    expect(validateOmniConfig(raw, [validLeaf({ apiKey: undefined, baseUrl: 'http://127.0.0.1:11434/v1' })])).toBeDefined();
  });

  test('isLoopbackHost correctly recognizes localhost and loopback IPv4/IPv6', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);

    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
