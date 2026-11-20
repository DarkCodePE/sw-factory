# Implementación de fab web · F3

## Veredicto

[V] `/metricas` implementada en `feat/fab-web-f3`, para verificación independiente. Los nueve tests focales y tipos pasan. La única suite completa terminó con 1456 pass, 2 skip, 2 fail y 1 error asociado al timeout de FetchUrl; ambos archivos pasaron al repetirlos aislados (4/4 T2 y 16/16 FetchUrl). No se presenta la suite como enteramente verde. No se hizo push ni se escribió en GitHub.

[V] El diff de `src/web.ts:106` se limita al despacho de rutas, import y enlace de navegación; el resto vive en módulos nuevos, salvo dos consultas de lectura añadidas al Store. Se conserva el servidor de F0/F1, Store readonly, Host, GET/HEAD y CSP (`src/web.ts:93`, `:97`, `:99`, `:100`). No hay migraciones, columnas ni dependencias nuevas.

## Métricas y fuentes de datos

[V] **Cohorte:** changes creados en los últimos 7 días, 30 días o todo el historial, hasta la hora de consulta. Workstream por id o slug. Se eligen los 1000 más recientes, con desempate por id; el aviso cuenta exactamente los omitidos. Todo resultado pertenece a esa cohorte acotada (`src/store.ts:1338`, `src/metrics.ts:19`, `src/web-metrics.ts:21`). El rango no es un filtro sobre cada evento: el recorrido y coste de esos changes se acumulan hasta la consulta. Se explica en la página.

| Métrica | Fuente y definición |
|---|---|
| Creación → primera activity | [V] Diferencia entre `changes.created_at` y el mínimo válido de `activities.created_at`; incluye `change_review`, que suele nacer junto al change. No equivale a primer arranque del worker (`src/metrics.ts:31`, `:36`; productor `src/store.ts:552`). |
| Creación → primera revisión pedida | [V] Mínimo entre creación de `change_review` y evento exacto `investigation awaiting spec review`. No se usa el estado mutable de revisión para fecharla (`src/metrics.ts:36`, `src/store.ts:1354`; productor `src/store.ts:912`). |
| Creación → primera decisión humana | [V] Eventos `change_review` o `investigation` seguidos de `approved`, `commented` o `declined`, con comentario opcional. Excluye veredictos automáticos de validadores (`src/store.ts:1351`, `:1355`; productor `src/store.ts:1105`). |
| Creación → primer estado terminal registrado | [V] Primer evento explícito `change completed/canceled`, revisión `declined`, `blocked:`, `quarantined:` o `<kind> failed permanently:`. No sustituye la fecha por `updated_at`. Puede medir un bloqueo previo a un retry aunque el estado actual ya sea otro (`src/store.ts:1352`, `src/metrics.ts:36`). |
| Mediana y p90 | [V] Mediana aritmética de las dos posiciones centrales para tamaño par. p90 por rango más próximo: `ceil(n × 0.9)`. Fechas inválidas, anteriores a la creación o futuras no producen duración. Cada hito muestra muestras y changes sin medición (`src/metrics.ts:6`, `:31`, `src/web-metrics.ts:23`). |
| Intervenciones humanas por change | [V] Cuenta eventos de decisiones de revisión, `human reply received (question …); re-queued` y `change retried (…)`; desglosa cada clase y total. No usa `retry_count`, que incluye reintentos automáticos (`src/store.ts:1357`; productores `src/store.ts:1041`, `:1105`, `:1158`). Cero significa ausencia de esos eventos, no prueba de historial completo. |
| Changes por estado | [V] Estado actual de los changes seleccionados (`src/metrics.ts:64`). No reconstruye el estado en una fecha histórica. |
| Activities por tipo | [V] `activities.kind` de los changes seleccionados, hasta la consulta (`src/metrics.ts:43`). No se restringe a la fecha de creación del propio activity. |
| Coste total y top 10 | [V] Reutiliza `changeCost`; un change sin activities o con cualquier intento desconocido conserva `null`. Total desconocido si algún change carece de coste completo. El subtotal medido suma solo changes completos. Top 10 de esos changes, incluido cero conocido (`src/metrics.ts:40`, `:59`, `:65`; `src/evidence.ts:103`). |
| Coste por adaptador | [V] Reutiliza `activityCosts` y lee `metadata.isolation.adapter`; no atribuye según la configuración actual del workstream. Evidencia confinada que solo dice `bwrap-allowlist` no prueba el adaptador y aparece en «No medido». Con varios intentos, el adaptador final no prueba los anteriores (`src/metrics.ts:46`, `:50`; productor `src/pool.ts:318`). |
| Coste por modelo | [V] Usa `metadata.model` solo si hay evidencia de un único intento. El productor habitual no guarda ese campo: aparece «No medido». No se consulta un proveedor ni se inventa el modelo. El test sintético cubre evidencia que sí lo trae (`src/metrics.ts:53`, `tests/web-metrics.test.ts:30`). |

