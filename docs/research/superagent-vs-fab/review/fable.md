# Doble verificación independiente: superagent de DSH frente a la fab

Revisor: Claude Fable 5.2, 2026-11-09. Borrador revisado: `design_draft.md` (Opus 5.5).

Commits leídos: fab `ce84fc4`, superagent `8c32a9d` (prefijo `S/`), harness `fcc0ad4` (prefijo `H/`). Todas las citas `archivo:línea` están comprobadas leyendo el código en esos commits, salvo las marcadas como **doc** (afirmación de documentación) o **inferencia**.

Método: lectura directa de tramos, sin subagentes. No ejecuté tests, ni el intake, ni ninguna sesión viva. No leí el material de apoyo de `dsh-analisis/`, para no heredar sus conclusiones.

## Resumen

- **La dirección es correcta, el encuadre no.** Reutilizar pool, worktrees, gates y adaptadores es lo acertado. Pero "mismo proceso" no existe en la fab y "no se crea una segunda máquina de estados" es falso: la admisión tiene su propia máquina (Thread y Eval) que vive antes de cualquier change.
- **El borrador no ve que la fab ya tiene sesión viva, servidor MCP y hooks** en su agente `native`. Propone construirlos sobre Claude Code.
- **La tabla §2 tiene una fila falsa y seis imprecisas.** La falsa (`blockActivity` deja el change en `in_review`) sostiene el mapeo de D1, que queda mal.
- **El diagrama salta el router para las peticiones explícitas.** En el superagent el router también decide las explícitas, y de él salen el título y el alcance del Mandate.
- **Falta el riesgo principal de escuchar sola:** el texto de un issue pasaría sin filtro al prompt del implementador (ADR-0007).

Veredicto al final: **listo con cambios**.

## 1. Comparación independiente de las dos arquitecturas

| Eje | superagent (`8c32a9d`) | fab (`ce84fc4`) | Consecuencia |
|---|---|---|---|
| Dominio | Agente proactivo: Trigger, Thread, Eval, Decision, Ticket, Assignment. El trabajo de ingeniería lo decide el worker por prompt (`S/src/core/model.ts:23-39,126-133,277-308`). | Fábrica de cambios: workstream, signal, change, activity con fases fijas `change_review → investigation → implementation → gates → validadores` (`src/enums.ts:32-37,73-76`, `src/store.ts:36`). | Se solapan solo en "unidad de trabajo aceptada". Lo anterior (admisión) es del superagent; lo posterior (fases, gates, evidencia) es de la fab. |
| Dueño del estado | Un `Engine` transaccional es la única puerta de escritura; SQLite propio con agregados JSON (`S/src/core/engine.ts:19-24`, `S/src/app/store.ts:2`). | `Store` sobre `fabrica.db`; los conectores añaden tablas propias fuera del esquema de `Store` (`src/store.ts:139-163`, `src/connectors/links.ts:6-16`). | Hay precedente en la fab para un módulo con tablas propias en la misma base. |
| Máquinas de estado | Tres: Eval por Thread (cola, plazo, reintentos, `unavailable`), Ticket (abierto o terminado, **reanudable**), Assignment (`pending/running/ended`) con Report de seis estados. La etapa `person/*` es una función derivada (`S/src/core/evals.ts:57-118`, `S/src/core/model.ts:211-216`, `S/src/core/stage.ts:9-21`). | Tres: signal (`new → triaged/duplicate/ignored`), change (10 estados, seis terminales), activity. La bandeja humana también es derivada (`src/enums.ts:12-29`, `src/store.ts:42-50,618-625`). | La Eval no tiene equivalente. El Ticket se reanuda tras terminar; el change terminal solo admite `retryChange`. |
| Ejecución | Una sesión persistente por Ticket, a la que se empuja (`start/deliver/stop`); modos `queue`, `steer`, `inject`; el worker abre el PR y decide el merge por prompt (`S/src/core/ports.ts:59-68`, `S/src/executor/dsh.ts:342,466,597`, `S/docs/003-execution.md:84` doc). | Un proceso de un solo disparo por activity, que el pool reclama con lease de 90 s y heartbeat de 30 s; una sola activity en curso por change; la fab abre el PR y fusiona (`src/store.ts:40-41,628-671`, `src/agents.ts:176-180`, `src/connectors/cli.ts:144-146`). | Modelo push con sesión larga frente a modelo pull con disparos cortos y verificación entre ellos. |
| Autorización | Quién puede originar trabajo: gate de código, fuerza `explicit/inferred`, Mandate inmutable revalidado al reanudar, modo `off/observe/auto` (`S/src/policy.ts:167-241`, `S/src/core/model.ts:96-133`). No hay aprobación humana previa al trabajo. | Qué puede hacer el agente y cuándo avanza: dos gates humanos, gates deterministas, validadores, sandbox, cuarentena (`src/store.ts:482-501,870-906`, `src/pool.ts:141,188,263`). No hay noción de quién pide. | Son ortogonales y se suman. Ninguna sustituye a la otra. |
| Canales | Entrada por sondeo de GitHub y eventos de Feishu; salida por Outbox con recibos, orden por conversación y reintentos (`S/src/sources/github.ts:198-246`, `S/src/app/outbox.ts:22-51`). | Entrada por clave de Jira a mano; salida síncrona, sin recibos, lanzada por el operador; el origen externo solo puede ser Jira (`src/connectors/cli.ts:104,118-120`, `src/connectors/types.ts:6-7`). | La fab no tiene nada que escuche ni que reintente un envío. |

