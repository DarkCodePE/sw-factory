# Revisión EGM, ronda 2: goldfish Fable 5.2

Roles: `design_critic` y `codebase_details`, modo REVIEW. Foco: doble verificación independiente de P1, P2 y P3.
Fecha: 2026-11-10. Método: `graft map/skeleton/callers/grep` y lectura de tramos. No se lanzaron subagentes ni se editó nada fuera de este archivo.

Commits comprobados con `git rev-parse`: fab `ce84fc4`, superagent `8c32a9d`, copilot `693f4db`, esf `e5567fb`, herdr `2d74cf8`, harness `fcc0ad4`.

Marcas: **[V]** verificado en código, **[D]** afirmación de documentación, **[I]** inferencia mía.

## 0. Respuesta corta

- **P1.** La fab es más robusta que las tres alternativas en estado durable, claim con lease, sandbox y gates. Es más débil en cuatro puntos concretos: huérfanos sin tope de reintentos, worktree reutilizado sin verificar, canal de vuelta sin outbox y adaptador sin sesión. Ningún módulo se reemplaza entero salvo el canal de vuelta.
- **P2.** mitkox conserva solo el dominio (`src/core`, idéntico salvo una cadena) y reescribe todo lo demás por harness, incluida la persistencia. Los puertos del dominio no hablan con el harness: encolan efectos durables, y un segundo contrato (`AgentBackend`) los ejecuta. Con la factory hace lo contrario que la página 06: la pone **debajo** como sistema aparte, en una cola Temporal propia.
- **P3.** La página 06 **cambia**, no se rehace. Se confirma la forma (admisión delante, misma base, sesión reanudable). Cae el puerto `Executor {start, deliver, stop}` como contrato de harness, y falta la pieza central: la cola de efectos durable.

## 1. Pistas del brief

| Pista | Resultado | Evidencia |
|---|---|---|
| `copilot-superagent/src/core` coincide con el del prototipo | **Confirmada, con una excepción.** `diff -rq` da 15 archivos por lado y una sola diferencia: la cadena `hostRestarted` | [V] `copilot/src/core/reasons.ts:19@693f4db` («Copilot Superagent restarted» frente a «dsh-superagent restarted») |
| `vscode/src/agent-backend.ts` define un `AgentBackend` | **Confirmada.** `{run, assess, steer?, handoff?, abort, dispose}`; única implementación, `CopilotBackend` | [V] `copilot/vscode/src/agent-backend.ts:42-49@693f4db`, `copilot/vscode/src/copilot.ts:89@693f4db` |
| `v1.0.0-rc.1.md:111` menciona la cola `superagent-esf` | **Confirmada.** El texto está en las líneas 109-111 | [V] `esf/release/qualification/v1.0.0-rc.1.md:109-111@e5567fb` |
| `sf-turn-executor.md` describe un «sf turn service» | **Confirmada**, y hay código detrás (`internal/turnexec`) | [D] `esf/docs/sf-turn-executor.md:1-8@e5567fb`; [V] `esf/internal/turnexec/service.go:538-622@e5567fb` |

## 2. Comparación de los cinco sistemas

| Eje | fab | superagent (prototipo) | copilot-superagent | ESF | dsh-herdr |
|---|---|---|---|---|---|
| Qué es | Fábrica local de cambios, CLI | Agente proactivo sobre DSH | El mismo dominio dentro de VS Code | Factory con Temporal y microVM | Observador de solo lectura |
| Estado durable | SQLite WAL, `IMMEDIATE` y reintento por `BUSY` | SQLite (`Store implements Repositories`) | Un JSON reescrito entero por commit, con lock por PID | Historial Temporal más manifiestos en `.factory/` | Ninguno propio; lee el journal de DSH |
| Unidad de trabajo | change con activities por fases | Ticket con Assignments | Ticket (mismo core) | Run como activación de un `Change` | No aplica |
| Ejecución | Pull: claim, lease 90 s, heartbeat 30 s | Push: sesión persistente por Ticket | Push: sesión Copilot por Ticket | Activity Temporal; agente sin reintento | No aplica |
| Contrato de harness | `AgentAdapter.command()` devuelve argv; un disparo | `Executor {start, deliver, stop}` sobre DSH | `AgentBackend` con `steer` opcional | `Harness {Provision, Run}` por nombre | No aplica |
| Efectos externos | Llamada síncrona | Cola `Effects` durable y Outbox con recibos | Efectos en el mismo commit que el estado | Activities con política de reintento por clase | No aplica |
| Aislamiento | `bwrap` (confine y wrap), threatmon | Lista de comandos prohibidos en el prompt | Callback de permisos; «not an OS sandbox» | microVM por run | No aplica |
| Verificación | Gates deterministas con HEAD verificado, validadores | No tiene | No tiene | Gates por código de salida | No aplica |

