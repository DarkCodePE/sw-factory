import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorkspaceFile } from '../agent/files.ts';

export async function projectItems(cwd: string, kind: 'commands' | 'skills') {
  const dir = join(cwd, '.agents', kind);
  try { if (await realpath(dir) !== dir) throw new Error('No se siguen enlaces en el catálogo del proyecto'); }
  catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => kind === 'commands' ? e.isFile() && /^[\w-]+\.md$/.test(e.name) : e.isDirectory() && /^[\w-]+$/.test(e.name))
    .slice(0, 100).map(e => kind === 'commands' ? e.name.slice(0, -3) : e.name).sort();
}
export async function projectPrompt(cwd: string, kind: 'commands' | 'skills', name: string) {
  if (!/^[\w-]+$/.test(name)) throw new Error('Nombre de recurso inválido');
  const path = kind === 'commands' ? `.agents/commands/${name}.md` : `.agents/skills/${name}/SKILL.md`;
  const { text } = await readWorkspaceFile(cwd, path);
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('El recurso supera 64 KiB');
  return text;
}
