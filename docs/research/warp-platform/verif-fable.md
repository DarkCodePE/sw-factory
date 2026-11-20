# Verificación de `fab web` F0 y F1 (Fable 5.2)

- **Qué se verificó:** `feat/fab-web` en `eec5a55`, seis commits sobre `origin/release/0.1.0-rc.12` (base `ff52f0b`). El SHA era el mismo antes y después de cada corrida larga. [V]
- **Worktree:** limpio al empezar y al acabar (`git status --short` vacío). No hice commits, push ni escrituras en GitHub. No lancé subagentes. [V]
- **Marcas:** [V] = ejecutado o leído en la línea citada; [I] = inferido.

## Veredicto

**Fusionable con arreglos.** No hay hallazgos altos. Hay dos medios que conviene cerrar antes de fusionar (H1 y H2) y varios huecos de test en defensas de seguridad (H3).

Lo que sí se sostiene, comprobado con ataques reales:

- El modo `readonly` no crea, migra ni corrompe la base, ni con el pool escribiendo ni tras un crash. [V]
- El filtro de `Host`, el 405, el path traversal, los symlinks y el escapado resisten todos los ataques que probé. [V]
- El árbol **no está invertido**: respeta `parent_activity_id`. [V]
- Los contadores de la bandeja cuadran con `fab inbox`. [V]

## Hallazgos

