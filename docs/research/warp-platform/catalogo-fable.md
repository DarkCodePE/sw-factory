# Catálogo de la plataforma web de Warp Factories frente a fab

- **Fecha:** 2026-11-19. **Autor:** Fable 5.2 (goldfish catalogador). **Brief:** `BRIEF-FABLE-WARP.md`.
- **Método:** recorrido en solo lectura de `platform.warp.dev` con la sesión `warp` de agent-browser. No se pulsó ningún botón que cambie estado; los `Save` de las pantallas con editor seguían deshabilitados al salir. fab se leyó en el worktree `sw-factory-t11`.
- **Límite de la muestra:** la cuenta es nueva (plan Start, una factory, un run con un hijo, sin integraciones, sin repos, sin automations). Todo lo que depende de PRs, issues, Slack o repos conectados se vio vacío; su comportamiento se infiere de textos de la interfaz y de los prompts de los agentes, y se marca como inferido.
- **Privacidad:** el informe no contiene emails, ids ni nombres; la factory se nombra `<factory>`. **Las capturas sí muestran el nombre del usuario, el nombre de la factory y, en algunas, su email (27, 34, 44): no deben subirse a un repo público sin revisarlas.**

## 1. Mapa del sitio

Capturas en `capturas/`. Rutas relativas a `https://platform.warp.dev`.

```
/home                                   Bandeja personal                         01
/runs/new                               New Chat (no abierto)                    —
/runs?factory_uid=…&filtros             Lista de runs                            02-05
/runs/<id>                              Detalle de run                           06-12
/create/codeforge-setup                 Crear factory / onboarding (no abierto)  —
/factory/<factory>/
  dashboard                             Métricas: Productivity, Spending, Scorers 13, 17-*
  agents                                Lista de agentes                         14, 18
  agents/<id>                           Editor de agente: Prompt, Automations, Settings 19-23
  automations                           Automations (vacío)                      15
  webhooks                              Webhooks entrantes (vacío)               38
  scorers                               Lista de scorers                         16
  scorers/<id>                          Scorer: Details, Config                  37, 39
  self-improvement                      PRs de automejora (vacío)                24, 40
  self-improvement/config               Configuración de automejora              41
  benchmarks                            Benchmarks (vacío)                       25
  definition                            Factory definition: árbol de ficheros + editor 26, 36
  settings/general-info                 Nombre, UID, handle del foreman, follow-ups 27
  settings/agent-defaults               Harness, modelo, host, runner, secretos, MCPs 28
  settings/scorer-defaults              Herencia desde agent defaults            29
  settings/scoring                      Modelo juez de benchmarks                30
  settings/integrations                 Integraciones de la factory              31
  settings/factory-repo                 Dónde vive la definición                 32
  settings/runners                      Runners                                  33
  settings/access                       Usuarios y roles                         34
  settings/danger-zone                  Borrar factory                           35
/settings/                              Ajustes personales y de equipo           43
  account · interface · notifications · integrations · privacy                 44-47
  billing                               Saldo y compra de uso                    42
  api-keys                              Factory API keys                         51
  networking                            Rangos IP de salida                      52
/mcps                                   MCPs y apps del equipo                   48
/agent-harnesses                        Credenciales por harness                 49
/secrets                                Secretos del equipo                      50
(app.warp.dev/admin)                    Panel de administración externo (no abierto) —
```

Una línea por pantalla:

| Pantalla | Qué es |
|---|---|
| Home | Saludo, contadores `Waiting on you / Active / Complete / Blocked / Failed`, búsqueda de runs propios, lista agrupada por día con «marcar como resuelto» y selección múltiple. |
| Runs | Lista con búsqueda, orden (Updated, Created, Title, Agent; asc/desc), filtro (Status, Agent, Factory, Source, Creator, Created on) y filtros rápidos (My runs, Running, Complete, Failed, Blocked, Cancelled, Background runs). Cada fila: estado, título, nº de hijos, fuente, creador, antigüedad. |
| Detalle de run | Conversación con el foreman a la izquierda; panel lateral con Timeline, Agents y Metadata. |
| Dashboard | Tres pestañas de métricas con rango de fechas. |
| Agents | Cinco agentes de fábrica (foreman, implement, review, spec, triage) más filtro por tipo, incluido `Custom`. |
| Editor de agente | Prompt en texto enriquecido; automations que lo usan; descripción, MCPs, secretos, harness, modelo, host y runner. Menú: Restore defaults, Delete. |
| Automations / Webhooks | Tareas recurrentes de los agentes; un webhook solo recibe entregas y necesita una automation con trigger Webhook. |
| Scorers | Cinco jueces: Verbosity, Task Compliance, Procedure Compliance, Efficiency, Code Quality. |
| Self-improvement | Lista de PRs propuestos contra la definición, para aprobación humana. |
| Benchmarks | Evaluar agentes con distintas configuraciones de modelo. |
| Factory definition | La factory entera como ficheros editables. |
| Settings de factory | Nueve subpáginas (ver árbol). |
| Settings de equipo | Credenciales, MCPs, API keys, facturación. |

