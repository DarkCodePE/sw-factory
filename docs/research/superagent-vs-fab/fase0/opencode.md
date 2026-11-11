# Revisión fase 0 (goldfish opencode)

- **Revisor:** opencode (goldfish, sin contexto previo)
- **Roles EGM:** `zoom_out.md`, `design_critic.md`
- **Worktree revisado:** `/home/orlando/Desktop/factory/sw-factory-fase0` (rama `feat/fase0-endurecer`, base `ce84fc4`)
- **Alcance:** revisión de solo lectura del diff sin commit (`git diff` + archivo nuevo `tests/agents-stdin.test.ts`) y ejecución de typecheck/tests focalizados. No se editó ningún archivo del worktree, no se hizo commit y no se lanzaron subagentes. No se leyó `fase0/codex.md` hasta completar los hallazgos.

## Veredicto

**Listo con cambios.**

Los cinco endurecimientos pedidos están sustancialmente implementados, los wrappers `live-claude`/`live-native` siguen siendo compatibles (verificado por lectura) y la verificación ejecutada pasó (`tsc --noEmit` y 56 tests focalizados). Quedan hallazgos de severidad media/baja sobre semántica de retorno/robustez operativa en recuperación de huérfanos y preparación de worktrees que conviene aclarar o cubrir antes de dar el cambio por cerrado.

## Evidencia verificada (ejecutada/leída)

- **Leído:** `BRIEF-REVIEW-AGY.md`, `BRIEF-FASE0.md`, `zoom_out.md`, `design_critic.md`, `git status`/`git diff` completo, `tests/agents-stdin.test.ts`, `src/agents.ts`, `src/store.ts`, `src/pool.ts`, `src/worktrees.ts`, `src/connectors/intake.ts`, `src/manifest-capture.ts`, tests modificados/nuevos relevantes, `/home/orlando/Desktop/factory/sw-factory-live-claude/src/live/claude.ts`, `/home/orlando/Desktop/factory/sw-factory-live-native/src/live/native.ts`.
- **Graft:** `graft callers recordActivityFailure` mostró llamadores en `src/store.ts:912` (`failActivity`) y `src/store.ts:1102` (`requeueOrphans`).
- **Ejecutado:**
  - `cd /home/orlando/Desktop/factory/sw-factory-fase0 && bun run typecheck` → `tsc --noEmit -p .` (sin errores).
  - `cd /home/orlando/Desktop/factory/sw-factory-fase0 && bun test tests/agents-stdin.test.ts tests/store.test.ts tests/worktrees.test.ts tests/connectors-intake.test.ts tests/pool-leases.test.ts` → `56 pass, 0 fail, 277 expect() calls, Ran 56 tests across 5 files. [4.81s]`.
- **Intentado (no completado):** `bun test tests` (suite completa) superó el timeout de 120s de esta sesión antes de terminar; no hay resultado completo verificado aquí.

## Tabla de hallazgos

