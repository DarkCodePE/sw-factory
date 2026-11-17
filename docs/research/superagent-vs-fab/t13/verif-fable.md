# T13-a y T13-b · verificación (Fable 5.2)

Fecha: 2026-11-13. Rama `feat/t13-router` en `/home/orlando/Desktop/factory/sw-factory-t13`, commits `0729e40` y `4b5ec6d` sobre `origin/release/0.1.0-rc.12`. Solo lectura: no edité el worktree (sigue limpio). Las mutaciones y sondas corrieron en una copia temporal de `HEAD`.

Marcas: **[V]** verificado ejecutando o leyendo la línea citada; **[I]** inferido.

## Veredicto

**Listo con cambios.** La implementación cumple §4 al pie de la letra y los seis tests nuevos fallan sin el cambio. No hay ningún bloqueo de corrección. Antes del PR pediría dos cambios pequeños (H3 y H4) y que el PR avise de H1, que es un defecto de la definición de §4 y no del código: tal como está definida, `stopsLost` va a marcar el cierre normal de un issue como «parada perdida».

## Qué comprobé

| Punto del brief | Resultado |
|---|---|
| 1. Definiciones | **[V]** Las tres cumplen §4: orden `decided_at, trigger_key` (`src/admission/report.ts:19`, `:34`), una fila por hilo con la más antigua que cumple (`report.ts:45-50`), `admittedAt` es el menor `decided_at` con `would_admit = 1` (`report.ts:27-30`), y la etiqueta se compara sin mayúsculas con la política de la propia fila (`report.ts:46-47`). |
| 2. Regresión | **[V]** No se pierden decisiones en una base real: la clave foránea está activa (`src/store.ts:284`), nada borra `adm_triggers`, y `admit` lanza si falta el trigger (`src/admission/resident.ts:86`). Los comentarios no tienen fila en `adm_decisions`, así que no se mezclan. Filas raras: ver H4. |
| 2. Qué escribe `resident.ts` | **[V]** Issue: `{repo, number, url, state, updatedAt, author, authorAssociation, labels}` (`resident.ts:74`). Comentario: `{kind:'comment', repo, number, commentId, url, author, authorType, authorAssociation, createdAt, updatedAt}`, sin `labels` ni `state` (`resident.ts:159`). La forma del evento de issue es la misma desde el primer commit de la admisión (`ff1040c`). |
| 3. Texto no confiable | **[V]** El cuerpo queda fuera: `buildReport` no consulta `adm_comments`. **[V]** `formatReport` no filtra nada: ver H5. `--json` sí escapa los caracteres de control. |
| 4. T13-b | **[V]** `report` y `report --json` sobre una base nueva no crean tablas. Los demás llamadores de `new AdmissionDb` están protegidos por `hasAdmission` o por `--live` (`src/cli.ts:137`, `:258`, `:375`; `src/pool.ts:131`, `:261`, `:470`; `src/tui.ts:221`). Excepciones: H2 y H6. |
| 5. Tests | **[V]** Con `report.ts` y `cli.ts` de la base: 5 pasan, 6 fallan (los seis nuevos). De 26 mutaciones, 21 mueren. Las que sobreviven: ver H3. |
| 6. Alcance | **[V]** El diff toca solo `src/admission/cli.ts`, `src/admission/report.ts` y `tests/admission-report.test.ts`. Nada de la lista «no tocar». Commits en español y sin `Co-Authored-By`. `bun run typecheck` sale con 0; el archivo de tests da 11 pass. |

## Hallazgos