## 2. Catálogo de capacidades

| Id | Sección | Capacidad | Qué hace el usuario | Entidades | Estados visibles | Captura |
|---|---|---|---|---|---|---|
| C01 | Home | Bandeja «te espera a ti» | Ve qué runs necesitan respuesta; los marca resueltos | run, notificación | Waiting on you, Active, Complete, Blocked, Failed | 01 |
| C02 | Runs | Lista con búsqueda, orden y filtros | Filtra por estado, agente, factory, fuente, creador y fecha | run | Running, Complete, Failed, Blocked, Cancelled | 02-04 |
| C03 | Runs | Jerarquía padre → hijos | Despliega los subagentes de un run | run, run hijo | contador de hijos | 05, 10 |
| C04 | Runs | Renombrar run | Cambia el título | run | — | 06 |
| C05 | Run | Transcript | Lee mensajes del foreman, razonamiento y tool calls plegables («Worked for 1m 3s: Ran 1 command…»); alterna Show thinking / Show tool calls | run, mensaje, paso | — | 06, 08 |
| C06 | Run | Follow-up | Escribe al run y adjunta ficheros | run, mensaje, adjunto | — | 06 |
| C07 | Run | Parar run | Botón Stop (deshabilitado si no corre) | run | — | 06 |
| C08 | Run | Cambiar de agente | Salta de la conversación del foreman a la de un subagente | run, agente | estado por agente | 07 |
| C09 | Run | Timeline | Traza por minutos con una columna por agente: turnos, «Sandbox setup», «Sandbox idle», mensajes entre agentes, segmentos bloqueados | run, turno, segmento | Blocked, idle | 09 |
| C10 | Run | Árbol de agentes con coste | Duración y coste por agente, total y propio («$ total ($ self)») | run, run hijo | estado por agente | 10 |
| C11 | Run | Metadata | Entorno (nombre, id, imagen), tiempo, creación, fuente, harness, modelo | run, entorno, runner | — | 11 |
| C12 | Run | Uso del run | Coste del run desplegable | run, uso | — | 12 |
| C13 | Run | Puntuar un run a mano | Menú «Score run» (no pulsado) | run, scorer | — | 08 |
| C14 | Run | Añadir run a benchmark | Menú «Add to benchmark» (no pulsado) | run, benchmark | — | 08 |
| C15 | Global | Máquina de estados del run | — | run | Running, Complete, Failed, Blocked, Cancelled, Waiting on you | 01, 02 |
| C16 | Global | Crear trabajo desde la web | New Chat / New run (no abierto) | run | — | 01 |
| C17 | Global | Varias factories | Lista lateral con orden, pin, crear, «Import work», copiar handle | factory | — | 01, 53 |
| C18 | Dashboard | Productividad | Interacciones humanas por PR; mediana de ciclo en cuatro tramos (kickoff→merge, kickoff→PR, PR→primera revisión humana, revisión→merge); PRs abiertos y fusionados; runs por tipo de agente | PR, run | «not measured» | 13 |
| C19 | Dashboard | Gasto | Coste por PR; desglose Compute / Platform / Inference; gasto por fuente, usuario, agente y modelo; top 20 PRs más caros | uso, PR, agente, modelo | — | 17-Spending |
| C20 | Dashboard | Scorers | Tasa de aprobado en el tiempo por scorer | scorer | «No scores in this range» | 17-Scorers |
| C21 | Agents | Agentes por rol | Lista y filtra: Foreman, Triage, Spec, Code, Review, Custom | agente | — | 14 |
| C22 | Agents | Editar el prompt | Editor enriquecido del prompt base; restaurar valores por defecto | agente, prompt | Save deshabilitado sin cambios | 20, 23 |
| C23 | Agents | Recursos por agente | Modelo (lista larga, con «auto» por objetivo), harness, host, runner, MCPs, secretos | agente, modelo, runner, secreto, MCP | — | 19, 22 |
| C24 | Automations | Tareas recurrentes | Crea automations para un agente (no creado) | automation, agente | vacío | 15, 21 |
| C25 | Automations | Webhooks entrantes | URL alojada que recibe JSON y dispara una automation | webhook, automation | vacío | 38 |
| C26 | Scorers | Definir un juez | Agentes evaluados, instrucciones del juez (rúbrica), clasificaciones con puntuación, nota de aprobado, tasa de muestreo | scorer, agente | — | 16, 39 |
| C27 | Scorers | Historial del juez | Coste acumulado, tendencia a 30 días (aprobado o coste diario), «Score past runs» | scorer, scoring run | «No scoring runs yet» | 37 |
| C28 | Self-improvement | Automejora con aprobación | Un agente propone PRs a la definición cuando un agente acumula fallos de scorer por encima de un umbral; un admin del equipo revisa | PR de automejora, scorer, revisor | vacío | 24, 40, 41 |
| C29 | Benchmarks | Benchmarks de agentes | Compara rendimiento entre configuraciones de modelo; juez por defecto de la plataforma | benchmark, agente, modelo | vacío | 25, 30 |
| C30 | Definition | Factory como código | Árbol `agents/<agente>/agent.md`, `runners/default.yaml`, `scorers/<scorer>/scorer.md`, `skills/<skill>/SKILL.md`, `factory.yaml`; editor, subida y alta de ficheros | factory, fichero | Save | 26, 36 |
| C31 | Definition | Skills de la factory | Tres skills incluidas: code-quality, code-review, ui-verification | skill | — | 26 |
| C32 | Settings | Identidad de la factory | Nombre, UID, handle `@…` del foreman para mencionarlo en otras plataformas, avatar | factory | handle no editable | 27 |
| C33 | Settings | Quién puede dar follow-ups | «Cualquiera con acceso al run» o «solo quien lo inició» (de pago) | factory, usuario | deshabilitado en plan Start | 27 |
| C34 | Settings | Valores por defecto con herencia | Defaults de agente; los scorers y la automejora heredan («From Agent defaults») y se pueden personalizar | factory, agente, scorer | — | 28, 29, 41 |
| C35 | Settings | Integraciones | Code forges (GitHub, GitLab, Azure DevOps), trackers (Linear, Jira), chat (Slack, Teams), nube (AWS, Google Cloud); se conectan primero a nivel de equipo | integración | Not connected, Setup pending | 31, 46, img 14 |
| C36 | Settings | Repo de la definición | Alojada por Warp o en un forge propio (de pago) | factory, repo | «Warp managed repo» | 32 |
| C37 | Settings | Runners | Runner `default` (Linux, imagen Docker); alta de runners | runner | Default | 33, 36 |
| C38 | Settings | Acceso y roles | Lista de usuarios con rol; gestión de roles de pago | usuario, rol | Admin | 34 |
| C39 | Settings | Borrar factory | Irreversible | factory | — | 35 |
| C40 | Equipo | Facturación | Saldo prepago con caducidad, compra de 10/20/50/100 $, plan Scale | equipo, saldo | — | 42 |
| C41 | Personal | Notificaciones | Aviso del navegador cuando un agente termina o necesita atención | notificación | on/off | 45 |
| C42 | Equipo | MCPs y apps | MCPs gestionados por el equipo, disponibles para las factories | MCP | vacío | 48 |
| C43 | Equipo | Harnesses de agente | Credencial por defecto para Claude Code, Codex y Pi; secretos de proveedor de modelos | harness, secreto | No default | 49 |
| C44 | Equipo | Secretos | Secretos para que los agentes usen cuentas y tokens; importación | secreto | vacío | 50 |
| C45 | Equipo | API keys | Tokens para usar las factories por API | API key | vacío | 51 |
| C46 | Equipo | Red | Rangos IP desde los que salen los agentes alojados | — | — | 52 |
| C47 | Onboarding | Asistente de alta | Seis pasos: conectar code hosts, …, activar agentes (triage, spec, code, review con interruptor; foreman fijo). Lista «Finish setup» persistente | factory, integración, agente | Setup pending | img 13, 14 |
| C48 | Entrada | Canales de entrada de trabajo | @mención al foreman en Slack, issue asignado a la factory, petición en la web | run, issue | — | img 13 |
| C49 | Ciclo | Puertas humanas | Aprobación de spec, preguntas de aclaración, entrega del PR | spec, PR, pregunta | Waiting on you, Blocked | 23 |
| C50 | Ciclo | Revisión adversarial | El review agent devuelve hallazgos; el foreman manda a rehacer los claros y publica en el PR solo los que necesitan juicio humano; una pasada por trabajo | PR, hallazgo | — | 23, img 14 |

