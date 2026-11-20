# Implementación de `fab web` · F0 y F1

## Veredicto

[V] F0 y F1 implementadas y entregadas para verificación independiente; las pruebas de web/Store y tipos pasan, y las tres ejecuciones completas tuvieron fallos externos al cambio que se detallan abajo. Ninguna ejecución completa quedó enteramente verde; las repeticiones aisladas de todos los archivos que fallaron sí pasaron.

## Rutas

[V] Todas admiten GET y HEAD; Host ajeno devuelve 403 y los demás métodos devuelven 405 con `Allow: GET, HEAD` (`src/web.ts:94@ff1b358`, `tests/web.test.ts:51@ff1b358`). El servidor escucha exclusivamente en `127.0.0.1`; puerto predeterminado 4310, configurable con `--port`, incluido 0 para escoger uno libre.

| Ruta | Consulta / lectura |
|---|---|
| `/` y `/?ws=<slug>` | [V] `Store.inbox`, `getChange`, `getWorkstream`; contadores de las activities de la bandeja por estado o revisión (`src/web.ts:50@ff1b358`). |
| `/workstreams` | [V] `Store.listWorkstreams`; objetivo, estado, repositorio y agente (`src/web.ts:57@ff1b358`). |
| `/changes?ws=&status=&q=` | [V] `listWorkstreams`, `getWorkstream`, `listChanges`; filtro de estado y búsqueda de título en servidor, conservados en el formulario y URL (`src/web.ts:58@ff1b358`). |
| `/changes/<id>` | [V] `getChange`, `listActivities`, `listEvents`, `getWorkstream`; jerarquía, timeline cronológica del change y coste compartido (`src/web.ts:70@ff1b358`). |
| `/activities/<id>` | [V] `getActivity`, `getChange`; resultado, revisión y evidencia de `runs/<change>/<activity>.log`, `<activity>.json`, `run.json` y `diff.patch` (`src/web.ts:78@ff1b358`). |
| `/style.css` | [V] Una hoja de estilo local, constante de `src/web-style.ts:2@ff1b358`. |
| `/poll.js` | [V] Sondeo GET cada 2000 ms, sin recargar toda la página ni interrumpir edición de filtros o selección de texto (`src/web.ts:16@ff1b358`). |

[V] Los ids desconocidos devuelven 404, los ids de evidencia inválidos 400 y los errores de lectura no filtran rutas ni excepciones (`src/web.ts:108@ff1b358`). No se añadieron endpoints de escritura.

## Commits

[V] Todos están en `feat/fab-web`, sin push, sin PR y sin `Co-Authored-By`:

- `e9fc7c8` — `feat(evidencia): compartir lectura acotada y abrir el Store sin migraciones`.
- `d3262cf` — `fix(store): leer bases cerradas sin crear WAL ni SHM`.
- `ff1b358` — `feat(web): añadir bandeja y evidencia local de solo lectura`.
- `b798604` — `fix(store): fijar el snapshot de lectura antes de cerrar el escritor`.
- `d1415e1` — `docs(web): guardar recorrido visual y contraste de F0 y F1`.
- `eec5a55` — `refactor(evidencia): reunir la lectura de sondas en el módulo común`.

## Cambios por fichero

