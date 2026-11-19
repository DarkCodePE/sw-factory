# Qué falta en fab para replicar Warp Factories

- **Fecha:** 2026-11-19. **Autor:** Fable 5.2 (goldfish analista). **Brief:** `BRIEF-FALTANTES-FABLE.md`.
- **Fuentes:** `recorrido-codex.md` (principal), `catalogo-fable.md`, `BRIEF-WEB-F2-CODEX.md`, `BRIEF-WEB-F3-CODEX.md`, `impl-f3-codex.md`. `impl-f2-codex.md` no existe todavía.
- **Código leído:** worktree `sw-factory-fabweb`, rama `feat/fab-web`, commit `77f0dfb`. Las rutas sin prefijo son relativas a ese worktree. Lo de F3 se comprobó en `sw-factory-webf3` (`48c238f`).
- **Cola leída:** `task.json` de `origin/release/0.1.0-rc.12` (45 tareas, `updated` 2026-11-17, ids hasta T45). La copia del checkout principal está atrasada (35 tareas, hasta T35); mandó la de la release.
- **Marcas:** **[V]** verificado leyendo la línea citada o ejecutando el comando; **[I]** inferido.
- Solo lectura: no se tocó código ni `task.json`, no se abrió Warp, el navegador ni las carpetas de capturas.

## 0. Tres hechos que difieren del brief

| Qué dice el brief | Qué hay | Evidencia |
|---|---|---|
| PR #80 (F0/F1) sin fusionar | **Fusionado.** | [V] `gh pr list --state all`: #80 `MERGED`. |
| F2 en curso | El worktree `sw-factory-webf2` está en `77f0dfb`, sin commits propios ni cambios sin confirmar. No hay informe. **F2 está encargada, sin código.** | [V] `git log` y `git status` del worktree. |
| F3 en curso | Implementada (4 commits) y con informe; **falta la verificación independiente**. La suite completa no salió verde (2 fallos que pasan aislados). | [V] `impl-f3-codex.md`; `sw-factory-webf3/src/web.ts:108`, `src/store.ts:1338`. |

Además: F0 a F3 **no tienen tarea en `task.json`**, y T43 figura `blocked` aunque el PR #79 («Mandate y enlace del PR (T43)») está fusionado [V]. La cola necesita ponerse al día antes de añadir lo nuevo (§3 propone T46 a T48 para registrar F0 a F3).

## 1. Tabla de módulos

Los 35 módulos son las filas de `recorrido-codex.md` §2, en su orden. «Tarea» remite a §3.

| # | Módulo | Objetivo | Estado en fab | Evidencia | Tarea |
|---|---|---|---|---|---|
| 1 | Home | Ver qué espera respuesta y volver a ello. | **hecho** (lectura). Faltan «marcar resuelto», búsqueda y agrupación por día. | [V] `src/web.ts:52` (bandeja con contadores), `src/store.ts:680` (`inbox`), `src/cli.ts:266`. | T49 |
| 2 | Runs | Encontrar trabajo por estado y origen. | **parcial.** Hay filtro por workstream, estado y texto del título. Faltan orden, fuente, creador, fecha y filtros rápidos. | [V] `src/web.ts:59-63`; `src/store.ts:573` (`listChanges` solo por workstream). | T49 |
| 3 | Detalle de run | Seguir la conversación y diagnosticar. | **parcial.** Hecho: árbol de activities, coste, línea de tiempo de eventos, log, `run.json`, diff, veredicto y metadata. En curso (F2): responder y decidir. Falta: turnos, transcript estructurado, parar, en vivo. | [V] `src/web.ts:23-35` (árbol), `:65-76` (change), `:77-87` (activity); `src/evidence.ts:95`, `:103`. | T47, T51, T54 |
| 4 | New Chat / New run | Crear trabajo desde la web. | **parcial:** la mutación existe, sin superficie web. F2 lo excluye. | [V] `src/store.ts:488` (`addSignal`), `:509` (`triageSignal`); `src/cli.ts:244`, `:255`. | T50 |
| 5 | Dashboard | Productividad, gasto y evaluaciones. | **en curso** (F3): ciclo, intervenciones, estados y coste. La pestaña Scorers **falta**. | [V] `sw-factory-webf3/src/web.ts:108`, `src/store.ts:1338`, `:1349`. | T48, T65 |
| 6 | Blueprint | Ver y ajustar el flujo de etapas, transiciones y gates. | **parcial:** el flujo existe en código, sin vista. No hay propuesta de cambio de flujo. | [V] `src/enums.ts` (`REVIEWABLE_KINDS`, `REVIEW_FOLLOW_UP`); `src/store.ts:149-150` (flags de aprobación), `:594` (`allowGate`). | T53 |
| 7 | Workers | Ver quién hace el trabajo. | **parcial:** los roles son tipos de activity y validadores, no entidades. Un adaptador por workstream. | [V] `src/enums.ts` (`ActivityKind`: 4 tipos); `src/profile.ts:21-22`; `src/store.ts:148` (columna `agent`). | T52, T57 |
| 8 | Editor de worker | Cambiar prompt, recursos y ejecución de un rol. | **parcial:** perfil con plantillas por rol y digest, solo por CLI. Un solo `model` y `harness` para todo el perfil. | [V] `src/profile.ts:10-18`, `:35`, `:75`; `src/profile-cli.ts:12-25`; `src/pool.ts:186`. | T57, T58 |
| 9 | Automations | Lanzar trabajo por horario o evento. | **falta.** | [V] `grep -rnE "cron\|schedule" src`: solo temporizadores de `script-runtime` y reglas de `threatmon`. | T68 |
| 10 | Webhooks | Recibir entregas que una automation filtra. | **falta.** La entrada es por sondeo. | [V] `grep -rn webhook src`: vacío; `src/admission/github.ts:15` (`pollIssues`), `:93` (`pollComments`). | T69 |
| 11 | Scorers | Aplicar una rúbrica de calidad a ejecuciones. | **falta.** Análogo: los validadores juzgan el change, bloquean el merge y no muestrean. | [V] `src/validators/verdict.ts:12`, `src/validators/publish.ts:29`. | T63, T64, T65 |
| 12 | Self-improvement | Proponer mejoras de la propia factory para revisión. | **parcial:** experimento pareado baseline contra candidato, por CLI. Sin disparo por umbral ni vista. | [V] `src/improve.ts:71`, `:316`; `src/improve-cli.ts:16-30`. | T62, T67 |
| 13 | Benchmarks | Repetir casos y comparar variantes. | **parcial:** suites con splits y corridas. Sin matriz de modelos, sin «añadir run» y sin vista. | [V] `src/improve.ts:15-18`, `:26-29`; carpeta `bench/`. | T62, T66 |
| 14 | Factory definition | Inspeccionar o editar la configuración versionable. | **parcial:** perfil por digest más fila del workstream. No hay árbol único ni visor. | [V] `src/profile.ts:75`, `:99`; `src/store.ts:147-150`, `:378`. | T52, T59 |
| 15 | Settings: General info | Identidad y quién da seguimiento. | **parcial:** `slug` y `goal`. Sin handle. La política de seguimiento es D2, en código. | [V] `src/store.ts:148`; `src/admission/gate.ts:32`, `:64`. | T52, T60 |
| 16 | Settings: Worker defaults | Configuración común de ejecución. | **parcial:** agente, concurrencia y tope por workstream. Sin herencia. | [V] `src/store.ts:148-150`; `src/cli.ts:219-232`. | T52, T57 |
| 17 | Settings: Scorer defaults | Entorno base de los scorers. | **falta** (depende de 11). | — | T64 |
| 18 | Settings: Benchmarking | Modelo juez de benchmarks. | **falta** (depende de 11 y 13). | — | T66 |
| 19 | Settings: Factory integrations | Asignar integraciones a la factory. | **parcial:** Jira y GitHub por CLI. Sin vista de estado. Nube: no aplica. | [V] `src/connectors/jira.ts:29`, `:65`; `src/connectors/github.ts:51`; `src/cli.ts:145`. | T52, T70 |
| 20 | Settings: Factory repo | Dónde vive la definición. | **parcial:** estado local en `FABRICA_HOME`; los perfiles son ficheros por digest. | [V] `src/profile.ts:75`; `src/web.ts:91`. | T59 |
| 21 | Settings: Runners | Entornos de ejecución reutilizables. | **parcial:** pool local y sandbox `bwrap`. No hay entidad runner. | [V] `src/sandbox/confine.ts:41`; `src/pool.ts:149`. | T52, T74 |
| 22 | Settings: Access | Usuarios y roles. | **falta.** fab es monousuario; solo se guarda el actor del evento. | [V] `src/store.ts:1323` (`FAB_ACTOR` o usuario del sistema). | T73 |
| 23 | Settings: Danger zone | Eliminar la factory. | **parcial:** se archiva; no se borra. | [V] `src/enums.ts` (`WORKSTREAM_TRANSITIONS`); `src/store.ts:471`; `src/cli.ts:240` (`ws create\|list\|state`). | T60 |
| 24 | Settings: Account | Perfil de la cuenta. | **no aplica** mientras fab sea local y monousuario (ver D-A). | [V] `src/store.ts:1323`. | T73 |
| 25 | Settings: Interface and theme | Personalizar la presentación. | **hecho:** tema claro y oscuro según el sistema. Sin selector manual. | [V] `src/web-style.ts:5`. | — |
| 26 | Settings: Notifications | Aviso del navegador. | **falta.** | [V] `grep -rnE "Notification\|notify-send" src`: solo tipos del SDK. | T55 |
| 27 | Settings: Integrations | Integraciones personales o de equipo. | **parcial** (mismo dato que 19). | [V] como 19. | T52 |
| 28 | Settings: Privacy | Participar en la mejora del producto. | **no aplica:** fab no envía telemetría a un proveedor. | [I] | — |
| 29 | Billing | Saldo y facturación. | **no aplica:** corre en local con las credenciales del dueño. El gasto sí se mide (F3). | [V] `src/evidence.ts:103`. | — |
| 30 | Factory API keys | Credenciales para usar la factory por API. | **falta.** El SDK es JSON-RPC por stdio para `fab exec`. | [V] `src/cli.ts:165`; únicos `Bun.serve`: `src/web.ts:96`, `src/sdk/mcp-server.ts:39`, `src/agent/mcp-oauth.ts:260`. | T71 |
| 31 | Networking | Rangos IP de salida de agentes alojados. | **no aplica.** Análogo: sonda de egress del sandbox. | [V] `src/sandbox/egress-probe.ts:149`. | T52 |
| 32 | MCPs and apps | Conexiones reutilizables para workers. | **parcial:** el agente nativo carga `mcpServers`; no hay MCP por rol de la fábrica ni vista. | [V] `src/agent/settings.ts:44`; `src/cli.ts:173`. | T52, T72 |
| 33 | Agent harnesses | Autenticación y elección de harness. | **hecho** por CLI: adaptadores y verificación de binarios. Sin vista web. | [V] `src/agents.ts:159`, `:165`; `src/agents-verify.ts:100`; `src/cli.ts:146`. | T52 |
| 34 | Secrets | Secretos que consumen las ejecuciones. | **parcial:** variables por allowlist y credenciales montadas en solo lectura; redacción al servir. Sin almacén. | [V] `src/sandbox/confine.ts:80-81`, `:102-106`; `src/evidence.ts:71`. | T72 |
| 35 | Onboarding | Preparar una factory antes de activar workers. | **falta.** Hoy es `fab ws create`. | [V] `src/cli.ts:214-233`. | T61 |

