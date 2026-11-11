# Revisión EGM (zoom_out) · opencode · ronda 2

Rol aplicado: `egm-zoom-out` (simplicidad/YAGNI, zoom out). **Modo: REVIEW.** Foco P3: mínimo que la fab debería tomar y lo que sobra. Sin contexto previo; solo código/docs citados.

Commits fijados y verificados en workspace: fab `ce84fc4`, dsh-superagent-prototype `8c32a9d`, copilot-superagent `693f4db`, ESF `e5567fb`, dsh-herdr `2d74cf8` (HEADs locales leídos con `git rev-parse --short`).

---

## P1. Robustez por módulo (fab ya tiene)

| módulo | fab | mejor alternativa | veredicto | evidencia |
|---|---|---|---|---|
| Modelo de estado y transiciones | 10 estados de change, activities con lease/retry, `blocked`/`quarantined`, transiciones cerradas en `Store` + gates/validadores (`graft skeleton src/store.ts@ce84fc4`: `ChangeStatus`, `setChangeStatus`, `allowGate`, `completeActivity`, `blockActivity`, `retryChange`) | Superagent: dominio distinto (Trigger/Thread/Eval/Ticket/Assignment, `liveTicket`, `waitsForPerson`, Mandate/Decision/inputs tipados) con mucha semántica de admisión y atención humana (`dsh-superagent-prototype/src/core/model.ts:23-353@8c32a9d`, idéntico en `copilot-superagent/src/core/model.ts@693f4db`). ESF: orquestación Go/Temporal de runs/steps, no equivalente directo a change/activity de la fab (`esf/internal/factory/*`, mapa `graft map@e5567fb`) | **Mantener** el núcleo change/activity/gates de la fab. **No reemplazar** por el modelo del superagent (resuelve otro problema). Tomar solo ideas puntuales si se prueba necesidad (p.ej. representación explícita de «esperando humano»), no el grafo completo | **verificado** `src/store.ts:36-38,52-54,556-567,801-995@ce84fc4`; **verificado** `src/core/model.ts:126-353@8c32a9d` y `@693f4db` |
| Claim, lease y recuperación de huérfanos | Claim atómico con TTL, `heartbeat`, `requeueOrphans` que reencola o cuarentena según reintentos, `agent_pgid`, `fail/quarantine` (`src/store.ts:628-671,674-692,909-941,1041-1122@ce84fc4`; uso en pool `src/pool.ts:359-468@ce84fc4`) | ESF turn-executor: lease de propiedad/renew+cancel, recuperación tras restart falla y destruye (no re-ejecuta en silencio), limpieza verificada (`docs/sf-turn-executor.md:66-83,92-101@e5567fb`). Ámbito distinto (ejecución efímera en VM por turno) | **Mantener** el mecanismo fab para workers pull. **Mejorar solo** si aparece evidencia de huecos reales (reanudación con fencing/ownership más fuerte) tomando patrones de lease/cleanup de ESF, no su arquitectura de VM-por-turno | **verificado** `src/store.ts:628-692,1048-1122@ce84fc4`; **docs** `docs/sf-turn-executor.md@e5567fb` |
| Worktrees | Worktree/rama por change ya integrada al flujo (`review/SINTESIS-EGM.md` C11/tabla; uso en pool/actividades, `src/worktrees.ts` en mapa fab) | ESF opera sobre manifests/checkpoints/sandboxes efímeros por turno, no worktrees Git de producto (`docs/sf-turn-executor.md@e5567fb`) | **Mantener** | **verificado/docs** `SINTESIS-EGM.md:48-53@ce84fc4`; **docs** `docs/sf-turn-executor.md@e5567fb` |
| Intake e idempotencia | Señales + `triageSignal`/`ignoreSignal`, intake Jira idempotente por clave, enlaces (`src/store.ts:428-472@ce84fc4`; `SINTESIS-EGM.md:50@ce84fc4`) | Superagent: Trigger/Thread idempotentes y evaluación por hilo como pieza central de admisión (`src/core/model.ts:23-154@8c32a9d`) | **Mantener** lo existente. **Extender mínimo** (gate/observe idempotente) solo si se implementa admisión; no importar Eval/Thread completos de entrada | **verificado** `src/store.ts:428-472@ce84fc4`; **verificado** `src/core/model.ts:23-154@8c32a9d` |
| Canal de vuelta, outbox y reintentos | Comentario/canal directo y señales de revisión; `ExternalRef.system` limitado (hoy jira) según síntesis previa; sin outbox transaccional con recibos generalizado en núcleo (`SINTESIS-EGM.md:25,44@ce84fc4`) | Superagent/copilot: modelo orientado a eventos externos y efectos; ESF `internal/notify` existe pero es otro dominio. El valor diferencial es el outbox con recibos en orígenes conversacionales | **Mantener** envío directo actual. **Mejorar tomando** un outbox pequeño con recibo/reintento **solo** para los canales que realmente se abran (p.ej. GitHub issues) y cuando haya fuente real; no construir bus genérico antes | **docs/verificado parcial** `SINTESIS-EGM.md:25,44@ce84fc4`; **inferencia** por ausencia de módulo outbox en mapa fab |
| Permisos y sandbox | Confinamiento `bwrap` con allowlist de mounts/env y modo estricto; para `claude` desactiva hooks/MCP del host (`--setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`) (`src/sandbox/confine.ts:36-117@ce84fc4`); política/gates separados | ESF: aislamiento por VM fresca por turno + perfiles/recibos de política (`docs/sf-turn-executor.md:21-34,100-134@e5567fb`) mucho más fuerte, a coste operativo alto. Copilot expone herramientas/contexto por backend (`vscode/src/agent-backend.ts:3-38@693f4db`) | **Mantener** confinamiento actual. **Mejorar tomando** la idea de «superficie cerrada y declarada por perfil/adaptador» (ya iniciada) antes que aumentar complejidad; **no reemplazar** por VM-por-turno salvo requisito de aislamiento hard demostrado | **verificado** `src/sandbox/confine.ts:58-109@ce84fc4`; **docs** `docs/sf-turn-executor.md@e5567fb`; **verificado** `agent-backend.ts@693f4db` |
| Adaptadores de harness y sesión, steer y abort | Adaptadores por comando + parse opcional (`claude/codex/agy/droid/native`), `confineAgent`, `factoryCommits`, sesión SDK (`resumeSession`) y MCP server de la fab (`src/agents.ts:1-120@ce84fc4`, `src/sdk/session.ts:144-155@ce84fc4`, `src/sdk/mcp-server.ts:23-86@ce84fc4`) | Copilot: `AgentBackend` unifica `run/assess/steer?/handoff?/abort/dispose` y `AgentTool` (`vscode/src/agent-backend.ts:40-47@693f4db`), puerto claro entre core y harness. Superagent core es agnóstico (`src/core/*`) | **Mejorar tomando** un **puerto interno mínimo** (inspirado en `AgentBackend`: run/assess/abort + capacidades declaradas; steer opcional) para no acoplar orquestación a CLI flags. **Mantener** implementaciones simples por harness; no adoptar SDK/harness específico como dependencia de dominio | **verificado** `src/agents.ts@ce84fc4`; **verificado** `src/sdk/session.ts@ce84fc4`, `src/sdk/mcp-server.ts@ce84fc4`; **verificado** `vscode/src/agent-backend.ts@693f4db` |
| Prompts y política versionados | Prompts/validadores y reglas existen dispersos; la «Policy» como objeto versionado con efectos/Mandate es propia del superagent, no un módulo equivalente hoy | Superagent: `Mandate.basis`, `policy-changed` inputs, `PolicyEffect` (`src/core/model.ts:116-133,235-269@8c32a9d`) | **Mantener** simple. Solo versionar/promocionar artefactos de decisión **cuando** haya admisión automática real; hoy sería YAGNI | **verificado** `src/core/model.ts:116-269@8c32a9d`; **inferencia** sobre madurez actual fab (prompts presentes en `src/validators/prompts.ts` vía mapa) |
| Eventos y auditoría | Eventos en store (`event`, `listEvents`) y resultados/evidencia por actividad; síntesis señala huecos frente a outbox/recibos externos (`src/store.ts:1198-1213@ce84fc4`, `SINTESIS-EGM.md@ce84fc4`) | Superagent registra disposiciones/decisiones como dominio; ESF conserva manifests/resultados de ejecución (`docs/sf-turn-executor.md:70-82@e5567fb`) | **Mantener** eventos locales. **Extender** registro solo junto al outbox/canal nuevo (evidencia de entrega) | **verificado** `src/store.ts:1198-1213@ce84fc4`; **docs** `docs/sf-turn-executor.md@e5567fb` |
| Reanudación tras caída | Lease/TTL + `requeueOrphans`, release/wait helpers; actividades reencolables (`src/store.ts:1048-1176@ce84fc4`) | ESF: active turns fallan tras restart y nunca se re-ejecutan en silencio; resultados requieren checkpoint+cleanup (`docs/sf-turn-executor.md:92-101@e5567fb`) — más fuerte para ejecución remota efímera | **Mantener**. **Mejorar** invariantes de no-duplicación/no-replay-silencioso si se añade worker residente, tomando la regla (no el mecanismo VM) | **verificado** `src/store.ts:1048-1176@ce84fc4`; **docs** `docs/sf-turn-executor.md@e5567fb` |
| Verificación y gates | Gates/validadores como parte del change/activity y fases (síntesis/página 06: `gates → validadores`), resúmenes de validación (`src/store.ts:699-795@ce84fc4`, contexto `SINTESIS-EGM.md:24@ce84fc4`) | ESF tiene perfiles de verificación/calificación propios de releases (`release/qualification/v1.0.0-rc.1.md@e5567fb`) — dominio de producto distinto | **Mantener** (es fortaleza diferencial de la fab). **No reemplazar** | **verificado** `src/store.ts:699-795@ce84fc4`; **docs** `release/qualification/v1.0.0-rc.1.md@e5567fb` |

