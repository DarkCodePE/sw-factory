# T12 — Fase 2: costura completa en el pool y modo `auto` mínimo (Sonnet 5.5)

Worktree `/home/orlando/Desktop/factory/sw-factory-r3`, rama `feat/t12-fase2-integracion` (base `5c4a9ac`). Sin push ni merge, sin subagentes, sin `Co-Authored-By` (el `CLAUDE.md` del proyecto lo prohíbe sin `attribution.commit`; el primer commit lo llevaba y se enmendó).

## Qué conecté y dónde
| Pieza | Dónde |
|---|---|
| Rama viva del pool (S1, S2, S6): `SessionStore.begin` → `planTurn` → `runLiveTurn` con `onReport` durable → `liveOutcome` + `applyReport` | `src/live/turn.ts` (`runLiveActivity`), llamada en `src/pool.ts:252` y `:283`; `awaiting` → `applyReport`, done/blocked → `closeWithReport` (`pool.ts:357-362`) |
| Sesión perdida (S3): `isSessionLoss` → `supersede` → `reconstructPrompt`, con evento y tope | bucle en `src/live/turn.ts` (`catch (error)`, l. 80) |
| Turno huérfano (S4): aplicar el report guardado o `CONTINUE_PROMPT` | `turn.ts` (rama `apply-report`) + `recovery.ts` (`planTurn` ignora el report de un intento que falló con motivo) |
| Espera (S5) | residente: `inbound` → `answerQuestion` (`resident.ts:180`); pool: `markAnswerDelivered` en `onSpawn` (`turn.ts`); plazo: `expireQuestions` también en el bucle del pool (`pool.ts:482`) |
| Outbox (S7) | `resident.ts:53` registra `reply` en modo auto; `outbox.ts` `reconcileQuestion` |
| Modo `auto` (S8) | `resident.ts:97` (`applyAdmission`), `admission/cli.ts` (`--mode auto --workstream --self`), `cli.ts` (`fab run --live`) |
| Confinamiento de changes de canal | `pool.ts:252-265` (`isChannelChange` → `confine` forzado; `assertConfinement` → `CHANNEL_NOT_CONFINABLE`) |

## Criterio de la rama viva
`fab run <slug> --live` **y** el adaptador del workstream tiene backend vivo (`LIVE_BACKENDS`, hoy solo `claude`) **y** la activity es investigación o implementación (`liveBackendFor`, `turn.ts:24`). Validadores y gates siguen en un disparo. Sin `--live` el camino de un disparo es idéntico (ni se crean tablas `adm_*`; test `pool-live`). Nota: el prompt vivo añade `LIVE_RULES` para que el agente conozca la tool `report`.

## Las 12 fronteras
| # | Frontera | Test |
|---|---|---|
| 1 | Leer canal → registrar trigger | `costura-fronteras` «1» (`after-read`) |
| 2 | Registrar → admitir | `costura-fronteras` «2» (`after-register`) |
| 3 | Admitir → signal → efecto cerrado | `auto-admit` «frontera 3» (`signal-created`, `effect-ran`) |
| 4 | Claim → sesión escrita → lanzado | `costura-fronteras` «4» (`session-written`); `pool-live` S4 (`session-launched`) |
| 5 | Pool muerto con agente vivo | `costura-fronteras` «5» (pgid real) |
| 6 | report → fin de turno → aplicado | `costura-fronteras` «6» (`report-recorded`, `turn-ended`, `report-applied`) |
| 7 | Espera → envío del comentario | `auto-outbox` «frontera 7» |
| 8 | Comentario enviado → recibo | `auto-outbox` «frontera 8» (`effect-ran`, marcador) |
| 9 | Respuesta → registrada → reencolada | `costura-fronteras` «9» (`answer-applied`) |
| 10 | Reanudar con sesión perdida | `pool-live` S3 (NotFound, transitorio, tope) |
| 11 | Change cancelado esperando | `costura-fronteras` «11»; `pool-live` M2 |
| 12 | Respuesta duplicada/tardía/sin rol | `costura-fronteras` «12» y «9» |

