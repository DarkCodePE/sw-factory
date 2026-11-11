# Síntesis EGM, ronda 2: robustez de la fab y estrategia de mitkox

Elefante: Claude Opus 5.5, 2026-11-10. Brief: `BRIEF.md`. Commits: fab `ce84fc4`, superagent `8c32a9d`, copilot-superagent `693f4db`, ESF `e5567fb`, dsh-herdr `2d74cf8`, harness `fcc0ad4`. Todos los repos se actualizaron con `git pull` antes de lanzar la ronda; ninguno había cambiado.

| Revisor | Modelo | Rol EGM y foco | Veredicto sobre la página 06 |
|---|---|---|---|
| `fable.md` | Claude Fable 5.2 | design_critic + codebase_details; doble verificación | **cambia** |
| `codex.md` | GPT-6-Astra | codebase_details + implementation_readiness; P1 | **cambia** |
| `pi.md` | Sonnet 5.5 (pi) | codebase_details + comprehension; P2 | **se mantiene la dirección**, cambian criterios y citas |
| `agy.md` | Gemini 3.8 Flash | design_critic + inventive_catalyst; P3 | **cambia** |
| `opencode.md` | modelo gratuito por defecto | zoom_out; P3 | **se mantiene y se recorta** |

Consenso: la forma de la página 06 se mantiene (admisión delante, unión por `addSignal`/`triageSignal`, sesión reanudable). Cambian el contrato de ejecución, el orden de fases y la base de hechos sobre `native`.

## 1. P1: robustez módulo a módulo (consolidada)

| Módulo | Veredicto | Qué tomar y de dónde | Revisores |
|---|---|---|---|
| Estado y transiciones | **Mantener** `Store` | Opcional: tabla de transiciones comprobada en `setChangeStatus`. Modelo de espera conversacional inspirado en Ticket/Assignment del superagent | Fable, Codex, opencode |
| Claim, lease, huérfanos | **Mantener y endurecer** | Tope de reejecuciones al reencolar huérfanos; token por claim; clasificar «resultado desconocido» antes de reejecutar (regla de ESF: el agente no se reintenta, `workflow.go:1285-1299`) | los 4 con P1 |
| Worktrees | **Mejorar tomando copilot** | `prepare`/`ticketAt`: comprobar repo común, rama, ruta canónica, marcador `.ready`; neutralizar filtros `smudge` | Fable, Codex |
| Intake e idempotencia | **Mantener; generalizar la clave** | `(source, id externo)` antes de añadir GitHub; conflicto por huella como el turn service de ESF | Fable, Codex |
| Canal de vuelta | **Reemplazar por Outbox sobre cola de efectos** | `effects` + `outbox` del superagent, con el marcador `attempted` y la reconciliación remota de copilot (`delivery.ts:112`) | Fable, Codex; opencode lo limita al canal que se abra |
| Permisos y sandbox | **Mantener** `bwrap` | Revalidar autoridad antes y después de cada permiso (copilot `copilot.ts:188-200`); prompt por stdin (ESF) | los 5 |
| Adaptadores y sesión | **Mantener** `AgentAdapter` para un disparo; **añadir** contrato vivo | Forma de `AgentBackend` de copilot, con métodos opcionales como capacidades | los 5 |
| Prompts y política | **Mantener** `Profile` | Policy/Mandate con `policyVersion` y `revalidate` del core solo cuando haya admisión automática | Fable, Codex, opencode |
| Eventos y auditoría | **Mantener; tipar** | Columna `kind` cerrada e ids de intento y de mensaje | Fable, Codex |
| Reanudación tras caída | **Mantener** para un disparo | Para la sesión viva, `resume()` del superagent: interrumpir y seguir la sesión, no reejecutar | Fable, Codex, opencode |
| Verificación y gates | **Mantener**: es la fortaleza de la fab | Nada obligatorio | los 5 |

Ningún módulo de la fab se reemplaza entero salvo el canal de vuelta.

## 2. P2: estrategia de mitkox (consolidada)

