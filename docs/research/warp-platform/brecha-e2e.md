# Brecha E2E: Warp Factories frente a fab

- **Fecha:** 2026-11-19. **Autor:** Sonnet 5.5 (goldfish analista). **Brief:** `BRIEF-BRECHA-E2E.md`.
- **Warp:** recorrido en solo lectura de `platform.warp.dev` con la sesión `warp` ya iniciada (no pidió login). Recorrí Home, Runs (Sort y Filter abiertos), detalle de run (menú More), Dashboard, Blueprint, Workers, editor de worker (menú y pestañas Settings, Prompt y Automations), Automations, Webhooks, Scorers y detalle de scorer, Self-improvement y su configuración, Benchmarks, Definition, los 9 Settings de factory, los 10 ajustes personales y de equipo (Account, Interface, Notifications, Integrations, Privacy, Billing, API keys, Networking, MCPs, Harnesses, Secrets). No pulsé nada que cree, cambie, ejecute o borre. La sesión se cerró con `agent-browser --session warp close`.
- **fab:** web `integ/web-completa` (`9f57926`), la más completa. El worktree `sw-factory-webfull` estaba en medio de una fusión y cambiando mientras trabajaba, así que **no lo toqué**: copié su código a una carpeta temporal, copié `/tmp/fab-web-preview.a2j6Hi` y arranqué `fab web --port 0 --write` sobre esa copia. Canjeé **solo mi enlace**; el del dueño (puerto 4320) sigue sin canjear y mi instancia está parada. No usé `~/.fabrica` ni `~/.fabrica-t11`.
- **Marcas:** **[V]** visto o probado hoy; **[I]** tomado de los informes (`recorrido-codex.md`, `catalogo-fable.md`) o inferido. `[V:F]` = visto antes por Fable, no revalidado.
- **Capturas** (no versionadas, sin datos personales en este informe): `capturas-brecha/warp-*.png` y `capturas-brecha/fab-*.png`. Las de Warp muestran el nombre y el correo de la cuenta; no deben subirse.
- **Reglas:** `task.json`, ramas y worktrees sin tocar; sin commits ni subagentes.

## 0. Qué hay en la web completa y qué no

Lo que la brief llamaba «hecho en rama» **ya está en la web completa** en estos casos, y lo probé: asistente de alta y ajustes de workstream (T60, T61), editor de perfiles (T58), señales y triaje (T50), cancelar y renombrar (T51), nota del dueño (formulario de T56c), visor del flujo (T53), configuración (T52), aviso del navegador (T55), API HTTP con clave (T71d, T71e) y `fab definition` y `fab note` en la CLI (T59, T56a).

**En rama, sin fusionar en la web completa** (`git merge-base --is-ancestor` contra `integ/web-completa`): `feat/t54a-turnos`, `feat/t56b-entrega-notas`, `feat/t63-t66c`, `feat/t66a-bench`, `feat/t66d-bench-cli`, `feat/t68c-automation-cli`, `feat/t68d-pool-automations`, `feat/t69b-webhook`, `feat/t71b-api-key-cli`, `feat/t72b-ws-env`, `feat/t72c-mcp-registry`, `feat/t72d-sandbox-env`, `feat/t72e-pool-env`, `feat/t74a-runners-store`, `feat/t74b-protocolo`, `feat/t74c-bundle`, `feat/t74e-cliente`, `feat/web-t62`.

**Ojo con «fusionada» en T64:** `feat/t64c-scorers-runner` apunta al mismo commit que `feat/t64b` (`6fb629b`), sin trabajo propio ni `impl-*.md`. Lo cuento como «en cola», no como hecho. Lo mismo para T74d, T74f a T74h, T64d, T64e, T67a a T67e, T54d, T56d y T72f, T72g: el diseño existe, el código no.

**Lo que ya había en la web** (también sin tarea nueva): `/experimentos` y `/experimentos/<id>` (T62 en la web completa, aunque su rama no figura como fusionada).

## 1. Matriz de capacidades

Una fila por capacidad. Estado: **web** (se usa hoy en la web completa), **solo CLI**, **en rama** (con la rama), **en cola** (tarea de `task.json`), **falta sin tarea** (con la tarea nueva de §3 que la cubre), **no aplica** o **no se replica** (con la decisión o la sección que lo justifica).