| Id | Severidad | Ruta:línea | Problema | Escenario que falla | Arreglo propuesto |
|---|---|---|---|---|---|
| H1 | Media (definición de §4, no del código) | `src/admission/report.ts:45-50`; origen en `src/admission/resident.ts:88-91` | `stopsLost` no mira si el change sigue vivo, y en `observe` nunca puede dispararse. | **[V, leído]** En `auto`, la fab termina el change y el issue se cierra (por ejemplo, al fusionar el PR). Ese trigger sale como `thread-already-admitted` con `state = 'closed'` y cuenta como parada perdida. El umbral de §1.3 es «al menos un caso», así que el primer change terminado lo cumpliría. **[V, leído]** En `observe` no hay vínculos (`resident.ts:113`), `changeOf` devuelve vacío y la razón nunca es `thread-already-admitted`: la sección saldrá siempre vacía en la prueba `observe` de T11. | Decisión del humano. Lo mínimo: decirlo en el PR y rotular la sección como «candidatas». Lo completo: añadir a cada fila el estado del change (lectura de `adm_thread_changes` más el change), lo que amplía §4. |
| H2 | Baja | `src/admission/cli.ts:17`; `src/admission/db.ts:79` | `hasAdmission` mira solo `adm_thread_changes`, tabla que llegó un commit después de las primeras `adm_*`. | **[V, ejecutado]** Base con `adm_triggers` y `adm_decisions` pero sin `adm_thread_changes`: `report` imprime «el residente nunca se ha ejecutado en esta base» y devuelve 0, con una decisión guardada. Antes del cambio la mostraba. **[V]** Ninguna etiqueta de versión cae entre `ff1040c` y `ef1454f`, así que solo afecta a bases de desarrollo de esos días. | En la rama `report`, comprobar cualquier tabla `adm_*` en vez de usar `hasAdmission`. O dejarlo y anotarlo. |
| H3 | Baja (test) | `tests/admission-report.test.ts:125-136` | Ningún test cubre el caso real de parada: una fila `thread-already-admitted` que no cumple, seguida de otra del mismo hilo que sí. | **[V, mutación]** Si el código mira solo la primera fila `thread-already-admitted` de cada hilo, los 11 tests pasan. Ese es el orden habitual: una actualización inocua con la etiqueta puesta y, después, la etiqueta retirada. | Añadir al test de `:125` un hilo con una primera fila abierta y etiquetada y una segunda sin etiqueta, y esperar la segunda. |
| H4 | Baja | `src/admission/report.ts:46-47` | Una fila mal formada tumba el informe entero, incluidas las secciones que antes funcionaban. | **[V, ejecutado]** Decisión `thread-already-admitted` con política sin `triggerLabel` y evento con alguna etiqueta: `TypeError` en `policy.triggerLabel.toLowerCase`. Mismo motivo con evento sin `labels`: `TypeError` en `e.labels.some`. **[V]** El residente nunca escribe filas así (`resident.ts:74`, `:119`, también en `ff1040c`); haría falta una edición manual de la base. Los eventos sin `state` o sin `authorAssociation` no rompen nada: se quedan fuera. | `(e.labels ?? [])` y `policy.triggerLabel?.toLowerCase()`. Dos expresiones. |
| H5 | Baja | `src/admission/report.ts:92`, `:95`, `:98` | `formatReport` imprime `url`, `author` y `thread` sin quitar caracteres de control. | **[V, ejecutado]** Con `\x1b[2J` y `\n` en `url` o `author` sembrados en `adm_triggers`, el texto contiene el escape y una línea falsa. **[I]** No es explotable hoy: los valores llegan de la API de GitHub por `gh`, que no admite esos caracteres en logins ni URLs, pero el código solo comprueba que sean cadenas (`src/admission/github.ts:32-34`, `:105-107`). Las líneas anteriores del informe (`lastError`, `report.ts:89`) ya tenían el mismo patrón. `labels` no se imprime. | Opcional: pasar cada línea por un `replace` de caracteres de control. No lo exigiría para este PR. |
| H6 | Baja (previo, fuera de T13-b) | `src/admission/resident.ts:49` | `fab resident --mode off` crea el esquema aunque no consulta nada. | **[V, ejecutado]** Tras `--repo o/r --mode off` sobre una base nueva, `hasAdmission` da verdadero y el pool abrirá la admisión. **[I]** Lo mismo ocurriría con `--mode auto` sin `--self` y con un workstream válido: el constructor crea el esquema (`:49`) antes de lanzar el error (`:53`). No lo ejecuté. | Fuera de este encargo. Anotarlo como tarea aparte si importa. |
| H7 | Informativa | `src/admission/report.ts:27-30`, `:36`, `:52-53` | Dos lecturas engañosas que §4 permite. | **[V]** `followupsLost` incluye comentarios anteriores a la admisión del hilo; el propio test lo fija (`tests/admission-report.test.ts:119`, comentario a las 09:00 y admisión a las 10:00). **[I]** En `observe`, un hilo admitido al que se le retira la etiqueta aparece en `unlabeledTrusted` con `admittedAt` anterior a `firstSeen`: es una parada, pero se lee como «issue sin etiquetar». | Nada en código. Avisar a quien lea el informe: `admittedAt < firstSeen` significa etiqueta retirada. |
| H8 | Cosmética | `src/admission/report.ts:1-2`, `:62-64` | La cabecera del archivo no menciona las tres mediciones, y en `--json` los campos nuevos salen antes que `sources`. | Ninguno funcional. | Opcional. |