- [V] `src/cli.ts:144@ff1b358`: despacho de `web` antes de cualquier apertura escritora del Store; ayuda del comando.
- [V] `src/store.ts:269@b798604`: opción `readonly`, sin esquema, migraciones, PRAGMA de escritura ni transacciones IMMEDIATE. Con WAL existente, conexión `readonly: true` y transacción diferida de lectura fijada al abrir. Sin WAL, copia estable en memoria con `Database.deserialize(..., { readonly: true })`; comprueba tamaño y tiempos antes/después. Solo en esa copia adapta los bytes de formato de diario para que SQLite pueda deserializarla. Un WAL sin SHM se rechaza, nunca se recupera desde la web.
- [V] `src/evidence.ts:11@e9fc7c8`: lector compartido con tope de 256 KiB, validación de rutas, descriptor de lectura, rechazo de symlinks y ficheros no regulares, redacción histórica y JSON antiguo. `activityCosts` y `changeCost` conservan la semántica de coste desconocido si falta cualquier intento (`:83`, `:91`).
- [V] `src/manifest.ts:6@e9fc7c8`: importa y reexporta la redacción común, conservando la API existente y las reglas del escritor de manifiestos. En `eec5a55` se mueve también `readEgressProbe` a `src/evidence.ts:104@eec5a55`, sin cambiar su comportamiento; manifest conserva la reexportación y el pool no cambia de import.
- [V] `src/improve.ts:150@e9fc7c8`: comparte metadata, informe de worker y agregación de coste; deja de duplicar esas lecturas.
- [V] `src/web.ts:88@ff1b358`: servidor, navegación, vistas y cabeceras; abre y cierra un lector por petición, para ver escrituras posteriores también cuando arrancó con una base cerrada.
- [V] `src/web-style.ts:2@ff1b358`: diseño de dos zonas, temas claro/oscuro, controles etiquetados, foco visible, enlace de salto y tablas desplazables.
- [V] `tests/web.test.ts:29@ff1b358` y `tests/web-readonly.test.ts:6@b798604`: pruebas HTTP, evidencia y SQLite de solo lectura.
- [V] `docs/research/warp-platform/web-capturas/`: veinte capturas sintéticas, registro del recorrido, cálculo de contraste y README.

## Tests

[V] Comandos ejecutados:

| Comando | Resultado |
|---|---|
| `bun test tests/web*.test.ts tests/store.test.ts` | 29 pass, 0 fail; 205 aserciones. Incluye el cierre del escritor después de abrir el lector. |
| `bun test tests/web.test.ts tests/improve.test.ts tests/manifest.test.ts` | 65 pass, 0 fail en la prueba focal de extracción, antes del último endurecimiento exclusivo del lector SQLite. |
| `bun test tests/manifest.test.ts -t egressProbe` · antes/después de la última extracción | 1 pass, 0 fail en ambos; 4 aserciones. Reubicación sin cambio de comportamiento. |
| `bun test tests/web*.test.ts` · estado final | 11 pass, 0 fail; 128 aserciones; 1,046 s. |
| `./node_modules/.bin/tsc --noEmit -p .` | 0 sobre el estado final. |
| `bun run typecheck` | 0 antes de cada commit. Ejecuta `tsc --noEmit -p .`. |
| `bun test tests` · primera ejecución | 1415 pass, 3 skip, 2 fail; 309,52 s. Fallos en `execute-network`, descritos en Desvíos. |
| `bun test tests/execute-network.test.ts` · repetición aislada | 16 pass, 0 fail; 147 aserciones; 2,47 s. |
| `bun test tests/t2-cualificacion.test.ts` · repetición aislada | 4 pass, 0 fail; 1115 aserciones; 95,14 s, incluida la preparación real del corpus. |
| `bun test tests` · segunda ejecución | 1420 pass, 2 skip, 1 fail; 436,29 s. Fallo externo de preparación T2; descrito abajo. Esta ejecución se inició antes del último arreglo de snapshot; ese arreglo tiene la prueba focal de 29 tests posterior. |

[V] Última ejecución completa: `bun test tests` → **1421 pass, 2 skip, 1 fail**, 8130 aserciones, 405,07 s. Pasaron T2, la prueba de cierre del escritor y la prueba de manifest/egress compartida. Falló la comprobación de conectividad real de `tests/egress-probe.test.ts:70@ff52f0b` (`reachable=false`, esperado `true`). Repetición aislada `bun test tests/egress-probe.test.ts` → **5 pass, 0 fail**, 29 aserciones, 137 ms. Evidencia: `/tmp/fabweb-suite-delivery.log` y `/tmp/fabweb-egress-repeat.log`.

[V] La última suite se inició en `d1415e1`; durante ella se reubicó, sin cambio de comportamiento, `readEgressProbe` en `eec5a55`. Esa extracción pasó su test antes y después y el typecheck. No se presenta esta ejecución como una validación de artefacto inmutable ni como una suite enteramente verde.