Evidencia de las celdas no citadas más abajo: [V] `fab/src/store.ts:277,281-301@ce84fc4`; [V] `superagent/src/app/store.ts:51@8c32a9d`; [V] `copilot/vscode/src/state.ts:123-156,249-319@693f4db`; [D] `esf/ARCHITECTURE.md:3-6,40-53@e5567fb`; [D] `herdr/README.md:30-45@2d74cf8`; [V] `superagent/src/app/execution-environment.ts:14@8c32a9d`; [D] `copilot/vscode/README.md` («a worktree is not an OS sandbox»).

## 3. P1: robustez módulo a módulo

| Módulo | fab | Mejor alternativa | Veredicto | Evidencia |
|---|---|---|---|---|
| Modelo de estado y transiciones | Guardas SQL repartidas por método; `setChangeStatus` escribe sin comprobar el estado previo | Superagent: `Engine` como única entrada, cada comando dentro de `repo.atomic` | **Mantener** el Store. **Mejorar**: una tabla de transiciones del change comprobada en `setChangeStatus` | [V] `fab/src/store.ts:556-567@ce84fc4`; [V] `superagent/src/core/engine.ts:19-48@8c32a9d` |
| Claim, lease y huérfanos | Claim atómico con exclusión por change. Tres defectos (F-01, F-02, F-03) | ESF: el agente no se reejecuta (`MaximumAttempts: 1`); el turn service no revive leases vencidos | **Mantener**; es el único con lease multiproceso. **Mejorar tomando de ESF** el tope de reejecuciones | [V] `fab/src/store.ts:628-671,1048-1122@ce84fc4`; [V] `esf/internal/factory/workflow.go:1285-1302@e5567fb`; [D] `esf/docs/sf-turn-executor.md:69-70,119-122@e5567fb` |
| Worktrees | Si la ruta existe, la reutiliza sin comprobar nada | Copilot: `prepare`/`ticketAt` verifican rama, repositorio y marcador `.ready` | **Mejorar tomando `Worktrees.prepare` del port** | [V] `fab/src/worktrees.ts:42@ce84fc4`; [V] `copilot/vscode/src/worktree.ts:94-129,131-228@693f4db` |
| Intake e idempotencia | Idempotente para Jira (`jira_imports` y `UNIQUE(source_system, source_key)`); `addSignal` no tiene clave externa | ESF turn service: `execution_id` más huella de la petición; conflicto = 409 | **Mantener**. **Mejorar**: generalizar la clave a `(source, id externo)` antes de añadir GitHub | [V] `fab/src/connectors/links.ts:8-13@ce84fc4`, `fab/src/connectors/intake.ts:16-52@ce84fc4`, `fab/src/store.ts:428-438@ce84fc4`; [V] `esf/internal/turnexec/service.go:577-598@e5567fb` |
| Canal de vuelta, outbox y reintentos | `TicketGateway.comment` síncrono, sin recibo ni reintento | Superagent: `Outbox` más `Effects`. Copilot añade el marcador `attempted` para la caída entre el envío y el recibo | **Reemplazar por Outbox + Effects**, con el marcador del port | [V] `fab/src/connectors/types.ts:27-31@ce84fc4`; [V] `superagent/src/app/outbox.ts:22-52@8c32a9d`, `superagent/src/app/effects.ts:60-66,130-146@8c32a9d`; [V] `copilot/vscode/src/outbound.ts:5-18@693f4db` |
| Permisos y sandbox | `bwrap` con `--clearenv` y lista de variables; threatmon posterior; rutas protegidas | ESF: microVM por run y prompt por archivo en stdin | **Mantener**; supera al superagent y al port. **Mejorar tomando de ESF** el transporte del prompt (F-05) | [V] `fab/src/sandbox/confine.ts:21-23,70-77@ce84fc4`, `fab/src/pool.ts:244-278@ce84fc4`; [V] `esf/internal/agentharness/harness.go:32-43@e5567fb` |
| Adaptadores, sesión, steer y abort | Un disparo: argv, `stdin: 'ignore'`, abort por SIGTERM y SIGKILL al grupo. La sesión viva existe en otra capa que el pool no usa (F-04) | Copilot: `AgentBackend` con `steer` idempotente por `requestId` y sesión con dueño comprobado | **Mantener** `AgentAdapter` para fases de un disparo. **Añadir** un contrato vivo con la forma de `AgentBackend` | [V] `fab/src/agents.ts:32-40,179,196-214@ce84fc4`; [V] `copilot/vscode/src/copilot.ts:152-163,317-346@693f4db` |
| Prompts y política versionados | Huella del perfil y sha de fab por activity | ESF: `profile_sha` congelado, y la petición se rechaza si el perfil cambió | **Mantener**. Para la Policy de admisión, tomar `policyVersion` y `revalidate` del core | [V] `fab/src/store.ts:1034-1038@ce84fc4`, `fab/src/pool.ts:131-132@ce84fc4`; [V] `esf/internal/turnexec/service.go:557-560@e5567fb`; [V] `superagent/src/core/ports.ts:16-27@8c32a9d` |
| Eventos y auditoría | Tabla `events` con texto libre y actor; evidencia en archivos atómicos | Superagent: `DomainEvents` tipados. ESF: eventos numerados y reproducibles con `?after=N` | **Mantener** la evidencia. **Mejorar**: columna `kind` con tipo cerrado; el `id` autoincremental ya sirve de cursor | [V] `fab/src/store.ts:160-162,1198-1206@ce84fc4`; [V] `superagent/src/core/ports.ts:86-103@8c32a9d`; [D] `esf/docs/sf-turn-executor.md:65-66@e5567fb` |
| Reanudación tras caída | El lease vence, la activity vuelve a `pending` y el agente arranca de cero en el mismo worktree | Superagent: `resume()` interrumpe, conserva el inbox y sigue la misma sesión | **Mantener** para un disparo. **Para la sesión viva, tomar la regla del superagent**: interrumpir y reanudar por id, no reejecutar | [V] `fab/src/store.ts:1096-1104@ce84fc4`; [V] `superagent/src/executor/dsh.ts:524-537@8c32a9d` |
| Verificación y gates | Gates deterministas con HEAD verificado, worktree limpio, integridad de rutas protegidas y `VERDICT` obligatorio | ESF: equivalente, y además reintenta la verificación tres veces | **Mantener**; a la par de ESF y muy por encima del superagent. Opcional: un reintento del gate ante tests inestables | [V] `fab/src/pool.ts:135-186,295-313@ce84fc4`, `fab/src/store.ts:822-826@ce84fc4`; [V] `esf/internal/factory/workflow.go:1304-1316@e5567fb` |

