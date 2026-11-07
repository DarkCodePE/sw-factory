// bench/t2-cualificacion: corpus T2 (10 repos x 10 tareas por mutación). Las pruebas de especificación son offline;
// la que prepara la suite necesita red para clonar (o T2_UPSTREAM con los clones ya fijados) y se salta si no hay.
import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifierArgv } from '../src/agent/mission-evidence.ts';
import { parseSuite } from '../src/improve.ts';
import { suiteT2 } from '../scripts/ideas/ciclo.ts';

const DIR = join(import.meta.dir, '../bench/t2-cualificacion');
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const repos = readdirSync(join(DIR, 'repos')).sort().map(f => json(join(DIR, 'repos', f)));
const mutaciones = (n: string) => json(join(DIR, 'mutaciones', `${n}.json`)) as { id: string; archivo: string; buscar: string; reemplazar: string; descripcion: string; ocultos: string[] }[];
const REVELA = /\btests?\b|\bpytest\b|\bunittest\b|\bdiff\b|\bl[ií]nea\b|\.py\b/i;

test('T2 corpus: 10 repos con pin, licencia permisiva y comando de tests', () => {
  expect(repos).toHaveLength(10);
  for (const r of repos) {
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.license_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(['MIT', 'BSD-3-Clause', 'BSD-2-Clause', 'Apache-2.0']).toContain(r.license_spdx);
    expect(r.url).toStartWith('https://github.com/');
    expect(r.test.slice(0, 3)).toEqual(['python3', '-m', 'pytest']);
    expect(existsSync(join(import.meta.dir, '../third_party', r.nombre))).toBe(false); // no se copia código del upstream
  }
});

test('T2 corpus: 10 mutaciones por repo, ids únicos, descripciones que no revelan el verificador', () => {
  const ids = new Set<string>();
  for (const r of repos) {
    const ms = mutaciones(r.nombre);
    expect(ms).toHaveLength(10);
    for (const m of ms) {
      expect(m.id).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
      expect(ids.has(m.id)).toBe(false);
      ids.add(m.id);
      expect(m.buscar).not.toBe(m.reemplazar);
      expect(m.archivo).not.toMatch(/(^|\/)tests?(\/|_)/); // la mutación nunca toca tests
      expect(m.ocultos.length).toBeGreaterThan(0);
      expect(m.descripcion).not.toMatch(REVELA);
      expect(m.descripcion).not.toContain(m.archivo);
    }
  }
  expect(ids.size).toBe(100);
  for (const d of json(join(DIR, 'descartadas.json'))) expect(d.motivo).toBeTruthy();
});

test('T2 corpus: las 100 referencias restauran el archivo exacto, incluso con reemplazar duplicado (offline)', () => {
  // Ejecuta la implementación real sin clones ni pytest: solo se simulan los
  // comandos de verificación. La referencia pertenece al upstream, fuera de la base.
  const p = Bun.spawnSync(['python3', '-I', '-c', String.raw`
import importlib.util, sys, tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

root = Path(sys.argv[1])
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('corpus', root / 'corpus.py')
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)
total = ambiguas = 0
with tempfile.TemporaryDirectory(prefix='t2-reference-') as tmp:
    tmp = Path(tmp)
    for repo in corpus.repos():
        for m in corpus.leer(root / 'mutaciones' / (repo['nombre'] + '.json')):
            # Contexto sintético: una sola coincidencia de buscar y, cuando es
            # posible, otra de reemplazar antes de la que inserta la mutación.
            contexto = m['reemplazar'] if m['buscar'] not in m['reemplazar'] else ''
            original = contexto + '\n# contexto anterior\n' + m['buscar'] + '\n# contexto posterior\n'
            assert original.count(m['buscar']) == 1, m['id']
            mutado = corpus.aplicar(original, m)
            assert mutado != original, m['id']
            ambiguas += mutado.count(m['reemplazar']) > 1
            base = tmp / 'base' / m['id']
            archivo = base / m['archivo']
            archivo.parent.mkdir(parents=True)
            archivo.write_text(mutado)
            referencia = tmp / 'upstream' / repo['nombre'] / m['archivo']
            referencia.parent.mkdir(parents=True, exist_ok=True)
            referencia.write_text(original)
            llamadas = []
            def verificar(argv, *, cwd, **kwargs):
                contenido = (Path(cwd) / m['archivo']).read_text()
                esperado = mutado if not llamadas else original
                assert contenido == esperado, m['id']
                llamadas.append(contenido)
                return SimpleNamespace(returncode=1 if len(llamadas) == 1 else 0)
            tarea = dict(id=m['id'], group=repo['nombre'], split='development', repo=str(base), verify='verificador-simulado')
            with patch.object(corpus, 'correr', return_value=(0, '', 0)), patch.object(corpus.subprocess, 'run', side_effect=verificar):
                resultado = corpus.validar_tarea(tarea, repo, m, tmp / 'upstream')
            assert resultado['ok'] and len(llamadas) == 2, m['id']
            assert archivo.read_text() == mutado, m['id']  # no modifica la base
            total += 1
assert total == 100, total
assert ambiguas > 0, 'falta cubrir la inversión textual ambigua'
print(f'{total} referencias exactas; {ambiguas} casos con reemplazar duplicado')
`, DIR], { stderr: 'pipe' });
  expect(p.stderr.toString()).toBe('');
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toContain('100 referencias exactas');
});