[V] Prueba roja comprobada antes del cambio: una apertura supuestamente readonly creaba una base inexistente. Después se reprodujeron con aserciones fallidas tres casos de SQLite: WAL sin SHM, base WAL cerrada que creaba auxiliares y cierre del escritor entre apertura/consulta. Los tres pasan con el arreglo correspondiente (`tests/web-readonly.test.ts:6`, `:18`, `:31@b798604`).

[V] La prueba de secreto JSON en un log histórico falló al mostrar `api_key` y pasó al añadir el tratamiento de JSON histórico (`tests/web.test.ts:115@ff1b358`). Las primeras pruebas HTTP se escribieron antes del servidor, pero su primer rojo fue un módulo inexistente: no lo cuento como demostración funcional de cada aserción HTTP. Los casos adicionales de evidencia antigua, ciclo, veredicto, cambios posteriores y symlink HTTP se añadieron como regresión; no todos tienen ejecución roja previa.

[V] Se comprobaron además base antigua sin migración, metadatos rotos, evidencia ausente, coste histórico `usage.costUsd`, truncado con PEM incompleto, filtro sin resultados, GET/HEAD, 405 en cada ruta y 404 (`tests/web.test.ts:29`, `:51`, `:68`, `:74`, `:96@ff1b358`).

## Prueba manual

[V] `fab web --port 0` se arrancó sobre un directorio temporal sembrado exclusivamente con datos sintéticos. Se recorrieron bandeja, workstreams, changes, detalle de change y detalle de activity en 1440 × 1000 y 390 × 844, temas claro y oscuro. Se usó la sesión propia `agent-browser --session fabweb`; el navegador requirió `--args "--no-sandbox"`. No se abrió `capturas/` ni ninguna base personal.

[V] Capturas en el worktree: `docs/research/warp-platform/web-capturas/{bandeja,workstreams,changes,change,activity}-{1440,390}-{light,dark}.png`. Se inspeccionaron las veinte imágenes. `recorrido.json` recoge consola y errores vacíos en los veinte recorridos finales, con `scrollWidth === innerWidth`; las tablas conservan desplazamiento interno en móvil.

[V] Se comprobó el formulario de búsqueda mediante navegación real y se añadió un change sintético con la página abierta: apareció por sondeo sin recarga. El cálculo de contraste de texto, enlaces y estados sobre las tres superficies dio un mínimo de 5,53:1 (`web-capturas/contraste.json`). El detector de Impeccable devolvió `[]`. Se cerraron servidor y navegador propios y se eliminó la fixture temporal.

## Seguridad

| Requisito | Cumplimiento y prueba |
|---|---|
| Solo lectura real | [V] SQLite readonly, ninguna migración, copia readonly sin auxiliares cuando no hay WAL; prueba de INSERT rechazado, estado inexistente/vacío, esquema antiguo, cierre de escritor y WAL incompleto (`src/store.ts:280@b798604`; `tests/web.test.ts:74@ff1b358`; `tests/web-readonly.test.ts:6@b798604`). |
| Ningún método de escritura | [V] GET/HEAD exclusivamente, también en recursos estáticos y rutas inexistentes (`src/web.ts:97@ff1b358`; `tests/web.test.ts:51@ff1b358`). |
| Escapado | [V] Texto dinámico pasa por redacción y escapado HTML; `<script>` probado en título, log, veredicto y evento (`src/web.ts:10@ff1b358`; `tests/web.test.ts:29`, `:96@ff1b358`). |
| Host | [V] Comparación exacta de `127.0.0.1:<puerto>` o `localhost:<puerto>`, con puerto real del listener; host externo y puerto incorrecto dan 403 (`src/web.ts:96@ff1b358`; `tests/web.test.ts:51@ff1b358`). |
| Evidencia dentro de stateDir | [V] Rutas relativas validadas, sin `..`, sin symlinks; `O_NOFOLLOW`, fichero regular y, en Linux, comprobación del descriptor realmente abierto mediante `/proc/self/fd` (`src/evidence.ts:11@e9fc7c8`; `tests/web.test.ts:51`, `:132@ff1b358`). |
| Cabeceras y red | [V] CSP restrictiva sin orígenes externos, `nosniff`, `no-store`, `no-referrer`; ningún CDN ni fuente remota (`src/web.ts:17@ff1b358`; `tests/web.test.ts:29@ff1b358`). |
| Redacción y tamaño | [V] Reutiliza la redacción de manifest y añade tratamiento de JSON histórico y PEM cortado; límite físico de lectura 256 KiB con aviso visible (`src/evidence.ts:29@e9fc7c8`; `tests/web.test.ts:68`, `:115@ff1b358`). |

