import pkg from '../../package.json' with { type: 'json' };
import { cellWidth, fit } from './render.ts';

export const FAB_VERSION = pkg.version;
export const TIPS = ['Escribe / para buscar comandos y skills del proyecto.', 'Usa /rewind list para revisar checkpoints de archivos.', 'Ctrl+O amplía el último diff; Ctrl+C cancela la operación.', 'Pega varias líneas como un bloque y pulsa Enter para enviarlas.'];
export interface Resources { skills: number; commands: number; mcpConfigured: number; agents: boolean; warnings: number }
export function resourceLine(r: Resources) {
  return `Skills (${r.skills}) ${r.skills ? '✓' : '✗'} · MCPs (${r.mcpConfigured}) ${r.mcpConfigured ? 'configurados, sin verificar' : '✗'} · Connectors: no disponible · AGENTS.md ${r.agents ? '✓' : '✗'}${r.warnings ? ` · ${r.warnings} recursos omitidos` : ''}`;
}
export const autonomyLabel = (value: string) => ({ off: 'cada acción requiere aprobación', low: 'ediciones permitidas; ejecución limitada', medium: 'ediciones y comandos de desarrollo', high: 'acciones automáticas bajo las políticas del runtime' }[value] ?? value);
export function modeLine(c: { model: string; mode: string; autonomy: string; reasoning?: string }, width: number) {
  const right = `${c.model} (${c.reasoning ?? 'predeterminado'})`, left = `${c.mode === 'spec' ? 'Spec' : c.mode === 'mission' ? 'Mission' : 'Auto'} (${c.autonomy}) · ${c.mode === 'spec' ? 'investigación y planificación; sin escrituras' : autonomyLabel(c.autonomy)}`;
  if (cellWidth(left) + cellWidth(right) + 3 < width) return left + ' '.repeat(width - cellWidth(left) - cellWidth(right) - 1) + right;
  return fit(left, Math.max(1, Math.floor(width / 2) - 2)) + ' · ' + fit(right, Math.max(1, Math.ceil(width / 2) - 2));
}
export function welcome(width: number, r: Resources, tipIndex = 0) {
  const logo = width >= 48 ? ['███████╗ █████╗ ██████╗ ', '██╔════╝██╔══██╗██╔══██╗', '█████╗  ███████║██████╔╝', '██╔══╝  ██╔══██║██╔══██╗', '██║     ██║  ██║██████╔╝', '╚═╝     ╚═╝  ╚═╝╚═════╝ '] : ['FAB'];
  const lines = [...logo, `fab v${FAB_VERSION} · agente propio`, '', `TIP: ${TIPS[((tipIndex % TIPS.length) + TIPS.length) % TIPS.length]}`,
    'Shift+Tab: modos · Ctrl+N: modelos · Ctrl+L: autonomía', 'Tab: razonamiento · /: comandos · Ctrl+C: cancelar', resourceLine(r)];
  return lines.map(line => { const text = fit(line, Math.max(1, width - 1)); return ' '.repeat(Math.max(0, Math.floor((width - cellWidth(text)) / 2))) + text; }).join('\n') + '\n';
}