## 3. Modelo inferido de Warp

### Entidades y relaciones

```
Team ──< Factory ──< Agent (foreman | triage | spec | code | review | custom)
  │         │           └─ prompt, modelo, harness, host, runner, MCPs, secretos
  │         ├──< Runner (os, arch, imagen Docker)
  │         ├──< Scorer >──< Agent      (rúbrica, clasificaciones, passingScore, samplingRate)
  │         ├──< Automation ── Agent    (trigger: horario o Webhook)
  │         ├──< Benchmark
  │         ├── Factory definition (ficheros; repo gestionado o propio)
  │         └──< Run ──< Run hijo (subagente)
  │                 ├─ source (web, self-improvement, …), creador, modelo, harness, entorno
  │                 ├──< Turno ──< Segmento (trabajo, idle, bloqueado)
  │                 ├──< Mensaje (usuario ↔ foreman ↔ subagente)
  │                 ├── Uso ($, total y propio)
  │                 └──< Score (scorer × run, muestreado)
  ├──< Integración (forge, tracker, chat, nube)   ├──< Secreto / MCP / API key
  └── Saldo de uso
```

- La factory se describe en `factory.yaml`: versión de esquema, nombre, alias, estrategia de credenciales, forges, repos, integraciones y defaults de agente. Cada agente es un `agent.md` con frontmatter (descripción, tipo, modelo) y el prompt en el cuerpo. La web es un editor sobre esos ficheros.
- El **run** es la unidad visible. No hay entidad «spec» ni «PR» propia en la web: viven en el forge y en el tracker, y el run los enlaza. El issue es «el registro durable»; si no hay issue, lo es la conversación del foreman.