## Decisiones de diseño

- [V] Navegación de workstreams a la izquierda y contenido documental a la derecha; en móvil, navegación arriba. El detalle coloca árbol, eventos y evidencia en secuencia. Estados con texto y color, tipografía del sistema y ninguna petición externa (`src/web-style.ts:2@ff1b358`).
- [V] Las consultas del dominio siguen siendo del Store. La suma de coste pertenece al lector compartido y se reutiliza desde improve; la web solo presenta los datos (`src/evidence.ts:91@e9fc7c8`).
- [V] La lectura de SQLite se abre por petición: evita congelar para siempre la copia de una base inicialmente cerrada. La copia en memoria evita que SQLite cree auxiliares al leer una base WAL cerrada. Umbral de la prueba: cero archivos nuevos; el test falló antes y pasa después (`tests/web-readonly.test.ts:18@b798604`).
- [V] El coste incompleto dice «No medido», nunca se convierte en cero. La duración solo se muestra para el último intento: el pool guarda una única `durationMs`, no una duración por intento histórico (`src/pool.ts:316@ff52f0b`; `src/web.ts:83@ff1b358`).

## Lo que no hice

- [V] No añadí F2, POST, aprobación, merge, gate allow, métricas nuevas, columnas, dependencias ni escrituras en GitHub. No se tocaron live ni sandbox.
- [V] No cambié la TUI: en este checkout `detailLines` lee `Activity.result/error` del Store, no logs de disco (`src/tui.ts:111@ff52f0b`). Sustituirlo por logs, truncado o redacción cambiaría su comportamiento. La lectura/escritura de manifiestos conserva su comportamiento; comparte la función de redacción, sin imponer el límite de presentación al escritor.
- [V] No inventé duraciones antiguas ni generé diffs ejecutando git desde HTTP. La vista presenta el patch guardado si existe (`runs/<change>/diff.patch`); la fábrica actual no genera ese archivo de forma general. La captura usa un patch sintético claramente perteneciente a la fixture.
- [V] No actualicé `task.json`: la cola de la release leída no contiene esta tarea web y el cierre corresponde al elefante. El encargo del goldfish pide implementación e informe.
- [V] No lancé subagentes ni guardé memoria externa. Se aplicaron las comprobaciones de legibilidad y detector de Impeccable; los pasos de entrevistas y revisión con subagentes se omitieron por el brief cerrado y su prohibición explícita de subagentes.

## Desvíos

