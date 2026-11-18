# T41 — informe del implementador (Sonnet 5.5)

Rama `fix/t41-fab-live-symlink`, commit `11011ab`. Sin push ni merge.

## Qué cambié y dónde
- `src/pool.ts`: pasa `mcpConfigDir = <stateDir>/live/<id-corto>/mcp` al turno, igual que `claudeProjects`.
- `src/live/turn.ts`, `src/live/contract.ts`: `mcpConfigDir` viaja por `LiveActivityCtx` y `LiveTurn`.
- `src/live/claude.ts` (`configDir(turn)`): la config con el token se escribe en `mcpConfigDir`, no en `<git-dir>/fab-live`. Se borra al terminar el turno, como antes.
- `src/agents.ts`: `runAgent` pasa `options.mcpConfig` a `confineAgent`.
- `src/sandbox/confine.ts`: con `mcpConfig`, resuelve la ruta real y falla cerrado si cae en un montaje escribible (misma comprobación `writable` que `claudeProjects`). La monta con `--ro-bind` en `/opt/fab-mcp/mcp.json` y sustituye la ruta del host en el argv por esa ruta fija.

**Decisiones:**
- Confinado y sin `mcpConfigDir`, el backend lanza error y no ejecuta nada. Así un llamador nuevo no vuelve al directorio inseguro sin darse cuenta.
- Sin confinar, el comportamiento no cambia: sigue usando `<git-dir>/fab-live`. No hay sandbox del que defenderse y `git status` lo ignora.
- `--strict-mcp-config` y `--mcp-config` siguen una sola vez cada uno. El camino de un disparo, codex, fake y simulated no se tocan.
- T34 sigue abierta: la ruta sigue en argv, ahora la fija del sandbox cuando se confina.

## Tests
| Test | Fichero | Sin el arreglo |
|---|---|---|
| Regresión del symlink: `fab-live` es symlink a una víctima, turno confinado; la víctima queda vacía, la config se ve en `/opt/fab-mcp/mcp.json`, no se puede escribir y se borra al final | `tests/live-claude.test.ts` | falla |
| Confinado sin `mcpConfigDir` falla cerrado y no lanza nada | `tests/live-claude.test.ts` | falla |
| Cableado pool → turno: `backend.turns[0].mcpConfigDir` | `tests/pool-live.test.ts` | falla |
| `confineAgent`: ro-bind, ruta fija sustituida en argv, y falla cerrado dentro del git dir | `tests/sandbox-confine.test.ts` | falla |

El test T40 existente pasa ahora `mcpConfigDir`, porque confinado lo exige.

Mutaciones en copia temporal, sin `git stash`; cada una mata al menos un test:
1. `configDir` ignora `mcpConfigDir`: mueren el test del symlink y el de T40.
2. Quitar la línea de `pool.ts`: muere el de cableado.
3. Quitar `mcpConfigDir` en `turn.ts`: muere el de cableado.
4. Quitar `mcpConfig: path` en `claude.ts`: muere el del symlink.
5. Quitar la comprobación `writable` en `confine.ts`: muere el de `confineAgent`.
6. Cambiar `--ro-bind` por `--bind`: muere el del symlink (la escritura funcionaría).
7. Quitar el fallo cerrado sin `mcpConfigDir`: muere el de fallo cerrado.

No ejecuté los tests contra el código original de `main`. La mutación 1 reproduce ese comportamiento: el host vuelve a `fab-live`, donde el symlink apunta a la víctima.

## Prueba real
`b2.ts` con `SRC` apuntando a este worktree, `claude` real y confinado (el pool lo confina porque el change es de canal):
- Turno 1: `report` con `awaiting` y su pregunta.
- Se responde «rojo».
- La sesión se reanuda, se implementa, y la rama tiene el commit «Add color.txt with color rojo».
- Los gates y las revisiones pasan.
- Tras el run no queda ningún `mcp-*.json` ni `fab-live`. Existen `state/live/<id>/mcp/` (vacío) y `claude-projects/`.