**Lectura zoom-out:** la fab ya es robusta en lo suyo (estado de change, claim/lease/huérfanos, worktrees, verificación/gates). Las ganancias reales y de bajo coste están en **interfaces/capacidades** (puerto de backend, superficie de permisos/MCP declarada), no en copiar motores ajenos.

---

## Hallazgos

### ZO2-H1
- **Severidad:** alta
- **Pregunta:** P3
- **Afirmación:** El mínimo valioso que la fab debería tomar del “modelo superagent” no es su motor (Trigger/Thread/Eval/Policy/Mandate/Outbox completo), sino un **contrato de ejecución agnóstico al harness** con capacidades explícitas (run, assess mínimo, steer/abort opcionales) y reporte estructurado. Eso resuelve fricción real de integración sin importar un segundo dominio.
- **Evidencia:** **verificado** `copilot-superagent/vscode/src/agent-backend.ts:40-47@693f4db` define `AgentBackend {run, assess, steer?, handoff?, abort, dispose}`; **verificado** `copilot-superagent/src/core/model.ts@693f4db` es estructuralmente el mismo núcleo que `dsh-superagent-prototype/src/core/model.ts@8c32a9d` (mismos tipos/esqueletos de Trigger/Thread/Eval/Ticket/Mandate). **verificado** la fab hoy acopla por comandos/flags y parsing ad hoc (`src/agents.ts:8-120@ce84fc4`) aunque ya tiene sesión/MCP reutilizables (`src/agent/rpc.ts:315-349`, `src/sdk/mcp-server.ts:23-30@ce84fc4`, citados y consistentes con mapa; `resumeSession` en `src/sdk/session.ts:144-155@ce84fc4`).
- **Propuesta concreta:** introducir un puerto interno tipo `HarnessBackend` (run + abort + `capabilities`: resume/steer/inject/mcp/sandbox) y adaptar `claude/native/codex` a él; posponer `assess` rico hasta que exista admisión real. No crear `Engine` paralelo.

