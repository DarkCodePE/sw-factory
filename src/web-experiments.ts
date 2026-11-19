// Vista de solo lectura de experimentos y suites de `fab improve`. Sin reglas propias: los números salen de improve.ts.
import type { Database } from 'bun:sqlite';
import { experimentRunsJson, experimentSchemaState, listExperiments, reportExperiment, SPLITS, type Suite } from './improve.ts';
import { redact } from './manifest.ts';
import { StoreError } from './store.ts';

const esc = (v: unknown) => redact(String(v ?? '')).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const enc = encodeURIComponent;
const SPLIT_LABEL: Record<string, string> = { development: 'Desarrollo', validation: 'Validación', qualification: 'Cualificación' };
const empty = (t: string) => `<p class="empty">${esc(t)}</p>`;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function suiteView(raw: string): string {
  let suite: Suite;
  try { suite = JSON.parse(raw) as Suite; if (!Array.isArray(suite.tasks)) throw 0; } catch { return empty('Suite ilegible.'); }
  return SPLITS.map(split => {
    const tasks = suite.tasks.filter(t => t?.split === split);
    return `<h3>${SPLIT_LABEL[split]} <small>${tasks.length} tareas</small></h3>${tasks.length ? `<ul>${tasks.map(t => `<li><code>${esc(t.id)}</code> · ${esc(t.description)}</li>`).join('')}</ul>` : empty('Sin tareas en este split.')}`;
  }).join('');
}

export function experimentsPage(db: Database, pathname: string): { title: string; body: string } | null {
  const m = /^\/experimentos(?:\/([^/]+))?$/.exec(pathname);
  if (!m) return null;
  const state = experimentSchemaState(db);
  const id = m[1] === undefined ? undefined : decodeURIComponent(m[1]);
  if (id !== undefined && !/^[\w-]+$/.test(id)) throw new URIError('Identificador inválido');
  if (state !== 'ok') {
    if (id !== undefined) throw new StoreError('not_found', `experimento ${id} no existe`);
    return { title: 'Experimentos', body: state === 'absent' ? empty('No hay experimentos: la base no tiene tablas de experimentos. Se crean con fab improve create.') : empty('El esquema de experimentos está incompleto: ejecuta un comando fab improve para migrarlo.') };
  }
  if (id === undefined) {
    const exps = listExperiments(db);
    if (!exps.length) return { title: 'Experimentos', body: empty('No hay experimentos. Se crean con fab improve create.') };
    return { title: 'Experimentos', body: `<p class="intro">Experimentos de mejora de perfiles y sus suites.</p><div class="table-wrap"><table><thead><tr><th>Experimento</th><th>Baseline</th><th>Candidate</th><th>Creado</th></tr></thead><tbody>${exps.map(e => `<tr><td><a href="/experimentos/${enc(e.id)}">${esc(e.id)}</a></td><td><code>${esc(e.baseline.slice(0, 12))}</code></td><td><code>${esc(e.candidate.slice(0, 12))}</code></td><td><time>${esc(e.createdAt)}</time></td></tr>`).join('')}</tbody></table></div><h2>Suites</h2>${[...new Map(exps.map(e => [e.suiteDigest, e])).values()].map(e => `<section><h3>Suite <code>${esc(e.suiteDigest.slice(0, 12))}</code></h3>${suiteView(e.suite)}</section>`).join('')}` };
  }
  let json: ReturnType<typeof experimentRunsJson>, report: string;
  try { json = experimentRunsJson(db, id); report = reportExperiment(db, id); } // lanza not_found si no existe
  catch (e) { if (e instanceof SyntaxError) return { title: `Experimento · ${id}`, body: `<p><a href="/experimentos">Volver a experimentos</a></p>${empty('Suite ilegible: no se puede calcular el informe.')}` }; throw e; }
  const runs = json.runs;
  const arms = SPLITS.flatMap(split => ['baseline', 'candidate', 'baseline_rep', 'control'].map(arm => ({ split, arm, r: runs.filter(x => x.split === split && x.arm === arm) }))).filter(x => x.r.length);
  const costCell = (r: typeof runs) => { const k = r.map(x => x.cost_usd).filter((c): c is number => typeof c === 'number'); return !k.length ? 'No medido' : `${mean(k).toFixed(2)} USD${k.length < r.length ? ` (${k.length}/${r.length})` : ''}`; };
  const summary = arms.length ? `<div class="table-wrap"><table><thead><tr><th>Split</th><th>Brazo</th><th>Repeticiones</th><th>Éxito</th><th>Coste medio (medidos/total)</th></tr></thead><tbody>${arms.map(({ split, arm, r }) => `<tr><td>${SPLIT_LABEL[split]}</td><td>${esc(arm)}</td><td>${r.length}</td><td>${mean(r.map(x => x.success)).toFixed(3)}</td><td>${costCell(r)}</td></tr>`).join('')}</tbody></table></div>` : empty('Sin corridas todavía.');
  const detail = runs.length ? `<div class="table-wrap"><table><thead><tr><th>Tarea</th><th>Split</th><th>Rep.</th><th>Brazo</th><th>Éxito</th><th>Líneas de diff</th><th>Duración</th><th>Coste</th></tr></thead><tbody>${runs.map(x => `<tr><td>${esc(x.task_id)}</td><td>${SPLIT_LABEL[x.split] ?? esc(x.split)}</td><td>${esc(x.repeat)}</td><td>${esc(x.arm)}</td><td>${x.success ? 'Sí' : 'No'}</td><td>${esc(x.diff_lines)}</td><td>${esc(x.duration_ms)} ms</td><td>${typeof x.cost_usd === 'number' ? `${x.cost_usd.toFixed(2)} USD` : 'No medido'}</td></tr>`).join('')}</tbody></table></div>` : '';
  return { title: `Experimento · ${id}`, body: `<p><a href="/experimentos">Volver a experimentos</a></p><h2>Resumen por brazo</h2>${summary}<h2>Informe de fab improve report</h2><pre tabindex="0">${esc(report)}</pre><h2>Corridas</h2>${detail || empty('Sin corridas todavía.')}` };
}
