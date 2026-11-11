# Síntesis EGM de la revisión de `design_draft.md`

Elefante: Claude Opus 5.5, 2026-11-09. Revisores goldfish (sin contexto de la conversación):

| Revisor | Rol EGM | Veredicto | Archivo |
|---|---|---|---|
| Claude Fable 5.2 | doble verificación independiente | listo con cambios | `fable.md` (15 hallazgos) |
| Codex (GPT-6.1-Sol) | codebase_details + implementation_readiness | **no listo** | `codex.md` (9) |
| agy (Gemini 3.8 Flash) | design_critic + inventive_catalyst | **no listo** | `agy.md` (7) |
| opencode (modelo gratuito por defecto) | zoom_out | listo con cambios | `opencode.md` (6) |

Commits: fab `ce84fc4`, superagent `8c32a9d`, harness `fcc0ad4`. El elefante re-verificó en código F-01, F-03, F-04 y CD-02 (ver §4).

## 1. Comparación arquitectónica superagent ↔ fab (consolidada)

Base: tabla de `fable.md` §1, confirmada en sus puntos de fondo por los otros tres.

| Eje | superagent | fab | Consecuencia |
|---|---|---|---|
| Dominio | Agente proactivo: Trigger, Thread, Eval, Decision, Ticket, Assignment | Fábrica de cambios: workstream, signal, change, activity con fases fijas (`change_review → investigation → implementation → gates → validadores`) | Solo se solapan en «unidad de trabajo aceptada». Lo de antes (admisión) es del superagent; lo de después (fases, gates, evidencia), de la fab. |
| Dueño del estado | `Engine` como única puerta de escritura | `Store` sobre `fabrica.db`; los conectores ya tienen tablas propias (`ChangeLinkStore`) | Hay precedente de módulo con tablas propias en la misma base. |
| Máquinas de estado | Eval por Thread, Ticket reanudable, Assignment; `person/*` derivada | signal, change (10 estados, `blocked` terminal), activity; bandeja derivada | La Eval no tiene equivalente. El change terminal no se reabre. |
| Ejecución | Push: una sesión persistente por Ticket, `queue/steer/inject`; el worker abre el PR | Pull: un disparo por activity, lease de 90 s y heartbeat de 30 s; la fab abre el PR y fusiona | Modelos opuestos. |
| Autorización | Quién origina trabajo: gate, fuerza, Mandate, `observe` | Qué hace el agente y cuándo avanza: gates humanos y deterministas, validadores, sandbox | Son ortogonales y se suman. |
| Canales | Poll de GitHub y Feishu; Outbox con recibos y reintentos | Jira por clave a mano; comentario síncrono, sin recibos | La fab no escucha ni reintenta. |

## 2. Hallazgos consolidados (sin duplicados)