| Esperado / ocurrido | Detección, clase y evidencia |
|---|---|
| Suite completa verde / dos fallos de `execute-network` en la primera ejecución | [V] Detectados al leer la salida. `Sandboxed process never started` al vencer 2 s y cancelación propagada al test siguiente. Repetición aislada: 16/16 pasan. [I] Compatible con carga del host, no demostrado como causa única. Evidencia: `/tmp/fabweb-suite.log`, `/tmp/fabweb-network-repeat.log`; `tests/execute-network.test.ts:230`, `:282@ff52f0b`. |
| Suite completa verde / preparación T2 sin `suite.json` tras 170 s en la segunda | [V] Detectado en la salida: el subproceso de `prepare.sh` agotó el plazo; falló la lectura del resultado inexistente. [I] Dependencia externa de red/clonado. Evidencia: `/tmp/fabweb-suite-final.log`; `tests/t2-cualificacion.test.ts:105`, `:110@ff52f0b`. Repetición aislada posterior: 4 pass, 0 fail, incluida la preparación del corpus; no se modificó la prueba. |
| Última suite completa verde / conectividad real de egress no alcanzable dentro de 2 s | [V] Detectado por `tests/egress-probe.test.ts:70@ff52f0b`: `reachable=false`. Repetición aislada: 5 pass, 0 fail en 137 ms. [I] Fallo transitorio de conectividad o carga del host; no se modificó la sonda. Evidencia: `/tmp/fabweb-suite-delivery.log`, `/tmp/fabweb-egress-repeat.log`. |
| Chromium arrancaría con sandbox / `No usable sandbox` | [V] Detectado en el arranque. Configuración del host. Resuelto con el argumento previsto por el brief; recorrido completado. |
| readonly bastaría / SQLite creaba auxiliares | [V] Detectado mediante medición en directorios temporales, con umbral de cero archivos nuevos. Arreglado y con pruebas rojas/verdes para base cerrada y cierre concurrente del escritor (`tests/web-readonly.test.ts:18`, `:31@b798604`). |
| Primera ampliación de prueba / llamada a `store.emit` inexistente | [V] Error de la fixture detectado por el runner; se corrigió a `Store.event` tras comprobar su definición. No se consideró un rojo funcional del producto. |

## Riesgos para la verificación

- [V] Una base sin WAL se copia completa en memoria por petición; no se midió rendimiento con bases grandes. El límite de 256 KiB afecta a archivos de evidencia, no al tamaño de SQLite (`src/store.ts:300@b798604`).
- [V] Un WAL existente sin SHM produce fallo cerrado: se necesita que un escritor legítimo recupere la base. No lo repara la web.
- [I] Debe revisarse con estrés el intervalo entre la comprobación de auxiliares y la primera lectura SQLite. Las pruebas cubren el cierre del escritor después de abrir el lector; no constituyen una auditoría del VFS ni de sustituciones hostiles de la base.
- [V] La comprobación del descriptor contra escapes por cambio de directorio se probó en Linux. En otras plataformas se usa realpath; no se verificó su comportamiento ante carreras (`src/evidence.ts:25@e9fc7c8`).
- [V] No hay duración histórica por intento ni un productor general de `diff.patch`. No se añadieron persistencias fuera de alcance para inventar esos datos.
- [I] El cálculo de contraste y recorrido por navegador no sustituyen una auditoría completa con lector de pantalla. No se hicieron mutaciones adversariales: corresponden al verificador independiente.

## Arreglos tras verificación

[V] Brief de arreglos y verificación de Fable leídos completos. Baseline `eec5a55`, worktree limpio; no se hizo push ni se lanzaron subagentes. Los cambios quedan en tres commits locales:

| Commit | Hallazgos y solución |
|---|---|
| `ed48297` — `fix(improve): conservar la lectura original de metadata (H2, H6)` | [V] `src/improve.ts` vuelve a ser idéntico a `ff52f0b` (diff vacío). Lee metadata completa, sigue symlinks, conserva las excepciones para JSON roto o `null`, el respaldo sin fichero/stateDir y el `workerReport` sin redacción adicional. El límite y las defensas del lector web quedan separados. |
| `3c0d261` — `fix(store): esperar bloqueos antes de abrir WAL (H1, H8)` | [V] `busy_timeout = 5000` precede a `journal_mode = WAL` en el escritor; también se configura en el lector WAL antes de BEGIN y en el snapshot deserializado (`src/store.ts:280`, `:334@7378614`). El PRAGMA se admite en ambas conexiones readonly. |
| `7378614` — `fix(web): proteger redacción y acotar la timeline (H3, H5, H7)` | [V] Refuerza tests de defensas; aplica PEM incompleto a valores JSON y texto; descarta el último token del prefijo truncado (`src/evidence.ts:39`, `:57@7378614`). La timeline presenta los últimos 200 eventos propios, en orden, e indica el número exacto omitido (`src/web.ts:76@7378614`). |

