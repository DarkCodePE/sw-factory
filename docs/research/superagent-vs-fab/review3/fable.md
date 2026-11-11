# Ronda 3 · doble check arquitectónico del diseño 06 (Fable 5.2, goldfish)

Revisor sin contexto previo, solo lectura. Roles EGM: `design_critic` + `zoom_out` + `codebase_details`, modo REVIEW.

- **Diseño:** `techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md` v0.4 (citado como `06:Lnn`).
- **Código fab:** worktree `sw-factory-docsint`, HEAD `3f9b904`. `git diff origin/release/0.1.0-rc.12 -- src` es vacío: el código leído es el de rc.12 (`9dbb175`). Citado como `src/...`.
- **Espigas:** `live-claude:` = `sw-factory-live-claude` (`aa9999e`), `live-native:` = `sw-factory-live-native` (`8ad7e55`).
- **Referencias:** `sa:` = `dsh-superagent-prototype` (`8c32a9d`), `cp:` = `ext/copilot-superagent` (`693f4db`), `esf:` = `ext/esf` (`e5567fb`).
- **[V]** = leído en código. **[I]** = inferido, sin leer o sin reproducir.

## Veredicto

**Sí con cambios.** La forma general aguanta: admisión delante, misma base, cola de efectos, «vivo = reanudable por id», turno a turno sin steer. Las fases 0 y 1 están bien hechas y la espiga del contrato es más simple que lo que el documento promete, lo cual es bueno.

No se debe empezar a escribir la fase 2 sin cerrar antes seis decisiones que el documento no toma y que el código no resuelve por sí solo:

1. Dónde vive el `sessionId` y qué pasa cuando la sesión se pierde (H-02, H-03).
2. Quién aplica el `report` y cómo sobrevive a una caída (H-01).
3. Quién lanza el turno: el pool o el residente. El documento dice las dos cosas (H-09).
4. Quién puede responder en un hilo y a qué contenido queda atada la admisión (H-05, H-06).
5. Qué puede publicar el Outbox (H-07).
6. Qué adaptador puede ejecutar trabajo que entra por un canal: `native` no es confinable (H-17).

Ninguna obliga a rehacer lo construido. Todas son aditivas.

---

## 1. Threads

| | Identidad del hilo | Identidad y dedupe del evento | Cómo entra la respuesta humana |
|---|---|---|---|
| **fab** | `github:<owner/repo>#<n>` (`src/admission/resident.ts:42`), tabla `adm_threads(id, source, first_seen)` (`src/admission/db.ts:21`) [V] | Clave `<thread>@<updated_at>`; `INSERT OR IGNORE` sobre PK (`resident.ts:42-46`) y efecto con `key` única para siempre (`src/admission/effects.ts:24`) [V] | No entra. El poller solo lee `repos/…/issues` (`src/admission/github.ts:18`), no comentarios. El evento guarda metadatos del issue, no del comentario, y no guarda texto ni actor del evento (`resident.ts:44-46`) [V] |
| **superagent** | `ThreadRef {source, id}`, clave `source:id` (`sa:src/core/model.ts:7,12`). Un Trigger pertenece a varios hilos; el primero aloja el Eval (`model.ts:26-27`) [V] | Id determinista por comentario: `key('github-comment', url, comment.id, updated_at)`; el issue es `key('github-issue', n)` (`sa:src/sources/github-trigger.ts:66-68,84`). `Engine.receive` lo guarda una vez (`sa:src/core/engine.ts:43-48`) [V] | Fan-out a los tickets suscritos al hilo (`model.ts:163-164`), `followupOwners` decide qué ticket lo atiende (`model.ts:68-75`), y la pregunta lleva el `triggerId` al que volver (`Attention`, `model.ts:274-275`). El canal de respuesta sale del Trigger (`github-trigger.ts:72`) [V] |
| **copilot** | El mismo core: importa `../../src/core` (`cp:vscode/src/orchestration.ts:3`, `agent-backend.ts:1`) [V] | Igual que el core [I: no leí `sources.ts`] | Igual; el gate local solo admite al operador de VS Code (`cp:vscode/src/runtime.ts:42-44`) [V] |
| **ESF** | No tiene hilos | `execution_id` + huella + dueño: repetir devuelve el estado anterior, y una huella distinta da 409 (`esf:internal/turnexec/service.go:592-598`) [V] | No aplica |

**¿Aguanta el modelo de la fab?** La tabla `adm_threads` sí; el formato `source:id` con el repo dentro es correcto y sirve para varios canales. `adm_triggers` no, pero se amplía, no se rehace. Faltan cuatro cosas:

- **El evento es una foto del issue, no un mensaje.** La clave por `updated_at` funde en uno todo lo que pase en el mismo segundo o entre dos polls. Vale para «el estado cambió», no para «alguien dijo algo». Para la respuesta hace falta un Trigger por comentario, con el id del comentario como identidad (H-06).
- **Sin actor.** Un comentario de cualquiera sube `updated_at` [I: comportamiento de la API de GitHub, no probado] y crea un trigger con los metadatos del **autor del issue**, no de quien comenta (`resident.ts:44-46`) [V].
- **Sin vínculo hilo → change.** Nada une `adm_threads` con un change (`db.ts:21`); `ExternalRef.system` sigue siendo solo `'jira'` (`src/connectors/types.ts:7`, `src/connectors/links.ts:48`) [V]. En modo `auto`, cada trigger nuevo del mismo hilo volvería a admitir.
- **Varios hilos para un change.** El PR que abre la fab es otro hilo del mismo trabajo; el superagent lo resuelve con `bindThread`/`follows` (`sa:src/core/engine.ts:54`, `model.ts:297`). En la fab basta una relación N hilos → 1 change.