[V] Las duraciones son **acumuladas desde creación**, cuatro intervalos con un origen común. Se eligió esa definición para no exigir que todos los changes pasen por todas las puertas. El primer bloqueo registrado no equivale al cierre definitivo después de todos los reintentos. Ambas definiciones están visibles en las fuentes de la tabla.

[V] Cada grupo de coste separa total y subtotal de activities completas, con número de activities cuyo coste falta; ese subtotal puede diferir del subtotal por change. La página indica además cuántos changes tienen coste incompleto (`src/web-metrics.ts:19`, `:25`).

## Commits

- [V] `2d1a4f6` — `feat(web): añadir métricas de ciclo, intervención y coste de solo lectura`.
- [V] `3a94f97` — `fix(web): conservar legibilidad de las barras en móvil`.
- [V] `9f51b38` — `docs(web): guardar capturas y pruebas reproducibles de métricas`.
- [V] `48c238f` — `test(web): incluir los eventos recientes al comprobar intervenciones`.

## Cambios por fichero

- [V] `src/metrics.ts:1`: agregación, estadísticas, cohorte, costes y atribución conservadora.
- [V] `src/web-metrics.ts:1`: documento de métricas, formulario GET, tablas con captions y encabezados de fila/columna, SVG del servidor, CSS adicional y actualización manual. Reutiliza tema y componentes de F0/F1; sin JS.
- [V] `src/store.ts:1338`: **dos métodos nuevos de solo lectura**, `metricsCohort` y `metricsEvents`. SELECT parametrizados; la consulta de eventos devuelve agregados y no carga los cuerpos al proceso. No hay SQL en la web.
- [V] `src/web.ts:9`, `:106`, `:108`, `:112`: import, rutas `/metricas`, `/metrics.css` y enlace de navegación. Los guardas se ejecutan antes de despachar ambas rutas.
- [V] `tests/web-metrics.test.ts:1`: nueve pruebas de cálculo, filtros, tope, HTTP, disco y atribución histórica.
- [V] `docs/research/warp-platform/web-capturas-f3/`: cuatro imágenes, recorrido DOM, medición, mutaciones y scripts para reproducirlas.

## Rendimiento medido

[V] Estado final `3a94f97`; fixture desechable: **1000 changes, 1000 activities, 2750 eventos y 1000 ficheros JSON (59 663 bytes)**. Cinco cálculos y cinco peticiones completas de `/metricas?range=all`, base cerrada y apertura readonly por petición. Evidencia y script: `web-capturas-f3/rendimiento.json`, `fixture.ts`.

| Medida | Mediana | Mínimo–máximo |
|---|---:|---:|
| Cálculo de métricas | [V] 226,91 ms | 223,23–242,31 ms |
| Apertura readonly | [V] 0,57 ms | 0,52–1,82 ms |
| Petición HTTP, lectura de base y HTML completos | [V] 231,76 ms | 222,02–239,02 ms |

[V] HTML: 168 621 caracteres; RSS final del proceso: 112,55 MiB. No añadí caché: con esta carga medida el cálculo no la necesitó. Se reutiliza el lector acotado de 256 KiB por fichero. `changeCost` y las agrupaciones leen la evidencia por separado; no se alteró su contrato para evitar esa segunda lectura (`src/metrics.ts:41`, `:47`).