## Comandos
- `bun test tests/live-claude.test.ts tests/pool-live.test.ts tests/sandbox-confine.test.ts`: 40 pass, 1 skip.
- `bun run typecheck`: limpio.
- `bun b2.ts <dir-temporal>` (script copiado con `SRC` cambiado): ver arriba.
- `bun test tests` (suite completa, una vez): 1409 pass, 2 skip, 0 fail.

## Lo que no hice
- No toqué T34: la ruta sigue en argv.
- No comprobé `stateDir` dentro del worktree más allá de la comprobación `writable` que ya hace `confineAgent`.
- Dejé un segundo `b2.ts` lanzado por error en segundo plano. Lo maté, pero pudo consumir unos segundos de modelo.


## Correcciones tras verificación

Commit nuevo sobre `11011ab`. H5 y H6 no se tocan, como se pidió.

- **H1 y H7 (misma causa).** Nueva `hostDir(dir, cwd)` en `src/sandbox/confine.ts`: crea el directorio, exige `realpath(dir) === resolve(dir)` (ningún symlink en la ruta) y que no caiga en un montaje escribible; si no, falla cerrado. Para obtener los montajes escribibles extraje `writableMounts()` de `confineAgent`. La usan:
  - `claude.ts`, antes de escribir la config MCP;
  - `confineAgent`, para `claudeProjects` (antes de montarlo) y para el directorio de `mcpConfig`.
- **H2.** El test de `confineAgent` ahora afirma `exitCode === 0`.
- **H3.** `confineAgent` sustituye todas las apariciones de la ruta en argv y lanza error si `mcpConfig` viene y no está. La forma `--mcp-config=<ruta>` sigue sin reconocerse: el único llamador usa argumentos separados.
- **H4.** Quitado el respaldo `<git-dir>/fab-live`. `mcpConfigDir` es obligatorio siempre, confinado o no, y falla antes de lanzar nada. Consecuencia: `hostDir` resuelve el git dir de `cwd`, así que el `cwd` tiene que ser un repo git. Los tests de `live-claude`, `live-report` y `live-sessions` ahora hacen `git init` y pasan `mcpConfigDir`.

**Tests nuevos o cambiados:**
- `live-claude`: `stateDir` dentro del git dir y `mcp/` cambiado por un symlink a una víctima; el turno falla, confinado o no, y la víctima queda vacía.
- `live-claude`: sin `mcpConfigDir` falla, confinado o no, y no existe `fab-live`.
- `sandbox-confine`: `claude-projects` dentro del git dir y cambiado por un symlink a una víctima falla y no escribe `PWNED`.
- `sandbox-confine`: `mcpConfig` con la ruta dos veces, ausente del argv, dentro de un montaje escribible y bajo un symlink.

**Mutaciones** (copia temporal, sin `git stash`); cada una mata al menos un test:
- quitar la comprobación de symlink: mueren 3 tests;
- quitar la comprobación `writable`: 2;
- no llamar a `hostDir` para `mcpConfig`: 1;
- no llamar a `hostDir` para `claudeProjects`: 3;
- quitar el error por ruta ausente: 1;
- volver a `indexOf` (solo la primera aparición): 1;
- `--bind` en lugar de `--ro-bind`: 2;
- `claude.ts` sin `hostDir`: 7;
- quitar la exigencia de `mcpConfigDir`: 1;
- quitar la línea del pool: 1.

**Comandos:** `bun run typecheck` limpio; `bun test tests`: 1411 pass, 2 skip, 0 fail (una vez al final; una pasada intermedia mostró 2 y luego 1 fallo en `live-report` y `live-sessions`, ya corregidos).

**Lo que no hice:**
- No repetí la prueba real con `claude` ni `b2.ts` tras estos cambios.
- `hostDir` hace `mkdir` antes de comprobar. Con un symlink colgante, ese `mkdir` puede crear un directorio vacío en el destino, pero el turno falla después y no se escribe nada.
- Si `stateDir` pasa por un enlace simbólico legítimo, ahora falla cerrado.

<!-- FIN -->
