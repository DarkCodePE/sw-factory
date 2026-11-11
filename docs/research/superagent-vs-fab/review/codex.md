# Revisión Goldfish Codex

Roles: `codebase_details.md` e `implementation_readiness.md`, modo REVIEW. Documento: `docs/research/superagent-vs-fab/design_draft.md`, secciones 2–6. Criterio: `implementation-readiness-standard.md` del repositorio EGM indicado en el brief.

El borrador todavía no permite implementar sin tomar decisiones de diseño. Además, contiene una contradicción con el estado actual de fab y propone combinar MCP con un confinamiento que actualmente desactiva MCP. Los hallazgos siguientes distinguen hechos del código, afirmaciones documentales e inferencias de diseño.

## Alcance y evidencia

- Confirmados los HEAD: fab `ce84fc412bee732a8106711a135c1f762c562c97`, superagent `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`, harness `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`. Los archivos de código usados como evidencia principal no presentan diferencias frente a esos HEAD.
- Las citas sin prefijo pertenecen a fab; `S/` al superagent; `H/` al harness, en las rutas del brief. Las referencias al borrador corresponden al archivo de trabajo, sin atribuirle un commit.
- Descubrimiento con graft y `graft-lector`, seguido de lectura de tramos numerados. Codebase Memory identifica el proyecto fab y estado `ready`, pero su comprobación de cobertura devuelve `coverage_unavailable` y generación desconocida para los seis archivos principales consultados. Se verificaron los tramos directamente; no se infiere exhaustividad del grafo. `graft callers blockActivity` no devuelve aristas, aunque las llamadas sí se leen en `src/pool.ts:279@ce84fc4`.
- El skeleton de superagent con `graft-lector --no-refresh` informa que falta sidecar. No ejecuté `init` para respetar la restricción de escritura; usé graft y lectura directa de los tramos citados.
- No ejecuté compilación, tests, servicios, intake externo ni sesiones con modelos. La prueba Haiku n=1 se trata como afirmación del borrador, no como experimento reproducido. No consulté conversaciones ni memorias previas.
- «Fuera de alcance: implementar» significa que no se exige código nuevo para aprobar esta revisión. Los defectos de preparación señalan decisiones que faltan en el documento, no archivos propuestos que aún no existen.

## Hallazgos

### CD-01 — Alta — La descripción de `blockActivity` contradice el código

**Sección del borrador:** §2, fila «Gates humanos» (línea 31), y D1.

**Problema:** se afirma que `blockActivity` deja el change en `in_review`. Lo deja en `blocked`; también cancela actividades pendientes y borra lease y PGID. Una actividad bloqueada puede aparecer en el inbox, pero eso no la convierte en una aprobación pendiente. Esta confusión afecta al mapeo de `person/review`, `person/blocked` y `human_action`.

**Evidencia verificada leyendo código:** `src/store.ts:874@ce84fc4`, `src/store.ts:879@ce84fc4` y `src/store.ts:882@ce84fc4`. El inbox incluye bloqueos mediante un criterio separado en `src/store.ts:619@ce84fc4`. `createChange` sí usa `in_review` cuando requiere aprobación, en `src/store.ts:490@ce84fc4`; `resolveReview` exige `review_status = 'awaiting'` en `src/store.ts:955@ce84fc4`.

**Propuesta concreta:** corregir la tabla y documentar por separado aprobación, bloqueo y pregunta humana. Añadir una tabla de transiciones que identifique qué operación existente se reutiliza para cada caso y cómo vuelve al trabajo. No tratar el inbox como prueba de equivalencia entre estados.

### CD-02 — Alta — El confinamiento existente de Claude desactiva el MCP y los hooks que requiere la propuesta

**Sección del borrador:** D3, D5 y fase 2.

**Problema:** la combinación propuesta no funciona reutilizando sin cambios el confinamiento actual: al ejecutar Claude confinado se añaden `--setting-sources ''`, `--strict-mcp-config` y una configuración `mcpServers` vacía. Tampoco basta con nombrar `bwrap`: en `runAgent` el confinamiento depende de una opción; no es una garantía universal del pool. El documento no fija cómo se configura y alcanza el MCP de fab ni dónde se instalan los hooks de confianza.