Extremo a extremo: `tests/auto-e2e.test.ts` (issue → change → pregunta → comentario → reanudación → done → gates `VERDICT: pass`).
Nota de método: una caída dentro de un handler de efecto (`signal-created`, `answer-applied`) la captura la cola como error y reintenta tras deshacer la transacción; los tests lo afirman (`attempts: 2`, un solo signal).

## Puntos abiertos
- **A8**: `markLaunched` antes de lanzar (`turn.ts`); `profile_digest` se compara en `begin` (`sessions.ts`).
- **A6**: `fab retry` y la tecla `r` del tui llaman a `resetSessionCap` (evento incluido). Para ello `adm_sessions.cap_from` (tabla `adm_`, con `ALTER` para bases previas); ninguna tabla de la fab migrada.
- **Tabla de sesiones**: se queda en `adm_sessions`.
- **B1**: `reconstructPrompt` pasa `untrusted: isChannelChange` y las plantillas del perfil; el pool activa `untrusted` igual.
- **M1**: `linkTriagedSignal` desde `fab triage`.
- **A5**: `closeWithReport` (cierre + marca en una transacción, con comprobación de worker); `applyReport` ya no marca done/blocked.
- **A4**: en auto, `question-not-published` reconcilia por marcador y, si sigue sin publicar, lanza para que el efecto reintente.
- **M2**: `fab inbox`/`show` muestran la pregunta; opciones: responder en el hilo, `fab retry` (nuevo `Store.abandonWait`) o `fab reject`.
- **M4**: el pool con `--live` también vence plazos.
- **B2**: **no hecha**. Prueba manual pendiente con `claude` real y confinado: (1) lanzar `fab run --live` sobre un change de canal con bwrap; (2) comprobar que `claude` lee el `--mcp-config` del git dir (`.git/worktrees/<n>/fab-live`) dentro del sandbox; (3) que `--allowedTools` unido por comas funciona; (4) provocar `awaiting` real y reanudar con `--resume`.

## Commits
```
807ef8f feat(pool): turno vivo en el pool detrás de --live (S1, S2, S4, S6)  [+A5, A8, B1]
18a56f2 feat(pool): sesión perdida … (S3, A6)
5515531 feat(pool): recuperación de un turno huérfano … (S4)
f14d08a feat(pool): espera waiting_reply … (S5, M2, M4)
fbe5c26 feat(residente): Outbox en modo auto … (S7, A4)
763c184 feat(residente): modo auto mínimo … (S8, M1)
cc66867 test(costura): fronteras 1, 2, 4, 5, 6, 9, 11, 12
f4885fb test(costura): extremo a extremo en modo auto
```
La «pieza 7» (puntos abiertos) quedó repartida en las piezas donde se cruzan, no en un commit propio.

## Comandos y salida
- Antes de editar: `bun test tests` → `1338 pass / 2 skip / 4 fail` (fallos previos y de carga: `security: API key never leaks…`, `exit code alone decides pass…`, `timeout fails one step…`, `interrupted tool snapshots…`).
- Al terminar: `bun run typecheck` → limpio. `bun test tests` → `1378 pass / 2 skip / 0 fail, 7904 expect(), 137 files [300.85s]`.

## Lo que no hice
- B2 (arriba). `native` no tiene backend vivo (no está en la rama). `steer`, efectos `launch/deliver/stop` (S1) fuera.
- El plazo de espera no es configurable por CLI (7 días por defecto; los tests manipulan `wait_until`).
- Un change de canal con adaptador no confinable queda `blocked`; no hay ruta para forzarlo.
- Riesgo: `fab retry` sobre un change `waiting_reply` abandona la espera sin avisar al hilo; la pregunta queda cancelada en la fab pero el comentario sigue publicado.

## Correcciones tras verificación (verif-fable.md)

Commits nuevos en la misma rama, sin `Co-Authored-By` ni push. Cada arreglo tiene un test; con `src/` revertido (comprobado con `git stash` de `src/`) fallan todos los marcados «sí», salvo M5 (ver nota).

