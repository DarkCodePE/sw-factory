import { evidencePath, readEvidence, type ClaudeFrame, type EvidenceText } from './evidence.ts';
import type { Ui } from './web-changes.ts';

type Step = { kind: 'message' | 'thinking' | 'call' | 'result'; title: string; text: string };
const notMeasured = '<p class="empty">No medido</p>';
const object = (value: unknown): ClaudeFrame | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeFrame : null;

function stepFromBlock(value: unknown, title: string): Step | null | undefined {
  const block = object(value);
  if (!block || typeof block.type !== 'string') return null;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { kind: 'message', title, text: block.text } : null;
    case 'thinking':
      return typeof block.thinking === 'string' ? { kind: 'thinking', title: 'Pensamiento', text: block.thinking } : null;
    case 'tool_use':
      return typeof block.name === 'string'
        ? { kind: 'call', title: `Llamada a herramienta · ${block.name}`, text: JSON.stringify(block.input ?? {}, null, 2) } : null;
    case 'tool_result': {
      const text = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
        ? block.content.flatMap(item => {
          const part = object(item);
          return part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
        }).join('\n') : '';
      return { kind: 'result', title: 'Resultado de herramienta', text };
    }
  }
}

function transcriptSteps(frames: ClaudeFrame[]): { steps: Step[]; incomplete: boolean } {
  const steps: Step[] = [];
  let incomplete = false;
  for (const frame of frames) {
    if (frame.type !== 'assistant' && frame.type !== 'user') continue;
    const title = frame.type === 'assistant' ? 'Mensaje del agente' : 'Mensaje de entrada';
    const content = object(frame.message)?.content;
    if (typeof content === 'string') {
      steps.push({ kind: 'message', title, text: content });
    } else if (Array.isArray(content)) {
      for (const value of content) {
        const step = stepFromBlock(value, title);
        if (step) steps.push(step);
        else if (step === null) incomplete = true;
      }
    } else incomplete = true;
  }
  return { steps, incomplete };
}

export function transcriptSection(log: EvidenceText | null, url: URL, ui: Ui, unavailable = 'No hay evidencia guardada.'): string {
  const { steps, incomplete } = transcriptSteps(log?.claudeFrames ?? []);
  const heading = '<h2>Transcript</h2>';
  const partial = log?.claudeIncomplete || incomplete;
  const warning = partial ? '<p class="notice">Transcript incompleto.</p>' : '';
  const fallback = partial || !steps.length ? logSection(log, ui, unavailable) : '';
  if (!steps.length) return `<section>${heading}${notMeasured}${warning}</section>${fallback}`;
  const thinking = url.searchParams.get('pensamiento') === '1';
  const tools = url.searchParams.get('herramientas') === '1';
  const ws = url.searchParams.get('ws');
  const visible = steps.filter(step => step.kind === 'message' || (step.kind === 'thinking' ? thinking : tools));
  return `<section class="transcript">${heading}${warning}
    <form method="get" class="transcript-filters" aria-label="Filtros del transcript">
      ${ws ? `<input type="hidden" name="ws" value="${ui.escape(ws)}">` : ''}
      <label><input type="checkbox" name="pensamiento" value="1"${thinking ? ' checked' : ''}> Mostrar pensamiento</label>
      <label><input type="checkbox" name="herramientas" value="1"${tools ? ' checked' : ''}> Mostrar llamadas y resultados</label>
      <button type="submit">Aplicar filtros</button>
    </form>
    ${visible.length ? `<ol>${visible.map(step => `<li><details><summary>${ui.escape(step.title)}</summary>${step.text ? `<pre tabindex="0">${ui.escape(step.text)}</pre>` : notMeasured}</details></li>`).join('')}</ol>`
      : '<p class="muted">Activa un filtro para ver los pasos guardados.</p>'}</section>${fallback}`;
}

export function activityLogSection(stateDir: string, changeId: string, activityId: string, url: URL, ui: Ui): string {
  let log: EvidenceText | null = null;
  let unavailable = 'No hay evidencia guardada.';
  try { log = readEvidence(stateDir, evidencePath(changeId, `${activityId}.log`)); }
  catch { unavailable = 'Evidencia no disponible: ruta insegura o fichero ilegible.'; }
  return transcriptSection(log, url, ui, unavailable);
}

function logSection(log: EvidenceText | null, ui: Ui, unavailable: string): string {
  const body = log ? `${log.truncated ? '<p class="notice">Archivo truncado: se muestran los primeros 256 KiB.</p>' : ''}<pre tabindex="0">${ui.escape(log.text)}</pre>`
    : `<p class="empty">${unavailable}</p>`;
  return `<section><h2>Log</h2>${body}</section>`;
}