---

## 2. Sesiones

| | Identidad de la sesión | Tras una caída | Sesión perdida |
|---|---|---|---|
| **superagent** | Derivada, no guardada: `worker-<ticketId>` (`sa:src/executor/dsh.ts:24`). Una por Ticket, no por Assignment [V] | `resume()`: cancela lo que corría, avisa al Engine (`assignmentInterrupted`) y relanza los pendientes (`dsh.ts:524-536`). Reintento transitorio con un mensaje «continúa donde lo dejaste» (`dsh.ts:557`) [V] | La recrea (`dsh.ts:313-316`) y comprueba con `holds(sessionId, requestId)` si aún contiene el encargo; si no, reenvía el brief completo (`dsh.ts:449-464`). La entrega es idempotente por `requestId` (`sa:src/app/sessions.ts:156-162`) [V] |
| **copilot** | Id estable por ticket, validado (`cp:vscode/src/copilot.ts:152`) [V] | Efectos `running` → `pending`, sesiones `working` → `interrupted` (`cp:vscode/src/orchestration.ts:109-110`). `InputAdmissionUncertain` no se reintenta (`orchestration.ts:726`). Sin automatización: informa `blocked` y exige reintento explícito (`runtime.ts:94-98`) [V] | Busca la sesión; si existe, `resumeSession`, si no, `createSession` con el mismo id (`copilot.ts:162,210-211`). Directorio distinto o identidad devuelta distinta: error (`copilot.ts:163,214`). «Un error del proveedor nunca se convierte en sesión nueva» (`copilot.ts:160`). El prompt se reconstruye desde el estado durable (`orchestration.ts:506`) [V] |
| **ESF** | `execution_id` idempotente por turno. El id de sesión del harness viaja **dentro del checkpoint** (`esf:internal/turnexec/types.go:55-58`, `runner.go:304-305,383-384`) y se pasa con `--resume` (`runner.go:161-162`) [V] | El agente no se reintenta: `MaximumAttempts: 1` (`esf:internal/factory/workflow.go:1285-1300`) [V] | No leído [I] |
| **fab (rc.12)** | No existe. `activities` no tiene columna de sesión (`src/store.ts:152-158`, migraciones `307-322`) [V] | Huérfano → `recordActivityFailure` → `pending` y se reejecuta el agente, hasta 3 veces (`store.ts:1102-1103,923-932`, `src/enums.ts:78`) [V] | No aplica |
| **fab (espigas)** | La genera la fab antes de lanzar (`live-claude:src/live/claude.ts:28`, `live-native:src/live/native.ts:41`) y solo vuelve en el resultado, en memoria (`claude.ts:55`) [V] | Nada: el contrato no persiste | `SessionNotFoundError` (`live/contract.ts:48`): `claude` por el texto «No conversation found» (`claude.ts:9,51,54`); `native` por `ENOENT` o cwd distinto (`native.ts:42-50`) [V] |

**¿Dónde vive el `sessionId` en la fab?** En ningún sitio durable. No sobrevive a la caída del pool, ni a `requeueOrphans`, ni al cambio de worker. Además:

- `failActivity` conserva el id de la activity (`store.ts:927-932`), pero `retryChange` crea una activity nueva (`store.ts:1030`). Una sesión atada a la activity se pierde en cada reintento humano [V].
- La sesión viva que ya existe (`load_session`, `src/sdk/session.ts:144-155`) sigue fuera del camino del pool: `native` lanza `fab exec` de un disparo (`src/agents.ts:145-155`) [V].

**Pérdida de la sesión.** Causas comprobadas o documentadas por las espigas:

- Bajo `--confine`, el HOME es un tmpfs por turno y el transcript desaparece; hay que montar `FAB_CLAUDE_SESSIONS_DIR` (informe `live/claude.md`) [V en el informe, no reproducido por mí].
- El directorio de sesión de `claude` se deriva del cwd, y `native` rechaza un cwd distinto (`native.ts:46`): si se recrea o mueve el worktree, la sesión no se reanuda [V/I].
- Caducidad de transcripts en `claude` y reanudar con otro modelo: **no verificado**. `LiveTurn` no tiene campo de modelo (`live/contract.ts:14-27`) [V].

**¿Trata el diseño «sesión irrecuperable»?** No. `06` §5.1 y §6 no la mencionan. El contrato define el error, pero ninguna transición dice qué hace la fab con él. Ver H-03.

---

## 3. Ejecutores (D2)