| # | Módulo de Warp | Capacidad | En Warp | Estado en fab | Evidencia |
|---:|---|---|---|---|---|
| 1 | Home | Bandeja «te espera a ti» con contadores | [V] Waiting on you / Active / Complete / Blocked / Failed | **web**. Bandeja con la lista que espera decisión | `/` |
| 2 | Home | Búsqueda en la bandeja | [V] caja «Search your runs» | **web** | `/` searchbox «Buscar en la bandeja» |
| 3 | Home | Agrupación por día | [V] región «Today» | **web**. Cabeceras por fecha | `/` (h2 2026-11-19…) |
| 4 | Home | Marcar como resuelto / visto | [V] botón «Mark … as resolved» | **web**. «Marcar como visto» con «Visto · deshacer», guardado en el navegador (T49); no cambia el dominio | `/`, T49 |
| 5 | Home | Selección múltiple y «Select all» | [V] botón «Select all», casillas por fila | **falta sin tarea**. → T94 | — |
| 6 | Home | Contador de no leídos junto a «Home» | [V] «Home, 1 unread notification» | **falta sin tarea**. → T94 (el menú «Bandeja» no lleva contador) | — |
| 7 | Home | New run desde Home | [V] enlace «New run» | **web**. Formulario de `/signals` crea una señal, que se tría aparte (T50) | `/signals` |
| 8 | Runs | Búsqueda por título | [V] «Search» | **web** | `/changes?q=` |
| 9 | Runs | Orden por Updated / Created / Title | [V] menú Sort, asc/desc | **web**. Actualizado, Creado, Título; sin elegir sentido asc/desc → T97 | `/changes` «Ordenar por» |
| 10 | Runs | Filtro por estado | [V] Filter › Status | **web**. 10 estados | `/changes` «Estado» |
| 11 | Runs | Filtro por worker/agente | [V] Filter › Worker | **falta sin tarea**. → T97 (adaptador y rol) | — |
| 12 | Runs | Filtro por factory | [V] Filter › Factory | **web**. Workstream | `/changes` «Workstream» |
| 13 | Runs | Filtro por fuente | [V] Filter › Source («3 hidden») | **web**. CLI, Canal, Jira, No medido; falta «automation» → T97 | `/changes` «Fuente» |
| 14 | Runs | Filtro por creador | [V] Filter › Creator | **web** | `/changes` «Creador» |
| 15 | Runs | Filtro por fecha | [V] Filter › Created on | **web**. Filtra por «Actualizado desde/hasta», no por creación → T97 | `/changes` fechas |
| 16 | Runs | Filtros rápidos por estado con atajo «My runs» | [V] Running, Complete, Failed, Blocked, Cancelled, My runs | **web**. Enlaces rápidos con recuento; «Mis changes» se obtiene con el filtro de creador | `/changes` navegación «Filtros rápidos» |
| 17 | Runs | «Background runs» (ocultar/mostrar los de fondo) | [V] filtro rápido | **falta sin tarea**. → T97 (changes nacidos de una automation) | — |
| 18 | Runs | Jerarquía padre → hijos con contador en la lista | [V] «Expand children · 1 child runs» | **falta sin tarea**. → T97 (columna de activities); el detalle del change sí las lista | `/changes/<id>` «Activities» |
| 19 | Runs | Renombrar run | [V] «Rename run» | **web**. Probado: título actualizado y evento con el anterior (T51) | `/changes/<id>` «Renombrar» |
| 20 | Runs | Lista «Finish setup» en cada página | [V] panel «Let's get your factory set up» | **web**. «Antes de activar» en cada workstream en borrador (T61) | `/workstreams` |
| 21 | Runs | Banners de integraciones y de ventas | [V] «Connect on Slack», «Schedule demo» | **no aplica**. No hay proveedor ni plan de pago (D9 D-A) | D9 |
| 22 | Detalle de run | Transcript de mensajes y pasos plegables | [V] «Worked for 1m 3s: Called Factory 1 time» | **en cola**. T54; hoy log en texto plano | `/activities/<id>` «Log» |
| 23 | Detalle de run | Alternar «Show thinking» / «Show tool calls» | [V] menú More | **en cola**. T54 (transcript estructurado) | T54 |
| 24 | Detalle de run | Turnos y estado de espera | [V:F] turnos y segmentos | **en rama**. `feat/t54a-turnos` (tabla `adm_turns`); la sección «Turnos» ya está en la web y dice «Sin turnos vivos» | `/changes/<id>` «Turnos»; `impl-t54a.md` |
| 25 | Detalle de run | Timeline por minutos con columna por agente | [V] «Toggle timeline» | **en cola**. T54; hoy hay línea de eventos por orden | `/changes/<id>` «Timeline» |
| 26 | Detalle de run | Mensaje libre al run (follow-up) | [V] caja «Follow up» | **en rama**. Formulario «Nota para el agente» ya en la web (T56c); la entrega en el turno siguiente está en `feat/t56b-entrega-notas` | `/changes/<id>`; `impl-t56b.md` |
| 27 | Detalle de run | Adjuntos en el follow-up | [V] «Add attachment» | **falta sin tarea**. → T96 | — |
| 28 | Detalle de run | Responder una pregunta pendiente | [V:F] run bloqueado con pregunta | **web**. Probado de punta a punta: la activity pasa de «Espera respuesta» a «Pendiente» | `/activities/<id>` «Responder pregunta» |
| 29 | Detalle de run | Parar el run | [V] «Stop run» | **web**. «Cancelar change» con casilla de confirmación (D-B); probado: change `Cancelado` | `/changes/<id>`; D9 |
| 30 | Detalle de run | Parar un turno suelto sin cancelar el change | [V:F] Stop por agente | **no se replica**. D4 excluye `stop` del residente; D-B limita a cancelar el change | D9 D-B, §4 |
| 31 | Detalle de run | Ir al subagente (hijo) | [V] «Open chat: implementation» | **web**. Enlaces a cada activity del change | `/changes/<id>` |
| 32 | Detalle de run | Duración y coste por agente, total y propio | [V] árbol con «$ total ($ self)» | **web**. Coste por intento y total del change; sin total/propio por árbol | `/activities/<id>` «Intentos» |
| 33 | Detalle de run | Metadata (entorno, harness, modelo, tiempos) | [V] panel Metadata | **web**. «Metadata de ejecución» y `run.json` | `/activities/<id>` |
| 34 | Detalle de run | Copiar nombre / id / valor | [V] botones «Copy …» | **falta sin tarea**. → T94 | — |
| 35 | Detalle de run | Uso del run desplegable | [V] «Usage $1.09» | **web**. Coste por intento y total | `/changes/<id>` «Coste total» |
| 36 | Detalle de run | Menú More: «View worker» | [V] menuitem | **falta sin tarea**. → T94 (enlace del activity a su rol y plantilla) | — |
| 37 | Detalle de run | Menú More: «Score run» | [V] menuitem | **en cola**. T65 | T65 |
| 38 | Detalle de run | Menú More: «Add to benchmark» | [V] menuitem | **en rama**. `fab bench add-task` en `feat/t63-t66c` (T66c); sin botón web → T88 | `impl-t63a-t66c.md` |
| 39 | Detalle de run | Refresco en vivo | [V:F] run en ejecución | **web**. Sondeo de 2 s («Actualización cada 2 s»); SSE solo si se mide que no basta (T55) | pie de la web |
| 40 | Detalle de run | Diff y veredicto del run | [V:F] PR y revisión | **web**. Diff, veredicto de validador y comentarios | `/activities/<id>` «Diff» |
| 41 | Detalle de run | Enlace al PR y al issue del run | [V:F] el run enlaza PR/issue | **falta sin tarea**. → T95 | — |
| 42 | Dashboard | Interacciones humanas por PR | [V] «Human interactions per PR» | **web**. Tabla «Intervenciones humanas por change» (decisiones, respuestas, reintentos); sin gráfico → T82 | `/metricas` |
| 43 | Dashboard | Mediana de ciclo, hitos desde la creación | [V] «Median cycle time» | **web**. Primera activity, revisión, decisión, terminal; mediana y p90 | `/metricas` |
| 44 | Dashboard | Ciclo en 4 tramos con el PR (kickoff→PR, PR→1.ª revisión humana, →merge) | [V] 4 botones «not measured» | **falta sin tarea**. → T83 | — |
| 45 | Dashboard | PRs abiertos y fusionados en el tiempo | [V] casillas Opened/Merged | **falta sin tarea**. → T83 | — |
| 46 | Dashboard | Runs por tipo de agente | [V] casillas Foreman/Code… | **web**. Tabla «Activities de la cohorte por tipo» (sin gráfico → T82) | `/metricas` |
| 47 | Dashboard | Selector de rango de fechas | [V] «Select date range» | **web**. 7 días, 30 días, todo; rango libre → T82 | `/metricas` |
| 48 | Dashboard | Gráficos de series temporales | [V] gráficas con eje de fechas | **falta sin tarea**. → T82 (SVG de servidor, con tabla equivalente) | — |
| 49 | Dashboard | Gasto por PR | [V:F] coste por PR | **web**. Coste por change y «Top 10» (hay 4 changes sin coste completo: «No medido») | `/metricas` «Coste» |
| 50 | Dashboard | Gasto por agente y por modelo | [V:F] pestaña Spending | **web**. Por adaptador y por modelo, con subtotal medido | `/metricas` |
| 51 | Dashboard | Gasto por fuente y por usuario | [V:F] pestaña Spending | **falta sin tarea**. → T82 | — |
| 52 | Dashboard | Desglose Compute / Platform / Inference | [V:F] pestaña Spending | **no aplica**. Corre en local con las credenciales del dueño; no hay plataforma que facture (D-A) | D9 D-A; catálogo §5.9 |
| 53 | Dashboard | Top 20 PRs más caros | [V:F] lista | **web**. Top 10 de changes | `/metricas` |
| 54 | Dashboard | Pestaña Scorers: tasa de aprobado | [V:F] «No scores in this range» | **en cola**. T65 | T65 |
| 55 | Blueprint | Grafo de etapas, transiciones y gates | [V] intro; [I:B] grafo | **web**. Flujo en SVG con tabla de etapas y transiciones | `/flujo?ws=plataforma` |
| 56 | Blueprint | Recuento de trabajo por etapa | [I:B] seguir el trabajo por etapa | **web**. «N changes» en cada etapa | `/flujo` |
| 57 | Blueprint | Panel con detalle de etapa o arista | [I:B] panel de selección | **web**. Se cubre con la tabla de etapas y transiciones, sin panel | `/flujo` |
| 58 | Blueprint | Vista YAML y edición del flujo | [I:B] vista YAML | **no se replica**. La puerta es un CAS del Store y un flag; el flujo se cambia en código, por PR | §4 «Gates en el prompt»; T53 |
| 59 | Blueprint | Generar propuesta de blueprint (crea un run) | [V] «Generate blueprint» | **no se replica**. Una propuesta de flujo es un PR normal, no un run que reescribe el flujo | §4; T53 |
| 60 | Workers | Lista de workers (foreman y secundarios) | [V] 5 workers de fábrica | **web**. Roles y plantillas en Configuración y Perfiles; no son entidades | `/config` «Workers», `/perfiles` |
| 61 | Workers | Buscar y filtrar workers por tipo | [V] «Search workers», filtro de tipo | **no aplica**. Los 5 roles son tipos de activity fijos | catálogo §7.8 |
| 62 | Workers | Crear worker propio (CUSTOM) | [V] botón New | **no se replica**. Un rol es un campo del perfil con digest, no una entidad creable | catálogo §7.8; T57 |
| 63 | Workers | Importar worker | [V] «Import» | **solo CLI**. `fab definition import`, `fab profile import` | `fab --help`; T59 |
| 64 | Workers | Duplicar o borrar un worker (menú) | [V] «Open menu» | **no aplica**. Roles fijos del dominio | catálogo §7.8 |
| 65 | Workers | Foreman como worker especial | [I:B] se trata aparte | **no aplica**. En fab el ciclo es código del Store y del pool, no un agente | catálogo §5.1 |
| 66 | Editor de worker | Prompt por worker | [V:F] pestaña Prompt | **web**. Una plantilla por rol; se guarda como perfil nuevo con digest | `/perfiles` |
| 67 | Editor de worker | Guardar sin editar en caliente | [V] «Save» deshabilitado sin cambios | **web**. Guardar crea otro perfil; asignarlo es otra acción con confirmación; probado | `/perfiles` |
| 68 | Editor de worker | Restaurar valores por defecto | [V] menú «Restore defaults» | **web**. Probado: vuelve al digest por defecto | `/perfiles` |
| 69 | Editor de worker | Borrar el worker | [V] menú «Delete» | **no aplica**. Roles fijos | catálogo §7.8 |
| 70 | Editor de worker | Descripción del worker | [V] campo Description | **no aplica**. Los roles no llevan descripción | — |
| 71 | Editor de worker | Pestaña Automations del worker | [V] «View automations» | **no aplica**. Una automation crea una señal; no se asocia a un rol | T68; §4 |
| 72 | Editor de worker | Modelo y adaptador por worker (harness) | [V] combos Harness y Model | **solo CLI**. Perfil v2 con adaptador y modelo por rol, por `fab profile import`; el editor web conserva esos campos pero no los edita → T84 | `/perfiles` texto «Adaptador, modelo y roles se conservan»; T57 |
| 73 | Editor de worker | Herencia desde los defaults («View defaults») | [V] enlace | **falta sin tarea**. → T84 (mostrar de dónde viene cada valor) | — |
| 74 | Editor de worker | Host del worker | [V] combo Host | **en cola**. T74 (runners) | T74 |
| 75 | Editor de worker | Runner por worker | [V] combo Runner | **en rama**. `fab ws runner` en `feat/t74a-runners-store`; sin selector web → T85 | `impl-t74a.md` |
| 76 | Editor de worker | MCPs por worker | [V] «Add MCP» | **en rama**. Perfil con `mcp` por rol (T72a, ya en la web completa) y `fab ws mcp` en `feat/t72b-ws-env` | `impl-t72a.md`, `impl-t72b.md` |
| 77 | Editor de worker | Secretos por worker | [V] «Add secret» | **en rama**. `fab ws env` en `feat/t72b-ws-env`: solo nombres (D-K) | `impl-t72b.md` |
| 78 | Automations | Lista de automations | [V] vacía | **web**. Lista con horario, estado y último resultado | `/automations` |
| 79 | Automations | Crear y editar una automation | [V] «New» | **en rama**. `fab automation add|…` en `feat/t68c-automation-cli`; la web lo remite a ese comando → T86 | `impl-t68c.md` |
| 80 | Automations | Horario hourly / daily / weekly / cron validado | [I:B] cuatro frecuencias | **en rama**. Parser en la web completa (`src/cron.ts`, T68a); alta en T68c | `impl-t68a-t69a.md` |
| 81 | Automations | «Run now» | [V:F] acción | **web**. Probado: crea una señal; la segunda vez da «Saltada: hay una señal o change abierto» | `/automations` |
| 82 | Automations | Pausar / habilitar | [I:B] enabled | **web**. Botón «Pausar» | `/automations` |
| 83 | Automations | Disparo por horario dentro del proceso | [V:F] ejecuta solo | **en rama**. `feat/t68d-pool-automations` (el pool llama al `tick`) | `impl-t68d.md` |
| 84 | Automations | Destino «etapa» además del worker | [I:B] selector Stage | **no se replica**. La señal entra por el principio del flujo | §4 «Destino etapa» |
| 85 | Automations | Triggers de GitHub, GitLab, Azure DevOps, Linear, Slack, Teams, Jira | [I:B] menú Add trigger | **en cola**. T70 (bloqueada por D-I: sin conectores hasta tener datos de T11 y T43) | T70; D9 D-I |
| 86 | Automations | La automation se tría sola | [V:F] ejecuta directo | **no se replica**. D-D: no se tría sola por ahora | D9 D-D |
| 87 | Webhooks | Receptor de entregas HTTP (aviso de GitHub) | [I:B] URL alojada | **en rama**. `feat/t69b-webhook`, dentro del residente; solo aviso y firma HMAC (D-E) | `impl-t69b.md` |
| 88 | Webhooks | Lista y búsqueda de webhooks | [V] «Search webhooks», «Add webhook» | **falta sin tarea**. → T87 | — |
| 89 | Webhooks | Vista de entregas con resultado matched / not_matched / skipped | [I:B] vista de entregas | **falta sin tarea**. → T87 (el registro lo trae T69b) | — |
| 90 | Webhooks | Webhook genérico que crea una señal | [I:B] dispara una automation | **no se replica**. D-E: solo aviso para GitHub, hasta que haya un caso real | D9 D-E |
| 91 | Webhooks | Autenticación TOKEN y URL_TOKEN | [I:B] tres modos | **no se replica**. Un token en la URL acaba en logs; solo firma HMAC | §4 |
| 92 | Webhooks | Rotar el secreto desde la interfaz | [I:B] rotación | **no se replica**. El secreto vive en el entorno del dueño (D-K) | D9 D-K |
| 93 | Webhooks | Tope de 20 webhooks | [I:B] límite de la UI | **no aplica**. Límite de interfaz, no contrato | recorrido-codex §2 |
| 94 | Scorers | Lista de scorers (jueces) | [V] 5 de fábrica con n.º de clasificaciones y agentes | **en cola**. T65 | T65 |
| 95 | Scorers | Definir un juez: rúbrica, clasificaciones, nota de aprobado, muestreo | [V:F] pestaña Config | **en cola**. T64: el bloque `scorers` del perfil y las funciones puras están hechos (T64a, T64b); falta el corredor | T64; `impl-t64a.md`, `impl-t64b.md` |
| 96 | Scorers | Alcance por worker, etapa o tarea completa | [I:B] selector de alcance | **en cola**. T64 (un rol o el change completo); «etapa» no se replica | T64 |
| 97 | Scorers | Muestreo y pausa con 0 % | [I:B] copy de sampling | **en cola**. T64 | T64 |
| 98 | Scorers | Detalle: tasa de aprobado y coste diario | [V] radios «Pass rate» / «Daily cost» | **en cola**. T65 | T65 |
| 99 | Scorers | «Score past runs» con vista previa | [V] botón | **en cola**. T65 | T65 |
| 100 | Scorers | Scorer defaults (runner base, herencia) | [V] «Customize» | **en cola**. T64 (valores heredados del perfil) | T64 |
| 101 | Self-improvement | Lista de candidatos de automejora | [V] «View all runs» | **en cola**. T67 | T67 |
| 102 | Self-improvement | Umbral de runs fallidos | [V] «Failed run threshold: 10» | **en cola**. T67; formulario web → T91 | T67 |
| 103 | Self-improvement | Modelo, runner y scorers de la automejora | [V] combos | **en cola**. T67 | T67 |
| 104 | Self-improvement | Instrucciones adicionales | [V] región | **falta sin tarea**. → T91 | — |
| 105 | Self-improvement | Run now | [V] botón | **en cola**. T67 («Ejecutar ahora», un candidato en curso por rol) | T67 |
| 106 | Self-improvement | Reviewers | [V] «Reviewer assignment» | **no aplica**. Un solo dueño (D-A) | D9 D-A |
| 107 | Self-improvement | Aprobación humana antes de aplicar | [V:F] PRs para aprobar | **en cola**. T67 y T58: solo el dueño asigna el perfil (D-H) | D9 D-H |
| 108 | Self-improvement | Experimentos pareados baseline vs candidato (análogo) | — | **web**. Lista, detalle por brazo e informe de `fab improve report` | `/experimentos/coste-validacion` |
| 109 | Benchmarks | Lista y búsqueda de benchmarks | [V] «Search benchmarks» | **en rama**. Motor en `feat/t66a-bench`, CLI en `feat/t66d-bench-cli`; sin vista web → T88 | `impl-t66a.md`, `impl-t66d.md` |
| 110 | Benchmarks | Filtro por tipo de worker | [V] «Filter by worker type» | **falta sin tarea**. → T88 | — |
| 111 | Benchmarks | Crear benchmark: variantes, repeticiones, suite | [I:B] objetivo task/agent/stage | **en rama**. `fab bench create|run|cancel|report` en `feat/t66d-bench-cli` | `impl-t66d.md` |
| 112 | Benchmarks | Estados Pendiente / Ejecutando / Scoring / Completado / Fallido / Cancelado | [I:B] etiquetas | **en rama**. Motor en `feat/t66a-bench`; vista → T88 | `impl-t66a.md` |
| 113 | Benchmarks | Puntuar trials y reemplazar solo los scores elegidos | [I:B] «Score run» | **en cola**. T66 (fase de puntuación) con T64 | T66 |
| 114 | Benchmarks | Suites y splits (análogo) | — | **web**. Lista de suites con tareas por split | `/experimentos` |
| 115 | Benchmarks | Modelo juez por defecto (Settings › Benchmarking) | [V] combo «Default benchmark model» | **en cola**. T66 | T66 |
| 116 | Factory definition | Árbol de ficheros de la factory | [V] agents/, runners/, scorers/, skills/ | **solo CLI**. `fab definition export <ws> <dir>` (ya en la web completa); la web no lo enseña → T89 | `fab --help`; `impl-t59.md` |
| 117 | Factory definition | Editor y «Save» en la web | [V] «Save» | **no se replica**. Solo visor; los cambios entran por PR | catálogo §7.10; T59 |
| 118 | Factory definition | Subir y crear ficheros; selector de rama | [V] Upload, New, «Branch: main» | **no se replica**. Idem: no se edita desde la web | catálogo §7.10 |
| 119 | Factory definition | Importar una definición | [V] «Import work» | **solo CLI**. `fab definition import <dir> --repo <ruta>` | `fab --help` |
| 120 | Factory definition | Skills de la factory | [V:F] 3 skills incluidas | **solo CLI**. Entran en el árbol exportado (T59) | `impl-t59.md` |
| 121 | Settings: General info | Nombre de la factory | [V] «Factory name» | **web**. El slug es fijo; el objetivo se edita en «Guardar ajustes» (T60) | `/workstreams` |
| 122 | Settings: General info | Factory UID copiable | [V] «Copy factory UID» | **no aplica**. El slug identifica el workstream | — |
| 123 | Settings: General info | Handle `@…` para mencionar al foreman | [V] «Foreman name» | **no se replica**. Admisión por texto: choca con D1, D2 y «el texto es dato» | catálogo §5.2 |
| 124 | Settings: General info | Avatar | [V] «Add an avatar» | **no aplica**. Cosmético; local y monousuario (D-A) | D9 D-A |
| 125 | Settings: General info | Quién puede enviar follow-ups | [V] dos radios (deshabilitados) | **no aplica**. Monousuario; D2 ya decide en el canal | D9 D-A |
| 126 | Settings: Worker defaults | Adaptador de la factory | [V] Harness | **web**. Se elige al crear (asistente, paso 3); cambiarlo después no tiene superficie → T84 | `/workstreams/nuevo` |
| 127 | Settings: Worker defaults | Modelo, host y runner por defecto | [V] combos | **solo CLI**. Modelo vía perfil v2; runner vía `fab ws runner` (rama T74a) → T84, T85 | `/config` |
| 128 | Settings: Worker defaults | Concurrencia y tope de tareas | [fab] ajustes de ejecución | **web**. Probado: concurrencia 4 guardada | `/workstreams` «Guardar ajustes» |
| 129 | Settings: Worker defaults | Secretos y MCP por defecto de la factory | [V] «Add secret», «Add MCP» | **en rama**. `fab ws env` y `fab ws mcp` (T72b) | `impl-t72b.md` |
| 130 | Settings: Factory integrations | Estado de GitHub y Jira | [V] proveedores «Not connected» | **web**. «Configurada» / «No configurada», sin valores | `/config` «Integraciones» |
| 131 | Settings: Factory integrations | Conectar Slack, Linear, GitLab, Azure, Teams | [V:F] se conectan en el equipo | **en cola**. T70 (bloqueada, D-I) | T70 |
| 132 | Settings: Factory integrations | Proveedores de nube AWS y Google Cloud | [V] «Not connected» | **no aplica**. Los runners remotos de D-J usan la máquina del dueño, no la nube del proveedor | D10; §4 |
| 133 | Settings: Factory repo | Dónde vive la definición | [V:F] «Warp managed repo» | **web**. Ruta del repositorio local en cada workstream; el árbol versionable es T59 (CLI) | `/workstreams` |
| 134 | Settings: Runners | Lista de runners | [V:F] runner `default` | **en rama**. `fab runner list` en `feat/t74a-runners-store`; sin vista web → T85 | `impl-t74a.md` |
| 135 | Settings: Runners | Alta, edición, baja y comprobación de un runner | [V] «New runner», «Edit runner» | **en rama**. `fab runner add|enable|disable|rm|check` (T74a, T74e); lado remoto T74c, T74d sin código | `impl-t74a.md`, `impl-t74e.md` |
| 136 | Settings: Runners | Runner remoto | [V:F] imagen Docker en la nube | **en cola**. T74 (D-J: sí, con credencial propia del runner, D10) | T74; D10 |
| 137 | Settings: Access | Usuarios y roles de la factory | [V:F] tabla de usuarios | **no aplica**. Local y monousuario; T73 bloqueada | D9 D-A |
| 138 | Settings: Danger zone | Borrar la factory | [V:F] «Delete Factory» | **web**. Se archiva (como `fab ws state … archived`), con el slug escrito para confirmar; probado; no se borra | `/workstreams` «Archivar workstream»; D11 |
| 139 | Settings: Danger zone | Borrado definitivo de datos | [V:F] irreversible | **no se replica**. D11: archivar como la CLI; no se borra | D11 |
| 140 | Settings: Danger zone | Reabrir un workstream archivado | — | **web**. «Reabrir (pausado)» | `/workstreams` |
| 141 | Settings: Danger zone | Pausar y activar | — | **web**. Probado «Pausar» | `/workstreams` |
| 142 | Onboarding | Asistente de alta de factory | [I:B] 6 pasos | **web**. 5 pasos (repo, objetivo y slug, adaptador y perfil, verificación, revisión); repo inexistente rechazado en su paso; crea en borrador | `/workstreams/nuevo` |
| 143 | Onboarding | Flags de aprobación, rutas protegidas, `--verify-setup` | [I:B] chequeos | **solo CLI**. `fab ws create --no-change-approval --protect …`: D-F los deja solo en la CLI | `fab --help`; D9 D-F |
| 144 | Onboarding | Canales de entrada: @mención en Slack, issue asignado | [V:F] canales | **no se replica**. Un texto no autoriza trabajo; entra por etiqueta (D1, D2) | catálogo §5.2 |
| 145 | Onboarding | Entrada por etiqueta de GitHub y por Jira | [fab] canales | **solo CLI**. `fab resident …`, `fab jira import` | `fab --help` |
| 146 | Settings: Account | Perfil de la cuenta | [V] Account, «Open admin panel» | **no aplica**. Local y monousuario | D9 D-A |
| 147 | Settings: Interface | Selector de tema | [V] combo de tema | **falta sin tarea**. → T92 (hoy sigue al sistema, sin selector) | `src/web-style.ts` |
| 148 | Settings: Notifications | Aviso del navegador | [V] switch «Browser notifications» | **web**. Botón «Avisos: no/sí»; el aviso lleva solo el recuento | pie de cada página; T55 |
| 149 | Settings: Integrations | Integraciones personales | [V] página Integrations | **no aplica**. Monousuario | D9 D-A |
| 150 | Settings: Privacy | «Help improve Warp» | [V] switch | **no aplica**. fab no envía telemetría | — |
| 151 | Billing | Saldo, compra de uso y plan | [V] $10…$100, «Upgrade to Scale» | **no aplica**. Corre local con las credenciales del dueño; el gasto sí se mide | D9 D-A |
| 152 | Factory API keys | API HTTP con clave por cabecera | [I] cliente de la API | **web**. `/api/v1/*` responde 401 sin clave (T71d, T71e) | `curl /api/v1/changes` → 401 |
| 153 | Factory API keys | Generar, listar y revocar claves | [V] «Generate new token» | **en rama**. `fab api-key` en `feat/t71b-api-key-cli`; sin pantalla web → T90 | `impl-t71b.md` |
| 154 | Networking | Rangos IP de salida de agentes alojados | [V] «Copy all … network ranges» | **no aplica**. No hay agentes alojados; el análogo es la sonda de egress | D9 D-A |
| 155 | Networking | Sonda de egress y sandbox (análogo) | — | **web**. «Sandbox y red», última sonda «Bloqueado» | `/config` |
| 156 | MCPs and apps | Lista de servidores MCP | [V] «New» | **web**. Solo nombres (`/config` «Servidores MCP»; en mi instancia sin `FABRICA_AGENT_SETTINGS` dice «No hay servidores») | `/config`; `src/web-config.ts:111` |
| 157 | MCPs and apps | Registro de servidores por referencia | [I:R] plantillas y servidores gestionados | **en rama**. `fab mcp list` y `mcp-servers.json` en `feat/t72c-mcp-registry` | `impl-t72c.md` |
| 158 | MCPs and apps | Autorizar un MCP con OAuth desde la interfaz | [I:R] «autorizar, desconectar» | **no se replica**. Token fuera de argv y de las rutas que el sandbox escribe (T34, T41) | AGENTS.md «Invariantes»; §4 |
| 159 | Agent harnesses | Adaptadores con su binario y su credencial local | [V] Claude Code, Codex, Pi | **web**. Tabla con «Sin pin» y «Detectada» | `/config` «Adaptadores» |
| 160 | Agent harnesses | Fijar los pines de binarios | [fab] verificación | **solo CLI**. `fab agents verify --pin` | `fab --help` |
| 161 | Agent harnesses | Guardar una credencial por defecto del harness | [V] «Claude Code default secret» | **no se replica**. No se guarda ninguna credencial en fab | §4; catálogo §5.8 |
| 162 | Secrets | Lista, alta e importación de secretos | [V] «New secret», «Import secrets» | **en rama**. Solo nombres: `fab ws env --import` (T72b); valores nunca (D-K) | `impl-t72b.md`; D9 D-K |
| 163 | Secrets | Valores de los secretos en un almacén | [V] valores alojados | **no se replica**. D-K: no hay almacén de valores | D9 D-K |
| 164 | Ciclo | Puertas humanas: aprobar, pedir cambios, rechazar | [V:F] spec y PR | **web**. Probado: «Pedir cambios» deja «Con comentarios»; el comentario es obligatorio | `/activities/<id>` |
| 165 | Ciclo | Reintentar un bloqueo o fallo | [fab] re-encolar | **web**. Probado: un change `Fallido` pasa a `Pendiente` | `/changes/<id>` «Reintentar change» |
| 166 | Ciclo | Revisión adversarial publicada entera | [V:F] review | **web**. «Veredicto y resultado» con el texto del validador | `/activities/<id>` |
| 167 | Ciclo | Fusionar el PR | [V:F] Warp no fusiona | **solo CLI**. `fab merge`, `fab gate allow`: D-F los deja en la CLI | `fab --help`; D9 D-F |

