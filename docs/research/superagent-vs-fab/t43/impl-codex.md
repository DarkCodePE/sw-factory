# T43 — implementación de Mandate y enlace del PR

Implementador: Codex, goldfish. Fecha: 2026-11-18. Base: `origin/release/0.1.0-rc.12`, `ff52f0b`. Worktree: `/home/orlando/Desktop/factory/sw-factory-t43`.

## Entrega

[V] Dos commits locales, sin push ni escrituras en GitHub:

- `8f662a0`: `feat(admisión): revocar el change al retirar su etiqueta`.
- `41a9fcf`: `feat(conectores): enlazar el hilo del PR y reparar tras una caída`.

[V] La cola remota consultada conserva T43 como bloqueada y enumera decisiones pendientes. El encargo ejecutado es el brief T43, que recoge D/E/F/G y autoriza explícitamente estas dos piezas. No cierro T43 ni modifico `task.json`: la revisión independiente y el cierre corresponden al orquestador/dueño.

## Qué cambió

[V] `src/admission/db.ts:67@41a9fcf`: añade por `ALTER` las columnas `trigger_key`, `revoked_at` y `revoked_reason`, también en bases anteriores. `src/admission/apply.ts:30@41a9fcf` guarda el trigger que admitió el hilo.

[V] `src/admission/resident.ts:119@41a9fcf`: antes del descarte por hilo admitido, comprueba el hilo de origen, su change no terminal y la ausencia de la etiqueta original, sin consultar rol ni contenido. Recupera la política de la primera admisión cuando una base antigua carece de `trigger_key`. No usa el cierre del issue como revocación. Un hilo auxiliar del PR no retira el mandato del issue.

[V] En `auto`, una transacción engloba la marca, `mandate-revoked`, `Store.closeChange`, la cancelación de preguntas con `reapQuestions` y la decisión (`resident.ts:135@41a9fcf`). Repetir la retirada no duplica el cierre; reetiquetar queda registrado como `thread-revoked`. En `observe`, solo registra `would_revoke`; el informe lo muestra entre decisiones y lo incluye en `stopsLost` (`src/admission/report.ts:51@41a9fcf`). Se conserva el formato de T13.

[V] `closeChange` barre las activities pendientes y en espera, pero una pregunta requería `reapQuestions`, y el turno activo se para mediante el latido existente (`src/store.ts:567@41a9fcf`, `src/store.ts:685@41a9fcf`, `src/pool.ts:149@41a9fcf`). Los tests comprueban esos efectos por separado.

[V] `src/admission/effects.ts:96@41a9fcf`: despacha los efectos `admit` vencidos antes del resto, conservando el orden por id dentro de cada grupo. Sin esto, una pregunta encolada antes de leer la retirada se publicaba antes de ejecutar la revocación. No se añadió otro router.

[V] `src/connectors/cli.ts:150@41a9fcf`: punto de caída `pr-created`, después de obtener el PR remoto. Tras guardar su referencia, si existe esquema de admisión y el change ya tiene hilos, registra el hilo `github:<repo>#<pr>` y llama a `ThreadLinks.link` en una transacción. Repetir `fab pr open` reutiliza la búsqueda remota existente y repara el enlace. El origen y el primer hilo no se sustituyen.

[V] `src/connectors/cli.ts:147@41a9fcf`: limita la carga de credenciales y el comentario Jira a `source.system === 'jira'`. Antes, un change procedente de GitHub intentaba usar Jira y fallaba antes de abrir el PR. Es necesario para ejecutar el camino pedido.

[V] Dos fixtures de `tests/admission-report.test.ts:116@41a9fcf` y `:205` pasan a nombrar las cuatro columnas que siembran: un `INSERT ... VALUES` sin columnas fallaba al ampliarse la tabla. No se cambiaron sus aserciones.

## Pruebas por requisito

[V] Todos los casos de esta tabla pasaron en la ejecución dirigida de 50 tests.