Límite de esta tabla: no leí las guardas internas de `superagent/src/core/tickets.ts`. La fila de estado compara la estructura (una entrada transaccional frente a guardas repartidas), no cada transición.

## 4. Hallazgos

### F-01 · alta · P1 · Un huérfano se reencola sin límite
- **Afirmación.** `requeueOrphans` devuelve la activity a `pending` sin tocar `retry_count`. Una activity que tumba el pool cada vez se reintenta indefinidamente. `failActivity` sí cuenta y corta en 3.
- **Evidencia.** [V] `fab/src/store.ts:1100@ce84fc4` (el `UPDATE` no incluye `retry_count`), frente a `fab/src/store.ts:917-923@ce84fc4` y `fab/src/enums.ts:78@ce84fc4`. ESF fija lo contrario para el agente: [V] `esf/internal/factory/workflow.go:1285-1299@e5567fb`.
- **Por qué importa ahora.** Hoy el pool corre en primer plano y una persona lo ve fallar. El comando residente de la página 06 lo deja sin supervisión.
- **Propuesta.** Incrementar `retry_count` en `requeueOrphans` y pasar a `failed` al llegar a `MAX_ACTIVITY_RETRIES`. Es una línea en el `UPDATE` más la rama de fallo.

### F-02 · media · P1 · El lease no tiene token de exclusión
- **Afirmación.** El `workerId` es `w<slot>-<pid>` y el slot rota en módulo. Un mismo pool puede volver a reclamar una activity con el mismo `workerId` que tenía antes de que venciera el lease. Todas las escrituras se protegen solo con `worker_id = ?`.
- **Evidencia.** [V] `fab/src/pool.ts:414@ce84fc4`; [V] `fab/src/store.ts:814-819,1125-1135@ce84fc4`.
- **Escenario.** [I] El portátil se suspende más de 90 s. Al despertar, el bucle llama a `requeueOrphans` (`fab/src/pool.ts:393@ce84fc4`), ve el lease vencido, mata al agente vivo y reencola. La corrutina anterior sigue en memoria con un `workerId` que puede coincidir con el nuevo claim. No lo reproduje.
- **Propuesta.** Añadir un UUID por claim al `workerId`. No hace falta columna nueva.