### Cosas de la CLI de fab sin equivalente en Warp (no cuentan en la matriz)

`fab merge`, `fab gate allow`, `fab worktree repair`, `fab validate publish`, `fab pr open|show`, `fab jira comment`, `fab resident report`, `fab agents verify --pin`, `fab exec`, `fab update`, `fab doctor`. Son las puertas y los procesos que D-F deja fuera de la web.

## 2. Resumen

Capacidades en la matriz: **167**. «No aplica» y «no se replica» son decisiones tomadas y no cuentan como brecha: quedan **130 capacidades replicables** como denominador.

| Estado | Nº | % de las replicables | % de todas |
|---|---:|---:|---:|
| web | 59 | 45.4 % | 35.3 % |
| solo CLI | 10 | 7.7 % | 6.0 % |
| en rama | 19 | 14.6 % | 11.4 % |
| en cola | 23 | 17.7 % | 13.8 % |
| falta sin tarea | 19 | 14.6 % | 11.4 % |
| **Replicables** | **130** | 100 % | 77.8 % |
| no aplica | 20 | — | 12.0 % |
| no se replica | 17 | — | 10.2 % |
| **Total** | **167** | | 100 % |

Por módulo (replicables):

| Módulo | web | solo CLI | en rama | en cola | falta sin tarea |
|---|---:|---:|---:|---:|---:|
| Home | 5 | 0 | 0 | 0 | 2 |
| Runs | 10 | 0 | 0 | 0 | 3 |
| Detalle de run | 8 | 0 | 3 | 4 | 4 |
| Dashboard | 7 | 0 | 0 | 1 | 4 |
| Blueprint | 3 | 0 | 0 | 0 | 0 |
| Workers | 1 | 1 | 0 | 0 | 0 |
| Editor de worker | 3 | 1 | 3 | 1 | 1 |
| Automations | 3 | 0 | 3 | 1 | 0 |
| Webhooks | 0 | 0 | 1 | 0 | 2 |
| Scorers | 0 | 0 | 0 | 7 | 0 |
| Self-improvement | 1 | 0 | 0 | 5 | 1 |
| Benchmarks | 1 | 0 | 3 | 2 | 1 |
| Factory definition | 0 | 3 | 0 | 0 | 0 |
| Settings | 9 | 1 | 3 | 2 | 1 |
| Onboarding | 1 | 2 | 0 | 0 | 0 |
| Factory API keys | 1 | 0 | 1 | 0 | 0 |
| Networking | 1 | 0 | 0 | 0 | 0 |
| MCPs and apps | 1 | 0 | 1 | 0 | 0 |
| Agent harnesses | 1 | 1 | 0 | 0 | 0 |
| Secrets | 0 | 0 | 1 | 0 | 0 |
| Ciclo | 3 | 1 | 0 | 0 | 0 |

