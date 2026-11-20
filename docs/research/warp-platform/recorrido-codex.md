# Warp Factories: recorrido de solo lectura

Fecha: 19 de noviembre de 2026 (Lima). Rol: Goldfish investigador. Destinatario del informe: Fable 5.2, para el cruce posterior con fab. No se implementó ni cambió configuración. El worktree de referencia está en `feat/fab-web`; este informe no evalúa paridad con fab.

**Evidencia.** `[V]` = interfaz o artefacto observado; `[I:B]` = comportamiento inferido del bundle principal; `[I:R]` = candidato estático de REA, no ejecución observada; `[V:F]` = interfaz observada en el recorrido anterior, no revalidada aquí. Una captura durante carga prueba solo el estado de carga, no un vacío ni una denegación. Los nombres de operaciones no prueban que se ejecutaran o que la sesión tenga permiso.

## 1. Resumen

[V] Warp Factories presenta una bandeja personal, un listado transversal de runs y, por factory, superficies de operación, configuración y evaluación. [V] El menú actual muestra **Blueprint** (marcado «New») y **Workers**. [I:B] Blueprint añade una representación de etapas, transiciones y gates, distinta del editor de ficheros de Factory definition. [I:B] Parte de la ejecución y la evaluación puede apuntar a una etapa, no solo a un worker.

```text
Persona → Home / Runs ─────────────────────────→ conversación y seguimiento
          New Chat / evento / horario / webhook → run → worker o etapa
                                                        ↑
Equipo → Factory → definición + Blueprint (etapas, transiciones, gates)
                ├→ Dashboard ← runs, uso y scoring
                ├→ Scorers / Benchmarks → señales de evaluación
                └→ Self-improvement → propuesta revisable
Equipo → credenciales de harness, MCPs, secretos, API keys y billing
```

## 2. Módulos

Cada fila sigue el orden del brief: objetivo, flujo, pantallas y estados, modelo, acciones, reglas. Las acciones de escritura se describen, no se prueban.