| Id | Sev. | `ruta:línea` | Problema y evidencia | Arreglo propuesto |
|---|---|---|---|---|
| H1 | Media | `src/store.ts:280` y `src/store.ts:331` | **El lector de solo lectura puede hacer fallar la apertura de un escritor.** Con un escritor que abre, escribe y cierra en bucle y un lector `readonly` abriendo sin parar, el escritor recibe `SQLiteError: database is locked at new Store (src/store.ts:331)`: 9 de 1810 aperturas y 8 de 1803 en dos corridas. Controles: sin lector, 0 de 826; con un lector en modo escritor, 0 de 1865. La causa es que `PRAGMA journal_mode = WAL` corre antes que `busy_timeout` (orden anterior a esta rama), pero quien lo dispara es el lector nuevo. Contradice «no bloquea nada». Comando: `MODE=readonly bun store-carrera.ts <worktree> 10`. [V] | Poner `PRAGMA busy_timeout = 5000` antes de `journal_mode` en el constructor escritor. Lo probé en una copia: 0 errores del escritor en 1501 aperturas. Toca la ruta del escritor, así que es decisión del dueño (ver abajo). |
| H2 | Media | `src/evidence.ts:75`, `src/improve.ts:155`, `src/improve.ts:165` | **`improve` cambia de comportamiento con metadata de más de 256 KiB.** `activityMetadata` devuelve `null` si el fichero se truncó. Con un `workerReport` de 300 KiB, `armCost` pasa de `0.1` a `null` (coste conocido → desconocido) y `armWorkerReport` pasa del informe a `null`. El informe del implementador dice que la semántica se conserva; en este caso no. Comando: `bun refactor.ts <worktree> <base>`. [V] | `improve` debe leer la metadata sin el tope de presentación (el tope es de la web). Añadir test con metadata grande. |
| H3 | Media | `tests/web.test.ts:84`, `tests/web.test.ts:35` | **Defensas sin test que las proteja** (detalle en Mutaciones). Las más serias: escuchar en `0.0.0.0` no rompe ningún test; abrir la base WAL como escritor tampoco; la CSP se puede debilitar a `script-src * 'unsafe-inline'`; el árbol se puede invertir. La aserción de `tests/web.test.ts:84` es vacía: ese `INSERT` falla también en un Store escritor (`NOT NULL constraint failed: events.workstream_id`). [V] | Un test por cada una: dirección de escucha, `INSERT` válido rechazado con WAL vivo, CSP completa, árbol con padre e hija, comillas en atributo. |
| H4 | Baja | `src/evidence.ts:59` | **Redacción: formatos que salen sin redactar** por HTTP: `Authorization: Basic`, `Cookie:`, `glpat-`, `npm_`, `passwd=`, `pwd:`, `--token X`, `curl -u u:p`, `private_key_id:`, bloque PGP, y claves JSON `authorization` y `pass`. Son huecos de `redact`, que ya existían en `manifest.ts`; la web los hereda. Comando: `ataques.sh`. [V] | Tarea aparte para ampliar `redact`. No es de este cambio. |
| H5 | Baja | `src/evidence.ts:39`, `src/evidence.ts:29` | **Dos huecos de redacción propios de la web.** (a) Un PEM sin cierre dentro de un `.json` no truncado no se redacta: la regla de PEM incompleto solo corre en la rama de texto. (b) Un secreto partido por el corte de 256 KiB sale a medias (`ghp_SECRETOENELCORT`, 19 de 36 caracteres), porque el prefijo ya no encaja en el patrón. [V] | (a) Aplicar la regla de PEM incompleto también a los valores JSON. (b) Redactar antes de cortar, o descartar la última palabra tras el corte. |
| H6 | Baja | `src/evidence.ts:13`, `src/evidence.ts:21` | **Otros cambios de `improve` frente a la base**, menos probables: metadata que es symlink ahora lanza (`Symlink de evidencia rechazado`) en vez de leerse; `stateDir` inexistente ahora lanza `ENOENT` en vez de devolver `null`; JSON roto o `null` ahora da `null` en vez de lanzar; el `workerReport` sale redactado otra vez (`password=hunter2` → `password=[REDACTED]`). `armCost` no captura esas excepciones. [V] | Decidir si `improve` debe tolerarlas; si no, documentarlo y cubrirlo con test. |
| H7 | Baja | `src/web.ts:75` | **El detalle de un change carga todos los eventos del workstream** y filtra en JS; la timeline no tiene tope. Con 58 MB de eventos de otro change, el detalle tarda 51 ms; el change con esos eventos devuelve 50 MB de HTML en 780 ms, cada 2 s por pestaña. [V] | Tope de eventos en la timeline con aviso. Una consulta por change sería un método nuevo del Store: fuera de alcance. |
| H8 | Baja | `src/store.ts:292` | **Peticiones que fallan durante la apertura o el cierre del escritor.** En la misma prueba de H1 el lector falló 509 de 19 130 veces (488 `database is locked`, 21 `WAL sin índice compartido`). Cada fallo es un 500 en esa petición; el sondeo lo ignora y reintenta. Falla cerrado, sin crear nada. [V] | `busy_timeout` en la conexión de lectura, o un reintento. |
| H9 | Info | `src/store.ts:280` | Tras un crash del escritor (SIGKILL con WAL y SHM en disco), el lector lee bien y **reescribe `fabrica.db-shm`** (cambian mtime y contenido). `fabrica.db` y el WAL no cambian. Es la recuperación normal de SQLite para un lector WAL. [V] | Ninguno; anotarlo como límite de «solo lectura». |
| H10 | Info | `src/web.ts:54` | Los contadores agrupan por `reviewStatus === 'awaiting'` antes que por `status`: una activity bloqueada y en espera cuenta como «Espera revisión». La suma coincide con `fab inbox`. [V] | Ninguno. |

### Decisión para el dueño (H1)

1. **Mover `busy_timeout` delante de `journal_mode` en el escritor (recomendada).** Una línea; elimina el fallo en mi prueba. En contra: toca la ruta del escritor, que el brief pedía no cambiar; hay que correr la suite entera.
2. **Dejar el escritor y dar reintentos al lector.** No toca el escritor. En contra: no arregla el fallo del escritor, solo los 500 del lector (H8).
3. **Fusionar así y anotarlo como riesgo.** Con un sondeo cada 2 s la ventana es pequeña. En contra: un `fab` de CLI puede fallar con «database is locked» sin causa visible mientras hay una pestaña abierta.

## Comprobaciones del brief

### 1. Solo lectura del Store