### Mutaciones que sobreviven

De 26, sobreviven 5. Solo la primera señala un hueco real.

- **Mirar solo la primera fila `thread-already-admitted` por hilo.** Hueco real: H3.
- **Comparar la etiqueta por subcadena** (`includes` en vez de `===`). Hueco menor: ningún test tiene una etiqueta que contenga a otra, como `fab-later` frente a `fab`.
- **`reasons.includes(...)` en vez de `reasons[0]`.** Equivalente en la práctica: esa razón solo se escribe en primera posición (`resident.ts:89`).
- **`LEFT JOIN` en vez de `JOIN`.** Equivalente con la clave foránea activa.
- **`association.toUpperCase()`.** Equivalente con los valores de la API.

## Contraste con `impl-codex.md`

Leído después de escribir los hallazgos.

- **Coincide** con lo que comprobé: los archivos tocados, las definiciones, que los seis tests fallaban antes, que el test 5 fallaba por la URL y no por la aserción del cuerpo (lo declara él mismo), el typecheck y el alcance.
- **No pude comprobar:** la suite completa (1398 pass); no la ejecuté. Tampoco los logs de `/tmp/t13-codex-evidence/`.
- **No menciona** ninguno de H1 a H7. En particular:
  - dice que no hubo que alterar el alcance de §4, lo cual es cierto, pero no advierte de que `stopsLost` queda vacía en `observe` ni de que cuenta cierres normales (H1);
  - describe el test de `stopsLost` como prueba de «deduplicación», pero esa deduplicación solo se prueba con dos filas que cumplen ambas (H3);
  - no señala que `report` deja de mostrar datos en una base de fase 1 (H2).
- **Su límite declarado** («`authorAssociation` no demuestra un rol de autorización») es correcto y coincide con §4.

## Lo que no revisé

- La suite completa `bun test tests`. Solo ejecuté `tests/admission-report.test.ts` y `bun run typecheck`, ambos en la copia temporal.
- El comportamiento con un residente real contra GitHub: todo lo de H1 y H7 sobre `observe` y `auto` sale de leer `resident.ts`, no de ejecutar un ciclo.
- `--mode auto` sin `--self` (H6): mi sonda falló antes, por el workstream.
- Si la API de GitHub puede devolver caracteres de control en `html_url` o `login` (H5).
- Las secciones §1 a §3 del análisis más allá de §1.2 y §1.3, y `BRIEF-T13-FABLE.md`.
- El rendimiento de `buildReport` con muchas decisiones: ahora hace `JSON.parse` del evento de cada una.

## Seguimiento (2026-11-14)

El commit `1afa42e` (otra sesión) cierra H1 a H5: `stopsLost` exige un change vinculado y añade `changeStatus`, `report` reconoce cualquier tabla `adm_*`, hay test de la segunda fila, las filas mal formadas ya no lanzan y `formatReport` quita los caracteres de control. **[V]** Leí el diff; `tests/admission-report.test.ts` y `bun run typecheck` pasan.

Ese arreglo introdujo un fallo nuevo, corregido en el commit siguiente de la rama (`fix(admisión): contar la parada si el change seguía vivo al decidirse`):

- **H9 (media, corregido).** `stopsLost` miraba el estado *actual* del change. Una etiqueta retirada con el change vivo desaparecía del informe en cuanto el change terminaba, es decir, casi siempre antes de que alguien lo leyera. **[V]** Test nuevo que fallaba antes del arreglo. Ahora la parada cuenta si la decisión es anterior al `updated_at` del change terminado.

Siguen abiertos:

- **H1, parte de `observe`:** sin vínculos, `stopsLost` sigue vacía en `observe`. Es inherente al modo.
- **Ambigüedad residual [I]:** si el issue se cierra por la fusión del PR antes de que la fab marque el change como terminado, ese cierre cuenta como parada. Se reconoce porque `changeStatus` sale terminado.
- **H6 y H7**, sin cambios. No ejecuté la suite completa tras estos commits.

<!-- FIN -->