[V] Para H7 se amplió `Store.listEvents` con un filtro opcional por change y se añadió `countEvents`, una consulta escalar. Así no se cargan los cuerpos de eventos ajenos ni omitidos para calcular el aviso. Se conserva el comportamiento de los llamadores de uno o dos argumentos; no se añadieron tablas, índices, migraciones, dependencias ni flags (`src/store.ts:1329`, `:1338@7378614`).

### Tests y medición

[V] La prueba de carrera fija de antemano el umbral de **cero errores del escritor**, realiza **1500 aperturas/escrituras/cierres** con un lector concurrente y comprueba el número final de eventos y `integrity_check`. No depende de pausas breves: `Bun.sleep(0)` solo permite recoger la finalización del hijo. Con el código anterior reprodujo **10 errores `database is locked`**; con el arreglo, **0**. No se generaliza esta muestra a todas las cargas (`tests/web-locks.test.ts:20@3c0d261`; salidas `/tmp/fabweb-arreglos-rojo-locks.log` y `/tmp/fabweb-arreglos-locks.log`).

[V] Antes del arreglo fallaron los seis casos diferenciales H2/H6 y el test H8 de timeout. Después pasan. El oráculo de `tests/fixtures/improve-evidence-base.ts:1@ed48297` contiene literalmente las dos funciones de la base, con su SHA. Se comparan valores y clase/mensaje de las excepciones en metadata de 300 KiB, symlink, stateDir inexistente, fichero ausente, JSON roto, JSON `null` e informe `password=hunter2` (`tests/web-improve.test.ts:30@ed48297`).

[V] H5 tuvo dos rojos independientes: PEM sin cierre dentro de JSON y token `ghp_…` partido por el corte. H7 fallaba antes por devolver 215 eventos sin el aviso; ahora devuelve 200 y «Se omiten 15 eventos anteriores», sin eventos de otro change (`tests/web.test.ts:224`, `:230`, `:244@7378614`).

[V] Los nuevos tests H3 pasan con el código correcto y fallan con la defensa correspondiente mutada: socket real de loopback en Linux, INSERT válido con WAL vivo y con snapshot, CSP exacta, comillas en atributo, jerarquía padre/hija, redacción de texto/JSON/campos de Store, FIFO, filtro de bandeja, contadores por revisión, exclusión de eventos ajenos y metadata truncada cuyo prefijo es JSON válido (`tests/web.test.ts:74`, `:143`, `:153`, `:164`, `:171`, `:178`, `:188`, `:200`, `:206`, `:216`, `:238@7378614`). El INSERT de control sí se acepta en el escritor; su rechazo ya no depende de una restricción NOT NULL.

| Comando | Resultado |
|---|---|
| `bun test tests/web.test.ts tests/web-improve.test.ts tests/web-readonly.test.ts` | [V] 30 pass, 0 fail; 188 aserciones, 2,12 s. |
| `bun test tests/web-locks.test.ts` | [V] 2 pass, 0 fail; carrera y timeout, 8,58 s. |
| `bun run typecheck`, antes de cada commit | [V] Salida 0. |
| `./node_modules/.bin/tsc --noEmit -p .`, con el código final | [V] Salida 0. |
| `bun test tests`, SHA `7378614` estable durante toda la ejecución | [V] 1442 pass, 2 skip, 1 fail; 7940 aserciones, 444,65 s. Fallo ajeno de preparación T2, detallado abajo. |
| `bun test tests/t2-cualificacion.test.ts`, repetición aislada | [V] 4 pass, 0 fail; 1115 aserciones, 131,57 s. |
| Tests HTTP/readonly de la copia de mutación, antes y después de mutarla | [V] 24 pass, 0 fail; 165 aserciones en la copia restaurada. |