### Ciclo de vida (del prompt del foreman)

```
entrada (web · @mención · issue asignado · webhook · automation)
  └─ foreman
       0. ¿el mensaje es para mí?            (si no, para en silencio)
       1. ¿triage?   por defecto sí ─────────► triage: investiga, reproduce, crea o adopta el issue, estima complejidad
       2. ¿spec?     solo si hay ambigüedad ─► pregunta al humano ─► spec: PR borrador ─► [HUMANO aprueba]
       3. implementar ───────────────────────► code: PR
       4. ¿review?   por defecto sí, 1 pasada► review: informe de hallazgos (nunca publica)
            hallazgos claros ───────────────► vuelta a code
            hallazgos con juicio ───────────► el foreman los publica en el PR ─► [HUMANO]
       5. entrega del PR ───────────────────► [HUMANO decide si fusiona]
       6. cierre en una entrada posterior (aviso de merge)
```

El trabajo puede entrar en cualquier etapa (un PR que revisar, un fallo de CI, una respuesta). Los subagentes conservan su conversación: los seguimientos vuelven al agente que ya tiene el contexto.

### Dónde interviene el humano

1. **Aprobar la spec** antes de implementar (confirmación escrita o aprobación del PR borrador).
2. **Responder preguntas**; ese hilo se pausa y lo demás sigue.
3. **Recibir el PR** y decidir el merge. Warp no fusiona.
4. **Aprobar PRs de automejora** de la propia factory.
5. **Desbloquear**: en el run observado el agente quedó `Blocked` por falta de identidad Git y pidió al humano aprovisionarla.

Dos rasgos que importan para el cruce: las puertas son **instrucciones del prompt**, no estados impuestos por código visible en la web; y el foreman decide por juicio saltarse triage, spec o review (en el run observado saltó las tres a petición del usuario).