| Módulo | Objetivo y flujo | Pantallas y estados | Modelo | Acciones y reglas |
|---|---|---|---|---|
| Home | [V] Priorizar runs que esperan una respuesta y volver a la conversación. | [V] Waiting on you, Active, Complete, Blocked y Failed; búsqueda y agrupación por día (`01-home`). | [V] Elemento de bandeja enlazado a una factory y a un run. [I:R] El cliente distingue marcado de notificación leído/no leído. | [V] Selección múltiple, abrir conversación, marcar resuelto, New run. No se marcó nada. |
| Runs | [V] Encontrar trabajo por estado y origen, incluso fuera de una factory. | [V] Search, Sort, Filter; My runs, Running, Complete, Failed, Blocked, Cancelled y Background runs (`02-runs`). [V:F] Filas con título, estado, hijos, fuente, creador y edad. | [V:F] Status, Agent, Factory, Source, Creator, Created on son dimensiones de filtro; no equivalen a los enums completos del servidor. | [V] Los filtros y la ordenación son controles de consulta. [V:F] Abrir la fila lleva al detalle. |
| Detalle de run | [V:F] Seguir la conversación y diagnosticar la ejecución y los hijos. | [V:F] Timeline, Agents y Metadata; un run bloqueado con pregunta pendiente. | [V:F] Run padre/hijo, turnos, segmentos, modelo, harness, uso y mensajes. [I:R] Hay un cliente de lectura en lote; el nombre no demuestra la estructura de su respuesta. | [V:F] Responder o detener son acciones distintas de navegar. Sin ejecución en vivo, PR, spec ni issue de ejemplo. |
| New Chat / New run | [V] Entrar a una tarea desde Home o el menú. | [V] Ambos enlaces apuntan a `/runs/new`. No se visitó. [I:B] Existe un compositor de `Run prompt` con soporte de adjuntos y expansión del texto. | [I:R] El bundle contiene un cliente `POST /agent/runs`; no se probó qué dispara la ruta al montarse. | [V] New Chat/New run. No se arrancó ni se comprobó la creación de un borrador. Fuente B `1398:15334`. |
| Dashboard | [V] Consultar productividad, gasto y evaluaciones. | [V] Productivity, Spending y Scorers, selector de rango y de vista de runs; ayudas de interacciones humanas, mediana de ciclo, PRs y total de runs (`03-dashboard`). | [V] Métricas agrupadas por vista y rango. [V:F] El catálogo anterior registra también el selector de coste. | [V] Cambiar vista y rango son consultas; no se infirieron agregaciones server-side de las etiquetas. |
| Blueprint | [I:B] Visualizar y ajustar el flujo aplicado de una factory, además de seguir el trabajo por etapa. | [V] Pantalla de introducción (`04-blueprint`). [I:B] Vistas grafo y YAML, panel de selección, Blueprint no disponible y carga con Retry; la plantilla por defecto es de solo lectura. | [I:B] `worker`, `start`, `stages`, `workers` opcional; subetapas, transiciones y estados de trabajo; gate humano con pregunta y salidas admitidas. | [I:B] Seleccionar etapa/arista, consultar YAML y revisar una propuesta. Generar propuesta crea un run; no se pulsó. Fuentes B `15:95388`, `17:17991`, `56:897`, `56:9896`, `1160:89573`, `1161:31021`. |
| Workers (antes Agents) | [V] Encontrar quién realiza el trabajo. [I:B] Foreman y workers secundarios se muestran como grupos distintos. | [V] Workers, Search workers, filtro All workers y New (`05-workers`). [V:F] El recorrido anterior vio el listado de cinco agentes base. | [I:B] El cliente enumera `TRIAGE`, `SPEC`, `IMPLEMENT`, `REVIEW`, `VERIFY`, `CUSTOM` para workers secundarios; trata `FOREMAN` por separado. No implica que se puedan crear todos. | [V] Buscar/filtrar y ver control New; no se abrió el alta. Fuente B `1161:39308`, `1161:41317`. |
| Editor de worker | [V:F] Cambiar instrucciones, recursos y ejecución de un agente. | [V:F] Prompt, Automations y Settings; la última agrupa descripción, MCPs, secretos, harness, modelo, host y runner. | [I:B] La definición puede referenciar una `source_path`; el cliente distingue raíces `agents` y `workers`. [V:F] Prompt y defaults se reflejan en la definición. | [V:F] Save, Restore defaults y Delete; no se pulsaron. Fuente B `1161:39308`. |
| Automations | [V:F] Lanzar trabajo por horario o evento. [I:B] El destino puede ser un worker o una etapa según la configuración. | [V] Automations, Manage Webhooks y New (`06-automations`). [I:B] El editor define selector Stage con estado No stages available / Unavailable y menú Add trigger. | [I:B] Horario: `hourly`, `daily`, `weekly`, `cron`; el cron tiene un campo con indicador de invalidez. Clases visibles en código: webhook, GitHub, Azure DevOps, GitLab, Linear, Slack, Microsoft Teams y Jira. | [I:B] Conectar proveedores y contar con permiso habilita opciones; GitLab añade check de disponibilidad por plan, y el editor contempla una bandera para Jira. No se lanzaron automatizaciones. Fuentes B `1171:20687`, `1171:96146`, `1171:99529`, `1171:104663`. |
| Webhooks | [V:F] Recibir entregas; la automatización suscrita decide si actúa. | [V] Búsqueda, Add webhook y Create automation (`07-webhooks`). [I:B] Existe vista de entregas y resultado de coincidencia. | [I:B] Webhook: nombre, modo de autenticación, enabled y fechas. Entrega: resultado, tamaño y fecha. El cliente valida niveles `webhook_ids`/`payload` con `matched`, `not_matched` o `skipped`. | [I:B] `TOKEN`, `URL_TOKEN`, `SIGNATURE`; el control de alta del menú de automatización se deshabilita si hay ≥20 webhooks, si carga o si falta permiso. Es un límite de UI, no de servidor comprobado. Fuentes B `1161:63499`, `1171:95229`, `1171:101100`, `1175:41980`. |
| Scorers | [V:F] Aplicar una rúbrica de calidad a ejecuciones. | [V] Search scorers y New (`08-scorers`). [V:F] Details y Config en un scorer existente. | [I:B] Alcance por workers, etapas o tarea completa; las etapas seleccionadas son un caso explícito. Sampling a 0% pausa scoring automático según el copy. | [I:B] Score past runs elige rango, muestra previsualización y permite repetir u omitir resultados previos antes de encolar. No se abrió ni ejecutó. Fuentes B `1160:57091`, `1175:91605`, `1175:92321`. |
| Self-improvement | [V:F] Revisar propuestas de mejora de la propia factory. | [V] Configure y Run now (`09-self-improvement`); Configuration, Settings, instrucciones adicionales y umbral (`10-self-improvement-config`). | [V] Failed run threshold, Reviewers y Scorers. [I:R] Cliente GraphQL con listado de runs de automejora, PRs y resumen de PRs. | [V] Save, Cancel, Customize y Run now; ninguno se pulsó. [I:R] Hay despacho manual y cierre de PR como candidatos, no prueba de aprobación o merge. |
| Benchmarks | [V:F] Repetir casos y comparar variantes/modelos con scorers. | [V] Search benchmarks, filtro por tipo de worker y New (`11-benchmarks`). [I:B] Pendiente, Ejecutando, Scoring, Completado, Fallido, Cancelado como etiquetas de cliente. | [I:B] Objetivo `task`, `agent` o `stage`; whole task incluye runs descendientes. Nombre para corrida y selección de scorers. | [I:B] Score run califica trials completos; reemplaza scores solo de los scorers seleccionados. No se probó Add to benchmark desde un run real. Fuentes B `1175:131365`, `1175:184882`, `1175:236068`, `1175:320039`. |
| Factory definition | [V:F] Inspeccionar o editar la configuración versionable de la factory. | [V] Factory definition, menú y Save (`12-definition`). [V:F] Árbol de archivos y editor de `factory.yaml` y definiciones de agentes. | [V:F] La definición contiene defaults, agentes e integraciones; no es la misma vista que Blueprint. | [V] Save estaba deshabilitado en la captura. No se editó ni aplicó configuración. |
| Factory Settings: General info | [V] Cambiar identidad y controlar seguimiento. | [V] Nombre, UID, nombre del foreman, avatar y dos radios de follow-up (`13-general`). | [V] Política: quien tenga acceso al run o solo su iniciador. | [V] Copy factory UID, borrar avatar y radios; no se usaron. La UI remite a Factory integrations. |
| Factory Settings: Worker defaults | [V] Proporcionar configuración común de ejecución. | [V] Harness, modelo, host, runner, Add secret, Add MCP y Team model settings (`14-agent-defaults`). | [V] Recursos de factory consumidos por workers; [V:F] override en el editor. | [V] Controles de selección y alta, no activados. |
| Factory Settings: Scorer defaults | [V] Configurar el entorno base de los scorers. | [V] Scorer defaults, ayuda de runner y Customize (`15-scorer-defaults`). | [V:F] Herencia desde defaults de ejecución y personalización. | [V] Customize no se abrió. |
| Factory Settings: Benchmarking | [V] Acceso a configuración de benchmarking. | [V] El menú dice Benchmarking; la ruta histórica `settings/scoring` no bastó por sí sola para validar el contenido con el selector inicial. | [V:F] Modelo juez de benchmark. | [V:F] Cambio de modelo; no se probó. |
| Factory Settings: Factory integrations | [V] Asignar integraciones a la factory. | [V] Región Cloud providers (AWS/GCP) y enlace a conectar primero al nivel de equipo (`17-integrations`). | [I:R] Cliente de integraciones conectadas y de permisos. | [V] No se conectó ni instaló ninguna integración. |
| Factory Settings: Factory repo | [V:F] Elegir dónde se aloja la definición. | [V:F] Repo gestionado o propio. | [V:F] Factory vinculada a repositorio de configuración. | [V:F] Cambiar origen/guardar; no probado. |
| Factory Settings: Runners | [V:F] Administrar entornos de ejecución reutilizables. | [V:F] Listado y alta de runner. | [V:F] OS, arquitectura e imagen. [I:R] `GetRunners`, `UpsertRunner`, `DeleteRunner`. | [V:F] New, Edit y Delete; no se abrieron formularios de edición/alta. |
| Factory Settings: Access | [V:F] Administrar el acceso de equipo a la factory. | [V:F] Tabla de usuarios y roles. | [I:R] `TeamFactoryRoles` y `SetTeamFactoryRoles`; su nombre no prueba la matriz de permisos. | [V:F] Invitar o cambiar rol; no probado. |
| Factory Settings: Danger zone | [V:F] Eliminar la factory. | [V:F] Pantalla de acción destructiva. | [V:F] Recurso principal: factory. | [V:F] Delete factory; no se abrió confirmación. |
| Settings: Account | [V] Consultar el perfil de la cuenta. | [V] Account en ajustes personales (`22-account`). | [V] Cuenta personal, distinta de la factory. | [V:F] Edición de perfil; no se guardó. |
| Settings: Interface and theme | [V] Personalizar la presentación. | [V] Selector de tema (`23-interface`). | [V] Preferencia de interfaz. | [V] Sin cambiar selección. |
| Settings: Notifications | [V] Controlar avisos de navegador. | [V] Switch Browser notifications (`24-notifications`), separado de la bandeja Home y la región de notificaciones. | [V] Preferencia booleana de navegador; [I:R] marcado leído/no leído es otra operación. | [V] No se cambió el switch. La región `Notifications alt+T` no aportó historial persistente. |
| Settings: Integrations | [V] Acceder a las integraciones personales/de equipo. | [V] Página Integrations (`25-personal-integrations`). [V:F] Gestión administrativa en dominio aparte, no inspeccionada. | [I:R] Conexión de equipo y asociación con factory son consultas distintas. | [V] No se conectaron proveedores ni se siguió el enlace externo de administración. |
| Settings: Privacy | [V] Consultar política de participación en mejora. | [V] Switch Help improve Warp en estado deshabilitado en la toma (`26-privacy`). | [V] Preferencia de privacidad. | [V] No se cambió; la captura por sí sola no determina por qué estaba deshabilitado. |
| Billing | [V] Ver saldo y acceso a facturación. | [V] Enlace de saldo en sidebar y página Billing (`27-billing`). [V:F] Compra de uso. | [I:R] Facturación de factory y workspace son consultas distintas, con candidato de portal Stripe. | [V] No se abrió portal ni compró uso; sin facturas de ejemplo. |
| Factory API keys | [V] Gestionar credenciales para uso por API. | [V] Factory API keys (`28-api-keys`). [V:F] Listado vacío en el recorrido anterior. | [V:F] API key, sin registrar valores. | [V:F] Alta/revocación no probadas. |
| Networking | [V:F] Consultar rangos de IP de salida para agentes alojados. | [V] Networking (`29-networking`). | [V:F] Rangos de salida; no credenciales. | [V] Consulta; no se probó ninguna política de red. |
| MCPs and apps | [V:F] Ofrecer conexiones reutilizables a workers. | [V] MCPs and apps (`30-mcps`). | [I:R] Plantilla, opciones de conexión, configuración del servidor y servidores gestionados. | [I:R] Crear, actualizar, descubrir, autorizar, desconectar y borrar aparecen en el bundle; no se invocaron. |
| Agent harnesses | [V:F] Administrar el método de autenticación de un harness. | [V] Agent harnesses (`31-harnesses`). | [I:R] Harness disponible, auth secret y default de equipo; hay flujo de billing vinculado para Claude en el código. | [I:R] Establecer default o iniciar vinculación; no probado. |
| Secrets | [V] Administrar secretos del equipo que consumen ejecuciones. | [V] Search secrets, Filter secrets, New secret, Import secrets y enlace a Agent harnesses (`32-secrets`). | [I:R] Consultas separadas de secretos y configuración de secretos; no se extrajeron valores. | [V] New e Import visibles, sin probar. [I:R] Crear/actualizar/borrar son candidatos estáticos. |
| Onboarding | [I:B] Preparar una factory conectando origen, identidad y canales antes de habilitar workers. | [V] Enlace Create factory; no se visitó el asistente. [I:B] Orden: `codeforge-setup`, `identity-setup`, `communication`, `warp-factory`, `issue-tracker`, `agents`. | [I:B] Selección de forges, identificadores de instalación/grupo/proyecto según proveedor, repos, nombre, alias y mapa de agentes habilitados. | [I:B] Chequeos del cliente: forge no vacío y datos por proveedor; requiere repos salvo `NONE`, nombre no vacío, alias válido y al menos un agente de TRIAGE/SPEC/IMPLEMENT/REVIEW habilitado. No se interpretó el regex como contrato de servidor. Fuentes B `56:24857`, `787:32360`. |