## 2. Tabla §2 del borrador, fila por fila

| Fila del borrador | Juicio | Motivo |
|---|---|---|
| Trigger ↔ `signals` | **Imprecisa** | Un Trigger es un evento inmutable con actor, hilos, canal, `human` y `addressed` (`S/src/core/model.ts:23-39`). Una signal solo tiene título, cuerpo y estado (`src/store.ts:145-147`). Varios Triggers alimentan un Ticket; una signal lleva a un único change. La idempotencia no está en `signals` sino en `jira_imports` (`src/connectors/links.ts:12-13`). |
| Ticket ↔ `changes` | **Imprecisa** | `blocked` existe, pero es extensión local del store y es **terminal** (`src/store.ts:38,42-50`). El Ticket tiene Mandate, canales, Inputs e hilos seguidos, y se reanuda tras terminar (`S/src/core/model.ts:277-308`). |
| Assignment ↔ `activities` | **Imprecisa** | Los campos citados existen (`src/store.ts:152-158`). Pero una activity es una fase de un disparo y un Assignment es el vínculo con una sesión que dura todo el Ticket (`S/src/core/model.ts:217-233`). |
| Domain events ↔ `events` | **Imprecisa** | `events` es un registro de texto libre con severidad (`src/store.ts:160-162`). Los del superagent son 13 tipos con datos (`S/src/core/ports.ts:84-101`). |
| Executor con slots ↔ pool | **Imprecisa** | El pool existe y limita por `worker_concurrency` (`src/pool.ts:414-417`). Falta decir que corre como comando en primer plano, uno por workstream, y que no tiene el slot extra para mensajes humanos. |
| prepare + worktree | **Correcta** | `src/worktrees.ts:18,37`; en el superagent es un comando configurable (`S/docs/003-execution.md:49-53` doc). |
| Adaptadores de harness | **Correcta** | `src/agents.ts:32-40,146`. Omite que `native` ya tiene modo de sesión (hallazgo F-03). |
| Gates humanos | **Falsa** en su segunda mitad | `blockActivity` deja el change en `blocked`, no en `in_review` (`src/store.ts:870-887`, línea 882). Además el superagent no tiene gates previos al trabajo: la fila empareja un concepto que solo existe en la fab. |
| Intake de Source | **Correcta** | `src/connectors/intake.ts:16-51`. |
| Channel de vuelta | **Imprecisa** | `ticketComment` admite `merged`, pero ningún código lo publica: solo se usan `status` y `pr_opened`, y los lanza el operador (`src/connectors/cli.ts:118,138,147`). No hay cola, recibo ni reintento. |

