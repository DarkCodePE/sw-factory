import { CHAT_COMMANDS } from './commands.ts';
import { cellWidth, fit } from './render.ts';
import type { ProjectResource } from './project.ts';

export interface PaletteEntry { name: string; description: string; origin: string; disabled?: boolean }
export function paletteCatalog(resources: ProjectResource[]): PaletteEntry[] {
  const builtins = CHAT_COMMANDS.flatMap(c => [c.name, ...c.aliases ?? []].map(name => ({ name,
    description: c.help, origin: c.unavailable ? 'no disponible' : c.group === 'Configuración' ? 'configuración' : 'fab', disabled: !!c.unavailable })));
  const reserved = new Set(builtins.map(c => c.name));
  return [...builtins, ...resources.filter(r => !reserved.has(r.name.toLowerCase())).map(r => ({ name: r.name.toLowerCase(), description: r.description, origin: r.kind === 'skills' ? 'skill del proyecto' : 'comando del proyecto' }))];
}
export function suggestions(line: string, catalog: PaletteEntry[]) {
  if (!/^\/[^\s]*$/.test(line)) return [];
  const query = line.slice(1).toLowerCase();
  return catalog.map((entry, index) => ({ entry, index, rank: entry.name.startsWith(query) ? 0 : entry.name.includes(query) ? 1 : entry.description.toLowerCase().includes(query) ? 2 : 3 }))
    .filter(e => !query || e.rank < 3).sort((a, b) => a.rank - b.rank || a.index - b.index).map(e => e.entry);
}
export function renderPalette(entries: PaletteEntry[], selected: number, width: number, maxRows = 6) {
  const start = Math.max(0, Math.min(selected - maxRows + 1, Math.max(0, entries.length - maxRows)));
  return entries.slice(start, start + maxRows).map((entry, index) => {
    const nameWidth = Math.min(30, Math.max(12, Math.floor(width * 0.25))), originWidth = Math.min(22, Math.floor(width * 0.25));
    const name = fit(`/${entry.name}`, nameWidth), origin = fit(entry.origin, originWidth);
    const description = fit(entry.description, Math.max(1, width - nameWidth - originWidth - 7));
    return fit(`${start + index === selected ? '›' : ' '} ${name}${' '.repeat(Math.max(1, nameWidth - cellWidth(name) + 1))}${description}${' '.repeat(Math.max(1, width - nameWidth - originWidth - cellWidth(description) - 5))}${origin}`, width - 1);
  });
}
