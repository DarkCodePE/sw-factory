# Backend vivo `claude` (informe)

Worktree `sw-factory-live-claude`, rama `feat/live-claude`, base `ce84fc4`. Sin commit.

## Qué hice
- `src/live/claude.ts`: `claudeLive: LiveBackend` (`confinable: true`). Un `claude -p` por turno.
  - Turno nuevo: `--session-id <uuid generado>`; reanudado: `--resume <id>` (flags verificados con `claude --help`).
  - Reutiliza el adaptador `claude` de `src/agents.ts` (`getAgent('claude').command`, con su `parse` de `--output-format json`) y `runAgent` tal cual: envuelvo el adaptador con un `command` que añade flags. **`runAgent` no se ha modificado.**
  - Tool `report`: `createSdkMcpServer` (MCP HTTP en 127.0.0.1, bearer, uno por turno, cerrado en `finally`). Se pasa con `--strict-mcp-config --mcp-config {"mcpServers":{"fab":…}}` y se permite con `--allowedTools mcp__fab__report`. El esquema (`REPORT_SCHEMA`) lo valida el servidor MCP; el handler añade la regla «`awaiting` exige `human_action`». Un report inválido devuelve `isError` al agente y no entra en `reports`.
  - Id inexistente con `--resume`: `claude` sale con 1 y `No conversation found with session ID: …` → `SessionNotFoundError` (también bajo confine, donde `runAgent` lo envuelve en un `Error`).
- `src/sandbox/confine.ts` (único cambio fuera de `src/live`): bind opcional `FAB_CLAUDE_SESSIONS_DIR` → `/home/agent/.claude/projects` (ver abajo). Sin la variable, comportamiento idéntico.
- `tests/live-claude.test.ts`: 6 unitarios (argv nuevo/reanudado, `SessionNotFoundError`, report válido e inválido por HTTP real contra un `claude` falso en PATH, abort, regla de `human_action`) + 1 live (`FAB_LIVE_TEST=1`; `FAB_LIVE_CONFINE=1` lo ejecuta confinado). Modelo: `ANTHROPIC_MODEL` por defecto `haiku`.

## Comandos y resultado
```
$ claude -p hola --resume 11111111-2222-4333-8444-555555555555 --output-format json
No conversation found with session ID: 11111111-…   (exit=1)

$ bun test tests/live-claude.test.ts
 6 pass / 1 skip / 0 fail

$ FAB_LIVE_TEST=1 bun test tests/live-claude.test.ts          # sin confinar
 7 pass / 0 fail   [15.15s]

$ FAB_LIVE_TEST=1 FAB_LIVE_CONFINE=1 bun test tests/live-claude.test.ts   # bwrap, sin FAB_CLAUDE_SESSIONS_DIR
 turno 1 OK (report awaiting llegó por 127.0.0.1 dentro de bwrap)
 turno 2: SessionNotFoundError … No conversation found   <- HOME tmpfs borrado entre turnos

$ (mismo, con FAB_CLAUDE_SESSIONS_DIR, ya en el test)
 7 pass / 0 fail   [11.44s]

$ bun run typecheck      -> limpio
$ bun test tests         -> 1065 pass / 1 skip / 2 fail (1.ª pasada)
```
Suite completa: los fallos **no son estables** y no tocan este cambio. 1.ª pasada: `agent.test.ts` «interrupted tool snapshots are refused…» y otro; 2.ª pasada: «host pause resumes an owned validator…» y «corrupt final record… 10000 records» (timeout 30 s). `tests/agent.test.ts` solo: 23 pass. Parecen flakes por carga. **No comparé contra `ce84fc4` limpio** (no corrí la suite en un árbol sin mis cambios).

## El problema difícil (confine)
- `bwrap` funciona aquí (`/usr/bin/bwrap`). `confine.ts` no usa `--unshare-net`, así que 127.0.0.1 es accesible: verificado en el live confinado.
- `confine.ts` añade al final `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Con mi `--mcp-config` anterior, el `report` sigue disponible (demostrado empíricamente: el turno 1 confinado registró el `awaiting`); `claude` fusiona ambas configs. No es una garantía documentada; si una versión futura hace «gana la última», habrá que omitir el vacío cuando el argv ya trae `--mcp-config`. No probé que otros MCP del host estén ausentes (se confía en `--strict-mcp-config` + `--setting-sources ''`).
- **Reanudar bajo confine**: el HOME es un tmpfs nuevo por turno, así que el transcript de `~/.claude/projects/<cwd>` se pierde y el turno 2 da `SessionNotFoundError`. Solución implementada: el llamador fija `FAB_CLAUDE_SESSIONS_DIR` a un directorio persistente (por intento/tarea) y `confine.ts` lo monta en `/home/agent/.claude/projects`. El cwd debe ser la misma ruta entre turnos (el directorio de sesión se deriva del cwd).

## No funciona / no probado
- El test «`confine: true` lanza si `confinable` es false» no aplica a este backend (es `confinable: true`); lo cubre el de `native`. Aquí solo se verifica que bajo confine se lanza el error de `confine` si falta bwrap/git (no probado sin bwrap).
- Sin `--permission-mode`/herramientas extra para el turno live: se heredan las del adaptador `claude`.
- Coste/uso: vienen de `parse` (no los comprobé en la salida live).
- Concurrencia de dos turnos sobre la misma sesión: no probada.

## Decisiones que afectan al otro backend / contrato
- Contrato sin cambios. `LiveTurn` no tiene campo de modelo; usé `ANTHROPIC_MODEL` (confine ya lo deja pasar).
- Convención de tool: servidor MCP `fab`, tool `report`; nombre visible para claude `mcp__fab__report`. `native` puede usar el mismo servidor/regla (`checkReport`, hoy exportada de `src/live/claude.ts`; conviene moverla a un módulo común al integrar).
- El pool, al integrar, debe pasar el mismo `cwd` y un `FAB_CLAUDE_SESSIONS_DIR` estable por sesión.

<!-- FIN -->
