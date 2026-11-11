# Informe de revisión Fase 0 (Goldfish AGY)

- **Fecha:** 2026-11-10
- **Worktree evaluado:** `/home/orlando/Desktop/factory/sw-factory-fase0`
- **Rama:** `feat/fase0-endurecer`
- **Base commit:** `ce84fc4`
- **Revisor:** Goldfish AGY (Roles: `egm-codebase-details` y `egm-implementation-readiness`)

---

## Veredicto

**Listo con cambios**.

La implementación aborda rigurosamente los cinco defectos identificados en el brief original, mantiene compatibilidad hacia atrás con las invocaciones existentes de los adaptadores y los wrappers de las ramas `live-*`, y supera el 100% de la suite de pruebas del proyecto (1078 pass, 0 fail en 102 archivos).

Sin embargo, se detectó una **regresión de severidad alta** en la unificación de fallos y reencolados en `src/store.ts:934-936` (`recordActivityFailure`): al reencolar o fallar con reintento una actividad huérfana de tipo `gates`, el change cambia erróneamente su estado de `'implemented'` a `'pending'`. Como resultado posterior, una vez que `gates` y los validadores terminan satisfactoriamente, el change no puede cerrarse (`closeChange` rechaza cambios que no estén en `'implemented'`), dejándolo atascado. Este defecto requiere una corrección condicional de dos líneas antes de realizar el commit.

---

## Tabla de hallazgos

| ID | Severidad | Ruta:Línea | Problema | Escenario concreto que falla | Arreglo propuesto |
|---|---|---|---|---|---|
| **H-01** | **Alta** (Blocker de release) | `src/store.ts:934-936`, `src/store.ts:1102` | `recordActivityFailure` resetea incondicionalmente el change a `'pending'` si `!a.validator`, sin verificar si el change ya estaba en `'implemented'`. | **[VERIFICADO]** Cuando una actividad de tipo `gates` (`a.kind === 'gates'`, `a.validator === null`) sufre vencimiento de lease (`requeueOrphans`) o un fallo transitorio con reintentos pendientes (`failActivity`), el change (que estaba en `'implemented'`) pasa a `'pending'`. Tras reintentar y pasar `gates`, `closeChange(changeId, 'completed')` lanza `StoreError: change <id> is pending, not implemented`. El change queda atascado de por vida. | En `src/store.ts:934-936`, solo transicionar a `'pending'` si `c.status === 'in_progress'`: <br> `if (!a.validator) { if (retry) { if (c.status === 'in_progress') this.setChangeStatus(a.changeId, 'pending'); } else { this.setChangeStatus(a.changeId, 'failed'); } }`. |
| **H-02** | **Media** (Riesgo arquitectural) | `src/worktrees.ts:67` | Truncado de la ruta y rama del worktree a los primeros 8 caracteres del UUID (`changeId.slice(0, 8)`). | **[VERIFICADO]** En caso de colisión de prefijo de 32 bits entre dos changes (probable tras ~65.000 cambios por paradoja del cumpleaños), el segundo change colisiona con el directorio del primero. `verifyWorktree` detecta la discrepancia de rama (`expected fab/<id2>`) y aborta con error, bloqueando el nuevo change. | Mantener en esta fase conforme al brief (para no romper worktrees activos), pero planificar en Fase 1/2 la migración de rutas a `changeId` completo o subdirectorios particionados. |
| **H-03** | **Baja** (Calidad de tipos) | `src/pool.ts:212` | Signatura estrecha en el wrapper `captureAgent.command` (`options?: { readOnly?: boolean }`). | **[VERIFICADO]** Aunque en runtime de JS el objeto `options` con `promptStdin: true` se propaga intacto a `agent.command`, la anotación omite `promptStdin`. Si un desarrollador añade lógica interna a esa lambda que consulte `options.promptStdin`, TypeScript fallará la compilación. | Tipar `captureAgent.command` como `(text: string, options?: { readOnly?: boolean; promptStdin?: boolean }) => string[]`. |
| **H-04** | **Baja** (Higiene operacional) | `src/worktrees.ts:70`, `src/worktrees.ts:134` | Persistencia del marcador `.<shortId>.preparing` ante abortos de infraestructura sin limpieza en `removeWorktree`. | **[VERIFICADO]** Si la creación del worktree falla antes de concluir (p. ej. `SIGKILL`, disco lleno), `unlinkSync(preparing)` no se ejecuta. `ensureWorktree` rechaza cualquier reutilización posterior con error de inspección manual, pero `removeWorktree` no elimina este archivo temporal. | Considerar que `removeWorktree` (`src/worktrees.ts:134`) elimine también `.${shortId}.preparing` si existe, facilitando la limpieza asistida desde comandos administrativos. |

---

## Análisis detallado por tarea

