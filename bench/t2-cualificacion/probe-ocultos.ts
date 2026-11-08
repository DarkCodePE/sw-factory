// Frontera de lectura de los tests ocultos de T2, sin modelo: reutiliza el adaptador `simulated` de T1.
// bun bench/t2-cualificacion/probe-ocultos.ts <destino> [tarea] [evidence.json]
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runAgent } from '../../src/agents.ts';
import { simulated } from '../t1-filtro/probe-hidden.ts';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(['git', '-C', cwd, ...a]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString();
};
const archivos = (dir: string, rel = ''): string[] => readdirSync(join(dir, rel)).flatMap(n => statSync(join(dir, rel, n)).isDirectory() ? archivos(dir, join(rel, n)) : [join(rel, n)]);

export async function probarOcultos(dest: string, taskId?: string) {
  const suite = JSON.parse(readFileSync(join(dest, 'suite.json'), 'utf8')).tasks as { id: string; repo: string; base: string }[];
  const t = taskId ? suite.find(x => x.id === taskId)! : suite[0]!;
  const ocultos = join(dest, 'ocultos', t.id);
  const rels = archivos(ocultos);
  const wt = mkdtempSync(join(tmpdir(), 'fab-t2-wt-'));
  rmSync(wt, { recursive: true });
  git(t.repo, 'worktree', 'add', '--detach', '-q', wt, t.base);
  try {
    const historia = git(t.repo, 'rev-list', '--all', '--objects');
    const paths: Record<string, string> = { 'suite.json': join(dest, 'suite.json'), ...Object.fromEntries(rels.map(r => [`oculto:${r}`, join(ocultos, r)])) };
    const expected = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, sha(p)]));
    const read = async (confine: boolean) => {
      rmSync(join(wt, 'probe-result.json'), { force: true });
      const run = await runAgent(simulated, `Paths: ${JSON.stringify(paths)}. Do not guess`, wt, 90_000, { confine });
      const observed = existsSync(join(wt, 'probe-result.json')) ? JSON.parse(readFileSync(join(wt, 'probe-result.json'), 'utf8')) : {};
      return { exitCode: run.exitCode, legibles: Object.keys(paths).filter(k => observed[k] === expected[k]), observed: Object.keys(observed).length };
    };
    const sinConfinar = await read(false);
    const confinado = await read(true);
    const pytest = await runAgent({
      name: 'simulated',
      command: () => ['python3', '-m', 'pytest', '-q'],
    }, '', wt, 120_000, { confine: true });
    if (pytest.exitCode !== 0) {
      console.error(`pytest confinado falló (rc=${pytest.exitCode}). Se requiere pytest instalado y una suite visible en verde.\n${pytest.stdout}\n${pytest.stderr}`);
    }
    return {
      tarea: t.id, ocultos: rels,
      enBase: rels.filter(r => existsSync(join(wt, r))),           // debe ser []
      enHistoria: rels.filter(r => historia.split('\n').some(l => l.endsWith(` ${r}`))), // debe ser []
      sinConfinar,                                                 // lectura posible: sin --confine no hay barrera
      confinado: { ...confinado, pytest_rc: pytest.exitCode },       // legibles: [], pytest_rc: 0
    };
  } finally { git(t.repo, 'worktree', 'remove', '--force', wt); }
}

if (import.meta.main) {
  const [dest, task, out] = process.argv.slice(2);
  if (!dest) throw new Error('uso: probe-ocultos.ts <destino> [tarea] [evidence.json]');
  const r = await probarOcultos(resolve(dest), task);
  const text = JSON.stringify(r, null, 2) + '\n';
  if (out) writeFileSync(resolve(out), text);
  console.log(text);
  if (r.enBase.length || r.enHistoria.length || r.confinado.legibles.length || !r.confinado.observed || r.confinado.pytest_rc !== 0) process.exitCode = 1;
}