**Evidencia verificada leyendo código:** `src/sandbox/confine.ts:58@ce84fc4` y `src/sandbox/confine.ts:64@ce84fc4`; el propio código excluye hooks, plugins y servidores MCP del host. Selección condicional del confinamiento y entorno heredado en `src/agents.ts:173@ce84fc4` y `src/agents.ts:178@ce84fc4`; propagación desde el pool en `src/pool.ts:217@ce84fc4`.

**Inferencia:** habilitar MCP indiscriminadamente para resolverlo ampliaría la frontera de confianza. Un servidor con privilegios del Engine necesita restringir los efectos que puede solicitar cada worker.

**Propuesta concreta:** definir el lanzamiento confinado para sesiones vivas: configuración MCP generada por fab con lista cerrada, transporte y acceso al servidor, hooks controlados por fab y fallo cerrado si falta aislamiento requerido. Vincular cada conexión a change/activity/intento vigentes; validar autorización en el servidor para `report`, `reply` y `link_pr`, sin confiar en un identificador elegido por el modelo. Añadir pruebas de acceso cruzado y de intento caducado.

### IR-01 — Alta — La espera humana no tiene un ciclo de vida compatible definido

**Sección del borrador:** D1, D2, fase 2 y §5, segunda pregunta.

**Problema:** no está decidido qué sucede con la activity, el proceso y el slot cuando un worker espera una respuesta. Si se usa `blocked`, el heartbeat será rechazado y el pool abortará; si se mantiene la promesa del worker abierta, seguirá ocupando un slot. Además, `runAgent` espera la salida del proceso y aplica un timeout de veinte minutos. Ninguna de esas políticas equivale por sí sola a una sesión durable esperando a una persona.

**Evidencia verificada leyendo código:** `blocked` es terminal en `src/store.ts:43@ce84fc4`; rechazo del heartbeat en `src/store.ts:674@ce84fc4`; aborto del worker ante fallo de heartbeat en `src/pool.ts:108@ce84fc4`; slots ligados a promesas en `src/pool.ts:413@ce84fc4` y `src/pool.ts:426@ce84fc4`. Timeout y espera al exit en `src/agents.ts:169@ce84fc4`, `src/agents.ts:226@ce84fc4` y `src/agents.ts:230@ce84fc4`. Recuperación de procesos huérfanos en `src/store.ts:1071@ce84fc4`.

**Propuesta concreta:** cerrar D1 antes de implementar: especificar transiciones para `waiting`, pregunta humana, respuesta, cancelación y caída; para cada una, indicar propietario del lease, ocupación del slot y si el proceso continúa o se reanuda después. Conservar exclusión por change y rechazar callbacks de intentos anteriores. Incluir reinicio de fab y expiración de lease como casos de aceptación.

### IR-02 — Alta — La admisibilidad `explicit` se convierte en trabajo sin definir la decisión semántica

**Sección del borrador:** §3.1 y diagrama de §4, arista `explicit → Mandate`.

**Problema:** el gate determina quién tiene autoridad; no determina por sí solo si el mensaje pide crear trabajo, consultar estado, detener o continuar uno existente. El camino directo del diagrama tampoco explica quién determina `scope` y título. Es una divergencia material respecto al superagent, que debe declararse o corregirse.

**Evidencia verificada leyendo código:** `S/src/policy.ts:197@8c32a9d` admite como explícito al emisor permitido que se dirige al agente. `S/src/core/evals.ts:109@8c32a9d` y `S/src/core/evals.ts:118@8c32a9d` envían el candidato admisible al assessor sin excluir esa fuerza. La decisión contempla `ignore`, `stop` y `accept` en `S/src/core/evals.ts:291@8c32a9d`; el alcance del Mandate viene de `outcome.scope`, no del gate, en `S/src/core/evals.ts:306@8c32a9d`. La evaluación proactiva distingue explícitos en `S/src/app/assessment.ts:109@8c32a9d`.

**Inferencia:** interpretar toda mención autorizada como un alta puede crear changes por preguntas o peticiones de parada. La figura no define una ruta alternativa para esos mensajes.