[V] La suite completa falla exclusivamente en `tests/t2-cualificacion.test.ts:112`: falta `suite.json` después de que la preparación dure 170,43 s, con timeout configurado de 170 s. Los tests nuevos, la carrera, improve, manifest y los tests de red anteriores pasan. [I] Compatible con el problema de preparación/clonado externo ya observado; la salida de esta ejecución no permite atribuirlo a un error de red concreto. Evidencia: `/tmp/fabweb-arreglos-suite.log`. La repetición aislada `bun test tests/t2-cualificacion.test.ts` pasó: **4 pass, 0 fail**, 1115 aserciones, 131,57 s, incluida la preparación real (130,08 s). Evidencia: `/tmp/fabweb-arreglos-t2-repeticion.log`. No se presenta la suite completa como enteramente verde.

[V] Desvío de la primera fixture H1: esperaba 1500 eventos pero incluía uno de creación del workstream. Ese fallo secundario no se cuenta como rojo funcional. Se vaciaron los eventos de la semilla antes de medir; la prueba válida posterior reprodujo los 10 errores del escritor citados arriba. Evidencia: `/tmp/fabweb-arreglos-rojo-1.log` frente a `/tmp/fabweb-arreglos-rojo-locks.log`.

### Mutaciones

[V] Se ejecutaron las **14 mutaciones pedidas**, más cuatro de redacción, en `/tmp/fabweb-arreglos-mut-b0glr2jf`, una copia de `git archive 7378614` con un enlace a node_modules, sin modificarlo. El worktree no se mutó. **18 mueren; 0 sobreviven; 0 sin aplicar.**

| Mutación | Test que la mata |
|---|---|
| W14 | [V] Socket real en loopback. |
| S03 | [V] INSERT válido rechazado en SQLite WAL readonly. |
| S09 | [V] INSERT válido rechazado en el snapshot deserializado. |
| W10, W11 | [V] CSP completa exacta. |
| W05 | [V] Comillas escapadas en el atributo `value`. |
| W17 | [V] Hija dentro del árbol de su padre. |
| E18 | [V] Metadata truncada con prefijo JSON válido no interpretada. |
| E08 | [V] FIFO rechazado como evidencia no regular. |
| W21, W22 | [V] Bandeja por workstream y contador según revisión, con una activity bloqueada y awaiting. |
| W23, W24 | [V] Filtro por estado y búsqueda por título. |
| W25 | [V] Eventos ajenos excluidos y timeline acotada. |
| W06, E11, E14, E15 (adicionales) | [V] Cada capa de redacción se prueba directamente; la redacción exterior no oculta la retirada de una defensa interior. |

[V] W25 se adaptó a la nueva ubicación del filtro: se eliminó el filtro por change de la consulta SQL de `listEvents`, manteniendo el defecto semántico original. E11/E14/E15 se adaptaron al helper `redactForWeb`. Las demás mutaciones conservan las expresiones del verificador. Los tres ficheros mutados volvieron a ser idénticos byte a byte al worktree; la copia restaurada pasó de nuevo sus 24 tests y después se retiró la copia temporal.

[V] Script y salidas: `/tmp/fabweb-arreglos-mutaciones.sh`, `/tmp/fabweb-arreglos-mutaciones.log`, `/tmp/fabweb-arreglos-mut-baseline.log`, `/tmp/fabweb-arreglos-mut-restaurada.log`. Son evidencia temporal; la tabla anterior conserva el resultado en este informe.

### Lo que no hice y límites

- [V] **No se hizo H4**: la función `redact` permanece idéntica a `eec5a55`, comprobada por comparación de su fuente. No se añadieron formatos de secreto a la política común. H5 solo añade defensas de presentación web.
- [V] No se cambiaron los tests de red/corpus ajenos ni se ocultaron sus fallos; no hubo push ni escrituras en GitHub.
- [V] No se repitieron las 62 mutaciones originales: se cubrieron las 14 pedidas y las cuatro capas adicionales indicadas. No se amplió el alcance a S06/S11/S12 ni al resto de hallazgos no encargados.
- [V] La nueva prueba del socket real usa `/proc/net/tcp` en Linux. No se verificaron otras plataformas ni un lector de pantalla.
- [V] Sigue vigente H9: un lector SQLite puede recuperar SHM tras un crash; esto no equivale a alterar la base ni el WAL. No se cambió esa recuperación ni el fallo cerrado cuando falta SHM.