### Tarea 1: Tope de reintentos en `requeueOrphans`

- **Estado del defecto en base `ce84fc4` [VERIFICADO]:** En `src/store.ts:1096@ce84fc4`, `requeueOrphans` actualizaba las actividades con lease vencido a `status = 'pending'`, pero no modificaba ni consultaba `retry_count`.
- **Implementación realizada:** Se unificó la mutación en `recordActivityFailure` (`src/store.ts:918-945`), compartida entre `failActivity` y `requeueOrphans`. Ambas se ejecutan bajo una transacción SQLite `IMMEDIATE`. Incrementa `retry_count`, evalúa `< MAX_ACTIVITY_RETRIES`, y si se agota el presupuesto transiciona a `status = 'failed'` fijando `completed_at`, emitiendo evento de severidad `error`.
- **Hallazgo y regresión detectada (H-01) [VERIFICADO]:**
  En la base `ce84fc4`, `requeueOrphans` contenía:
  ```ts
  if (!act.validator && act.change_status === 'in_progress') {
    this.setChangeStatus(act.change_id, 'pending');
  }
  ```
  Al extraer `recordActivityFailure`, se programó:
  ```ts
  if (!a.validator) {
    this.setChangeStatus(a.changeId, retry ? 'pending' : 'failed');
  }
  ```
  Nótese que se eliminó la condición `c.status === 'in_progress'`.
  Cuando la actividad huérfana es de tipo `gates`:
  1. `a.kind === 'gates'` y `a.validator === null` (por tanto `!a.validator` es `true`).
  2. El change se encuentra en estado `'implemented'` (tras finalizar con éxito la fase de implementación).
  3. Si el lease de `gates` expira o el proceso muere, `recordActivityFailure` cambia `change.status` a `'pending'`.
  4. La actividad `gates` se reintenta y pasa (`VERDICT: pass`). `completeActivity` aprueba gates y encola validadores, pero **no** vuelve a poner el change en `'implemented'`.
  5. Al concluir los validadores, `closeChange(changeId, 'completed')` ejecuta:
     ```ts
     if (outcome === 'completed' && c.status !== 'implemented') {
       throw new StoreError('invalid_transition', `change ${changeId} is ${c.status}, not implemented`);
     }
     ```
  6. El cierre falla sistemáticamente.
  
  **Prueba de concepto empírica ejecutada:**
  ```text
  After implementation: implemented
  Gate activity kind: gates validator: null
  Change status while gate in progress: implemented
  Change status after gate requeued: pending
  Status after gate2 complete: pending
  Close change failed with: change 8ae796b1-... is pending, not implemented
  ```

---

### Tarea 2: Token por claim en el worker pool

- **Estado del defecto en base `ce84fc4` [VERIFICADO]:** En `src/pool.ts:414@ce84fc4`, el workerId se calculaba como:
  ```ts
  const workerId = `w${(slot++ % current.workerConcurrency) + 1}-${process.pid}`;
  ```
  Al rotar las tareas dentro del mismo slot y PID, el identificador se repetía exactamente.
- **Implementación realizada [VERIFICADO]:** En `src/pool.ts:414`, se añadió un sufijo único:
  ```ts
  const workerId = `w${(slot++ % current.workerConcurrency) + 1}-${process.pid}-${randomUUID()}`;
  ```
  Sin añadir columnas a la base de datos ni alterar la signatura de `claimActivity`.
- **Comprobación de cercado (fencing) [VERIFICADO]:** Todas las operaciones de mutación del store (`heartbeat`, `completeActivity`, `failActivity`, `blockActivity`, `quarantineActivity`, `releaseActivity`, `requeueActivity`) incluyen la cláusula SQL `AND worker_id = ?` (o `worker_id IS ?`). Corrutinas o promesas rezagadas con tokens anteriores no pueden sobreescribir claims nuevos.
- **Test validado:** `tests/pool-leases.test.ts` (`successive claims in one pool slot have distinct tokens and fence late writes`), ejecutado con éxito.

---

### Tarea 3: Verificación de worktrees reutilizados

- **Estado del defecto en base `ce84fc4` [VERIFICADO]:** En `src/worktrees.ts:42@ce84fc4`, `ensureWorktree` hacía:
  ```ts
  if (existsSync(path)) return { path, branch, baseSha: ... };
  ```
  Devolvía cualquier directorio existente sin verificar si pertenecía al repo, si estaba en la rama correcta o si era un linked worktree íntegro.