[I] Estos tiempos no cubren disco frío, metadata de 256 KiB por activity, muchos activities por change ni una base histórica mucho mayor. El tope limita changes procesados y HTML, pero la consulta agregada todavía tiene que recorrer eventos y la apertura de una base cerrada copia la base completa. No es un SLA ni una medición de carga concurrente.

## Mutaciones

[V] Cuatro mutaciones ejecutadas **en copia temporal**, sin mutar el worktree. **4 mueren, 0 sobreviven**. Se restauraron todos los ficheros y la copia volvió a pasar sus nueve tests antes de eliminarse. Script y resultados conservados en `web-capturas-f3/mutaciones.py`, `mutaciones.json`.

| Mutación | Test que falla |
|---|---|
| Mediana pasa a mínimo | [V] Mediana par/impar y tramos de resultado conocido. |
| Total con `null` pasa a subtotal numérico | [V] Coste desconocido distinto de cero. |
| Se elimina el umbral inferior de fecha | [V] Cohorte por fecha y workstream. |
| Se ignora workstream | [V] Cohorte por fecha y workstream. |

## Tests

[V] Las primeras pruebas se escribieron antes del módulo. El primer rojo fue `Cannot find module ../src/metrics.ts`; no lo presento como prueba funcional de cada cálculo. La primera ejecución con implementación detectó una fixture inconsistente: creaba `change_review` pero esperaba la fecha del evento posterior. Se corrigió la fixture a `investigation`, respetando la definición de la petición inicial.

[V] Dos pruebas adicionales tuvieron rojo funcional antes de arreglarlas: un comentario humano que contenía `investigation failed permanently:` se interpretaba como terminal por un GLOB demasiado amplio; y se atribuía todo el coste histórico al último adaptador. Se acotó el prefijo del evento y se dejó la atribución histórica como desconocida (`tests/web-metrics.test.ts:87`, `:106`; `/tmp/webf3-extra-red.log`).

| Comando | Resultado |
|---|---|
| `bun test tests/web-metrics.test.ts` | [V] 9 pass, 0 fail. |
| `bun test tests/web-metrics.test.ts tests/web.test.ts tests/web-readonly.test.ts` | [V] 39 pass, 0 fail; 238 aserciones; 4,08 s. |
| `bun run typecheck` (`tsc --noEmit -p .`) | [V] Salida 0 antes de ambos commits de código. |
| `bun test tests` | [V] 1456 pass, 2 skip, 2 fail, 1 error; 8013 aserciones; 480,44 s. Única ejecución completa. |
| `bun test tests/t2-cualificacion.test.ts`, aislado | [V] 4 pass, 0 fail; 1115 aserciones; 42,11 s. |
| `bun test tests/agent-fetch-url.test.ts`, aislado | [V] 16 pass, 0 fail; 129 aserciones; 5,86 s. |

[V] HTTP comprueba GET, HEAD sin cuerpo, 405 en escrituras, Host ajeno rechazado, CSP, escapado de título, ausencia de scripts/sondeo, SVG y tablas. Tras consultar una base cerrada conserva exactamente nombres del árbol y bytes de la base; no crea auxiliares ni modifica esquema (`tests/web-metrics.test.ts:70`). La lógica de apertura readonly previa también pasó sus tests de regresión.

[V] La suite se lanzó con código de producción `3a94f97`. Durante ella se confirmó documentación y se cambió una línea del test de exclusión de eventos: usaba el reloj fijo del mediodía y dejaba fuera también los eventos emitidos a la hora real. Se corrigió para consultar hasta la hora actual. La corrección pasó de forma aislada: **9 pass, 0 fail, 57 aserciones** (`/tmp/webf3-event-test-final.log`). La suite no se presenta como validación de un SHA inmutable.

### Desvíos de la suite

