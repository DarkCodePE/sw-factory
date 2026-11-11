# Revisión EGM ronda 2 — pi (codebase_details + comprehension) — foco P2

Citas: `repo/archivo:línea@sha`. Etiquetas: **[V]** verificado en código, **[D]** afirmación de documentación, **[I]** inferencia.
Alias: fab=`sw-factory@ce84fc4`; sa=`dsh-superagent-prototype@8c32a9d`; csa=`copilot-superagent@693f4db`; esf=`esf@e5567fb`; herdr=`dsh-herdr@2d74cf8`.
Alcance: P2 a fondo. P1 solo en lo que P2 prueba; P3 resumido al final.

## 0. Las cuatro pistas

| Pista | Resultado | Evidencia |
|---|---|---|
| `csa/src/core` coincide con `sa/src/core` | **Confirmada con una excepción [V].** `diff -rq` de los 15 ficheros solo difiere en `reasons.ts`: la cadena `hostRestarted` (`'Copilot Superagent restarted'` frente a `'dsh-superagent restarted'`, línea 19). | csa/src/core/reasons.ts:19@693f4db; sa/src/core/reasons.ts:19@8c32a9d |
| `vscode/src/agent-backend.ts` define `AgentBackend` | **Confirmada [V].** Es una interfaz de 6 métodos: `run`, `assess`, `steer?`, `handoff?`, `abort`, `dispose`. Solo `CopilotBackend` la implementa. | csa/vscode/src/agent-backend.ts:42-49; csa/vscode/src/copilot.ts:89@693f4db |
| `v1.0.0-rc.1.md:111` menciona «a separate superagent lane polls `superagent-esf`» | **Confirmada, pero es una nota de aislamiento, no una integración [V/D].** El texto empieza en la línea 110 y termina en la 111. Es un aviso de que hay workers antiguos sobre colas Temporal compartidas. El log de evidencia muestra que el «lane» es un segundo proceso `factory worker`. Usa la config `dsh-superagent-prototype/integration/esf/superagent-factory-safe.toml` y `task_queue = "superagent-esf"`. | esf/release/qualification/v1.0.0-rc.1.md:109-112; esf/release/qualification/evidence/v1.0.0-rc.1/logs/temporal-queue-isolation.log:14-42@e5567fb |
| `docs/sf-turn-executor.md` describe un «sf turn service» | **Imprecisa.** El título es «sf turn execution service». Es `cmd/turn-executor`, un servicio HTTP privado de un solo proceso. `sf` es un orquestador externo (workflow, workspace, conectores, permisos y aceptación) que ESF no contiene. El servicio solo da una VM Cube por turno. Tampoco es el superagent. | esf/docs/sf-turn-executor.md:1-8,18@e5567fb |

## 1. Hallazgos

### E-01 · alta · P2 — El enlace superagent↔ESF no existe en ningún repo versionado
- **Afirmación:** no hay código de integración superagent→ESF en sa ni en esf. Solo hay una config TOML local y trazas de proceso.
- **Evidencia:**
  - `git ls-files` de sa@8c32a9d no contiene ningún `integration/` ni `esf` **[V]**.
  - `grep -i esf` en sa solo da `pnpm-lock.yaml` **[V]**.
  - La ruta `/home/mitko/dev/dsh-superagent-prototype/integration/esf/superagent-factory-safe.toml` solo aparece en el log de evidencia de esf, como reconstrucción posterior a la ejecución (`temporal-queue-isolation.log:2,14`) **[V]**.
  - En esf, `superagent` aparece solo en evidencias JSON y en la nota rc.1. No hay código Go que lo cite **[V]**.
  - El run `factory-run-esf-superagent-hello-unreal-20261103T085936Z` en `component-upgrade-2026-11-03/local-stack.json:1346` prueba que alguien lanzó un run ESF con ese nombre. No prueba quién lo lanzó ni cómo **[V]**.
- **Inferencia [I]:** el «lane» es una segunda instancia de la factory ESF, con config propia y cola Temporal aislada. Pudo lanzarla el superagent o un humano, y nada versionado lo acredita.
- **Propuesta:** la página 06 y cualquier síntesis no deben afirmar «mitkox conecta superagent con ESF vía X». Quedó una `Executor` sin implementación ESF publicada. Quien diseñe la fab debe tratar la conexión como **desconocida**, no como patrón a copiar.

### E-02 · alta · P2 — La estrategia de mitkox NO es una capa común sobre arneses: es «núcleo compartido + un backend por producto»
Reconstrucción, con el nivel de certeza de cada eslabón:

1. **Núcleo conservado.** `src/core` (15 ficheros: `engine`, `intake`, `tickets`, `assignments`, `replies`, `ports`, `model`…) se copia intacto en csa. Solo cambia una cadena **[V]**. El README de csa dice «bundles the shared ticket engine from `src/core/`» **[D]** (csa/README.md, sección tras «Build and install»).
2. **Puerto de ejecución.** Se define en `Executor {start, deliver, stop}` (sa/src/core/ports.ts:59-70@8c32a9d). Es asíncrono: «each method only queues work, which reports back through the Engine's callbacks» **[V]**. `DshExecutor implements Executor` (sa/src/executor/dsh.ts:207) y usa un `ExecutorHost` con contexto Cordis, effects durables, slots y sesiones (dsh.ts:59-83) **[V]**.
3. **Reescritura por harness.** En csa no hay `Executor`. La capa propia es `AgentBackend` (agent-backend.ts:42-49), con `CopilotBackend` sobre `@github/copilot-sdk` (copilot.ts:8-11,89,125). `orchestration.ts` hace de Executor+Assessor y llama a `backend.run/assess/steer/handoff/abort` (orchestration.ts:15,142,318,478-479,513) **[V]**. Es decir, **el harness se reescribe entero** (el DshExecutor de 673 líneas pasa a ~779 líneas de `orchestration.ts` + 514 de `copilot.ts`) y el núcleo se reutiliza **[V]**.
4. **Parte del contrato es del núcleo, no del backend.** El backend recibe `AgentRun` con `ticketId`, `sessionId`, `directory`, `systemPrompt` y `tools`, más hooks `assertAuthorized`, `currentSystemPrompt` (revisión de prompt) y `onConsumed`, y una `AbortSignal` (agent-backend.ts:12-26). Los permisos del harness pasan por `onPermissionRequest` con comprobación de autoridad antes y después (copilot.ts:188-200) **[V]**.
5. **Steer idempotente.** `steer` usa `requestId`, un marcador `[Superagent input <id>]` y `getEvents` para reconciliar si el mensaje ya entró (copilot.ts:317-335) **[V]**. El contrato de «entrega de input» exige que el backend sepa responder «¿ya lo viste?».
6. **ESF.** Tiene su propia abstracción `agentharness.Harness {Name, Model, Provision, Run}` (esf/docs/adr/0003; internal/agentharness/harness.go@e5567fb), sin sesión, steer ni abort granular **[V/D]**. Va por lotes: un `Run` por tarea en una VM Cube.
7. **Servicio de turnos de ESF.** `turn-executor` es una segunda interfaz más rica: lease de 60 s renovado cada 20 s, eventos numerados con `?after=N`, permisos duraderos con `operation_digest`, checkpoint de sesión Claude, idempotencia por `execution_id` (409 en conflicto), perfiles con `profile_sha` y `turn_policy` (esf/docs/sf-turn-executor.md:36-80) **[D]**. Su cliente es **sf**, no el superagent.
8. **Herdr.** `dsh-herdr` es un observador de **solo lectura** de los journals `~/.dsh/sessions/**/session.v4.jsonl.zstd` que informa a Herdr por OSC 7501 (herdr/README.md:1-40) **[V/D]**. Ni herdr ni esf ni csa se citan entre sí (`grep -i herdr` en esf y csa: sin resultados) **[V]**. Herdr es una vista del arnés `dsh`, no un contrato de backend.

- **Conclusión [I]:** mitkox usa **tres contratos distintos**, no uno: (a) `Executor` para la política de tickets (sa), (b) `AgentBackend` para un harness con sesión viva (csa), (c) `Harness`/HTTP de turnos para sandbox por lote (esf). No hay evidencia de un contrato único que los una.
- **Propuesta:** no esperar de mitkox un «backend contract» reutilizable. Se pueden tomar los **eventos de contrato** de (b) y (c) como lista de requisitos.

### E-03 · alta · P2 — La fab ya está en la posición de ESF, no en la de csa
- **Afirmación:** `src/agents.ts` es el mismo patrón que `agentharness` de ESF: un comando por activity, sin sesión ni steer.
- **Evidencia:**
  - `AgentAdapter {name, command(prompt, {readOnly}), env?, parse?, factoryCommits?}` (fab/src/agents.ts:32-43@ce84fc4) y `runAgent` lanza `Bun.spawn` con `stdin:'ignore'`, `detached`, timeout y SIGTERM→SIGKILL tras 2 s (agents.ts:165-250) **[V]**.
  - Hay seis adaptadores: `claude`, `codex`, `agy`, `droid`, `native`, `fake` (agents.ts:~147) **[V]**.
  - ESF: un `GenericCommandHarness` parametrizado por `Spec` (ejecutable, argv fijo, flag de modelo, timeout, allowlist de entorno, transporte de prompt) y un `Registry` por nombre; «there is deliberately no arbitrary command harness» (esf/docs/adr/0003; harness.go:1-11) **[D/V]**.
