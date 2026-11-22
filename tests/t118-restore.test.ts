import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { ejecutarSimulacro } from '../deploy/scripts/simulacro-recuperacion.ts';

describe('T118b: Copia de seguridad y recuperación básica (Ola 1, §3.3)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = join(tmpdir(), `fab-t118b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  test('Simulacro de recuperación: base con WAL, restauración, integridad y apertura en Store readonly', async () => {
    const res = await ejecutarSimulacro(workDir);

    // 1. Integridad de la base restaurada
    expect(res.integrityCheckOk).toBe(true);
    expect(res.foreignKeyCheckOk).toBe(true);

    // 2. Conservación del recuento y contenido exacto de filas sembradas
    expect(res.restoredRowsMatched).toBe(true);
    expect(res.seededWorkstreams).toBe(2);
    expect(res.seededChanges).toBe(2);

    // 3. Apertura en solo lectura confirmada
    expect(res.readonlyStoreOpened).toBe(true);

    // 4. Medición de tiempos: RTO y duración
    expect(res.durationRestoreMs).toBeGreaterThan(0);
    // Objetivo RTO: 2 h (7_200_000 ms); aquí medido en unos pocos ms
    expect(res.durationRestoreMs).toBeLessThan(5000);
  });

  test('Scripts deploy/scripts/backup.sh y restore.sh restauran y verifican SHA256', () => {
    const backupScript = join(__dirname, '../deploy/scripts/backup.sh');
    const restoreScript = join(__dirname, '../deploy/scripts/restore.sh');

    // Crea base origen con Store
    const sourceState = join(workDir, 'script-source');
    mkdirSync(sourceState, { recursive: true });
    const sourceDb = join(sourceState, 'fabrica.db');

    execSync(`bun -e '
      import { Store } from "./src/store.ts";
      const s = new Store("${sourceDb}");
      const ws = s.createWorkstream({ slug: "ws-sh", goal: "Script test", repo: "test/repo" });
      s.setWorkstreamState(ws.id, "active");
      s.createChange(ws.id, "Change script", "Desc");
      s.close();
    '`, { stdio: 'inherit' });

    // Ejecuta backup.sh
    const backupDir = join(workDir, 'script-backups');
    execSync(`bash "${backupScript}" "${sourceDb}" "${backupDir}"`, { stdio: 'pipe' });

    // Encuentra el archivo de backup generado
    const files = execSync(`ls -1 "${backupDir}"/*.db`).toString().trim().split('\n');
    expect(files.length).toBeGreaterThan(0);
    const backupFile = files[0]!;
    expect(existsSync(`${backupFile}.sha256`)).toBe(true);

    // Ejecuta restore.sh hacia un nuevo stateDir
    const restoreState = join(workDir, 'script-restored');
    execSync(`bash "${restoreScript}" "${backupFile}" "${restoreState}"`, { stdio: 'ignore' });

    const restoredDb = join(restoreState, 'fabrica.db');
    expect(existsSync(restoredDb)).toBe(true);

    // Verifica que el Store abre y lee el contenido restaurado
    const output = execSync(`bun -e '
      import { Store } from "./src/store.ts";
      const s = new Store("${restoredDb}", { readonly: true });
      const list = s.listWorkstreams();
      console.log(list[0]?.slug);
      s.close();
    '`).toString().trim();
    expect(output).toBe('ws-sh');
  });
});