## 4. Cruce con fab

Estado medido en el dominio de fab (Store, pool, CLI, TUI). **Ninguna capacidad tiene superficie web en fab**: no hay servidor HTTP de la factory (los únicos `Bun.serve` son el MCP del SDK, `src/sdk/mcp-server.ts:39`, y el callback OAuth). Rutas relativas a `sw-factory-t11`.

| Id | Capacidad | Estado | Dónde en fab |
|---|---|---|---|
| C01 | Bandeja «te espera» | cubierta | `Store.inbox` `src/store.ts:630`; `fab inbox` `src/cli.ts:263`; TUI `src/tui.ts` |
| C02 | Lista con filtros | parcial | `listChanges` `src/store.ts:523`, `listActivities` `:610` (solo workstream, change y estado; sin búsqueda, creador, fuente ni fecha) |
| C03 | Padre → hijos | parcial | `activities.parent_activity_id` y change → activities (doc `factory/02`); no se expone como árbol |
| C04 | Renombrar | falta | — |
| C05 | Transcript | parcial | Log por activity `src/manifest.ts:39` y `run.json` (doc `factory/08`); texto plano, sin pasos estructurados. T16 y T26 tocan el `report` |
| C06 | Follow-up | parcial | Comentario de revisión `resolveReview` `src/store.ts:1025`; respuesta a pregunta `src/admission/answers.ts:14`. No hay mensaje libre a un turno; T21 y T23 parciales |
| C07 | Parar | parcial | `fab reject` (`src/cli.ts`, doc `factory/10`); D4 excluye `stop` del residente |
| C08 | Cambiar de agente | parcial | Activities de un change en la TUI (`src/tui.ts`) |
| C09 | Timeline | parcial | `listEvents` `src/store.ts:1279`; sin spans ni turnos. T17 a T19 (sesiones) parciales |
| C10 | Coste por agente | parcial | `attemptCosts` y `durationMs` por activity `src/pool.ts:316-318`; sin agregación por change |
| C11 | Metadata | parcial | `run.json`, `fab_sha`, `profile_digest`, `isolation` (`src/pool.ts:318`, doc `factory/08`) |
| C12 | Uso del run | parcial | `AgentUsage.costUsd` `src/agents.ts:15-16`; solo adaptadores que lo informan |
| C13 | Puntuar run | falta | Análogo lejano: `fab validate` |
| C14 | Run a benchmark | falta | Las suites de `improve` se escriben a mano (`src/improve.ts:17-18`) |
| C15 | Estados | cubierta | `ChangeStatus` `src/enums.ts:20-29` más `blocked`, `quarantined` `src/store.ts:36-50`; `awaiting` |
| C16 | Crear trabajo | parcial | `addSignal` `src/store.ts:438`, `triageSignal` `:459`; solo CLI |
| C17 | Varias factories | cubierta | Workstreams: `createWorkstream` `src/store.ts:359`, `listWorkstreams` `:417` |
| C18 | Productividad | falta | Los eventos y fechas existen; no hay métricas. T13 midió solo seguimientos y paradas perdidos |
| C19 | Gasto | parcial | Coste por intento en la evidencia (`src/pool.ts:316`), `armCost` `src/improve.ts:163-179`; sin vista |
| C20 | Tendencia de scorers | falta | — |
| C21 | Agentes por rol | parcial | Los roles son `ActivityKind` (`src/enums.ts:32-37`) y validadores (`src/validators/prompts.ts:47-48`), no entidades configurables |
| C22 | Editar prompt | parcial | `Profile` `src/profile.ts:10`, `saveProfile` `:75`, `defaultProfile` `:37`; plantillas `src/prompts.ts:64` |
| C23 | Recursos por agente | parcial | Un adaptador por workstream (`getAgent` `src/agents.ts:159`); no por rol |
| C24 | Automations | falta | — |
| C25 | Webhooks | falta | El residente hace poll (`pollIssues` `src/admission/github.ts:15`) |
| C26 | Definir juez | falta | Análogo: veredicto de validador `src/validators/verdict.ts:12` (juzga el change, no el run) |
| C27 | Historial del juez | falta | — |
| C28 | Automejora | parcial | `improve`: experimento baseline contra candidato `src/improve.ts:71`; propone, no promueve (AGENTS.md «Lecciones y memoria») |
| C29 | Benchmarks | parcial | Suites y splits `src/improve.ts:15-18`; corpus `bench/`; sin matriz de modelos |
| C30 | Factory como código | parcial | Perfil con digest (`src/profile.ts:35`) y flags del workstream; no hay un árbol único de definición |
| C31 | Skills | parcial | El agente nativo carga `SKILL.md` (`src/agent/registry.ts`); no hay skills de la factory |
| C32 | Identidad y handle | parcial | `slug` del workstream; sin handle de mención |
| C33 | Quién da follow-ups | parcial | D2 (`TRIAGE_ROLES` `src/admission/gate.ts:32`); T21 parcial |
| C34 | Defaults con herencia | parcial | Flags del workstream (doc `factory/02`); sin herencia |
| C35 | Integraciones | parcial | Jira y GitHub (`src/connectors/jira.ts`, `src/connectors/github.ts`); sin Slack, Linear, GitLab, Azure ni nube |
| C36 | Repo de la definición | parcial | Estado local en `~/.fabrica` (`src/cli.ts:34`) |
| C37 | Runners | parcial | Pool local `runPool` `src/pool.ts:462` y sandbox `confineAgent` `src/sandbox/confine.ts:41`; sin runners remotos |
| C38 | Acceso y roles | falta | fab es monousuario; `events.actor` existe |
| C39 | Borrar factory | falta | Solo `setWorkstreamState` `src/store.ts:421` |
| C40 | Facturación | no aplica | fab corre en local con las credenciales del usuario |
| C41 | Notificaciones | falta | Outbox avisa en el issue (`src/admission/outbox.ts:44`); nada al escritorio |
| C42 | MCPs de equipo | parcial | MCP del agente nativo y del SDK (`src/sdk/mcp-server.ts`) |
| C43 | Harnesses | cubierta | `AGENT_NAMES` `src/agents.ts:165`; pins de binarios `src/agents-verify.ts:87` |
| C44 | Secretos | parcial | Variables de entorno y `.env` acotado (`src/connectors/jira.ts:6-60`); redacción `src/manifest.ts:10` |
| C45 | API keys | falta | El SDK es JSON-RPC sobre stdio para `fab exec`, no para la factory (doc `factory/10`) |
| C46 | Red | no aplica | Análogo: sonda de egress `src/sandbox/egress-probe.ts` |
| C47 | Onboarding | falta | `fab ws create` |
| C48 | Canales de entrada | parcial | Etiqueta en GitHub (D1, `src/admission/gate.ts:28`) e importación de Jira; T43 bloqueada |
| C49 | Puertas humanas | cubierta | `resolveReview` `src/store.ts:1025`, `allowGate` `:544`, Outbox y `answers.ts:14`, `mergeBlocker` `src/validators/publish.ts:29` |
| C50 | Revisión adversarial | cubierta | Validadores `src/validators/`, `publishValidation` `src/validators/publish.ts:43` |