- **Diferencias reales:**
  - ESF pasa el prompt por `stdin_file`, para que el texto no confiable no vaya en la línea de comandos. La fab lo pasa por argv en `claude`, `codex`, `agy` y `droid` (`claude -p prompt`, agents.ts:44-48 y los demás) **[V]**. Esa es una ventaja concreta de ESF: aislamiento y sin `ARG_MAX`.
  - ESF sustituye `{{model_args}}`. La fab fija los flags en cada adaptador.
  - ESF provisiona el binario dentro de una VM con digest fijado. La fab confina con `confineAgent` opcional (`--confine`).
- **Propuesta:** (1) mantener `AgentAdapter` como la forma de «un disparo»; (2) tomar `stdin_file` de ESF como transporte por defecto en `claude`/`codex` para que el prompt nunca vaya en argv. Es un cambio local y no requiere sesión. (3) Para sesión y steer **no** copiar ESF, sino la forma de `AgentBackend` de csa.

### E-04 · media · P2 — La «matriz de capacidades» de 06 D2 no tiene equivalente en mitkox; sus opcionales sí
- **Afirmación:** la página 06 D2 propone «matriz de capacidades por adaptador (reanudar, steer, inject, cancel, MCP, permisos duros)» (06:117). mitkox no tiene una matriz: usa **métodos opcionales** `steer?` y `handoff?` en `AgentBackend` (agent-backend.ts:45-46) y el motor consulta `this.deps.backend.steer` antes de usarla (orchestration.ts:318,478) **[V]**.
- **Valoración:** coincide en esencia con la matriz, con una forma más simple. La matriz declarativa no se prueba con el código de mitkox.
- **Propuesta:** implementar las capacidades como métodos opcionales en TypeScript (`steer?`, `resume?`) y no como un registro de capacidades. Ahorra una capa.

### E-05 · media · P2 — Lo que csa añade al contrato de backend y la página 06 no recoge
Estos contratos están en `AgentRun`/`AgentSteer`, no en `Executor`:
1. `assertAuthorized()` invocado antes **y después** de cada permiso del harness; si la autoridad del ticket terminó, se rechaza (copilot.ts:188-200) **[V]**.
2. `currentSystemPrompt()` + `onPromptApplied(revision)`: el prompt versionado se reaplica durante la sesión y se confirma la revisión aplicada (agent-backend.ts:20-21; copilot.ts:118-119) **[V]**.
3. `steer` idempotente por `requestId`, con reconciliación por eventos (copilot.ts:317-335) **[V]**.
4. `handoff(ticketId)`: el worker cede el control al operador y no se aborta (copilot.ts:352; orchestration.ts:290,363) **[V]**.
5. `abort(ticketId)` limpia tareas y llama a `session.abort()` por RPC (copilot.ts:355-367,478) **[V]**.
- **Propuesta:** si la fab añade un adaptador vivo, estos cinco son los criterios de aceptación mínimos del contrato (no solo `start/deliver/stop`). Los de ESF turn-executor (lease, `?after=N`, digest de operación) son un segundo juego, relevante para ejecución remota.

### E-06 · media · P2 — Nada en el repositorio de mitkox conecta Herdr con el ticket
- **Afirmación:** Herdr no sustituye al panel ni al bus de eventos del superagent.
- **Evidencia:** herdr/README.md describe un lector de journals de `dsh` que emite OSC 7501; no hay referencias a `Ticket`, `Mandate` ni `superagent` **[V]**. csa y esf no mencionan herdr **[V]**.
- **Propuesta:** si la fab quiere visibilidad en Herdr, el equivalente es **emitir OSC 7501 desde su propio journal de sesión**, no integrar el superagent. Es una mejora de observabilidad aparte, sin relación con admisión ni mandatos.

### E-07 · baja · P2 — Divergencia de doc: «lane» y «turn service» pueden inducir a confusión
- El término «superagent lane» (rc.1.md:110-111) y «sf turn service» (pista) se leen como componentes del sistema. Son, respectivamente, una cola Temporal y un servicio de un orquestador externo. Cualquier documento de la fab debe llamarlos así.
- **Propuesta:** en la página 06 y en las notas de procedencia, citar `esf/docs/sf-turn-executor.md:1-8` y el log de aislamiento (no el qualification .md) como fuente, con la etiqueta «docs/evidencia de proceso», no «código».

