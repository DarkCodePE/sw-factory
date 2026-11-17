# T13-a y T13-b · implementación Codex

Fecha: 2026-11-13. Worktree: `/home/orlando/Desktop/factory/sw-factory-t13`. Rama: `feat/t13-router`. Base comprobada: `1fbb4b9` (merge de T40, PR #71). Árbol inicialmente limpio.

## Cambios y commits

- `0729e40` — `feat(admisión): medir seguimientos, paradas e issues sin etiqueta`.
  - `src/admission/report.ts:10`: añade los campos `followupsLost`, `stopsLost` y `unlabeledTrusted` al contrato del informe; también se serializan mediante el `--json` existente.
  - `src/admission/report.ts:18`: une decisiones con los metadatos del trigger; ordena por `decided_at`, `trigger_key`.
  - `src/admission/report.ts:24`: considera admitido un hilo con vínculo a change, signal o alguna decisión `would_admit = 1`; calcula la primera fecha de admisión.
  - `src/admission/report.ts:31`: usa exclusivamente `DEFAULT_POLICY.trustedAssociations` para contar confianza, sin autorizar nada.
  - `src/admission/report.ts:33`: obtiene comentarios `no-open-question` de hilos admitidos y autores de confianza, con URL, autor, asociación y fecha. No consulta `adm_comments`.
  - `src/admission/report.ts:43`: conserva por hilo la primera parada candidata y el primer issue abierto de confianza sin etiqueta. La parada compara etiquetas sin distinguir mayúsculas con la política guardada en su propia decisión. `admittedAt` es el mínimo de todas las admisiones del hilo, o `null`.
  - `src/admission/report.ts:91`: agrega las tres secciones de texto después de las existentes, con URLs y `(ninguno)` si están vacías.
- `4b5ec6d` — `fix(admisión): evitar crear el esquema al consultar el informe`.
  - `src/admission/cli.ts:17`: comprueba `hasAdmission` antes de construir `AdmissionDb`; si falta, imprime `(el residente nunca se ha ejecutado en esta base)` o `{}` con `--json`, y devuelve 0.

Ambos commits están en español y sin `Co-Authored-By`. El worktree queda limpio; este informe se entrega en la ruta externa indicada por el brief, fuera del worktree T13.

## Tests escritos antes de implementar

Las nuevas mediciones se prueban con `INSERT` directos sobre `new AdmissionDb(store).db`, sin `gh` falso. Los cinco tests existentes se conservan.

| Test nuevo | Ubicación | Antes del cambio | Prueba que aporta |
|---|---|---|---|
| un seguimiento de confianza sin pregunta abierta en un hilo admitido sale en followupsLost, con su URL | `tests/admission-report.test.ts:102` | Falló: campo `undefined` | MEMBER con vínculo a change y OWNER con signal incluidos; NONE, hilo sin admitir y otra razón excluidos. |
| en observe cuenta como admitido el hilo con una decisión would_admit | `tests/admission-report.test.ts:116` | Falló al acceder a `.map` de `undefined` | Sin vínculos ni signals; orden por fecha y, en empate, trigger; incluye COLLABORATOR. |
| la etiqueta retirada o el cierre sobre un hilo ya admitido sale en stopsLost, una vez por hilo | `tests/admission-report.test.ts:125` | Falló: campo `undefined` | Deduplicación, mínima fecha aunque se inserte después, cierre con etiqueta, política personalizada y comparación sin mayúsculas; excluye abierto etiquetado y otra primera razón. |
| un issue de confianza sin etiqueta sale en unlabeledTrusted, con admittedAt si se etiquetó después | `tests/admission-report.test.ts:138` | Falló: campo `undefined` | Primera observación, mínima admisión posterior y ausencia de admisión; excluye NONE, cerrado y otra primera razón. |
| formatReport no imprime el cuerpo del comentario | `tests/admission-report.test.ts:154` | Falló por faltar la URL del comentario en el texto | Comprueba URLs de las tres secciones, ausencia del cuerpo con ESC real (`\x1b[2J`) en texto y JSON, y marcadores vacíos. La aserción de ausencia del cuerpo por sí sola ya se cumplía antes: el fallo previo corresponde a la sección nueva que debía mostrar su URL. |
| report sobre una base sin admisión no crea tablas adm_* | `tests/admission-report.test.ts:173` | Falló: `hasAdmission` pasó de `false` a `true` | Tras el arreglo prueba texto y JSON sobre bases nuevas separadas: retorno 0, `hasAdmission = false`, cero tablas `adm_*` y salida exacta. |

El test existente de `--json` compara el resultado de `residentMain` con `buildReport`, de modo que también comprueba la inclusión de los tres campos nuevos.

## Comprobación del análisis y discrepancias

Antes de editar comprobé las fuentes de datos y los puntos afectados: `report.ts`, `cli.ts`, `db.ts`, `gate.ts` y los tramos de registro de issues, registro de comentarios, admisión e inbound de `resident.ts`. Se mantienen los nombres de tablas, columnas y metadatos citados; no hubo que alterar el alcance de §4.

- El análisis partía de `b4d9945`; el worktree real parte de `1fbb4b9`. T40 sí está fusionado: `src/sandbox/confine.ts:15` acepta `claudeProjects` y `src/sandbox/confine.ts:65` condiciona el montaje persistente de sesiones y `src/sandbox/confine.ts:70` lo añade. La afirmación histórica de que faltaba ese arreglo ya no describe este HEAD. No reproduje la reanudación con Claude real.
- Antes de T13-b, la construcción que el análisis situaba en `cli.ts:18` estaba en `cli.ts:17`. Tras el arreglo está en `cli.ts:21`; la comprobación nueva está en `cli.ts:17`.
- La referencia «CLAUDE.md #2078» es el identificador mencionado en la regla de atribución, no un número de línea: el archivo tiene 224 líneas. Se leyó y se respetó la prohibición del brief.
- Codebase Memory no tiene un proyecto para este worktree T13; el proyecto de la copia principal devolvió `coverage_unavailable` y generación desconocida para las rutas consultadas. No lo tomé como evidencia vigente del worktree: contrasté con graft y lectura directa de los archivos/tramos afectados. No reindexé ni modifiqué configuración de herramientas.

No revalidé hechos externos del análisis (issues/etiquetas reales en GitHub ni bases de otras ubicaciones): no son necesarios para estas dos tareas.

## Comandos y resultados

Logs locales de ejecución: `/tmp/t13-codex-evidence/` (temporales). La evidencia duradera resumida está en este informe.

| Comando / etapa | Resultado |
|---|---|
| `git status --short`, `git branch --show-current`, `git log -1 --oneline` al comenzar | Limpio; `feat/t13-router`; `1fbb4b9`. |
| `bun test tests/admission-report.test.ts`, antes de editar | 5 pass, 0 fail, 15 aserciones. Guardado en `baseline.log` antes de las ediciones. |
| Mismo comando, cinco tests de T13-a escritos y producción intacta | 5 pass, 5 fail; cada test nuevo falla (`t13-a-red.log`). |
| Mismo comando, T13-a implementado | 10 pass, 0 fail, 27 aserciones (`t13-a-green.log`). |
| `bun run typecheck` en T13-a | Primera ejecución detectó TS7006 en el callback de etiquetas; corregida la anotación del parámetro y repetido: salida 0 (`t13-a-typecheck.log`). |
| Mismo test focalizado, test de T13-b escrito y CLI intacta | 10 pass, 1 fail; reproduce creación indebida del esquema (`t13-b-red.log`). |
| Mismo comando, T13-b implementado | 11 pass, 0 fail, 36 aserciones (`t13-b-green.log`). |
| `bun run typecheck`, después de ambos commits | Salida 0 (`typecheck.log`). |
| `bun test tests`, suite completa una vez, después de ambos commits | Salida 0: 1398 pass, 2 skip, 0 fail; 7960 aserciones, 1400 tests en 138 archivos, 286,68 s (`full-suite.log`). No fue necesario repetir `tests/agent.test.ts`. |
| `git diff --check` y `git diff 1fbb4b9..HEAD --check` | Sin errores de espacios. |

## Alcance respetado y límites

No implementé §3.2: ni router, `route.ts`, revocación, Subscriptions ni `assess`. No modifiqué `gate`, `commentGate`, `Resident.admit`, `Resident.inbound`, `applyAdmission`, el esquema de `db.ts`, las tablas de la fab, `src/live/*`, `pool.ts`, `store.ts`, `prompts.ts` ni `outbox.ts`.

No añadí flags, tablas, columnas, dependencias, llamadas a modelos ni llamadas de medición a `gh`. No hice push, merge ni escrituras en GitHub; no lancé subagentes ni usé `git stash`.

Los dos tests omitidos por la suite son las integraciones optativas con Claude real y el poll de issues reales; no se habilitaron. Durante la ejecución se observó otro proceso `bun test tests` ajeno a esta sesión sobre el mismo worktree; no se intervino en él. Esta sesión lanzó la suite completa una sola vez.

El informe produce indicios para revisión humana; `authorAssociation` no demuestra un rol de autorización. No probé T11 con tráfico real, T39 ni reanudación real de T40: siguen fuera de este encargo.

## Correcciones tras verificación

Leído íntegramente `verif-fable.md` y aplicada la instrucción posterior del humano. Commit nuevo sobre `4b5ec6d`, en la misma rama `feat/t13-router`: **`1afa42e` — `fix(admisión): corregir mediciones y sanear el informe tras verificación`**, en español y sin `Co-Authored-By`. El texto anterior describe la primera implementación; esta sección actualiza su alcance y resultados.

- **H1:** `src/admission/report.ts:41` une `adm_thread_changes` con `changes` y reutiliza `isTerminalChange` del Store para conservar solo changes existentes no terminales. `stopsLost` incorpora `changeStatus` (`report.ts:12`, `:54`), también visible en texto (`:100`). Sigue seleccionando la primera decisión que cumple, sin confundir el estado del issue con el del change. El criterio consulta el **estado actual al construir el informe**, no reconstruye el estado histórico: una parada anterior deja de salir si el change ya terminó. En observe sin vínculos, esta sección sigue vacía. Esto modifica explícitamente la definición inicial de §4 por encargo del humano.
- **H2:** `src/admission/cli.ts:17` comprueba cualquier tabla cuyo nombre cumpla `GLOB 'adm_*'`, con guion bajo literal, en vez de `hasAdmission`. No modifica ese helper ni sus otros consumidores. Una base sin admisión mantiene la salida anterior y no crea tablas; una base antigua con tablas de admisión entra en la ruta existente de `AdmissionDb`, que puede completar su esquema.
- **H3:** `tests/admission-report.test.ts:211` añade un hilo con actualización inocua abierta y etiquetada, seguida de retirada de etiqueta. Debe conservar la segunda URL y fecha. El código ya seleccionaba correctamente esa segunda fila; no se cambió ese comportamiento.
- **H4:** `src/admission/report.ts:52` usa `(e.labels ?? [])` y `policy.triggerLabel?.toLowerCase()`. Dos tests independientes cubren cada ausencia.
- **H5:** `src/admission/report.ts:105` elimina controles C0, DEL y C1 de cada línea antes de unir las líneas propias del informe. El test contamina campos de las siete secciones, incluidos errores de efectos; comprueba ausencia de controles y líneas falsas, conservación del texto y de los separadores del informe. El cuerpo del comentario sigue excluido.

### Pruebas de regresión y fallos previos

Las nuevas fixtures siembran changes y vínculos reales para las paradas; los tests anteriores de paradas y formato se adaptaron a ese requisito. No se modificó el esquema ni el Store.

| Test | Ruta:línea | Resultado contra producción anterior |
|---|---|---|
| Excluye changes terminados y exige un change vinculado existente | `tests/admission-report.test.ts:197` | Falla: el código anterior incluía completed, failed, canceled, declined, blocked y quarantined, además de hilos sin vínculo, con solo signal/would_admit o vínculo a change inexistente. |
| Conserva la segunda fila si la primera no cumple | `tests/admission-report.test.ts:211` | Falla por faltar `changeStatus`; el comportamiento de seleccionar la segunda fila ya existía. Además se probó el mutante H3 descrito abajo. |
| Reconoce tablas antiguas sin adm_thread_changes y conserva decisiones | `tests/admission-report.test.ts:222` | Falla: devolvía el mensaje de residente nunca ejecutado. Tras el arreglo pasa tanto texto como JSON. |
| Tolera ausencia de labels | `tests/admission-report.test.ts:235` | Falla con TypeError de `.some`. |
| Tolera ausencia de triggerLabel | `tests/admission-report.test.ts:235` | Falla con TypeError de `.toLowerCase`. |
| Quita controles de cada línea sin permitir líneas falsas | `tests/admission-report.test.ts:244` | Falla: permanecían controles y saltos de línea procedentes de datos. |

**Procedimiento sin stash:** antes de editar producción, exporté `git archive HEAD` a `/tmp/t13-revision-red-kkv5zic_`, enlacé las dependencias instaladas y copié únicamente el archivo de tests actualizado. `bun test tests/admission-report.test.ts` en esa copia dio **10 pass, 7 fail**: fallan los seis tests nuevos y el test anterior de paradas adaptado al nuevo campo. Log: `/tmp/t13-codex-evidence/revision-red.log`.

Para aislar el valor de H3, copié después la producción corregida a esa misma copia temporal y la muté para marcar como visto un hilo en su primera decisión `thread-already-admitted`, aunque no cumpliera la condición. `bun test tests/admission-report.test.ts -t 'stopsLost conserva la segunda'` dio **0 pass, 1 fail, 16 filtrados**: devolvía `[]` en vez de la segunda fila. Log: `revision-h3-mutant.log`. La mutación nunca se aplicó al worktree.

### Validación final y límites

- Baseline previo a la revisión: **11 pass, 0 fail**, 36 aserciones (`revision-baseline.log`).
- `bun test tests/admission-report.test.ts`: **17 pass, 0 fail**, 50 aserciones (`revision-green.log`).
- `bun run typecheck`: salida **0** (`revision-typecheck.log`).
- `git diff --check`: sin errores; commit limitado a `report.ts`, `cli.ts` y `admission-report.test.ts`; worktree limpio tras el commit.
- No repetí la suite completa: esta revisión pidió typecheck y el archivo focalizado. El resultado completo anterior corresponde a `4b5ec6d`, no al commit de corrección.
- **H6, H7 y H8 no se tocaron.** Sin router, revocación, Subscriptions, modelos, flags, esquema nuevo, subagentes, stash, push, merge ni escrituras en GitHub. El informe se actualizó en la ruta externa indicada, fuera del worktree T13.
- La comprobación de Codebase Memory volvió a devolver cobertura no disponible y generación desconocida para este worktree; se contrastaron las fuentes afectadas directamente y con graft.

<!-- FIN -->