Lectura:

- **Lo que ya se usa en la web** es el ciclo diario: bandeja, lista y detalle de changes con evidencia, decisiones, señales, cancelar, renombrar, notas, ajustes y alta de workstreams, perfiles, flujo, métricas y experimentos. Lo probé de punta a punta con acciones reales (§4).
- **Lo que está en rama** es casi todo T54, T56b, T64, T66, T68, T69, T71b, T72 y T74: la web las mostrará cuando se fusionen, y T80 pide fusionarlas antes de que la web nombre sus comandos.
- **Lo que está en cola sin código** son los jueces (T64c a T65), la automejora (T67) y el resto de T74. Es el bloque grande que falta de verdad.
- **Lo que no tenía tarea** da 20 tareas nuevas (T78 a T97): 16 de función, casi todas de superficie web sobre datos que ya existen, y 4 de errores.
- **«No se replica» y «no aplica»** (puertas en el prompt, texto que autoriza, secretos alojados, borrado definitivo, facturación, usuarios) siguen todas respaldadas por §4 o por D9, D10 y D11. No encontré ninguna que haya que reabrir.

## 3. Bugs encontrados al recorrer fab

| Id | Gravedad | Qué pasa | Cómo reproducirlo | Tarea |
|---|---|---|---|---|
| B1 [V] | baja | Al «Pedir cambios» o «Rechazar» sin comentario, el navegador queda en `/activities/<id>/review` con la sola frase «Elige una decisión y escribe un comentario…»: sin menú ni enlace de vuelta; recargar da 404. | `/changes` → un change en revisión → su activity `change_review` → **Pedir cambios** con el comentario vacío. Captura `fab-bug-pedircambios-vacio.png`. | T78 |
| B2 [V] | baja | La ayuda dice «fab web [--port 4310] web local de solo lectura» y no cita `--write`. | `fab --help` (`src/cli.ts:72`). | T79 |
| B3 [V la web; I el efecto] | media | `/automations` dice «Alta y edición: fab automation», pero ese comando no existe en la web completa; cae en `fab [prompt]` y muestra la ayuda del chat. Sin `--help`, un dueño que lo copie abriría una conversación con el agente [I: no lo ejecuté sin `--help` para no gastar un turno]. | Abrir `/automations`; `fab automation --help` imprime la ayuda del chat. Pasa igual con `fab score`, `fab bench`, `fab api-key` y `fab runner`, que hoy solo están en ramas. | T80 |
| B4 [V el síntoma; I la causa en producción] | baja | En `/metricas`, «Primer estado terminal registrado» da 0 muestras y 14 «No medido» aunque hay 2 changes completados. En la siembra, `change completed` cuelga de una activity de validador (qa) y `metricsEvents` descarta esas (`src/store.ts:1819`). | Abrir `/metricas` con la base de la siembra. Consulta: `events` de «Reducir el tiempo de validación local». Puede ser un defecto de la siembra y no del código: hay que mirar un merge real. | T81 |