| | Frontera | Quién reintenta |
|---|---|---|
| **copilot** | `Executor {start, deliver, stop}` solo encola (`cp:vscode/src/runtime.ts:65-73`); `AgentBackend {run, assess, steer?, handoff?, abort, dispose}` toca el harness (`agent-backend.ts:42-49`) [V] | La cola de efectos, con tope y espera; lo incierto no se reintenta (`orchestration.ts:726-731`) [V] |
| **ESF** | `Harness {Name, Model, Provision, Run}` (`esf:internal/agentharness/harness.go:132-143`) [V] | Infraestructura: 5 intentos. Agente: 1 (`workflow.go:1273-1300`) [V] |
| **superagent** | Efectos por tipo, con límite de concurrencia, orden y `Later` (`sa:src/app/effects.ts:26-36,138-139`) [V] | La cola, sin tope: reintenta con espera para siempre y avisa por salud (`effects.ts:141-159`) [V] |
| **fab (06, D2)** | Efectos durables + contrato vivo de seis métodos (`06:L155`) | Sin definir |
| **fab (espiga)** | `LiveBackend {name, confinable, run, steer?}`; abortar es `turn.signal` (`live/contract.ts:38-45,22`) [V] | Sin definir; `runAgent` no reintenta [V] |

**¿Es la frontera correcta?** Los dos niveles sí. La lista de métodos de D2 no: la espiga ya demostró que con «un proceso por turno, reanudable por id» sobran cuatro de los seis. `assess` es el router (fase 3), `handoff` y `dispose` solo tienen sentido con un proceso retenido, y `abort` ya es la señal. **Hay que actualizar D2 a lo que dice `contract.ts`, no al revés** (H-10). Lo mismo con D4: `assertAuthorized`, prompt versionado y `steer` idempotente no están en el contrato y no hacen falta sin steer.

**¿Cuadra con las espigas?** El contrato es idéntico en las dos ramas (`diff` vacío) [V]. Tres desajustes con el diseño:

- **El `report` no es durable.** Los dos backends lo acumulan en un array en memoria (`claude.ts:29,37`; `native.ts:53,22`). El diseño dice que el `report` escribe en el Store durante el turno (`06:L141-142`). Ver H-01.
- **Dos canales de estado.** El turno vivo de `native` devolvió `status: missing` con `reports` válidos (informe `live/native.md`), y el pool falla una activity con `missing` (`src/pool.ts:305-309`). D3 dice «alineada con `STATUS:`» sin decir cuál manda, ni qué pasa con varios reports en un turno (H-11).
- **Token MCP por turno, no por activity** (`claude.ts:30,57`), y en `claude` viaja en argv dentro de `--mcp-config` (`claude.ts:15`), visible en la lista de procesos. `native` lo pasa por archivo `0600` (`native.ts:60-62`) [V].

**Regla de ESF.** La fab hace hoy lo contrario: un huérfano o un fallo vuelven a `pending` y el agente se reejecuta solo (`store.ts:923-932,1102-1103`). Para un disparo es tolerable. Para una sesión es peligroso: reejecutar reenvía el prompt a una sesión que quizá ya terminó el turno (H-04). El estado «resultado desconocido» existe solo en `adm_effects` (`db.ts:12`, `effects.ts:35`); las activities no lo tienen, aunque `06:L79` y `06:L167` lo prometen [V].

**Lease de 90 s y turno largo.** La premisa del brief no se cumple en el código: el lease **no** mata un turno largo. El latido es un temporizador del proceso del pool, independiente del agente (`pool.ts:108-117`), y renueva cada 30 s (`store.ts:40-41`). Lo que sí mata un turno:

- El `timeoutMs` por defecto de `runAgent`, 20 minutos (`src/agents.ts:181`); el pool no pasa otro (`pool.ts:229`). ESF da 60 minutos (`workflow.go:1291`) [V].
- **Cualquier** error del latido aborta al agente, también un `SQLITE_BUSY` agotado (`pool.ts:108-115`, `store.ts:281-300`). Con un residente escribiendo en la misma base, esa ventana crece (H-13) [V el código, I la frecuencia].

Y lo que el latido no detecta: un agente colgado con el pool vivo. Solo lo corta el timeout.

**¿Quién lanza el turno?** El diagrama de §5 lo pone en el residente (`06:L124`); la secuencia de §5.1, en el pool (`06:L140,147`); la espiga dice «the pool's one-shot model is kept» (`live/contract.ts:2`). `Effects.dispatch` es serie (`effects.ts:44-48`): un efecto `launch` de 20 minutos pararía el poll y el Outbox. Debe ser el pool (H-09).

---

## 4. Tickets y workers

| superagent | fab | Nota |
|---|---|---|
| Ticket (`sa:model.ts:277`) | change | Unidad autorizada. El Ticket lleva Mandate, canales e inputs; el change, no |
| Assignment (`model.ts:218`) | Lo más parecido es **un turno** (un claim de una activity) | Una activity con conversación son varios turnos; la fab no tiene registro por turno |
| Sesión `worker-<ticketId>` | No existe (H-02) | Debe colgar del change + tipo de activity, no del claim |
| `Attention` (`model.ts:275,287`) | No existe | La pregunta abierta: una por activity |
| `inputs` / `undelivered` (`model.ts:289-291`) | No existe | La respuesta humana pendiente de entregar |
| Slots con reserva para personas (`sa:dsh.ts:305-309`) | `running.size < workerConcurrency`, por proceso de pool (`pool.ts:429`) | No es global: dos pools duplican la concurrencia [V] |
| Report `waiting` / `blocked` (`model.ts:216`) | `blocked` es terminal para el change (`store.ts:43-50,882`) | `awaiting` no existe como estado de activity |

