import { resolveExecutionPolicy } from './agent/execution-policy.ts';
import { existsSync, statSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { configuredProviders, loadExecSettings } from './agent/settings.ts';
import { AUTONOMIES, chatHome, loadChatConfig, terminalText } from './chat/config.ts';
import { ChatController } from './chat/controller.ts';
import { TerminalInput } from './chat/terminal.ts';
import { commandHelp } from './chat/commands.ts';
import { networkPolicy } from './agent/network-policy.ts';
import { listConfiguredToolCatalog } from './agent/engine.ts';

import { hasToolPrefixSelector, resolveToolSelection, normalizeExecArgv } from './agent/exec-flags.ts';
import { prepareExecWorktree } from './agent/exec-worktree.ts';

export { loadChatConfig } from './chat/config.ts';
export { parseInput } from './chat/commands.ts';
export type { ChatConfig } from './chat/config.ts';
export const describeCall = (name: string, args: string) => `${name} ${terminalText(args).slice(0, 160)}`;
export const describeResult = (value: unknown, isError: boolean) => `${isError ? 'error: ' : ''}${terminalText(JSON.stringify(value)).slice(0, 160)}`;

export async function chatMain(argv: string[]): Promise<number> {
  const { args: normalizedArgs, worktreeName } = normalizeExecArgv(argv);
  const args = normalizedArgs.map((arg, i) => ['--resume', '-r'].includes(arg) && (!normalizedArgs[i + 1] || normalizedArgs[i + 1]!.startsWith('-')) ? '--resume=' : arg);
  let io: TerminalInput | undefined;
  try {
    const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
      cwd: { type: 'string' }, settings: { type: 'string' }, model: { type: 'string', short: 'm' }, auto: { type: 'string' },
      yolo: { type: 'boolean' }, 'use-spec': { type: 'boolean' }, mission: { type: 'boolean' }, resume: { type: 'string', short: 'r' },
      last: { type: 'boolean' }, fork: { type: 'string' }, 'session-id': { type: 'string' },
      worktree: { type: 'string', short: 'w' }, 'worktree-dir': { type: 'string' },
      'append-system-prompt': { type: 'string' }, 'append-system-prompt-file': { type: 'string' },
      'timeout-ms': { type: 'string' }, 'max-turns': { type: 'string' }, 'max-context-tokens': { type: 'string' },
      'only-tools': { type: 'string' }, 'add-tools': { type: 'string' }, 'remove-tools': { type: 'string' }, sandbox: { type: 'string' }, 'sandbox-network': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    } });
    if (v.help) { console.log('fab [prompt] | fab chat [carpeta] [--cwd path] [--settings file] [-m id] [--yolo] [--auto off|low|medium|high]\n  [-w, --worktree [nombre]] [--worktree-dir path] [--only-tools ids] [--add-tools ids] [--remove-tools ids]\n  --resume [id] --last --fork id --use-spec --mission\n  --sandbox-network auto|ask|deny (auto: red automática solo en high)\n\n' + commandHelp()); return 0; }
    if (v.fork && (v.resume !== undefined || v['session-id'] || v.last)) throw new Error('--fork no se combina con --resume/--last/--session-id');
    if (v['use-spec'] && v.mission) throw new Error('--use-spec y --mission son excluyentes');
    const folder = !v.cwd && positionals.length === 1 && existsSync(positionals[0]!) && statSync(positionals[0]!).isDirectory() ? positionals.pop() : undefined;
    let cwd = await realpath(resolve(v.cwd ?? folder ?? process.cwd()));
    if (!statSync(cwd).isDirectory()) throw new Error('--cwd requiere un directorio');
    const settings = await loadExecSettings(v.settings ?? process.env.FABRICA_AGENT_SETTINGS);

    if (v.worktree !== undefined) {
      if (v['worktree-dir']) console.error('Warning: --worktree-dir is deprecated; set worktreeDirectory in settings instead');
      const worktreeRoot = v['worktree-dir'] ?? settings.worktreeDirectory;
      const wt = await prepareExecWorktree({ repo: cwd, name: worktreeName || undefined, root: worktreeRoot });
      console.error(`Worktree: branch ${wt.branch} at ${wt.path}`);
      cwd = wt.path;
    }

    const home = chatHome(), config = loadChatConfig(settings, home);
    if (v['sandbox-network'] !== undefined) config.networkPolicy = networkPolicy(v['sandbox-network']);
    if (v.model) config.model = v.model;
    if (v.auto) { if (!AUTONOMIES.includes(v.auto as any)) throw new Error('Autonomía inválida'); if (!v.yolo) config.autonomy = v.auto as typeof config.autonomy; }
    if (v['use-spec']) config.mode = 'spec'; if (v.mission) config.mode = 'mission';
    if (config.mode === 'mission' && config.autonomy !== 'high' && !v.yolo) throw new Error('Mission exige --auto high');
    if (v.sandbox && !['required', 'best-effort'].includes(v.sandbox)) throw new Error('Sandbox inválido');
    resolveExecutionPolicy({ permissionMode: v.yolo ? 'yolo' : 'standard', autonomy: v.auto as typeof config.autonomy | undefined,
      interactionMode: config.mode, sandbox: v.sandbox as 'required' | 'best-effort' | undefined, networkPolicy: config.networkPolicy });
    const number = (key: 'timeout-ms' | 'max-turns' | 'max-context-tokens') => {
      if (v[key] === undefined) return;
      const n = Number(v[key]); if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) throw new Error(`Límite inválido: ${key}`); return n;
    };
    const append = [v['append-system-prompt'], v['append-system-prompt-file'] ? await readFile(resolve(v['append-system-prompt-file']), 'utf8') : ''].filter(Boolean).join('\n');
    let availableToolNames: string[] | undefined;
    if (hasToolPrefixSelector(v['only-tools'], v['add-tools'], v['remove-tools'])) {
      const configured = configuredProviders(settings, { model: config.model });
      const prov = configured.providers[configured.defaultModelId]!;
      const fullCatalog = await listConfiguredToolCatalog({
        prompt: '',
        cwd,
        provider: prov,
        mcpServers: settings.mcpServers,
        settingsPolicy: { modelIds: [config.model], maxAutonomy: config.autonomy, networkPolicy: config.networkPolicy ?? 'auto' },
        interactionMode: config.mode,
      });
      availableToolNames = fullCatalog.map(t => t.schema.function.name);
    }
    const toolSel = resolveToolSelection(v['only-tools'], v['add-tools'], v['remove-tools'], availableToolNames);
    io = new TerminalInput(process.stdin, process.stdout, !!process.stdin.isTTY);
    const app = new ChatController({ cwd, home, settings, config, agent: {
      permissionMode: v.yolo ? 'yolo' : 'standard',
      timeoutMs: number('timeout-ms'), maxTurns: number('max-turns'), maxContextTokens: number('max-context-tokens'),
      sandbox: v.sandbox as 'required' | 'best-effort' | undefined, appendSystemPrompt: append,
      onlyTools: toolSel.onlyTools, removeTools: toolSel.removeTools,
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
      await app.refreshCommands(); app.provider(); io.welcome();
      app.print(app.status());
      if (v.resume !== undefined || v['session-id'] || v.last) await app.submit('/resume ' + ((v['session-id'] ?? v.resume) || (v.last ? '--last' : '')));
      if (v.fork) { await app.submit('/resume ' + v.fork); await app.submit('/fork'); }
      const initial = positionals.join(' ');
      if (initial && !await app.submit(initial)) return 0;
      let buffer = '';
      while (!closing) {
        await app.refreshCommands();
        await app.syncHistory();
        let line: string;
        try { line = await io.question(buffer ? '… ' : `fab [${app.config.mode}/${app.permissionLabel}] › `); } catch { break; }
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