**Resumen** (48 capacidades aplicables; C40 y C46 quedan fuera):

| Estado | Nº | % |
|---|---|---|
| Cubierta | 6 | 12,5 % |
| Parcial | 28 | 58,3 % |
| Falta | 14 | 29,2 % |

Lectura: el **núcleo del ciclo** (estados, bandeja, puertas humanas, revisión, varias factories, harnesses) ya existe y es más estricto que el de Warp. Lo parcial es casi todo **dato que fab ya guarda pero no agrega ni expone**. Lo que falta de verdad son tres bloques: observabilidad agregada (C18, C20), el sistema de jueces sobre runs (C13, C14, C26, C27) y la automatización por tiempo o webhook (C24, C25), además de lo multiusuario (C38, C45).

## 5. Qué conviene no copiar

1. **Puertas humanas en el prompt.** En Warp, «no implementes hasta que aprueben la spec» es una frase del foreman, y el foreman puede saltarse triage, spec y review por juicio. En fab la puerta es un CAS en el Store (`src/store.ts:1025`) y un flag del workstream. No moverlo al prompt.
2. **Admisión por texto.** Warp admite trabajo por @mención, por issue asignado o por un mensaje en un hilo compartido, y decide «¿es para mí?» leyendo el texto. Choca con D1 (solo con etiqueta), con D2 (quien etiqueta debe tener rol triage o superior) y con «el texto es dato». Tampoco copiar la opción «cualquiera con acceso al run puede dirigirlo».
3. **Webhooks que disparan agentes.** Un POST de JSON a una URL que lanza una automation es texto de un tercero convertido en orden. Si fab lo hace algún día, el webhook debe producir una señal que pase por el gate, nunca un turno.
4. **Triage que crea y edita issues por su cuenta.** En fab el triage es el acto humano que autoriza; el agente puede proponer, no abrir trabajo.
5. **El revisor que no publica y el foreman que filtra hallazgos.** El orquestador decide qué hallazgos ve el humano. En fab el veredicto del validador se publica entero y bloquea el merge (`mergeBlocker`). Mantenerlo.
6. **Automejora que edita la definición.** Warp deja que la factory se reescriba a sí misma tras una aprobación. fab exige candidato con evidencia, experimento pareado y PR revisado; la web puede mostrar candidatos, no aplicarlos.
7. **Editar prompts en caliente desde la web.** El perfil de fab se identifica por digest y cada activity guarda con qué digest corrió. Un editor web debe crear un perfil nuevo, no mutar el vigente.
8. **Credenciales del ejecutor y secretos en el servidor.** `credentialStrategy: EXECUTOR` y un almacén de secretos alojado van contra el confinamiento. En fab los secretos no llegan al agente salvo por allowlist; la web no debe guardarlos ni mostrarlos.
9. **Runners alojados y coste «Platform».** No aplica a una fábrica local. Tampoco el saldo prepago.
10. **Marca y aspecto.** Nombres como Foreman, la disposición de tres paneles del run y la estética son de Warp. Usar el vocabulario propio: workstream, change, activity, señal, validador, gate.

