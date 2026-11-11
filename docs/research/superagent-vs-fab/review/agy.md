# Revisión de Diseño (Goldfish EGM): Integración del Superagent de DSH en la Fab

**Revisor:** agy (Goldfish EGM)  
**Roles:** `design_critic.md` (Hostile Design Critic) + `inventive_catalyst.md` (Inventive Problem Solving / TRIZ)  
**Documento auditado:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/design_draft.md`  
**Fecha:** 2026-11-09  

### Repositorios y Shas verificados
- `fab`: `/home/orlando/Desktop/factory/sw-factory` @ `ce84fc4`
- `superagent`: `/home/orlando/Desktop/ia-master/dsh-superagent-prototype` @ `8c32a9d`
- `deepseek-harness`: `/home/orlando/Desktop/ia-master/deepseek-harness` @ `fcc0ad4`

### Leyenda epistémica
- **[VERIFICADO EN CÓDIGO]**: Comprobado directamente en los fuentes en disco inspeccionando líneas y ramas de ejecución.
- **[AFIRMACIÓN DE DOCS]**: Respaldado por documentación técnica de los repositorios sin ejecución interactiva.
- **[INFERENCIA]**: Deducción lógica o análisis arquitectónico a partir de evidencia estática.

---

## 1. Evaluación Estratégica General

El borrador aborda un problema arquitectónico real y de alto valor: cómo dotar a la `fab` de reactividad conversacional y de admisión determinista externa sin reimplementar un harness masivo como DSH. La propuesta acierta al identificar que la fab ya cuenta con la mayor parte del sustrato de ejecución (`signals`, `changes`, `activities`, `pool`, `worktrees`, validadores e integración inicial con Jira/GitHub).

Sin embargo, desde las ópticas combinadas de **Crítico de Diseño** (auditoría de supuestos, fallos de escalabilidad, cuotas y consistencia) y de **Catalizador Inventivo** (eliminación de falsos compromisos mediante principios TRIZ), la propuesta actual adolece de **tres falsos compromisos críticos** que la vuelven inviable en su formulación presente:

1. **El falso compromiso del monoproceso y base de datos única:** Se asume que para evitar duplicar lógica o tener dos dueños del estado, es obligatorio meter intake, webhooks, router, servidor MCP, outbox y sesiones vivas en el mismo proceso y sobre el mismo archivo SQLite (`fabrica.db`). Esto pasa por alto la severa contención transaccional (`SQLITE_BUSY`) que ya experimenta la fab con múltiples workers.
2. **El colapso del modelo de estados y ciclo de vida (D1):** El borrador asume erróneamente que `blockActivity` deja el cambio en `in_review` y propone mapear `person/answer` y `person/blocked` a `blocked`. En el código real de la fab, `blocked` es un estado terminal que cancela todas las actividades pendientes y mata el change de forma irreversible.
3. **La contradicción entre leases del pool y sesiones interactivas vivas (D4):** Pretender que una sesión interactiva viva espere a un humano mientras reside en un worker del pool colisiona directamente con el sistema de leases (`lease_expires_at = 90s`), provocando la parálisis del workstream (`worker_concurrency`) o la muerte del proceso del agente por `SIGKILL` ejecutado por `requeueOrphans`.

A continuación se detallan los hallazgos con evidencia directa en código y propuestas inventivas estructuradas.

---

## 2. Hallazgos de Revisión

### H1. [ALTA / BLOCKER] Falsa asunción sobre `blockActivity` y colapso terminal del ciclo de vida al mapear `person/*` a `blocked`

- **Sección del borrador:** §2 (Tabla, fila 31) y §4.1 (Decisión D1).
- **Problema técnico:**
  El borrador fundamenta su estrategia de estados en una premisa fáctica falsa. En la fila 31 de la tabla (§2) afirma que `blockActivity deja el change en in_review`. Basado en ello, la Decisión D1 propone:
  > *«D1. Las etapas `person/*` se derivan de los estados del change. `person/review` = `in_review` por gate; `person/blocked` = `blocked`; `person/answer` = nueva razón de bloqueo `human_action`. Supuesto no verificado: que `in_review`/`blocked` más una razón basten sin estado nuevo.»*

  [VERIFICADO EN CÓDIGO] Al auditar `src/store.ts:871-888@ce84fc4`, `blockActivity` no pone el change en `in_review`. Ejecuta explícitamente:
  `this.setChangeStatus(a.changeId, 'blocked');`
  
  En `src/store.ts:43-50@ce84fc4`, `'blocked'` es explícitamente parte de `TERMINAL_CHANGE_STATUSES`:
  ```ts
  export const TERMINAL_CHANGE_STATUSES: readonly string[] = [
    'completed',
    'failed',
    'canceled',
    'declined',
    'blocked',
    'quarantined',
  ];
  ```
  Al llamar a `setChangeStatus` con un estado terminal (`src/store.ts:555-566@ce84fc4`), se desencadena la cancelación masiva de actividades:
  ```ts
  if (isTerminalChange(status)) {
    this.db.query(`UPDATE activities SET status = 'canceled', completed_at = ? WHERE change_id = ? AND status = 'pending'`).run(this.now(), changeId);
    this.terminalEvidence.add(changeId);
    writeManifest(this, changeId);
  }
  ```
  Y en el pool de ejecución (`src/pool.ts:123, 174, 233, 316@ce84fc4`), ante cualquier change en estado terminal (`store.isTerminalChange(change.status)`), los workers abortan de inmediato y liberan la actividad. Además, en la fab no existe ninguna operación `unblock`; la única reapertura es `retryChange` (`src/store.ts:998-1035@ce84fc4`), la cual no reanuda la actividad existente sino que aborta y genera una activity completamente nueva desde cero.

  En el superagent de DSH (`S/src/core/stage.ts:9-21@8c32a9d`), las etapas `person/answer` y `person/blocked` son **pausas reanudables** (`waitsForPerson(ticket)`), donde un follow-up o respuesta humana reactiva de inmediato la ejecución devolviendo el ticket al executor. Si la fab mapea `person/answer` a `blocked`, el change muere, sus tareas pendientes se cancelan y el trabajo queda abortado permanentemente.

- **Evidencia:**
  - `src/store.ts:43-50@ce84fc4`: Definición de `TERMINAL_CHANGE_STATUSES` conteniendo `'blocked'`.
  - `src/store.ts:555-566@ce84fc4`: `setChangeStatus` cancela todas las actividades pendientes y sella el manifiesto si el estado es terminal.
  - `src/store.ts:871-888@ce84fc4`: `blockActivity` transiciona el change a `'blocked'`, cancela actividades y emite advertencia.
  - `src/pool.ts:123,174,233,316@ce84fc4`: Aborto inmediato de procesamiento si `isTerminalChange`.
  - `S/src/core/stage.ts:9-21@8c32a9d`: `ticketStage` y `canRetry` clasifican `person/*` como espera activa reanudable por humanos.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Falso compromiso detectado:* Intentar embutir una conversación bidireccional interactiva dentro de un autómata de estados unidireccional por lotes, forzando la sobrecarga semántica de `blocked` (que significa fallo irreparable en fab) para representar "esperando respuesta humana".
  - *Contradicción técnica:* **Reanudabilidad interactiva (Flexibilidad de control) vs. Invariante de cierre terminal (Consistencia del Store)**.
  - *Patrón de resolución:* **Segmentación** (Pattern #1) y **Extracción** (Pattern #2).
    - Extraer la condición de espera humana del conjunto terminal.
    - Incorporar un estado formal no terminal en el change (p. ej. `waiting_human` o preservar `in_review` con `review_status = 'awaiting_input'`), replicando la semántica que ya emplean los validadores cuando emiten `VERDICT: needs_human` (`review_status = 'commented'`, manteniéndose en `implemented` sin cancelarse, `src/store.ts:820-840@ce84fc4`).
  - *Pasivos operacionales secundarios:* Requiere migrar el esquema SQL de `src/store.ts`, actualizar los predicados de `inbox()` y `runPool()`, y extender la CLI/TUI para permitir al operador responder la pregunta del worker para desatascar el cambio.

---

### H2. [ALTA / BLOCKER] Incompatibilidad crítica entre leases del pool y sesiones vivas: parálisis por concurrencia o terminación forzosa por `SIGKILL`

- **Sección del borrador:** §4.1 (Decisión D4) y §5 (Riesgos y preguntas abiertas, viñeta 2).
- **Problema técnico:**
  El borrador propone en D4 utilizar sesiones vivas para workers (`Claude Code` con stdin stream-json persistente) y reconoce de pasada en §5 la duda de si lease y heartbeat siguen valiendo para una sesión que espera a un humano. Sin embargo, no proporciona solución y asume que ambos modelos convivirán pacíficamente.
  
  [VERIFICADO EN CÓDIGO] El mecanismo de leases de la fab es implacable:
  1. `src/store.ts:35-36@ce84fc4` fija `LEASE_TTL_MS = 90_000` (90 s) y `HEARTBEAT_INTERVAL_MS = 30_000` (30 s).
  2. `src/pool.ts:103-113@ce84fc4` ejecuta un `setInterval` de latido atado al hilo de ejecución de `processActivity`.
  3. `src/store.ts:140-144@ce84fc4` restringe la concurrencia del workstream por `worker_concurrency`.
  4. `src/store.ts:1072-1085@ce84fc4` implementa `requeueOrphans`. En cada vuelta del pool (`src/pool.ts:344@ce84fc4`), se buscan actividades con `lease_expires_at <= now`. Si la actividad vencida tiene un `agent_pgid` vivo, ejecuta:
     ```ts
     process.kill(-act.agent_pgid, 'SIGKILL');
     ```
  
  Esto crea un dilema insoluble para la propuesta tal como está redactada:
  - **Opción A (El worker vivo mantiene el lease mientras espera al humano):** El proceso hijo de Claude sigue vivo y el pool sigue enviando latidos cada 30 s. Consecuencia: el worker consume de forma permanente 1 slot de `worker_concurrency`. Si el workstream tiene `worker_concurrency: 1` (muy común en repos locales), toda la fábrica queda completamente paralizada para otros changes mientras la persona no responda en GitHub o Jira.
  - **Opción B (El worker vivo suspende el lease o el pool se reinicia):** Si el lease no se renueva durante 90 segundos porque la activity se considera pausada, `requeueOrphans` asume que el worker crasheó, envía `SIGKILL` al grupo de procesos (`agent_pgid`) y reasigna o cancela la actividad, destruyendo la sesión viva que estaba esperando.
  - **Opción C (El proceso sale pero la fab no sabe reanudarlo):** `runAgent` (`src/agents.ts:148-180@ce84fc4`) está codificado asumiendo un ciclo sincrónico que espera `proc.exited`. No existe infraestructura de backgrounding de sesiones en el pool.

- **Evidencia:**
  - `src/store.ts:35-36@ce84fc4`: TTL de lease de 90 segundos.
  - `src/store.ts:1072-1085@ce84fc4`: `SIGKILL` automático a procesos huérfanos con lease expirado.
  - `src/pool.ts:103-113@ce84fc4`: Bucle rígido de latido en `processActivity`.
  - `src/pool.ts:221-224@ce84fc4`: Invocación monolítica y bloqueante de `runAgent`.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Falso compromiso detectado:* Creer que para tener "sesiones vivas conversacionales" es obligatorio mantener un proceso hijo del sistema operativo atado a un slot de worker del pool de ejecución por lotes.
  - *Contradicción técnica:* **Disponibilidad/Rendimiento del pool (Productividad industrial) vs. Continuidad conversacional (Latencia de respuesta humana)**.
  - *Patrón de resolución:* **Consumibles Baratos** (Pattern #10) + **Acción Preliminar** (Pattern #3).
    - Desacoplar la "sesión de agente" del "proceso del SO": tratar el proceso hijo como un consumible efímero por turno (*turn-based dispatch*).
    - En lugar de mantener a Claude Code en streaming bidireccional infinito bloqueando un proceso de Bun, cada turno de ejecución es una actividad delimitada.
    - Cuando el agente requiere entrada humana o concluye su paso, persiste su estado en el transcript nativo o almacén local utilizando un identificador determinista (`--session-id <uuid deterministic>`). La activity se completa exitosamente con un resultado `suspend(waiting_human)`, liberando el lease y el slot del pool.
    - Cuando el webhook o poller recibe la respuesta humana, encola una nueva activity que ejecuta `claude -p --resume <uuid>` (**Acción Preliminar**).
  - *Resultado Final Ideal (IFR):* El sistema proporciona al usuario la experiencia de una conversación continua y con memoria, mientras que para el pool de la fábrica todas las ejecuciones son transacciones efímeras de coste cero mientras esperan.
  - *Pasivos operacionales secundarios:* Se pierde la memoria caché volátil en RAM del proceso Node (aunque Claude Code mantiene el log en `.jsonl`). Si la respuesta humana tarda más de 5 minutos, la API de Anthropic purga la caché de contexto efímera (incrementando el coste de tokens al reanudar).

---

### H3. [ALTA / BLOCKER] Falsa atribución de seguridad al sandbox `bwrap` y ceguera ante prompt injection en herramientas MCP vivas

- **Sección del borrador:** §4.1 (Decisión D5) y §5 (Riesgos, viñeta 4).
- **Problema técnico:**
  En la Decisión D5, el borrador sostiene:
  > *«D5. Gate duro fuera del prompt. Hooks `PreToolUse` y el sandbox `bwrap` existente (`techdocs/docs/factory/07-seguridad.md`). Un worktree no es frontera de seguridad (`S/docs/003-execution.md:80`).»*

  [VERIFICADO EN CÓDIGO] Esta afirmación es técnicamente errónea respecto a cómo funciona la seguridad en `sw-factory`:
  1. `techdocs/docs/factory/07-seguridad.md:60-61@ce84fc4` lo dice explícitamente:
     > *«No lo usan los adaptadores `claude`, `codex`, `agy` ni `droid`: la factory los lanza tal cual. `isolationFor` lo declara en la evidencia (`src/manifest.ts:52-59`).»*
  2. En `src/pool.ts:221-224@ce84fc4`, `opts.confine` solo se activa si la configuración global lo impone, y aun así, los CLIs externos que requieren red (como Claude Code para hablar con la API de Anthropic) no pueden correr dentro de `bwrap --unshare-net` sin romper su funcionamiento básico.
  3. La seguridad contra acciones anómalas del agente en la fab descansa casi exclusivamente en `ThreatMonitor` (`src/pool.ts:245-255@ce84fc4`). Sin embargo, `ThreatMonitor` es **estrictamente post-hoc**: analiza el `stdout`, `stderr` y el git diff *únicamente después de que el proceso ha finalizado*.
  
  Si se implementa una sesión viva con un servidor MCP exponiendo `reply`, `report` y `link_pr` conectado directamente al Engine (§4):
  - El proceso de Claude Code nunca termina entre interacciones. Por tanto, `ThreatMonitor` **nunca se ejecuta** durante la conversación.
  - Un atacante que introduzca un prompt injection a través de un Issue o Pull Request de GitHub admitido por el router puede instruir al modelo para que llame a la herramienta MCP `reply` con datos confidenciales del entorno, o ejecute herramientas de sistema en el host sin ningún sandbox de OS activo.
  - Los hooks `PreToolUse` de Claude Code no constituyen una frontera de aislamiento de procesos, sino una política dentro del mismo espacio de ejecución del usuario.

- **Evidencia:**
  - `techdocs/docs/factory/07-seguridad.md:60-61@ce84fc4`: Exclusión explícita de `claude`, `codex` y `agy` del sandbox `bwrap`.
  - `src/manifest.ts:52-59@ce84fc4`: `isolationFor` documenta que los adaptadores corren sin aislamiento de OS.
  - `src/pool.ts:245-255@ce84fc4`: `ThreatMonitor.report()` se evalúa en diferido tras la terminación del subproceso.
  - `src/agents.ts:40-62@ce84fc4`: Definición del adaptador `claude` sin confinamiento `bwrap`.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Falso compromiso detectado:* Confiar en que herramientas MCP vivas pueden tener efectos colaterales directos en el mundo exterior asumiendo que un hook en espacio de usuario reemplaza a un sandbox de sistema operativo.
  - *Contradicción técnica:* **Capacidad de interacción inmediata del agente vs. Confinamiento de efectos hostiles no auditados**.
  - *Patrón de resolución:* **Amortiguación Previa** (Pattern #4) e **Inversión** (Pattern #5).
    - *Inversión del Outbox:* Las herramientas MCP expuestas al worker (`reply`, `link_pr`) no deben realizar llamadas de red ni ejecutar mutaciones externas en tiempo real. Su única función debe ser encolar mensajes en un estado de borrador transaccional (`staged`) en la base de datos local.
    - Ningún mensaje sale hacia GitHub o Jira hasta que el turno concluye y pasa por un filtro de evaluación determinista o revisión humana (amortiguación previa).
  - *Pasivos operacionales secundarios:* Introduce una latencia deliberada de unos segundos antes de que el bot publique en GitHub/Jira; requiere un despachador asíncrono para vaciar el buzón de salida.

---

### H4. [MEDIA / MAJOR] Acoplamiento monolítico y contención crítica de escrituras en SQLite (`fabrica.db`) por concurrencia multi-rol

- **Sección del borrador:** §4 (Propuesta de diseño, párrafo 46).
- **Problema técnico:**
  El borrador descarta tajantemente cualquier separación arquitectónica:
  > *«Extender la fab dentro del mismo proceso y el mismo `fabrica.db`. Descartado: un proyecto aparte (duplicaría store, pool, worktrees, gates y adaptadores) y una capa externa encima (dos dueños del estado).»*

  [INFERENCIA / VERIFICADO EN CÓDIGO] Esta decisión ignora las restricciones de concurrencia de SQLite y los límites del event loop de Bun:
  1. `src/store.ts:555, 871@ce84fc4` y a lo largo de todo el store se utilizan transacciones `.immediate()`. Aunque SQLite esté configurado en modo WAL, las transacciones inmediatas obtienen un cerrojo de reserva exclusivo para escrituras.
  2. La fab ya presenta problemas conocidos de contención cuando múltiples workers del pool compiten por leases, requeue y transiciones de activities, requiriendo envoltorios explícitos como `withRetry` y comprobaciones de `isBusyError` (`src/store.ts:52-56@ce84fc4`, `src/pool.ts:335-340@ce84fc4`).
  3. Colocar en el mismo proceso y sobre el mismo archivo SQLite:
     - El poller/webhook HTTP de GitHub y Jira recibiendo eventos.
     - La tabla de admisión y evaluación de candidatos con llamadas LLM de evaluación estructurada.
     - El servidor MCP atendiendo llamadas RPC de los agentes en ejecución.
     - Los latidos periódicos (cada 30 s por worker) del pool de ejecución.
     - Los subprocesos de compilación pesada y tests de gates.
     - Los reintentos y registros durables de la Outbox.
  Causará picos de contención `SQLITE_BUSY`, bloqueos de event loop y retardos en los heartbeats del pool, lo que a su vez disparará falsos positivos en `requeueOrphans`.

- **Evidencia:**
  - `src/store.ts:52-56@ce84fc4`: Detección de bloqueos de base de datos (`isBusyError`).
  - `src/store.ts:555,871@ce84fc4`: Bloqueos de escritura exclusivos vía `.immediate()`.
  - `src/pool.ts:335-340@ce84fc4`: Manejo de excepciones por contención durante la ejecución del pool.
  - `design_draft.md:46`: Directriz de diseño de proceso único y base de datos única.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Falso compromiso detectado:* Creer que para evitar duplicación de código o problemas de doble dueño de estado es indispensable concentrar I/O externa, coordinación y cómputo pesado en un monolito de un solo proceso y un solo archivo SQLite.
  - *Contradicción técnica:* **Coherencia transaccional del dominio vs. Aislamiento de fallos y rendimiento de I/O**.
  - *Patrón de resolución:* **Extracción** (Pattern #2) e **Intermediario** (Pattern #8).
    - Desacoplar físicamente la base de datos de admisión/conversación de la base de datos de ejecución industrial:
      - `superagent.db`: Triggers, Threads, Evals, Mandates, Outbox y auditoría de admisión (gestionado por el demonio de intake/router).
      - `fabrica.db`: Workstreams, Changes, Activities, Events y Leases (gestionado por la factory y el pool).
    - La integración se realiza mediante un puerto intermediario: cuando un Mandate es aceptado, el intake utiliza la API/SDK existente (`importIssue` o `addSignal`) para generar el trabajo en la fab (`src/connectors/intake.ts:16-51@ce84fc4`).
  - *Pasivos operacionales secundarios:* Gestión de dos archivos SQLite en disco y necesidad de manejar consistencia eventual entre el ID de Ticket externo y el Change ID interno.

---

### H5. [MEDIA / MAJOR] Huérfanos de estado en el modelo relacional: Triggers y Threads sin Change

- **Sección del borrador:** §4 (párrafo 63) y §2 (Tabla, fila 24 y 32).
- **Problema técnico:**
  El borrador afirma en §4:
  > *«El dueño del estado sigue siendo el `change`: el Mandate y el Thread se enlazan a él y no se crea una segunda máquina de estados.»*

  [VERIFICADO EN CÓDIGO] Esta estructura es relacionalmente inconsistente con la operativa del superagent:
  1. En el superagent (`S/src/core/model.ts:100-115@8c32a9d`, `S/src/policy.ts:40@8c32a9d`), el ciclo de vida de un evento entrante es:
     `Trigger -> Thread -> Gate -> Evaluation (Assessor) -> Decision`.
     Una gran cantidad de Triggers procesados terminan en `rejected`, `not_human`, `off`, o en modo `observe` como `would_accept`. En ninguno de estos casos se debe o puede instanciar un `change` en la fábrica.
  2. Si el Mandate y el Thread se enlazan obligatoriamente al `change`, ¿dónde se registran los hilos descartados, las conversaciones en curso que piden clarificación antes de definir trabajo, o las métricas de observación en sombra?
  3. En `src/store.ts:145-147@ce84fc4`, la tabla `signals` tiene la restricción:
     `workstream_id TEXT NOT NULL REFERENCES workstreams(id)`
     Un webhook entrante de un repositorio genérico de GitHub o una mención de usuario no conoce a priori a qué `workstream_id` pertenece hasta que el Assessor clasifica la intención. No se puede crear un Signal preliminar sin workstream.

- **Evidencia:**
  - `src/store.ts:145-147@ce84fc4`: Clave foránea obligatoria `workstream_id NOT NULL` en `signals`.
  - `S/src/core/model.ts:100-115@8c32a9d`: Independencia de entidades previas a la creación de Tickets.
  - `S/src/core/tickets.ts:37-45@8c32a9d`: Un Ticket solo se crea tras una evaluación aceptada (`AssessmentOutcome.kind === 'accept'`).
  - `design_draft.md:63`: Vinculación exclusiva del Thread y Mandate al Change.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Falso compromiso detectado:* Tratar la admisión previa como si fuera un atributo derivado del Change para evitar añadir tablas a la base de datos.
  - *Contradicción técnica:* **Minimalismo de tablas relacionales vs. Integridad y completitud de la auditoría de admisión**.
  - *Patrón de resolución:* **Segmentación** (Pattern #1).
    - Modelar la admisión como un agregado independiente previo: `triggers` y `threads` deben poseer su propia persistencia. El `Mandate` actúa como el contrato frontera: únicamente al emitir un Mandate positivo se dispara la transición hacia `Signal` o `Change` en la fábrica.
  - *Pasivos operacionales secundarios:* Requiere definir esquemas y políticas de retención/limpieza periódica para descartar triggers antiguos que nunca se convirtieron en changes.

---

### H6. [MEDIA / MAJOR] Carencia de dimensionamiento económico de tokens, cuotas de suscripción y políticas de contrapresión (Backpressure)

- **Sección del borrador:** §4.1 (Decisiones D2, D4) y §5 (Riesgos y preguntas abiertas, viñeta 1).
- **Problema técnico:**
  El borrador menciona como riesgo en §5 que hacen falta slots y prioridad para la cuota de suscripción, pero no formula ninguna propuesta arquitectónica en §4.
  
  [AFIRMACIÓN DE DOCS / INFERENCIA] En un entorno real operando sobre Claude Code bajo suscripción Anthropic Pro/Team o claves de API:
  1. El router evaluador (`Assessor`) invoca a `claude -p` con salida estructurada (`json-schema`) ante cada candidato inferido.
  2. Los workers concurrentes con sesiones vivas stream-json acumulan el historial completo de llamadas a herramientas (`tool_use`, `tool_result`, `diffs`), haciendo que los tokens de entrada crezcan de forma cuadrática en turnos sucesivos.
  3. DSH implementa una suite completa de compactación y poda para mitigar esto (`compaction-basic`, `tool-result-pruner`, `image-offload`, verificado en `mapa-harness.md:57,110`). La fab no tiene ningún mecanismo de compactación de contexto para Claude Code.
  4. Los límites de uso de la suscripción de Anthropic (ventanas de 5 horas) o límites de RPM/TPM se agotarán con rapidez si múltiples workers y el router compiten libremente, provocando errores HTTP 429 que causarán el fallo masivo de actividades en el pool.

- **Evidencia:**
  - `mapa-harness.md:57,110`: Presencia en DSH de plugins dedicados de compactación y poda de resultados de herramientas.
  - `src/agents.ts:40-62@ce84fc4`: El adaptador de `claude` no establece banderas de contención de costes como `--max-turns` o `--max-budget-usd`.
  - `design_draft.md:79-81`: Admisión del riesgo sin mitigación en el diseño.

- **Dimensión TRIZ / Catalizador Inventivo:**
  - *Contradicción técnica:* **Profundidad de contexto del agente vs. Cuota finita de tokens/llamadas de la suscripción**.
  - *Patrón de resolución:* **Dinámica** (Pattern #6) y **Amortiguación Previa** (Pattern #4).
    - Implementar un *Token Governor* en la capa de adaptación:
      - Imponer banderas estrictas en la invocación de Claude Code: `--max-turns <N>` y `--max-budget-usd <M>`.
      - Bounding de contexto: truncar o sintetizar salidas de herramientas muy voluminosas (p. ej. salidas de compilación o tests de gates) antes de reenviarlas a la sesión viva.
      - Reserva de cuota prioritaria para turnos de clarificación humana frente a tareas de exploración de fondo (siguiendo el principio de DSH en `S/cordis.patch.yml:5-11@8c32a9d`).
  - *Pasivos operacionales secundarios:* Riesgo de truncar información relevante si la política de poda es demasiado agresiva; necesidad de gestionar colas de espera con backpressure cuando se aproxime el límite de cuota.

---

### H7. [BAJA / NIT] Sobrecarga de la interfaz `TicketGateway` para la gestión de la Outbox

- **Sección del borrador:** §2 (Tabla, fila 33) y §4 (párrafo 63).
- **Problema técnico:**
  El borrador indica en la tabla de §2 que la fab ya tiene el canal de vuelta en `TicketGateway.comment` y recomienda en §4 que *«el Outbox reutilice el TicketGateway existente en vez de crear otro canal»*.
  
  [VERIFICADO EN CÓDIGO] Al revisar `src/connectors/types.ts:29-31@ce84fc4`:
  ```ts
  export interface TicketGateway {
    getIssue(key: string): Promise<TicketIssue>;
    comment(key: string, markdown: string): Promise<void>;
  }
  ```
  `TicketGateway` está diseñado como un puerto estrecho para sistemas pull basados en clave (como Jira). No soporta identificadores de hilo, acuses de entrega (`receipts`), estado de envío (`pending | sent | dropped`), ni multiplexación hacia Pull Requests o comentarios específicos de GitHub (`S/src/core/ports.ts:60-68@8c32a9d`, `S/src/app/outbox.ts:23@8c32a9d`). Forzar su reutilización directa rompería la generalidad de la Outbox del superagent.

- **Evidencia:**
  - `src/connectors/types.ts:29-31@ce84fc4`: Firma rígida de `TicketGateway`.
  - `S/src/core/ports.ts:60-68@8c32a9d`: Tipos de `OutboundMessage`, `ChannelRef` y `ReplyStatus` en Superagent.
  - `design_draft.md:33,63`: Asunción de equivalencia entre Outbox y TicketGateway.

- **Propuesta concreta:**
  Definir una interfaz formal `OutboxChannel` desacoplada de `TicketGateway`, capaz de recibir un `ChannelRef` estructurado (`{ system: 'github' | 'jira', targetId: string, threadId?: string }`) y gestionar la idempotencia mediante identificadores de entrega únicos (`receipts`).

---

## 3. Resumen de Hallazgos y Clasificación

| ID | Severidad | Rol Principal | Subtema | Problema Nuclear |
|---|---|---|---|---|
| **H1** | **Alta (Blocker)** | Design Critic / Inventive Catalyst | Ciclo de vida y Estados | `blockActivity` lleva a `'blocked'` (terminal); mapear `person/*` mata el change de forma irreversible. |
| **H2** | **Alta (Blocker)** | Design Critic / Inventive Catalyst | Concurrencia y Pool Leases | Sesión viva en pool monopoliza `worker_concurrency` o muere por `SIGKILL` de `requeueOrphans`. |
| **H3** | **Alta (Blocker)** | Design Critic | Sandbox y Seguridad | `bwrap` no aplica a Claude Code; ThreatMonitor post-hoc es ciego ante inyecciones en herramientas MCP vivas. |
| **H4** | **Media (Major)** | Design Critic / Inventive Catalyst | Arquitectura de Almacenamiento | Monolito de un solo proceso y un solo SQLite (`fabrica.db`) provocará contención severa por cerrojos exclusivos. |
| **H5** | **Media (Major)** | Design Critic | Modelo Relacional de Dominio | Triggers y Threads previos a la creación del Change quedan huérfanos sin dueño de estado ni workstream. |
| **H6** | **Media (Major)** | Design Critic / Inventive Catalyst | Economía de Tokens y Cuotas | Carencia de control de presupuestos, compactación de contexto y backpressure para la suscripción de Claude. |
| **H7** | **Baja (Nit)** | Design Critic | Interfaces de Conectores | `TicketGateway` es insuficiente para modelar los canales y acuses de la Outbox bidireccional. |

---

## 4. Veredicto

Veredicto: no listo (bloqueado por inconsistencias críticas en el ciclo de vida, contención en la arquitectura de ejecución y supuestos de seguridad no verificados en el código).

<!-- FIN -->
