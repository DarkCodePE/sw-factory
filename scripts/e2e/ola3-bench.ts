#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { BenchCase, CaseResult, runBenchCase } from './ola3-runner.ts';

const HELP = `Uso: scripts/e2e/ola3-bench.sh <cli_dir> <modo> [filtro]

Argumentos:
  <cli_dir>   Directorio raíz del repo fab bajo prueba (contiene src/cli.ts)
  <modo>      'baseline' (sin gates) o 'gates' (con --verify)
  [filtro]    Opcional: 'pilot' (primeros 2 casos), id de caso (ej: tc-bug-01), o 'all' (por defecto)

Variables de entorno:
  FAB_BENCH_AGENT   Adaptador a utilizar (por defecto: codex)
  FAB_BENCH_OUTDIR  Directorio para guardar resultados (por defecto: bench/ola3/results)
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.includes('-h') || args.includes('--help')) {
    console.log(HELP);
    process.exit(args.length < 2 ? 1 : 0);
  }

  const cliDir = resolve(args[0]!);
  const mode = args[1] as 'baseline' | 'gates';
  if (mode !== 'baseline' && mode !== 'gates') {
    console.error(`Error: modo desconocido "${mode}". Debe ser 'baseline' o 'gates'.`);
    process.exit(1);
  }

  const filter = args[2] ?? 'all';
  const agent = process.env.FAB_BENCH_AGENT ?? 'codex';
  const outDir = process.env.FAB_BENCH_OUTDIR ?? resolve(cliDir, 'bench/ola3/results');

  const casesPath = resolve(cliDir, 'bench/ola3/cases.json');
  if (!existsSync(casesPath)) {
    console.error(`Error: no se encontró ${casesPath}`);
    process.exit(1);
  }

  const allCases: BenchCase[] = JSON.parse(readFileSync(casesPath, 'utf8'));
  let selectedCases: BenchCase[] = [];

  if (filter === 'pilot') {
    // 2 cases to test quota and duration: 1 bug (tc-bug-01) + 1 clean (tc-clean-01)
    selectedCases = allCases.filter((c) => c.id === 'tc-bug-01' || c.id === 'tc-clean-01');
  } else if (filter === 'all') {
    selectedCases = allCases;
  } else {
    selectedCases = allCases.filter((c) => c.id === filter);
    if (selectedCases.length === 0) {
      console.error(`Error: no se encontró ningún caso con id "${filter}".`);
      process.exit(1);
    }
  }

  console.log(`\n======================================================`);
  console.log(`  BANCO OLA 3 — MEDICI\u00d3N FICHA 01`);
  console.log(`  Modo: ${mode.toUpperCase()} | Agente: ${agent}`);
  console.log(`  Casos a ejecutar: ${selectedCases.length} (filtro: ${filter})`);
  console.log(`  CLI dir: ${cliDir}`);
  console.log(`======================================================\n`);

  const results: CaseResult[] = [];
  const startAll = Date.now();

  for (let i = 0; i < selectedCases.length; i++) {
    const c = selectedCases[i]!;
    const num = `[${i + 1}/${selectedCases.length}]`;
    process.stdout.write(`${num} Ejecutando ${c.id} (${c.repo}, ${c.category})... `);

    try {
      const res = await runBenchCase(c, cliDir, mode, agent);
      results.push(res);
      const mark = c.is_bug
        ? res.detected ? 'DETECTADO (OK)' : 'NO DETECTADO (FALLO)'
        : res.false_rejection ? 'FALSO RECHAZO (FALLO)' : 'ACEPTADO (OK)';
      console.log(`veredicto=${res.verdict} -> ${mark} (${res.duration_s}s, ${res.cost})`);
    } catch (err: any) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        id: c.id,
        repo: c.repo,
        category: c.category,
        is_bug: c.is_bug,
        caught_by_tests: c.caught_by_tests,
        verdict: 'error',
        detected: false,
        false_rejection: false,
        duration_s: 0,
        cost: 'error',
        summary: '',
        error: err.message,
      });
    }
  }

  const totalDurationS = Math.round((Date.now() - startAll) / 1000);

  // Aggregation
  const bugCases = results.filter((r) => r.is_bug);
  const cleanCases = results.filter((r) => !r.is_bug);

  const bugsDetected = bugCases.filter((r) => r.detected).length;
  const falseRejections = cleanCases.filter((r) => r.false_rejection).length;

  const sensitivity = bugCases.length > 0 ? (bugsDetected / bugCases.length) : 0;
  const fpRate = cleanCases.length > 0 ? (falseRejections / cleanCases.length) : 0;

  // Print results table
  console.log(`\n======================================================`);
  console.log(`  TABLA DE RESULTADOS (${mode.toUpperCase()})`);
  console.log(`======================================================`);
  console.log(`ID           Repo      Categoría     Esperado  Veredicto   Det/FR   Duración  Coste`);
  console.log(`---------------------------------------------------------------------------------`);
  for (const r of results) {
    const esp = r.is_bug ? (r.caught_by_tests ? 'bug (test)' : 'bug (sem)') : 'sano';
    const status = r.is_bug
      ? (r.detected ? 'DET' : 'MISS')
      : (r.false_rejection ? 'FP_REJ' : 'PASS');
    console.log(
      `${r.id.padEnd(12)} ${r.repo.padEnd(9)} ${r.category.padEnd(13)} ${esp.padEnd(9)} ${r.verdict.padEnd(11)} ${status.padEnd(8)} ${(r.duration_s + 's').padEnd(9)} ${r.cost}`
    );
  }
  console.log(`---------------------------------------------------------------------------------`);
  console.log(`Sensibilidad (bugs detectados): ${bugsDetected}/${bugCases.length} (${(sensitivity * 100).toFixed(1)}%)`);
  console.log(`Falsos rechazos (sanos):        ${falseRejections}/${cleanCases.length} (${(fpRate * 100).toFixed(1)}%)`);
  console.log(`Duración total:                 ${totalDurationS}s`);
  console.log(`======================================================\n`);

  // Write TSV and JSON summaries
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });

  const tsvHeader = 'id\trepo\tcategory\tis_bug\tcaught_by_tests\tverdict\tdetected\tfalse_rejection\tduration_s\tcost\tsummary\n';
  const tsvRows = results
    .map(
      (r) =>
        `${r.id}\t${r.repo}\t${r.category}\t${r.is_bug}\t${r.caught_by_tests}\t${r.verdict}\t${r.detected}\t${r.false_rejection}\t${r.duration_s}\t${r.cost}\t${r.summary}`
    )
    .join('\n');
  const tsvPath = join(outDir, `results-${mode}.tsv`);
  writeFileSync(tsvPath, tsvHeader + tsvRows + '\n');

  const jsonSummary = {
    mode,
    agent,
    cliDir,
    totalCases: results.length,
    bugsTotal: bugCases.length,
    bugsDetected,
    sensitivity,
    cleanTotal: cleanCases.length,
    falseRejections,
    falseRejectionRate: fpRate,
    totalDurationS,
    results,
  };
  const jsonPath = join(outDir, `results-${mode}.json`);
  writeFileSync(jsonPath, JSON.stringify(jsonSummary, null, 2) + '\n');

  console.log(`Resumen guardado en:`);
  console.log(`  - TSV:  ${tsvPath}`);
  console.log(`  - JSON: ${jsonPath}\n`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
