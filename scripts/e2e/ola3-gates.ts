// Ola 3: mide los gates deterministas sobre el banco de agy y los combina con la línea base del QA con LLM.
// El pipeline es secuencial (gates → QA sobre el mismo HEAD) y el QA recibe la misma entrada que en la línea
// base, así que el resultado combinado es: rechazo si el gate falla; si pasa, el veredicto de QA de la línea base.
// uso: bun scripts/e2e/ola3-gates.ts [raíz de trabajo]   (por defecto ~/.cache/fab-ola3-gates; no /tmp: ver report-ola3-codex)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runGates } from '../../src/gates.ts';

const repo = resolve(import.meta.dir, '../..');
const bench = join(repo, 'bench/ola3');
const root = resolve(process.argv[2] ?? join(homedir(), '.cache/fab-ola3-gates'));
const cases = JSON.parse(readFileSync(join(bench, 'cases.json'), 'utf8')) as {
  id: string; repo: string; is_bug: boolean; caught_by_tests: boolean; test_cmd: string; patch_file: string;
}[];
const baseline = new Map(readFileSync(join(bench, 'results/results-baseline.tsv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split('\t')).map((f) => [f[0], { verdict: f[5], seconds: Number(f[8]) }]));

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', '-c', 'core.hooksPath=/dev/null', ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
};

rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
// Fase de dependencias, separada del gate (ficha 01): el sandbox filtra el entorno y no ve ~/.local.
const deps = join(root, '_deps');
const pip = Bun.spawnSync(['python3', '-m', 'pip', 'install', '-q', '--target', deps, 'pytest']);
if (pip.exitCode !== 0) throw new Error(`pip: ${pip.stderr.toString()}`);
const PYTEST = ['python3', '-c', "import sys;sys.path.insert(0,'_deps');import pytest;raise SystemExit(pytest.main(['-q','-p','no:cacheprovider']))"];
const rows = [];
for (const c of cases) {
  const dir = join(root, c.id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(bench, 'fixtures', c.repo), dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  git(dir, 'apply', join(bench, c.patch_file)); git(dir, 'add', '-A'); git(dir, 'commit', '-qm', c.id);
  const argv = c.test_cmd.startsWith('pytest') ? PYTEST : c.test_cmd.split(' ');
  if (argv === PYTEST) cpSync(deps, join(dir, '_deps'), { recursive: true });  // sin commit: solo dependencia
  const started = performance.now();
  const gate = await runGates(dir, [argv], new AbortController().signal);
  const gateSeconds = (performance.now() - started) / 1000;
  const qa = baseline.get(c.id)!;
  // QA solo corre si el gate pasa; su veredicto es el de la línea base para la misma entrada.
  const pipelinePass = gate.passed && qa.verdict === 'pass';
  rows.push({
    id: c.id, is_bug: c.is_bug, caught_by_tests: c.caught_by_tests, gate: gate.passed ? 'pass' : 'fail',
    gate_exit: gate.steps[0]?.exitCode, gate_s: +gateSeconds.toFixed(2), qa_baseline: qa.verdict,
    baseline_flags: qa.verdict !== 'pass', pipeline_flags: !pipelinePass, llm_runs: gate.passed ? 1 : 0,
    llm_s: gate.passed ? qa.seconds : 0, baseline_s: qa.seconds,
  });
}

const bugs = rows.filter((r) => r.is_bug), clean = rows.filter((r) => !r.is_bug);
const n = (xs: typeof rows, k: 'baseline_flags' | 'pipeline_flags') => xs.filter((r) => r[k]).length;
const sum = (k: 'llm_s' | 'baseline_s' | 'gate_s') => +rows.reduce((s, r) => s + r[k], 0).toFixed(1);
const summary = {
  gate_detects_test_caught: `${bugs.filter((r) => r.caught_by_tests && r.gate === 'fail').length}/${bugs.filter((r) => r.caught_by_tests).length}`,
  gate_false_fail_on_clean: `${clean.filter((r) => r.gate === 'fail').length}/${clean.length}`,
  sensitivity_baseline: `${n(bugs, 'baseline_flags')}/${bugs.length}`,
  sensitivity_pipeline: `${n(bugs, 'pipeline_flags')}/${bugs.length}`,
  sensitivity_ratio: +(n(bugs, 'pipeline_flags') / n(bugs, 'baseline_flags')).toFixed(2),
  false_rejections_baseline: `${n(clean, 'baseline_flags')}/${clean.length}`,
  false_rejections_pipeline: `${n(clean, 'pipeline_flags')}/${clean.length}`,
  llm_runs_baseline: rows.length, llm_runs_pipeline: rows.filter((r) => r.llm_runs).length,
  llm_seconds_baseline: sum('baseline_s'), llm_seconds_pipeline: sum('llm_s'), gate_seconds: sum('gate_s'),
  cost_ratio: +((sum('llm_s') + sum('gate_s')) / sum('baseline_s')).toFixed(2),
};
writeFileSync(join(bench, 'results/results-gates.json'), JSON.stringify({ summary, rows }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
for (const r of rows) console.log(`${r.id}\tgate=${r.gate}(${r.gate_exit})\tqa=${r.qa_baseline}\tpipeline=${r.pipeline_flags ? 'rechaza' : 'acepta'}`);
