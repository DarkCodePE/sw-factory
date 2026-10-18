import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultAuthFile } from '../agent/chatgpt.ts';
import type { ExecSettings } from '../agent/settings.ts';
import type { Autonomy, InteractionMode } from '../agent/types.ts';

export const AUTONOMIES: Autonomy[] = ['off', 'low', 'medium', 'high'];
export const REASONING = ['low', 'medium', 'high'] as const;
export interface ChatConfig { model: string; autonomy: Autonomy; mode: InteractionMode; theme: 'color' | 'plain'; reasoning?: typeof REASONING[number] }
export const chatHome = () => resolve(process.env.FABRICA_HOME ?? join(homedir(), '.fabrica'));
export function loadChatConfig(settings: ExecSettings = {}, home = chatHome()): ChatConfig {
  let saved: Record<string, unknown> = {};
  try {
    const fd = openSync(join(home, 'chat.json'), 'r'), bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    try {
      while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, null); if (!n) break; size += n; }
    } finally { closeSync(fd); }
    if (size === bytes.length) throw new Error('chat.json supera 64 KiB');
    const value = JSON.parse(bytes.subarray(0, size).toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value;
  } catch { /* Missing or invalid preferences use validated defaults. */ }
  const model = process.env.FABRICA_LLM_MODEL ?? settings.modelId
    ?? (typeof saved.model === 'string' && saved.model.trim() ? saved.model : undefined)
    ?? (existsSync(defaultAuthFile()) ? 'chatgpt:gpt-6-luna' : 'qwen3.5-32k:latest');
  const autonomy = AUTONOMIES.includes(saved.autonomy as Autonomy) ? saved.autonomy as Autonomy : 'off';
  // Mission authority is deliberately invocation-local, never restored from preferences.
  return { model, autonomy, mode: 'auto', theme: saved.theme === 'plain' ? 'plain' : 'color', ...(REASONING.includes(saved.reasoning as any) ? { reasoning: saved.reasoning as ChatConfig['reasoning'] } : {}) };
}
export function saveChatConfig(config: ChatConfig, home = chatHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'chat.json'), temp = file + '.' + crypto.randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify({ model: config.model, autonomy: config.autonomy, theme: config.theme, reasoning: config.reasoning }, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

/** Terminal content is data: remove CSI/OSC and control sequences before displaying it. */
export const terminalText = (value: unknown) => String(value)
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