**Propuesta concreta:** separar admisión de decisión de intención para ambas fuerzas. Precisar qué componente enruta explícitos, cómo obtiene el alcance, cuándo adjunta a un change existente y cuándo decide `ignore` o `stop`. Hacer que la creación de signal/change ocurra únicamente tras una decisión de aceptación persistida. Especificar la revalidación de Policy al decidir y al reanudar.

### IR-03 — Alta — Faltan identidad, relaciones y transacción de aceptación

**Sección del borrador:** §4, fase 1 y §5, pregunta sobre Threads.

**Problema:** «Trigger/Thread idempotentes» y «mismo fabrica.db» no establecen claves ni atomicidad. Faltan la identidad externa del evento, el checkpoint del poller, la relación Trigger–signal–change, las cardinalidades de Thread y el enlace al Mandate. En observe no existe change: por tanto, afirmar que Thread y Mandate se enlazan a él no resuelve cómo se conservan las decisiones observadas. Un reintento entre esas escrituras puede duplicar trabajo o dejar autorización y trabajo desalineados.

**Evidencia verificada leyendo código:** `signals` guarda título, cuerpo y enlace al change, sin la identidad y autoridad estructuradas de un Trigger, en `src/store.ts:145@ce84fc4`. El Trigger original incluye actor, source, Threads y canal en `S/src/core/model.ts:23@8c32a9d`. `triageSignal` garantiza una transacción signal→change en `src/store.ts:449@ce84fc4`, pero su precondición es una signal `new`; no define deduplicación del evento externo. El intake Jira existente sí agrupa registro de importación, signal y enlaces en `src/connectors/intake.ts:40@ce84fc4`.

**Propuesta concreta:** añadir esquema mínimo con claves únicas, relaciones y nulabilidad durante observe; definir la clave de evento GitHub y la persistencia del cursor. Reutilizar la transacción de triage y el patrón del intake existente para incluir decisión, Mandate y enlaces, sin efectos de red dentro de la transacción. Documentar migración de bases existentes y comportamiento del rollback con registros nuevos pendientes. Resolver explícitamente la cardinalidad de Threads antes de fijar el esquema.

### IR-04 — Media — La fase observe depende de un router que llega en la fase 3

**Sección del borrador:** §4.2, fases 1 y 3.

**Problema:** la fase 1 promete `would_accept`, pero según §3 el modelo valora los candidatos inferidos y ese router se entrega en fase 3. Sin él, el gate puede registrar admisibilidad, no la aceptación semántica que habría ocurrido. También se promete que observe no crea ningún change, aunque los modos de evaluación del sistema de referencia no eliminan automáticamente la admisión explícita.

**Evidencia verificada leyendo código:** el gate permite explícitos independientemente de `mode` en `S/src/policy.ts:197@8c32a9d` y `S/src/policy.ts:204@8c32a9d`; `admitsInferred` exige auto y reglas habilitadas en `S/src/policy.ts:212@8c32a9d`. La solicitud al assessor se realiza en `S/src/core/evals.ts:118@8c32a9d`. **Afirmación documental de la referencia:** `S/src/core/model.ts:100@8c32a9d` describe observe como evaluación de candidatos proactivos sin aceptarlos.

**Propuesta concreta:** entregar el assessor mínimo en fase 1 o cambiar su salida a `would_admit`, reservando `would_accept` para una decisión evaluada. Definir una simulación global adicional si se quiere impedir también altas explícitas, respuestas y arranques de workers. Añadir condiciones de salida comprobables antes de avanzar de fase.

### CD-03 — Media — `TicketGateway` no cubre por sí solo el canal GitHub propuesto

**Sección del borrador:** §2, «Channel de vuelta»; §4, reutilización de `TicketGateway`; fase 3.

**Problema:** la reutilización planteada omite una diferencia del contrato actual: `ExternalRef.system` solo admite Jira y `TicketGateway.comment` recibe una clave de ticket. El gateway GitHub existente comenta sobre un `PullRequestRef`, no sobre una conversación arbitraria de issue. La figura empieza por GitHub y exige una dirección de respuesta que aún no está definida.

