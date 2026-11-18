# Brief T15: `isBusyError` no debe confundir un mensaje con «busy» con un bloqueo de la base

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase0`, rama `fix/t15-isbusyerror`, base `origin/release/0.1.0-rc.12` (`5c4a9ac`). Trabaja **solo** ahí. `node_modules` ya está enlazado; no lo toques.

## Defecto
`src/store.ts:57-60`:

```ts
return (err as any).code === 'SQLITE_BUSY' || /database is locked|busy/i.test(err.message);
```

La parte `|busy` toma por bloqueo de SQLite **cualquier** error cuyo mensaje contenga «busy». Por ejemplo, un error de git con una ruta `busy-state/…`, o «device or resource busy» de un `rm`.

Verifica primero el efecto en sus llamadores:
- `src/store.ts:299` (`withRetry`): reintenta como si fuera contención;
- `src/pool.ts:104`: el latido lo tolera;
- `src/pool.ts:371`: preserva la activity y la reencola en lugar de fallarla;
- `src/pool.ts:436`, `448` y `460`.

El resultado es que un error no transitorio se reintenta o se reencola indefinidamente. Lo detectó Codex en T10, que tuvo que anteponer `WorktreeNeedsRepair` y renombrar una ruta de test para esquivarlo.

## Qué hacer
1. **Comprueba qué errores reales produce `bun:sqlite`** ante contención, con `code`, `errno` y mensaje. Créalos de verdad en un test con dos conexiones y una transacción `IMMEDIATE` abierta; no lo supongas. Cubre también `SQLITE_BUSY_SNAPSHOT` y `SQLITE_LOCKED` si aparecen.
2. **Reconoce solo esos errores**: por `code`, o por el mensaje exacto de SQLite (`database is locked`, `database table is locked`, …), nunca por una palabra suelta. Arreglo mínimo y en `isBusyError`, que es la capa dueña.
3. **Revisa todos los llamadores** (`graft callers isBusyError`). Si alguno dependía del comportamiento laxo, dilo en el informe.
4. **Retira el rodeo de T10** si sobra: la ruta `busy-state` en `tests/pool.test.ts` y el orden `!(err instanceof WorktreeNeedsRepair) && isBusyError(err)` en `src/pool.ts:371`. Si alguno debe quedarse, justifícalo.

## Tests
- Un `SQLITE_BUSY` real, provocado con dos conexiones, se reconoce.
- `Error('git failed at /tmp/busy-state/x')` y `Error('EBUSY: resource busy or locked')` no se reconocen.
- En el pool, una activity cuyo error contiene «busy» en una ruta falla o bloquea según su tipo, y no se reencola en bucle.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- **Prohibido:** tocar otros worktrees o el repo principal (salvo tu informe), hacer commit, push o merge, o lanzar subagentes.
- **Comprobaciones:**
  - **antes de editar:** `bun test tests`; guarda la salida;
  - **al terminar:** `bun run typecheck`, tus tests y otra vez `bun test tests`. La suite no debe empeorar.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/cortas/t15.md` e incluye:
- el defecto, con la cita `ruta:línea`;
- los errores reales de SQLite que observaste;
- qué cambiaste;
- los llamadores revisados;
- los comandos que ejecutaste, con su salida pegada;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