| Requisito | Evidencia ejecutada |
|---|---|
| D/E: retirar etiqueta; cerrar no revoca; sin consulta de rol | `tests/mandate.test.ts:21@41a9fcf`; conserva `FAB` en issue cerrado, después retira y cancela |
| D: change terminal intacto | `tests/mandate.test.ts:47@41a9fcf`; no marca revocado ni repite el cierre |
| G e idempotencia | `tests/mandate.test.ts:34@41a9fcf`; retirada repetida y reetiquetado: un signal, un change y un evento de cierre; informe con `thread-revoked` |
| Observe | `tests/mandate.test.ts:55@41a9fcf`; `would_revoke`, una fila `stopsLost`, sin cancelar ni marcar la autorización |
| Política original e hilo auxiliar | `tests/mandate.test.ts:66@41a9fcf`; cambiar la configuración no reemplaza la etiqueta autorizante; otro hilo sin etiqueta no cancela |
| Bases anteriores | `tests/mandate.test.ts:78@41a9fcf`; elimina las tres columnas, ejecuta migración dos veces y revoca recuperando la decisión antigua |
| Frontera 13 | `tests/costura-fronteras.test.ts:133@41a9fcf`; caída dentro de transacción: ni marca ni cierre persisten; reintento completa ambos una vez |
| Frontera 14 | `tests/costura-fronteras.test.ts:156@41a9fcf`; pregunta con `reply` pendiente antes de la retirada: pregunta y activity canceladas; cero publicaciones |
| Turno en curso | `tests/costura-fronteras.test.ts:239@41a9fcf`; intercepta el temporizador del latido, lo ejecuta explícitamente después de revocar y comprueba `AbortSignal`, activity cancelada y ninguna pregunta abierta/publicada |
| Frontera 15 | `tests/costura-fronteras.test.ts:200@41a9fcf`; caída después de `gh pr create`; repetir repara el enlace y no crea un segundo PR; tercer intento idempotente |
| Respuesta desde PR | `tests/costura-fronteras.test.ts:215@41a9fcf`; PR creado mediante CLI/gateway falsos; revisión manual origina otra implementación que pregunta en el issue; comentario sin rol ignorado, comentario `triage` del PR responde y su texto llega al turno reanudado |

[V] No se usan esperas cortas en los tests nuevos. El test del latido ejecuta su callback mediante una señal explícita; restaura el espía en `finally`.

### Rojo previo y mutaciones

[V] Antes de implementar, `bun test tests/mandate.test.ts` dio **1 pass / 5 fail**: la retirada no cancelaba y faltaban las columnas. El caso de política original/hilo auxiliar ya pasaba: es una protección, no prueba de comportamiento nuevo.

[V] Los dos tests de PR se ejecutaron antes del cambio del conector y fallaron: inicialmente lo hacían por el uso incorrecto de Jira, antes de alcanzar el enlace. Tras resolverlo, el test de respuesta necesitó corregir su preparación: `retryChange` exige una activity fallida/bloqueada. Ahora usa validación → gate bloqueado → reintento, mediante comandos reales del Store.

[V] Los tests de fronteras 13/14 y del turno activo se añadieron después del primer cambio de Mandate; no alego un rojo previo de esos tests. En una copia temporal se retiraron tres arreglos y se ejecutó cada test clave, uno por vez:

| Arreglo retirado | Resultado |
|---|---|
| `Resident` anterior, sin Mandate | Frontera 13 falla: nunca llega al crash point |
| Prioridad de `admit` en la cola | Frontera 14 falla: aparece una publicación real en el runner falso |
| Bloque que registra/enlaza el hilo del PR | Frontera 15 falla: tras repetir, `changeOf(PR)` sigue `undefined` |

[V] Cada mutante terminó con código 1 y una aserción específica fallida. Logs: `/tmp/t43-mutations-jaa6d_xa/resident.log`, `order.log`, `pr.log`. No se usó `git stash` ni se mutó el worktree para esas pruebas.

## Comandos y resultados