**«Worker asignado a un ticket» en la fab** = una sesión de harness atada a (change, tipo de activity) que sobrevive entre claims. El worker en sí (`workerId`) es efímero: se genera por claim, `w<n>-<pid>-<uuid>` (`pool.ts:430`), y ya sirve de token de fencing [V].

**Cuánto vive un slot.** Lo que dura `processActivity` en memoria. Una activity que sale de `in_progress` no ocupa slot, así que `awaiting` no lo ocupa. Sí sigue ocupando el worktree y la rama.

**Reanudación.** Lo que el código exige para que `awaiting` funcione:

- **Reencola** el residente, en la misma transacción en que registra la respuesta (`06:L146`). Como la admisión no escribe en `activities` (`06:L104`), hace falta un comando nuevo del Store.
- **Fencing en tres capas**: (1) la transición `awaiting → pending` condicionada al id de la pregunta abierta, para que una respuesta duplicada o tardía no reencole dos veces; (2) el claim siguiente crea un `workerId` nuevo y todas las escrituras ya van condicionadas a él (`store.ts:817,875,928`); (3) el efecto `reply` va cercado por `attempt_id` (`effects.ts:50-53,83`) [V lo existente].
- **Puntos del Store que hoy desconocen el estado nuevo** [V]: exclusión por change en el claim (`store.ts:640-644`), barrido al cerrar un change (`store.ts:560-562`, solo cancela `pending`), `requeueOrphans` (`store.ts:1063`), `waitForRelease` (`store.ts:1143`), `inbox` (`store.ts:619-625`), salida de `--once` (`pool.ts:450-455`), `TERMINAL_ACTIVITY` (`enums.ts:59`).
- **Colisión de nombre**: `review_status = 'awaiting'` ya significa «espera revisión de spec» (`store.ts:849,961,623`) (H-12).

**Cuotas y concurrencia.**

- Las conversaciones abiertas están acotadas por el `taskLimit` del workstream, 20 changes abiertos por defecto (`store.ts:381,486-487`) [V]. No hay otro tope.
- El «slot reservado para mensajes humanos» de `06:L170` no existe en el código. **Tampoco hace falta**: el claim ordena por `created_at` (`store.ts:645`), y una activity reanudada conserva el suyo, así que pasa delante del trabajo nuevo sin reservar nada [V el orden, I la consecuencia]. Recomiendo quitar la promesa del documento en vez de construirla.
- Falta un plazo para `awaiting`: sin respuesta, la activity y su worktree quedan abiertos para siempre (H-16).

---

## 5. Threat model

Camino completo, con lo que hay hoy en cada tramo:

| Tramo | Hoy | Dónde puede escalar el texto |
|---|---|---|
| Canal → Trigger | Solo metadatos; el texto no se guarda (`resident.ts:44`) [V] | En la fase 2 habrá que traer el texto. Si se lee al admitir o al lanzar, no es el que vio quien etiquetó (H-05) |
| Gate | Función pura sobre metadatos (`src/admission/gate.ts:30-42`). El etiquetador es el actor del último `labeled` y su rol actual (`github.ts:54-72`) [V] | El gate no puede escalar. Pero decide por trigger, y el texto puede cambiar después |
| Router | No existe (fase 3) | — |
| Signal → prompt | `change.description` entra literal bajo `# Change`, sin delimitar, antes de las reglas (`src/prompts.ts:57-60`) [V] | El texto puede imitar secciones del prompt |
| Agente | `claude` permite `python3`, `cat` y `git` (`agents.ts:55-58`). `--confine` no aísla la red (`src/sandbox/confine.ts:21`, sin `--unshare-net`) y monta las credenciales de Claude en lectura (`confine.ts:62`) [V] | Leer la credencial y sacarla por red o por el propio Outbox [I: no reproducido]. Sin `--confine`, todo el HOME |
| Respuesta → Outbox | `human_action` es texto libre (`live/contract.ts:11`) | Publicar contenido arbitrario con la identidad de la fab (H-07) |

**¿Basta la verificación de la etiqueta?** Para la fase 1, sí: cubre issue forms, bots y usuarios sin rol (`github.ts:64-68`, `gate.ts:36`) [V]. Para la fase 2 no, por dos motivos:

1. **Prueba quién autorizó, no qué autorizó.** El autor de un issue puede editar título y cuerpo después de que alguien con triage lo etiquete [I: regla de GitHub]. La edición sube `updated_at`, nace un trigger nuevo, la etiqueta y el etiquetador siguen siendo válidos, y el gate vuelve a decir `would_admit` (`resident.ts:42-47`, `gate.ts:34-41`).
2. **`scope_max` no lo consume nadie.** Se calcula y se guarda (`resident.ts:67-68`), pero fuera de `src/admission` no hay ninguna lectura [V: búsqueda en `src`]. D5 dice que el gate «fija el scope máximo»; hoy solo lo anota (H-15).

**Respuesta humana en la fase 2: qué falta.**