1. **Conserva el dominio y reescribe el host.** `copilot-superagent/src/core` es el del prototipo salvo una cadena (`reasons.ts:19`, `hostRestarted`). Todo lo demás se reescribe por host, también la persistencia: SQLite en el prototipo y JSON con lock en copilot. [V: Fable, Pi, Codex]
2. **El puerto `Executor` no toca el harness.** En copilot, `start`/`deliver`/`stop` solo encolan un efecto durable (`vscode/src/runtime.ts:65-73`), y el harness se alcanza por un segundo contrato, `AgentBackend {run, assess, steer?, handoff?, abort, dispose}` (`agent-backend.ts:42-49`). Ninguna clase de copilot implementa `Executor`; `orchestration.ts` hace su papel. [V: Fable F-07, Pi E-08; re-verificado por el elefante]
3. **Hay tres contratos para tres granos de ejecución.** `Executor` + `AgentBackend` para la sesión viva (copilot); `Harness {Name, Model, Provision, Run}` para un run por lotes (ESF), equivalente a nuestro `AgentAdapter`; y el turn service de ESF para un turno con lease, eventos y `execution_id` idempotente. No hay un contrato único. [Pi E-02, Fable §5.2]
4. **La integración superagent ↔ ESF no está publicada.** Solo hay un rastro: un worker de ESF con la config `dsh-superagent-prototype/integration/esf/superagent-factory-safe.toml` sobre la cola `superagent-esf`. Aparece en un log de evidencia de otra máquina, y ese directorio no existe en el repo publicado. El cliente «sf» del turn service tampoco está en ningún repo. Es inferencia, no precedente. [V: Pi E-01, Fable F-09; re-verificado por el elefante]
5. **Herdr solo observa.** Ningún repo de mitkox lo conecta a Ticket, Mandate ni ESF. [V: Pi E-06, Codex]
6. **La fab está en la posición de ESF**, con un proceso por activity. El hueco no es el puerto `Executor`: es no tener un equivalente de `AgentBackend`. [Pi E-03, Fable §5.4]

## 3. Hallazgos que cambian la página 06

| # | Hallazgo | Sev. | Revisores | Verificado por el elefante |
|---|---|---|---|---|
| R1 | La sesión viva de `native` existe en `src/agent/rpc.ts` y `src/sdk`, pero **el pool no la usa**: el adaptador `native` lanza `fab exec` de un disparo con stdin cerrado | Alta | Fable F-04 | Sí, `src/agents.ts:134-143` |
| R2 | D2 se sustituye por dos niveles: (1) el dominio encola efectos durables en `fabrica.db`; (2) un contrato vivo con la forma de `AgentBackend`, cuyos métodos opcionales son la matriz de capacidades | Alta | Fable F-07, Pi E-04, agy H3-02, opencode ZO2-H1 | Sí, `runtime.ts:65-73@693f4db` |
| R3 | Falta la **cola de efectos** (`effects(kind, key, payload, attempts, due)`); el Outbox es un caso de ella. Sin ella, una caída entre `awaiting` y el reencolado pierde el comentario | Alta | Fable F-08, Codex CD-03 | Patrón en `superagent/src/app/effects.ts` |
| R4 | `requeueOrphans` reencola sin tocar `retry_count`; un huérfano recurrente se reintenta sin fin. Con un comando residente no hay nadie mirando | Alta | Fable F-01, Codex CD-02 | Sí, `src/store.ts:1096-1102` |
| R5 | `ensureWorktree` reutiliza cualquier ruta existente sin comprobar repo ni rama; la ruta trunca el id a 8 caracteres | Alta | Fable F-06, Codex CD-01 | Sí, `src/worktrees.ts:42` |
| R6 | Recuperar un lease no prueba que reejecutar sea seguro: hace falta identidad de intento y un estado «resultado desconocido» | Alta | Codex CD-02, Fable F-02 | Regla de ESF en `workflow.go:1285-1299`, verificada |
| R7 | Criterios mínimos del contrato vivo: `assertAuthorized` antes y después de cada permiso, prompt versionado reaplicado, `steer` idempotente por `requestId` con reconciliación, `handoff`, abort confirmado, y entrega aceptada y consumida | Alta | Pi E-05, Codex IR-02 | No |
| R8 | La fase que introduzca `awaiting` debe traer ya el Outbox y la persistencia de pregunta y respuesta. Tal como está, la página 06 la deja para la fase 3 | Alta | Codex IR-03, IR-01 | Contradicción interna de la página 06 |
| R9 | **Corrección de la ronda 1 (C9):** `bwrap` **sí** envuelve a `claude` con `--confine`; lo que se pierde es MCP y hooks. `native` no admite `--confine` | Media | Codex CD-04, Fable F-12 | Sí, `src/sandbox/confine.ts:8` |
| R10 | Prompt por argv: límite de ~128 KiB y texto no confiable visible en la lista de procesos. ESF usa `stdin_file` | Media | Fable F-05, Pi E-03 | No |
| R11 | Descartar la «capa externa» necesita un argumento: mitkox la eligió con ESF porque ESF es remoto. Un backend que solo posee el turno no crea dos dueños del change | Media | Fable F-10, Codex P3 | — |
| R12 | Unión por `addSignal`/`triageSignal` es insuficiente: la admisión también observa estados, entrega respuestas, pide stop y recibe reports. Todo debe pasar por comandos de la capa dueña | Media | Codex P3 | — |
| R13 | El gate determinista debe fijar el `scope` máximo con metadatos verificados; la salida del router no puede ampliarlo. Título y alcance generados por un LLM siguen siendo datos no confiables | Media | agy H3-03, Codex P3 | — |
| R14 | `importIssue` abre la transacción sin `withRetry` | Baja | Fable F-11 | No |
| R15 | Recorte: Mandate, Thread/Eval, Subscriptions y router general quedan en backlog hasta que haya un canal real | Media | opencode ZO2-H4 | — |