Lo que probé y **funciona**: escapado de HTML en título y cuerpo de una señal (`<b>`, `<script>` salen como texto), casilla de confirmación obligatoria para cancelar, repetición de «Ejecutar ahora» (la segunda da «Saltada»), repo inexistente rechazado en el paso 1 del asistente, 401 de la API sin clave, y que el enlace de escritura es de un solo uso.

## 4. Recorrido de acciones en fab (instancia propia, copia de la siembra)

| Acción | Resultado |
|---|---|
| Canjear el enlace propio | Cookie de sesión; «Escritura habilitada» en el pie. |
| Crear señal con HTML en título y cuerpo | Se guarda y se muestra escapada; lista «Señales nuevas». |
| Triar la señal | Crea el change en `En revisión` con una activity `change_review`. |
| Renombrar el change | Título nuevo y aviso «Acción registrada». |
| Guardar nota para el agente | Aparece en «Notas» como «Pendiente de entrega»; el formulario avisa de que «ahora no hay ningún turno previsto». |
| Cancelar sin marcar la casilla | El navegador lo impide. Con la casilla: `Cancelado`. |
| Pedir cambios sin y con comentario | Sin: B1. Con: la activity queda «Con comentarios». |
| Reintentar un change fallido | Pasa a `Pendiente`; el motivo del fallo se conserva en el cuerpo. |
| Responder una pregunta abierta | La activity pasa de «Espera respuesta» a «Pendiente». |
| Pausar, guardar ajustes y archivar un workstream (escribiendo el slug) | Funcionan; archivar muestra cuántos changes hay en curso y «Reabrir (pausado)» lo deshace. |
| Asistente de alta (5 pasos) | Rechaza un repo inexistente; con un repo git crea `brecha-e2e` en borrador con la lista «Antes de activar». |
| Perfiles: guardar plantilla, asignar con confirmación, restaurar valores por defecto | Digest nuevo, asignado y restaurado al por defecto, cada uno con su aviso. |
| Automation (creada por script contra mi copia, porque la web no la crea) | «Ejecutar ahora» crea una señal; la segunda vez, «Saltada: hay una señal o change abierto». |
| «Marcar como visto» en la bandeja | Cambia a «Visto · deshacer» y persiste al recargar. |
| Interruptor «Avisos» | Es un botón del pie (`#fab-notify`); no pedí el permiso del navegador. |

