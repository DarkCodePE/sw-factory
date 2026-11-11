# Revisión EGM zoom-out — `design_draft.md` (goldfish opencode)

Rol: `egm-zoom-out` (REVIEW), criterio de simplicidad/YAGNI/reutilización de alto nivel. Sin contexto previo: solo `design_draft.md` y código/docs citados. Método: lecturas dirigidas con `grep -n`/`sed -n` sobre los repos en sus SHAs indicados; graft sin grafo construido en este entorno (`graft map`/`graft-lector init` devolvieron "no graph"), por lo que la verificación se hizo contra archivos fuente leídos directamente. Cada evidencia se comprobó leyendo código.

## Resumen de verificación (base factual)

| Afirmación del borrador (§2/§3/§4) | Estado | Evidencia leída |
|---|---|---|
| `AgentAdapter { name, command(prompt, {readOnly}), env?, parse?, factoryCommits? }`, adaptadores claude/codex/agy/droid/native/fake | Verificado | `src/agents.ts:32-40,42-64,79-120,122-146@ce84fc4` (interfaz y adaptadores; la lista completa sigue más abajo en el archivo, no releída entera) |
| Adaptadores de un solo disparo (`command` → argv) | Verificado | `src/agents.ts:34,42-62,79-95@ce84fc4`; pool invoca `runAgent` por actividad (`src/pool.ts:10,217@ce84fc4`) |
| Intake por pull del operador y por clave, idempotente con `ChangeLinkStore` + `triageSignal` opcional | Verificado | `src/connectors/intake.ts:16-53@ce84fc4` (`importIssue` exige `key`, consulta gateway, enlaza/importa, triage opcional) |
| `TicketGateway.comment` y `ticketComment(pr_opened\|merged\|status)` | Verificado | `src/connectors/types.ts:27-31@ce84fc4`, `src/connectors/intake.ts:62-66@ce84fc4` |
| Activities con `lease_expires_at`, `worker_id`, `retry_count`, `agent_pgid`; `worker_concurrency` por workstream | Verificado | `src/store.ts:142,152-159,232,236-237,318-319@ce84fc4` |
| Un worktree/rama `fab/<id-corto>` por change | Verificado | `src/worktrees.ts:1,18,37-44@ce84fc4` |
| `blockActivity` deja change en `blocked`; gates humanos `require_change_approval`/`require_approval` y transiciones a `in_review` | Parcialmente verificado | `src/store.ts:143-144,179-180,492,850,870-883,968@ce84fc4`. `blockActivity` pone la **actividad** y el **change** en `blocked` (870-883), no `in_review`. `in_review` se usa en otros flujos (492,850,968); el mapeo exacto "gate → `in_review`" que asume D1 no se trazó completo aquí. |
| Superagent: `steer`=`next-step`+despierta, `inject`=`next-step` sin despertar, `followup`=`next-turn` | Verificado (harness) | `deepseek-harness/packages/core/agent-loop/src/agent.ts:179-189@fcc0ad4` |
| Superagent: puertos `Assessor {request,release}` y `Executor {start,deliver,stop}` | Verificado | `dsh-superagent-prototype/src/core/ports.ts:49-68@8c32a9d` |
| Superagent: Outbox como puerto/receipts sobre efectos | Verificado (forma) | `dsh-superagent-prototype/src/app/outbox.ts:1-35@8c32a9d` |
| Superagent: stages `person/{delivery,answer,review,blocked,failed}` | Verificado | `dsh-superagent-prototype/src/core/stage.ts:5-17@8c32a9d` |
| Cita `S/src/core/tickets.ts:37` para Mandate | Imprecisa | `tickets.ts:25-40@8c32a9d` muestra `create(..., mandate: Mandate, ...)` y uso; la definición/base de `Mandate`/`MandateBasis` está en `src/core/model.ts:126-133@8c32a9d`. |

## Hallazgos (zoom-out)

