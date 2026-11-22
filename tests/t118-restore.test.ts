import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, statSync, chmodSync } from 'node:fs';
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

    // 2. Conservación del recuento y contenido exacto de filas sembradas (incluida la fila en WAL)
    expect(res.restoredRowsMatched).toBe(true);
    expect(res.walExistedAtBackup).toBe(true);
    expect(res.naiveMissedWalRow).toBe(true);
    expect(res.walRowRestored).toBe(true);
    expect(res.seededWorkstreams).toBe(2);
    expect(res.seededChanges).toBe(3);

    // 3. Apertura en solo lectura confirmada
    expect(res.readonlyStoreOpened).toBe(true);

    // 4. Medición de tiempos: RTO y duración
    expect(res.durationRestoreMs).toBeGreaterThanOrEqual(0);
  });

  test('Scripts deploy/scripts/backup.sh y restore.sh restauran y verifican SHA256 con WAL activo', () => {
    const backupScript = join(__dirname, '../deploy/scripts/backup.sh');
    const restoreScript = join(__dirname, '../deploy/scripts/restore.sh');

    // Crea base origen con Store
    const sourceState = join(workDir, 'script-source');
    mkdirSync(sourceState, { recursive: true });
    const sourceDb = join(sourceState, 'fabrica.db');

    // 1. Sembrado con lector bloqueando checkpoint
    execSync(`bun -e '
      import { Store } from "./src/store.ts";
      import { Database } from "bun:sqlite";
      import { copyFileSync } from "node:fs";

      const s = new Store("${sourceDb}");
      const ws = s.createWorkstream({ slug: "ws-sh", goal: "Script test", repo: "test/repo" });
      s.setWorkstreamState(ws.id, "active");
      s.createChange(ws.id, "Change script base", "Desc");
      s.db.exec("PRAGMA wal_checkpoint(PASSIVE);");

      const reader = new Database("${sourceDb}", { readonly: true });
      reader.exec("BEGIN");
      reader.query("SELECT count(*) FROM workstreams").get();

      // Transacción confirmada en WAL
      s.createChange(ws.id, "FILA-WAL-SCRIPT", "Solo en WAL");

      // cp ingenuo
      copyFileSync("${sourceDb}", "${workDir}/naive-test.db");
      reader.exec("COMMIT");
      reader.close();
      s.close();
    '`, { stdio: 'pipe' });

    // Verificar que el cp ingenuo NO tiene la fila de WAL
    const naiveCheck = execSync(`bun -e '
      import { Database } from "bun:sqlite";
      const d = new Database("${workDir}/naive-test.db", { readonly: true });
      try {
        const row = d.query("SELECT count(*) as n FROM changes WHERE title = \\"FILA-WAL-SCRIPT\\"").get() as any;
        console.log(row?.n ?? 0);
      } catch {
        console.log(0);
      }
      d.close();
    '`).toString().trim();
    expect(naiveCheck).toBe('0');

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

    // Verifica que el Store abre y lee el contenido restaurado, incluida la fila de WAL
    const output = execSync(`bun -e '
      import { Store } from "./src/store.ts";
      const s = new Store("${restoredDb}", { readonly: true });
      const list = s.listWorkstreams();
      const changes = s.changeIndex();
      console.log(list[0]?.slug + " " + changes.some(c => c.title === "FILA-WAL-SCRIPT"));
      s.close();
    '`).toString().trim();
    expect(output).toBe('ws-sh true');
  });

  test('T118-H6: restore.sh valida destino libre, obligatoriedad de SHA256 y sustitución atómica', () => {
    const backupScript = join(__dirname, '../deploy/scripts/backup.sh');
    const restoreScript = join(__dirname, '../deploy/scripts/restore.sh');

    const sourceState = join(workDir, 'h6-source');
    mkdirSync(sourceState, { recursive: true });
    const sourceDb = join(sourceState, 'fabrica.db');

    execSync(`bun -e '
      import { Store } from "./src/store.ts";
      const s = new Store("${sourceDb}");
      s.createWorkstream({ slug: "ws-h6", goal: "H6 test", repo: "test/repo" });
      s.close();
    '`);

    const backupDir = join(workDir, 'h6-backups');
    execSync(`bash "${backupScript}" "${sourceDb}" "${backupDir}"`, { stdio: 'pipe' });
    const files = execSync(`ls -1 "${backupDir}"/*.db`).toString().trim().split('\n');
    const backupFile = files[0]!;

    // 1. Destino ya ocupado -> debe fallar sin --force
    const targetDir = join(workDir, 'h6-target');
    mkdirSync(targetDir, { recursive: true });
    const existingDb = join(targetDir, 'fabrica.db');
    execSync(`touch "${existingDb}"`);

    let failedOccupied = false;
    try {
      execSync(`bash "${restoreScript}" "${backupFile}" "${targetDir}"`, { stdio: 'pipe' });
    } catch {
      failedOccupied = true;
    }
    expect(failedOccupied).toBe(true);

    // Con --force sobrescribe con éxito
    execSync(`bash "${restoreScript}" --force "${backupFile}" "${targetDir}"`, { stdio: 'pipe' });
    expect(existsSync(existingDb)).toBe(true);

    // 2. Sin archivo .sha256 -> debe fallar salvo --no-checksum
    const noShaBackup = join(workDir, 'sin-sha.db');
    execSync(`cp "${backupFile}" "${noShaBackup}"`); // Sin copiar el .sha256
    const noShaTarget = join(workDir, 'h6-nosha-target');

    let failedNoSha = false;
    try {
      execSync(`bash "${restoreScript}" "${noShaBackup}" "${noShaTarget}"`, { stdio: 'pipe' });
    } catch {
      failedNoSha = true;
    }
    expect(failedNoSha).toBe(true);
    expect(existsSync(join(noShaTarget, 'fabrica.db'))).toBe(false);

    // Con --no-checksum se permite
    execSync(`bash "${restoreScript}" --no-checksum "${noShaBackup}" "${noShaTarget}"`, { stdio: 'pipe' });
    expect(existsSync(join(noShaTarget, 'fabrica.db'))).toBe(true);

    // 3. Respaldo truncado / corrupto -> falla y no deja fabrica.db en el destino
    const corruptBackup = join(workDir, 'corrupt.db');
    execSync(`head -c 200 "${backupFile}" > "${corruptBackup}"`);
    execSync(`sha256sum "${corruptBackup}" | awk '{print $1}' > "${corruptBackup}.sha256"`);
    const corruptTarget = join(workDir, 'h6-corrupt-target');

    let failedCorrupt = false;
    try {
      execSync(`bash "${restoreScript}" "${corruptBackup}" "${corruptTarget}"`, { stdio: 'pipe' });
    } catch {
      failedCorrupt = true;
    }
    expect(failedCorrupt).toBe(true);
    expect(existsSync(join(corruptTarget, 'fabrica.db'))).toBe(false);
  });

  test('T118-H14: backup.sh soporta rutas con comillas simples, evita colisiones y respeta permisos', () => {
    const backupScript = join(__dirname, '../deploy/scripts/backup.sh');

    const sourceState = join(workDir, 'h14-source');
    mkdirSync(sourceState, { recursive: true });
    const sourceDb = join(sourceState, 'fabrica.db');
    execSync(`bun -e '
      import { Store } from "./src/store.ts";
      const s = new Store("${sourceDb}");
      s.createWorkstream({ slug: "ws-h14", goal: "H14 test", repo: "test/repo" });
      s.close();
    '`);

    // 1. Ruta con comilla simple en el directorio de destino
    const quoteDir = join(workDir, "o'brien-backups");
    execSync(`bash "${backupScript}" "${sourceDb}" "${quoteDir}"`, { stdio: 'pipe' });
    const quoteFiles = execSync(`ls -1 "${quoteDir}"/*.db`).toString().trim().split('\n');
    expect(quoteFiles.length).toBe(1);

    // 2. Dos copias consecutivas en el mismo segundo dejan dos ficheros distintos
    const multiDir = join(workDir, 'multi-backups');
    execSync(`bash "${backupScript}" "${sourceDb}" "${multiDir}"`, { stdio: 'pipe' });
    execSync(`bash "${backupScript}" "${sourceDb}" "${multiDir}"`, { stdio: 'pipe' });
    const multiFiles = execSync(`ls -1 "${multiDir}"/*.db`).toString().trim().split('\n').filter(Boolean);
    expect(multiFiles.length).toBe(2);
    expect(multiFiles[0]).not.toBe(multiFiles[1]);

    // 3. Directorio existente con permisos 0755 no se muta a 0700
    const existingDir = join(workDir, 'existing-755');
    mkdirSync(existingDir);
    chmodSync(existingDir, 0o755);
    execSync(`bash "${backupScript}" "${sourceDb}" "${existingDir}"`, { stdio: 'pipe' });
    const mode = statSync(existingDir).mode & 0o777;
    expect(mode.toString(8)).toBe('755');
  });
});
