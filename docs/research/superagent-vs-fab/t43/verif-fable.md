# T43 — verificación independiente de Mandate y enlace del PR

Verificador: Fable 5.2, goldfish, solo lectura. Fecha: 2026-11-18.
Rama `feat/t43-mandate-pr` en `/home/orlando/Desktop/factory/sw-factory-t43`, HEAD `41a9fcf`, base `ff52f0b` (`origin/release/0.1.0-rc.12`). El SHA no cambió entre el inicio y el final, y el worktree quedó limpio **[V]**.

Marcas: **[V]** ejecutado o leído en la línea citada; **[I]** inferido.

## Veredicto

**Listo con cambios.** No hay hallazgos altos. Las decisiones D, E, F y G se cumplen, la revocación es atómica y el modo observe no cancela nada. Antes del PR hay que:

1. Arreglar H1: un evento atrasado sin etiqueta revoca un change admitido después. Es una guarda de una línea más su test.
2. Decidir H2 (dueño): un change `blocked`, `failed` o `quarantined` cuenta como terminal, así que retirarle la etiqueta no deja rastro y `fab retry` lo revive sin autorización.
3. Añadir el test que falta para «un PR de un change sin hilo de origen no se une a nada» (H6). El código lo hace bien; ningún test lo protege.

El resto (H3-H5, H7-H10) puede ir en el mismo commit de arreglos o quedar como followups.

## Qué se cumple

| Punto del brief | Resultado | Evidencia |
|---|---|---|
| D: cerrar no revoca; retirar sí, si el change no es terminal | Cumple **[V]** | `tests/mandate.test.ts:21`; mutación M9 muere |
| G: un hilo revocado no se readmite | Cumple **[V]** | `resident.ts:126`; M2 muere; decisión `thread-revoked` |
| E: hace falta la etiqueta para admitir | Cumple **[V]** | `mandate()` nunca admite; el gate no cambia (diff) |
| F: ningún comentario crea un turno | Cumple **[V]** | Exploits E11 y E13: comentario triage tras revocar → `no-open-question`, activities sin cambios |
| Atomicidad (frontera 13) | Cumple **[V]** | M10 (sin transacción) muere. Con la caída movida después de `closeChange` (M11) el rollback también deshace ambos |
| Idempotencia al reejecutar `admit` | Cumple **[V]** | Un solo evento `change canceled` tras tres ciclos (`mandate.test.ts:34`) |
| Nunca cancela un change terminal | Cumple **[V]** | Exploit E3 con `completed`, `failed`, `canceled`, `declined`, `blocked` y `quarantined`: estado intacto, `revoked_at` nulo, 0 eventos de cancelación |
| Prioridad de `admit` (frontera 14) | Sin daño **[V]/[I]** | Ver «Prioridad de `admit`» |
| PR sin hilo de origen no se une | Cumple **[V]** | Exploit E5: 0 filas en `adm_thread_changes` y `adm_threads` |
| Respuesta en el PR sin rol triage | Rechazada **[V]** | `costura-fronteras.test.ts:215`: el comentario de `outsider` (rol `read`) es anterior y no responde |
| Texto del PR al prompt | No entra **[V]** | `pollIssues` descarta los PR (`src/admission/github.ts:30`) y el trigger no guarda texto (`resident.ts:72`). Solo entra el comentario de quien tiene rol triage, por el camino que ya existía (ver H10) |
| Observe no cancela | Cumple **[V]** | M6 muere. Exploit E10: un ciclo observe con y sin retirada escribe lo mismo salvo la decisión `would_revoke` |
| `stopsLost` de T13 | No se rompe **[V]** | `tests/admission-report.test.ts` pasa; M15 muere |
| `scope` no se amplía; comentarios propios | Cumple **[V]** | El diff no escribe `adm_thread_signals.scope` ni toca `gate.ts` ni el filtro `self-authored` |
| Alcance («no tocar») | Cumple **[V]** | `git diff --stat`: 6 ficheros de `src`, ninguno en router, `src/live/`, `src/sandbox/`, `store.ts` ni `pool.ts` |

## Hallazgos