### F-03 · media · P1 · Se mata por pgid sin comprobar que el proceso sea el agente
- **Afirmación.** `requeueOrphans` envía `SIGKILL` al grupo `agent_pgid` guardado. Si el agente murió y el sistema reutilizó ese pid, se mata un grupo ajeno.
- **Evidencia.** [V] `fab/src/store.ts:1073-1086@ce84fc4`. El propio código lo marca como atajo, pero solo por la suposición de misma máquina. El port sí distingue dueño muerto de dueño no verificable: [V] `copilot/vscode/src/state.ts:136-146@693f4db`.
- **Propuesta.** Guardar junto al pgid la hora de arranque del proceso (`/proc/<pid>/stat`) y compararla antes de matar.

### F-04 · alta · P1 y P3 · La sesión viva de `native` no está en el camino del pool
- **Afirmación.** La página 06 dice que la sesión viva y el MCP «ya existen en `native`». Existen en la capa RPC y SDK. El adaptador `native` que usa el pool lanza `fab exec` de un disparo, con stdin cerrado.
- **Evidencia.** [V] `fab/src/agent/rpc.ts:315-349@ce84fc4` (la sesión); [V] `fab/src/agents.ts:134-143,179@ce84fc4` (lo que ejecuta el pool); [V] `fab/src/pool.ts:217-225@ce84fc4`. Afecta a `06-integracion-superagent-fab.md:52,57,146`.
- **Consecuencia.** La fase 2 no es «añadir steer». Es un segundo camino de ejecución en el pool, con su propio contrato. La recomendación «`native` primero porque ya tiene casi todo» subestima el coste.
- **Propuesta.** Corregir §2 y §6: «la sesión existe en `src/agent/rpc.ts` y `src/sdk/session.ts`; el pool no la usa». Presupuestar la fase 2 como contrato nuevo (F-07).

### F-05 · media · P1 · El prompt viaja en argv
- **Afirmación.** Todos los adaptadores pasan el prompt como argumento. El prompt incluye el cuerpo de la HU y el historial.
- **Evidencia.** [V] `fab/src/agents.ts:44-48,104-113@ce84fc4`. ESF usa por defecto un archivo redirigido a stdin y explica el motivo: [V] `esf/internal/agentharness/harness.go:35-43@e5567fb`.
- **Riesgo.** [I] Linux limita un argumento a unos 128 KiB; un historial largo falla al lanzar, y ese fallo consume un reintento. Además el texto no confiable queda visible en la lista de procesos.
- **Propuesta.** Añadir a `AgentAdapter` un modo de prompt por stdin para los CLI que lo admiten.

### F-06 · media · P1 · Un worktree existente se da por bueno
- **Afirmación.** `ensureWorktree` devuelve la ruta si existe. No comprueba que sea un worktree del repositorio, que esté en la rama `fab/<id>` ni que su creación terminara.
- **Evidencia.** [V] `fab/src/worktrees.ts:42@ce84fc4`. El port comprueba las tres cosas y además neutraliza los filtros `smudge`: [V] `copilot/vscode/src/worktree.ts:105-127,188-226@693f4db`.
- **Riesgo.** [I] Una caída a mitad de `git worktree add`, o un agente que cambia de rama, dejan un directorio que la siguiente activity usa como válido. El gate lo detectaría tarde (`GATE_HEAD_CHANGED`), tras gastar una ejecución del agente.
- **Propuesta.** Portar las comprobaciones de `ticketAt` (rama, `git-common-dir`, marcador). Los filtros son de prioridad baja: los define la configuración local, no el repositorio.