| Esperado / ocurrido | Detección, causa y evidencia |
|---|---|
| Suite verde / T2 no produjo suite.json tras 170,64 s | [V] Detectado en salida, `tests/t2-cualificacion.test.ts:112`: ENOENT tras agotar el plazo de preparación. [I] Compatible con el problema externo de preparación/clonado ya documentado; no se atribuye a una causa de red concreta sin evidencia. Log `/tmp/webf3-suite.log`. Repetición aislada **4 pass, 0 fail**, incluida preparación real; `/tmp/webf3-t2-repeat.log`. |
| Suite verde / FetchUrl agotó el timeout del test | [V] `tests/agent-fetch-url.test.ts:177`: test de 5000 ms vencido; un rechazo posterior recibió `Fixture closed` en vez de `timeout`, registrado como error entre tests. [I] Compatible con carga; causa no demostrada. Log `/tmp/webf3-suite.log`. Repetición aislada **16 pass, 0 fail**; `/tmp/webf3-fetch-repeat.log`. |

## Prueba manual

[V] `agent-browser --session fabf3 --args "--no-sandbox"` sobre dos workstreams y ocho changes sintéticos en stateDir temporal. Nunca bases personales. Página completa en **1440 × 1000 y 390 × 844**, tema claro y oscuro. Las cuatro imágenes finales fueron abiertas e inspeccionadas. `scrollWidth === innerWidth`, consola y errores vacíos en las cuatro capturas, siete tablas y dos SVG, cero scripts. El formulario termina en `/metricas?ws=motor&range=7` con cuatro changes seleccionados (`web-capturas-f3/recorrido.json`).

[V] Se ajustó el viewBox del SVG para conservar etiquetas legibles en móvil; tablas anchas con desplazamiento interno. El primer registro del formulario se tomó antes de completarse la navegación: se repitió esperando la URL final. Se reinició el servidor después del ajuste y se regeneraron las cuatro capturas. Detector de Impeccable: `[]`. Se cerraron el navegador y servidor propios y se retiró la fixture.

[V] Se heredó el sistema visual existente, sin PRODUCT.md ni cambios en DESIGN.md. El brief cerrado y su prohibición de subagentes prevalecen sobre las entrevistas y revisiones delegadas sugeridas por el skill. La revisión visual aquí es del implementador, no sustituye la verificación goldfish independiente.

## Lo que no hice

- [V] Sin migraciones, persistencias nuevas, índices, flags, dependencias ni cache en memoria.
- [V] Sin agentes reales: no se tocaron `src/live/` ni `src/sandbox/`.
- [V] Sin acciones F2, publicación, push, PR, merge ni escrituras en GitHub. Sin subagentes.
- [V] No cerré la tarea en `task.json`: la cola de `origin/release/0.1.0-rc.12` no contiene F3; el cierre corresponde al elefante después de verificarla. No se alteró la cola de otro worktree.
- [V] No inventé modelos, adaptadores confinados, tiempos terminales a partir de updated_at ni decisiones humanas a partir de veredictos automáticos.

## Riesgos

- [V] La clasificación usa los prefijos que produce el Store hoy; un cambio futuro del vocabulario de eventos exige actualizar la consulta. Historial recortado o formas antiguas no reconocidas reducen cobertura (`src/store.ts:1351`).
- [V] Un hito ausente muestra «No medido»; una cuenta de intervenciones es solo lo observado. Las salidas no garantizan completitud histórica (`src/web-metrics.ts:23`, `:26`).
- [I] La medición de 1000 changes no asegura el mismo tiempo con cientos de activities por change; no hay tope independiente de activities. Base cerrada y scan de eventos conservan sus costes históricos.
- [V] La base y la evidencia en disco no comparten un snapshot atómico. Evidencia que cambie entre la suma por change y la lectura por activity puede producir subtotales transitoriamente diferentes. No se añadió caché que prolongase esa diferencia (`src/metrics.ts:41`, `:47`).
- [V] Se mantienen las limitaciones previas de la redacción histórica y del lector SQLite; no se amplió su alcance.
- [V] Grafo MCP más cercano: proyecto `sw-factory-fabweb`, generación `2026-11-19T17:07:58Z`, sin huecos registrados en las cinco rutas consultadas. Este worktree no estaba indexado: las conclusiones de implementación se contrastaron leyendo la fuente local; no se equiparó la cobertura del otro checkout con la de éste.

<!-- FIN -->
