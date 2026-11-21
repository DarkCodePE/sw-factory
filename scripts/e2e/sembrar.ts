// Siembra un stateDir temporal con datos sintéticos para el e2e de la web (T76). Nunca toca ~/.fabrica.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.ts';
import { ensureStateDir } from '../../src/state-dir.ts';
import { AdmissionDb } from '../../src/admission/db.ts';
import { ensureSchema, suiteDigest, type Suite } from '../../src/improve.ts';
import { defaultProfile, saveProfile, type Profile } from '../../src/profile.ts';

export interface Semilla {
  stateDir: string;
  repos: Record<string, string>;
  /** Id de cada change sembrado, por clave. */
  changes: Record<string, string>;
  /** Id de la activity que hay que mirar de cada change (revisión, pregunta o fallo). */
  activities: Record<string, string>;
  automation: string;
  signal: string;
  profiles: { v1: string; v2: string };
}

const git = (repo: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', '-C', repo, '-c', 'user.email=e2e@fab.local', '-c', 'user.name=e2e', ...args]);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
};

/** Un repo git desechable con un commit; la ruta es absoluta, como exige el asistente de alta. */
export function crearRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const r = Bun.spawnSync(['git', 'init', '-q', '-b', 'main', dir]);
  if (r.exitCode !== 0) throw new Error('git init falló');
  writeFileSync(join(dir, 'README.md'), '# repo desechable\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const iso = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

export function sembrar(root: string): Semilla {
  const stateDir = join(root, 'state');
  ensureStateDir(stateDir); // 0700 como en producción: con 0755 el adjunto se rechaza (T96)
  const repos = Object.fromEntries(['plataforma', 'canal', 'pool', 'archivo', 'nuevo'].map(n => [n, crearRepo(join(root, 'repos', n))]));
  const s = new Store(join(stateDir, 'fabrica.db'));
  new AdmissionDb(s); // crea las tablas adm_* (preguntas, turnos)
  ensureSchema(s.db);

  const v1 = defaultProfile();
  const v2: Profile = { ...defaultProfile(), schemaVersion: 2, roles: { implement: { harness: 'fake' }, code_review: { harness: 'native' } } };
  v2.worker.investigate += '\nPerfil v2 del e2e.';
  const d1 = saveProfile(stateDir, v1).digest, d2 = saveProfile(stateDir, v2).digest;

  // `pool` es el único con agente fake y activo: solo allí corre runPool, para no mover el resto de la semilla.
  s.createWorkstream({ slug: 'plataforma', goal: 'Mantener despliegues reproducibles.', repo: repos.plataforma!, profile: d2 });
  s.createWorkstream({ slug: 'canal', goal: 'Seguir señales de entrada y preguntas de agentes.', repo: repos.canal!, profile: d1 });
  s.createWorkstream({ slug: 'pool', goal: 'Workstream del pool fake.', repo: repos.pool!, agent: 'fake', requireChangeApproval: false });
  s.createWorkstream({ slug: 'archivo', goal: 'Workstream que se archiva en el e2e.', repo: repos.archivo! });
  for (const slug of ['plataforma', 'canal', 'pool', 'archivo']) s.setWorkstreamState(slug, 'active');
  s.setWorkstreamState('archivo', 'paused');

  const changes: Record<string, string> = {}, activities: Record<string, string> = {};
  const specs: [string, string, string, string][] = [
    // clave, workstream, título, estado
    ['aprobar', 'plataforma', 'Revisión para aprobar', 'in_review'],
    ['cambios', 'plataforma', 'Revisión para pedir cambios', 'in_review'],
    ['pregunta', 'canal', 'Change con pregunta abierta', 'in_progress'],
    ['reintentar', 'canal', 'Change fallido para reintentar', 'failed'],
    ['cancelar', 'plataforma', 'Change para cancelar', 'in_progress'],
    ['renombrar', 'canal', 'Change para renombrar', 'pending'],
    ['nota', 'plataforma', 'Change para dejar una nota', 'in_progress'],
    ['completado', 'canal', 'Change completado de ejemplo', 'completed'],
    ['bloqueado', 'plataforma', 'Change bloqueado de ejemplo', 'blocked'],
  ];
  for (const [i, [key, slug, title, status]] of specs.entries()) {
    process.env.FAB_ACTOR = ['marina', 'diego', 'fab'][i % 3];
    const c = s.createChange(slug, title, `Descripción sintética de «${title}».`);
    const parent = s.listActivities({ changeId: c.id })[0]!;
    const child = randomUUID();
    const when = 6 + i * 9;
    const review = status === 'in_review';
    const waiting = key === 'pregunta';
    const childStatus = review ? 'completed' : key === 'cancelar' ? 'pending' : waiting ? 'waiting_reply' : status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : status === 'completed' ? 'completed' : status === 'pending' ? 'pending' : 'in_progress';
    s.db.query('UPDATE changes SET status=?,branch=?,created_at=?,updated_at=? WHERE id=?').run(status, status === 'pending' ? null : `demo/${slug}-${i}`, iso(when + 5), iso(when), c.id);
    s.db.query("UPDATE activities SET kind='investigation',status='completed',review_status='approved',created_at=?,started_at=?,completed_at=?,result=? WHERE id=?").run(iso(when + 4), iso(when + 3.8), iso(when + 3), 'Alcance documentado.', parent.id);
    s.db.query('INSERT INTO activities (id,workstream_id,change_id,parent_activity_id,kind,status,review_status,result,error,retry_count,created_at,started_at,completed_at,question_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(child, c.workstreamId, c.id, parent.id, review ? 'change_review' : 'implementation', childStatus, review ? 'awaiting' : null, review ? 'Listo para revisión humana.' : 'Resumen sintético.', childStatus === 'failed' ? 'El manifiesto no incluye la entrada.' : null, 0, iso(when + 2), iso(when + 1.8), ['completed', 'failed'].includes(childStatus) ? iso(when + 1) : null, waiting ? 'pregunta-e2e' : null);
    if (waiting) s.db.query('INSERT INTO adm_questions (id,activity_id,change_id,text,asked_at) VALUES (?,?,?,?,?)').run('pregunta-e2e', child, c.id, '¿Conservamos el resumen 7 o 30 días?', iso(when + 1));
    const run = join(stateDir, 'runs', c.id);
    mkdirSync(run, { recursive: true });
    for (const [j, id] of [parent.id, child].entries()) {
      writeFileSync(join(run, `${id}.json`), JSON.stringify({ durationMs: 18200 + i * 1000 + j * 3000, attemptCosts: [0.08 + i * 0.02], isolation: { adapter: 'native' } }));
      writeFileSync(join(run, `${id}.log`), `[fab] ejecución sintética\n[worker] ${title}\n`);
    }
    writeFileSync(join(run, 'run.json'), JSON.stringify({ fixture: true, status }));
    writeFileSync(join(run, 'diff.patch'), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    changes[key] = c.id;
    activities[key] = child;
  }
  delete process.env.FAB_ACTOR;

  // La señal que se ignora; la que se tría la crea la web durante el recorrido.
  const sig = s.addSignal('canal', 'Señal sembrada', 'Texto de la señal sembrada.');
  const automation = s.createAutomation({ workstream: 'plataforma', name: 'informe-semanal', cron: '0 9 * * 1', title: 'Informe semanal', body: 'Revisar el estado de la plataforma.' });

  // Experimento mínimo con la suite del diseño de improve.
  const suite: Suite = { tasks: [
    { id: 'bandeja', repo: repos.plataforma!, base: 'abc1234', description: 'Mantener el foco al actualizar.', verify: 'true', split: 'development' },
    { id: 'revision', repo: repos.canal!, base: 'abc1234', description: 'Trazabilidad de una decisión.', verify: 'true', split: 'validation' },
  ] };
  s.db.query('INSERT INTO experiments (id,baseline,candidate,suite,suite_digest,created_at) VALUES (?,?,?,?,?,?)').run('perfil-e2e', d1, d2, JSON.stringify(suite), suiteDigest(suite), iso(48));
  const run = s.db.query('INSERT INTO experiment_runs (experiment_id,batch,seed,split,task_id,repeat,arm,position,profile_digest,agent,success,diff_lines,duration_ms,cost_usd,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const t of suite.tasks) for (const [position, arm] of ['baseline', 'candidate', 'baseline_rep'].entries()) run.run('perfil-e2e', 'lote-e2e', 7, t.split, t.id, 0, arm, position, arm === 'candidate' ? d2 : d1, 'native', position % 2, 8 + position, 22000 + position * 900, 0.1 + position * 0.03, iso(40));

  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  s.close();
  return { stateDir, repos, changes, activities, automation: automation.id, signal: sig.id, profiles: { v1: d1, v2: d2 } };
}

if (import.meta.main) console.log(JSON.stringify(sembrar(process.argv[2] ?? join(process.cwd(), '.e2e-semilla')), null, 2));