- **Quién puede responder no está definido.** `06:L145` dice «respuesta en el hilo». En un repo público comenta cualquiera. El superagent lo resuelve en el gate: un mensaje en un hilo con tickets es admisible, pero solo es `explicit` si el remitente está en la lista (`sa:src/policy.ts:206-207`) [V].
- **No se verifica nada**, porque no se leen comentarios (`github.ts:18`).
- **La fab se dispararía a sí misma**: su propio comentario sube `updated_at` y crea otro trigger. No hay noción de «identidad del agente» en la admisión; el superagent la filtra (`sa:src/sources/github-trigger.ts:62-63`) [V].
- Propuesta mínima: reutilizar la consulta de permiso que ya existe (`github.ts:66-71`) sobre el autor del comentario; solo rol triage o superior reanuda; el comentario debe ser posterior al recibo de la pregunta; el resto se registra y se ignora.

**¿Puede el agente hacer que la fab publique contenido arbitrario?** Con el diseño tal como está, sí: nada limita `human_action`. No puede elegir el destino si se copia la regla del superagent, donde el canal sale del Trigger guardado y no del agente (`sa:src/core/replies.ts:84`) [V]. Queda el contenido: menciones, órdenes a otros bots, enlaces, y secretos leídos del entorno. El monitor de amenazas ya existe y se puede aplicar al texto saliente (`pool.ts:268-273`) [V que existe, I que sirva sin cambios].

---

## 6. Coherencia del documento

Afirmaciones que el código de rc.12 ya desmiente:

| Dónde | Dice | El código dice |
|---|---|---|
| `06:L11` | «No hay código ni ADR todavía. Queda abierta la elección del primer adaptador vivo» | `src/admission/` existe y las fases 0 y 1 están en release (`be21cce`, `9dbb175`). `06:L193` da la elección por decidida: contradicción interna |
| `06:L17` | fab en `ce84fc4` | rc.12 es `9dbb175` |
| `06:L79` | Claim: «Endurecer» | Hecho: tope vía `recordActivityFailure` (`store.ts:1103`) y token por claim (`pool.ts:430`). Sigue faltando «resultado desconocido» en activities |
| `06:L80` | «Reutiliza cualquier ruta existente (`src/worktrees.ts:42`)» | `verifyWorktree` comprueba repo, rama y estado (`src/worktrees.ts:39-60,72`); el marcador es `.preparing`, no `.ready` (`worktrees.ts:69-70`) |
| `06:L81` | Clave genérica «antes de GitHub» | GitHub ya entró por la admisión y `ExternalRef` sigue en `'jira'` (`types.ts:7`). `importIssue` ya usa `withRetry` (`src/connectors/intake.ts:40`) |
| `06:L84`, `06:L169` | «prompt por argv» | `claude`, `codex`, `droid` y `native` usan stdin (`agents.ts:46,89,114,147`). Quedan `agy` y `fake` (`agents.ts:103,136`) |
| `06:L85`, `06:L202` | `native` en `src/agents.ts:134-143` | Ahí está `fake`; `native` es `145-155`. El hecho sigue siendo cierto |
| `06:L94-97` | Faltan cola de efectos, residente y admisión | Existen en modo observe (`effects.ts`, `resident.ts`, `gate.ts`) |
| `06:L124` contra `06:L140` | Lanza el residente / lanza el pool | Ver H-09 |
| `06:L155` (D2) | Contrato de seis métodos | La espiga tiene `run` y `steer?` (`live/contract.ts:38-45`) |
| `06:L158` (D5) | «token por activity» | Por turno (`claude.ts:30,57`) |
| `06:L170` | «slot reservado para mensajes humanos» | No existe ni se necesita (§4) |
| `06:L193` | Fila de 4 celdas en una tabla de 2 columnas | La celda «Análisis previo» queda fuera de la tabla al renderizar |
| `06:L206` | «No verificado: cómo drena los efectos `orchestration.ts`» | Verificable: `running` → `pending` al arrancar (`cp:orchestration.ts:109`), lo incierto no se reintenta (`:726`) |

Citas que siguen siendo correctas: `store.ts:882`, `store.ts:276,281-301`, `confine.ts:58-64`, `agent-backend.ts:42-49`, `runtime.ts:65-73`, `workflow.go:1285-1299` [V].

Otra incoherencia entre documentos: `task.json` usa D1-D3 para el gate y el `06` usa D1-D5 para otra cosa. `gate.ts:26` cita «(D2)» refiriéndose al de `task.json`.

**Secciones a actualizar:** el aviso inicial y la tabla de commits; §3 completa (pasar a «hecho en fase 0/1» lo que lo está); §4 (marcar 1, 2 y 4 como hechos en observe); el diagrama de §5; §5.1 (quién aplica el report, sesión perdida); D2, D3, D4 y D5; §6 (riesgos resueltos fuera, riesgos nuevos dentro: H-05 a H-08); §7 (fases 0 y 1 cerradas, con sus PR); §8 (arreglar la fila); §9.

---

## 7. Lo que falta para la fase 2

Condición de salida de §7: evento → admisión → turno → pregunta → caída → respuesta → reanudación → gates, con fallos inyectados en cada frontera.

**A. Decisiones, antes de escribir código (en este orden):**