### Capacidades del catálogo que el recorrido no lista como módulo

El recorrido de Codex no tiene fila para estas seis. Se añaden para que el cruce sea completo.

| Catálogo | Capacidad | Estado en fab | Evidencia | Tarea |
|---|---|---|---|---|
| C04 | Renombrar un run | **falta** | [V] no hay mutación del título en `src/store.ts`. | T51 |
| C17 | Varias factories | **hecho** | [V] `src/web.ts:58`; `src/store.ts:409`, `:467`. | — |
| C31 | Skills de la factory | **parcial:** el agente nativo lee `.agents/skills/<n>/SKILL.md`; no forman parte del perfil. | [V] `src/agent/registry.ts:126-127`. | T59 |
| C48 | Canales de entrada | **parcial:** etiqueta en GitHub e importación de Jira. | [V] `src/admission/gate.ts:28`, `:36`; `src/connectors/intake.ts:16`. | T70 |
| C49 | Puertas humanas | **hecho**, en código. | [V] `src/store.ts:1075` (`resolveReview`), `:594`, `:1013`, `:1032`. | — |
| C50 | Revisión adversarial | **hecho**; el veredicto se publica entero. | [V] `src/validators/publish.ts:29`, `:43`. | — |

## 2. Resumen

| Estado | Nº | Módulos |
|---|---:|---|
| Hecho | 3 | 1, 25, 33 |
| En curso | 1 | 5 |
| Parcial | 18 | 2, 3, 4, 6, 7, 8, 12, 13, 14, 15, 16, 19, 20, 21, 23, 27, 32, 34 |
| Falta | 9 | 9, 10, 11, 17, 18, 22, 26, 30, 35 |
| No aplica | 4 | 24, 28, 29, 31 |
| **Total** | **35** | |

Lectura:

- **La mitad es «parcial»**, y en 12 de esos 18 el dato o la mutación ya existen: falta la superficie (2, 4, 6, 7, 14, 15, 16, 19, 20, 27, 32 y la parte de lectura del 3). Eso es F4: barato y de riesgo bajo.
- **Lo que falta de verdad** son cuatro piezas nuevas: jueces sobre ejecuciones (11, 17, 18), entrada automática (9, 10), avisos (26) y lo de equipo (22, 30).
- **«No aplica» tiene una razón concreta en los cuatro casos**: no hay proveedor que facture, aloje agentes ni recoja telemetría. Si el dueño decide el servidor compartido (D-A), el 24 pasa a «falta».

## 3. Tareas nuevas

### Notas para quien las añada

- **Ids:** T46 en adelante; el último de la release es T45. T46 a T48 **registran lo que ya existe** (F0 a F3), para que las dependencias apunten a un id real.
- **Campos:** se sigue la forma existente (`id`, `title`, `why`, `where`, `proposal`, `acceptance`, `status`, `depends_on`, `pr`). `phase`, `estimate` y `risk` son **campos nuevos**: los pide el brief y `task.json` no los tiene hoy.
- **Las tareas `blocked`** dependen de una decisión de §5, nombrada en su `note`.
- **Estimaciones** en días de implementador, sin contar verificación. Son [I].

### Tabla

