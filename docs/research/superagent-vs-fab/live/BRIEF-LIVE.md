# Brief: adaptador vivo (fase 2, espiga)

Implementa **un backend vivo** de la fab según el contrato `src/live/contract.ts`. Dos agentes trabajan en paralelo, cada uno en su worktree, sobre la misma base (`ce84fc4`):

| Backend | Worktree | Rama | Quién |
|---|---|---|---|
| `claude` (Claude Code CLI) | `/home/orlando/Desktop/factory/sw-factory-live-claude` | `feat/live-claude` | Sonnet |
| `native` (agente propio de la fab, `src/agent/`) | `/home/orlando/Desktop/factory/sw-factory-live-native` | `feat/live-native` | Codex |

Diseño de referencia (léelo primero): `/home/orlando/Desktop/factory/sw-factory/techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`, sobre todo §5.1 y §5.2.

## Qué significa «vivo» aquí
Es **reanudable por id, un turno por llamada**. El agente pregunta a un humano con `report(awaiting, …)`, el turno termina y el proceso sale. Cuando llega la respuesta, la fab llama a `run({ sessionId, prompt: respuesta })` y la conversación sigue en la misma sesión. Sin steer, sin proceso retenido y sin cambios en el pool.

## Contrato (fijo)
`src/live/contract.ts` está ya en tu worktree. **No lo modifiques.** Si crees que está mal, explícalo en tu informe; no lo cambies.

## Qué entregar
1. `src/live/<backend>.ts`: un `LiveBackend` exportado.
2. La tool `report` servida por la fab. Reutiliza `createSdkMcpServer` de `src/sdk/mcp-server.ts`: MCP HTTP en 127.0.0.1 con token bearer, uno por turno. Pásaselo al agente con su propio mecanismo: `--mcp-config` en claude y la config MCP del agente en native. Cada `report` válido se añade a `reports` del resultado; uno inválido devuelve error al agente.
3. Reutiliza `runAgent` de `src/agents.ts`, o su lógica de proceso, timeout y abort, en vez de duplicarla. Si necesitas un punto de extensión pequeño en `runAgent` (por ejemplo un argv distinto), añádelo sin cambiar su comportamiento actual.
4. Tests en `tests/live-<backend>.test.ts`:
   - **Unitarios, siempre, sin red ni modelo**: argv de un turno nuevo y de un turno reanudado, `SessionNotFoundError` con un id desconocido, report válido e inválido, abort, y que `confine: true` lance un error si `confinable` es false.
   - **Live, solo con `FAB_LIVE_TEST=1`**:
     - Turno 1: «Recuerda la palabra clave ÁMBAR-7. Llama a la tool report con state awaiting, pidiendo un color.»
     - Turno 2, con el `sessionId` devuelto: «Rojo. ¿Cuál era la palabra clave? Llama a report con state done.»
     - Se comprueba que `reports` tiene `awaiting` y luego `done`, que el turno 2 contiene ÁMBAR-7 y que el `sessionId` es el mismo. Usa el modelo más barato disponible.
5. Informe en `docs/research/superagent-vs-fab/live/<backend>.md`:
   - qué hiciste;
   - comandos ejecutados y resultado, pegando la salida;
   - qué no funciona o no probaste;
   - decisiones que afecten al otro backend o al contrato.

   Última línea, exactamente: `<!-- FIN -->`.

## Específico de `claude`
- Turno nuevo: `claude -p … --session-id <uuid>` (genera tú el uuid). Reanudar: `claude -p … --resume <id>`. Verifica los flags con `claude --help`; no los supongas.
- `--output-format json` da `session_id`, coste y uso; reutiliza el `parse` del adaptador `claude` actual.
- Un id inexistente con `--resume` debe dar `SessionNotFoundError`, no una sesión nueva.
- **El problema difícil**: con `confine: true`, `src/sandbox/confine.ts` vacía la config MCP (`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`). Haz que bajo confinamiento solo quede disponible el MCP `report` de la fab: `--strict-mcp-config` con tu config y nada más. `confine.ts` no aísla la red, así que 127.0.0.1 debería ser accesible; compruébalo. Si lo logras, `confinable: true`. Prueba live confinada solo si `bwrap` funciona en esta máquina.
- Las sesiones de Claude viven en `~/.claude/projects/<cwd>`. Bajo confine el HOME es un tmpfs nuevo: anota si eso impide reanudar y propón cómo resolverlo, por ejemplo con un directorio de sesiones persistente montado.

## Específico de `native`
- La sesión ya existe en `src/agent/`: `session.ts`, `rpc.ts` con `load_session`/`add_user_message`, `stream-input.ts` y el modo `exec`. Encuentra la forma más simple de un turno por llamada con `--session-id` o equivalente, y reanudar por id. Mira `src/agent/exec-flags.ts` y `src/agent/README.md`.
- La tool `report` puede inyectarse por la config MCP del agente, usando la misma `createSdkMcpServer`.
- `native` no está en `assertConfinement` (`src/sandbox/confine.ts:8`): `confinable: false`, salvo que encuentres un sandbox existente aplicable, por ejemplo `src/sandbox/wrap.ts`. Si lo encuentras, documéntalo y no lo actives sin tests.
- Para el test live usa el proveedor que funcione aquí, por ejemplo la suscripción ChatGPT vía `codex login` (`src/agent/chatgpt.ts`). Anota cuál.

## Reglas
- Trabaja **solo en tu worktree**. No toques el otro worktree ni `/home/orlando/Desktop/factory/sw-factory`, salvo tu informe en la carpeta `docs/research/superagent-vs-fab/live/` de ese repo principal.
- No modifiques `src/pool.ts` ni `src/store.ts`: la integración con el pool es otra tarea.
- No hagas commit, push ni merge. No instales dependencias. No lances subagentes.
- Antes de terminar: `bun test tests/live-<backend>.test.ts`, `bun run typecheck` y `bun test tests` (la suite completa no debe empeorar respecto a `ce84fc4`; anota los fallos previos si los hay).
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y tramos con `sed -n`; nada de grep masivos.
- Cita archivos como `ruta:línea`.