## 3. Modelo global y evidencia REA

```text
Equipo ──< Factory ──< Run ──< Turno / Mensaje / Run hijo
   │           ├──< Worker (foreman diferenciado; defaults y overrides)
   │           ├──  Blueprint ──< Etapa ──< Transición / Gate / Subetapa
   │           ├──< Automation ──< Trigger → Worker o Etapa
   │           ├──< Webhook ──< Entrega → suscripción en Automation
   │           ├──< Scorer → Worker / Etapa / Tarea completa
   │           └──< Benchmark → objetivo, corrida, trial, scores
   └──< Integración / Harness / MCP / Secreto / API key / Facturación
```

[I:B] Las relaciones nuevas de etapa proceden del cliente, no de un esquema de base de datos. [V:F] La implementación de spec/PR/issue y la regla de revisión por el foreman descritas por Fable siguen siendo evidencia de instrucciones o enlaces, no un lifecycle garantizado por backend. La etapa/gate de Blueprint no demuestra que ninguna factory existente use un gate concreto.

[V] REA MCP `list_browser_targets` identificó Home y `analyze_web_bundle` capturó 56 scripts del origen. `inspect_analysis_view` devolvió 54 fuentes completas, 2 no disponibles, 137 gaps y cero patrones estructurales en esa proyección. El registro padre `ev_5402eb8ab95a4f8c17fb7cd5016ddec38c56b4069f7010ca8549509e01007bee` retuvo **255 candidatos de endpoint/operación**, no 255 llamadas reales. El bundle grande agotó el deadline de ese analizador: se leyó localmente sin ejecutarlo tras comprobar que el SHA-256 de la descarga pública coincidía exactamente con el observado por REA. **B** = `factory-D3ikUJG01vgnYQew.js`, `69c35e00f12e6b8da7a04ea37b138ed8b6762409bf30a5966eb9505ca6e94fa1`. Las coordenadas B son línea:columna, base 1. No se requirió clonar ni reinstalar el fork para usar el MCP conectado; no se afirma que el servicio sea una compilación del HEAD remoto.

