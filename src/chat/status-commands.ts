import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpRuntime } from '../agent/mcp.ts';

export async function handleHooksCommand(cwd: string, print: (msg: string) => void): Promise<void> {
  const home = process.env.FABRICA_HOME ?? join(process.env.HOME ?? '.', '.fabrica');
  const sources = [
    { origin: join(home, 'hooks.json'), display: '~/.fabrica/hooks.json' },
    { origin: join(cwd, '.fab/hooks.json'), display: '.fab/hooks.json' },
  ];
  let foundAny = false;
  for (const src of sources) {
    try {
      const text = await readFile(src.origin, 'utf8');
      const json = JSON.parse(text);
      if (typeof json === 'object' && json !== null) {
        let fileHasHooks = false;
        for (const [event, groups] of Object.entries(json)) {
          if (Array.isArray(groups)) {
            for (const grp of groups) {
              if (grp && Array.isArray(grp.hooks)) {
                for (const h of grp.hooks) {
                  if (h?.command) {
                    if (!fileHasHooks) {
                      thisFileHeader(src.display, print);
                      fileHasHooks = true;
                    }
                    foundAny = true;
                    print(`  ${event}: ${h.command}${grp.matcher ? ` [matcher: ${grp.matcher}]` : ''}`);
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // file does not exist or unreadable, continue
    }
  }
  if (!foundAny) {
    print('Sin hooks configurados en ~/.fabrica/hooks.json ni .fab/hooks.json');
  }
}

function thisFileHeader(display: string, print: (msg: string) => void): void {
  print(`${display}:`);
}

export function handleMcpCommand(
  mcpServers: Record<string, any> | undefined,
  disabledMcp: Set<string>,
  arg: string,
  print: (msg: string) => void,
): void {
  const [action, server] = arg.split(/\s+/);
  if (action && action !== 'list') {
    if (!['enable', 'disable'].includes(action) || !server || !Object.hasOwn(mcpServers ?? {}, server)) {
      throw new Error('/mcp [list|enable <nombre>|disable <nombre>]');
    }
    if (action === 'disable') disabledMcp.add(server);
    else disabledMcp.delete(server);
  }
  const statuses = McpRuntime.status();
  const names = Object.keys(mcpServers ?? {});
  if (!names.length) {
    print('Sin MCP configurados. Usa --settings con mcpServers.');
    return;
  }
  for (const n of names) {
    if (disabledMcp.has(n)) {
      print(`${n}: excluido`);
      continue;
    }
    const st = statuses.find(s => s.server === n);
    if (!st) {
      print(`${n}: configurado (conectividad no comprobada)`);
    } else if (st.state === 'needs authentication') {
      print(`${n} [${st.transport}]: needs authentication${st.authorizeUrl ? ` · ${st.authorizeUrl}` : ''}`);
    } else {
      print(`${n} [${st.transport}]: ${st.state}`);
    }
  }
}