- **Implementación realizada [VERIFICADO]:**
  1. Se implementó `verifyWorktree` (`src/worktrees.ts:39-60`), basada en la referencia de `copilot-superagent/vscode/src/worktree.ts` (licencia MIT debidamente atribuida en comentario):
     - Comprueba que `.git` sea un archivo (`lstatSync.isFile()`).
     - Comprueba que `rev-parse --show-toplevel` coincida con la ruta raíz canónica.
     - Comprueba mediante `rev-parse --path-format=absolute --git-common-dir` que el worktree comparta el mismo common dir canónico del repositorio base (`realpathSync`).
     - Comprueba que `git symbolic-ref --quiet --short HEAD` sea exactamente `branchFor(changeId)`.
     - Inspecciona el directorio de administración (`--absolute-git-dir`) para confirmar la existencia de `index` y la ausencia de bloqueos (`index.lock`, `locked`).
     - Valida `git rev-parse --verify HEAD^{commit}`.
  2. Mecanismo de intención atómica: antes de invocar `git worktree add`, crea un archivo `.<shortId>.preparing` con `flag: 'wx'` (creación exclusiva). Si el archivo ya existe o Git falla antes de validar, se aborta sin borrar nada y requiriendo inspección manual.
  3. No borra archivos ni repositorios ajenos en ningún caso de fallo.
- **Riesgo anotado (H-02) [VERIFICADO]:** Se respeta la directriz de mantener el truncado a 8 caracteres (`changeId.slice(0, 8)`), quedando documentado el riesgo de colisión de hash en el catálogo de hallazgos.

---

### Tarea 4: `withRetry` en `importIssue`

- **Estado del defecto en base `ce84fc4` [VERIFICADO]:** En `src/connectors/intake.ts:40@ce84fc4`, `importIssue` abría directamente `store.db.transaction(() => { ... })()` sin envolverlo en `store.withRetry`.
- **Implementación realizada [VERIFICADO]:** En `src/connectors/intake.ts:40-52`, se envuelve en `store.withRetry(() => store.db.transaction(() => { ... }).immediate())`.
  - La llamada remota de red a Jira (`tickets.getIssue(opts.key)`) queda deliberadamente fuera de la transacción reintentable.
  - El registro de la señal, la vinculación del issue y el triage opcional se mantienen completamente atómicos e idempotentes.
- **Test validado:** Se creó `importIssue retries a contended transaction and remains idempotent` en `tests/connectors-intake.test.ts`, replicando el patrón de bloqueo concurrente entre procesos (`BEGIN IMMEDIATE` con retardo via `Atomics.wait` y `PRAGMA busy_timeout = 5`). Pasa limpiamente en 347 ms.

---

### Tarea 5: Prompt por stdin en adaptadores CLI

- **Estado del defecto en base `ce84fc4` [VERIFICADO]:** En `src/agents.ts:174@ce84fc4`, el prompt se pasaba siempre como argumento de línea de comandos en `agent.command(prompt, options)`, con límite de 128 KiB en Linux y visibilidad en `/proc`. En `src/manifest-capture.ts:12@ce84fc4`, stdin se creaba con `stdin: 'ignore'`.
- **Implementación realizada [VERIFICADO]:**
  1. `AgentAdapter` incorpora `promptStdin?: boolean`.
  2. `claude`, `codex`, `droid` y `native` declaran `promptStdin: true`.
  3. `codex` pasa `-` en lugar del prompt cuando `options.promptStdin` está activo.
  4. `droid` pasa `--file /dev/stdin`.
  5. `native` omite el posicional del prompt, y `src/agent/exec.ts:242` lee de `Bun.stdin.text()` al no ser TTY.
  6. `agy` se mantiene por argv (no se le añade `promptStdin`), dado que su CLI no admite prompt de texto plano sin posicional bajo `--print` (su stdin requiere modo NDJSON `stream-json`).
  7. `manifest-capture.ts:12` se actualizó a `stdin: 'inherit'`, permitiendo que el pipe fluya sin interrupción al binario final.
- **Compatibilidad con ramas dependientes [VERIFICADO]:**
  - Se inspeccionó `/home/orlando/Desktop/factory/sw-factory-live-claude/src/live/claude.ts`. Su patrón `adapter: AgentAdapter = { ...base, command: (prompt, options) => liveClaudeArgv(base.command(prompt, options), ...)` hereda `promptStdin: true` y propaga `options` a `base.command`, omitiendo el prompt de argv y recibiéndolo por stdin sin conflicto.
  - Se inspeccionó `/home/orlando/Desktop/factory/sw-factory-live-native/src/live/native.ts`. Su adaptador utiliza `--file promptPath` hacia un archivo temporal y no declara `promptStdin: true`, por lo que `runAgent` mantiene `stdin: 'ignore'` y no altera su funcionamiento.
  - El contrato por defecto de `agent.command(prompt)` sin la opción `promptStdin: true` sigue retornando el prompt en argv intacto.
- **Tests validados:** `tests/agents-stdin.test.ts` (7 pruebas unitarias completas verificando envíos de más de 200 KiB, integridad SHA-256, herencia a través del wrapper de captura y manejo de procesos que abortan de forma temprana).