### ZO2-H2
- **Severidad:** alta
- **Pregunta:** P2
- **Afirmación:** La estrategia de mitkox es **conservar el núcleo de decisión/dominio y reescribir el borde de ejecución por entorno**: el core se reutiliza (prototype→copilot), el harness entra detrás de `AgentBackend`, y ESF empuja la ejecución efímera a un **servicio de turnos** separado con autoridad de workflow fuera de él. Herdr aparece como capa de experiencia/monitoreo (terminal/monitor), no como backend de ejecución equivalente.
- **Evidencia:** **verificado** paridad de `src/core/model.ts` entre `dsh-superagent-prototype@8c32a9d` y `copilot-superagent@693f4db`; **verificado** `copilot-superagent/vscode/src/agent-backend.ts@693f4db` como contrato de backend/herramientas. **docs/verificado** ESF: `docs/sf-turn-executor.md@e5567fb` (“sf remains the workflow, workspace, connector, permission and acceptance authority”, VM fresca por turno, checkpoint, no segundo Temporal workflow) y `release/qualification/v1.0.0-rc.1.md:111@e5567fb` menciona “a separate superagent lane polls `superagent-esf`” (integración por carril/cola, no fusión de motores). **inferencia** dsh-herdr: mapa centrado en `monitor/`, `plugin/`, `app/mods` (`graft map@2d74cf8`) sugiere rol de observación/control de terminal, no núcleo transaccional.
- **Propuesta concreta:** la fab debe imitar **solo** el patrón “core/puerto estable, adaptadores reemplazables”; no imitar la topología distribuida (Temporal/VM lane/turn service) salvo que el problema escale a eso.