| id | sev. | ruta:línea | problema | escenario concreto que falla o se degrada | arreglo propuesto |
|---|---|---|---|---|---|
| F1 | media | `src/store.ts:1102-1104`, `src/pool.ts:393-399` | `requeueOrphans` ahora incrementa `count` solo cuando la recovery deja la activity en `pending`; si el lease agotó el presupuesto y la deja `failed`, el huérfano se procesa pero la función devuelve 0 para ese caso. El pool usa ese retorno para log (`requeued ${recovered}...`) y para decidir refresco/espera. | Una activity huérfana alcanza `MAX_ACTIVITY_RETRIES` en esta pasada: queda `failed` y el change `failed` (correcto en DB), pero `requeueOrphans` puede retornar 0 y el pool no registra que se recuperó/falló un huérfano ni necesariamente toma el camino de refresh inmediato asociado a `recovered > 0`. En operación no supervisada, el síntoma es observabilidad/latencia de reacción degradada justo en el caso terminal que más importa vigilar. | Distinguir “huérfanos procesados” de “huérfanos reencolados”: devolver/registrar ambos contadores o devolver `processed > 0` para que el pool haga refresh/log aunque el resultado sea fallo permanente; añadir un test de pool/loop que cubra expiración final (no solo requeue). |
| F2 | media | `src/store.ts:1052-1108`, `src/store.ts:918-933` | La recuperación de huérfanos corre en una sola transacción IMMEDIATE y delega cada caso no terminal a `recordActivityFailure`, que lanza `StoreError('conflict')` si el `UPDATE` condicionado (`status='in_progress' AND worker_id IS ?` + change no terminal) no afecta filas. Antes, el reencolado por fila comprobaba `res.changes === 1` y continuaba; ahora una condición inesperada en un huérfano aborta toda la pasada. | En una pasada con varios huérfanos expirados, uno cambia de estado/propietario entre el `SELECT` inicial y su procesamiento (carrera rara, claim tardío externo, o transición concurrente no contemplada): `recordActivityFailure` lanza conflicto y el `withRetry`/tx aborta, dejando sin procesar también los demás huérfanos válidos hasta un intento posterior. | Capturar/registrar conflictos por fila dentro del bucle (sin tumbar el lote) o revalidar y omitir filas ya no reclamables, manteniendo el reintento de la tx solo para contención `SQLITE_BUSY`. Cubrir con test de carrera/batch si es viable. |
| F3 | baja | `src/worktrees.ts:69-83` | `ensureWorktree` crea el marcador `.preparing` antes de `git worktree add` y lo elimina solo tras verificación y cálculo de base exitosos. Si `git worktree add`, `verifyWorktree` o pasos posteriores fallan, el marcador (y posiblemente estado parcial) queda persistente y cualquier intento futuro falla en `existsSync(preparing)` con “preparation is incomplete…; inspect it manually”. | Un fallo transitorio de git (I/O, lock externo, estado temporal del repo) durante la creación deja el worktree permanentemente bloqueado para la fab hasta intervención manual, aunque el trabajo pendiente pudiera recuperarse con un reintento limpio. Esto es coherente con “no borres nada automáticamente”, pero eleva fricción operativa en modo residente. | Documentar explícitamente el protocolo de recuperación del marcador/ruta; considerar distinguir “falló antes de crear artefactos” de “creación parcial” (con evidencia verificable) o exponer una ruta de remediación manual segura. Añadir test del caso “git worktree add lanza y deja marcador”. |
| F4 | baja | `src/agents.ts:96-99`, `src/agents.ts:137-141`, `src/agents.ts:45-50,82-120,142-149` | Los adaptadores `agy` y `fake` siguen sin `promptStdin` y entregan prompt por argv. Para `claude/codex/droid/native` el cambio cumple stdin (>200 KiB cubierto en tests y argv sin prompt), pero HU no confiable en `agy` permanece visible en argv y sujeta a límites de longitud del SO/CLI. | Si el pool ejecuta una HU grande o sensible con agente `agy`, el prompt sigue expuesto en la lista de procesos y puede fallar por longitud; `fake` conserva truncado propio (comportamiento conocido de test adapter). | Aceptable si se reconoce explícitamente: dejar anotado en configuración/operación que `agy` no es apto para prompts grandes/sensibles hasta soportar stdin o canal equivalente. (El brief permite dejar por argv y anotar.) |

## Hallazgos positivos / cobertura de lo pedido (verificado)

