// La matriz y el informe leen el motor de bench, y las acciones reutilizan los comandos de fab bench.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { benchmarkSummary, getBenchmark, listBenchmarks, type Variant } from './bench.ts';
import { writeSuiteWithTask, type TaskSpec } from './bench-task.ts';
import { SPLITS } from './improve.ts';
import type { Change, Store } from './store.ts';

const STATUS: Record<string, string> = {
  pending: 'Pendiente', running: 'En curso', scoring: 'Puntuando', complete: 'Completo', failed: 'Fallido', canceled: 'Cancelado',
};
const SPLIT_LABEL = { development: 'Desarrollo', validation: 'Validación', qualification: 'Cualificación' };
const enc = encodeURIComponent;
const unmeasured = 'No medido';
const filename = (id: string, nonce: string) => `suite-candidata-${id}-${nonce}.json`;
const hiddenCsrf = (csrf: string) => `<input type="hidden" name="csrf" value="${csrf}">`;

export function benchmarksPage(store: Store, url: URL, escape: (value: unknown) => string, csrf?: string) {
  const match = /^\/benchmarks(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return null;
  if (!match[1]) {
    const all = listBenchmarks(store.db);
    const q = url.searchParams.get('q') ?? '', agent = url.searchParams.get('agent') ?? '', status = url.searchParams.get('status') ?? '';
    const agents = [...new Set(all.flatMap(b => (b.variants ?? []).map(v => v.agent)))].sort();
    const option = (value: string, label: string, current: string) => `<option value="${escape(value)}"${value === current ? ' selected' : ''}>${escape(label)}</option>`;
    const filters = `<form method="get" action="/benchmarks" class="filters"><label>Nombre<input type="search" name="q" value="${escape(q)}"></label><label>Adaptador<select name="agent">${option('', 'Todos', agent)}${agents.map(a => option(a, a, agent)).join('')}</select></label><label>Estado<select name="status">${option('', 'Todos', status)}${Object.entries(STATUS).map(([s, label]) => option(s, label, status)).join('')}</select></label><button>Filtrar</button></form>`;
    const filtered = all.filter(b => b.id.toLowerCase().includes(q.trim().toLowerCase()) &&
      (!agent || (b.variants ?? []).some(v => v.agent === agent)) && (!status || b.status === status));
    const rows = filtered.map(b => `<tr><td><a href="/benchmarks/${enc(b.id)}">${escape(b.id)}</a></td><td>${escape(STATUS[b.status] ?? b.status)}</td><td>${b.variants ? b.variants.length : 'Variantes ilegibles'}</td><td>${escape([...new Set((b.variants ?? []).map(v => v.agent))].join(', '))}</td><td><time>${escape(b.created_at)}</time></td></tr>`).join('');
    const list = rows ? `<div class="table-wrap"><table><thead><tr><th>Benchmark</th><th>Estado</th><th>Variantes</th><th>Adaptadores</th><th>Creado</th></tr></thead><tbody>${rows}</tbody></table></div>` :
      `<p class="empty">${all.length ? 'Ningún benchmark coincide con los filtros.' : 'No hay benchmarks. Se crean con fab bench create.'}</p>`;
    return { title: 'Benchmarks', body: filters + list };
  }
  const id = decodeURIComponent(match[1]);
  if (!/^[\w-]+$/.test(id)) throw new URIError('Identificador inválido');
  const benchmark = getBenchmark(store.db, id);
  const variants = JSON.parse(benchmark.variants) as Variant[];
  const report = benchmarkSummary(store.db, id);
  const matrix = variants.map(v => `<tr><td>${escape(v.name)}</td><td>${escape(v.agent)}</td><td><code>${escape(v.profile)}</code></td></tr>`).join('');
  const results = report.variants.map(v => {
    const cost = v.mean_cost_usd === null ? unmeasured : `${v.mean_cost_usd.toFixed(4)} USD${v.cost_known < v.n ? ` (${v.cost_known}/${v.n})` : ''}`;
    return `<tr><td>${escape(v.variant)}</td><td>${v.n}</td><td>${v.success_rate.toFixed(3)}</td><td>${v.mean_diff_lines.toFixed(1)}</td><td>${(v.mean_duration_ms / 1000).toFixed(1)}</td><td>${cost}</td></tr>`;
  }).join('');
  const judges = report.variants.flatMap(v => v.judges.map(j => `<tr><td>${escape(v.variant)}</td><td>${escape(j.scorer)}</td><td>${j.pass_rate === null ? unmeasured : `${(j.pass_rate * 100).toFixed(0)}% (${j.passed}/${j.scored})`}</td><td>${j.mean_score?.toFixed(2) ?? unmeasured}</td><td>${j.unscored}</td></tr>`)).join('');
  const table = (columns: string[], rows: string) => `<div class="table-wrap"><table><thead><tr>${columns.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  const cancel = csrf && ['pending', 'running', 'scoring'].includes(report.status)
    ? `<form action="/benchmarks/${enc(id)}/cancel" method="post" class="web-action">${hiddenCsrf(csrf)}<fieldset><legend>Cancelar benchmark</legend><p>Las corridas iniciadas pueden terminar. Se conservan los resultados registrados.</p><label><input type="checkbox" name="confirm" value="yes" required> Confirmo la cancelación</label><button>Cancelar benchmark</button></fieldset></form>` : '';
  return { title: `Benchmark · ${id}`, body: `<p><a href="/benchmarks">Volver a benchmarks</a></p><div class="summary"><strong>${escape(STATUS[report.status] ?? report.status)}</strong><span>Suite <code>${escape(report.suite_digest)}</code></span></div>` +
    (report.error ? `<p class="notice">${escape(report.error)}</p>` : '') + cancel +
    `<h2>Matriz de variantes</h2>${table(['Variante', 'Adaptador', 'Perfil'], matrix)}<h2>Informe de fab bench report</h2>` +
    (results ? table(['Variante', 'Corridas', 'Éxito', 'Líneas de diff (media)', 'Duración media (s)', 'Coste medio'], results) : '<p class="empty">Sin corridas todavía.</p>') +
    (judges ? `<h2>Jueces</h2>${table(['Variante', 'Juez', 'Aprobados', 'Puntuación media', 'Sin puntuar'], judges)}` : '') };
}

export function suiteTaskForm(change: Change, stateDir: string | undefined, url: URL, escape: (value: string) => string, csrf?: string) {
  if (!stateDir || !csrf || change.status !== 'completed' || !change.baseSha) return '';
  const nonce = url.searchParams.get('suite-candidata') ?? '';
  const output = /^[0-9a-f-]{36}$/.test(nonce) ? join(stateDir, filename(change.id, nonce)) : '';
  const saved = output && existsSync(output) ? `<p role="status">Suite candidata guardada en <code>${escape(output)}</code>.</p>` : '';
  return `${saved}<form action="/changes/${enc(change.id)}/suite-task" method="post" class="web-action">${hiddenCsrf(csrf)}<fieldset><legend>Añadir a suite</legend><p>Genera una suite de una tarea en un fichero nuevo para que puedas revisarla.</p><label>Identificador<input name="task" required maxlength="41" pattern="[a-z0-9][a-z0-9\\-]{0,40}"></label><label>Split<select name="split">${SPLITS.map(split => `<option value="${split}">${SPLIT_LABEL[split]}</option>`).join('')}</select></label><label>Comando de verificación (opcional)<input name="verify"></label><button>Generar tarea candidata</button></fieldset></form>`;
}

export function saveSuiteCandidate(store: Store, stateDir: string, id: string, spec: TaskSpec) {
  const nonce = randomUUID();
  writeSuiteWithTask(store, id, { ...spec, out: join(stateDir, filename(id, nonce)) });
  return `/changes/${enc(id)}?suite-candidata=${nonce}`;
}