- **Ruta del escritor:** el diff de `src/store.ts` solo añade un import, la opción, dos funciones y dos líneas en el constructor. Sin `readonly`, la apertura es la misma expresión de antes y el resto no cambia. [V]
- **Concurrente con escritor vivo:** 2526 aperturas de lectura mientras un escritor hacía 2187 escrituras con checkpoints. 0 errores en ambos lados, ningún retroceso de datos, `integrity_check: ok`, y ningún `INSERT` aceptado por el lector. [V]
- **Base cerrada:** inodo, tamaño, mtime y hash idénticos tras leer. La copia en memoria rechaza `INSERT`, `CREATE TABLE`, `VACUUM` y `PRAGMA user_version`. Los bytes 18 y 19 del fichero siguen en `2 2`. [V]
- **Crash, WAL sin SHM, esquema antiguo, fichero basura y fichero vacío:** todos fallan cerrado o leen sin tocar la base (salvo H9). [V]
- **Base de 58 MB:**

  | Caso | Tiempo por petición | Memoria |
  |---|---|---|
  | Cerrada (copia entera en memoria) | 24 ms de mediana en la bandeja | El proceso sube de 183 MB a un pico de 497 MB tras las pruebas |
  | Con escritor vivo (SQLite `readonly`) | menos de 1 ms en la bandeja | Sin copia |

  El coste con base cerrada crece en proporción al tamaño. [V]

### 2. Seguridad HTTP (ataques reales contra `fab web --port 0`)

- **Escucha:** solo `127.0.0.1:<puerto>`. [V]
- **`Host`:** 403 para host ajeno, sin puerto, puerto distinto, sufijo (`127.0.0.1:<p>.evil.example`), mayúsculas, `[::1]`, `0.0.0.0`, lista con coma, vacío y URL absoluta con host ajeno. `X-Forwarded-Host` se ignora. [V]
- **Métodos:** 405 con `Allow: GET, HEAD` para POST, PUT, PATCH, DELETE, OPTIONS, TRACE, CONNECT y PROPFIND. [V]
- **Traversal:** `%2e%2e%2f`, doble codificación (`%252e`), `%00`, UTF-8 sobrelargo y `%ZZ` dan 400; `/fabrica.db`, `/runs/...` y `//etc/passwd` dan 404. `/changes/%2e%2e` da 200 porque la URL se normaliza a `/` (la bandeja): no filtra nada. [V]
- **Symlinks:** un `diff.patch` que apunta fuera y un `runs/<change>` que es symlink a un directorio de fuera no filtran contenido; el coste del change sale «No medido». [V]
- **XSS:** `<script>` en título, descripción, objetivo, log, error y query string sale escapado; cada página tiene un solo `<script>`, el del sondeo. [V]
- **Disco:** tras todos los ataques, el árbol de `stateDir` es idéntico en nombres, inodos, tamaños y mtimes. [V]

### 3. Refactor de evidencia

Comparé `armCost` y `armWorkerReport` de la base y de la rama sobre 16 casos. Coste 0, coste `null`, `usage.costUsd` antiguo, intentos que faltan y fichero ausente dan lo mismo: **desconocido sigue siendo `null` y cero sigue siendo `0`**. Difieren los casos de H2 y H6. `readEgressProbe` y `redact` se movieron sin cambios. [V]

### 4. Corrección de la vista

- **Árbol:** `Store.resolveReview` inserta la activity siguiente con el `change_review` aprobado como padre (`src/store.ts:1098`). Con un flujo real, `investigation.parentActivityId` es el id del `change_review`, y la web la pinta un nivel por debajo (`src/web.ts:28`). La captura `change-1440-dark.png` es correcta. [V]
- **Bandeja:** 3 items en la web y 3 en `fab inbox` sobre los mismos datos. [V]

### 6. Recorrido con agent-browser (sesión `fabverif`, `--no-sandbox`)

Bandeja, change, activity, changes y workstreams en 1440 y 390 px, tema oscuro en móvil. Sin desbordamiento horizontal a 390 px. La búsqueda y el filtro por estado funcionan. Un change añadido desde otro proceso apareció por sondeo sin recargar. Consola y errores vacíos. Solo datos sintéticos. [V]

## Mutaciones

62 mutaciones en una copia temporal: **29 mueren, 33 sobreviven**, ninguna sin aplicar. Tras la tanda, `diff -rq` entre la copia y el worktree no da diferencias. [V]