No probé: aprobar una `change_review` hasta el final (habría pedido al pool lanzar la investigación, que mi instancia no ejecuta), rechazar una revisión ni «Ignorar» una señal.

## 5. Faltantes sin tarea: tareas nuevas

Ids desde **T78**. Cada tarea trae `covers` con las capacidades de la matriz que cierra (campo añadido a la forma de `task.json`; el orquestador puede quitarlo). Las cuatro primeras son los bugs de §3. Dependencias: solo ids que existen en `task.json` (T46 a T77).

```json
[
  {
    "id": "T78",
    "title": "Bug: los errores de una acción web se muestran en una página sin navegación",
    "phase": "F4",
    "why": "Al pedir cambios o rechazar sin comentario, el navegador queda en `/activities/<id>/review` con una sola línea («Elige una decisión y escribe un comentario…»), sin menú, sin enlace de vuelta y con 404 al recargar.",
    "where": "src/web-actions.ts (respuesta de error de `performAction`), src/web.ts (plantilla de página)",
    "proposal": "Devolver el error dentro de la plantilla normal de la web, con el menú, el mensaje y un enlace a la página de origen; mantener el código de estado. Comprobar las demás acciones con error de validación (título vacío, nota vacía, slug distinto).",
    "acceptance": "Test: POST sin comentario devuelve 400 con el menú y un enlace a la activity; ningún error de acción devuelve una página sin `<nav>`; el texto del error se escapa; la acción no se ejecuta.",
    "estimate": "1 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T47"
    ],
    "covers": [
      "Ciclo: puertas humanas",
      "Detalle de run: responder"
    ],
    "pr": null
  },
  {
    "id": "T79",
    "title": "Bug: la ayuda de `fab web` sigue diciendo «solo lectura»",
    "phase": "F4",
    "why": "`fab --help` dice «fab web [--port 4310]  web local de solo lectura» y no menciona `--write`, que sí existe y es la forma de usar las acciones.",
    "where": "src/cli.ts:72",
    "proposal": "Actualizar la línea y documentar `--write` y `--port 0`; comprobar que la guía de techdocs de la web dice lo mismo.",
    "acceptance": "Test de ayuda: la salida de `fab --help` contiene `--write`; ninguna línea dice «solo lectura» para `fab web`.",
    "estimate": "0,5 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [],
    "covers": [
      "Todas las acciones de la web"
    ],
    "pr": null
  },
  {
    "id": "T80",
    "title": "Bug: la web cita comandos que aún no existen en la web completa",
    "phase": "F4",
    "why": "La página `/automations` dice «Alta y edición: fab automation add», pero `fab automation` no está en `integ/web-completa` (T68c no está fusionada). El comando desconocido cae en `fab [prompt]` y arranca el chat del agente: un dueño que copie la línea gasta una conversación en vez de ver un error.",
    "where": "src/web-automations.ts:2 y :12; src/cli.ts (despacho de subcomandos); ramas feat/t68c-automation-cli, feat/t71b-api-key-cli, feat/t66d-bench-cli, feat/t72b-ws-env, feat/t72c-mcp-registry, feat/t74a-runners-store",
    "proposal": "(1) Fusionar en la integración las ramas con CLI ya implementadas antes de enseñar sus comandos. (2) Un test que recorra los textos de la web con `fab <verbo>` y compruebe que cada verbo está en `fab --help`. (3) Decisión del dueño aparte: que un verbo de la fábrica mal escrito dé «comando desconocido» y no abra el chat.",
    "acceptance": "El test de coherencia falla si la web nombra un comando ausente de `fab --help`; `fab automation add --help` responde con su ayuda y no abre el chat.",
    "estimate": "1-2 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": [
      "T68",
      "T71",
      "T66",
      "T72",
      "T74"
    ],
    "covers": [
      "Automations: crear y editar",
      "Factory API keys: generar claves",
      "Runners",
      "Benchmarks"
    ],
    "pr": null
  },
  {
    "id": "T81",
    "title": "Bug probable: el hito «terminal» del tiempo de ciclo queda sin muestras",
    "phase": "F3",
    "why": "En los datos de prueba, `/metricas` muestra «Primer estado terminal registrado: 0 muestras, 14 no medido» aunque hay 2 changes completados. El evento `change completed` cuelga de una activity de validador (qa) y `metricsEvents` descarta los eventos de activities con validador.",
    "where": "src/store.ts:1806-1820 (`metricsEvents`, filtro `activity_id NOT IN … validator IS NOT NULL`); src/metrics.ts:36",
    "proposal": "Comprobar con un merge real a qué activity cuelga `change completed`. Si es una activity de validador, contar el evento terminal aunque cuelgue de ella y seguir excluyendo solo los eventos de decisión de los validadores. Si el dato de prueba es el defectuoso, corregir la siembra y dejar una prueba que lo cubra.",
    "acceptance": "Un change completado, uno cancelado y uno fallido dan 3 muestras en el hito terminal; la mediana coincide con la diferencia entre la creación y el evento; el resto de métricas no cambia.",
    "estimate": "1 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T48"
    ],
    "covers": [
      "Dashboard: mediana de ciclo"
    ],
    "pr": null
  },
  {
    "id": "T82",
    "title": "Métricas: gráficos, rango libre y gasto por fuente y por actor",
    "phase": "F4",
    "why": "Warp dibuja series por día, deja elegir el rango y reparte el gasto por fuente y usuario. `/metricas` solo tiene tablas, tres rangos fijos y reparto por adaptador y modelo.",
    "where": "src/web-metrics.ts, src/metrics.ts, src/store.ts (`metricsCohort`, `metricsEvents`)",
    "proposal": "Gráficos SVG de servidor (changes creados por día, coste por día, intervenciones por día) con la tabla equivalente debajo; rango con fecha de inicio y fin; tabla de coste por fuente del change y por actor del primer evento. Sin librerías ni script nuevo.",
    "acceptance": "Los números del gráfico coinciden con la tabla; un día sin datos se dibuja como hueco, no como cero; rango inválido se rechaza; coste desconocido sigue «No medido»; la CSP no cambia.",
    "estimate": "3-4 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T48"
    ],
    "covers": [
      "Dashboard: gráficos",
      "Dashboard: selector de rango",
      "Dashboard: gasto por fuente y usuario"
    ],
    "pr": null
  },
  {
    "id": "T83",
    "title": "Métricas con PR: tramos hasta el PR, revisión humana y merge, y PRs en el tiempo",
    "phase": "F4",
    "why": "Warp mide kickoff→PR, PR→primera revisión humana y →merge, y cuenta PRs abiertos y fusionados. fab abre el PR con `fab pr open` pero no guarda su fecha como dato consultable ni lo enseña en el change.",
    "where": "src/store.ts (evento de PR abierto y de merge), src/cli.ts (`pr open`, `merge`), src/web-metrics.ts, src/web-changes.ts",
    "proposal": "Registrar como eventos el PR abierto (con su URL) y el merge, mostrar el enlace en el detalle del change y añadir a `/metricas` los tramos kickoff→PR y PR→merge y la serie de PRs. «Primera revisión humana» queda «No medido» hasta que un conector la lea por la API (solo lectura).",
    "acceptance": "Con eventos sintéticos, cada tramo da la diferencia exacta; un change sin PR no se oculta, aparece «No medido»; la URL del PR se escapa y solo admite https; no hay llamadas de red al servir.",
    "estimate": "3-5 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": [
      "T48",
      "T49"
    ],
    "covers": [
      "Dashboard: ciclo con PR",
      "Dashboard: PRs abiertos y fusionados"
    ],
    "pr": null
  },
  {
    "id": "T84",
    "title": "Editor web de adaptador y modelo por rol, con la herencia visible",
    "phase": "F6",
    "why": "El perfil v2 permite adaptador y modelo por rol, pero el editor web solo cambia las plantillas («Adaptador, modelo y roles se conservan»). Tampoco se puede cambiar el adaptador de un workstream ya creado, ni ver de dónde sale cada valor.",
    "where": "src/web-profile.ts, src/profile.ts (esquema v2, `resolveRole`), src/store.ts (adaptador del workstream)",
    "proposal": "En `/perfiles`, por rol: adaptador y modelo con «heredado de: perfil / workstream». Guardar crea un perfil nuevo con digest, como hoy. Cambiar el adaptador del workstream es una acción aparte con confirmación y evento con el valor anterior. Un adaptador no confinable en un workstream de canal se rechaza (T32).",
    "acceptance": "Guardar no altera ningún perfil existente; dos guardados iguales dan el mismo digest; el evento guarda el adaptador anterior; modelo con caracteres no permitidos se rechaza; una activity en curso conserva su perfil.",
    "estimate": "4-6 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [
      "T57",
      "T58"
    ],
    "covers": [
      "Editor de worker: modelo y adaptador",
      "Editor de worker: herencia",
      "Worker defaults: adaptador y modelo"
    ],
    "pr": null
  },
  {
    "id": "T85",
    "title": "Runners en la web: lista, comprobación y asignación",
    "phase": "F9",
    "why": "El runner existe solo por `fab runner` y `fab ws runner` (rama). Warp lo gestiona desde Settings › Runners y lo elige en cada worker.",
    "where": "src/web-config.ts, src/web-ws.ts; módulos de T74a y T74e",
    "proposal": "Lista de runners con su estado y los datos «declarados, no verificados» (D10); acción «Comprobar» que hace `runner check`; selector de runner por workstream con confirmación y evento. Alta y baja siguen en la CLI hasta decidir lo contrario.",
    "acceptance": "La página no muestra credenciales ni rutas del runner; «Comprobar» no lanza trabajo; asignar deja evento con el anterior; sin runners la página no da error 500.",
    "estimate": "3-4 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [
      "T74",
      "T52"
    ],
    "covers": [
      "Runners: lista",
      "Editor de worker: runner"
    ],
    "pr": null
  },
  {
    "id": "T86",
    "title": "Alta y edición de automations desde la web",
    "phase": "F8",
    "why": "Hoy la web solo lista, ejecuta y pausa; la alta y la edición piden `fab automation`. Warp las crea y edita en pantalla.",
    "where": "src/web-automations.ts, src/web-actions.ts; módulos de T68b y T68c",
    "proposal": "Formulario con nombre, workstream, horario (cada hora, diario, semanal o cron validado al guardar) y plantilla fija de señal. Edición y borrado con confirmación. Sin autotriage (D-D) y sin destino «etapa».",
    "acceptance": "Cron inválido se rechaza con su mensaje; la plantilla se escapa; el evento guarda quién y el valor anterior; crear no lanza turnos; los tests no esperan al reloj.",
    "estimate": "3-4 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [
      "T68",
      "T47"
    ],
    "covers": [
      "Automations: crear y editar"
    ],
    "pr": null
  },
  {
    "id": "T87",
    "title": "Webhooks en la web: lista y entregas con su resultado",
    "phase": "F8",
    "why": "Warp lista los webhooks y sus entregas con resultado matched, not_matched o skipped. El receptor de fab (T69b) las registra, pero no hay pantalla.",
    "where": "src/web.ts, tablas de T69b (`webhook_deliveries`)",
    "proposal": "Ruta de solo lectura con las entregas (resultado, tamaño, fecha, id) y el estado del receptor. Nunca se muestra el cuerpo ni el secreto; la alta y la rotación siguen fuera (D-K, §4).",
    "acceptance": "Una entrega sin firma aparece como rechazada sin cuerpo; el HTML no contiene el secreto ni el cuerpo; sin tablas la página dice «Sin receptor».",
    "estimate": "2-3 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": [
      "T69"
    ],
    "covers": [
      "Webhooks: lista",
      "Webhooks: vista de entregas"
    ],
    "pr": null
  },
  {
    "id": "T88",
    "title": "Benchmarks en la web: lista, estados, informe y «añadir a suite»",
    "phase": "F7",
    "why": "Warp lista los benchmarks, filtra por tipo de worker y deja añadir un run a un benchmark. En fab el motor y la CLI están en ramas y la web no los enseña.",
    "where": "src/web-experiments.ts, src/web-changes.ts; módulos de T66a, T66c y T66d",
    "proposal": "Rutas de lectura de benchmarks con estados (pendiente, en curso, puntuando, completo, fallido, cancelado), matriz de variantes e informe. Con `--write`: cancelar y «Añadir a suite» desde un change terminado, que genera la tarea candidata en un fichero para revisar.",
    "acceptance": "Los números coinciden con `fab bench report`; cancelar no lanza más filas; la tarea generada pasa `parseSuite`; una suite usada no cambia de digest.",
    "estimate": "4-5 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": [
      "T66",
      "T62"
    ],
    "covers": [
      "Benchmarks: lista y filtro",
      "Benchmarks: estados",
      "Detalle de run: Add to benchmark"
    ],
    "pr": null
  },
  {
    "id": "T89",
    "title": "Visor del árbol de definición en la web",
    "phase": "F6",
    "why": "`fab definition export` ya escribe el árbol (workstream, perfil por rol, validadores, skills), pero la web no lo enseña, aunque T59 lo proponía. Warp tiene el árbol con el contenido de cada fichero.",
    "where": "src/definition.ts, src/web-config.ts",
    "proposal": "Ruta de solo lectura que genera el árbol en memoria y lo muestra con el contenido de cada fichero. Sin edición ni subida (catálogo §7.10): cambiar es un PR.",
    "acceptance": "El árbol no contiene rutas absolutas ni valores de entorno; un fichero grande se trunca con aviso; la página no escribe en disco; coincide con `fab definition export`.",
    "estimate": "2-3 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T59"
    ],
    "covers": [
      "Factory definition: árbol"
    ],
    "pr": null
  },
  {
    "id": "T90",
    "title": "Claves de la API desde la web: crear, listar y revocar",
    "phase": "F9",
    "why": "La API `/api/v1` ya responde, pero crear una clave exige `fab api-key` (rama). Warp lo hace en Factory API keys.",
    "where": "src/web-actions.ts, src/web-api.ts; tabla `api_keys` de T71a",
    "proposal": "Pantalla con las claves (nombre, ámbito, creación, último uso). Crear muestra la clave una sola vez, nunca en la URL ni en un log; revocar pide confirmación. Se guarda solo el hash.",
    "acceptance": "La base y los logs no contienen la clave en claro; una clave revocada da 401; la página no la repite al recargar; el ámbito `read` no muta.",
    "estimate": "2-3 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [
      "T71",
      "T47"
    ],
    "covers": [
      "Factory API keys: generar claves"
    ],
    "pr": null
  },
  {
    "id": "T91",
    "title": "Configuración de la automejora en la web",
    "phase": "F7",
    "why": "Warp tiene un formulario con umbral de fallos, scorers, modelo, runner e instrucciones adicionales. T67 cubre la lista y «Ejecutar ahora», no el formulario.",
    "where": "src/improve-auto.ts (T67), src/web-experiments.ts",
    "proposal": "Formulario con umbral y ventana, jueces que cuentan e instrucciones adicionales para el agente proponente, guardado en el perfil con digest. No cambia quién aplica la mejora (D-H).",
    "acceptance": "Guardar crea perfil nuevo; un umbral fuera de rango se rechaza; las instrucciones se delimitan como texto del dueño; el perfil vigente no cambia sin la acción de T58.",
    "estimate": "2-3 d",
    "risk": "medio",
    "status": "pending",
    "depends_on": [
      "T67",
      "T58"
    ],
    "covers": [
      "Self-improvement: instrucciones adicionales",
      "Self-improvement: umbral"
    ],
    "pr": null
  },
  {
    "id": "T92",
    "title": "Selector de tema claro, oscuro o del sistema",
    "phase": "F4",
    "why": "Warp deja elegir el tema. La web de fab sigue solo al sistema.",
    "where": "src/web-style.ts, src/web.ts",
    "proposal": "Control en el pie con tres opciones y `data-theme` guardado en localStorage dentro de try/catch; sin script en línea (CSP).",
    "acceptance": "Sin localStorage la página sigue el sistema; elegir oscuro fija el atributo y sobrevive a la recarga; los contrastes pasan en ambos temas.",
    "estimate": "1 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T46"
    ],
    "covers": [
      "Settings: Interface"
    ],
    "pr": null
  },
  {
    "id": "T93",
    "title": "Barra lateral de workstreams: buscar, ordenar y fijar",
    "phase": "F4",
    "why": "La lista lateral de Warp tiene búsqueda, orden y pin. La de fab es una lista fija en el orden de creación.",
    "where": "src/web.ts (navegación de workstreams)",
    "proposal": "Caja de búsqueda y fijado guardado en localStorage; los archivados se agrupan al final.",
    "acceptance": "Con 30 workstreams la búsqueda filtra sin recargar; fijar no cambia el dominio; sin localStorage la lista sale como hoy.",
    "estimate": "1 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T46"
    ],
    "covers": [
      "Settings: varias factories"
    ],
    "pr": null
  },
  {
    "id": "T94",
    "title": "Pulido de bandeja y detalle: selección múltiple, contador, copiar id y enlace al rol",
    "phase": "F4",
    "why": "Faltan cuatro gestos pequeños de Warp: marcar varios elementos como vistos, el contador junto al menú, copiar el id y saltar de una activity a su rol.",
    "where": "src/web.ts (bandeja y plantilla), src/web-changes.ts",
    "proposal": "«Seleccionar todo» y «Marcar los seleccionados como vistos»; contador de la bandeja en el menú; botón de copiar id; enlace de cada activity a su rol en `/perfiles`.",
    "acceptance": "Los seleccionados pasan a «Visto» y se deshacen; el contador coincide con la bandeja; copiar no necesita script en línea; sin localStorage nada se rompe.",
    "estimate": "1-2 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T49"
    ],
    "covers": [
      "Home: selección múltiple",
      "Home: contador",
      "Detalle de run: copiar id",
      "Detalle de run: View worker"
    ],
    "pr": null
  },
  {
    "id": "T95",
    "title": "Enlace al PR y al issue en el detalle del change",
    "phase": "F4",
    "why": "El detalle de un run de Warp enlaza su PR y su issue. fab abre el PR con `fab pr open` y el change no lo muestra.",
    "where": "src/web-changes.ts, src/store.ts, src/cli.ts (`pr open`)",
    "proposal": "Guardar la URL del PR y la clave del issue de origen y mostrarlas como enlaces; solo https a hosts conocidos, el resto como texto.",
    "acceptance": "Una URL `javascript:` o de otro host no se vuelve enlace; un change sin PR no muestra el bloque; el texto se escapa.",
    "estimate": "1-2 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T49"
    ],
    "covers": [
      "Detalle de run: enlace al PR y al issue"
    ],
    "pr": null
  },
  {
    "id": "T96",
    "title": "Adjuntos en la nota del dueño",
    "phase": "F5",
    "why": "Warp permite adjuntar ficheros al follow-up. La nota de fab es solo texto (T56c).",
    "where": "src/web-actions.ts, src/admission/sessions.ts (`reconstructPrompt`), tabla `change_notes`",
    "proposal": "Adjuntos de texto de hasta 64 KiB, guardados fuera de toda ruta que el sandbox escriba y entregados dentro del bloque delimitado con nonce junto a la nota. Sin binarios ni imágenes en la primera versión.",
    "acceptance": "Un adjunto con instrucciones no altera el formato de salida (canario); un symlink o un nombre con `..` se rechaza; el adjunto se entrega una sola vez; prueba con `claude` real y confinado.",
    "estimate": "3-4 d",
    "risk": "alto",
    "status": "pending",
    "depends_on": [
      "T56"
    ],
    "covers": [
      "Detalle de run: adjuntos"
    ],
    "pr": null
  },
  {
    "id": "T97",
    "title": "Lista de changes: filtros por worker y por origen automation, y sentido del orden",
    "phase": "F4",
    "why": "Faltan tres filtros de Runs: por worker, por «segundo plano» (los que nacieron de una automation) y por fecha de creación; el orden no deja elegir ascendente o descendente y la lista no cuenta las activities hijas.",
    "where": "src/web-changes.ts:5-41 (`Query`, filtros), src/store.ts (`listChanges`)",
    "proposal": "Añadir `source=automation` al filtro de fuente (T68), filtro por adaptador y por rol, filtro por fecha de creación junto al de actualización, `dir=asc|desc` y una columna con el número de activities.",
    "acceptance": "Cada filtro da el conjunto exacto con datos sintéticos; un change sin dato aparece como «No medido»; la consulta sigue en un Store de solo lectura; 1000 changes en menos de 300 ms.",
    "estimate": "2 d",
    "risk": "bajo",
    "status": "pending",
    "depends_on": [
      "T49",
      "T68"
    ],
    "covers": [
      "Runs: filtro por worker",
      "Runs: filtro por fecha",
      "Runs: orden",
      "Runs: Background runs",
      "Runs: jerarquía"
    ],
    "pr": null
  }
]
```