### ZO2-H3
- **Severidad:** alta
- **Pregunta:** P2, P3
- **Afirmación:** Comparada con `AgentBackend` de copilot, la estrategia actual de la fab (`AgentAdapter` = nombre + argv + env + parse) es simple pero **insuficiente para capacidades vivas** (steer/inject/abort fino/context tools) y empuja diferencias al orquestador. Sin embargo, saltar a un backend tan rico como el de VS Code o al turn-executor de ESF sería sobrediseño para el estado actual.
- **Evidencia:** **verificado** `src/agents.ts:8-21,23-120@ce84fc4` (contrato de comandos; `factoryCommits`, sin canal de sesión viva en interfaz). **verificado** `vscode/src/agent-backend.ts:3-38,40-47@693f4db` (herramientas/contexto, eventos, `steer?`, `currentSystemPrompt`). **docs** `docs/sf-turn-executor.md@e5567fb` (control de ownership/permissions/leases por ejecución efímera). **verificado** fab ya dispone de piezas bajas (`resumeSession`, MCP con token) (`src/sdk/session.ts:144-155`, `src/sdk/mcp-server.ts:23-86@ce84fc4`).
- **Propuesta concreta:** evolucionar en dos pasos pequeños: (1) declarar capacidades por adaptador y unificar abort/sesión, (2) añadir `steer/inject` solo donde el harness lo soporte nativamente. No modelar `AgentTool` genérico ni protocolo de permisos interactivos hasta tener caso real.

### ZO2-H4
- **Severidad:** media
- **Pregunta:** P3
- **Afirmación:** La página 06 es correcta en el corte “admisión delante, fábrica detrás” pero **sobredimensiona** el paquete (router/Mandate/Subscriptions/Outbox/sesión viva compleja) como si fuera un bloque necesario. Desde simplicidad, la mayor parte es YAGNI hasta que exista un origen y volumen que lo exijan.
- **Evidencia:** **docs** `06-integracion-superagent-fab.md:63-71,136-152@ce84fc4` propone admisión completa + router + outbox + steer y fases 1-3. **verificado** síntesis previa ya reduce riesgo clave a “sesión reanudable por id, no proceso retenido” y recomienda costura mínima (`SINTESIS-EGM.md:33,55-56,73@ce84fc4`). **verificado** core superagent modela mucha semántica no requerida hoy por la fab (`src/core/model.ts:126-308@8c32a9d`).
- **Propuesta concreta:** reencuadrar 06 como “opciones incrementales”: mantener D1 corregido y el principio de unión única, pero tratar Mandate/Eval/Subscriptions/Outbox general como backlog condicionado a señales reales.

### ZO2-H5
- **Severidad:** media
- **Pregunta:** P1, P3
- **Afirmación:** No hay evidencia de que ESF sea “más robusto” para los módulos que la fab ya resuelve bien (state/change, worktrees, gates, pool pull). ESF optimiza otro eje: ejecución aislada, reproducible y operable (VM/Temporal/turn service) con coste de infraestructura y complejidad mucho mayor.
- **Evidencia:** **verificado/docs** ESF turn service: VM fresca, manifests/checkpoints, leases, límites y controles de coste (`docs/sf-turn-executor.md:13-19,74-101,137-156@e5567fb`); **docs** carril superagent separado en calificación (`release/qualification/v1.0.0-rc.1.md:111@e5567fb`). **verificado** fab: claim/lease/huérfanos, gates, validadores (`src/store.ts:628-795,1048-1122@ce84fc4`).
- **Propuesta concreta:** **no** tomar ESF como reemplazo modular; usarlo solo como referencia de invariantes (fail-closed, no replay silencioso, limpieza verificada) al endurecer piezas concretas.