| Id | Sev. | Ruta | Problema y evidencia | Arreglo propuesto |
|---|---|---|---|---|
| H1 | Media | `src/admission/resident.ts:134` | **Un evento atrasado revoca.** `mandate()` no compara la fecha del evento con la del trigger que admitió. Si el efecto `admit` de un trigger antiguo (issue aún sin etiqueta) se ejecuta después de la admisión, cancela el change con la etiqueta puesta. Pasa cuando ese efecto falló y esperaba en backoff, o cuando alguien revive un efecto `dead` (lo hace el propio test 13). **[V]** Exploit E1: trigger `@01-06` sin etiqueta, admisión `@01-07`; resultado `change=canceled`, decisión `mandate-revoked` sobre el trigger viejo. Por G no se puede readmitir. | Revocar solo si `event.updatedAt` es posterior al del trigger de admisión (`origin.trigger_key`). Test con el escenario de E1. |
| H2 | Media, **[DECIDIR]** | `src/admission/resident.ts:128`, `src/store.ts:44-51` | **Un change bloqueado revive sin autorización.** `isTerminalChange` incluye `blocked`, `failed` y `quarantined`, que `retryChange` reabre (`store.ts:1083`). Retirar la etiqueta en ese estado no marca nada y consume el evento. **[V]** Exploit E2: bloqueado → etiqueta retirada → `revoked_at` nulo → `retryChange` → `pending`, y sigue vivo dos ciclos después. Solo lo revoca otro evento del issue. | Ver «Decisión para el dueño». |
| H3 | Baja | `src/admission/resident.ts:139` | **Con un merge en curso la revocación se pierde.** `closeChange` lanza `conflict` (`store.ts:1065`); el efecto agota 5 intentos y queda `dead`. **[V]** Exploit E8: `status=dead`, `revoked_at` nulo; al acabar el merge nada reintenta. Queda el aviso de T29. | Aceptable si se documenta: un merge lo lanza una persona. Si no, tratar `conflict` como reintento sin tope. |
| H4 | Baja | `src/admission/resident.ts:130-133` | **Base anterior a T43 con otra etiqueta en su historia.** Sin `trigger_key`, se toma la *primera* decisión `would_admit` del hilo, que puede ser de `observe` con una etiqueta antigua. **[V]** Exploit E4: el change se cancela con la etiqueta vigente puesta. Solo afecta a bases migradas cuya política cambió de etiqueta. | Tomar la última decisión `would_admit` con `decided_at <= adm_thread_signals.created_at`. |
| H5 | Baja | `src/connectors/cli.ts:155` | **El PR se une aunque esté en otro repo que el hilo de origen.** **[V]** Exploit E6: `--repo otro/repo` → hilos `github:owner/project#7` y `github:otro/repo#12`. Un residente sobre ese repo aceptaría respuestas con el rol de *ese* repo. | Unir solo si `pr.repo` coincide con el repo del primer hilo (`parseThread`). |
| H6 | Baja (test) | `src/connectors/cli.ts:152,154` | **Sin test para «PR sin hilo de origen».** M18 (quitar `threadsOf(...).length`) y M19 (quitar `hasAdmission`) sobreviven. | Un test por cada condición; E5 sirve de base. |
| H7 | Baja (test) | `tests/costura-fronteras.test.ts:137-144` | **Las aserciones dentro del callback de caída no afirman nada.** Un `expect` que falla ahí lanza dentro del efecto y la cola lo traga como fallo del efecto. M17 (caída antes del `UPDATE`) y M11 (después de `closeChange`) sobreviven. Las aserciones posteriores a la caída sí son reales. | Guardar lo observado en variables y afirmarlo fuera del callback. |
| H8 | Baja (test) | `src/admission/apply.ts:30` | **Guardar `trigger_key` al admitir no tiene test.** M12 sobrevive: la recuperación de `resident.ts:130` lo tapa. Es la línea que evita H4 en bases nuevas. | Afirmar `trigger_key` justo después de admitir, antes de revocar. |
| H9 | Baja | `src/connectors/cli.ts:142` | El `--dry-run` aún anuncia un comentario en la «HU» para un change de origen GitHub (`linked?.source`, sin el filtro `system === 'jira'` de las líneas 147 y 160) **[V, leído]**. | Mismo filtro. |
| H10 | Info, previo a T43 | `src/admission/recovery.ts:35` | La respuesta humana es el prompt del turno reanudado, sin delimitar. No lo cambia T43, pero el enlace del PR añade un hilo más por el que entra. La autoridad es el rol triage consultado en la API. | Tarea aparte si se quiere delimitar. |