**Sobreviven por hueco de test:**

| Mutación | Qué quedó sin proteger |
|---|---|
| W14 | Escuchar en `0.0.0.0` |
| S03 | Abrir la base WAL sin `readonly` |
| S09 | `deserialize` escribible |
| W10, W11 | CSP con `'unsafe-inline'` o `script-src *` (el test solo mira `default-src 'none'`) |
| W05 | Escapado sin comillas (inyección en atributo) |
| W06, E11, E14, E15 | Cada capa de redacción por separado; W06 deja sin redactar los campos de la base |
| W17 | Árbol invertido (el test solo tiene una activity) |
| W21, W22, W25 | Bandeja sin filtro de workstream, contador por `status`, eventos de otros changes |
| E08 | Evidencia que no es fichero regular |
| E09 | Valor del tope (el test escala con la constante) |
| E18 | Metadata truncada (es H2) |
| E23, E24, E25 | Coste: `usage` con reintentos, change sin activities → `0`, `NaN`. Estas condiciones ya existían en `improve.ts` sin test |
| S06, S11, S12 | Base que cambia durante la copia, base que no es fichero, cabecera SQLite |
| W03 | `Host` ausente aceptado (difícil de probar con `fetch`) |

**Sobreviven por ser equivalentes o redundantes:** W15 (Bun ya quita el cuerpo en HEAD), W18, E01 y E02 (se cubren entre sí), E04 y E06 (E05 y E07, que quitan dos y tres capas, sí mueren), E16, S07 y S10 (dos comprobaciones del WAL que se cubren entre sí).

**Mueren:** filtro de `Host` (W01, W02), escapado HTML (W04), 405 (W07, W08), CSP ausente (W09), `nosniff` (W12), regex del id (W13), Store escritor en la web (W16), coste `null` como cero (W19), symlink por HTTP (W20, E03, E05, E07), filtros (W23, W24), truncado y PEM incompleto (E10, E12), claves JSON en texto (E13), semántica de coste (E17, E19 a E22), y el Store de lectura (S01, S02, S04, S05, S08).

## Suite

| Comando | Resultado |
|---|---|
| `tsc --noEmit -p .` | Sale con 0. [V] |
| `bun test tests` en el worktree | 1421 pass, 2 skip, **1 fail**, 430 s. [V] |
| `bun test tests/t2-cualificacion.test.ts` a solas | 4 pass, 0 fail, 161 s. [V] |

- El fallo fue `T2 corpus` en `tests/t2-cualificacion.test.ts:111`: `git clone` de GitHub cortado (`RPC failed; curl 92 HTTP/2 stream`). Es **red**, no carga ni código. El test importa `parseSuite` de `src/improve.ts`, que la rama no toca. [V]
- `execute-network` y `egress-probe` pasaron en mi corrida, así que no reproduje sus fallos. `execute-network` no importa código cambiado. [V] `egress-probe` solo se relaciona con `readEgressProbe`, que se movió sin cambios. [I]
- Mi suite corrió a la vez que otras pruebas mías, con la máquina cargada.

## Contraste con el informe del implementador

Lo leí después de fijar mis hallazgos.

- **Coincide:** rutas, cabeceras, solo lectura en disco, fallo cerrado con WAL sin SHM, que la TUI no se tocó, y que la copia en memoria no se había medido con bases grandes (medida arriba).
- **No se sostiene:** «`activityCosts` y `changeCost` conservan la semántica» es cierto para desconocido frente a cero, pero no para metadata grande, symlinks ni `stateDir` ausente (H2, H6).
- **No mencionó:** el fallo del escritor por el lector (H1), que pedía revisar «con estrés» y es justo lo que apareció; la aserción vacía del `INSERT`; el coste de cargar todos los eventos (H7).
- **Sus tres fallos de suite:** confirmo el de T2 como red. Los otros dos no los pude reproducir.

## Lo que no pude comprobar