## 3. Hallazgos

### F-01. `blockActivity` no deja el change en `in_review`; el mapeo de D1 queda mal
- **Severidad**: alta. **Sección**: §2 (Gates humanos) y D1.
- **Problema**: D1 iguala `person/review` a `in_review` y `person/blocked` a `blocked`. En la fab `in_review` es aprobación **previa** al trabajo (el change nace ahí, o vuelve tras `investigation`). En el superagent `person/review` es un resultado **listo** con PR. El equivalente real es `implemented`. Y `blocked` es terminal: no lo libera un mensaje de una persona, solo `retryChange`.
- **Evidencia**: `src/store.ts:870-887@ce84fc4`, `src/store.ts:494-501@ce84fc4`, `src/store.ts:42-50@ce84fc4`, `src/store.ts:998-1031@ce84fc4`, `S/src/core/stage.ts:15@8c32a9d`.
- **Propuesta**: sustituir D1 por esta tabla y quitar "por gate":

| Etapa del superagent | Estado en la fab | Nota |
|---|---|---|
| `person/review` | `implemented` | Espera validadores y merge. |
| `person/blocked`, `person/failed` | `blocked`, `failed`, `quarantined` | Sale solo con `retryChange`. |
| `person/answer` | Sin equivalente | Ver F-02. |
| `idle` (espera un Trigger) | Sin equivalente | Un change no espera eventos externos. |
| Sin equivalente | `in_review` | Gate previo propio de la fab; se conserva. |

### F-02. Una pregunta al humano no tiene camino de vuelta
- **Severidad**: alta. **Sección**: D1, D3.
- **Problema**: D1 propone una razón de bloqueo `human_action`. La razón cabe sin estado nuevo: ya hay un convenio de prefijos en `activities.error`. Lo que falta es la vuelta. `retryChange` reencola la activity sin texto del humano, y la activity arranca de cero. El único camino existente que lleva un comentario humano al agente es `resolveReview` con `comment`, y solo vale para `change_review` e `investigation`.
- **Evidencia**: `src/store.ts:540@ce84fc4` (prefijo `GATE_TAMPERED:`), `src/store.ts:998-1031@ce84fc4`, `src/store.ts:944-978@ce84fc4`, `src/enums.ts:70-76@ce84fc4`.
- **Propuesta**: decidir en el ADR uno de dos caminos. (a) Extender el camino de revisión: la pregunta deja la activity en `awaiting` y la respuesta la reencola con el comentario. (b) Añadir un comentario a `retryChange`. El supuesto de D1 pasa a ser: "no hace falta estado nuevo, sí hace falta una transición nueva".

### F-03. La fab ya tiene sesión viva, servidor MCP y hooks en `native`
- **Severidad**: alta. **Sección**: §3.4, D3, D4, D5, diagrama.
- **Problema**: §3.4 afirma que los adaptadores son de un solo disparo. Es cierto para la interfaz `AgentAdapter`, pero el agente propio ya ofrece casi todo lo que el diagrama marca como nuevo:
  - Sesión por turnos sobre stdin con cola de mensajes, interrupción y fin.
  - RPC con `add_user_message`, `interrupt_session` y `load_session` para reanudar.
  - SDK `createSession` que arranca esa sesión y le conecta servidores MCP.
  - Servidor MCP en proceso, en `127.0.0.1`, con token por instancia.
  - Hooks `PreToolUse` y peticiones de permiso y de pregunta al usuario.