| Id | Commit | Test | Falla sin el arreglo |
|---|---|---|---|
| H1 | 3608b4e | `tests/pool-live.test.ts` «H1: tras fab retry…» | sí |
| H2 | 3608b4e | `tests/pool-live.test.ts` «H2: … error transitorio…» | sí |
| B8 | 3608b4e | `tests/pool-live.test.ts` (A6: `toBe(before.g + 1)`) | n/a (endurece un test) |
| M1 | fcee966 | `tests/pool-live.test.ts` «M1: un pool sin --live…» | sí |
| M2 | fcee966 | `tests/pool-live.test.ts` «M2: un huérfano con un report…» | sí |
| M5 | fcee966 | `tests/pool-live.test.ts` «S4/M5: … el pool falla (sin commits) se descarta…» | no: lo cubría ya la guarda por texto de error; el test fija el nuevo mecanismo (el descarte vive en `failLive`) |
| B3 | fcee966 | `tests/pool-live.test.ts` «B3: el pool crea el AdmissionDb una vez…» | sí |
| B4 | fcee966 | `tests/pool-live.test.ts` «B4: --live con un adaptador sin backend vivo…» | sí |
| M3 | e49118e | `tests/t12-correcciones.test.ts` «M3…» | sí |
| M4 | 69fd247 | `tests/t12-correcciones.test.ts` «M4…» | sí |
| B1 | 69fd247, test reescrito en el commit siguiente | `tests/t12-correcciones.test.ts` «B1…» (caída en `signal-created`, punto previo al arreglo, entre registrar la decisión y aplicarla) | sí: con `git checkout 69fd247~4 -- src/` falla (el gate recalculado no halla la etiqueta y no crea el change); con HEAD pasa |

Cómo se cerró cada uno:
- **H1**: `planTurn` recibe el historial del change y toma el motivo (error salvo orfandad, comentario del revisor) de la activity previa más reciente que lo tenga, cortando en una activity completada del mismo tipo.
- **H2**: `markAnswerDelivered` pasa de `onSpawn` al cierre del turno con resultado. Coste: si el pool muere con el agente ya servido, la respuesta se reenvía una vez más (entrega «al menos una vez»).
- **M1**: sin `--live`, una activity con sesión lanzada, respuesta pendiente o report guardado queda `blocked` con `LIVE_SESSION_REQUIRED`.
- **M2**: `Store.requeueOrphans(ws, nowIso, keep)`; el pool pasa un filtro por report pendiente. La activity vuelve a `pending` sin gastar reintento y con error de orfandad.
- **M5**: `planTurn` aplica siempre el report pendiente; `failLive` (pool) lo marca aplicado en la misma transacción que `failActivity`. Ya no depende del texto de `activity.error`.
- **M3**: `buildValidatorPrompt` acepta `untrusted`/`nonce`; el pool lo activa con `isChannelChange`. El prompt por defecto no cambia (golden de `profile.test.ts`).
- **M4**: en `auto` el residente lee comentarios siempre.
- **B1**: `admit` aplica la decisión ya registrada para el trigger y solo consulta el gate si no la hay (nuevo `CrashPoint` `decision-recorded`).
- **B3**: un `AdmissionDb` por `runPool`. **B4**: aviso al arrancar.

### Documentado, no cambiado
- **B5**: `model` es siempre `null` en `SessionMeta` (`src/live/turn.ts`): S3 cuenta el cambio de modelo como pérdida de sesión, pero hoy no se detecta; solo cambia la sesión si cambia `profile_digest`. Se arreglará cuando el perfil o el backend exponga el modelo real.
- **B6**: marcar la sesión lanzada antes de lanzar (A8) convierte un fallo de arranque transitorio (`bwrap`, `claude` que no arranca) en «sesión perdida» en el reintento: evento y una generación del tope gastada. Es el coste aceptado de A8; roza la letra de S3 («un error transitorio nunca abre sesión nueva»).
- Sin tocar, de la verificación: B2 (el test de la frontera 5 solo ejerce el Store), B7, B9, B10.

### Comprobaciones
- `bun run typecheck` → limpio.
- `bun test tests` → `1384 pass / 2 skip / 0 fail, 7913 expect(), 138 files [302.71s]`.

<!-- FIN -->