- H1 con un pool real de larga vida y una pestaña sondeando cada 2 s: solo medí el bucle extremo, así que no sé la frecuencia en uso normal.
- Otras plataformas: la comprobación por `/proc/self/fd` solo existe en Linux.
- Carreras hostiles entre `lstat` y `open` en la evidencia, y sustitución de la base durante la copia.
- El contraste WCAG y la accesibilidad con lector de pantalla; solo miré desbordamiento y tema.
- El tema claro en móvil y las veinte capturas del implementador una a una (abrí `change-1440-dark.png`).
- Bases mayores de 58 MB.
- Que `git archive` de la base reproduzca exactamente el `improve` anterior en un entorno real: comparé las funciones, no una corrida completa de `fab improve`.

## Evidencia

Scripts y salidas en `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-fabweb/c8a1d0e6-6403-4761-bad3-41c8418ca384/scratchpad/exp/` (`store-ro.ts`, `store-carrera.ts`, `grande-http.ts`, `refactor.ts`, `seed.ts`, `ataques.sh`, `mutaciones.sh` y sus `.out`). Es un directorio de sesión: se pierde con una limpieza de `/tmp`. Las copias de mutación y los datos sintéticos están borrados.

## Segunda pasada

- **Qué se verificó:** `feat/fab-web` en `7378614`, tres commits sobre `eec5a55`: `ed48297` (H2, H6), `3c0d261` (H1, H8) y `7378614` (H3, H5, H7). El SHA era el mismo antes y después de la suite. [V]
- **Reglas:** las mismas. Worktree limpio al empezar y al acabar; mutaciones en una copia temporal ya borrada; sin commits, push ni subagentes. [V]
- Leí la sección «Arreglos tras verificación» de `impl-codex.md` después de fijar mis hallazgos.

### Veredicto

**Fusionable con un arreglo.** H1, H2, H3, H5, H6, H7 y H8 quedan cerrados. El arreglo de H5 introduce un hallazgo nuevo de severidad alta (N1): una regex cuadrática que deja `fab web` bloqueado 30 s por petición con un log concreto. El arreglo es de una línea y lo probé en una copia.

### Estado de los hallazgos anteriores

| Id | Estado | Evidencia |
|---|---|---|
| H1 | **Cerrado** | `store-carrera.ts` sin cambios, dos corridas: 0 errores del escritor en 1679 y 1583 aperturas (antes 9 de 1810). `busy_timeout` va ahora delante de `journal_mode` (`src/store.ts:334`). La mutación que restaura el orden anterior muere por el test H1 de `tests/web-locks.test.ts:20`. [V] |
| H2 | **Cerrado** | `src/improve.ts` es idéntico a la base `ff52f0b` (diff vacío). `refactor.ts` sin cambios: los 16 casos dan igual, incluido el de 300 KiB. [V] |
| H3 | **Cerrado** | Las 14 mutaciones que sobrevivían por hueco de test y pedí cubrir mueren ahora (tabla abajo). La aserción vacía del `INSERT` usa ya un `INSERT` válido y exige el error `readonly`. [V] |
| H5 | **Cerrado, con regresión (N1, N2)** | El PEM sin cierre en JSON ya no sale (`SECRETORUNPEM` desaparece de mis ataques) y el token partido tampoco (`cola visible` vacía). [V] |
| H6 | **Cerrado** | Mismo motivo que H2: symlink, `stateDir` inexistente, JSON roto, JSON `null` y `workerReport` sin redactar se comportan como en la base. [V] |
| H7 | **Cerrado** | La timeline pide solo los últimos 200 eventos del change y cuenta los omitidos. Con 12 500 eventos ajenos de 4 KB, la consulta tarda 4 ms (antes 81 ms cargando y filtrando). [V] |
| H8 | **Cerrado** | En las mismas dos corridas, 0 errores del lector en 16 505 y 17 726 lecturas (antes 509 de 19 130). Los dos lectores llevan `busy_timeout` (`src/store.ts:286`, `src/store.ts:316`). [V] |
| H4 | Sin cambios, como se acordó | `redact` no se tocó; los formatos sin cubrir siguen saliendo. Tarea aparte. [V] |
| H9, H10 | Sin cambios | Informativos. |

### Hallazgos nuevos