## 6. Plan por fases

Principio: la web es otra superficie, como la CLI y la TUI; **no contiene reglas** y llama al Store (doc `factory/10`). Escucha solo en `127.0.0.1`.

| Fase | Entrega | Qué falta en fab | Estimación | Riesgo |
|---|---|---|---|---|
| **F0 · Lectura** | `fab web`: lista de workstreams, changes con filtros por estado, detalle de change con sus activities, eventos, bandeja. Refresco por sondeo cada 2 s, como la TUI | Un servidor HTTP local y una capa de lectura con una conexión SQLite de solo lectura real (sin crear esquema ni tomar locks; lección de T13-b). Las consultas ya existen: `listChanges`, `listActivities`, `inbox`, `listEvents` | 3-5 días | Bajo. Vigilar que el texto de issues se escape siempre (dato, no HTML) |
| **F1 · Evidencia** | Detalle de activity: log, `run.json`, diff, veredictos de validadores, coste y duración por intento; coste sumado por change | Lector de evidencia compartido (hoy repartido entre `manifest.ts`, `improve.ts:163` y la TUI); redacción aplicada también al servir | 4-6 días | Medio. Fuga de secretos en logs antiguos sin redactar; ficheros grandes |
| **F2 · Decisiones** | Aprobar, comentar y rechazar una revisión; reintentar; responder preguntas | Autenticación local (token de un solo uso impreso en la terminal, cabecera `Origin` comprobada, anti-CSRF) y `events.actor` con la identidad web. Las mutaciones ya existen: `resolveReview`, `retryChange`, `answerQuestion` | 4-6 días | **Alto.** Primera superficie que escribe por red: un fallo aquí salta D1. No incluir `merge` ni `gate allow` |
| **F3 · Métricas** | Tiempo de ciclo por tramo, intervenciones humanas por change, coste por change, por adaptador y por modelo | Consultas agregadas sobre `events` y evidencia; guardar el coste en una columna para no leer disco. Depende de T16 y T17 (report y sesión durables) | 5-8 días | Medio. Datos históricos incompletos darán «no medido» |
| **F4 · Turno vivo** | Timeline por turnos y estado de espera; aviso al navegador cuando algo te espera | Eventos de turno desde `src/live/` (sesión, report, espera) y un canal de envío (SSE). Depende de T16 a T19 y T26 | 8-12 días | Alto. Las piezas de las que depende están parciales |
| **F5 · Calidad** | Vista de experimentos de `improve` y de los corpus de `bench/`; candidatos de perfil con su evidencia | API de lectura sobre `experiments` y `experiment_runs` (`src/improve.ts:21-31`). Jueces sobre runs solo si se decide construirlos | 5-8 días lectura; jueces aparte | Medio. Riesgo de construir jueces sin problema medido |
| **F6 · Entrada y equipo** | Estado del residente y de los `would_admit`; automations; varios usuarios | Mandate y router (T43, bloqueada), modelo de usuarios y roles, API con claves | Sin estimar | Alto. No empezar hasta cerrar T11 y T43 |