### ZO2-H6
- **Severidad:** baja
- **Pregunta:** P2
- **Afirmación:** Pistas a confirmar: (1) el core de `copilot-superagent` y el prototipo coinciden en el modelo central — **confirmado** por esqueleto equivalente. (2) `AgentBackend` existe en `vscode/src/agent-backend.ts` — **confirmado**. (3) ESF menciona carril `superagent-esf` en calificación — **confirmado (docs)**. (4) `sf-turn-executor.md` describe turn service — **confirmado (docs)**. Ninguna de estas pistas, por sí sola, justifica importar subsistemas completos.
- **Evidencia:** **verificado** `graft skeleton src/core/model.ts` idéntico en forma en ambos repos (`@8c32a9d`, `@693f4db`); **verificado** `copilot-superagent/vscode/src/agent-backend.ts@693f4db`; **docs** `esf/release/qualification/v1.0.0-rc.1.md:111@e5567fb`; **docs** `esf/docs/sf-turn-executor.md@e5567fb`.
- **Propuesta concreta:** registrar estas equivalencias como “puerto y carril”, no como mandato de arquitectura.

### ZO2-H7 (fuera de foco, grave)
- **Severidad:** media
- **Pregunta:** P1
- **Afirmación:** Riesgo vigente ya conocido: el confinamiento de `claude` anula MCP/hooks del host, lo que limita instrumentación y control fino desde la fab; cualquier mejora de “sesión viva/MCP” debe diseñarse por adaptador y no asumir paridad.
- **Evidencia:** **verificado** `src/sandbox/confine.ts:102-109@ce84fc4` fuerza `--setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. **verificado** `SINTESIS-EGM.md:39,59,65@ce84fc4`.
- **Propuesta concreta:** tratar la matriz de capacidades real (MCP/hooks/steer bajo confinamiento) como prerrequisito antes de prometer features de control de sesión.

---

## P2. Estrategia de mitkox (reconstrucción)

- **Núcleo conservado:** el **modelo/dominio de admisión y ticketing** del superagent se mantiene como core compartible (prototype → copilot: `src/core/model.ts` equivalente, **verificado** `@8c32a9d/@693f4db`). Allí viven Trigger/Thread/Eval/Decision/Ticket/Assignment/Mandate.
- **Reescritura por harness/entorno:** en copilot el acople al runtime es un **backend port** (`AgentBackend` en `vscode/src/agent-backend.ts@693f4db`, **verificado**) que abstrae `run/assess/steer/handoff/abort/dispose` y herramientas; el core no habla VS Code. **Inferencia:** misma separación que busca la fab, pero ya formalizada como interfaz.
- **Conexión superagent ↔ factory (ESF):** ESF expone un **turn execution service** (`docs/sf-turn-executor.md@e5567fb`, **docs**) que ejecuta turnos efímeros (VM fresca, blob/checkpoint, permisos ligados a operación, cleanup verificado) mientras “sf/workflow” retiene autoridad de permisos/aceptación; la calificación indica un carril separado `superagent-esf` polleado aparte (`release/qualification/v1.0.0-rc.1.md:111@e5567fb`, **docs**). Es integración por **límite de ejecución/cola**, no por compartir el motor interno de la fab.
- **Contrato de backend (efectivo):** en copilot, contrato de **capacidades de agente** (`AgentBackend` + `AgentTool/Event/Run/Steer`, **verificado**). En ESF/turn, contrato de **servicio HTTP de ejecución** con tokens/ownership, perfil congelado, eventos/resultados y control de permisos — un backend de ejecución remota, no una sesión de chat in-process (**docs** `sf-turn-executor.md@e5567fb`).
- **Herdr:** repositorio orientado a monitorización/integración de terminal y app/mods (`graft map@2d74cf8`, `graft ask` hits en `monitor/`, `plugin/`; **verificado/inferencia**). No aporta evidencia de ser el motor de estado; encaja como superficie de observación/UX alrededor de sesiones.
- **Comparación con la fab (`src/agents.ts@ce84fc4`):** la fab usa adaptadores **imperativos por CLI** (argv/env/parse) — adecuados para disparos batch y simples — mientras copilot sube el nivel a un **puerto semántico** estable. ESF baja a un **ejecutor aislado por turno**. La brecha útil para la fab es adoptar el **puerto/capacidades** (bajo coste), no la orquestación VM/Temporal de ESF ni el dominio completo del superagent.

---

## P3. Lo mejor de todos (mínimo y sobras)

**Principio zoom-out:** optimizar por lo que la fab ya hace bien y cerrar solo brechas que desbloquean valor inmediato.

- **Tomar (mínimo):**
  1. **Puerto de harness con capacidades declaradas** (inspirado en `AgentBackend`: run/abort, metadata de resume/steer/mcp/sandbox) para desacoplar `runAgent/pool` de flags concretos. (**verificado** necesidad implícita en `src/agents.ts@ce84fc4` vs `agent-backend.ts@693f4db`).
  2. **MCP/superficie de herramientas cerrada por adaptador/actividad** (la fab ya va en esa línea con token) pero alineada a capacidades reales bajo confinamiento. (**verificado** `src/sdk/mcp-server.ts@ce84fc4`, `src/sandbox/confine.ts@ce84fc4`).
  3. **Invariantes de reanudación/lease** “no duplicar, no replay silencioso” cuando haya residente (patrón), sin copiar VM-per-turn. (**verificado** base en `src/store.ts@ce84fc4`; **docs** regla en `sf-turn-executor.md@e5567fb`).
  4. Si y solo si se abre un canal entrante real: **intake idempotente + gate observe** y **outbox mínimo con recibo** para ese canal (costura mínima de 06 fase 1 acotada).

- **Aplazar (hasta evidencia):** router/assessor automático, Mandate/Policy versionada con efectos, Subscriptions/Threads/Eval completos, steering avanzado cross-harness, carril `superagent-esf` propio.

- **Descartar (para la fab, ahora):** reimplementar el **core de dominio** del superagent como dueño de estado; adoptar **turn-executor/VM por turno/Temporal** como reemplazo del pool/worktree; “sesión viva” como proceso retenido (contradice lección C3 de la síntesis). También descartar un **AgentBackend rico** con context tools/permisos interactivos genéricos sin caso de uso.

**Arquitectura recomendada (simple):** mantener `Store + pool + worktrees + gates/validadores` como columna vertebral; añadir un **módulo opcional de admisión** (tablas propias, misma DB, entrada única a `addSignal/triageSignal`) solo cuando haya poller; y formalizar un **contrato de adaptador por capacidades** que envuelva sesión/MCP existentes. Un solo dueño de estado por agregado, sin proceso dual de “engine”.

### Qué pasa con la página 06 (`06-integracion-superagent-fab.md@ce84fc4`)

| Parte de 06 | Veredicto | Motivo (simplicidad) |
|---|---|---|
| Tesis de “dos sistemas que se tocan en un punto” y no duplicar (addSignal/triageSignal, tablas propias) | **Se confirma** | Corta complejidad y respeta dueños de estado (**docs** §1,§4; coherente con síntesis C6/C11). |
| Reutilizar lo ya existente (señales, pool, worktrees, sesión/MCP en native) y sesión **reanudable por id** | **Se confirma** | Mínimo incremental, evita YAGNI de procesos retenidos (**docs** §2,§4.1). |
| Correcciones incorporadas (D1, MCP no “nuevo” en native, residente nuevo, confinamiento claude) | **Se confirma** | Alinea diseño con realidad verificada (**docs** §2,§4.2). |
| Módulo de admisión completo (gate+Mandate+Policy+Thread/Eval/Subscriptions) y router para todas las peticiones | **Cambia (se recorta fuerte)** | Mucha superficie antes de necesidad probada; quedarse con gate/observe+idempotencia y outbox mínimo por canal (**docs** §3,§5). |
| Outbox general + `steer` como eje temprano + fases 2-3 tal cual | **Cambia / se aplaza** | Condicionar a demanda real y a matriz de capacidades; priorizar puerto de adaptador. |
| Diagrama/alcance que implica “tramo superagent” casi completo dentro de la fab | **Cae como paquete** (sobrevive la costura) | Importar el dominio superagent/ESF entero es exceso; conservar solo la costura y el contrato. |

**Veredicto de una línea sobre la página 06:** se mantiene como **costura mínima** (unión por `addSignal/triageSignal`, sesión reanudable, tablas propias) pero **se recorta**: caen Mandate/Thread-Eval/Subscriptions/router-outbox generales hasta evidencia, y se prioriza un puerto de adaptador por capacidades.

<!-- FIN -->