| Id | Sev. | `ruta:línea` | Problema y evidencia | Arreglo propuesto |
|---|---|---|---|---|
| N1 | **Alta** | `src/evidence.ts:39` | **La regex `/\S+$/u` del recorte es cuadrática y bloquea el servidor.** Con un log cuyos primeros 256 KiB son una sola línea sin espacios y el corte cae en un salto de línea, `readEvidence` tarda 31 s. Por HTTP: `GET /activities/<id>` tardó 30,3 s, y una petición a la bandeja lanzada mientras tanto tardó 29,3 s (antes, 2 ms). El servidor es de un solo hilo y la página se vuelve a pedir cada 2 s. El contenido del log lo controla el agente, es decir, es texto no confiable. Mi propio caso de H5 (token `ghp_` tras un salto de línea en el corte) también tarda 30 s. Comandos: `bun p2-nuevo.ts <worktree>` y `p2-dos.sh`. [V] | Recorrer hacia atrás desde el final, sin regex y con tope: `const floor = Math.max(0, text.length - 4096); let i = text.length; while (i > floor && !/\s/.test(text[i - 1]!)) i--; text = text.slice(0, i);`. Probado en una copia: todos los casos en 4 ms o menos, y `tests/web.test.ts` sigue en 21 pass. Añadir un test con ese log que no dependa del reloj (por ejemplo, contando el texto devuelto). |
| N2 | Media | `src/evidence.ts:39` | **Un log truncado sin ningún espacio se muestra vacío.** Con 512 KiB de una sola línea (JSON minificado, base64), la página enseña 0 de 262 144 caracteres y solo el aviso «Archivo truncado». Antes del arreglo se veían los 256 KiB. [V] | El mismo arreglo de N1: con el tope de 4096 se muestran 258 048 caracteres. |
| N3 | Baja | `src/evidence.ts:90`, `src/evidence.ts:98` | **El coste de la web se quedó sin tests de su semántica.** Al volver `improve` a su código original, `activityCosts` y `changeCost` solo los usa la web, y los tests de `armCost` ya no los ejercitan. Sobreviven ahora E19 (falta un intento), E20 (coste `null` sumado como cero) y E22 (intento de una activity fallida), que en la primera pasada morían. Es justo la distinción entre desconocido y cero. [V] | Tests de `changeCost` en `tests/web.test.ts` para esos tres casos, o reutilizar el oráculo de `tests/fixtures/improve-evidence-base.ts`. |
| N4 | Info | `src/evidence.ts:98`, `src/improve.ts:164` | El coste tiene ahora dos implementaciones: la de `improve` (lee completo) y la de la web (tope de 256 KiB). Para metadata grande, `improve` dirá un coste y la web «No medido». Es consecuencia aceptada de cerrar H2. [I] | Ninguno ahora; anotarlo. |
| N5 | Info | `src/store.ts:1329`, `src/store.ts:1338` | `listEvents` gana un tercer parámetro opcional y aparece el método público `countEvents`. Es API nueva del Store, que el encargo original pedía no ampliar; no hay tablas, columnas, índices ni migraciones. Los llamadores existentes (`src/cli.ts:401`, `src/tui.ts:100`) se comportan igual. [V] | Que el dueño lo acepte como parte de H7. |
| N6 | Info | `tests/web-locks.test.ts:20` | El test de H1 es una carrera: con el código correcto nunca falla, pero con el defecto podría pasar por azar. En mi mutación murió a la primera (6,6 s). [I] | Ninguno; es el mejor test posible sin inyectar fallos. |

### `listEvents`, `countEvents` y `busy_timeout`