- **Evidencia**: `src/agent/stream-input.ts:26,58-60@ce84fc4`, `src/agent/rpc.ts:315-316,347-348@ce84fc4`, `src/sdk/session.ts:51,91@ce84fc4`, `src/sdk/mcp-server.ts:23-41@ce84fc4`, `src/agent/hooks.ts:10@ce84fc4`.
- **Límite verificado**: `native` no tiene `steer` ni `inject`. `add_user_message` exige sesión en reposo y el SDK rechaza un segundo turno en curso (`src/agent/rpc.ts:316`, `src/sdk/session.ts:91`). El SDK responde hoy `cancel` a toda petición de permiso y de pregunta (`src/sdk/session.ts:67-68`).
- **Propuesta**: en el diagrama, "NUEVO servidor MCP del Engine" pasa a "reutiliza `createSdkMcpServer`". En D4, el primer adaptador vivo es `native` (ver F-08).

### F-04. No existe un "mismo proceso" donde alojar lo nuevo
- **Severidad**: alta. **Sección**: §4.
- **Problema**: "Extender la fab dentro del mismo proceso" presupone un proceso residente. La fab es un CLI. El pool es un bucle en primer plano por workstream, y `fab daemon` devuelve error porque "falta un backend propio". El sondeo de GitHub, el Outbox y el servidor MCP necesitan un proceso que hoy no existe.
- **Evidencia**: `src/cli.ts:147-150@ce84fc4`, `src/pool.ts:359,388-392@ce84fc4`, `src/cli.ts:108@ce84fc4`.
- **Propuesta**: reformular como "misma base `fabrica.db` y un comando residente nuevo". Añadirlo como pieza nueva del diagrama y como primer entregable de la fase 1. Varios procesos sobre la misma base ya están previstos (`isBusyError`, `src/pool.ts:394-399`).

### F-05. Sí hay una segunda máquina de estados, y vive antes del change
- **Severidad**: alta. **Sección**: §4, párrafo bajo el diagrama.
- **Problema**: el borrador dice que el dueño del estado sigue siendo el change y que no se crea otra máquina. Pero Trigger, Thread, Eval y Decision existen aunque nunca haya change: un Trigger ignorado no crea ninguno, y el modo `observe` de la fase 1 no crea ninguno por definición. La Eval tiene cola por hilo, plazo, dos reintentos y `unavailable`.
- **Evidencia**: `S/src/core/evals.ts:19,57-118@8c32a9d`, `S/src/core/intake.ts:19-27@8c32a9d`, `S/src/core/model.ts:135-182@8c32a9d`.
- **Propuesta**: decirlo sin rodeos: dos agregados con un único punto de unión. La admisión es un módulo con tablas propias en `fabrica.db`, fuera de `Store`, que entra en la máquina de la fab solo por `addSignal` y `triageSignal` (`src/store.ts:428,449-465`). El Ticket sí se funde con el change, uno a uno. Es el mismo patrón que `ChangeLinkStore` y el mismo criterio que ADR-0001 (ver F-06).

### F-06. El borrador no se mide contra ADR-0001 ni ADR-0007
- **Severidad**: alta. **Sección**: §4, §5.
- **Problema**:
  - ADR-0001 rechazó meter el ciclo de investigación dentro de `Store` porque "contamina la BD", y eligió un orquestador delgado que solo toca la máquina de la fab al final. Es el mismo problema de forma: una etapa nueva delante del change. El borrador elige lo contrario sin citarlo.
  - ADR-0007 declara dato no confiable todo texto ajeno y separa lector de implementador. Hoy el cuerpo de la HU llega íntegro a la descripción del change, que alimenta el prompt del implementador. Con importación manual, el operador hace de filtro. Con admisión automática, un comentario de GitHub llegaría al agente que escribe código.