Mínimo para decir «fab tiene web»: **F0 + F1**, unas dos semanas, sin tocar reglas ni seguridad de escritura.

## 7. [DECIDIR]

1. **¿Dónde corre la web?** (a) Local, `127.0.0.1`, monousuario; (b) servidor compartido. **Recomendado: (a).** La (b) exige usuarios, roles y secretos, que fab no tiene.
2. **¿La web escribe?** (a) Solo lectura hasta nuevo aviso; (b) decisiones de revisión en F2. **Recomendado: (a) ahora, (b) tras una verificación con mutaciones del servidor.**
3. **¿`merge` y `gate allow` desde la web?** **Recomendado: no.** Se quedan en la CLI.
4. **¿Stack de la interfaz?** (a) HTML servido por Bun con una hoja de estilo y sondeo, sin dependencias; (b) SPA con framework. **Recomendado: (a)**, coherente con la TUI sin dependencias.
5. **¿Mismo binario o paquete aparte?** **Recomendado: comando `fab web` en el mismo binario**, usando la capa de lectura común.
6. **¿Construir jueces sobre runs (scorers)?** **Recomendado: no todavía.** Medir primero si los validadores y `improve` dejan un hueco; dejar la pieza en una tarea bloqueada con umbrales.
7. **¿Automations y webhooks?** **Recomendado: no.** Si hace falta algo recurrente, que entre como señal por el gate.
8. **¿«Agente por rol» configurable (modelo y prompt por kind)?** **Recomendado: sí, pero como campo del perfil con digest**, no como entidad editable en caliente.
9. **¿Las capturas se versionan?** Contienen nombre y email. **Recomendado: no; añadir `capturas/` al `.gitignore` o recortarlas antes.**
10. **¿Editor de la definición en la web?** **Recomendado: solo visor.** Los cambios, por PR.

## 8. Lo no explorado

| Qué | Por qué |
|---|---|
| New Chat / New run (`/runs/new`) | El brief prohíbe New y Run; no estaba claro si abrir la página crea un borrador |
| Crear factory y onboarding (`/create/codeforge-setup`) | Prohibidos Create y Next. Solo se conocen los pasos 1 y 3 por las capturas del usuario (img 13 y 14); los otros cuatro pasos no se vieron |
| Formularios de alta: agente, automation, webhook, scorer, benchmark, runner, secreto, MCP, API key | Prohibido New. De las automations no se conocen los tipos de trigger más allá de «recurrente» y «Webhook» |
| «Score run», «Add to benchmark», «Score past runs», «Run now», «Import», «Import work», «Edit runner» | Pueden cambiar estado |
| Vista de PR, de spec y de issue dentro de un run; revisión publicada en un forge | La cuenta no tiene forge, repos ni PRs. El ciclo de la sección 3 sale del prompt del foreman, no de un run real completo |
| Run en ejecución (estado Running, streaming, Stop activo) | El único run estaba bloqueado |
| Panel de administración (`app.warp.dev/admin`), facturación detallada, integraciones de equipo | Otro dominio, fuera de la plataforma; no se abrió |
| Integraciones de factory con forge conectado | Sin integraciones, la página solo mostró proveedores de nube |
| Contenido de los prompts de implement, review y spec, y de las tres skills | Se leyó entero el del foreman y parte del de triage; el resto solo por título |
| Desplegables de Dashboard (rango de fechas, vista de runs y de coste), filtros de Runs por submenú, «Copy factory handle or label» | Se vieron las etiquetas, no cada opción |
| Panel de notificaciones (alt+T) | No devolvió contenido legible |
| Capturas `19-agente-review` y `19-agente-spec` | Se tomaron con la página aún cargando; el contenido equivale al de foreman, implement y triage |

<!-- FIN -->