## Ronda final

[V] Se leyó completa la «Segunda pasada» de Fable. Baseline `7378614`, worktree limpio. Commit local **`77f0dfb` — `fix(evidencia): acotar el recorte y cubrir el coste web (N1-N3)`**, sin push ni `Co-Authored-By`.

### Cambios

- [V] **N1 y N2:** se sustituyó `/\S+$/u` por un recorrido hacia atrás de como máximo **4096 caracteres**, sin regex; `trim()` detecta los espacios de cada carácter. Si no encuentra espacio conserva el prefijo anterior a esos 4096 caracteres. Si el corte termina en salto de línea, conserva todo el prefijo. No se amplió la política de redacción (`src/evidence.ts:39@77f0dfb`).
- [V] Test de una única línea sin espacios de **512 KiB**: antes del arreglo devolvía 0 caracteres y falló la aserción; ahora devuelve **258048** caracteres y el resultado no está vacío (`tests/web.test.ts:261@77f0dfb`; `/tmp/fabweb-final-rojo-n2.log`).
- [V] Dos tests del corte justo en **LF y CRLF**, con una línea sin espacios hasta el salto, comprueban igualdad con el prefijo de **262144 caracteres**, truncado activo y texto no vacío. No hay aserciones sobre tiempo, pausas ni umbrales de reloj (`tests/web.test.ts:269@77f0dfb`). No se volvió a ejecutar la regex defectuosa sobre el caso lento antes de cambiarla; el límite de trabajo se comprueba leyendo el bucle y sus condiciones.
- [V] **N3:** tests directos de `activityCosts` y `changeCost`, con metadata en disco para la suma: intento que falta → desconocido; coste `null` → desconocido; cero explícito → cero conocido. Para una activity fallida con tres intentos, `[0,0,0]` suma 0 sin exigir un cuarto intento; `[0,0]` o `[0,null,0]` dejan el total desconocido (`tests/web.test.ts:283@77f0dfb`). No se cambió el cálculo, que ya daba estos resultados.
- [V] **N5 aceptado:** no se modificaron `listEvents`, `countEvents` ni su API en esta ronda. Tampoco se tocaron N4, H4 ni otros hallazgos fuera del encargo.

### Validación

| Comando / comprobación | Resultado |
|---|---|
| `bun test tests/web.test.ts -t N2`, antes del cambio | [V] Rojo funcional: esperado 258048, recibido 0. |
| `bun test tests/web.test.ts`, tras el cambio | [V] **27 pass, 0 fail**, 174 aserciones; 2,49 s. Incluye los seis tests añadidos. |
| `./node_modules/.bin/tsc --noEmit -p .` | [V] Salida 0 antes del commit. |
| `bun test tests`, commit estable `77f0dfb` | [V] **1449 pass, 2 skip, 0 fail**, 8216 aserciones; 380,22 s. T2 pasó en esta ejecución. |

[V] Se repitieron **E19, E20 y E22** en una copia temporal de `git archive 77f0dfb`, sin modificar el worktree. **Las tres mueren**, ninguna sobrevive ni queda sin aplicar. E19 falla ante el intento ausente y la activity fallida; E20, ante `null`; E22, al exigir indebidamente un cuarto intento. La copia pasa los tres tests N3 antes y después de las mutaciones, y `src/evidence.ts` queda idéntico byte a byte al worktree. Se retiró la copia temporal.

[V] Evidencia temporal: `/tmp/fabweb-final-mutaciones.sh`, `/tmp/fabweb-final-mutaciones.log`, `/tmp/fabweb-final-mut-base.log`, `/tmp/fabweb-final-mut-restaurada.log`. No se repitió la tanda completa de mutaciones ni se hicieron cambios ajenos a N1/N2/N3.

[V] Suite completa sin fallos en esta ronda; no fue necesario repetir tests externos. Salida: `/tmp/fabweb-final-suite.log`. El worktree sigue limpio en `77f0dfb`, sin push.

<!-- FIN -->