- **Evidencia**: `docs/research/arquitectura-ideacion/adr/ADR-0001-componer-no-construir.md:6-9,15@ce84fc4` (doc), `docs/research/arquitectura-ideacion/adr/ADR-0007-fuentes-no-confiables.md:9-11@ce84fc4` (doc), `src/connectors/intake.ts:7-13,45-46@ce84fc4`, `S/src/core/model.ts:22@8c32a9d` ("`text` and `meta` are untrusted external data").
- **Propuesta**: añadir a §5 el riesgo de inyección como el primero de la lista. Regla para el ADR: el router lee el texto externo envuelto como dato y produce título y alcance en formato fijo; el implementador recibe eso, no el texto original. Citar ADR-0001 y explicar por qué aquí sí se comparte la base.

### F-07. El diagrama salta el router para las peticiones explícitas
- **Severidad**: alta. **Sección**: §3.3 y diagrama (`GATE -->|explicit| MAN`).
- **Problema**: en el superagent toda Eval pasa por el assessor, también la explícita. El gate solo fija la fuerza. La sesión principal decide aceptar, adjuntar a un Ticket existente, parar o ignorar, y produce el `title` y el `scope`. El Mandate guarda ese `scope`. Con el atajo del borrador, una petición explícita no tiene alcance, no se detectan duplicados y "para" no se puede decidir.
- **Evidencia**: `S/src/core/evals.ts:118@8c32a9d`, `S/src/core/ports.ts:42-45@8c32a9d`, `S/src/core/model.ts:126-133@8c32a9d`, `S/docs/002-authorization.md:85@8c32a9d` (doc).
- **Propuesta**: en el diagrama, `explicit` también pasa por el assessor. Lo único que cambia con la fuerza es que la explícita se acepta en cualquier modo y la inferida solo en `auto` (`S/src/policy.ts:55-58`). En fase 1, antes de que exista el router, el alcance de una explícita es el cuerpo del issue tal cual: decirlo.

### F-08. D4 elige el primer adaptador vivo equivocado
- **Severidad**: media. **Sección**: D4, §4.2 fase 2.
- **Problema**: Claude Code aporta `steer` (una prueba, n=1) pero arrastra tres riesgos que el propio borrador lista: cuota, términos de uso y permisos solo de prompt. `native` cubre cola, cancelación, reanudación, MCP, hooks y sandbox real, sin esos riesgos. Además, para conducir `claude` por stdin hay que cambiar `runAgent`, que hoy cierra stdin y corta a los 20 minutos.
- **Evidencia**: F-03; `src/agents.ts:163-180@ce84fc4`; `techdocs/docs/factory/07-seguridad.md:27@ce84fc4` (doc: bwrap cubre gates, setup y herramientas de `native`); `src/agents.ts:46-61@ce84fc4`.
- **Propuesta**: fase 2a con `native` valida los puertos `start/deliver(queue)/stop` y las herramientas MCP. Fase 2b añade `claude` para `steer`, detrás de la matriz de capacidades. Contrapartida, **inferencia**: si el modelo de `native` rinde peor en implementación, 2a prueba el diseño pero no la calidad.

### F-09. "Sesión viva" choca con tres invariantes del pool
- **Severidad**: media. **Sección**: D4, §5 (segunda pregunta abierta).
- **Problema**: una sesión que cruza fases rompe:
  - La exclusión de una sola activity en curso por change.
  - La verificación tras el agente, que exige el HEAD verificado y el worktree limpio.
  - El slot: el heartbeat lo emite el pool, no el agente, así que el lease sigue vivo mientras la sesión espera a un humano y ocupa un slot de `worker_concurrency`. El superagent libera el slot al entregar a una persona.
- **Evidencia**: `src/store.ts:640-644@ce84fc4`, `src/pool.ts:105-117,188,240@ce84fc4`, `S/docs/003-execution.md:37@8c32a9d` (doc).
- **Propuesta**: responder la pregunta abierta en el ADR así: la sesión vive **dentro de una activity**. Cuando espera a un humano, la activity termina y la sesión se guarda por id. La respuesta abre una activity nueva que reanuda esa sesión (`load_session` en `native`, `src/agent/rpc.ts:350`). "Viva" significa reanudable, no proceso retenido. La matriz de capacidades de D2 gana la columna "reanudar por id".