---

## Resultados de verificación y pruebas

Todos los comandos se ejecutaron sobre el worktree `/home/orlando/Desktop/factory/sw-factory-fase0` sin realizar commits ni modificaciones en los archivos inspeccionados:

1. **Chequeo de tipos (`typecheck`):**
   ```bash
   $ bun run typecheck
   $ tsc --noEmit -p .
   ```
   *Salida:* Código de salida 0 (limpio, sin errores de tipado).

2. **Ejecución de tests focalizados en los cambios:**
   - `tests/agents-stdin.test.ts`:
     ```text
     7 pass, 0 fail (39 expect() calls) [196.00ms]
     ```
   - `tests/connectors-intake.test.ts`:
     ```text
     9 pass, 0 fail (47 expect() calls) [394.00ms]
     ```
   - `tests/pool-leases.test.ts`:
     ```text
     9 pass, 0 fail (68 expect() calls) [2.07s]
     ```
   - `tests/store.test.ts`:
     ```text
     17 pass, 0 fail (72 expect() calls) [683.00ms]
     ```
   - `tests/worktrees.test.ts`:
     ```text
     14 pass, 0 fail (51 expect() calls) [2.25s]
     ```

3. **Suite completa de pruebas (`bun test tests`):**
   ```text
   1078 pass
   0 fail
   6731 expect() calls
   Ran 1078 tests across 102 files. [281.77s]
   ```
   *Observación:* La totalidad de las pruebas de la suite pasan, incluyendo pruebas de sandbox con `bwrap`, journaling de agentes y coordinación RPC.

---

## Contraste con el informe del implementador (`codex.md`)

Tras redactar de forma independiente los hallazgos y evaluar el código fuente, se procedió a la lectura de `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase0/codex.md`. Se identifican los siguientes puntos de contraste:

1. **Punto ciego crítico sobre `gates` (Hallazgo H-01):**
   - *Informe de Codex (§1):* Codex indica textualmente: *"Los validadores conservan su política original: agotan su activity, pero el change continúa `implemented`"*.
   - *Evaluación Goldfish:* Codex diseñó y ejecutó su test de prueba únicamente sobre validadores (`qa`), los cuales poseen `a.validator === 'qa'`. No advirtió que la actividad `gates` tiene `a.kind === 'gates'` con `a.validator === null` y se ejecuta con el change en `'implemented'`. Al reutilizar ciegamente `recordActivityFailure`, Codex introdujo una regresión inadvertida donde cualquier reintento de lease vencido en `gates` degrada el change a `'pending'`, rompiendo el cierre posterior del change en `closeChange`. Este es el motivo por el cual el veredicto no es "listo para commit", sino "listo con cambios".

2. **Diferencia en resultados de la suite global:**
   - *Informe de Codex (§Verificación previa y §Validación conjunta):* Reporta 1 fallo sistemático persistente por timeout de 30s en `tests/agent-journal.test.ts` (`corrupt final record ignored and repaired; corruption before final record fails closed; 10000 records [30000.37ms]`), obteniendo 1077 pass / 1 fail.
   - *Evaluación Goldfish:* En nuestra corrida sobre el mismo hardware, dicho test completó en ~65-139 ms sin agotar el timeout, registrando un resultado neto superior: **1078 pass / 0 fail**.

3. **Coincidencias de criterio técnico:**
   - **Evaluación de AGY:** Ambos análisis coinciden plenamente en que `agy` no debe configurarse con `promptStdin: true`, dada la incompatibilidad de su CLI en modo texto plano sin argumentos posicionales.
   - **Captura con herencia de stdin:** Ambos análisis identifican que sin la modificación de `stdin: 'inherit'` en `src/manifest-capture.ts`, el pipeline unconfined del pool habría quedado roto para todos los adaptadores con stdin.
   - **Contención en `importIssue`:** Ambos coinciden en la idoneidad del test de contención multi-proceso con `Atomics.wait` y `busy_timeout`.
   - **Riesgo de truncado a 8 caracteres:** Ambos informes respetan la restricción del brief de no modificar el truncado a 8 caracteres y lo clasifican como un riesgo pendiente de resolución futura.

---

## Lo que no se revisó

1. **Ejecución contra APIs remotas comerciales:** No se realizaron llamadas a los endpoints reales de Anthropic, OpenAI o Factory AI (todas las pruebas usan simulaciones locales o CLI mocks en `/tmp`).
2. **Entornos fuera de Linux:** No se validó el comportamiento de los descriptores `/dev/stdin` ni de `bwrap` en sistemas macOS o Windows.
3. **Escenarios de degradación por concurrencia distribuida masiva:** No se realizaron pruebas de estrés con más de 2 procesos SQLite concurrentes simultáneos en `importIssue`.

<!-- FIN -->