[V] `bun run typecheck`: código 0 antes de cada commit. Primer intento: código 127 porque faltaba `tsc` en este worktree. Se creó el enlace local ignorado `node_modules → ../sw-factory/node_modules`, reutilizando las dependencias instaladas; no se instalaron ni añadieron dependencias.

[V] `bun test tests/costura-fronteras.test.ts tests/mandate.test.ts tests/admission-report.test.ts tests/admission-apply.test.ts tests/connectors-cli.test.ts`: **50 pass, 0 fail, 232 aserciones**, 9,97 s. Los dos fixtures de T13 fallaron inicialmente por el `INSERT` posicional y se corrigieron como se describe arriba.

[V] `git diff --check`: código 0.

[V] `bun test tests`: código 1; **1421 pass, 2 skip, 1 fail, 1 error**, 8061 aserciones, 1424 tests / 139 archivos, 324,02 s. Falló por timeout de 5000 ms `tests/pool-live.test.ts:189` (S4/M5), a 7687,91 ms. Después apareció `Cannot use a closed database` desde el turno que había sobrevivido al timeout. Log: `/tmp/t43-suite.log`.

[V] El caso S4/M5 aislado pasó en este worktree (900,41 ms) y en un clon local desechable del SHA exacto de la release `ff52f0b2f4a9e214327d431a949d9ac905958a71` (722,05 ms, código 0). Evidencia de este último: `/tmp/t43-release-m2emahtw/pool-live.log`. No reproduje el timeout en la release y no lo declaro defecto ajeno demostrado.

[V] `bun test tests --timeout 20000`: **código 0; 1422 pass, 2 skip, 0 fail**, 8063 aserciones, 1424 tests / 139 archivos, 286,54 s. S4/M5 pasó en 640,83 ms. Los omitidos son las dos pruebas contra claude/GitHub reales. No se cambió ningún test ni código entre las dos suites; solo se amplió el límite del ejecutor. Log: `/tmp/t43-suite-retry.log`.

## Límites, riesgos y desvíos

[V] No se tocó router, `assess`, contexto de seguimientos, readmisión, flags de CLI, `src/live/`, `src/sandbox/`, `src/store.ts` ni `src/pool.ts`. No hubo modelos reales, modo auto contra un repo real, push, PR remoto ni escrituras en GitHub. No se ejecutó verificación independiente: esta entrega es de implementación.

[V] El sondeo sigue viendo snapshots de etiquetas: quitar y reponer entre dos lecturas puede no observarse. El aborto del proceso sigue esperando el siguiente latido; el test demuestra ese mecanismo, no un aborto síncrono al recibir el evento.

[V] `stopsLost` conserva por compatibilidad la medición histórica de cierres de issue de T13. Esa medición no autoriza ni provoca una revocación.

[V] Los puntos de caída y las publicaciones se probaron con runners/backend falsos. No se hicieron afirmaciones sobre una escritura remota real ni sobre recuperación de un PR remoto ya cerrado/fusionado, que sigue la conducta existente del gateway.

[V] El MCP graph disponible correspondía al checkout principal, no a este worktree; `index_status` respondió ready pero sin generación verificable y `check_index_coverage` devolvió `coverage_unavailable`. No se usaron sus ausencias como evidencia. Se contrastaron las rutas con graft y lectura directa del worktree antes de editar.

[V] Desvíos: (1) se esperaba typecheck ejecutable; faltaba `tsc`, detectado por el implementador, causa de preparación local, resuelto reutilizando node_modules; (2) se esperaban fixtures T13 compatibles con el ALTER, fallaron sus INSERT posicionales, detectado por tests dirigidos y corregido sin cambiar aserciones; (3) se esperaba que S4/M5 acabara en 5000 ms, excedió el límite y dejó un turno accediendo a una base cerrada, detectado por la suite, causa temporal no establecida, evidencia `/tmp/t43-suite.log`; (4) un intento de comparar toda la suite mediante una copia sin metadatos Git produjo fallos MCP que no aparecen aquí: corrida inválida, descartada como evidencia de la release, log `/tmp/t43-baseline-suite.log`. Se sustituyó por clon local en el SHA exacto para el contraste aislado. Ninguno justifica ampliar el alcance de T43.