Observaciones sin hallazgo:

- En observe puro no hay `adm_thread_signals`, así que `would_revoke` no aparece nunca (**[V]** E9). Solo sale en una base que antes pasó por auto. Es el límite ya anotado en `AGENTS.md` para T13.
- Si el hilo del PR ya está unido a otro change, `fab pr` devuelve 1 después de guardar el PR y no toca el otro vínculo (**[V]** E7). Falla cerrado.
- `stopsLost` sigue contando un cierre con etiqueta como parada perdida, aunque por D ya no lo es. Es la medición histórica de T13; el implementador lo dice.
- Un hilo con `scope=propose` no tiene change unido y `mandate()` lo ignora **[I]**. Queda fuera del encargo.

## Decisión para el dueño (H2)

| Opción | Qué se hace | A favor | En contra |
|---|---|---|---|
| **A (recomendada)** | Para Mandate, terminal es solo `completed`, `canceled` y `declined`. Un change `blocked`, `failed` o `quarantined` sin etiqueta se revoca y se cancela. | Cierra el hueco sin tocar el Store. `closeChange('canceled')` no valida el estado de origen (`store.ts:1062-1076`). | Cambia la letra de D («no terminal») y cancela un change que una persona podría querer inspeccionar. |
| B | Marcar `revoked_at` sin cancelar, y que `fab retry` rechace un change de un hilo revocado. | No cancela nada que esté parado. | El Store tendría que leer tablas `adm_*`, o la CLI añadir una comprobación: más superficie. |
| C | Dejarlo y documentarlo: `fab retry` es una orden local del dueño. | Cero código. | Quien retira la etiqueta cree haber parado el trabajo, y no hay registro de que lo pidió. |

## Prioridad de `admit` (frontera 14)

- Solo cambia la posición de `admit` frente a `inbound` y `reply`; el orden por `id` dentro de cada grupo se conserva (`effects.ts:97`) **[V]**.
- No deja nada sin atender: un `admit` que falla pasa a backoff o a `dead`, y deja de estar vencido. El resto se despacha en el mismo `dispatch()` **[V]** (E8: tras 5 intentos el efecto muere y el ciclo termina; la suite completa pasa).
- Efecto visible: si una respuesta triage y la retirada llegan en el mismo ciclo, gana la retirada y la respuesta queda `no-open-question` (**[V]** E11). Falla hacia cerrado.
- M13 (quitar la prioridad) muere por el test 14.
- No cubre una pregunta publicada en un ciclo anterior a leer la retirada **[I]**; es inherente al sondeo.

## Mutaciones

Copia temporal con `git init`; `diff -rq` contra el worktree limpio al terminar **[V]**. Tests: `mandate`, `costura-fronteras`, `admission-report`, `admission-effects`, `connectors-cli`, `admission-links`, `connectors-intake`. En la copia falla siempre `top-level CLI dispatch exposes connector help` (artefacto de la copia; en el worktree pasa) y no se cuenta.

| Id | Mutación | Resultado |
|---|---|---|
| M1 | Sin la comprobación de change terminal | Muere (1) |
| M2 | Sin la guarda `revoked_at` | Muere (1), solo por la razón `thread-revoked` del informe |
| M3 | Sin el `UPDATE` que marca la revocación | Muere (4) |
| M4 | Sin `closeChange` | Muere (6) |
| M5 | Sin `reapQuestions` | Muere (1, test 14) |
| M6 | Observe también cancela | Muere (1) |
| M7 | Etiqueta de la política actual en vez de la de admisión | Muere (1) |
| M8 | Comparación de etiqueta sensible a mayúsculas | Muere (1) |
| M9 | Cerrar el issue revoca | Muere (1) |
| M10 | Sin transacción | Muere (1, test 13) |
| M11 | Caída después de `closeChange` | **Sobrevive**: equivalente en resultado (el rollback deshace ambos), pero muestra H7 |
| M12 | No guardar `trigger_key` al admitir | **Sobrevive**: hueco de test (H8) |
| M13 | Sin prioridad de `admit` | Muere (1, test 14) |
| M14 | Sin `ALTER` | Muere (17) |
| M15 | Informe sin `would_revoke` | Muere (1) |
| M16 | Observe no registra `would_revoke` | Muere (1) |
| M17 | Caída antes del `UPDATE` | **Sobrevive**: hueco de test (H7) |
| M18 | PR: sin exigir hilo de origen | **Sobrevive**: hueco de test (H6) |
| M19 | PR: sin `hasAdmission` | **Sobrevive**: hueco de test (H6) |
| M20 | PR: sin `link` | Muere (2) |
| M21 | PR: sin registrar el hilo en `adm_threads` | Muere (2) |
| M22 | PR: credenciales Jira para cualquier origen | Muere (2) |
| M23 | PR: comentario Jira para cualquier origen | Muere (2) |
| M24 | Caída después de `setPullRequest` | **Sobrevive**: equivalente (repetir `fab pr` repara igual) |
| M25 | Sin la comprobación «el PR corresponde al change» | **Sobrevive** en estos tests; es código anterior a T43 y no busqué su test en otros ficheros |