- **Huérfanos/reintentos:** `recordActivityFailure` centraliza política de retry, marca fallo permanente con `completed_at`, evento de error que incluye `lease expired` y actualiza estado de change para no validadores; `requeueOrphans` relee estado de change dentro de la pasada (`src/store.ts:912-945,1093-1104`). Tests nuevos en `tests/store.test.ts:229-281` cubren agotamiento por lease, presupuesto compartido y validador huérfano preservando change `implemented`.
- **Token por claim:** `workerId` incluye `randomUUID()` por intento (`src/pool.ts:4,414`); test `tests/pool-leases.test.ts:547-575` verifica unicidad y rechazo de `heartbeat`/`completeActivity` con tokens antiguos.
- **Verificación de worktree:** `verifyWorktree` comprueba linked worktree, root, `git-common-dir` canónico, rama esperada, índice/locks y HEAD; creación usa marcador `.preparing` y verificación post-creación (`src/worktrees.ts:39-84`). Tests en `tests/worktrees.test.ts:232-286` cubren otro repo, rama cambiada/detached, directorio/repo independiente, reutilización legacy válida con dirty files y checkout incompleto/marcador.
- **importIssue con retry:** transacción envuelta en `store.withRetry(...).immediate()` (`src/connectors/intake.ts:40-52`); test de contención/idempotencia en `tests/connectors-intake.test.ts:116-148`.
- **Prompt por stdin y compatibilidad:** `promptStdin` por adaptador, `command(..., {promptStdin})` conserva argv por defecto, `runAgent` pasa stdin UTF-8 y `manifest-capture` hereda stdin (`src/agents.ts:32-42,44-150,176-188`, `src/manifest-capture.ts:12`). `live-claude` sigue componiendo `adapter.command`/flags (`.../sw-factory-live-claude/src/live/claude.ts:43-47`) y `native` sigue construyendo su propio adapter sin `promptStdin` (`.../sw-factory-live-native/src/live/native.ts:69-84`), por lo que el cambio no rompe su contrato observado. Tests nuevos `tests/agents-stdin.test.ts` cubren compatibilidad, >200 KiB, wrapper/capture, argv-only y no bloqueo por stdin grande.

## Contraste con `codex.md` (leído después de redactar hallazgos)

- **Coincidencias:** codex describe correctamente los cinco defectos y fixes principales (política compartida huérfanos/retry, `randomUUID` por claim, verificación + marcador de worktree con origen copilot MIT, `withRetry`+`immediate` en import atómico, stdin por capacidad con compatibilidad de `command` y `manifest-capture` heredando stdin), y las limitaciones de `agy`/`/dev/stdin`/no cambio de truncado 8 chars.
- **Base y alcance de verificación:** codex reporta base 1060 pass/1 fail (timeout conocido) y final 1077 pass/1 fail en suite completa, además de typecheck y corridas focalizadas (`fase0/codex.md:13-39,166-193`). En esta revisión independiente solo se verificó typecheck y 56 tests focalizados; la suite completa no fue completada aquí por timeout de ejecución. Esto no contradice su evidencia, pero no la replica.
- **Divergencias/énfasis añadidos por esta revisión:**
  - codex afirma que “El retorno sigue contando solo las activities efectivamente reencoladas” (`fase0/codex.md:44`) pero no analiza el efecto en el consumidor del pool; mi F1 señala el posible impacto observacional/de refresh cuando la recovery termina en fallo permanente (`src/store.ts:1103`, `src/pool.ts:393-399`).
  - codex no discute la tolerancia a fallos por fila en lotes de `requeueOrphans`; mi F2 señala que un conflicto en `recordActivityFailure` aborta la tx completa a diferencia del patrón previo más tolerante por fila.
  - codex documenta el fail-closed del marcador (`fase0/codex.md:74,88`) en línea con la tarea; mi F3 lo plantea como riesgo operativo adicional ante fallos transitorios de creación.

## Lo que no revisé

- No ejecuté la suite completa `bun test tests` hasta el final en este entorno (timeout a 120s); la conclusión de “sin regresiones globales” depende de las corridas reportadas por codex y de mi corrida focalizada.
- No ejecuté CLIs reales (`claude`, `codex`, `agy`, `droid`) contra modelos/servicios; la revisión de stdin se apoya en diff, tests con procesos locales y lectura de wrappers/ayudas citadas en el diff/contexto.
- No revisé empíricamente comportamiento en Windows para `--file /dev/stdin` (droid) ni concurrencia multi-proceso real más allá de los tests existentes/añadidos.
- No inspeccioné en ejecución escenarios de carreras distribuidas entre pools remotos ni la interacción completa del loop del pool ante fallos permanentes de huérfanos (más allá de lectura de código).
- No leí `fase0/agy.md`, `fase0/haiku.md` ni otros informes de revisores.

<!-- FIN -->