- **Compatibilidad:** `listEvents(ws)`, `listEvents(ws, 3)` y `listEvents(ws, -1)` devuelven lo mismo que antes; pasar `undefined` como tercer argumento equivale a no pasarlo. [V]
- **Filtro:** con change, devuelve solo sus eventos, los últimos N en orden ascendente. Un change de otro workstream, `''` o `null` dan 0 filas, sin error. `countEvents` de un workstream inexistente lanza `not_found`. [V]
- **Rendimiento:** no hay índice sobre `events` (`SCAN events`), pero con 12 505 eventos de 4 KB las cuatro consultas tardan entre 1,4 y 4 ms. [V]
- **Escritor:** tras el cambio de orden, `busy_timeout = 5000`, `journal_mode = wal` y `foreign_keys = 1` siguen activos. [V]
- **Lectores:** `PRAGMA busy_timeout` se admite en la conexión `readonly` y en la copia deserializada, y no escribe en disco: tras la carrera queda solo `fabrica.db`, con `integrity_check: ok`. [V]
- **Ataques HTTP:** repetí `ataques.sh` sin cambios. `Host`, métodos, traversal, symlinks, XSS, cabeceras, árbol, bandeja y disco dan lo mismo que en la primera pasada; solo cambian las dos fugas de H5, que desaparecen. [V]

### Mutaciones

74 mutaciones (las 62 anteriores adaptadas más 12 sobre el código de los arreglos): **55 mueren, 19 sobreviven**, ninguna sin aplicar. Tras la tanda, `diff -rq` entre la copia y el worktree no da diferencias. [V]

- **Las 12 nuevas mueren todas:** orden de `busy_timeout` del escritor, `busy_timeout` de cada lector, recorte del token, PEM incompleto en JSON, tope de la timeline, `countEvents` sin filtro, omitidos a cero o sin `Math.max`, y `listEvents` sin filtro, con los primeros en vez de los últimos, o sin invertir.
- **De las 33 que sobrevivían, mueren ahora 17:** W05, W06, W10, W11, W14, W17, W21, W22, W25, E08, E09, E11, E14, E15, E18, S03 y S09.
- **Siguen vivas por equivalentes o redundantes (8):** W15, W18, E01, E02, E04, E06, E16 y la pareja S07/S10.
- **Siguen vivas por hueco de test (8):** W03 (`Host` ausente), E23, E24, E25 (coste: `usage` con reintentos, sin activities, `NaN`), S06, S11, S12 (base que cambia durante la copia, base que no es fichero, cabecera SQLite). No se pidió cubrirlas.
- **Sobreviven y antes morían (3):** E19, E20 y E22. Es N3.

### Suite

| Comando | Resultado |
|---|---|
| `tsc --noEmit -p .` | Sale con 0. [V] |
| `bun test tests` en el worktree | **1443 pass, 2 skip, 0 fail**, 382 s. [V] |
| Tests de web en la copia, antes de mutar | 32 pass, 0 fail. [V] |

La suite salió verde entera, incluido T2. Corrió a la vez que mis pruebas de carrera, con la máquina cargada.

### Contraste con «Arreglos tras verificación»

- **Coincide:** `improve.ts` idéntico a la base; orden de los PRAGMA; los tres `busy_timeout`; timeline de 200 con el número exacto omitido; compatibilidad de `listEvents`; sus 18 mutaciones muertas; H4 sin tocar.
- **No mencionó:** el coste de la regex de recorte (N1) ni que un log sin espacios queda vacío (N2); su test de H5 usa un prefijo de espacios, que es el caso rápido. Tampoco que el coste de la web pierde la cobertura que le daban los tests de `improve` (N3).
- **Su fallo de T2 en la suite:** en mi corrida T2 pasó, así que no lo reproduje.

### Lo que no pude comprobar

- N1 con logs reales de la fábrica: no sé con qué frecuencia un log real tiene una línea larga sin espacios que cruce el corte. El caso sintético es determinista.
- El recorrido con agent-browser no lo repetí: los cambios de vista se limitan al aviso de eventos omitidos, cubierto por test y por `ataques.sh`.
- Lo ya listado en la primera pasada: otras plataformas, carreras hostiles sobre la evidencia, accesibilidad y bases de más de 58 MB.

### Evidencia

Scripts nuevos en el mismo directorio de sesión `.../scratchpad/exp/` (`p2-nuevo.ts`, `p2-dos.sh`, `mutaciones2.sh`) y salidas en `.../scratchpad/p2/` (`nuevo.out`, `dos.out`, `carrera.out`, `refactor.out`, `mutaciones.out`, `ataques.out`, `arreglo-n1.out`, `suite.txt`). Se pierden con una limpieza de `/tmp`.

<!-- FIN -->