1. **El pool ejecuta los turnos; el residente solo hace poll, Outbox y reencolado.** Fuera `launch`/`deliver`/`stop` de la fase 2: parar ya funciona porque el latido rechaza un change terminal y aborta (`store.ts:678-680`, `pool.ts:111-113`).
2. **Canal de la fase 2: comentarios de issues de GitHub.** Es el único con poller.
3. **Identidad de sesión:** una por (change, tipo de activity), con contador de generación, escrita **antes** de lanzar. La fab ya genera el id (`claude.ts:28`).
4. **Sesión perdida:** generación nueva con prompt reconstruido desde estado durable (change, historial, preguntas y respuestas), con evento y contando para el tope. Nunca en silencio. Exige guardar pregunta y respuesta en la fab, no solo en el harness.
5. **Autoridad del `report`:** en modo vivo manda el `report`; gana el último válido; sin `report`, falla como hoy.
6. **Durabilidad del `report`:** el handler MCP lo persiste por `attemptId` sin tocar la activity; el pool lo aplica al acabar el turno.
7. **Nombre y transiciones del estado de espera**, con plazo. No `awaiting`.
8. **Quién puede responder** y **a qué contenido queda atada la admisión**.
9. **Política del Outbox:** plantilla, tope, destino fijo, filtro.
10. **Adaptador para trabajo que entra por canal:** solo uno confinable. `native` lanza si se le pide `confine` (`native.ts:35-37`); puede seguir en paralelo para changes creados a mano.

**B. Piezas, en orden de dependencia:**

1. Vínculo hilo → change y `ExternalRef` con `github`. Una admisión por hilo.
2. Modo `auto` mínimo: el efecto `admit` crea el signal con el contenido fijado en la admisión. `scope_max = propose` → solo `addSignal` (triage humano); `change` → `triageSignal`. Usa comandos que ya existen (`store.ts:428,449`).
3. Lectura de comentarios: Trigger por comentario, con actor, y filtro de la identidad propia.
4. Store: estado de espera y dos comandos, «preguntar» (estado + efecto `reply` en una transacción) y «responder» (condicionado al id de la pregunta). Barridos de §4.
5. Tabla de sesiones y rama del pool que llama a `LiveBackend.run`.
6. `report` durable.
7. Outbox: efecto `reply` con marcador en el comentario y reconciliación antes de reenviar. Sin eso el efecto no es reejecutable y una caída lo deja `unknown` sin salida (`effects.ts:35`).
8. Recuperación de un turno huérfano: aplicar el `report` persistido si existe; si no, reanudar con «continúa», no con el prompt inicial.
9. Autorización de la respuesta.

**C. Fronteras donde inyectar el fallo.** El patrón ya existe (`CrashPoint`, `effects.ts:14`, `resident.ts:78-80`); se amplía:

1. Leer → registrar (existe).
2. Registrar → admitir (existe).
3. Admitir → signal creado → efecto cerrado. No debe duplicar el signal.
4. Claim → sesión escrita → proceso lanzado.
5. Pool muerto a mitad de turno, con el agente vivo.
6. `report` recibido → fin de turno → aplicado.
7. Estado de espera confirmado → envío del comentario.
8. Comentario enviado → recibo guardado. No debe publicar dos veces.
9. Respuesta leída → registrada → reencolada.
10. Reanudar con la sesión perdida.
11. Change cancelado mientras espera, y respuesta que llega después.
12. Respuesta duplicada, tardía (a una pregunta anterior) o de alguien sin rol.

---

## Tabla de hallazgos

Cada hallazgo tiene su tarea en `../task.json`, en el mismo orden: H-01 a H-08 son T16 a T23 (alta, bloquean T12), H-09 a H-17 son T24 a T32 (media) y H-18 a H-20 son T33 a T35 (baja).

