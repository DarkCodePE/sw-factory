# Reporte Ola 0 — agy (agentes, pool y worktrees)

**Repo / Worktree:** `/home/orlando/Desktop/factory/sw-factory-ola0-agy`  
**Rama:** `fab/research-ola0-agy` (base `main@29d4dd3`)  
**Fecha:** 2026-10-30  

---

## 1. Resumen de cambios por defecto (archivo:línea)

### D3 — Clasificación de STATUS antes de truncar y distinción de missing/blocked
- **`src/prompts.ts:82-93`**:
  - Se añadió la interfaz `ReportStatus { done: boolean; kind: 'done' | 'blocked' | 'missing'; reason: string }`.
  - Se modificó `parseReportStatus(output: string)` para clasificar el `kind`:
    - Sin línea de STATUS: `{ done: false, kind: 'missing', reason: 'report has no STATUS line' }`.
    - `STATUS: done`: `{ done: true, kind: 'done', reason: '' }`.
    - `STATUS: blocked ...`: `{ done: false, kind: 'blocked', reason: line.replace(/^STATUS:\s* /i, '') }`.
    - Otros (p. ej. `STATUS: pending` u otros textos): `{ done: false, kind: 'missing', reason: 'report has no STATUS line' }`.
- **`src/agents.ts:4-18, 125-135, 137-168`**:
  - Se definió e integró `AgentRunStatus` en `AgentRun`: `status: { kind: 'done' | 'blocked' | 'missing'; reason: string }`.
  - En `boundedAgentOutput`: se eliminó la inyección de `'STATUS: blocked - report has no STATUS line'`. Si existe una línea real de STATUS del agente, se conserva en el prefijo truncado; de lo contrario, el prefijo únicamente incluye `[Report body truncated]\n`.
  - En `runAgent`: se calcula `status` sobre la salida completa (`rawOutput`) antes de pasarla a `boundedAgentOutput`, retornando `status` dentro de `AgentRun`.
- **`src/pool.ts:4, 48-57`**:
  - Se eliminó el re-parseo de salida truncada con `parseReportStatus(run.output)`.
  - Se utiliza `run.status`.
  - Si `run.status.kind === 'missing'`, se registra en la actividad `${run.status.reason}\n\n...` (`'report has no STATUS line'`) y se loguea `failed: ${run.status.reason}` (sin anteponer "blocked").
  - Si `run.status.kind === 'blocked'`, se preserva `blocked: ${run.status.reason}`.
- **`tests/pool.test.ts:63-64`**:
  - Se actualizaron las aserciones de `parseReportStatus` para esperar `kind: 'blocked'` y `kind: 'missing'`.
- **`tests/agents-output.test.ts:1-50`** (nuevo):
  - Verifica que `boundedAgentOutput` no inventa línea `STATUS:` cuando no existe en salidas de 24 000 caracteres, y conserva headers reales.
  - Verifica que `runAgent` clasifica antes de truncar (status `missing` sin "STATUS: blocked", status `blocked` con bloqueo real, y status `done` con salida larga).

### D5 — Protección de llamadas `git` con flags seguros en worktrees y pool
- **`src/worktrees.ts:5-13`**:
  - Se definió y exportó `GIT_SAFE_FLAGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=']`.
  - La función `git(cwd, ...args)` ejecuta `Bun.spawn(['git', ...GIT_SAFE_FLAGS, ...args], ...)` protegiendo todas las operaciones de worktrees (`ensureWorktree`, `commitWorktree`, `mergeAndCleanup`, `removeWorktree`, etc.).
- **`src/pool.ts:8, 31-36, 68`**:
  - Se importó `GIT_SAFE_FLAGS` de `./worktrees.ts` y se aplicó a las llamadas directas de `Bun.spawn(['git', ...GIT_SAFE_FLAGS, ...])` para `diff --stat` y `status --porcelain`.
- **`tests/worktrees.test.ts:180-202`**:
  - Test que instala hooks ejecutables `post-checkout` y `pre-commit` en `.git/hooks/` que intentan escribir archivos marcadores. Comprueba que ni `ensureWorktree` ni `commitWorktree` los ejecutan.

### H2 — Verificación de worktree limpio (`git status --porcelain`) tras todos los validadores
- **`src/pool.ts:65-74`**:
  - Se removió la condición restrictiva `if (a.validator === 'qa')`.
  - Se comprueba `git status --porcelain` tras **cualquier** validador.
  - Si el worktree quedó sucio, la actividad falla con el mensaje `${a.validator} dejó cambios en el worktree`.
- **`tests/validators-pool.test.ts:89-123`**:
  - Test que ejecuta un validador no-QA (`code_review`) que deja un archivo sin commitear en el worktree y verifica que la actividad falla con `'code_review dejó cambios en el worktree'`.

---

## 2. Commits realizados

Tres commits limpios en la rama `fab/research-ola0-agy`:
1. `40346f0`: `D3: clasificar STATUS antes de truncar salida y distinguir missing de blocked`
2. `f9ab813`: `D5: usar flags seguros de git en worktrees y llamadas del pool`
3. `d43b031`: `H2: verificar porcelain tras todos los validadores y reportar cambios`

---

## 3. Verificación

### `bun test`
```
 755 pass
 0 fail
 4186 expect() calls
Ran 755 tests across 78 files. [201.27s]
```
*(Línea base en main: 751 tests, 0 fallos. Con las 4 nuevas pruebas: 755 tests, 0 fallos).*

### `bunx tsc --noEmit`
```
(salida vacía, código de salida 0)
```

---

## 4. Decisiones y notas
- **Actualización en `tests/pool.test.ts`**: La prueba unitaria de `parseReportStatus` fue actualizada para comprobar el nuevo campo `kind` devuelto (`kind: 'blocked'` y `kind: 'missing'`). Los demás tests del pool pasaron sin modificaciones.
- **`GIT_SAFE_FLAGS` centralizado**: Se exportó desde `src/worktrees.ts` y se reutilizó en `src/pool.ts` para asegurar consistencia estricta entre todas las operaciones auxiliares de Git.
- **Respeto de límites y aislamiento**: No se tocaron archivos fuera de los permitidos (`src/store.ts`, `src/validators/publish.ts` y `src/tui.ts` permanecieron intactos).