## Timeout de S4/M5 (`tests/pool-live.test.ts:189`)

**No lo provoca T43, y no lo reproduje.**

- T43 no toca `src/pool.ts`, `src/live/`, `tests/pool-live.test.ts` ni `tests/helpers/` **[V]** (diff vacío).
- Suite completa en el worktree: 0 fallos **[V]**.
- El test a solas, 5 veces: 714-726 ms en la rama y 700-726 ms en un export de la release **[V]**.
- Con 24 ejecuciones en paralelo: 1,83-2,14 s en la rama y 1,82-2,06 s en la release, sin fallos **[V]**. Mismo tiempo y misma sensibilidad a la carga en ambas.
- Conclusión **[I]**: inestabilidad previa por carga de la máquina, de la familia de T45. No pude demostrarlo con un fallo en la release: en 58 ejecuciones no hubo ninguno.

## Contraste con el informe del implementador

Lo leí después de correr exploits y mutaciones, antes de redactar.

- **Coincide:** el alcance, los ficheros tocados, el cambio de Jira como requisito del camino, el arreglo de los dos fixtures de T13, el límite del sondeo por snapshots y que S4/M5 pasa a solas en rama y release.
- **No reproduje:** su fallo de S4/M5 en la suite completa (1 fail); la mía dio 1422 pass, 0 fail.
- **No se sostiene del todo:** «frontera 13: caída dentro de transacción» está bien probada por lo que pasa *después* de la caída, pero las cuatro aserciones dentro del callback no afirman nada (H7).
- **No mencionó:** H1 (evento atrasado), H2 (`blocked` cuenta como terminal), H3 (merge en curso), H4 (la «primera» decisión puede ser de otra etiqueta), H5 (PR en otro repo) y la falta de test del caso «sin hilo de origen».

## Comandos

| Comando | Resultado |
|---|---|
| `git fetch`; `git merge-base HEAD origin/release/0.1.0-rc.12` | `ff52f0b`, igual que la release |
| `bun run typecheck` (worktree) | Código 0 |
| `bun test tests` (worktree) | **1422 pass, 2 skip, 0 fail**, 1424 tests, 139 ficheros, 311,65 s; HEAD `41a9fcf` antes y después |
| `ROOT=<worktree> bun test <scratchpad>/exploits/t43-exploits.test.ts` | 18 escenarios. E1, E2, E4 y E8 confirman H1-H4; E6 confirma H5; E3, E5, E7, E9-E11 y E13 salen como se esperaba. El único `fail` (E10) era de mi script: `outbox: false` deja un `reply` sin handler, igual con y sin retirada de etiqueta |
| `mutar.sh` × 25 en la copia | Tabla de mutaciones |
| S4/M5 × 5 a solas y × 24 en paralelo, rama y export de la release | Sin fallos; tiempos arriba |

Los scripts están en `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t43/7d1e9ad2-457c-4357-a5ca-70d718180b72/scratchpad/exploits/`. Es un directorio temporal: si hacen falta para la segunda pasada, hay que copiarlos antes de que se limpie.

## Lo que no revisé