### F-07 · alta · P2 y P3 · El puerto `Executor` no es el contrato de harness
- **Afirmación.** La decisión D2 propone `Executor {start, deliver, stop}` como puerto agnóstico de harness. En el port de mitkox ese puerto no toca el harness: cada método **encola un efecto durable** en el mismo commit que el estado. El harness se alcanza por un segundo contrato, `AgentBackend`.
- **Evidencia.** [V] `copilot/vscode/src/runtime.ts:65-73@693f4db` (`start`, `deliver` y `stop` solo llaman a `repo.enqueue`); [V] `copilot/vscode/src/state.ts:8-25@693f4db` (`PendingEffect` con `attempts` y `nextAttemptAt`); [V] `copilot/vscode/src/agent-backend.ts:42-49@693f4db`. `graft callers Executor` no da ninguna clase que lo implemente en el port. El prototipo sigue el mismo patrón con su cola: [V] `superagent/src/app/effects.ts:42-66@8c32a9d`, `superagent/src/core/ports.ts:55-69@8c32a9d`.
- **Propuesta.** Sustituir D2 por dos niveles. (1) El dominio encola efectos (`launch`, `deliver`, `stop`, `reply`) en una tabla de `fabrica.db`. (2) Un contrato vivo `{run, steer?, abort}` por harness, donde un método opcional ausente **es** la matriz de capacidades. `assess` va aparte.

### F-08 · alta · P3 · Falta la cola de efectos en la página 06
- **Afirmación.** §3 lista Outbox con recibos, pero no la cola de efectos. En los dos sistemas de referencia el Outbox es solo un caso de esa cola, que también cubre el lanzamiento, la entrega de inputs y la parada.
- **Evidencia.** [V] `superagent/src/app/effects.ts:11-24@8c32a9d` (seis clases de efecto); [V] `superagent/src/app/outbox.ts:24,31@8c32a9d` (el Outbox registra un manejador `reply` y encola dentro de `atomic`).
- **Consecuencia.** Sin ella, la secuencia de §4.1 tiene un hueco: si el proceso muere entre «transición awaiting» y «reencola con el comentario», el comentario se pierde.
- **Propuesta.** Añadir a §3 y a la fase 1 una tabla `effects (kind, key, payload, attempts, due)` con clave única `(kind, key)`, escrita en la misma transacción que el estado. El comando residente pasa a ser su bucle de despacho.

### F-09 · media · P2 · La integración superagent ↔ ESF no está en ningún repo entregado
- **Afirmación.** Solo hay rastros en la evidencia de release de ESF. No se puede leer el código de esa integración.
- **Evidencia.** [V] `esf/release/qualification/evidence/v1.0.0-rc.1/logs/temporal-queue-isolation.log:14@e5567fb`: un proceso `factory --config …/dsh-superagent-prototype/integration/esf/superagent-factory-safe.toml worker`. [V] El directorio `integration/` no existe en `superagent@8c32a9d`. [V] `esf/release/qualification/evidence/component-upgrade-2026-11-03/local-stack.json:1346@e5567fb`: un workflow `factory-run-esf-superagent-hello-unreal-…` completado. Ese log es una reconstrucción posterior, según su propia nota.
- **Consecuencia.** Lo que sigue en §5.3 es inferencia. Tampoco se puede identificar «sf», el cliente del turn service: ningún repo lo contiene.
- **Propuesta.** Marcar en el ADR esta parte como no verificable, y no citarla como precedente.

### F-10 · media · P3 · «Capa externa encima» se descarta sin decir que el autor de referencia la eligió
- **Afirmación.** §4 descarta una capa externa porque crea «dos dueños del estado». Es justo lo que hace mitkox con ESF: el superagent lanza runs en una factory aparte, con su propio estado.
- **Evidencia.** F-09, más [D] `esf/ARCHITECTURE.md:12-16@e5567fb` (la factory solo acepta repositorio aprobado, revisión exacta y texto de tarea).
- **Juicio.** El descarte sigue siendo correcto para la fab: es local, tiene una sola base y no hay microVM ni Temporal que justifiquen la frontera. Falta el argumento.
- **Propuesta.** Añadir una frase a §4: la separación de mitkox responde a que ESF es remoto y el superagent no; en la fab ambos comparten proceso y disco.