**Evidencia verificada leyendo código:** `src/connectors/types.ts:6@ce84fc4`, `src/connectors/types.ts:27@ce84fc4` y `src/connectors/types.ts:54@ce84fc4`. `ticketComment` construye texto, no resuelve destinos ni entrega mensajes, en `src/connectors/intake.ts:62@ce84fc4`. La referencia diferencia una dirección de canal de la identidad del Thread en `S/src/core/model.ts:7@8c32a9d` y `S/src/core/model.ts:9@8c32a9d`.

**Propuesta concreta:** documentar cómo representa fab los destinos Jira, GitHub issue y GitHub PR y qué operación los atiende. Reutilizar los gateways aplicables mediante un despacho pequeño; indicar qué contrato se amplía para issues y cómo mantiene compatibilidad con el intake Jira actual. No introducir un segundo cliente Jira.

### IR-05 — Media — Las firmas de puertos omiten los recibos necesarios para recuperar entregas

**Sección del borrador:** D2, D3 y §3.2.

**Problema:** `deliver(modo)` no es la firma del puerto citado: el original recibe Ticket y Assignment y confirma entrega, fallo y lectura mediante callbacks distintos. La matriz de capacidades tampoco define qué ocurre al pedir un modo no soportado. Para Outbox solo se menciona la existencia de recibos, sin precisar cuándo se persisten ni qué ocurre si el proveedor publica y fab cae antes de registrar el envío.

**Evidencia verificada leyendo código:** `S/src/core/ports.ts:59@8c32a9d`–`S/src/core/ports.ts:68@8c32a9d` define callbacks y parada; `H/packages/core/agent-loop/src/agent.ts:179@fcc0ad4`, `H/packages/core/agent-loop/src/agent.ts:183@fcc0ad4` y `H/packages/core/agent-loop/src/agent.ts:187@fcc0ad4` distinguen siguiente turno, siguiente paso y ausencia de despertar. `S/src/app/outbox.ts:31@8c32a9d` persiste recibo y efecto atómicamente; `S/src/app/outbox.ts:45@8c32a9d` ordena entregas y `S/src/app/outbox.ts:48@8c32a9d`–`S/src/app/outbox.ts:50@8c32a9d` separa envío externo de confirmación local.

**Inferencia:** la idempotencia de la cola local no demuestra entrega externa exactamente una vez.

**Propuesta concreta:** fijar firmas, identificadores de mensaje/intento, estados de entrega/lectura y recuperación tras caída; definir rechazo explícito para capacidades ausentes. Para Outbox, especificar orden, reintentos, destinos desaparecidos y estrategia de reconciliación o duplicación admitida ante confirmación incierta. No prometer equivalencia de `steer` con la sola prueba textual n=1.

### IR-06 — Media — Falta un plan de cambios y de pruebas por fase

**Sección del borrador:** §4.2 y §6.

**Problema:** las fases nombran componentes, pero no identifican archivos Create/Modify/Delete, cambios concretos ni criterios de prueba. El borrador reconoce experimentos no ejecutados; eso es una limitación declarada, no un fallo por sí mismo. Lo que falta para superar el estándar de preparación es definir las pruebas futuras y los contratos que demostrarán.

**Evidencia verificada leyendo código:** el trabajo afecta a invariantes ya existentes: exclusión por change al reclamar en `src/store.ts:635@ce84fc4`, barrera tras ejecución en `src/pool.ts:232@ce84fc4` y exigencia de commits antes de completar implementación en `src/pool.ts:314@ce84fc4`. **Evidencia documental:** el borrador, líneas 75–77, solo enumera tres fases; línea 91 declara lo no ejecutado. El estándar EGM leído exige límites de archivos y pruebas específicas.

**Propuesta concreta:** añadir una lista de archivos y pasos por fase, con pruebas para: evento duplicado y pollers concurrentes; observe sin efectos; explícito de consulta/parada; Policy revocada durante evaluación y reanudación; contexto sin autoridad; respuesta durante tool; espera humana sin agotar slots; worker anterior reportando tras reasignación; caída antes/después de envío externo; compatibilidad con adaptadores one-shot y gates sobre el HEAD verificado. Reutilizar fixtures y utilidades pertinentes tras localizarlas; no se auditó aquí exhaustivamente la infraestructura de tests.

Veredicto: **no listo** — corregir la contradicción con el código y cerrar los contratos de autorización, sesión y persistencia antes de convertirlo en ADR ejecutable.
<!-- FIN -->
