# Brief EGM, ronda 2: robustez de la fab y estrategia de mitkox

Eres un revisor **goldfish** del Elephant-Goldfish Model: no conoces la conversación previa. Juzga solo el código y los documentos que se citan aquí.

## Contexto mínimo
La fab (software factory propia) estudia incorporar el modelo de `dsh-superagent-prototype`: admisión de peticiones de un equipo, Ticket/Mandate y worker vivo. Una ronda anterior produjo un diseño, que **no debes dar por bueno**:
- `/home/orlando/Desktop/factory/sw-factory/techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`
- `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review/SINTESIS-EGM.md`

Esa ronda solo preguntó qué **le falta** a la fab. Esta ronda pregunta otras tres cosas:

- **P1. Robustez.** Para cada módulo que la fab **ya tiene**, ¿la pieza equivalente del superagent, copilot-superagent o ESF es más robusta? Responde módulo a módulo con *mantener*, *mejorar tomando X* o *reemplazar por X*. Módulos: modelo de estado y transiciones; claim, lease y recuperación de huérfanos; worktrees; intake e idempotencia; canal de vuelta, outbox y reintentos; permisos y sandbox; adaptadores de harness y sesión, steer y abort; prompts y política versionados; eventos y auditoría; reanudación tras caída; verificación y gates.
- **P2. Estrategia de mitkox.** El mismo autor (mitkox) publica `dsh-herdr`, `copilot-superagent` (un port del superagent a VS Code + Copilot SDK) y ESF (una factory en Go con Temporal y CubeSandbox). Reconstruye **cómo piensa integrar** superagent, factory, harnesses y Herdr: qué capa conserva, qué reescribe por harness, cómo se conecta el superagent con la factory y qué contrato de backend usa. Compáralo con la estrategia de adaptadores de la fab (`src/agents.ts`).
- **P3. Lo mejor de todos.** Con P1 y P2, ¿qué arquitectura debería seguir la fab? ¿Qué partes de la página 06 se confirman, cambian o caen?

## Repos (fija cada cita a su commit)
| Repo | Ruta | Commit |
|---|---|---|
| fab | `/home/orlando/Desktop/factory/sw-factory` | `ce84fc4` |
| dsh-superagent-prototype | `/home/orlando/Desktop/ia-master/dsh-superagent-prototype` | `8c32a9d` |
| copilot-superagent | `/home/orlando/Desktop/factory/ext/copilot-superagent` | `693f4db` |
| ESF | `/home/orlando/Desktop/factory/ext/esf` | `e5567fb` |
| dsh-herdr | `/home/orlando/Desktop/ia-master/dsh-herdr` | `2d74cf8` |
| deepseek-harness | `/home/orlando/Desktop/ia-master/deepseek-harness` | `fcc0ad4` |

Todos están indexados con graft.

**Pistas sin verificar**, que debes confirmar o refutar:
- Según el elefante, `copilot-superagent/src/core` coincide con el de `dsh-superagent-prototype/src/core`.
- `vscode/src/agent-backend.ts` define un `AgentBackend`.
- `esf/release/qualification/v1.0.0-rc.1.md:111` menciona «a separate superagent lane polls `superagent-esf`».
- `esf/docs/sf-turn-executor.md` describe un «sf turn service».

## Método obligatorio (fab-research, ADR-0008)
No hagas grep masivos ni leas archivos enteros a ciegas.
1. Orientación: `graft map <repo>` o `graft ask "<consulta>" <repo>`.
2. Estructura: `graft skeleton <archivo> <repo>` y `graft callers <símbolo> <repo>`.
3. Lectura: solo los tramos necesarios, con `sed -n 'A,Bp'`.
4. Cada afirmación cita `repo/archivo:línea@sha`, comprobada leyendo el código. Marca cada una como **verificado** (código), **docs** (afirmación de documentación) o **inferencia**.

## Reglas
- SOLO LECTURA: no edites nada salvo tu archivo de salida. No hagas commit, no lances subagentes y no instales nada.
- Aplica tu rol EGM leyendo `/home/orlando/Desktop/ia-master/elephant-goldfish-model/agents/<rol>.md`.
- Céntrate en las preguntas de tu foco, pero anota cualquier hallazgo grave fuera de él.
- Formato de cada hallazgo: **id**, severidad (alta/media/baja), pregunta (P1/P2/P3), afirmación, evidencia, propuesta concreta.
- Para P1, incluye una tabla `módulo | fab | mejor alternativa | veredicto | evidencia`.
- Termina con un veredicto de una línea sobre la página 06 (se mantiene / cambia / se rehace). La última línea debe ser exactamente `<!-- FIN -->`.

Escribe en español en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review2/<tu-nombre>.md`.