[V] Estado final: árbol de trabajo limpio en `feat/t43-mandate-pr`, dos commits por delante de la release. Informe guardado sin confirmar en el checkout principal, como pide el brief. Listo para la verificación independiente; no supone autorización de publicación.

## Correcciones tras verificación

[V] Encargo: `BRIEF-T43-ARREGLOS.md`; revisión: `verif-fable.md`. Se trabajó sobre `41a9fcf`, sin cambios de otra sesión en el worktree. Commits nuevos, sin push:

- `5c9acc3` — `fix(admisión): ordenar la revocación y cancelar estados recuperables`.
- `d0886dc` — `fix(conectores): limitar los hilos del PR al repositorio de origen`.
- `4fabb02` — `test(admisión): detectar huecos de caída y persistencia del trigger`.

[V] H2 aplica la decisión A del usuario recogida en el brief: **solo para Mandate**, terminal significa `completed`, `canceled` y `declined`. No se cambió la definición global del Store ni su política de reintentos. Las referencias de la entrega anterior describen su versión histórica; esta sección prevalece para el comportamiento corregido.

| Id | Commit | Test | ¿Falla sin el arreglo? |
|---|---|---|---|
| H1 | `5c9acc3` | `tests/mandate.test.ts:87@4fabb02`: E1, efecto antiguo sin etiqueta después de la admisión; conserva el change y permite una retirada posterior real | [V] Sí: quitando la comparación temporal, cancela indebidamente |
| H2 | `5c9acc3` | `tests/mandate.test.ts:102@4fabb02`: casos `blocked`, `failed`, `quarantined`, creados con comandos del Store; retirada cancela y `retryChange` lanza sin revivir | [V] Sí: restaurar los tres estados como terminales produce tres fallos |
| H4 | `5c9acc3` | `tests/mandate.test.ts:122@4fabb02`: sin `trigger_key`, historia con política antigua, admisión aplicada y decisión futura; conserva la etiqueta vigente y después revoca con el trigger correcto | [V] Sí: tanto al volver a elegir la primera decisión como al omitir el límite `created_at` |
| H5 | `d0886dc` | `tests/connectors-cli.test.ts:194@4fabb02` y `:202`: otro repo no añade hilo; el mismo repo admite diferencias de mayúsculas | [V] Sí: sin comparar repos, aparece el hilo del otro repo |
| H6 | `d0886dc` | `tests/connectors-cli.test.ts:169@4fabb02` y `:177`: sin origen no crea hilos; sin admisión no crea tablas `adm_*` | [V] Sí frente a M18 y M19 por separado. Son protecciones de comportamiento que ya existía; pasaban antes de los arreglos |
| H7 | `4fabb02` | `tests/costura-fronteras.test.ts:133@4fabb02`: captura estado durante la caída y lo afirma fuera del callback | [V] Sí frente a M17 (caída antes de marcar) y M11 (después del cierre). Ambos sobreviven con el test de `41a9fcf` y mueren con el test corregido |
| H8 | `4fabb02` | `tests/mandate.test.ts:141@4fabb02`: comprueba `trigger_key` inmediatamente después de admitir, sin revocar | [V] Sí frente a M12: guardar `null` ya no queda oculto por la recuperación histórica |
| H9 | `d0886dc` | `tests/connectors-cli.test.ts:208@4fabb02`: dry-run de origen GitHub no anuncia comentario Jira ni escribe | [V] Sí: al restaurar el filtro antiguo aparece el comentario incorrecto |
| H3 | Sin cambio, por encargo | Limitación documentada abajo | No se alteró ni se presenta como resuelto |

[V] Código corregido: `src/admission/resident.ts:122@4fabb02` recupera `created_at`; `:128` usa el conjunto terminal específico de Mandate; `:130` selecciona por trigger explícito o, en una base antigua, la última decisión `would_admit` con `decided_at <= created_at`; `:136` exige que el evento sea estrictamente posterior a la autorización. `src/connectors/cli.ts:142@4fabb02` filtra Jira también en dry-run; `:154` obtiene el primer hilo y compara su repo con `pr.repo` mediante `parseThread`, sin distinguir mayúsculas.

