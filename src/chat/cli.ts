import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadExecSettings } from '../agent/settings.ts';
import { chatHome, terminalText } from './config.ts';
import { listSessions } from './sessions.ts';

export async function localCommandMain(command: 'search' | 'find' | 'mcp', argv: string[]): Promise<number> {
  try {
    const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      cwd: { type: 'string' }, settings: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (v.help) { console.log(command === 'mcp' ? 'fab mcp list [--settings file]' : 'fab search|find <texto> [--cwd carpeta]'); return 0; }
    if (command === 'mcp') {
      if (positionals.length > 1 || positionals[0] && positionals[0] !== 'list') throw new Error('Solo mcp list está disponible. Configura mcpServers en --settings; OAuth/gestión persistente no implementados.');
      const settings = await loadExecSettings(v.settings ?? process.env.FABRICA_AGENT_SETTINGS);
      const names = Object.keys(settings.mcpServers ?? {});
      console.log(names.length ? names.map(n => terminalText(n) + ': configurado (conectividad no comprobada)').join('\n') : 'Sin MCP configurados');
      return 0;
    }
    if (!positionals.length) throw new Error('Uso: fab search <texto> [--cwd carpeta]');
    const cwd = await realpath(resolve(v.cwd ?? process.cwd()));
    const { sessions, truncated } = await listSessions(join(chatHome(), 'agent-sessions'), cwd, positionals.join(' '), true);
    for (const s of sessions) console.log(terminalText(`${s.id} · ${s.title}${s.archived ? ' [archivada]' : ''}\n  ${s.preview.replace(/\n/g, ' ')}`));
    if (truncated) console.log('Resultados parciales por límite de lectura');
    return 0;
  } catch (e) { console.error(terminalText(e instanceof Error ? e.message : String(e))); return 1; }
}
