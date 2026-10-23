import type { JsonSchema, SdkTool } from './types.ts';

export function tool<I = unknown>(name: string, description: string, inputSchema: JsonSchema,
  handler: SdkTool<I>['handler']): SdkTool<I> {
  if (!/^[\w.-]{1,128}$/.test(name) || !description.trim() || !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error('Invalid SDK tool definition');
  }
  return { name, description, inputSchema, handler };
}

export function validateToolInput(schema: JsonSchema, input: unknown, path = 'input'): string | undefined {
  if (schema.enum && !schema.enum.some(value => JSON.stringify(value) === JSON.stringify(input))) return `${path} must be one of the declared enum values`;
  const type = schema.type;
  if (type === 'object') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return `${path} must be an object`;
    const value = input as Record<string, unknown>, properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${path}.${key} is required`;
    for (const [key, item] of Object.entries(value)) {
      const child = properties[key];
      if (!child) { if (schema.additionalProperties === false) return `${path}.${key} is not allowed`; continue; }
      const error = validateToolInput(child, item, `${path}.${key}`); if (error) return error;
    }
  } else if (type === 'array') {
    if (!Array.isArray(input)) return `${path} must be an array`;
    if (schema.items) for (let i = 0; i < input.length; i++) { const error = validateToolInput(schema.items, input[i], `${path}[${i}]`); if (error) return error; }
  } else if (type === 'string' && typeof input !== 'string' || type === 'number' && (typeof input !== 'number' || !Number.isFinite(input)) ||
      type === 'integer' && (typeof input !== 'number' || !Number.isSafeInteger(input)) || type === 'boolean' && typeof input !== 'boolean' ||
      type === 'null' && input !== null) return `${path} has the wrong type`;
  return undefined;
}