### Pruebas y mutaciones de los arreglos

[V] Rojo previo: los cinco casos nuevos de H1/H2/H4 fallaron antes del cambio (**6 pass / 5 fail**, `/tmp/t43-fixes-mandate-red.log`); los de H5 y H9 fallaron antes del cambio del conector (**11 pass / 2 fail**, `/tmp/t43-fixes-pr-red.log`). Los casos H6 y la comparación sin mayúsculas ya pasaban: no se presentan como rojos previos.

[V] `bun test tests/mandate.test.ts tests/costura-fronteras.test.ts tests/connectors-cli.test.ts`: **38 pass / 0 fail, 206 aserciones**, 7,54 s; log `/tmp/t43-fixes-targeted.log`. `bun run typecheck`: código 0 antes de cada uno de los tres commits. `git diff --check`: código 0.

[V] Todas las mutaciones se hicieron en un clon local desechable, sin tocar el worktree ni usar stash. **11 mutantes murieron por aserciones**: H1, H2, H4, H4 sin límite temporal, H5, M18, M19, M17, M11, M12 y H9. M17 y M11 también se corrieron con el test anterior, que los dejó pasar. Script: `/tmp/t43-fixes-mutate.py`; resultados y logs individuales: `/tmp/t43-fixes-mutations-qs164mk6/results.json` y ficheros vecinos. M11 sigue siendo equivalente en el resultado del rollback; el test corregido comprueba además la posición exacta exigida al punto de caída.

[V] `bun test tests`: **código 0; 1433 pass, 2 skip, 0 fail**, 8103 aserciones, 1435 tests / 139 archivos, 287,77 s. Se usó el timeout predeterminado, sin repetir ni ampliar el límite. Los omitidos siguen siendo los dos tests con claude/GitHub reales. Log completo: `/tmp/t43-fixes-suite.log`.

### Limitaciones que siguen abiertas

[V] **H3 se mantiene por instrucción expresa:** si hay un merge en curso, `Store.closeChange` rechaza cancelar; la transacción deshace la marca de revocación y el efecto agota sus intentos hasta quedar `dead`, con el aviso existente. Al terminar el merge no se reintenta automáticamente. Evidencia de implementación: `src/store.ts:1065@4fabb02`; reproducción de Fable: E8 en `verif-fable.md`. No repetí ese exploit ni modifiqué el tratamiento de conflictos.

[V] H10 no se cambió: la delimitación del texto humano del turno reanudado sigue fuera de alcance. Tampoco se tocaron `src/live/`, `src/sandbox/`, `src/store.ts`, `src/pool.ts`, router ni flags; no se ejecutaron agentes reales ni escrituras en GitHub. La comprobación independiente de estos tres commits queda para el verificador.

[V] El grafo seguía correspondiendo al checkout principal, sin generación verificable y con `coverage_unavailable` en las rutas pertinentes. Se usaron las trazas graft y lectura directa del worktree para estos arreglos, sin inferir ausencias del grafo.

[V] Estado de entrega: HEAD `4fabb02`, worktree limpio, tres commits nuevos y cinco por delante de la release. El informe queda sin confirmar en el checkout principal, según el flujo del brief. No se cambió `task.json` ni se publicó nada.

## Ronda final

[V] Encargo del dueño: N1, N2 y N3 de la sección «Segunda pasada» de `verif-fable.md`. Base de esta ronda: `4fabb02`; se comprobó el worktree limpio antes de editar. Tres commits locales nuevos, sin push ni trailer de coautoría:

| Id | Commit | Test y sensibilidad |
|---|---|---|
| N1 | `44ff715` — conservar grafía del repo en el hilo del PR | [V] `tests/connectors-cli.test.ts:202@d71ac98`: con origen `owner/project` y `--repo Owner/Project`, encuentra el hilo `github:owner/project#3`, no el de grafía alternativa, y comprueba también `adm_threads.source`. Falla antes del arreglo y al restaurar la grafía de `pr.repo` en la copia temporal |
| N2 | `b0b45fe` — proteger completed y declined | [V] `tests/mandate.test.ts:47@d71ac98`: casos independientes `completed`, `canceled`, `declined`; después de retirar la etiqueta conservan el estado, no marcan revocación ni generan cierre. Pasaban antes porque el código ya era correcto. Quitando `completed` o `declined` del conjunto terminal, el caso correspondiente falla |
| N3 | `d71ac98` — compartir terminales con el informe | [V] `tests/admission-report.test.ts:277@d71ac98`: `would_revoke` para `blocked`, `failed` y `quarantined` aparece en `stopsLost`. Los tres casos fallan antes y al restaurar el predicado global del Store en el informe |

[V] N1 forma tanto el id del hilo como su `source` con `parseThread(first).repo`, manteniendo la comparación del repositorio sin distinguir mayúsculas (`src/connectors/cli.ts:155@d71ac98`). No añade alias ni modifica los vínculos ya guardados.

[V] N3 tiene una sola definición del conjunto específico de Mandate en `src/admission/mandate.ts:4@d71ac98`, mediante `isTerminalForMandate`. La usan el residente (`src/admission/resident.ts:129@d71ac98`) y el informe (`src/admission/report.ts:51@d71ac98`). `completed`, `canceled` y `declined` son terminales para ambos; los estados recuperables siguen siendo revocables y medibles. Se conserva la regla histórica que cuenta una retirada observada antes de que el change terminase. La definición global del Store permanece independiente y no se cambió.

[V] El test anterior de exclusión del informe ahora excluye solo los tres terminales de Mandate (`tests/admission-report.test.ts:196@d71ac98`); los tres estados recuperables se comprueban expresamente en los nuevos casos N3. Los estados finales del test N2 se siembran directamente para aislar la guarda de revocación de las transiciones generales del Store.

### Validación de esta ronda

[V] Antes del código: **44 pass, 4 fail**, 188 aserciones. Fallaron el test ajustado N1 y los tres N3; N2 ya pasaba, como corresponde a un hueco de cobertura. Log: `/tmp/t43-final-red.log`.

[V] `bun test tests/mandate.test.ts tests/admission-report.test.ts tests/connectors-cli.test.ts`: **48 pass, 0 fail**, 190 aserciones, 6,70 s. Log: `/tmp/t43-final-targeted.log`. `bun run typecheck`: código 0 antes de cada commit. `git diff --check`: código 0.

[V] En un clon local desechable, **4 mutantes muertos por aserciones, código 1**: N1 (restaurar la grafía de `pr.repo`), N2-completed, N2-declined y N3 (volver al predicado del Store en el informe). Script: `/tmp/t43-final-mutate.py`; resultados y logs individuales: `/tmp/t43-final-mutations-g_b875yg/results.json` y ficheros vecinos. No se mutó el worktree ni se usó stash.

[V] `bun test tests`: **código 0; 1438 pass, 2 skip, 0 fail**, 8115 aserciones, 1440 tests / 139 archivos, 288,45 s. Timeout predeterminado, una ejecución. Los dos omitidos corresponden a claude/GitHub reales. Log completo: `/tmp/t43-final-suite.log`.

[V] Sin cambios en router, pool, Store, backends vivos o sandbox, sin agente/GitHub reales, sin publicación ni actualización de `task.json`. Se mantienen H3 y H10 según el encargo previo. La lectura y trazas se contrastaron directamente en el worktree: el grafo del checkout principal sigue sin cobertura/generación verificables para estas rutas.

[V] Entrega final de esta ronda: HEAD `d71ac98`, árbol limpio y tres commits nuevos sobre `4fabb02`. Informe actualizado sin confirmar en el checkout principal, para la siguiente revisión. Sin push.

<!-- FIN -->