### E-08 · baja · fuera de foco — Contratos duplicados dentro de csa
- csa conserva `Executor` en el núcleo (`src/core/ports.ts`) **[V]**, pero `grep -n Executor vscode/src/*.ts` no devuelve ninguna implementación **[V]**. El puerto del núcleo queda sin implementar en csa: `orchestration.ts` cumple ese papel directamente. Quien copie el núcleo debe saber que el puerto `Executor` es el contrato de sa, no el de csa.

## 2. Tabla P2: estrategia de adaptadores

| Aspecto | fab (`src/agents.ts`) | csa (`AgentBackend`) | ESF (`Harness` + turn-executor) | sa (`DshExecutor`) |
|---|---|---|---|---|
| Unidad | un proceso por activity [V] | sesión viva por ticket [V] | un `Run` por tarea (lote) [V/D]; turno con lease/eventos [D] | sesión viva `worker-<ticket>` [V] |
| Steer | no | sí, idempotente (copilot.ts:317) | no en `Harness`; no en turn-executor (checkpoint de sesión Claude) [D] | sí, vía sesión dsh [V] |
| Abort | SIGTERM→SIGKILL por grupo (agents.ts:~210) | `abort(ticketId)` RPC (copilot.ts:355) | `cancel` con `owner_token` [D] | `stop()` (dsh.ts:357) |
| Prompt | argv | SDK | `stdin_file` por defecto [D] | sesión |
| Permisos | flags del CLI (`acceptEdits`, allowlist) | `onPermissionRequest` + `assertAuthorized` | `operation_digest`, aprobación duradera [D] | operador sin aprobación [D] (003-execution.md) |
| Sandbox | `confineAgent` opcional | ninguna (SECURITY: privilegios del operador) [D] | VM Cube por turno [D] | ninguna |
| Contrato único | sí (`AgentAdapter`) | sí | dos (Harness y HTTP) | sí (`Executor`) |

## 3. Respuesta a P2 (resumen)

- **Qué conserva mitkox:** el núcleo de tickets (`src/core`), copiado casi bit a bit, más prompts/skills adaptados [V/D].
- **Qué reescribe por harness:** el ejecutor completo. Hoy hay dos: `DshExecutor` (dsh) y `orchestration.ts`+`CopilotBackend` (Copilot SDK) [V].
- **Cómo se conecta con la factory:** no hay evidencia versionada. Solo un worker ESF aislado con config local en una cola `superagent-esf` [V/D, ver E-01]. Hay que tratarlo como desconocido.
- **Contrato de backend:** hay tres sin unificar: `Executor`, `AgentBackend`, `Harness`+HTTP de turnos.
- **Herdr:** vista de observación de journals dsh; sin papel de contrato [V].
- **Comparación con la fab:** la fab está en el nivel de ESF (un proceso por activity). Para sesión viva el modelo a imitar es `AgentBackend` de csa, con sus cinco obligaciones (E-05), no el de ESF.

## 4. Impacto en P1 y P3 (breve)

- **P1 (adaptadores de harness):** *mejorar tomando X*: pasar prompt por `stdin_file` (ESF) y no por argv (E-03). Sesión/steer/abort: *mejorar tomando X* de csa, solo para adaptadores vivos. No *reemplazar*: ESF `Harness` no es más capaz que `AgentAdapter` (`AgentAdapter` ya tiene `readOnly`, `parse` con usage y `factoryCommits`).
- **P3 sobre la página 06:** se **confirma** la dirección «puertos `Executor`/`assess` + capacidades» (D2), con la forma de métodos opcionales de csa. **Cambia** el criterio de aceptación de un adaptador vivo (E-05) y la afirmación implícita de que mitkox ya integró superagent con una factory (E-01). **Cae** cualquier cita que presente ESF o Herdr como parte de una integración existente.

## 5. Límites de esta revisión

- No leí el árbol completo de `esf/internal/turnexec` (solo la documentación `sf-turn-executor.md`): las propiedades de lease/eventos/permisos son **[D]**.
- No verifiqué el estado de la fab más allá de `src/agents.ts` ni los módulos P1 restantes.
- Las rutas `/home/mitko/...` son de otra máquina: no se pueden comprobar.

**Veredicto página 06: se mantiene la dirección (puertos y capacidades por adaptador), cambian el criterio de aceptación del adaptador vivo y las citas sobre mitkox (no existe integración superagent↔factory versionada), y cae cualquier afirmación de que ESF o Herdr formen parte de un contrato de backend.**

<!-- FIN -->
