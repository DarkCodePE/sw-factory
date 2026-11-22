import { existsSync, mkdirSync, rmSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { Store } from '../../src/store.ts';

export interface SimulacroResult {
  durationBackupMs: number;
  durationRestoreMs: number;
  seededWorkstreams: number;
  seededChanges: number;
  seededActivities: number;
  walExistedAtBackup: boolean;
  naiveMissedWalRow: boolean;
  walRowRestored: boolean;
  integrityCheckOk: boolean;
  foreignKeyCheckOk: boolean;
  restoredRowsMatched: boolean;
  readonlyStoreOpened: boolean;
}

/**
 * Ejecuta el simulacro básico de copia y restauración según T118b ola 1 (§3.3):
 * 1. Siembra una base con el esquema disponible (sin usuarios ni libro).
 * 2. Mantiene una transacción de lectura abierta para bloquear el checkpoint del WAL.
 * 3. Realiza transacciones confirmadas dejando cambios pendientes exclusivamente en WAL.
 * 4. Comprueba que un 'cp' ingenuo no captura la fila del WAL.
 * 5. Ejecuta backup.sh y restore.sh.
 * 6. Verifica que la base restaurada recupera íntegramente la fila de WAL.
 * 7. Verifica integrity_check, foreign_key_check, recuentos y apertura en Store readonly.
 * 8. Registra tiempos de recuperación (RTO).
 */
export async function ejecutarSimulacro(workDir: string): Promise<SimulacroResult> {
  const sourceDir = join(workDir, 'source-state');
  const backupDir = join(workDir, 'backups');
  const restoreDir = join(workDir, 'restore-state');

  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });

  const sourceDb = join(sourceDir, 'fabrica.db');

  // 1. Sembrado
  const store = new Store(sourceDb);
  const ws1 = store.createWorkstream({ slug: 'ws-core', goal: 'Core engine', repo: 'acme/core' });
  const ws2 = store.createWorkstream({ slug: 'ws-docs', goal: 'Documentación', repo: 'acme/docs' });

  const c1 = store.createChange(ws1.id, 'Optimizar consultas', 'Mejora de índices');
  const c2 = store.createChange(ws2.id, 'Guía de inicio', 'Nuevo tutorial');

  // Mutación inicial consolidada
  store.setWorkstreamState(ws1.id, 'active');
  store.addChangeNote(c1.id, 'Nota de revisión inicial');
  store.db.exec('PRAGMA wal_checkpoint(PASSIVE);');

  // 2. Lector abierto que bloquea el truncado del WAL
  const reader = new Database(sourceDb, { readonly: true });
  reader.exec('BEGIN');
  reader.query('SELECT count(*) FROM workstreams').get();

  // Fila confirmada que reside en WAL
  const cWal = store.createChange(ws1.id, 'FILA-SOLO-EN-WAL', 'Transacción confirmada en WAL');

  const walPath = `${sourceDb}-wal`;
  const walExistedAtBackup = existsSync(walPath) && statSync(walPath).size > 0;

  // 3. Demostración de falla de 'cp' simple frente a backup atómico
  const naiveDb = join(workDir, 'naive-cp.db');
  copyFileSync(sourceDb, naiveDb);
  let naiveMissedWalRow = false;
  try {
    const naiveConn = new Database(naiveDb, { readonly: true });
    const naiveRow = naiveConn.query("SELECT count(*) as n FROM changes WHERE title = 'FILA-SOLO-EN-WAL'").get() as { n: number };
    naiveMissedWalRow = (naiveRow?.n ?? 0) === 0;
    naiveConn.close();
  } catch {
    naiveMissedWalRow = true;
  }

  const seededWorkstreams = store.listWorkstreams().length;
  const seededChanges = store.changeIndex().length;
  const seededActivities = store.listActivities({ changeId: c1.id }).length;

  // 4. Copia de seguridad mediante deploy/scripts/backup.sh
  const backupScript = join(__dirname, 'backup.sh');
  const restoreScript = join(__dirname, 'restore.sh');

  const t0Backup = performance.now();
  execSync(`bash "${backupScript}" "${sourceDb}" "${backupDir}"`, { stdio: 'pipe' });
  const durationBackupMs = performance.now() - t0Backup;

  // Liberamos transacciones y cerramos origen
  reader.exec('COMMIT');
  reader.close();
  store.close();

  // 5. Restauración en un nuevo directorio mediante deploy/scripts/restore.sh
  const backupFiles = readdirSync(backupDir).filter(f => f.endsWith('.db') && !f.endsWith('.tmp'));
  if (backupFiles.length === 0) throw new Error('No se generó archivo de respaldo');
  const backupFile = join(backupDir, backupFiles[0]!);

  const t0Restore = performance.now();
  execSync(`bash "${restoreScript}" "${backupFile}" "${restoreDir}"`, { stdio: 'pipe' });
  const durationRestoreMs = performance.now() - t0Restore;

  const restoreDb = join(restoreDir, 'fabrica.db');

  // 6. Verificación de integridad SQLite
  const restoredStore = new Store(restoreDb, { readonly: true });
  const integrity = restoredStore.db.query('PRAGMA integrity_check;').get() as { integrity_check?: string };
  const integrityCheckOk = integrity?.integrity_check === 'ok';

  const fk = restoredStore.db.query('PRAGMA foreign_key_check;').all();
  const foreignKeyCheckOk = fk.length === 0;

  // 7. Verificación de recuento y contenido (incluyendo la fila de WAL)
  const restoredWorkstreams = restoredStore.listWorkstreams();
  const restoredChanges = restoredStore.changeIndex();
  const restoredNotes = restoredStore.listChangeNotes(c1.id);
  const walRowRestored = restoredChanges.some(c => c.title === 'FILA-SOLO-EN-WAL');

  const restoredRowsMatched =
    restoredWorkstreams.length === seededWorkstreams &&
    restoredChanges.length === seededChanges &&
    walRowRestored &&
    restoredWorkstreams.some(w => w.slug === 'ws-core') &&
    restoredWorkstreams.some(w => w.slug === 'ws-docs') &&
    restoredChanges.some(c => c.title === 'Optimizar consultas') &&
    restoredNotes.some(n => n.body === 'Nota de revisión inicial');

  const readonlyStoreOpened = true;
  restoredStore.close();

  return {
    durationBackupMs,
    durationRestoreMs,
    seededWorkstreams,
    seededChanges,
    seededActivities,
    walExistedAtBackup,
    naiveMissedWalRow,
    walRowRestored,
    integrityCheckOk,
    foreignKeyCheckOk,
    restoredRowsMatched,
    readonlyStoreOpened,
  };
}

if (import.meta.main) {
  const dir = process.argv[2] || join(tmpdir(), `fab-simulacro-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  console.log(`[Simulacro T118b] Ejecutando en ${dir}...`);
  ejecutarSimulacro(dir).then(res => {
    console.log('[Simulacro T118b] Resultado:', JSON.stringify(res, null, 2));
    if (!res.integrityCheckOk || !res.foreignKeyCheckOk || !res.restoredRowsMatched) {
      console.error('[Simulacro T118b] Fallo de integridad en la restauración.');
      process.exit(1);
    }
    console.log(`[Simulacro T118b] ÉXITO: RTO medido = ${res.durationRestoreMs.toFixed(2)} ms (Tope de objetivo: 2 h).`);
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }).catch(err => {
    console.error('[Simulacro T118b] Error:', err);
    process.exit(1);
  });
}