| Id | Sev. | Dónde | Problema | Escenario que falla | Propuesta |
|---|---|---|---|---|---|
| H-01 | Alta | `06:L141-143`; `claude.ts:29,37`; `native.ts:22,53`; `pool.ts:108-115`; `store.ts:685-689` | El `report` vive en memoria del pool. Y si se aplicara a mitad de turno, la activity dejaría `in_progress`, el latido fallaría y abortaría al agente | El agente informa `awaiting`; el pool muere antes de aplicarlo. La pregunta se pierde y el huérfano se reejecuta sobre la misma sesión | El handler persiste el report por `attemptId` sin cambiar el estado; el pool lo aplica al final en una transacción con el efecto `reply`; la recuperación lo aplica en vez de reejecutar |
| H-02 | Alta | `store.ts:152-158,307-322,1030`; `claude.ts:55` | El `sessionId` no tiene sitio durable y la activity no es una clave estable | Cae el pool tras el turno 1: el turno 2 abre una sesión nueva sin memoria. `retryChange` crea otra activity y pierde la sesión | Fila por (change, tipo, generación) escrita antes de lanzar, con backend, cwd, modelo y huella de perfil |
| H-03 | Alta | `06` §5.1, §6; `live/contract.ts:48` | «Sesión irrecuperable» no tiene transición | Bajo confine sin directorio persistente, o tras recrear el worktree, `--resume` falla; la activity falla 3 veces y el change queda `failed` con una respuesta humana ya dada | Decisión A4. Copiar a copilot: prompt reconstruible (`cp:orchestration.ts:506`) y nunca sesión nueva por error transitorio (`cp:copilot.ts:160`) |
| H-04 | Alta | `store.ts:923-932,1102-1103`; `06:L79,L167` | El agente se reejecuta solo tras fallo u orfandad; no hay «resultado desconocido» en activities | El turno terminó y dejó commits, pero el pool murió antes de `completeActivity`. La reejecución reenvía el prompt inicial a una sesión que ya lo hizo | Para activities vivas: reconciliar (report persistido, estado del worktree) y reanudar con «continúa», como `sa:dsh.ts:557` |
| H-05 | Alta | `resident.ts:42-47`; `gate.ts:34-41`; `github.ts:54-72` | La etiqueta verifica quién, no qué | Triage etiqueta un issue inocuo; el autor edita el cuerpo con una inyección; el trigger nuevo pasa el gate | Guardar el contenido admitido (texto + hash) y exigir que la última edición sea anterior al `labeled`; si no, `edited-after-label` y volver a etiquetar. El prompt usa solo esa copia |
| H-06 | Alta | `06:L145`; `github.ts:18`; `resident.ts:44-46` | No se define ni se verifica quién responde; no se leen comentarios; el evento no tiene actor | Un tercero comenta en un issue público con una pregunta abierta y su texto entra como respuesta en una sesión con permisos de escritura | Trigger por comentario con actor; permiso con la consulta existente (`github.ts:66-71`); posterior al recibo de la pregunta |
| H-07 | Alta | `live/contract.ts:11`; `confine.ts:21,62`; `agents.ts:55-58` | El Outbox publicaría texto libre del agente con la identidad de la fab | Un issue inyectado hace que el agente lea la credencial y la ponga en `human_action`; la fab la publica en el issue | Plantilla fija, tope de longitud, destino derivado del hilo guardado (`sa:replies.ts:84`), neutralizar menciones y órdenes, pasar `ThreatMonitor` al texto saliente, una pregunta abierta por activity |
| H-08 | Alta | `resident.ts:42-47`; `db.ts:21`; `types.ts:7` | Sin vínculo hilo → change y sin filtro de identidad propia | En `auto`, el comentario de la fab crea un trigger, que admite otra vez: signals duplicados o bucle | Pieza B1 y filtro de actor propio en B3 |
| H-09 | Media | `06:L124` contra `06:L140,147`; `effects.ts:44-48`; `agents.ts:181` | El documento asigna el lanzamiento al residente y al pool a la vez | Si lanza el residente, un turno de 20 minutos para el poll y el Outbox | Decisión A1 |
| H-10 | Media | `06:L155,L157`; `live/contract.ts:38-45` | D2 y D4 describen un contrato mayor que el implementado | Quien implemente desde el `06` construirá `assess`, `handoff` y `dispose` sin uso | Reescribir D2 y D4 desde `contract.ts`; aplazar el resto a cuando haya steer |
| H-11 | Media | `06:L156`; `pool.ts:305-309`; `live/native.md` | Dos canales de estado sin precedencia | Turno con `report(awaiting)` y sin línea `STATUS`: el pool lo trata como `missing` y falla | Decisión A5 |
| H-12 | Media | `store.ts:560-562,640-645,849,961,1063,1143`; `pool.ts:450-455` | El estado nuevo choca con `review_status='awaiting'` y hay siete puntos que no lo conocen | Change cancelado mientras espera; llega la respuesta, se reencola a `pending` bajo un change terminal, nadie lo reclama y `--once` no termina | Otro nombre; transición condicionada; incluirlo en el barrido terminal |
| H-13 | Media | `pool.ts:108-115`; `store.ts:281-300`; `agents.ts:181` | Cualquier error del latido aborta el turno; el tope real del turno son 20 minutos fijos | El residente retiene la escritura; el latido agota reintentos con `BUSY` y mata un turno sano | Tolerar fallos de bloqueo consecutivos hasta cerca del lease; timeout configurable; corregir la explicación del `06` |
| H-14 | Media | `effects.ts:35,44-48,74-78` | `unknown` y `dead` no tienen salida ni aviso; la cola es serie | Una caída entre enviar el comentario y cerrar el efecto deja `reply` en `unknown`; la pregunta no llega y la activity espera para siempre | Reconciliar por marcador (B7); evento visible al quedar `dead` o `unknown` |
| H-15 | Media | `06:L158`; `resident.ts:67-68` | `scope_max` se calcula y nadie lo aplica | Autor no confiable: el gate dice `propose` y el change se ejecutaría igual | Pieza B2 |
| H-16 | Media | `06:L170`; `store.ts:486,645`; `pool.ts:429` | Sin plazo de espera; concurrencia por proceso, no global; el slot reservado no existe | 20 conversaciones sin respuesta llenan el `taskLimit` y bloquean el workstream | Plazo → `blocked` con motivo; quitar el slot reservado del documento; documentar un pool por workstream |
| H-17 | Media | `06:L193`; `native.ts:35-37`; ADR-0007 | «Los dos en paralelo» incluye un backend no confinable para texto no confiable | Un issue admitido se ejecuta con `native` sin sandbox de proceso | Decisión A10 |
| H-18 | Baja | `prompts.ts:57-60` | Texto no confiable sin delimitar en el prompt | El cuerpo del issue imita una sección `# Your activity` | Delimitador con nonce y aviso. No sustituye al sandbox |
| H-19 | Baja | `claude.ts:13-17`; `confine.ts:64` | Token MCP en argv; dos `--allowedTools` y dos `--mcp-config` cuyo comportamiento es empírico | Otra versión de `claude` hace «gana el último» y el agente pierde `report` o las herramientas | Pasar la config por archivo; test que fije el comportamiento |
| H-20 | Baja | `06` completo (§6 de este informe) | Citas y estados obsoletos; ids D1-D3 duplicados con `task.json` | El siguiente lector hereda afirmaciones falsas | Actualizar a v0.5 antes de la fase 2 |

