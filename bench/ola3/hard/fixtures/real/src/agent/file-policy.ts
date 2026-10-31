import { createHash } from 'node:crypto';
import type { ToolContext } from './types.ts';
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export function rememberRead(context: ToolContext, path: string, data: Uint8Array) { context.fileReads?.set(path, digest(data)); }
export function checkRead(context: ToolContext, path: string, data: Uint8Array) {
  if (context.requireReadBeforeEdit && context.fileReads?.get(path) !== digest(data)) throw new Error('Read this file before editing; its current bytes must match the read snapshot');
}