const red = process.env.T2_UPSTREAM || Bun.spawnSync(['git', 'ls-remote', 'https://github.com/mahmoud/boltons', 'HEAD'], { timeout: 15_000 }).exitCode === 0;

test.skipIf(!red)('T2 corpus: prepare.sh genera la suite, sin tests ocultos en la base; verify falla en la base y pasa con la referencia', () => {
  const dest = join(mkdtempSync(join(tmpdir(), 't2-corpus-')), 'suite');
  try {
    const p = Bun.spawnSync(['bash', join(DIR, 'prepare.sh'), dest], { stderr: 'pipe', timeout: 170_000 });
    expect(p.stderr.toString()).toBe('');
    const raw = json(join(dest, 'suite.json'));
    const suite = parseSuite(raw);
    expect(suiteT2(suite)).toEqual([]);
    expect(suite.tasks).toHaveLength(100);
    const grupos = new Map<string, string[]>();
    for (const t of suite.tasks) grupos.set(t.group!, [...(grupos.get(t.group!) ?? []), t.split]);
    expect(grupos.size).toBe(10);
    for (const s of grupos.values()) expect(s.filter(x => x === 'validation')).toHaveLength(2);
    expect(suite.tasks.filter(t => t.split === 'development')).toHaveLength(80);

    // Contrasta las 100 bases reales con el archivo de referencia del pin.
    // No exige unicidad de reemplazar: validar_tarea restaura el archivo entero.
    for (const r of repos) for (const m of mutaciones(r.nombre)) {
      const t = suite.tasks.find(x => x.id === m.id)!;
      const original = readFileSync(join(process.env.T2_UPSTREAM || join(dest, 'upstream'), r.nombre, m.archivo), 'utf8');
      expect(original.split(m.buscar).length - 1).toBe(1);
      expect(readFileSync(join(t.repo, m.archivo), 'utf8')).toBe(original.replace(m.buscar, m.reemplazar));
    }

    for (const r of repos) {
      const m = mutaciones(r.nombre)[0]!;
      const t = suite.tasks.find(x => x.id === m.id)!;
      for (const rel of m.ocultos) {
        expect(existsSync(join(t.repo, rel))).toBe(false);                    // fuera del árbol de la tarea
        expect(existsSync(join(dest, 'ocultos', m.id, rel))).toBe(true);      // guardados fuera del repo
      }
      expect(Bun.spawnSync(['git', '-C', t.repo, 'rev-parse', 'HEAD']).stdout.toString().trim()).toBe(t.base);
    }
    // Dos tareas completas: la base mutada falla y la mutación inversa pasa.
    for (const r of [repos[0]!, repos[5]!]) {
      const m = mutaciones(r.nombre)[0]!, t = suite.tasks.find(x => x.id === m.id)!;
      const work = mkdtempSync(join(tmpdir(), 't2-verify-'));
      try {
        cpSync(t.repo, work, { recursive: true });
        const [cmd, ...args] = verifierArgv(t.verify);
        const verify = () => Bun.spawnSync([cmd!, ...args], { cwd: work, timeout: 120_000 }).exitCode;
        expect(verify()).not.toBe(0);
        const f = join(work, m.archivo);
        writeFileSync(f, readFileSync(join(process.env.T2_UPSTREAM || join(dest, 'upstream'), r.nombre, m.archivo), 'utf8')); // referencia: el archivo del commit fijado
        expect(verify()).toBe(0);
      } finally { rmSync(work, { recursive: true, force: true }); }
    }
  } finally { rmSync(join(dest, '..'), { recursive: true, force: true }); }
}, 240_000);
