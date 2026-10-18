import { existsSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadExecSettings } from './agent/settings.ts';
import { AUTONOMIES, chatHome, loadChatConfig, terminalText } from './chat/config.ts';
import { ChatController } from './chat/controller.ts';
import { TerminalInput } from './chat/terminal.ts';
import { commandHelp } from './chat/commands.ts';

export { loadChatConfig } from './chat/config.ts';
export { parseInput } from './chat/commands.ts';
export type { ChatConfig } from './chat/config.ts';
export const describeCall = (name: string, args: string) => `${name} ${terminalText(args).slice(0, 160)}`;
export const describeResult = (value: unknown, isError: boolean) => `${isError ? 'error: ' : ''}${terminalText(JSON.stringify(value)).slice(0, 160)}`;

export async function chatMain(argv: string[]): Promise<number> {
  const args = argv.map((arg, i) => ['--resume', '-r'].includes(arg) && (!argv[i + 1] || argv[i + 1]!.startsWith('-')) ? '--resume=' : arg);
  let io: TerminalInput | undefined;
  try {
    const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
      cwd: { type: 'string' }, settings: { type: 'string' }, model: { type: 'string', short: 'm' }, auto: { type: 'string' },
      'use-spec': { type: 'boolean' }, mission: { type: 'boolean' }, resume: { type: 'string', short: 'r' },
      last: { type: 'boolean' }, fork: { type: 'string' }, 'session-id': { type: 'string' },
      'append-system-prompt': { type: 'string' }, 'append-system-prompt-file': { type: 'string' },
      'timeout-ms': { type: 'string' }, 'max-turns': { type: 'string' }, 'max-context-tokens': { type: 'string' },
      'only-tools': { type: 'string' }, 'remove-tools': { type: 'string' }, sandbox: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (v.help) { console.log('fab [prompt] | fab chat [carpeta] [--cwd path] [--settings file] [-m id] [--auto off|low|medium|high]\n  --resume [id] --last --fork id --use-spec --mission\n\n' + commandHelp()); return 0; }
    if (v.fork && (v.resume !== undefined || v['session-id'] || v.last)) throw new Error('--fork no se combina con --resume/--last/--session-id');
    if (v['use-spec'] && v.mission) throw new Error('--use-spec y --mission son excluyentes');
    const folder = !v.cwd && positionals.length === 1 && existsSync(positionals[0]!) && statSync(positionals[0]!).isDirectory() ? positionals.pop() : undefined;
    const cwd = await realpath(resolve(v.cwd ?? folder ?? process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('--cwd requiere un directorio');
    const settings = await loadExecSettings(v.settings ?? process.env.FABRICA_AGENT_SETTINGS);
    const home = chatHome(), config = loadChatConfig(settings, home);
    if (v.model) config.model = v.model;
    if (v.auto) { if (!AUTONOMIES.includes(v.auto as any)) throw new Error('Autonomía inválida'); config.autonomy = v.auto as typeof config.autonomy; }
    if (v['use-spec']) config.mode = 'spec'; if (v.mission) config.mode = 'mission';
    if (config.mode === 'mission' && config.autonomy !== 'high') throw new Error('Mission exige --auto high');
    if (v.sandbox && !['required', 'best-effort'].includes(v.sandbox)) throw new Error('Sandbox inválido');
    const number = (key: 'timeout-ms' | 'max-turns' | 'max-context-tokens') => {
      if (v[key] === undefined) return;
      const n = Number(v[key]); if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw new Error(`Límite inválido: ${key}`); return n;
    };
    const append = [v['append-system-prompt'], v['append-system-prompt-file'] ? await readFile(resolve(v['append-system-prompt-file']), 'utf8') : ''].filter(Boolean).join('\n');
    io = new TerminalInput(process.stdin, process.stdout, !!process.stdin.isTTY);
    const app = new ChatController({ cwd, home, settings, config, agent: {
      timeoutMs: number('timeout-ms'), maxTurns: number('max-turns'), maxContextTokens: number('max-context-tokens'),
      sandbox: v.sandbox as 'required' | 'best-effort' | undefined, appendSystemPrompt: append,
      onlyTools: v['only-tools']?.split(',').filter(Boolean), removeTools: v['remove-tools']?.split(',').filter(Boolean),
    } }, io);
    io.controller = app;
    await app.syncHistory(); io.update(app.statusState);
    let closing = false;
    const stop = () => { if (app.busy) app.interrupt(); else { app.print('Ctrl+D o /exit para salir'); io?.clearInput(); } };
    const terminate = () => { closing = true; app.interrupt(); io?.close(); };
    io.onInterrupt = stop;
    io.onClose = () => { if (process.stdin.isTTY) { closing = true; app.interrupt(); } };
    process.on('SIGINT', stop); process.on('SIGTERM', terminate);
    try {
      await app.refreshCommands(); app.provider();
      app.print('╭─ fab · agente propio ───────────────────────────────');
      app.print(app.status()); app.print('╰─ / o Tab: comandos · /mode: auto/spec/mission · Ctrl+C: cancelar');
      if (v.resume !== undefined || v['session-id'] || v.last) await app.submit('/resume ' + ((v['session-id'] ?? v.resume) || (v.last ? '--last' : '')));
      if (v.fork) { await app.submit('/resume ' + v.fork); await app.submit('/fork'); }
      const initial = positionals.join(' ');
      if (initial && !await app.submit(initial)) return 0;
      let buffer = '';
      while (!closing) {
        await app.syncHistory();
        let line: string;
        try { line = await io.question(buffer ? '… ' : `fab [${app.config.mode}/${app.config.autonomy}] › `); } catch { break; }
        if (line.endsWith('\\')) { buffer += line.slice(0, -1) + '\n'; continue; }
        try { if (!await app.submit(buffer + line)) break; }
        catch (e) { app.print(e instanceof Error ? e.message : String(e)); }
        buffer = '';
      }
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', terminate); }
    return 0;
  } catch (e) { console.error(terminalText(e instanceof Error ? e.message : String(e))); return 1; }
  finally { io?.close(); }
}