| # | Hallazgo | Severidad | Revisores | Resolución propuesta |
|---|---|---|---|---|
| C1 | **`blockActivity` deja el change en `blocked` (terminal), no en `in_review`**. D1 mapea mal: `person/review` = `implemented`, `in_review` es un gate *previo*. | Alta | los 4 | Sustituir D1 por la tabla de F-01. |
| C2 | **La pregunta humana no tiene camino de vuelta**: `retryChange` reencola sin el texto del humano; solo `resolveReview` lleva comentarios. | Alta | Fable F-02, Codex IR-01 | Transición nueva (activity `awaiting` + comentario) sin estado nuevo. |
| C3 | **Sesión viva vs pool**: rompe la exclusión por change, la verificación del HEAD y el slot; con el heartbeat la sesión ocupa `worker_concurrency` o `requeueOrphans` la mata. | Alta | los 4 | La sesión vive **dentro de una activity** y se **reanuda por id**. «Viva» quiere decir reanudable, no un proceso retenido. |
| C4 | **La fab ya tiene sesión, MCP y hooks en `native`**: `add_user_message`, `interrupt_session`, `load_session`, `createSdkMcpServer` con token y hooks `PreToolUse`. Le faltan `steer` e `inject`. | Alta | Fable F-03 | Reutilizarlo; el diagrama deja de marcar MCP como «NUEVO». |
| C5 | **No existe un «mismo proceso»**: la fab es un CLI, el pool corre en primer plano por workstream y `fab daemon` devuelve error. | Alta | Fable F-04 (agy H4 relacionado) | Hace falta un comando residente nuevo como primer entregable. |
| C6 | **Sí hay una segunda máquina de estados** (Trigger, Thread, Eval) antes del change; en `observe` nunca hay change. | Alta | Fable F-05, Codex IR-03, agy H5, opencode ZO-2 | Dos agregados con un solo punto de unión: admisión con tablas propias en `fabrica.db`, fuera de `Store`, que entra por `addSignal` y `triageSignal`. |
| C7 | **Inyección**: hoy el cuerpo de la HU llega íntegro al prompt del implementador. Con admisión automática, el texto de GitHub llegaría al agente que escribe código (ADR-0007). | Alta | Fable F-06, agy H3 | Primer riesgo del ADR: el router lee el texto como dato y produce título y alcance en formato fijo, y el implementador recibe solo eso. |
| C8 | **Las peticiones explícitas también pasan por el router**: el gate fija la fuerza, y el assessor decide aceptar, adjuntar, parar o ignorar, además del `scope`. | Alta | Fable F-07, Codex IR-02 | Corregir el diagrama. |
| C9 | **El confinamiento de `claude` desactiva MCP y hooks** (`--strict-mcp-config` con `mcpServers` vacío). `bwrap` no envuelve a `claude`. | Alta | Codex CD-02, Fable F-11, agy H3 | D5 por adaptador. MCP generado por la fab con lista cerrada y un token por activity que identifique el change. |
| C10 | **Fase 1 promete `would_accept` sin router** (el router llega en la fase 3). | Media | Codex IR-04 | En fase 1, `would_admit`, o un assessor mínimo. |
| C11 | **La fab ya cubre partes de la fase 1**: signal `new` = observe, `ignoreSignal`, bandeja, `taskLimit`, `change_links`, `profile_digest`, `needs_human`. | Media | Fable F-13, opencode ZO-3 | Matriz «reutiliza / extiende / nuevo». |
| C12 | **D3 inventa `link_pr` y duplica `STATUS:`**. | Media | Fable F-10 | Una sola tool, `report(state, summary, human_action?)`, sobre las transiciones de `STATUS`. |
| C13 | **Puertos copiados de DSH**: `Assessor {request,release}` sobra con `claude -p`; `deliver` sin recibos. | Media / baja | Fable F-12, Codex IR-05, opencode ZO-4 | `assess(): Promise<…>`; matriz de capacidades real primero. |
| C14 | **Canal de vuelta**: `ExternalRef.system` solo admite `jira`; GitHub comenta sobre PR, no sobre issues. | Media | Codex CD-03, agy H7, Fable F-13 | Ampliar el contrato (lo decide el integrador). |
| C15 | **Cuota, compactación y contrapresión** con varias sesiones vivas. | Media | agy H6 | Presupuesto por workstream y slot humano. |
| C16 | **Piezas del superagent que se pierden** sin decirlo: seguimiento, reanudación, «para» como Trigger, aviso de Policy, cola de efectos, lotes por hilo. | Media | Fable F-14 | Tabla «se toma / se aplaza / se descarta». |
| C17 | **Falta plan por fase**: archivos y pruebas. | Media | Codex IR-06 | Añadirlo en el ADR. |
| C18 | Citas imprecisas: `tickets.ts:37` frente a `model.ts:126`, `003-execution.md:31` frente a `:59`, `assessment.ts:94` frente a `:89`; falta enlazar `inspiracion/05`. | Baja | Fable F-15, opencode ZO-6 | Corregir. |

## 3. Desacuerdos entre revisores

| Tema | Posiciones | Juicio del elefante |
|---|---|---|
| Base de datos | **agy H4**: separar procesos y bases por contención (`.immediate()`, `isBusyError`). **Fable F-04/F-05**: misma base con tablas propias; varios procesos sobre la misma base ya están previstos (`isBusyError`). | Misma base. La contención ya se gestiona, y la admisión escribe poco (eventos externos, no heartbeats). Revisar si una medición lo desmiente. |
| Alcance | **opencode ZO-1**: recortar a una «prueba de costura» mínima antes de fijar puertos. **Fable/Codex**: corregir y detallar el diseño completo. | Compatibles: el ADR fija la forma y la fase 1 es la costura mínima. |
| Primer adaptador vivo | **Fable F-08**: `native` primero (ya tiene sesión, MCP, hooks y sandbox). **Borrador D4**: `claude` (objetivo de la suscripción). | **Decisión del usuario** (§5). |

## 4. Verificación del elefante

| Hallazgo | Comprobado en | Resultado |
|---|---|---|
| C1 | `src/store.ts:882@ce84fc4` | `this.setChangeStatus(a.changeId, 'blocked')`: confirmado. |
| C4 | `src/agent/rpc.ts:315-316,347-349`, `src/sdk/mcp-server.ts:23-30`, `src/sdk/session.ts:89-91@ce84fc4` | `droid.add_user_message` exige `idle()`; existe `interrupt_session`; `createSdkMcpServer` con token; el SDK rechaza un segundo turno activo: confirmado. |
| C5 | `src/cli.ts:147-150@ce84fc4` | `fab daemon: falta un backend propio`: confirmado. |
| C9 | `src/sandbox/confine.ts:58-64@ce84fc4` | `--setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`: confirmado. |

No re-verificado por el elefante: C3 (líneas de `pool.ts`), H4 de agy (contención real), C14, C16.

## 5. Decisiones para el usuario antes del ADR

1. **Primer adaptador vivo**: `native` (riesgo bajo, ya existe casi todo; no tiene `steer`) o `claude` (usa la suscripción y tiene `steer` comprobado con n=1, pero hay que adaptar `runAgent`, el confinamiento con MCP y los términos de uso).
2. **Base de datos**: misma `fabrica.db` con tablas propias (recomendado) o base separada (agy).
3. **Fase 1**: solo `would_admit` con el gate (costura mínima, sin modelo) o incluir ya un assessor mínimo para registrar `would_accept`.

<!-- FIN -->