---

## Contraste con `SINTESIS-R2.md`

Escrito después de fijar los hallazgos.

**Confirmo:**

- R1: `native` sigue de un disparo en el pool (ahora `agents.ts:145-155`).
- R2, en su dirección: dos niveles.
- R3, R4, R5, R14: implementados en las fases 0 y 1 (`effects.ts`; `store.ts:1103`; `worktrees.ts:39-60`; `intake.ts:40`). De R5 queda la ruta truncada a 8 caracteres (`worktrees.ts:67`), ya anotada como T9.
- R8: el estado de espera, el Outbox y la persistencia de pregunta y respuesta van juntos. Mis H-01 y H-14 son su consecuencia concreta.
- R9: `confine.ts:58-64`.
- R12: la fase 1 lo respeta; el residente no toca tablas de la fab (`resident.ts:2`).
- R15: recortar. Añado recortes: `launch`/`deliver`/`stop`, cuatro métodos de D2, el slot reservado.

**Contradigo o matizo:**

- **R2 y R7 (forma de `AgentBackend` y sus criterios).** Con reanudación por id y sin steer, la espiga demuestra que casi todo sobra. R7 son requisitos de un proceso retenido; no deben ser condición de la fase 2.
- **R6.** Se da por encaminado, pero solo existe el token por claim. «Resultado desconocido» está en `adm_effects`, no en las activities, que es donde hace falta (H-04).
- **Juicio sobre la base de datos (§4).** La conclusión (misma base) es correcta. El argumento no: compara la espera con el lease de 90 s, y el riesgo real no es que caduque el lease sino que el latido lance un error y aborte el turno (`pool.ts:111-113`). La objeción de agy tenía parte de razón por otra vía (H-13).
- **«Reanudación tras caída: `resume()` del superagent, no reejecutar».** Es lo correcto y no hay nada que lo implemente; el pool reejecuta.
- **R13.** El gate ya fija `scope_max`, pero nadie lo consume (H-15).

**Nuevo en esta ronda:**

- H-01 (durabilidad y momento del `report`), H-02 y H-03 (sitio del `sessionId` y sesión perdida).
- H-05 a H-08: todo el modelo de amenazas de la fase 2 (edición tras la etiqueta, autoridad de la respuesta, contenido del Outbox, auto-disparo).
- H-09 (quién lanza), H-11 (dos canales de estado), H-12 (colisión y puntos del Store), H-17 (`native` no confinable frente a ADR-0007).
- La prioridad de la respuesta humana sale gratis del orden FIFO por `created_at`.
- La premisa «el lease de 90 s mata un turno largo» no se sostiene en el código.

---

## Lo que no revisé

- **`dsh-herdr` y `deepseek-harness`:** no los abrí. Nada de este informe se apoya en ellos.
- **`review/SINTESIS-EGM.md` (ronda 1):** no la leí; solo la R2 y `task.json`.
- **Superagent:** no leí `core/tickets.ts`, `core/evals.ts`, `core/assignments.ts`, el cuerpo de `app/sessions.ts` ni `app/outbox.ts` más allá de las líneas citadas. No comprobé si el Outbox evita el doble envío entre `send` y `settle`.
- **Copilot:** no leí `delivery.ts`, `worktree.ts`, `sources.ts` ni `state.ts`. La afirmación «`src/core` se copia intacto» no la verifiqué; solo que se importa.
- **ESF:** solo `workflow.go:1270-1302`, la interfaz `Harness` y fragmentos de `turnexec`. No leí implementaciones de harness ni qué hace con una sesión perdida.
- **Fab:** de `src/agent/rpc.ts` solo localicé las líneas de sesión; no leí `src/agent/session.ts`, `src/threatmon/`, `src/gates.ts`, `src/manifest.ts` ni los tests. No leí el ADR-0007; uso lo que el brief y el `06` dicen de él.
- **Sin ejecución:** no corrí tests, ni `claude`, ni `gh`. Son inferencias sin reproducir: la caducidad de transcripts de `claude`, reanudar con otro modelo, el comportamiento de flags repetidos, que un comentario suba `updated_at`, que el autor pueda editar tras la etiqueta, y la exfiltración de H-07.
- **Método:** el worktree `sw-factory-docsint` no tiene índice de graft y construirlo habría escrito en disco, así que leí por tramos numerados. No afirmo cobertura completa de llamadores.

<!-- FIN -->