| Consumidor | Operaciones o rutas candidatas, sin valores de parámetros | Evidencia |
|---|---|---|
| Runs y bandeja | `/agent/runs/batch-get`, `/agent/runs`, `/factory-inbox/notifications/read`, `/factory-inbox/notifications/unread` | [I:R] `HarnessSelector…chunk.js:2:130663`; `client…chunk.js:2:2738`, `2:3139`, `2:3231`. |
| Automations | `/agent/schedules` | [I:R] `client…chunk.js:2:1325`; no representa todo el transporte de eventos. |
| Blueprint | Lectura de Blueprint por defecto y comienzo de una propuesta por factory | [I:B] B `15:95388`, `1160:89573`; la respuesta de propuesta comprueba presencia de identificador de run y estado. |
| Webhooks | Listado por factory y revisión de entregas; código de alta, rotación y comprobación de coincidencias | [I:B] B `1161:63499`; no se enviaron requests manuales ni payloads. |
| Permisos / Runners | `CheckFactoryPermissions`, `GetRunners`, `UpsertRunner`, `DeleteRunner`, `TeamFactoryRoles` | [I:R] `factory-source…chunk.js:3:29457`, `3:98881`; las mutaciones no se invocaron. |
| Automejora | `GetFactorySelfImprovementRuns`, `GetFactorySelfImprovementPullRequests`, `GetFactorySelfImprovementManualDispatch`, `StartFactorySelfImprovementManualTick` | [I:R] `factory-source…chunk.js:3:56277` y candidatos del padre REA. |
| Harness / Secrets / MCPs | `GetAvailableHarnesses`, `GetTeamHarnessAuthDefaults`, `GetManagedSecrets`, `GetManagedSecretConfigs`, `ManagedMcpAvailableTemplates`, `ManagedMcpServers` | [I:R] `factory-source…chunk.js:3:86103`, `3:86842`, `3:94213`, `3:94799`; catálogo, configuración y credenciales no son la misma entidad. |
| Billing | `GetFactoryBillingInfo`, `GetWorkspaceBillingSettings`, `StripeBillingPortal` | [I:R] `factory-source…chunk.js:3:48555` y candidatos del padre REA. |