### F-11 · baja · P1 · `importIssue` abre la transacción sin `withRetry`
- **Afirmación.** La página 06 dice que la contención «ya se gestiona». `importIssue` usa `store.db.transaction(...)()` directo, diferida y sin reintento.
- **Evidencia.** [V] `fab/src/connectors/intake.ts:40-52@ce84fc4`, frente a `fab/src/store.ts:281-301@ce84fc4`.
- **Propuesta.** Envolverla en `store.withRetry`. Importa cuando un proceso residente escriba a la vez que el pool.

### F-12 · baja · P3 · `native` no entra en `--confine`
- **Afirmación.** `assertConfinement` solo admite `claude`, `codex`, `fake` y `simulated`. La tabla de decisiones dice que `native` «ya tiene sandbox».
- **Evidencia.** [V] `fab/src/sandbox/confine.ts:8@ce84fc4`. Existe otro sandbox con `--unshare-net` en `fab/src/sandbox/wrap.ts:112@ce84fc4`; no verifiqué que `native` lo use en el pool.
- **Propuesta.** Citar en §6 qué sandbox aplica a `native` y con qué línea.

## 5. P2: la estrategia de mitkox

### 5.1 Qué conserva y qué reescribe
- **Conserva el dominio.** `src/core` (15 archivos, 2088 líneas) se copia tal cual: Engine, modelo y puertos. [V] ver §1.
- **Reescribe todo lo demás.** `diff -rq` marca como exclusivos del prototipo `app`, `executor`, `sources`, `infra`, `policy.ts`, `kv.ts` y `deployment.ts`. El port los rehace en `vscode/src`: `state.ts`, `runtime.ts`, `sources.ts`, `delivery.ts`, `orchestration.ts`, `worktree.ts` y `copilot.ts`. [V]
- **También reescribe la persistencia.** El prototipo usa SQLite; el port, un JSON con lock. Ambos cumplen `Repositories`. [V] `superagent/src/app/store.ts:51@8c32a9d`, `copilot/vscode/src/state.ts:159@693f4db`.
- **Lectura.** [I] Lo portable es el contrato transaccional del dominio (`atomic` síncrono más puertos que solo encolan). Los adaptadores y el almacén no se comparten entre harnesses.

### 5.2 Tres contratos para tres granos de ejecución

| Grano | Contrato | Dónde | Propiedades |
|---|---|---|---|
| Un run completo | `Harness {Name, Model, Provision, Run}` | ESF | Se elige por nombre en un registro; el llamante nunca pasa un ejecutable. [V] `esf/internal/agentharness/harness.go:131-143,159-199@e5567fb` |
| Un turno con checkpoint | API privada del turn service | ESF | `execution_id` idempotente, token de dueño, lease de 60 s, eventos reproducibles, permisos atados a una huella de operación. [V] `esf/internal/turnexec/service.go:150,577-598@e5567fb`; [D] `esf/docs/sf-turn-executor.md:57-76@e5567fb` |
| Sesión viva | `AgentBackend` | copilot-superagent | `steer` idempotente por `requestId`, reconciliado contra el historial de la sesión. [V] `copilot/vscode/src/copilot.ts:321-335@693f4db` |

ESF descartó conducir agentes por protocolo (ACP o MCP) por no encontrar una superficie no interactiva estable: [D] `esf/docs/adr/0003-agent-harness-abstraction.md:79@e5567fb`.

### 5.3 Cómo conecta superagent, factory y Herdr
- **Superagent → factory.** [I, sobre F-09] El superagent actúa como cliente de ESF. Un worker de factory dedicado atiende la cola Temporal `superagent-esf` con una configuración «safe». La factory conserva su estado y su verificación.
- **Herdr.** Solo observa. `dsh-herdr` lee el journal de sesiones de DSH y emite estado por OSC 7501; no hay camino de control. [D] `herdr/README.md:30-45@2d74cf8`; [V] `herdr/bin/dsh-herdr:8-10@2d74cf8`.
- **DSH.** El harness ofrece `followup`, `steer` e `inject` con semántica distinta por frontera de turno y de paso. [V] `harness/packages/core/agent/src/runtime-types.ts:244-270@fcc0ad4`. El prototipo los usa con un id de mensaje estable para no duplicar: [V] `superagent/src/app/delivery.ts:66-85@8c32a9d`.