### ZO-1
- **Severidad:** alta
- **Sección:** §4 (propuesta), §4.1 D2/D3/D4, §4.2 (fases)
- **Problema:** El diseño empaqueta como arquitectura objetivo un subsistema completo (Trigger/Thread/Mandate/Policy+observe, Assessor/router con salida estructurada, Subscriptions, Outbox, worker vivo con modos `queue/steer/inject`, MCP del engine) antes de aislar la unidad mínima que resuelve el problema raíz de §1. El diagrama (§4, líneas 48-61) presenta la maquinaria entera como reparto estable, y D2/D4 fijan puertos y primer adaptador vivo cuando el material de apoyo identifica que el modelo de ejecución condiciona los huecos críticos: en Claude Code, `steer` a mitad de turno/`inject` sin despertar/acuse de inbox son huecos (afirmación de docs/análisis: `mapa-portabilidad.md:114-118,123@8c32a9d/fcc0ad4`, no verificada ejecutando `claude -p`). D4 eleva un experimento n=1 (Haiku, "sin probar: inject, Codex, agy, cuota", §4.1) a decisión de primer adaptador.
- **Evidencia:** objetivo amplio vs. necesidad raíz en `design_draft.md:13-18,46-62,66-78@ce84fc4` (borrador). El pool actual es por actividad one-shot: `runAgent(opts.confine ? agent : captureAgent, prompt, path, ...)` y commits/gates sobre el resultado (`src/pool.ts:208-221,217@ce84fc4`); `AgentAdapter.command` produce argv por invocación (`src/agents.ts:34@ce84fc4`). El superagent del que se importan conceptos depende de inbox/entrega viva (`dsh-superagent-prototype/src/core/ports.ts:59-68@8c32a9d`, harness `agent.ts:179-189@fcc0ad4`).
- **Propuesta concreta:** Reducir el alcance a una **prueba de costura** que valide solo el problema raíz con lo existente: (1) admisión en `observe` que persista `would_accept` como evento/registro ligado a `signal` o tabla nueva mínima, sin crear `Thread/Mandate/Subscription/Outbox` completos; (2) un experimento explícito de "sesión viva + herramienta de reporte" que demuestre el canal de retorno de estado **dentro de las invariantes del pool/lease actuales** antes de decidir puertos `Executor/Assessor`. Aplazar router modelado, subscriptions y outbox propio hasta que (1)-(2) produzcan evidencia.

### ZO-2
- **Severidad:** alta
- **Sección:** §4, §4.1 D1, §5
- **Problema:** Riesgo de **segunda máquina de estados disfrazada** y de colisión con el modelo de ejecución existente. El borrador dice "el dueño del estado sigue siendo el `change`" (línea 63) y deriva `person/*` de `in_review`/`blocked`/razón `human_action` (D1), pero no define el modelo de datos ni el ciclo de vida que una "sesión viva" tendría dentro de una `activity`. Hoy una actividad es reclamada con lease, ejecutada por un agente y completada/fallada/bloqueada (`src/store.ts:152-159,654,870-883@ce84fc4`; `src/pool.ts` orquesta la corrida). Una sesión que "espera a un humano" o recibe `steer/inject` rompe el supuesto implícito de lease/heartbeat como ventana de ejecución acotada; el propio §5 lo reconoce pero la arquitectura no lo resuelve.
- **Evidencia:** `blockActivity` lleva change+activity a `blocked` con `error` libre (`src/store.ts:870-883@ce84fc4`); no hay campo `human_action` ni tipo de bloqueo estructurado. Las activities tienen `lease_expires_at`/`agent_pgid` y claim/índices de lease (`src/store.ts:158-159,236-237,318-319,323@ce84fc4`). El superagent modela espera humana con stages `person/*` y semántica propia (`dsh-superagent-prototype/src/core/stage.ts:5-17@8c32a9d`).
- **Propuesta concreta:** Antes de introducir "modo sesión viva", documentar una decisión de **modelo de concurrencia** con opciones explícitas y criterio de elección: (a) actividad efímera por turno reanudada (compatible con leases actuales), (b) actividad larga tipo sesión con lease renovado/estado `waiting_human`, o (c) entidad separada de sesión enlazada 1:1 al change. Exigir esquema concreto: dónde se persisten `thread`/identidad de sesión, cómo se representa `human_action` (columna/tabla/convención de `error` tipado) y qué invariantes del pool cambian. Sin eso, D1 es una inferencia no aterrizada.