## 4. Desacuerdos

| Tema | Posiciones | Juicio del elefante |
|---|---|---|
| Base de datos | **agy H3-01**: `admision.db` aparte, porque `withRetry` bloquea el bucle con `Atomics.wait` y dejaría sin heartbeats al pool. **Fable, opencode y Codex**: misma base | **Misma base.** Verificado `store.ts:281-301`: como mucho 4 intentos con esperas de 25 a 500 ms, muy por debajo de un lease de 90 s con heartbeat cada 30 s. Una base aparte rompería la atomicidad estado + efecto, que R3 exige |
| Copiar `AgentBackend` literal | **agy**: adoptarlo tal cual. **opencode**: un puerto mínimo, sin `AgentTool` ni permisos interactivos genéricos. **Fable y Pi**: su forma, con métodos opcionales | Tomar la forma y los criterios de R7; dejar fuera `contextTools` y lo específico de VS Code |
| Alcance | **opencode**: recortar mucho. **Codex**: costura completa con fallos inyectados antes de `auto` | Compatibles: alcance pequeño, pero lo que entre debe ser completo frente a caídas |

## 5. Efecto sobre las decisiones abiertas

1. **Primer adaptador vivo.** R1 reduce la ventaja de `native`: ni `native` ni `claude` tienen hoy sesión en el camino del pool, y ambos necesitan el contrato vivo nuevo. `native` sigue sin `steer` y fuera de `--confine` (R9). `claude` tiene `steer` probado con n=1, pero bajo `--confine` pierde MCP. **Sigue abierta**; el coste de ambas opciones es ahora parecido.
2. **Base de datos.** **Misma `fabrica.db`**, por §4 y R3.
3. **Fase 1.** **Solo `would_admit`**: lo piden opencode y agy, y Codex lo acepta mientras la fase no ejecute agentes. El router queda para cuando haya un canal real (R15).

Orden de fases resultante:

| Fase | Contenido |
|---|---|
| 0 | Endurecimiento: R4, R5, R6 (token de claim), R14, R10 |
| 1 | Tabla `effects`, comando residente con lock exclusivo como despachador, admisión `observe` con `would_admit` |
| 2 | Contrato vivo (R2, R7) en un adaptador, con `awaiting` y Outbox del canal que se abra (R8). Prueba de costura completa con fallos inyectados en cada frontera |
| 3 | Router, Mandate y Subscriptions, solo con un canal real y evidencia (R15) |

## 6. No verificado

- Los escenarios de F-02, F-03, F-05 y F-06 son inferencias sin reproducción.
- `copilot/vscode/src/orchestration.ts`: cómo se drenan los efectos y con qué reintentos.
- Las guardas internas de `superagent/src/core/tickets.ts`.
- `esf/internal/turnexec` es en buena parte [D] para Pi y [V] parcial para Fable y Codex.
- El código real de la integración superagent ↔ ESF, que no está publicado.

<!-- FIN -->