### 5.4 Frente a `src/agents.ts`
- `AgentAdapter` equivale al `Harness` de ESF: configuración de argv por agente, un disparo. [V] `fab/src/agents.ts:32-40@ce84fc4`.
- Le faltan dos cosas que ESF tiene: prompt por stdin (F-05) y versión del ejecutable como evidencia (`Versioner`, `esf/internal/agentharness/harness.go:145-150@e5567fb`). La fab cubre lo segundo por otra vía, con `verifyAgentStart`: [V] `fab/src/pool.ts:362-366@ce84fc4`.
- No tiene equivalente de `AgentBackend`. Ese es el hueco real, no el puerto `Executor`.

## 6. P3: arquitectura recomendada y efecto sobre la página 06

**Arquitectura.** Admisión delante de la fab, en `fabrica.db`, con el dominio del superagent como referencia de diseño. El dominio encola efectos durables; un comando residente con lock exclusivo los despacha. El pool y `AgentAdapter` siguen para las fases de un disparo. La sesión viva entra por un contrato nuevo con la forma de `AgentBackend`. Herdr queda fuera del camino de control.

| Parte de la página 06 | Resultado | Motivo |
|---|---|---|
| §1 dos sistemas con un solo punto de unión | **Se confirma** | Coincide con la frontera del core |
| §2 tabla de equivalencias y citas | **Se confirma.** Comprobé las siete citas de `store.ts`, `intake.ts`, `types.ts`, `rpc.ts`, `mcp-server.ts`, `cli.ts` y `confine.ts` | Todas apuntan a la línea correcta |
| §2 «la sesión viva ya existe en `native`» | **Cambia** | F-04 |
| §3 lista de lo que falta | **Cambia**: añadir la cola de efectos | F-08 |
| §4 misma base, tablas propias, unión por `addSignal` y `triageSignal` | **Se confirma** | El port demuestra que el dominio vive bien sobre otro almacén |
| §4 descarte de la capa externa | **Se mantiene, con argumento nuevo** | F-10 |
| §4.1 sesión reanudable por id | **Se confirma** | Es la regla de `resume()` del prototipo |
| D2 `Executor {start, deliver, stop}` como puerto de harness | **Cae** | F-07 |
| D2 matriz de capacidades | **Cambia**: métodos opcionales del contrato vivo | F-07 |
| D3 una sola tool `report` | **Se confirma** | El port expone lo mismo: `copilot/vscode/src/runtime.ts:195-201@693f4db` [V] |
| D5 gate duro por adaptador | **Se confirma**; tomar el callback de permisos del port como modelo | `copilot/vscode/src/permissions.ts:5-21@693f4db` [V] |
| §6 fase 1 | **Cambia**: precederla de F-01, F-02 y F-06 | Un proceso residente convierte esos defectos en fallos sin testigo |
| §6 «`native` primero» | **Cambia**: el coste está subestimado | F-04, F-12 |
| §6 misma base de datos | **Se confirma**, con F-11 | |

**Orden propuesto.** (0) Endurecer: F-01, F-02, F-06, F-11. (1) Tabla de efectos, comando residente con lock y admisión en `observe`. (2) Contrato vivo y primer adaptador. (3) Router y Outbox sobre la cola de efectos.

## 7. Lo que no verifiqué
- Las guardas de transición dentro de `superagent/src/core/tickets.ts`.
- `copilot/vscode/src/orchestration.ts` (57 KB): cómo se drenan los efectos y con qué reintentos. Solo leí cómo se encolan.
- Que `native` use `src/sandbox/wrap.ts` en el pool.
- Los escenarios de F-02, F-03, F-05 y F-06: son inferencias a partir del código, sin reproducción.
- El código de la integración superagent ↔ ESF y la identidad de «sf» (F-09).
- `fab/src/profile.ts` y `fab/src/prompts.ts`; la fila de prompts se apoya solo en el registro de la huella.

**Veredicto sobre la página 06: cambia.** Se mantiene la forma; se sustituye D2, se añade la cola de efectos y se antepone una fase de endurecimiento.

<!-- FIN -->