### F-10. D3 inventa `link_pr` y duplica el informe de estado
- **Severidad**: media. **Sección**: D3.
- **Problema**:
  - `link_pr` no existe en el superagent. Sus herramientas de worker son `ack`, `thread_unrelated`, `thread_follow`, `trigger_handback` y `report`. El PR se asocia por el nombre de la rama.
  - En la fab el PR lo abre y lo enlaza la fábrica, no el agente. Un `link_pr` dejaría que el agente afirme qué PR es el suyo.
  - `report` duplica el protocolo actual: la primera línea `STATUS: done` o `STATUS: blocked - <motivo>`, que el pool ya traduce a `blockActivity`.
  - El worker del superagent no tiene `reply`: pregunta con `human_action` dentro de `report` y la sesión principal envía la respuesta.
  - "agy habla MCP" no está verificado: el adaptador solo usa `agy -p … --output-format text`.
- **Evidencia**: `S/src/app/tools/executor.ts:29,42,51,66,75,80@8c32a9d`, `S/docs/003-execution.md:53@8c32a9d` (doc), `src/connectors/cli.ts:144-146@ce84fc4`, `src/prompts.ts:28,93-96@ce84fc4`, `src/pool.ts:279-282@ce84fc4`, `src/agents.ts:91-94@ce84fc4`.
- **Propuesta**: quitar `link_pr`. Dejar una sola herramienta, `report(state, summary, human_action?)`, que escribe en las mismas transiciones que la línea `STATUS`. La línea `STATUS` sigue siendo el informe final de los adaptadores sin MCP. Marcar agy como no verificado.

### F-11. D5 da por existente un gate duro que no cubre a `claude`
- **Severidad**: media. **Sección**: D5.
- **Problema**: el sandbox general de la fab solo envuelve gates, setup y herramientas de `native`. Para `claude` y `codex` existe el confinamiento `--confine`, pensado para un disparo, con un home vacío. No está comprobado que una sesión viva de `claude` funcione ahí, ni cómo se autentica. Y D5 no dice cómo sabe el servidor MCP qué change llama.
- **Evidencia**: `techdocs/docs/factory/07-seguridad.md:27@ce84fc4` (doc), `src/sandbox/confine.ts:7-8,17-21@ce84fc4`, `src/agents.ts:173@ce84fc4`, `src/sdk/mcp-server.ts:36-41@ce84fc4`.
- **Propuesta**: D5 separa por adaptador. `native`: hooks y bwrap ya existentes. `claude`: `--confine` más hooks, **sin probar**, como condición de entrada de la fase 2b. Para el MCP: una instancia por activity, cuyo token identifica el change, como ya hace `createSdkMcpServer`.

### F-12. El puerto `Assessor { request, release }` es más de lo que el diseño necesita
- **Severidad**: baja. **Sección**: D2.
- **Problema**: `request/release` es asíncrono porque el assessor del superagent es una sesión persistente y ocupada: de ahí el plazo que cuenta desde la entrega, los reintentos y `release`. El borrador propone `claude -p` con esquema JSON, que es una llamada con respuesta.
- **Evidencia**: `S/src/core/ports.ts:48-53@8c32a9d`, `S/src/app/assessment.ts:94-101@8c32a9d`, `S/src/core/model.ts:148-151@8c32a9d`.
- **Propuesta**: empezar con `assess(candidate): Promise<AssessmentOutcome>`. Copiar tal cual `assessmentOutcome`, que valida la respuesta del modelo en código (`S/src/policy.ts:40-61`). Pasar a `request/release` solo si el router llega a ser una sesión que conversa.

### F-13. Piezas de la fab que ya cubren lo que la fase 1 dice que falta
- **Severidad**: media. **Sección**: §3, §4.2 fase 1.
- **Problema**: la fase 1 crea registros `would_accept` nuevos. La fab ya tiene con qué expresarlo.
- **Evidencia y propuesta**, pieza por pieza:

| Necesidad del borrador | Pieza existente | Evidencia |
|---|---|---|
| Admitido pero no aceptado (`observe`) | Signal `new` sin triage; es lo que hace `importIssue` con `triage: false` | `src/connectors/intake.ts:49@ce84fc4` |
| Decisión `ignore` o duplicado | `ignoreSignal(id, 'ignored' \| 'duplicate')` | `src/store.ts:467-472@ce84fc4` |
| Etapas `person/*` derivadas | La bandeja: activities en `awaiting` más la última bloqueada | `src/store.ts:618-625@ce84fc4` |
| Freno a la admisión automática | `taskLimit`: `createChange` falla con `limit_reached` | `src/store.ts:482-488@ce84fc4` |
| Enlace del hilo de origen | `change_links`, una fuente por change, con unicidad | `src/connectors/links.ts:8-11@ce84fc4` |
| Prompts versionados por ejecución | `profile_digest` y `fab_sha` por activity | `src/store.ts:1034-1036@ce84fc4` |
| Veredicto "necesita humano" | `needs_human` de los validadores | `src/connectors/types.ts:74@ce84fc4` |

  - Dos consecuencias para el borrador. La admisión debe tratar `limit_reached` como "en cola", no como error. Y la pregunta abierta "¿un change puede tener varios Threads?" tiene hoy respuesta: no, el esquema admite una sola fuente por change y solo de tipo `jira`. Ampliar `ExternalRef.system` es un cambio de contrato que el archivo reserva al integrador (`src/connectors/types.ts:1-7`).

### F-14. Piezas del superagent que se pierden sin decirlo
- **Severidad**: media. **Sección**: §3 y fuera de alcance.
- **Problema**: §3 lista cuatro aportes. El código tiene al menos seis mecanismos más de los que depende que "conversar" funcione. El borrador no los toma ni los descarta.
- **Evidencia**:
  - **Propiedad del seguimiento**: el mensaje de una persona en el hilo de un Ticket lo decide el worker, que lo atiende o lo devuelve. `S/src/core/model.ts:68-75`, `S/src/core/engine.ts:227`.
  - **Reanudar un Ticket terminado** bajo el mismo Mandate, revalidándolo. `S/src/core/intake.ts:38-41`, `S/src/policy.ts:213-240`. En la fab un change `completed` no se reabre.
  - **"Para" es un Trigger** que decide la Eval, no el worker. `S/docs/002-authorization.md:143` (doc).
  - **Aviso de cambio de Policy** a cada Ticket afectado. `S/src/core/model.ts:259-269`, `S/src/policy.ts:144-165`.
  - **Cola duradera de efectos** para todo lo que ocurre tras una decisión, no solo el Outbox. `S/src/app/outbox.ts:24,31`, `S/docs/003-execution.md:153-161` (doc).
  - **Lotes por hilo**: los Triggers que llegan durante una Eval esperan juntos a la siguiente. `S/src/core/engine.ts:42-48`.
- **Propuesta**: añadir a §3 una tabla "se toma, se aplaza, se descarta" con estos seis. Mi lectura, **inferencia**: se toman la cola de efectos y los lotes por hilo; se aplazan seguimiento y reanudación a la fase 3 (sin ellos no hay conversación); "para" se traduce a cancelar el change; el aviso de Policy se descarta mientras los changes sean cortos.

### F-15. Citas y omisiones menores
- **Severidad**: baja. **Sección**: §5, §6, cabecera.
- **Problema**:
  - El slot reservado para mensajes humanos está en `S/docs/003-execution.md:59`, no en `:31` (que es el título del apartado).
  - `S/src/app/assessment.ts:94` es el constructor; la clase empieza en `:89`.
  - El borrador no cita `techdocs/docs/investigacion/inspiracion/05-dsh-que-tomar-para-fab.md`, publicado en el mismo commit `ce84fc4`, que ya trae una matriz "tomar / no tomar". Sus decisiones coinciden con D5, pero conviene que el ADR la sustituya o la referencie.