## 4. Inventario de acciones

| Módulo | Acción | Efecto | Evidencia |
|---|---|---|---|
| Home / Runs | Buscar, filtrar, abrir detalle | Cambia selección o navega | [V] UI. |
| Home | Mark as resolved | Control para resolver elemento de bandeja | [V] Etiqueta UI, efecto no ejecutado. |
| Runs / New Chat | New run, responder, Stop | Crear o continuar ejecución, o detenerla | [V] Enlace de alta; [V:F] controles del detalle; no ejecutados. |
| Dashboard / Blueprint | Cambiar vista, escoger etapa o transición | Inspeccionar métricas o un nodo/arista | [V] Dashboard; [I:B] Blueprint. |
| Blueprint | Generar propuesta | Inicia un run ligado a la factory | [I:B] B `1160:89573`. |
| Workers / Definition | New, Save, Restore defaults, Delete | Alta/edición/reversión/baja de configuración | [V] Controles de listado/definición; [V:F] editor. |
| Automations / Webhooks | Add trigger, Run now, crear webhook, editar o rotar | Configura el disparo, ejecuta trabajo o cambia recepción/autenticación | [V] Alta en UI; [I:B] menú del editor y cliente de webhooks. |
| Scorers / Benchmarks | Score past runs, Score run, Add to benchmark | Encola evaluación o incorpora un caso; Score run puede reemplazar resultados seleccionados | [I:B] Flujos de scoring; [V:F] etiqueta de Add to benchmark, sin probar efecto. |
| Self-improvement | Configure, Run now | Abre formulario de parámetros o solicita despacho manual | [V] UI; [I:R] candidato de despacho. |
| Ajustes de factory/equipo | Save, Customize, Invite, Import, Connect, Upgrade, Delete | Cambia parámetros, permisos, credenciales/integración, plan o recurso | [V]/[V:F] Controles, no se usaron. |