### ZO-3
- **Severidad:** media
- **Sección:** §3, §4 (nodos "NUEVO"), §4.1 D2
- **Problema:** **Reinvención/paralelismo de vocabulario** frente a piezas ya presentes en fab. Se proponen como nuevos Trigger/Thread/Mandate/Outbox/Assessor/Policy cuando fab ya tiene `signals`, `events`, `ChangeLinks`/import idempotente, `TicketGateway`, y comentario de vuelta; el intake existe aunque sea manual (`importIssue`). Importar el modelo conceptual del superagent sin una tabla explícita de "reutiliza / extiende / reemplaza" eleva complejidad accidental y dificulta mantener `fabrica.db` como único dueño.
- **Evidencia:** señales/eventos/intake/comentarios verificados en `src/store.ts:145-162@ce84fc4`, `src/connectors/intake.ts:16-66@ce84fc4`, `src/connectors/types.ts:27-31@ce84fc4`. El borrador reconoce equivalencias parciales (§2) pero en §4 etiqueta casi todo como `NUEVO` salvo el flujo `signal→change→pool` y `agents.ts`. `ChangeLinkStore`/`importIssue` ya resuelven idempotencia por fuente+clave (`src/connectors/intake.ts:20-52@ce84fc4`).
- **Propuesta concreta:** Añadir una matriz de **reutilización obligatoria** (componente existente → responsabilidad nueva → cambio mínimo): p. ej. `events`/`signals` como sustrato de trigger observado, `ChangeLink*` para identidad/idempotencia externa, `TicketGateway.comment/ticketComment` como canal de salida antes de crear Outbox genérico, intake poller como extensión de `importIssue`/fuente. Marcar como "nuevo" solo lo que no tenga equivalente (gate/Policy con `observe`, sesión viva) y justificar por qué no es una extensión.

### ZO-4
- **Severidad:** media
- **Sección:** §4.1 D2, §4.2 fase 2, §3.4
- **Problema:** **Acoplamiento prematuro a la forma de DSH/superagent** y a una capacidad no uniforme entre adaptadores. D2 copia los puertos `Executor/Assessor` del superagent y promete "matriz de capacidades" (`reanudar, steer, inject, cancel, MCP, permisos duros`), pero los adaptadores actuales de fab son invocaciones CLI heterogéneas sin sesión gestionada (`src/agents.ts` construye comandos; codex/agy/droid/native tienen semánticas y opciones distintas). El borrador no confronta que, según el análisis de portabilidad (afirmación de docs), DSH es in-process/Cordis y Claude Code es un proceso con protocolo, y que la capa acoplada a reescribir es sustancial (`mapa-portabilidad.md:13,158-166@8c32a9d/fcc0ad4`).
- **Evidencia:** heterogeneidad verificada: `claude` usa `-p`+tools+`--output-format json` y parsea uso (`src/agents.ts:42-77@ce84fc4`); `codex` usa `codex exec` con sandboxes y `factoryCommits` (`src/agents.ts:79-89@ce84fc4`); `agy`/`droid`/`native` tienen flags/env distintos (`src/agents.ts:92-120,122-146@ce84fc4`). Puertos fuente: `Executor.start/deliver/stop`, `Assessor.request/release` (`dsh-superagent-prototype/src/core/ports.ts:49-68@8c32a9d`).
- **Propuesta concreta:** Definir primero la **matriz de capacidades real** sobre los adaptadores que fab ya soporta (qué significa `resume/cancel/steer/inject/MCP/report` para claude, codex, agy, droid, native; cuáles son imposibles o degradan) y derivar de ahí una interfaz mínima. Evitar adoptar la firma DSH como contrato interno hasta que la costura (ZO-1/ZO-2) demuestre qué operaciones son necesarias; si solo se necesita "reportar estado + pedir input" por MCP en claude, no se requiere modelar `steer/inject` para todos.