- **Evidencia**: `S/docs/003-execution.md:31,59@8c32a9d` (doc), `S/src/app/assessment.ts:89,94@8c32a9d`, `techdocs/docs/investigacion/inspiracion/05-dsh-que-tomar-para-fab.md:12-29@ce84fc4` (doc).
- **Propuesta**: corregir las dos citas y enlazar la página 05.

## 4. La elección de fondo: dentro, aparte o encima

| Opción | A favor | En contra | Juicio |
|---|---|---|---|
| Extender dentro, como dice el borrador | Un solo dueño del change; reutiliza pool, worktrees, gates y adaptadores. | No hay proceso residente (F-04). Mete la máquina de Eval en `Store`, contra ADR-0001 (F-06). | Correcta en el tramo de ejecución, no en el de admisión. |
| Proyecto aparte | El núcleo del superagent es portable: 2088 líneas en `src/core/` cuyos únicos imports externos son `node:crypto` y `zod`, con licencia MIT. | Mantiene un segundo agregado Ticket con Assignments propios: dos dueños del trabajo. Duplica la ejecución. | Descartada, por la razón que da el borrador. |
| Capa encima | Aísla la admisión. | Si guarda su propio estado de Ticket, repite el problema anterior. | Descartada tal como la define el borrador. |
| **Módulo de admisión delante, misma base** | Tablas propias en `fabrica.db` como `ChangeLinkStore`; entra por `addSignal` y `triageSignal`; el Ticket es el change. Respeta ADR-0001 y deja la ejecución intacta. | Exige el comando residente y definir bien la unión (Mandate y Thread enlazados al change). | **Recomendada.** |

La opción recomendada no contradice la intención del borrador: es su misma propuesta con el límite del módulo puesto donde el código ya lo pone. Lo que cambia es que el ADR admite dos agregados y un punto de unión, en vez de prometer una sola máquina.

Sobre reutilizar código del superagent: `policy.ts` no es portable tal cual (importa `./infra/text.ts` e `./infra/environment.ts`, `S/src/policy.ts:10-11`), pero el gate, `revalidate` y `assessmentOutcome` son funciones puras de unas 120 líneas. Copiarlas con pin (ADR-0005) es más barato y más fiel que reescribir la tabla de admisión. Que `Intake` y `Evals` se puedan separar de `Tickets` es **inferencia**: `Evals` recibe `Tickets` en el constructor (`S/src/core/engine.ts:36`) y no lo he desenredado.

## 5. D1 a D5, en una línea cada una

| Decisión | Juicio | Cambio pedido |
|---|---|---|
| D1 | Mapeo erróneo; la idea de derivar se sostiene | Tabla de F-01 y transición de vuelta de F-02. |
| D2 | Se sostiene | Añadir "reanudar por id" a la matriz (F-09); simplificar `Assessor` (F-12). |
| D3 | Se sostiene con recortes | Quitar `link_pr`; `report` unificado con `STATUS`; reutilizar el servidor MCP existente (F-03, F-10). |
| D4 | Orden equivocado | `native` primero, `claude` después; sesión dentro de una activity (F-08, F-09). |
| D5 | Principio correcto, base sobrestimada | Separar por adaptador; token por activity (F-11). |

## 6. Lo que no comprobé

- No ejecuté nada: ni tests, ni una sesión `native` con MCP, ni `--confine` con `claude`.
- No verifiqué la prueba de `steer` de D4 ni los términos de uso de la suscripción.
- No leí `S/docs/007-architecture.md` ni el material de `dsh-analisis/`.

Veredicto: **listo con cambios** — antes del ADR hay que corregir la fila falsa y D1 (F-01, F-02), reconocer lo que la fab ya tiene (F-03, F-13), reformular §4 como módulo de admisión con comando residente (F-04, F-05, F-06) y pasar las explícitas por el router (F-07).

<!-- FIN -->