| Id | Título | Fase | Depende de | Estimación | Riesgo |
|---|---|---|---|---|---|
| T46 | Registro: `fab web` F0/F1, lectura y evidencia (PR #80) | F0-F1 | — | hecho | — |
| T47 | Registro: `fab web` F2, decisiones desde la web | F2 | T46 | 4-6 d | alto |
| T48 | Registro: `fab web` F3, métricas | F3 | T46 | hecho, sin verificar | medio |
| T49 | Lista de changes y bandeja completas | F4 | T46 | 2-3 d | bajo |
| T50 | Crear una señal y triarla desde la web | F4 | T47 | 2-3 d | medio |
| T51 | Cancelar y renombrar un change desde la web | F4 | T47 | 2 d | medio |
| T52 | Página de configuración de solo lectura | F4 | T46 | 4-6 d | medio |
| T53 | Visor del flujo (Blueprint) | F4 | T46, T48 | 3-4 d | bajo |
| T54 | Línea de tiempo por turnos y transcript estructurado | F5 | T46, T16, T17, T19, T26 | 6-8 d | alto |
| T55 | Aviso del navegador cuando algo te espera | F5 | T46 | 1-2 d | bajo |
| T56 | Mensaje libre del dueño a un change | F5 | T47, T54 | 4-6 d | alto |
| T57 | Perfil v2: modelo y adaptador por rol | F6 | — | 5-8 d | alto |
| T58 | Editor web de perfiles | F6 | T47, T52, T57 | 4-6 d | alto |
| T59 | Definición exportable como árbol de ficheros | F6 | T57 | 3-5 d | medio |
| T60 | Ajustes y borrado de workstream desde la web | F6 | T47, T52 | 3-4 d | alto |
| T61 | Asistente de alta de workstream | F6 | T47, T52 | 3-5 d | medio |
| T62 | Vista de experimentos y suites | F7 | T46 | 3-4 d | bajo |
| T63 | Medir si los validadores dejan hueco para jueces | F7 | — | 2 d | bajo |
| T64 | Jueces (scorers) sobre ejecuciones terminadas | F7 | T57, T63 | 8-12 d | alto |
| T65 | Jueces en la web: lista, historial y pestaña del panel | F7 | T47, T48, T64 | 5-7 d | medio |
| T66 | Benchmarks: matriz de variantes y «añadir a suite» | F7 | T57, T62, T64 | 6-9 d | medio |
| T67 | Automejora por umbral, con candidato revisable | F7 | T58, T64, T66 | 5-8 d | alto |
| T68 | Automations por horario que crean señales | F8 | T50, T11 | 5-8 d | alto |
| T69 | Webhooks entrantes como aviso y como señal | F8 | T68, T43 | 8-12 d | alto |
| T70 | Más conectores de entrada | F8 | T43, T69 | sin estimar | alto |
| T71 | API HTTP local con claves | F9 | T47 | 4-6 d | alto |
| T72 | Secretos y MCP por referencia, por workstream y rol | F9 | T57, T34 | 4-6 d | alto |
| T73 | Usuarios, roles y cuenta | F9 | T71 | sin estimar | alto |
| T74 | Runners con nombre | F9 | T52 | sin estimar | alto |

Orden: F4 solo necesita F0 a F2. F5 necesita las tareas de sesión (T16 a T26) cerradas. F6 abre con T57, que es la única sin dependencias y desbloquea F7 y F9. F8 espera a los datos de T11 y a T43. F9 va al final porque casi todo depende de D-A.

### JSON

```json
[
  {
    "id": "T46",
    "title": "Registro: `fab web` F0/F1, lectura y evidencia",
    "phase": "F0-F1",
    "why": "La web existe y está fusionada, pero no tiene tarea: nada puede depender de ella por id.",
    "where": "src/web.ts, src/web-style.ts, src/evidence.ts",
    "proposal": "Registrar lo ya fusionado. Informes en docs/research/warp-platform/ (impl-codex.md, verif-fable.md).",
    "acceptance": "Tarea presente en task.json con el PR enlazado.",
    "estimate": "hecho",
    "risk": "bajo",
    "status": "done",
    "depends_on": [],
    "pr": 80
  },
  {
    "id": "T47",
    "title": "Registro: `fab web` F2, decisiones desde la web",
    "phase": "F2",
    "why": "Primera superficie que escribe por red. Sin ella no hay respuesta, revisión ni reintento desde la web.",
    "where": "worktree sw-factory-webf2, rama feat/fab-web-f2; módulos nuevos src/web-actions.ts y src/web-auth.ts",
    "proposal": "La del brief BRIEF-WEB-F2-CODEX.md: `fab web --write`, token de un solo uso, cookie de sesión, CSRF y Origin, actor `web`. Sin merge ni `gate allow`.",
    "acceptance": "Los tests del brief pasan; cada defensa tiene una mutación que mata algún test; verificación independiente sin hallazgos altos.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "in_progress",
    "depends_on": ["T46"],
    "note": "El 2026-11-19 el worktree seguía en 77f0dfb, sin commits propios ni informe.",
    "pr": null
  },
  {
    "id": "T48",
    "title": "Registro: `fab web` F3, panel de métricas",
    "phase": "F3",
    "why": "Equivale a las pestañas Productivity y Spending del panel de Warp.",
    "where": "worktree sw-factory-webf3, rama feat/fab-web-f3; src/metrics.ts, src/web-metrics.ts, src/store.ts (metricsCohort, metricsEvents)",
    "proposal": "Verificar con un goldfish de otro modelo lo que describe impl-f3-codex.md y abrir el PR.",
    "acceptance": "Verificación independiente sin hallazgos altos; suite completa verde o con los dos fallos conocidos repetidos a solas.",
    "estimate": "hecho, sin verificar",
    "risk": "medio",
    "status": "in_progress",
    "depends_on": ["T46"],
    "note": "Implementada en 4 commits (hasta 48c238f). La suite dio 2 fallos y 1 error que pasan aislados (t2-cualificacion, agent-fetch-url).",
    "pr": null
  },
  {
    "id": "T49",
    "title": "Lista de changes y bandeja completas",
    "phase": "F4",
    "why": "La lista solo filtra por workstream, estado y título. Warp filtra además por fuente, creador y fecha, ordena y tiene filtros rápidos; su bandeja agrupa por día y deja marcar como resuelto.",
    "where": "src/web.ts:52-63; src/store.ts:573 (listChanges); adm_thread_changes para la fuente; events.actor para el creador",
    "proposal": "Añadir a /changes orden (actualizado, creado, título), filtro por fecha, por fuente (CLI, canal, Jira) y por actor del primer evento, y enlaces de filtro rápido por estado. En la bandeja, agrupar por día y buscar. «Marcar como visto» se guarda en localStorage del navegador: no cambia el estado del dominio ni añade tablas.",
    "acceptance": "Tests con datos sintéticos: cada filtro y cada orden devuelven el conjunto exacto; un change sin fuente conocida aparece como «No medido», no se oculta; la consulta sigue en un Store readonly y no crea ficheros; 1000 changes en menos de 300 ms.",
    "estimate": "2-3 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": ["T46"],
    "pr": null
  },
  {
    "id": "T50",
    "title": "Crear una señal y triarla desde la web",
    "phase": "F4",
    "why": "Equivale a New run. Hoy solo se puede con `fab signal add` y `fab triage`.",
    "where": "src/store.ts:488 (addSignal), :509 (triageSignal), :527 (ignoreSignal); src/cli.ts:244-265",
    "proposal": "Con `--write`: formulario que crea una señal, lista de señales nuevas y botones triar o ignorar. Son dos pasos separados, igual que en la CLI: la señal no lanza nada hasta que el dueño la tría. Sin adjuntos.",
    "acceptance": "Sin `--write`, 405. Con sesión: crear deja una señal `new` y un evento con actor `web`; triar crea el change; doble envío da `conflict`; título y cuerpo se escapan al mostrarse; límites de tamaño de F2.",
    "estimate": "2-3 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T47"],
    "pr": null
  },
  {
    "id": "T51",
    "title": "Cancelar y renombrar un change desde la web",
    "phase": "F4",
    "why": "Warp tiene Stop y renombrar. En fab cancelar es `fab reject` y no existe renombrar.",
    "where": "src/cli.ts:382-390 (reject); src/store.ts:1112 (closeChange); método nuevo de Store para el título",
    "proposal": "Botón Cancelar con confirmación que hace lo mismo que `fab reject` (evento, closeChange, espera de liberación y borrado del worktree). Renombrar: método `renameChange` con evento que guarda el título anterior.",
    "acceptance": "Cancelar un change en curso lo deja `canceled` y libera el worktree; cancelar uno terminal da `invalid_transition` sin efecto; renombrar deja evento con el título anterior y actor `web`; título de hasta 200 caracteres, escapado.",
    "estimate": "2 d",
    "risk": "medio",
    "status": "blocked",
    "depends_on": ["T47"],
    "note": "Bloqueada por D-B: el brief de F2 excluye «parar agentes» de forma explícita.",
    "pr": null
  },
  {
    "id": "T52",
    "title": "Página de configuración de solo lectura",
    "phase": "F4",
    "why": "Diez módulos de Warp (workers, definición, defaults, integraciones, harnesses, MCPs, runners, red, repo) son en fab datos que ya existen y solo se ven por CLI.",
    "where": "src/store.ts:147-150 y :378 (workstream); src/profile.ts:90-106; src/agents.ts:165; src/agents-verify.ts; src/sandbox/report.ts:10; src/sandbox/egress-probe.ts:46; src/connectors/jira.ts:29; src/agent/settings.ts:44",
    "proposal": "Ruta /config por workstream: flags y topes; perfil vigente con su digest y las plantillas por rol; perfiles guardados; adaptadores y resultado de la verificación de binarios; sandbox y última sonda de egress; integraciones como «configurada» o «no configurada»; nombres de servidores MCP. Nunca se muestra un valor de variable, token ni URL con credenciales.",
    "acceptance": "Test que siembra variables con valores canario y comprueba que ninguno aparece en el HTML; las plantillas se escapan; la página no crea ficheros ni abre la base en escritura; una integración sin configurar no da error 500.",
    "estimate": "4-6 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T46"],
    "pr": null
  },
  {
    "id": "T53",
    "title": "Visor del flujo (Blueprint)",
    "phase": "F4",
    "why": "Warp dibuja etapas, transiciones y gates. En fab el flujo está en código y no se ve.",
    "where": "src/enums.ts (REVIEWABLE_KINDS, REVIEW_FOLLOW_UP, ActivityKind); src/store.ts:149-150; src/validators/index.ts:14",
    "proposal": "Ruta /flujo: SVG de servidor generado desde las constantes del dominio (señal, triage, revisión del change, investigación, implementación, validadores, merge), con las puertas humanas marcadas según los flags del workstream y el número de changes en cada etapa. Solo lectura: el flujo se cambia en el código, no en la web.",
    "acceptance": "Test: si se añade una transición a REVIEW_FOLLOW_UP aparece en el grafo sin tocar la vista; con `--no-spec-approval` la puerta correspondiente se dibuja abierta; hay una tabla equivalente al grafo; los recuentos coinciden con datos sintéticos.",
    "estimate": "3-4 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": ["T46", "T48"],
    "pr": null
  },
  {
    "id": "T54",
    "title": "Línea de tiempo por turnos y transcript estructurado",
    "phase": "F5",
    "why": "Warp muestra turnos, segmentos (trabajo, espera, bloqueo) y pasos plegables. fab muestra eventos y el log en texto plano.",
    "where": "src/admission/db.ts:43-59 (adm_reports, adm_questions, adm_sessions); src/live/turn.ts:58; src/web.ts:65-87",
    "proposal": "En el detalle del change, una fila por turno con su sesión y generación, el report aplicado, la pregunta y su respuesta, y los tramos de espera. Lectura sobre las tablas adm_* en modo readonly; si la base no tiene esas tablas, la sección dice «Sin turnos vivos».",
    "acceptance": "Datos sintéticos con dos generaciones de sesión, una pregunta respondida y una caducada: la vista las ordena y etiqueta bien; base sin tablas adm_* no falla ni las crea; el texto de preguntas y respuestas se escapa; prueba corta con claude real y confinado, como pide AGENTS.md para src/live.",
    "estimate": "6-8 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T46", "T16", "T17", "T19", "T26"],
    "pr": null
  },
  {
    "id": "T55",
    "title": "Aviso del navegador cuando algo te espera",
    "phase": "F5",
    "why": "Warp avisa cuando un agente termina o necesita atención. fab solo avisa en el issue, por el Outbox.",
    "where": "src/web.ts:17 (POLL), :52 (bandeja)",
    "proposal": "El sondeo que ya existe compara el número de elementos de la bandeja y lanza una notificación del navegador cuando sube. Interruptor en la página, guardado en localStorage. Sin SSE: se añade solo si se mide que el sondeo de 2 s no basta. El aviso lleva el recuento, nunca texto de un issue.",
    "acceptance": "Test del script: con permiso concedido y bandeja de 1 a 2 se llama una vez a Notification; sin permiso no se pide en cada sondeo; el cuerpo del aviso no contiene títulos ni texto de terceros; la CSP sigue sin permitir script en línea.",
    "estimate": "1-2 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": ["T46"],
    "pr": null
  },
  {
    "id": "T56",
    "title": "Mensaje libre del dueño a un change",
    "phase": "F5",
    "why": "En Warp se puede escribir a un run en cualquier momento. En fab solo se responde a una pregunta abierta o se comenta una revisión.",
    "where": "src/admission/sessions.ts:112 (reconstructPrompt); src/admission/recovery.ts:27 (planTurn); src/store.ts:1032",
    "proposal": "Una nota del dueño queda guardada y el pool la entrega al empezar el turno siguiente del change, dentro del prompt. No interrumpe un turno en marcha ni añade el efecto `deliver`, que D4 excluye.",
    "acceptance": "Una nota escrita con el change en espera aparece en el prompt del turno siguiente y una sola vez; una nota a un change terminal se rechaza; la entrega queda en un evento con actor; prueba con claude real y confinado.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "blocked",
    "depends_on": ["T47", "T54"],
    "note": "Bloqueada por D-C: toca D4 (el pool lanza los turnos; sin launch, deliver ni stop).",
    "pr": null
  },
  {
    "id": "T57",
    "title": "Perfil v2: modelo y adaptador por rol",
    "phase": "F6",
    "why": "En Warp cada worker tiene su modelo, harness y prompt. En fab el perfil tiene un solo `model` y `harness`, y el adaptador se fija por workstream.",
    "where": "src/profile.ts:10-18, :53; src/pool.ts:186; src/agents.ts:159; src/store.ts:148",
    "proposal": "schemaVersion 2 con un bloque opcional por rol (investigate, implement, code_review, security_audit, qa) que puede fijar adaptador y modelo; lo que falte se hereda del perfil y luego del workstream. Sigue identificado por digest: cambiar un rol es un perfil nuevo. Los perfiles v1 se siguen leyendo con el mismo digest.",
    "acceptance": "El digest de todo perfil v1 existente no cambia; un perfil v2 con modelo por rol hace que la activity de ese rol corra con ese modelo y lo deje en su metadata; un adaptador no confinable en un change de canal falla cerrado (T32); perfil con rol desconocido se rechaza nombrando el campo.",
    "estimate": "5-8 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [],
    "pr": null
  },
  {
    "id": "T58",
    "title": "Editor web de perfiles",
    "phase": "F6",
    "why": "Equivale al editor de worker de Warp (Prompt, Settings, Restore defaults), sin editar en caliente.",
    "where": "src/profile.ts:75 (saveProfile), :103 (DEFAULT_DIGEST); src/profile-cli.ts; método nuevo de Store para asignar el perfil al workstream",
    "proposal": "Con `--write`: editar las plantillas crea un perfil nuevo con su digest; el vigente no se toca. Asignarlo al workstream es una acción aparte, con confirmación y evento que guarda el digest anterior. «Restaurar valores por defecto» asigna DEFAULT_DIGEST. Las activities ya creadas conservan su digest.",
    "acceptance": "Guardar no altera ningún fichero de perfil existente; dos guardados iguales dan el mismo digest y `created: false`; asignar deja evento con digest anterior y nuevo; una activity en curso termina con el digest con el que empezó; plantilla de más de 32 KiB se rechaza.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T47", "T52", "T57"],
    "pr": null
  },
  {
    "id": "T59",
    "title": "Definición exportable como árbol de ficheros",
    "phase": "F6",
    "why": "Warp guarda la factory como ficheros en un repo. En fab la definición está repartida entre la fila del workstream y el perfil.",
    "where": "src/profile-cli.ts:12-25 (export, import); src/store.ts:409; src/agent/registry.ts:126-127 (skills)",
    "proposal": "`fab definition export <ws> <dir>` escribe un árbol legible (workstream, perfil por rol, validadores, skills del repo) y `import` lo valida y crea perfil y workstream en draft. El árbol se versiona en el repo que elija el dueño; los cambios entran por PR. La web lo muestra en la página de configuración.",
    "acceptance": "Exportar e importar en un estado vacío da el mismo digest de perfil; el árbol no contiene rutas absolutas del dueño ni valores de entorno; importar sobre un slug existente falla sin tocar nada; un fichero desconocido en el árbol se rechaza.",
    "estimate": "3-5 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T57"],
    "pr": null
  },
  {
    "id": "T60",
    "title": "Ajustes y borrado de workstream desde la web",
    "phase": "F6",
    "why": "Equivale a General info y Danger zone. Hoy solo existe `fab ws create|list|state`; no se puede editar ni borrar.",
    "where": "src/cli.ts:213-242; src/store.ts:471 (setWorkstreamState); src/enums.ts (WORKSTREAM_TRANSITIONS)",
    "proposal": "Con `--write`: cambiar objetivo, concurrencia y tope de tareas; pausar, activar y archivar. Borrar solo un workstream archivado y sin changes en curso, escribiendo su slug para confirmar. Los flags de aprobación y las rutas protegidas no se editan desde la web.",
    "acceptance": "Cada cambio deja evento con valor anterior y actor; borrar uno activo da `invalid_transition`; borrar con un change en curso se rechaza; un POST que intente cambiar `require_approval` o las rutas protegidas se ignora y lo prueba un test.",
    "estimate": "3-4 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T47", "T52"],
    "note": "D-F decide si los flags de aprobación se pueden tocar desde la web. Recomendado: no.",
    "pr": null
  },
  {
    "id": "T61",
    "title": "Asistente de alta de workstream",
    "phase": "F6",
    "why": "Warp guía el alta en seis pasos y deja una lista «Finish setup». En fab es un comando con una docena de flags.",
    "where": "src/cli.ts:214-233; `fab doctor` en src/cli.ts:391; src/agents-verify.ts",
    "proposal": "Formulario en pasos (repo local, objetivo, adaptador, perfil, comando de verificación) que termina en `createWorkstream` en estado draft, más una lista de comprobaciones que reutiliza `fab doctor`. Activarlo sigue siendo un paso explícito.",
    "acceptance": "El workstream creado es idéntico al de `fab ws create` con los mismos valores; un repo que no existe o no es git se rechaza en su paso; nace en draft; la lista marca como pendiente un adaptador sin binario verificado.",
    "estimate": "3-5 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T47", "T52"],
    "pr": null
  },
  {
    "id": "T62",
    "title": "Vista de experimentos y suites",
    "phase": "F7",
    "why": "Los experimentos de `improve` y las suites solo se ven con `fab improve report`.",
    "where": "src/improve.ts:26-29 (tablas), :316 (reportExperiment), :341 (experimentRunsJson); tests/web-improve.test.ts",
    "proposal": "Rutas /experimentos y /experimentos/<id> de solo lectura: brazos, repeticiones, éxito, coste, líneas de diff y el resumen que ya calcula reportExperiment. Lista de suites con sus tareas por split.",
    "acceptance": "Los números de la página coinciden con `fab improve report --json` sobre el mismo estado; una base sin tablas de experimentos no las crea; coste desconocido se muestra «No medido».",
    "estimate": "3-4 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": ["T46"],
    "pr": null
  },
  {
    "id": "T63",
    "title": "Medir si los validadores dejan hueco para jueces",
    "phase": "F7",
    "why": "AGENTS.md exige medir antes de construir una pieza. Los validadores ya juzgan cada change; no se sabe qué verían los jueces que ellos no ven.",
    "where": "src/validators/verdict.ts:12; src/store.ts:814 (validationSummary); events",
    "proposal": "Fijar por escrito, antes de medir: (1) proporción de changes aprobados por los validadores que después recibieron «comentar» o «rechazar» del dueño o un reintento; (2) umbral: si supera el 15 % en al menos 30 changes, los jueces se construyen con muestreo alto; si no, con muestreo bajo y solo como aviso. Medir con eventos existentes, sin llamadas a modelos.",
    "acceptance": "Nota en la tarea con la medición, el umbral, el resultado y lo que la medición no puede ver. Sin escrituras nuevas en la base.",
    "estimate": "2 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [],
    "pr": null
  },
  {
    "id": "T64",
    "title": "Jueces (scorers) sobre ejecuciones terminadas",
    "phase": "F7",
    "why": "Warp puntúa ejecuciones con rúbricas, clasificaciones, nota de aprobado y muestreo, por worker, por etapa o por tarea completa. fab no tiene nada equivalente.",
    "where": "Módulo nuevo src/scorers.ts; tablas nuevas `scorers` y `scores`; src/validators/prompts.ts:51 como modelo de prompt; src/prompts.ts:22 (untrusted)",
    "proposal": "Un juez es rúbrica, clasificaciones con puntuación, nota de aprobado, tasa de muestreo y alcance (un rol, o el change completo); vive en el perfil, con digest. Corre después de que la activity termine, como proceso de un disparo, confinado y sin escritura en el worktree. El material juzgado va delimitado con nonce. El resultado es un aviso: nunca cambia el estado del change ni cuenta para el merge. Muestreo 0 lo pausa.",
    "acceptance": "Muestreo determinista por semilla: con tasa 0 no corre ninguno y con 1 corren todos; un juez que falla o no devuelve una clasificación válida deja `score` nulo, no cero; ningún resultado de juez cambia `changes.status` ni `mergeBlocker`; texto con instrucciones dentro del material juzgado no altera el formato de salida (test con canario); prueba con claude real y confinado.",
    "estimate": "8-12 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T57", "T63"],
    "note": "D-G: el catálogo recomendaba no construirlos todavía. T63 fija el muestreo, no el si.",
    "pr": null
  },
  {
    "id": "T65",
    "title": "Jueces en la web: lista, historial y pestaña del panel",
    "phase": "F7",
    "why": "Equivale a Scorers (Details, Config), «Score past runs», «Score run» y la pestaña Scorers del Dashboard.",
    "where": "src/web.ts; src/web-metrics.ts (F3); tablas de T64",
    "proposal": "Lista y detalle de jueces con coste acumulado y tasa de aprobado en el tiempo; pestaña en /metricas. Con `--write`: puntuar una ejecución a mano y puntuar un rango pasado, con vista previa del número de ejecuciones y del coste estimado y la opción de saltar las ya puntuadas.",
    "acceptance": "La tasa de aprobado coincide con datos sintéticos; «No hay puntuaciones en este rango» cuando no las hay; la vista previa de un rango cuenta lo mismo que luego se encola; repetir la acción con «saltar las ya puntuadas» no crea duplicados.",
    "estimate": "5-7 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T47", "T48", "T64"],
    "pr": null
  },
  {
    "id": "T66",
    "title": "Benchmarks: matriz de variantes y «añadir a suite»",
    "phase": "F7",
    "why": "Warp compara configuraciones de modelo sobre casos repetibles y deja añadir un run real como caso. En fab las suites se escriben a mano y se compara un candidato contra un baseline.",
    "where": "src/improve.ts:17-18 (SuiteTask), :71 (createExperiment), :257 (RunOptions); src/improve-cli.ts",
    "proposal": "Corrida con N variantes (perfil y modelo) sobre una suite, reutilizando el motor de `improve`, con estados pendiente, en curso, puntuando, completa, fallida y cancelada. «Añadir a suite» genera desde un change terminado una SuiteTask candidata (repo, base, descripción, verificación) en un fichero que el dueño revisa; no modifica una suite ya usada, porque su digest la identifica.",
    "acceptance": "Una corrida de 2 variantes × 3 tareas × 2 repeticiones produce 12 filas; cancelar deja las filas hechas y no lanza más; la tarea generada desde un change pasa parseSuite; el digest de una suite existente no cambia.",
    "estimate": "6-9 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": ["T57", "T62", "T64"],
    "pr": null
  },
  {
    "id": "T67",
    "title": "Automejora por umbral, con candidato revisable",
    "phase": "F7",
    "why": "Warp propone cambios a la definición cuando un worker acumula fallos de juez por encima de un umbral. En fab `improve` se lanza a mano.",
    "where": "src/improve.ts:71; tablas de T64; src/profile.ts:75",
    "proposal": "Cuando un rol supera el umbral de fallos de juez en una ventana, la fab registra un candidato: un perfil nuevo propuesto por un agente confinado y un experimento pareado contra el vigente. La web lo lista con su evidencia. Aplicarlo es la asignación de perfil de T58, hecha por el dueño. La fab nunca asigna el perfil ni abre el PR por su cuenta.",
    "acceptance": "Por debajo del umbral no se crea candidato; por encima se crea uno, no uno por fallo; el perfil vigente del workstream no cambia sin la acción de T58; el candidato lleva el id del experimento y los ids de las puntuaciones que lo dispararon; «Ejecutar ahora» crea como mucho un candidato en curso por rol.",
    "estimate": "5-8 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T58", "T64", "T66"],
    "note": "D-H: quién aplica la mejora. Recomendado: solo el dueño.",
    "pr": null
  },
  {
    "id": "T68",
    "title": "Automations por horario que crean señales",
    "phase": "F8",
    "why": "Warp lanza trabajo cada hora, día, semana o por cron. fab no tiene nada recurrente.",
    "where": "Tabla nueva `automations`; src/admission/resident.ts (bucle); src/store.ts:488 (addSignal)",
    "proposal": "Una automation es horario (cada hora, diario, semanal o cron), workstream y una plantilla fija de señal escrita por el dueño. Al vencer crea una señal con fuente `automation:<id>`; no lanza turnos. Si ya hay una señal o un change abierto de esa automation, se salta la vez. «Ejecutar ahora» crea la misma señal. La expresión cron se valida al guardar.",
    "acceptance": "Con reloj inyectado: una automation diaria crea exactamente una señal por día aunque el proceso se reinicie; con una señal abierta de la misma automation no crea otra; cron inválido se rechaza al guardar; ningún camino crea una activity sin pasar por triage; sin esperas reales en los tests.",
    "estimate": "5-8 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T50", "T11"],
    "note": "D-D decide si una automation del dueño puede triarse sola. Recomendado: empezar sin autotriage.",
    "pr": null
  },
  {
    "id": "T69",
    "title": "Webhooks entrantes como aviso y como señal",
    "phase": "F8",
    "why": "Warp recibe entregas HTTP que una automation filtra. En fab la entrada es por sondeo.",
    "where": "Servidor nuevo, separado de `fab web`; src/admission/github.ts:15; src/admission/gate.ts:36; tablas nuevas `webhooks` y `webhook_deliveries`",
    "proposal": "Dos usos. (1) Aviso: una entrega firmada de GitHub solo adelanta el sondeo; el contenido y la autoridad se vuelven a leer por la API, así que D1 y D2 no cambian. (2) Genérico: una entrega válida queda registrada (resultado, tamaño, fecha) y, si coincide con el filtro de una automation, crea una señal `new` con el cuerpo delimitado como no confiable; nunca un change ni un turno. Solo autenticación por firma HMAC; el secreto se lee de una variable de entorno y no se guarda en la base. Tope de 20 webhooks y de 64 KiB por entrega.",
    "acceptance": "Firma ausente o errónea: 401 y ninguna fila de señal; entrega repetida con el mismo id no duplica; una entrega de GitHub con etiqueta `fab` falsificada en el cuerpo no admite nada, porque el gate lee la API; el cuerpo aparece en el prompt solo dentro del bloque con nonce; el resultado de cada entrega es `matched`, `not_matched` o `skipped`; el secreto no aparece en argv, logs ni base.",
    "estimate": "8-12 d",
    "risk": "alto",
    "status": "blocked",
    "depends_on": ["T68", "T43"],
    "note": "Bloqueada por D-E: escuchar fuera de 127.0.0.1 es una decisión del dueño.",
    "pr": null
  },
  {
    "id": "T70",
    "title": "Más conectores de entrada",
    "phase": "F8",
    "why": "Warp admite GitLab, Azure DevOps, Linear, Slack, Teams y Jira como origen de eventos. fab tiene GitHub por etiqueta y Jira por importación manual.",
    "where": "src/admission/github.ts; src/connectors/",
    "proposal": "Cada conector nuevo define su equivalente de D1 y D2 (qué marca dispara y cómo se verifica el rol de quien la puso) antes de escribirse. Sin ese equivalente, el conector es solo de salida (avisos).",
    "acceptance": "Por conector: tests del gate con marca puesta por alguien sin rol, por un bot y por la propia fab; el título y el cuerpo no entran en la decisión de admisión.",
    "estimate": "sin estimar (5-8 d por conector)",
    "risk": "alto",
    "status": "blocked",
    "depends_on": ["T43", "T69"],
    "note": "Bloqueada por D-I: qué conectores y con qué prioridad.",
    "pr": null
  },
  {
    "id": "T71",
    "title": "API HTTP local con claves",
    "phase": "F9",
    "why": "Warp ofrece claves para usar la factory por API. El SDK de fab es JSON-RPC por stdio y solo cubre `fab exec`.",
    "where": "src/web.ts:96; módulos de F2 (src/web-auth.ts); tabla nueva `api_keys`",
    "proposal": "Rutas /api/v1 en JSON sobre el mismo servidor: lectura de workstreams, changes, activities y bandeja, y las mismas mutaciones que la web con `--write`. Clave con ámbito (`read` o `decide`), mostrada una sola vez al crearla y guardada como hash. Va en la cabecera Authorization, nunca en la URL ni en argv. Sin merge ni `gate allow`.",
    "acceptance": "Sin clave, 401; clave `read` en una mutación, 403; clave revocada, 401; la base no contiene la clave en claro (test que la busca); la clave no aparece en logs ni eventos; la API no expone ninguna mutación que la web no tenga.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T47"],
    "pr": null
  },
  {
    "id": "T72",
    "title": "Secretos y MCP por referencia, por workstream y rol",
    "phase": "F9",
    "why": "Warp guarda secretos y servidores MCP en su servidor y los asigna a workers. En fab el agente recibe variables por una allowlist fija y no hay MCP por rol.",
    "where": "src/sandbox/confine.ts:102-106; src/agent/settings.ts:44; perfil v2 de T57",
    "proposal": "El workstream declara nombres de variables permitidas y el perfil declara, por rol, qué nombres y qué servidores MCP usa. Los valores siguen viviendo en el entorno del dueño: ni la base ni la web los guardan o muestran. La web enseña el nombre y si está definido. «Importar» lee nombres de un fichero, no valores.",
    "acceptance": "Una variable no declarada no llega al proceso confinado; la base y el HTML no contienen ningún valor canario; un rol sin MCP declarado arranca sin servidores; el token de un MCP no aparece en argv (T34); un change de canal no recibe más variables que uno local.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": ["T57", "T34"],
    "note": "D-K: confirma que no habrá almacén de valores.",
    "pr": null
  },
  {
    "id": "T73",
    "title": "Usuarios, roles y cuenta",
    "phase": "F9",
    "why": "Warp tiene usuarios con rol por factory, cuenta personal y política de quién puede dar seguimiento. fab es monousuario.",
    "where": "src/store.ts:1323 (actor); módulos de F2 y T71",
    "proposal": "Solo si el dueño elige el servidor compartido: usuarios con rol (lector, triage, admin) y cada mutación comprobada contra el rol en el Store, no en la vista. En local no se construye: el actor del evento ya identifica quién decidió.",
    "acceptance": "Se define al tomar D-A.",
    "estimate": "sin estimar",
    "risk": "alto",
    "status": "blocked",
    "depends_on": ["T71"],
    "note": "Bloqueada por D-A: local monousuario o servidor compartido.",
    "pr": null
  },
  {
    "id": "T74",
    "title": "Runners con nombre",
    "phase": "F9",
    "why": "Warp define runners (sistema, arquitectura, imagen) reutilizables. En fab hay un pool local y un sandbox único.",
    "where": "src/sandbox/confine.ts:41; src/sandbox/detect.ts:112; src/pool.ts",
    "proposal": "Opción local: un runner es un nombre para un conjunto de opciones del sandbox ya existente (red, montajes de solo lectura), elegible por workstream. Los runners remotos o en la nube quedan fuera salvo decisión.",
    "acceptance": "Se define al tomar D-J.",
    "estimate": "sin estimar",
    "risk": "alto",
    "status": "blocked",
    "depends_on": ["T52"],
    "note": "Bloqueada por D-J: runners remotos sí o no.",
    "pr": null
  }
]
```

## 4. Replicar sin romper reglas

Cada fila es una capacidad de Warp que choca con una regla de fab o con la §5 del catálogo. La columna «Cómo» es el diseño propuesto; todas están recogidas en las tareas de §3.

| Capacidad de Warp | Con qué choca | Cómo replicarla | Tarea |
|---|---|---|---|
| **Gates en el prompt** (Blueprint: «gate humano con pregunta y salidas admitidas»; el foreman decide saltarse etapas) | Catálogo §5.1. En fab la puerta es un CAS del Store (`src/store.ts:1075`) y un flag del workstream. | El Blueprint de fab es un **visor generado desde el código**. Se ve el mismo grafo de etapas y gates, pero no se edita: cambiar el flujo es un PR. La «propuesta de Blueprint» de Warp se replica como PR normal, no como run que reescribe el flujo. | T53 |
| **New run / New Chat** | Catálogo §5.2 (admisión por texto) y §5.4 (el triage es el acto humano). | El formulario crea una **señal**, no un turno. Triar es un segundo clic del dueño, autenticado. Es lo mismo que `fab signal add` más `fab triage`: la web no gana poder. | T50 |
| **Follow-up libre a un run** | D4: sin `deliver` desde el residente. Catálogo §5.2: «cualquiera con acceso puede dirigirlo». | La nota la escribe solo el dueño autenticado en local, se guarda y la **entrega el pool** al empezar el turno siguiente. No interrumpe turnos. | T56, D-C |
| **Stop** | El brief de F2 excluye «parar agentes». D4 excluye `stop` del residente. | Cancelar el **change** con la misma ruta que `fab reject`, desde la web local, con confirmación. No se mata un turno suelto. | T51, D-B |
| **Automations por horario** | Catálogo §7.7: lo recurrente debe entrar como señal por el gate. | La automation crea una señal con una plantilla que escribió el dueño. No hay texto de terceros. El triage sigue siendo humano salvo D-D. | T68, D-D |
| **Destino «etapa» de una automation** | El flujo de fab no admite entrar a mitad. | No se replica como salto: la señal entra por el principio. Una revisión recurrente (por ejemplo, auditar una rama) se modela como una señal cuyo change es de solo investigación. [I] | T68 |
| **Webhooks que lanzan trabajo** | Catálogo §5.3. Invariantes: el título y el cuerpo no entran al gate; texto de canal delimitado con nonce; solo confinado. | Dos niveles. **Aviso:** la entrega de GitHub solo despierta el sondeo, y el gate vuelve a leer etiqueta y rol por la API. **Genérico:** la entrega crea una señal `new` que espera triage humano, con el cuerpo marcado como no confiable. Nunca un turno. | T69, D-E |
| **Autenticación de webhook `TOKEN` y `URL_TOKEN`** | «Un token nuevo nunca va en argv»; un token en la URL acaba en logs. | Solo `SIGNATURE` (HMAC). El secreto vive en el entorno del dueño. | T69 |
| **Triggers de Slack, Teams, Linear, GitLab, Azure, Jira** | D1 y D2: solo con la marca de disparo puesta por alguien con rol. | Cada conector define su marca y cómo verifica el rol **antes** de escribirse. Si la plataforma no permite verificar el rol por API, el conector es solo de salida. | T70, D-I |
| **Scorers** | Catálogo §7.6: no construir sin problema medido. Invariante: texto no confiable delimitado. | Se mide primero (T63), y se construyen como **aviso**: no bloquean el merge ni cambian estados. Corren confinados y de un disparo, con el material delimitado. La rúbrica vive en el perfil, con digest. | T63, T64 |
| **Score past runs / Score run** | Gasto no acotado al puntuar un rango. | Vista previa obligatoria con número de ejecuciones y coste estimado antes de encolar; se pueden saltar las ya puntuadas. | T65 |
| **Self-improvement que edita la definición** | Catálogo §5.6. AGENTS.md: «el agente propone, no promueve». | El disparo por umbral crea un **candidato**: perfil nuevo más experimento pareado. Aplicarlo es una asignación de perfil que hace el dueño. La fab no abre el PR ni asigna. | T67, D-H |
| **Editar el prompt en caliente** | Catálogo §5.7: cada activity guarda con qué digest corrió. | El editor **crea un perfil nuevo**. Asignarlo es otra acción, con evento. Las activities en curso conservan su digest. | T58 |
| **Editar Worker defaults y General info** | Los flags `require_change_approval` y `require_approval` son puertas. | Se editan objetivo, concurrencia y tope. Los flags de aprobación y las rutas protegidas se quedan en la CLI. | T60, D-F |
| **Factory definition con editor y Save** | Catálogo §7.10: solo visor; cambios por PR. | Exportar e importar como árbol de ficheros versionable. La web lo muestra. | T59 |
| **Secrets alojados e Import secrets** | Catálogo §5.8. Sección «Secretos» de AGENTS.md. | Se guardan **nombres**, no valores. La web muestra «definida» o «no definida». Importar lee nombres. | T72, D-K |
| **MCPs gestionados por el equipo, con OAuth** | Token del MCP fuera de argv (T34); nada persistente en rutas que el sandbox escriba. | El perfil declara por rol qué servidores usa; la configuración y los tokens siguen fuera del worktree, como dejó T41. | T72 |
| **Agent harnesses con credencial en el servidor** (`credentialStrategy: EXECUTOR`) | Catálogo §5.8. | No se guarda ninguna credencial. La página muestra el adaptador, su binario verificado y si su credencial local existe, sin leerla. | T52 |
| **Factory API keys** | «Un token nuevo nunca va en argv». La API no debe superar a la CLI. | Clave con ámbito, guardada como hash, por cabecera. La API expone lo mismo que la web, sin merge ni `gate allow`. | T71 |
| **Access, roles y «quién puede dar follow-up»** | fab es monousuario. D2 ya decide quién responde en el canal. | En local no se construye: el actor del evento basta. En servidor compartido, el rol se comprueba en el Store. | T73, D-A |
| **Runners alojados, nube (AWS, GCP) y coste Platform** | Catálogo §5.9. | Runner con nombre como perfil del sandbox local. Lo remoto, solo con decisión. | T74, D-J |
| **Notificaciones del navegador** | El texto de un issue es dato. | El aviso lleva solo recuentos y estados, nunca títulos ni cuerpos. | T55 |
| **El foreman filtra hallazgos del revisor** | Catálogo §5.5. | No se replica el filtro. El veredicto del validador se sigue publicando entero (`src/validators/publish.ts:43`). La vista del change ya lo enseña. | — |
| **Marca y vocabulario** | Catálogo §5.10. | workstream, change, activity, señal, validador, juez, flujo. Sin «Foreman» ni «Blueprint» en la interfaz. | todas |

## 5. `[DECIDIR]`

| Id | Decisión | Opciones | Recomendación |
|---|---|---|---|
| **D-A** | ¿Dónde corre la web? | (a) Local, `127.0.0.1`, un usuario. (b) Servidor compartido con usuarios y roles. | **(a).** Con (a), Access y Account quedan «no aplica» y T73 no se hace. Con (b) hay que construir usuarios, roles y secretos antes de exponer nada: es otro proyecto. |
| **D-B** | ¿Cancelar un change desde la web? | (a) No; sigue en `fab reject`. (b) Sí, con confirmación, por la misma ruta que la CLI. | **(b).** No añade poder: es la misma mutación. No incluye matar un turno suelto. |
| **D-C** | ¿Mensaje libre a un change? | (a) Solo respuestas a preguntas y comentarios de revisión (lo que trae F2). (b) Nota guardada que el pool entrega en el turno siguiente. (c) Entrega en vivo a un turno en marcha. | **(b).** Respeta D4. La (c) exige reabrir D4 y la recuperación de sesión. |
| **D-D** | ¿Una automation puede triarse sola? | (a) No: crea la señal y espera al dueño. (b) Sí, si la plantilla la escribió el dueño y el alcance tiene tope. | **(a) primero.** Pasar a (b) con datos: cuántas señales de automation se trían sin cambios. Umbral propuesto: más del 90 % en 20 señales. |
| **D-E** | ¿El receptor de webhooks escucha fuera de `127.0.0.1`? | (a) Solo el uso «aviso» para GitHub, detrás de un túnel que monta el dueño. (b) Puerto configurable con firma HMAC obligatoria. (c) No hay receptor; se mantiene el sondeo. | **(a).** Da la latencia de Warp sin cambiar el gate. El webhook genérico espera a que haya un caso real. |
| **D-F** | ¿Flags de aprobación, `gate allow` y `merge` desde la web? | (a) No, siguen en la CLI. (b) Sí, con segunda confirmación. | **(a).** Es la decisión 3 del catálogo; nada ha cambiado. |
| **D-G** | ¿Construir jueces sin problema medido? | (a) Medir (T63) y construir solo si se supera el umbral. (b) Medir y construir siempre, como aviso; el umbral fija el muestreo. | **(b)**, porque el dueño quiere replicar todo. El coste de equivocarse se limita con muestreo bajo y con que el juez no bloquea nada. |
| **D-H** | ¿Quién aplica una mejora propuesta? | (a) Solo el dueño, asignando el perfil. (b) La fab abre un PR con el cambio. (c) Se aplica sola si el experimento gana. | **(a).** La (b) es aceptable más adelante si el PR va contra el repo de la definición (T59). La (c) contradice «propone, no promueve». |
| **D-I** | ¿Qué conectores de entrada? | (a) Ninguno hasta tener datos de T11 y T43. (b) Uno, elegido por uso real. (c) Todos los de Warp. | **(a).** Si hace falta uno antes, que sea de salida (avisos), que no toca el gate. |
| **D-J** | ¿Runners remotos o en la nube? | (a) No; runner con nombre sobre el sandbox local. (b) Sí. | **(a).** La (b) lleva credenciales del dueño a otra máquina: choca con «Secretos» y con el confinamiento. |
| **D-K** | ¿Almacén de valores de secretos? | (a) No; solo nombres. (b) Almacén cifrado local. | **(a).** |
| **D-L** | ¿Dónde viven estas tareas? | (a) En el `task.json` actual, con el campo `phase`. (b) En un `task.json` propio en `docs/research/warp-platform/`. | **(a)**, para no tener dos colas; el campo `context` del fichero habla solo de superagent → fab y habría que ampliarlo. |

Sin forma segura encontrada, y por eso no se replican tal cual:

- **Billing, Privacy y Networking.** No hay proveedor: no existe saldo que comprar, telemetría que enviar ni IP de salida propia. El gasto se ve en F3 y el egress en T52.
- **El foreman que filtra hallazgos y decide saltarse etapas.** Replicarlo exige mover una puerta al juicio de un modelo. No hay variante segura; lo que sí se replica es su resultado visible (el flujo y el veredicto).

## 6. Huecos del recorrido de Codex

**Cobertura**

1. **No es una verificación independiente del catálogo.** 15 de las 35 filas abren su objetivo con `[V:F]` (visto por Fable, no revalidado): detalle de run, editor de worker, automations, webhooks, scorers, self-improvement, benchmarks, definición, repo, runners, access, danger zone, networking, MCPs y harnesses. [V] recuento sobre la columna «Objetivo y flujo».
2. **Faltan seis capacidades del catálogo** sin fila propia: renombrar run (C04), lista de factories con pin e «Import work» (C17), skills de la factory (C31), canales de entrada (C48), puertas humanas (C49) y revisión adversarial (C50). El ciclo de vida queda en una frase de §3.
3. **Ningún formulario de alta** está reconstruido campo por campo (lo reconoce en §6). Para T64, T66, T68 y T69 los campos salen del catálogo y de nombres del bundle, no de la interfaz.
4. **Sin ejemplo real** de run activo, streaming, Stop, PR, spec o issue embebidos. T54 y T56 se diseñan sin haber visto la pantalla que replican.

**Inferencias débiles**

5. **Blueprint.** Solo se vio la pantalla de introducción. Etapas, subetapas, transiciones, gates, vista YAML y propuesta son `[I:B]`. El propio recorrido dice que no demuestra que ninguna factory use un gate. Es el módulo «New» y el peor sustentado.
6. **Destino por etapa** en automations, scorers y benchmarks: `[I:B]` por selectores del cliente. No se sabe qué significa lanzar trabajo «en una etapa».
7. **Proveedores de triggers** (GitHub, Azure DevOps, GitLab, Linear, Slack, Teams, Jira): «clases visibles en código». No se sabe qué eventos ofrece cada uno ni si llevan filtro de payload.
8. **Tope de 20 webhooks** y modos de autenticación: límite de la interfaz y nombres de enum, no contrato del servidor.
9. **`VERIFY` como tipo de worker** y la lista `TRIAGE…CUSTOM`: enum del cliente; no se vio ningún worker de ese tipo.
10. **Self-improvement.** No se sabe sobre qué ventana cuenta el umbral, si es por worker, ni qué hace «cierre de PR». T67 fija su propia definición.
11. **Coordenadas `línea:columna`** sobre un bundle minificado: solo valen para ese SHA. Los «255 candidatos» son cadenas, no llamadas; REA dejó 137 huecos y 2 fuentes sin leer, y el bundle grande se leyó a mano fuera del analizador.

**Contradicciones y cabos sueltos**

12. **Estados.** Home usa «Waiting on you, Active, Complete, Blocked, Failed»; Runs usa «Running, Complete, Failed, Blocked, Cancelled». No se explica la correspondencia Active ↔ Running ni dónde cae Cancelled en Home.
13. **Benchmarking.** La fila dice `[V]` para el menú, pero añade que la ruta «no bastó para validar el contenido». En la práctica es `[V:F]`.
14. **Dashboard.** Cita como `[V:F]` el «selector de coste» del catálogo, pero el catálogo (§8) dice que no abrió las opciones de esos desplegables.
15. **«Run now»** aparece en el inventario de acciones bajo Automations y Webhooks, pero no en la fila del módulo Automations.
16. **Onboarding.** Da seis identificadores de paso sacados del bundle; el catálogo solo vio los pasos 1 y 3. El contenido del paso `warp-factory` es desconocido.
17. **Controles vistos y no descritos:** «Manage Webhooks», «Team model settings», «Import work», «Copy factory handle or label».
18. **No hay matriz de roles ni de funciones de pago.** El catálogo sí anotó qué opciones estaban deshabilitadas en el plan Start; el recorrido no lo revalida. Para fab importa poco.

## 7. Lo que no revisé

- **F2:** no hay código que leer. Su estado sale del brief y de `git log`.
- **F3:** comprobé que existen las rutas y las dos consultas del Store; no verifiqué los cálculos ni repetí sus tests.
- **PR #79 (T43):** vi que está fusionado; no leí su código. El worktree `feat/fab-web` puede no incluirlo, así que la fila C48 puede estar algo por detrás de la release.
- **`src/agent/`** (agente nativo, misiones, router de modelos): solo las líneas citadas. Puede haber piezas reutilizables para T57 y T72 que no vi.
- **No ejecuté** tests, `fab` ni la web. Todo **[V]** es lectura de la línea citada o salida de `grep`, `git` y `gh`.
- **Las estimaciones** no están medidas contra el ritmo real de F0 a F3.
- **El JSON** se validó con `jq` como sintaxis; no contra un esquema, porque `task.json` no tiene uno.

<!-- FIN -->