- Ninguna prueba con `gh` real ni con un agente real. T43 no toca `src/live/` ni `src/sandbox/`.
- El residente y el pool como procesos separados sobre la misma base (contención real de SQLite). H1 depende de un fallo transitorio de ese tipo y lo simulé plantando el efecto.
- El aborto del turno vivo más allá del test del latido.
- La salida de texto de `fab resident report` con `would_revoke` (solo `buildReport`).
- `writeManifest` se ejecuta dentro de `closeChange` (`store.ts:575`): si la transacción de `mandate()` fallara después, el fichero no se deshace **[I]**. No lo probé.
- El hilo `scope=propose`: mi exploit no llegó a crear ese estado; lo dicho es por lectura.
- `task.json`, techdocs y el resto de la cola.

---

# Segunda pasada

Fecha: 2026-11-18. Commits revisados: `5c9acc3`, `d0886dc` y `4fabb02` sobre `41a9fcf`. HEAD `4fabb02`, sin moverse durante la pasada; worktree limpio **[V]**. La primera pasada queda arriba sin cambios.

## Veredicto

**Listo para PR.** H1, H2 (decisión A) y H4-H9 quedan cerrados, cada uno con un test que muere al quitar el arreglo. La suite completa pasa y no hay regresiones. Quedan tres hallazgos nuevos, todos bajos; N1 y N2 son de una línea y conviene meterlos antes de fusionar, pero no bloquean.

## Estado de los hallazgos anteriores

| Id | Estado | Evidencia |
|---|---|---|
| H1 | **Cerrado** | `resident.ts:136`: el evento debe ser posterior al trigger de admisión. **[V]** Exploit E1 sin tocar: `change=pending`, decisión `thread-already-admitted`. Mutación P1 muere por `mandate.test.ts:87` |
| H2 | **Cerrado** (opción A) | `resident.ts:128`: para Mandate, terminal es `completed`, `canceled` y `declined`. **[V]** Exploit E3: `blocked`, `failed` y `quarantined` pasan a `canceled` con `revoked_at`; los otros tres siguen intactos. Exploit E2: `retryChange` lanza. P4, P5 y P6 mueren |
| H3 | Abierto, por encargo | **[V]** Exploit E8 da lo mismo que antes: efecto `dead`, `revoked_at` nulo. El implementador lo documenta |
| H4 | **Cerrado** | `resident.ts:130-133`: última decisión `would_admit` con `decided_at <= created_at`. **[V]** Exploit E4: `change=pending`. P10 y P11 mueren |
| H5 | **Cerrado**, con un resto (N1) | `cli.ts:154-155`. **[V]** Exploit E6: solo queda el hilo de origen. P12 y P13 mueren |
| H6 | **Cerrado** | `connectors-cli.test.ts:169,177`. P14 y P15 mueren |
| H7 | **Cerrado** | `costura-fronteras.test.ts:137-149`: lo observado se afirma fuera del callback. P17 (antes M17) y P18 (antes M11) mueren |
| H8 | **Cerrado** | `mandate.test.ts:141`. P19 (antes M12) muere |
| H9 | **Cerrado** | `cli.ts:142`. P16 muere |
| H10 | Sin cambio (previo a T43, tarea aparte) | — |

## Hallazgos nuevos

| Id | Sev. | Ruta | Problema y evidencia | Arreglo propuesto |
|---|---|---|---|---|
| N1 | Baja | `src/connectors/cli.ts:156` | **El hilo del PR se guarda con la grafía de `pr.repo`, no con la del hilo de origen.** El repo se compara sin distinguir mayúsculas, pero el id es `github:${pr.repo}#n`. Con `--repo Owner/Project` y origen `owner/project` queda `github:Owner/Project#12` (**[V]**, script N1, y el test `connectors-cli.test.ts:202` lo fija así). El residente forma el hilo con su propia grafía (`resident.ts:186`) y `changeOf` compara exacto (`links.ts:19`), así que una respuesta en ese PR no encontraría el change **[I]**: mi script no llegó a abrir la pregunta, solo demuestra los ids distintos. Falla hacia cerrado. | Formar el id con `parseThread(first).repo` y ajustar la aserción del test. |
| N2 | Baja (test) | `src/admission/resident.ts:128` | **`completed` y `declined` no tienen test en la lista propia de Mandate.** P7 y P8 (quitar cada uno de la lista) sobreviven; solo `canceled` está cubierto (P9 muere). Antes lo protegía `isTerminalChange` del Store; ahora es una lista escrita a mano, y quitar `completed` cancelaría un change terminado. El código actual es correcto (**[V]** E3). | Extender `mandate.test.ts:47` a los tres estados. |
| N3 | Baja | `src/admission/report.ts:50` | **En observe, `stopsLost` no cuenta lo que auto ya revocaría.** El informe sigue usando `isTerminalChange`. **[V]** Script N3: change `blocked`, etiqueta retirada en observe → hay decisión `would_revoke` pero `stopsLost` está vacío. Solo afecta a la medición. | Usar en el informe el mismo conjunto que `mandate()`, o dejarlo anotado como límite de la medición. |