## 5. Diferencias con el catálogo Fable

- [V] Añadir **Blueprint** como módulo independiente; [I:B] separar grafo aplicado, configuración YAML, propuesta y run de generación. No confundir con el editor general de definición.
- [V] Actualizar la navegación: **Workers**, **Worker defaults**, **Benchmarking** y **Factory integrations**. [I:B] `VERIFY` aparece en el cliente como tipo de worker, no como otro worker predeterminado observado.
- [I:B] Ampliar el modelo de automatización: calendario con cuatro frecuencias, providers con condiciones de conexión/plan y destino por etapa además de worker. Ampliar webhook con autenticación y resultados de filtro por nivel.
- [I:B] Ampliar evaluación: tarea completa y etapas además de workers; previsualización por rango al evaluar runs históricos y distinción entre reintentar scoring y sobrescribir resultados seleccionados de trials.
- [I:B] Completar el orden y los chequeos del onboarding sin abrir la ruta de creación. [V] Conservar como no visitado el compositor de New Chat; [I:B] hay evidencia del componente de prompt, no del montaje de la ruta.

## 6. Lo que no se pudo ver

- [V] No se visitaron rutas de alta ni se ejecutaron acciones de estado. Los formularios de alta de worker, automation, webhook, scorer, benchmark, runner, secreto, MCP y API key no quedaron reconstruidos campo por campo. Las inferencias anteriores son parciales y no sustituyen un walkthrough de esos formularios.
- [V:F] No hay muestra validada de run activo, streaming, Stop, forge conectado, PR/spec/issue embebidos ni revisión publicada. Tampoco se revalidaron todos los prompts y skills. No se usó el dominio externo de administración ni se abrió Stripe.
- [V] La cobertura estática de REA es parcial; no hubo source maps generados ni inspección activa de formularios. No hay contrato de backend, matriz completa de roles, completitud de enums, reglas de rate limit ni cobertura exhaustiva de operaciones GraphQL de red.
- [V] Las capturas se guardan en `capturas-codex/`, ignorado por Git. Pueden contener datos de cuenta; no se adjuntan ni se distribuyen. Los archivos crudos de trabajo de REA/DOM quedan fuera del repo, no son el entregable.

<!-- FIN -->