### ZO-5
- **Severidad:** media
- **Sección:** §4.1 D5, §5, §2
- **Problema:** **Contexto de seguridad insuficiente a la altitud de la decisión**. D5 declara gate duro fuera del prompt (hooks + `bwrap`) y §5 reconoce "workers vivos con más privilegios", pero no reconcilia esto con el estado real: permisos/herramientas varían por adaptador (claude con `--permission-mode acceptEdits` y lista de tools; codex con sandbox/workspace-write o read-only; agy con `--dangerously-skip-permissions`; droid en modo airgap con modelo BYO). El borrador trata la seguridad como una decisión binaria resuelta, cuando una sesión viva amplía superficie (tiempo, entrada posterior del humano, herramientas MCP nuevas).
- **Evidencia:** `src/agents.ts:42-59@ce84fc4` (claude acceptEdits/allowed tools), `src/agents.ts:86-88@ce84fc4` (codex sandbox), `src/agents.ts:94@ce84fc4` (agy `--dangerously-skip-permissions`), `src/agents.ts:102-120@ce84fc4` (droid airgap/model env). `readOnly` se propaga en pool/adapters (`src/pool.ts:208,220@ce84fc4`, `src/agents.ts:34,86,142,170@ce84fc4`). La frontera de seguridad "no es el worktree" es consistente con el aviso del superagent (afirmación de docs: `S/docs/003-execution.md:78-82@8c32a9d`, leído parcialmente).
- **Propuesta concreta:** Añadir una sección de **modelo de amenazas delta** para "sesión viva": qué nuevas acciones permite (inyectar instrucciones post-arranque, exponer MCP del engine, acceso prolongado), qué garantías aporta cada adaptador hoy, y qué controles son obligatorios por capacidad (hook deny, sandbox, allowlist MCP, red). Condicionar la fase 2 a pasar esa matriz, no solo a implementar hooks.

### ZO-6
- **Severidad:** baja
- **Sección:** §1, §3.1, citas `S/…`/`H/…`
- **Problema:** **Precisión de trazabilidad** menor que puede erosionar confianza en un borrador que pide revisión rigurosa. Algunas referencias mezclan el lugar de uso con el lugar de definición (p. ej. Mandate citado a `S/src/core/tickets.ts:37`, mientras la definición/base aparece en `core/model.ts:126-133@8c32a9d`; `tickets.ts` lo consume en `create`). No afecta la dirección, pero en un diseño que integra dos modelos conviene que las anclas apunten a definiciones canónicas.
- **Evidencia:** ver tabla de verificación arriba: `dsh-superagent-prototype/src/core/tickets.ts:25-40@8c32a9d` (uso en `create`), `dsh-superagent-prototype/src/core/model.ts:126-133@8c32a9d` (Mandate/Basis). Feishu está fuera de alcance (§1) pero el intake objetivo de fase 3/diagrama lo roza implícitamente; conviene mantener el corte explícito.
- **Propuesta concreta:** Normalizar citas a **definición + un sitio de uso representativo** cuando difieran (ej. `Mandate: model.ts:126@8c32a9d; usado en tickets.ts:32@8c32a9d`). Añadir nota de que citas `S/docs/*` y `mapa-portabilidad` son afirmaciones de análisis estático salvo D4/ejecución explícitamente declarada.

## Veredicto

**listo con cambios** — La dirección (extender la fab como único dueño de estado, empezando por admisión en `observe`) es coherente con el problema raíz, pero antes de tratar §4/D2 como arquitectura comprometida hay que recortar alcance a una costura mínima verificable, resolver el modelo de actividad/sesión viva bajo leases, fijar una matriz de reutilización sobre `signals`/`events`/`ChangeLinkStore`/`TicketGateway`, y aterrizar capacidades+seguridad por adaptador.

<!-- FIN -->