Observación sin hallazgo: si la etiqueta se retira y se repone, y el efecto de la retirada llega tarde, el change se revoca con la etiqueta puesta (**[V]** script N4). Es coherente con G: la retirada ocurrió, y procesada en orden daría el mismo resultado.

## Mutaciones de la segunda pasada

Copia temporal nueva; `diff -rq` contra el worktree limpio al terminar **[V]**. Tests: `mandate`, `costura-fronteras`, `connectors-cli`, `admission-report`. El fallo `top-level CLI dispatch…` es el artefacto de la copia ya descrito y no se cuenta.

| Id | Mutación | Resultado |
|---|---|---|
| P1 | Sin la guarda del evento atrasado | Muere |
| P2 | Guarda con `<` en vez de `<=` | **Sobrevive**: equivalente (con la misma fecha es el mismo trigger, que trae la etiqueta) |
| P3 | Guarda invertida | Muere (12) |
| P4-P6 | `blocked`, `failed` o `quarantined` de nuevo terminales | Mueren, una cada una |
| P7 | `completed` fuera de la lista terminal | **Sobrevive**: hueco de test (N2) |
| P8 | `declined` fuera de la lista terminal | **Sobrevive**: hueco de test (N2) |
| P9 | `canceled` fuera de la lista terminal | Muere |
| P10 | Origen: primera decisión en vez de la última | Muere |
| P11 | Origen: sin el tope `created_at` | Muere |
| P12 | PR: sin comparar el repo | Muere |
| P13 | PR: comparación de repo sensible a mayúsculas | Muere |
| P14 | PR: sin exigir hilo de origen | Muere (2) |
| P15 | PR: sin `hasAdmission` | Muere |
| P16 | Dry-run: comentario para cualquier origen | Muere |
| P17 | Caída antes del `UPDATE` | Muere |
| P18 | Caída después de `closeChange` | Muere |
| P19 | No guardar `trigger_key` al admitir | Muere |

## Contraste con «Correcciones tras verificación»

- **Coincide:** la suite (1433 pass, 2 skip, 0 fail), el typecheck, los ficheros tocados, que H3 y H10 siguen abiertos por encargo y que cada arreglo tiene un mutante que muere. Reproduje los 11 mutantes que cita.
- **No mencionó:** N1 (el test nuevo de mayúsculas fija la grafía equivocada), N2 (la lista propia pierde la cobertura de `completed` y `declined`) y N3.

## Comandos

| Comando | Resultado |
|---|---|
| `bun run typecheck` (worktree) | Código 0 |
| `bun test tests` (worktree) | **1433 pass, 2 skip, 0 fail**, 1435 tests, 139 ficheros, 294,34 s; HEAD `4fabb02` antes y después |
| `ROOT=<worktree> bun test <scratchpad>/exploits/t43-exploits.test.ts` (sin cambios) | E1, E2, E3 (`blocked`, `failed`, `quarantined`), E4 y E6 dan ahora el resultado corregido; sus 6 `fail` son las aserciones del comportamiento antiguo. E8 igual que antes (H3) |
| `ROOT=<worktree> bun test <scratchpad>/exploits/t43-pasada2.test.ts` | N1, N3 y N4 |
| `mutar.sh` × 19 en la copia nueva | Tabla de arriba |

## Lo que no revisé en esta pasada

- Lo mismo que en la primera: sin `gh` ni agente real, sin residente y pool en procesos separados.
- La consecuencia de N1 de punta a punta (respuesta perdida): es por lectura.
- No repetí la medición de S4/M5; en esta suite completa no falló.
- `BRIEF-T43-ARREGLOS.md` no lo leí: verifiqué contra los hallazgos y la decisión A que me pasaron.

<!-- FIN -->
