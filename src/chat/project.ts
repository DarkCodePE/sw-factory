import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readWorkspaceFile } from '../agent/files.ts';
import { terminalText } from './config.ts';

async function projectDirectory(cwd: string, kind: 'commands' | 'skills') {
  const root = await realpath(cwd), dir = await realpath(join(root, '.agents', kind));
  const path = relative(root, dir);
  if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('El catálogo del proyecto apunta fuera de la carpeta de trabajo');
  return { root, dir };
}

export async function projectItems(cwd: string, kind: 'commands' | 'skills') {
  let dir: string;
  try { ({ dir } = await projectDirectory(cwd, kind)); }
  catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter(e => kind === 'commands' ? e.isFile() && /^[\w-]+\.md$/.test(e.name) : e.isDirectory() && /^[\w-]+$/.test(e.name))
    .slice(0, 100).map(e => kind === 'commands' ? e.name.slice(0, -3) : e.name).sort();
}
export async function projectPrompt(cwd: string, kind: 'commands' | 'skills', name: string) {
  if (!/^[\w-]+$/.test(name)) throw new Error('Nombre de recurso inválido');
  const { root, dir } = await projectDirectory(cwd, kind);
  const path = relative(root, join(dir, kind === 'commands' ? `${name}.md` : `${name}/SKILL.md`));
  // Resolve only the catalog alias; anchored reads still reject links in resource paths.
  const { text } = await readWorkspaceFile(root, path);
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('El recurso supera 64 KiB');
  return text;
}
export interface ProjectResource { name: string; kind: 'commands' | 'skills'; description: string }
export function promptBody(text: string) { return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ''); }
export async function projectCatalog(cwd: string) {
  const resources: ProjectResource[] = [], warnings: string[] = [], names = new Set<string>();
  for (const kind of ['commands', 'skills'] as const) {
    let items: string[];
    try { items = await projectItems(cwd, kind); }
    catch { warnings.push(`Catálogo no legible: .agents/${kind}`); continue; }
    for (const name of items) {
      try {
        const text = await projectPrompt(cwd, kind, name), key = name.toLowerCase();
        if (names.has(key)) { warnings.push(`Nombre duplicado: ${name}`); continue; }
        const meta = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
        const description = /^description:\s*([^\r\n]*)/m.exec(meta)?.[1]?.replace(/^['"]|['"]$/g, '');
        resources.push({ name, kind, description: terminalText(description && !['>', '|'].includes(description) ? description : promptBody(text).split('\n').find(line => line.trim() && !line.startsWith('#')) ?? `Recurso local ${name}`).replace(/\s+/g, ' ').slice(0, 200) }); names.add(key);
      } catch { warnings.push(`Recurso no legible: ${name}`); }
    }
  }
  return { resources, warnings };
}
