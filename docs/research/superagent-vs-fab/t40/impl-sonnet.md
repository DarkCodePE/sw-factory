# T40: `claude --resume` confinado, informe

## Qué cambié
- `src/sandbox/confine.ts:17` — `confineAgent` acepta un 5.º parámetro `claudeProjects?: string`. Solo en la rama `name === 'claude'` crea ese directorio (0700) y lo monta rw en `/home/agent/.claude/projects` (junto al bloque de credenciales). Nada más del HOME se monta.
- `src/agents.ts` (`runAgent`) — nueva opción `claudeProjects` que se pasa a `confineAgent`.
- `src/live/claude.ts` (llamada a `runAgent`) — pasa `join(dir, 'claude-projects')`, con `dir` = `<git-dir>/fab-live` (la misma ruta de `configDir`). Es por worktree: no se comparte entre changes ni con el `~/.claude` del host.
- Solo turnos vivos de claude: el camino de un disparo y codex/fake/simulated no pasan la opción, así que no cambian.
- Commit en `fix/t40-resume-confinado`, en español, sin `Co-Authored-By`.

## Tests (`tests/sandbox-confine.test.ts`, al final)
- `claudeProjects persists ... across confined calls`: dos llamadas confinadas sucesivas; la 2.ª lee lo que escribió la 1.ª. **Falla sin el arreglo** (comprobado revirtiendo `src`).
- `without claudeProjects nothing persists`: sin la opción cada llamada tiene HOME nuevo y no se crea `fab-live`. Pasa con y sin arreglo, por diseño (guarda la regresión contraria).
- Ambos usan `skipIf(!canConfine)` como el resto del fichero.

## Prueba real (b2.ts con SRC al worktree, `claude` real)
- Turno 1: investigación en `awaiting`; respuesta «rojo»; turno 2 con `--resume 5a33d244-…` → exit 0, sin «No conversation found».
- `adm_sessions`: `investigation|1|5a33d244…` e `implementation|1|99edf56c…`: una sola generación por tipo.
- Rama con commit `Add color.txt with color rojo`. El `claude-projects` existe bajo `.git/worktrees/<n>/fab-live/`.
- El script falló al final solo por su consulta `SELECT … launched` (columna inexistente); no afecta al resultado. No lo corregí.

## Comandos
- `bun run typecheck`: limpio.
- `bun test tests` (final): 1389 pass, 2 skip, 0 fail (1391 tests, 138 ficheros).
- Una primera pasada dio 1 fail que no identifiqué (salida cortada con `tail`); la repetición completa dio 0 fail. Posible flaky, no investigado.

## Qué no hice
- No hice push, merge ni escribí en GitHub; sin subagentes.
- No limpio el directorio `claude-projects` al terminar el change (crece con los transcripts; se va con el worktree).
- No cubro la ruta fuera de git (`tmpdir()/fab-live` de `configDir`) con un montaje persistente distinto.
- Usé `git stash` una vez (apply inmediato) para el test de «falla sin arreglo`; el stash quedó vacío.

## Correcciones tras verificación (verif-fable.md)

Commit nuevo sobre `2304ca2`, en español y sin `Co-Authored-By`.

- **H1 y H2 (críticos):** `claude-projects` ya no está en el git dir. El pool lo pasa por `LiveTurn.claudeProjects` (`src/live/contract.ts`, `src/live/turn.ts`) con valor `<stateDir>/live/<id-corto>/claude-projects` (`src/pool.ts`, llamada a `runLiveActivity`). `src/live/claude.ts` solo lo reenvía. En `src/sandbox/confine.ts` se calcula `realpathSync` del directorio y se falla cerrado («escribible») si cae dentro del worktree o de un git dir montado en escritura; se monta la ruta real. Test de regresión del symlink: `tests/sandbox-confine.test.ts` («inside a writable mount… fails closed»), que cubre la ruta dentro de `.git` y un symlink hacia ella. Límite conocido: la comprobación y el montaje no son atómicos, pero con el directorio fuera de los montajes escribibles el agente ya no puede alterarlo.
- **H3:** `tests/live-claude.test.ts` («T40: cableado…»): dos `claudeLive.run` confinados seguidos con `claude` falso; el segundo lee lo que escribió el primero. Para que el falso del PATH llegue al sandbox cambié `Bun.which(argv[0])` por `Bun.which(argv[0], { PATH: process.env.PATH })` en `confine.ts`, igual que ya se hacía con `bwrap` (antes ejecutaba el `claude` real y gastó unos tokens en una pasada de depuración).
- **H6:** `src/worktrees.ts`, `mergeAndCleanup` y `removeWorktree` borran `<stateDir>/live/<id-corto>`. Test: `tests/worktrees.test.ts` (merge). `removeWorktree` lleva la misma línea pero no tiene test propio.
- **H5 (anotado, aceptado):** todo lo que claude guarde bajo `~/.claude/projects` persiste, no solo el transcript (p. ej. memoria por proyecto). Queda dentro del mismo change; no comprobé con claude real qué más lee de ahí.
- **H4, H7:** desaparecen con el movimiento fuera del git dir. **H8:** fuera de alcance (symlink sobre `fab-live` y `mcp-<uuid>.json`); conviene tarea aparte.

### Pruebas
- Mutaciones (copia de seguridad en el scratchpad, sin `git stash`): sin el chequeo de realpath falla el test del symlink; sin el reenvío en `claude.ts` falla el de cableado; sin el borrado falla el de worktrees.
- `bun run typecheck`: limpio. `bun test tests`: 1391 pass, 2 skip, 0 fail.
- `b2.ts` repetido con `claude` real: sin «No conversation found»; `adm_sessions` con una generación por tipo; los transcripts quedan en `<stateDir>/live/<id>/claude-projects` y el git dir solo tiene `fab-live` (vacío de transcripts).
- No comprobé en esta pasada `--resume` en el cmdline del proceso (el script no lo capturó).

## Tras la segunda verificación

Commit nuevo solo de tests (sin cambios en `src/`).

- **N1:** `tests/pool-live.test.ts` («T40: el turno vivo recibe claudeProjects…»): con backend vivo falso, `turns[0].claudeProjects` es `<stateDir>/live/<id-corto>/claude-projects`.
- **N2:** `tests/worktrees.test.ts`: el test de `removeWorktree` crea `<stateDir>/live/<id>` y comprueba que se borra.
- **N4:** `tests/live-claude.test.ts`: el test de cableado borra su `live-state-*` en el `finally`.
- **Mutaciones** (copias en el scratchpad, sin `git stash`; restauradas después): sin la línea de `src/pool.ts` falla N1; sin `claudeProjects: ctx.claudeProjects` en `src/live/turn.ts` falla N1; sin el `rmSync` de `removeWorktree` falla N2.
- `bun run typecheck` limpio; `pool-live`, `worktrees`, `live-claude` y `sandbox-confine`: 51 pass, 0 fail. No repetí la suite completa (solo cambian tests).

<!-- FIN -->
