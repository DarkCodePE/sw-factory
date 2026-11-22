import { activityInference } from './evidence.ts';
import type { Activity } from './store.ts';
import type { Ui } from './web-changes.ts';

export function attemptSection(activity: Activity, metadata: Record<string, unknown> | null, ui: Ui): string {
  const e = ui.escape, unknown = 'No medido';
  const rows = activityInference(activity, metadata).map(({ usage, costUsd, durationMs, remoteDeclared }, index) => {
    const cells = [usage?.effectiveModel, usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens, usage?.cacheWriteTokens,
      costUsd === null ? null : `${costUsd.toLocaleString('es', { maximumSignificantDigits: 6 })} USD${usage?.priceVersion ? ` · estimado (tabla ${usage.priceVersion})` : ''}`,
      durationMs === undefined ? null : `${durationMs} ms`];
    return `<tr><th scope="row">${index + 1}${remoteDeclared ? '<br><small>Declarado por el runner</small>' : ''}</th>${cells.map(value => `<td>${e(value ?? unknown)}</td>`).join('')}</tr>`;
  });
  const headings = ['Intento', 'Modelo efectivo', 'Entrada', 'Salida', 'Lectura de caché', 'Escritura de caché', 'Coste', 'Duración'];
  return `<h2>Intentos</h2><div class="table-wrap"><table><thead><tr>${headings.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
