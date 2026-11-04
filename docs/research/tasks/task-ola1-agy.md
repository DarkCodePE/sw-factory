# Tarea ola 1 — agy (07 exclusión por change y leases)

Repo: /home/orlando/Desktop/factory/sw-factory-ola1-agy (rama `fab/research-ola1-agy`, base `main@7783845`, ola 0 ya integrada).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2 (reglas), §4 ficha **07** y §5 (tests que cambian). Léelas enteras; son el contrato. Referencia ESF (MIT): /home/orlando/Desktop/factory/ext/esf @d901657; no copies código.

## Propiedad de archivos
Eres dueño de: `claimActivity`, `heartbeat`, `completeActivity` (barrera de estado terminal), `requeueOrphans` y el esquema de leases en `src/store.ts`; `runAgent` en `src/agents.ts`; el bucle de `runPool` en `src/pool.ts` en lo que toca a leases, heartbeat, aborto y `--once`.
Otro agente (codex) implementa en paralelo 06 (estado `blocked`), 09 (actor en eventos) y 02 (integridad) y toca `store.ts`, `pool.ts`, `cli.ts`, `tui.ts`, `worktrees.ts`. **No toques `cli.ts` salvo lo mínimo para que `fab reject` cancele y espere, ni `tui.ts`, `worktrees.ts`, `validators/`.** Describe en el reporte cada cambio en `store.ts`/`pool.ts` fuera de tus funciones.

## Puntos clave (resumen; la ficha manda)
- D6 exclusión: `claimActivity` no reclama una activity si su change tiene otra `in_progress`. Validadores de un change pasan a secuenciales.
- D7 barrera: claim, heartbeat y `completeActivity` rechazan si el change está terminal; `fab reject` cancela y espera a que el worker suelte antes de borrar el worktree.
- Lease: `lease_expires_at` (TTL 90 s, heartbeat 30 s); `requeueOrphans` solo reencola vencidos y corre en cada vuelta del bucle. Usa el helper `addColumn` (D8). Migración: activities `in_progress` existentes reciben `now + TTL`.
- Aborto real: `runAgent(..., { signal })` lanza el CLI como líder de grupo (`detached`), al abortar mata el grupo (`process.kill(-pid)`), y el lease no queda libre hasta confirmar la salida.
- Reloj inyectado para TTL; nada de timing incidental.

## Tests obligatorios
Fake lento + reloj inyectado: dos pools contra el mismo store, uno muere → 0 duplicados y recuperación ≤ 180 s (en reloj simulado); `reject` durante implementación → change cancelado y sin escrituras posteriores; `--once` no sale antes de que venza un lease; aborto mata al hijo y al nieto. Actualiza `tests/store.test.ts:151-157` y `tests/validators-pool.test.ts` según §5.

## Verificación
`bun test` y `bunx tsc --noEmit` en verde (línea base: 762 pass). Además una prueba real con dos procesos `fab run` sobre el mismo store y agente fake lento (copia de `examples/toy-calc` en /tmp): mata uno con `kill -9` y muestra que el otro recupera sin duplicar. Pega comandos y salida en el reporte.

## Entrega
- Commits pequeños en español. **Sin `Co-Authored-By`.** No hagas merge, push ni toques otras ramas.
- Reporte en `/home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola1-agy.md`: cambios (archivo:línea), salida de tests y tsc, la prueba real de dos procesos, decisiones y dudas.