Orden sugerido: T78 y T79 son de media hora a un día y no dependen de nada abierto. T80 antes de fusionar más CLI. T82, T92, T93, T94, T95 y T97 son de superficie web sobre datos que ya existen, de riesgo bajo, y pueden ir en paralelo si no comparten `src/web.ts`. T84, T85, T86, T90 y T96 tocan escritura o credenciales: llevan verificador de otro modelo.

## 6. Lo que no revisé

- **Warp:** no abrí ningún formulario de alta, menús `New`, el editor del scorer (la pestaña Config), el submenú de cada filtro de Runs ni los desplegables del Dashboard; los contenidos salen del catálogo y de los informes de Codex y Fable. La cuenta es de prueba (una factory, un run, sin integraciones): lo que depende de PRs, issues o Slack lo vi vacío.
- **fab:** no probé la aprobación hasta el final de una revisión, «Ignorar» una señal, el asistente con un adaptador no confinable ni el aviso del navegador con permiso concedido. No recorrí las ramas: su estado sale de `git merge-base`, `git worktree list` y los `impl-*.md`. No ejecuté suites de tests.
- **Datos:** la siembra marca todas las fuentes como «No medido», así que no probé los filtros de fuente con valores reales.
- **MCP en `/config`:** en mi instancia el listado de servidores sale vacío porque no definí `FABRICA_AGENT_SETTINGS`; el código lo lee de ahí (`src/web-config.ts:111`).

<!-- FIN -->
