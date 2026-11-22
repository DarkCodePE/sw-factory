import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.ts';

export interface SimulacroResult {
  durationBackupMs: number;
  durationRestoreMs: number;
  seededWorkstreams: number;
  seededChanges: number;
  seededActivities: number;
  walExistedAtBackup: boolean;
  integrityCheckOk: boolean;
  foreignKeyCheckOk: boolean;
  restoredRowsMatched: boolean;
  readonlyStoreOpened: boolean;
}

/**
 * Ejecuta el simulacro básico de copia y restauración según T118b ola 1 (§3.3):
 * 1. Siembra una base con el esquema disponible (sin usuarios ni libro).
 * 2. Realiza transacciones confirmadas dejando cambios en WAL.
 * 3. Ejecuta la copia de seguridad.
 * 4. Simula caída / parada de servicios y restaura en un directorio nuevo.
 * 5. Verifica integrity_check, foreign_key_check, recuentos y apertura en Store readonly.
 * 6. Registra tiempos de recuperación (RTO).
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

  // Mutación en WAL
  store.setWorkstreamState(ws1.id, 'active');
  store.addChangeNote(c1.id, 'Nota de revisión inicial');

  const seededWorkstreams = store.listWorkstreams().length;
  const seededChanges = store.changeIndex().length;
  const seededActivities = store.listActivities({ changeId: c1.id }).length;

  const walExistedAtBackup = existsSync(`${sourceDb}-wal`);

  // 2. Copia de seguridad (simulando parada controlada o checkpoint atómico)
  const t0Backup = performance.now();
  store.db.exec('PRAGMA busy_timeout = 5000;');
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  const backupFile = join(backupDir, 'fabrica-backup.db');
  rmSync(backupFile, { force: true });
  store.db.exec(`VACUUM INTO '${backupFile}';`);
  const durationBackupMs = performance.now() - t0Backup;

  // Cerramos el servicio original para simular parada de negocio
  store.close();

  // 3. Restauración en un nuevo directorio
  const t0Restore = performance.now();
  const restoreDb = join(restoreDir, 'fabrica.db');
  copyFileSync(backupFile, restoreDb);

  // 4. Verificación de integridad SQLite
  const restoredStore = new Store(restoreDb, { readonly: true });
  const integrity = restoredStore.db.query('PRAGMA integrity_check;').get() as { integrity_check?: string };
  const integrityCheckOk = integrity?.integrity_check === 'ok';

  const fk = restoredStore.db.query('PRAGMA foreign_key_check;').all();
  const foreignKeyCheckOk = fk.length === 0;

  // 5. Verificación de recuento y contenido
  const restoredWorkstreams = restoredStore.listWorkstreams();
  const restoredChanges = restoredStore.changeIndex();
  const restoredNotes = restoredStore.listChangeNotes(c1.id);

  const restoredRowsMatched =
    restoredWorkstreams.length === seededWorkstreams &&
    restoredChanges.length === seededChanges &&
    restoredWorkstreams.some(w => w.slug === 'ws-core') &&
    restoredWorkstreams.some(w => w.slug === 'ws-docs') &&
    restoredChanges.some(c => c.title === 'Optimizar consultas') &&
    restoredNotes.some(n => n.body === 'Nota de revisión inicial');

  const readonlyStoreOpened = true;
  restoredStore.close();

  const durationRestoreMs = performance.now() - t0Restore;

  return {
    durationBackupMs,
    durationRestoreMs,
    seededWorkstreams,
    seededChanges,
    seededActivities,
    walExistedAtBackup,
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
