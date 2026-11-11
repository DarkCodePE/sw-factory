# Implementación de la ronda 3 (Sonnet 5.5)

Worktree `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/ronda3-hallazgos` (desde `9dbb175`, rc.12).
Sin push ni PR. Sin trailer `Co-Authored-By`. T25 y T35 quedan fuera (documento 06, no está en release).

## Decisiones comunes (apartes de las propuestas)
- **`src/live/` traído de la espiga `live-claude`, tal cual**: `contract.ts` y `claude.ts` (+ `tests/live-claude.test.ts`). **`native.ts` NO se trae**: depende de `exec --new-session-id/--settings/--session-dir` de `src/agent/`, que no está en rc.12 (los 3 tests de la espiga native fallan en esta rama). T16/T34 sobre native quedan pendientes.
- **Dos campos opcionales añadidos al contrato** (`LiveTurn`), que el contrato de las espigas no tiene y habría que llevar a ambas ramas: `onReport` (T16, persistir antes de contestar al agente) y `newSessionId` (T17, la fab fija el id de una sesión nueva; con `sessionId` se reanuda).
- Todas las tablas nuevas llevan prefijo `adm_` y viven en `src/admission/db.ts`. Lo único que toca tablas de la fab es `Store` (columnas `question_id`, `wait_until`, estado `waiting_reply`) y `ChangeLinkStore` (`ExternalRef.system` admite `'github'`).
- Comportamiento por defecto sin cambios, salvo: (a) el gate exige además que el contenido no se haya editado tras la etiqueta (T20, una llamada GraphQL extra por trigger que pasaría el gate); (b) `Labeler` lleva `at`. Los comentarios (T21) y el Outbox (T22) son opt-in y la CLI no expone el Outbox.
- Nada se cablea en el pool (fase 2 no existe en rc.12). Lo que queda para T12 se anota por fila.

## Estado por tarea
| Tarea | Estado | Commit | Tests añadidos | Pendiente de T12 / notas |
|---|---|---|---|---|
| T16 | hecho (lado Store/admisión) | `580aa5c` | `tests/live-report.test.ts` (8) | El pool debe pasar `onReport: ReportStore.recorder(...)` y llamar `applyReport` al acabar el turno. native: pendiente (no está en la rama). |
| T17 | hecho | `b3016ad` | `tests/live-sessions.test.ts` (7) | El pool debe llamar `SessionStore.begin` antes de lanzar y `markLaunched` en `onSpawn`. |
| T18 | hecho (lado admisión) | `011571b` | `tests/live-session-lost.test.ts` (4) | El pool debe llamar `supersede` al capturar `isSessionLoss(error)` y usar `reconstructPrompt`; `SessionLostExhaustedError` → `failActivity`. |
| T19 | hecho (lado admisión) | `4858aeb` | `tests/live-recovery.test.ts` (4) | El pool debe consultar `planTurn` tras cada claim; `markAnswerDelivered` en `onSpawn`. |
| T20 | hecho | `7031bc9` | `tests/admission-content.test.ts` (7) | El prompt del change debe usar solo `adm_content` (copia admitida). [I] que `lastEditedAt` cubra el título: no comprobado, por eso también hay hash. |
| T23 | hecho (lado admisión) | `ef1454f` | `tests/admission-links.test.ts` (6) | El efecto de admisión del modo auto debe llamar `ThreadLinks.link`. |
| T21 | hecho (modo observe) | `7294abf` | `tests/admission-comments.test.ts` (7) | Aceptar un comentario → `answerAwaiting` (T27) solo en auto. |
| T22 | hecho | `8c3740f` | `tests/admission-outbox.test.ts` (8) | Exponer `outbox` en la CLI al activar auto. |
| T24 | hecho (decisión + test) | `fe7800f` | `tests/admission-effects-kinds.test.ts` (1) | El residente no registra launch/deliver/stop; el 06 no está en la rama. |
| T26 | hecho (función) | `24690cd` | en `tests/live-report.test.ts` | El pool debe usar `liveOutcome` en pool.ts:305-309 para turnos vivos. |
| T27 | hecho | `9bae1b2` | `tests/live-waiting.test.ts` (7) | Nombre `waiting_reply`; claim, barrido, inbox, orfandad y --once cubiertos. |
| T28 | hecho | `86cc040` | `tests/pool-heartbeat.test.ts` (3) | Código de rc.12 (pool.ts), sin depender de T12. |
| T29 | hecho | `ba0b6ad` | `tests/admission-effects-stuck.test.ts` (6) | |
| T30 | hecho (función) | `4f4b90d` | `tests/admission-apply.test.ts` (5) | `applyAdmission` desde el efecto de admisión del modo auto. |
| T31 | hecho | `824f285` | en `tests/live-waiting.test.ts` | Slot reservado: se quita en el 06 (fuera de rama). |
| T32 | hecho (función) | `4807443` | `tests/admission-channel.test.ts` (3) | El pool debe usar `runLiveTurn`. |
| T25 | fuera de rama | | | Documento 06. |
| T33 | hecho (opt-in) | `387dfb9` | `tests/prompts-untrusted.test.ts` (3) | `PromptInput.untrusted` es opt-in porque `tests/profile.test.ts` fija los prompts por defecto byte a byte; el pool de T12 lo activa con `isChannelChange`. |
| T34 | hecho (claude) | `a53dba6` | en `tests/live-claude.test.ts` (3) | Config MCP por archivo 0600 en el git dir; un solo `--allowedTools`/`--mcp-config`; confine ya no añade un `--mcp-config` vacío si hay uno. native: no está en la rama. |

Correcciones del bloque media: `8b52d84` (M1: `isChannelChange` también cubre changes triajados a mano desde un signal `propose`), M2 y M3 (comentarios). M4 (el plazo de una espera solo vence con el residente corriendo; coherente porque las preguntas solo existen con residente) queda anotado para T12. Sobre M2: qué puede hacer la persona desde el inbox con una `waiting_reply` (`resolveReview` no actúa sobre ella) queda para T12.

Última suite completa: 1320 pass, 1 fail (`agent-execute-background`, «30s foreground»: dependiente de la carga; pasa aislado 9/9). La primera pasada del mismo comando dio 2 fallos y 1 error de ese estilo; no relacionados con estos cambios.

Correcciones del bloque alta (verificador): `d5e51ae` (A1), `336abad` (A3), `debeb35` (A2, A9, A4), fix T22 (A7a). Sin hacer, a T12: A5 (aplicar done/blocked junto al cierre y con fencing de worker), A6 (el tope de generaciones no se reinicia con retryChange), A8 (marcar la intención antes de lanzar; comparar profile_digest) y la nota de `question-not-published` si el residente muere entre publicar y guardar `published_at`.

Orden real de commits del bloque alta: T16, T17, T18, T19, T20, **T23, T21, T22** (T21/T22 dependen del vínculo hilo → change de T23).
