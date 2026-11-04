# Tarea ola 1 — codex (06 BLOCKED, 09 actor y motivo, 02 integridad)

Repo: /home/orlando/Desktop/factory/sw-factory-ola1-codex (rama `fab/research-ola1-codex`, base `main@7783845`, ola 0 ya integrada).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2 (reglas), §4 fichas **06**, **09**, **02** y §5 (tests que cambian). Léelas enteras antes de empezar; son el contrato. Referencia ESF (MIT): /home/orlando/Desktop/factory/ext/esf @d901657 — cita `ext/esf/<archivo>@d901657` en el commit si te inspiras en algo concreto. No copies código.

Orden obligatorio: **06 → 09 → 02** (02 usa el estado `blocked` de 06 y el actor de 09).

## Propiedad de archivos
Puedes tocar: `src/store.ts`, `src/pool.ts`, `src/worktrees.ts`, `src/cli.ts`, `src/tui.ts`, `src/validators/*.ts`, `src/prompts.ts` y sus tests (`tests/*.test.ts`), más tests nuevos.
Otro agente (agy) implementa la ficha **07** en paralelo y es dueño de: `claimActivity`, `heartbeat`, `completeActivity` (solo la barrera de estado terminal), `requeueOrphans`, leases y `runAgent` en `src/agents.ts`. **No toques esas funciones ni `src/agents.ts`.** Si 06 necesita cambiar `completeActivity`/`failActivity` para el estado `blocked`, hazlo en la mínima superficie y descríbelo en el reporte para que yo resuelva el conflicto al integrar.

## Puntos clave (resumen; la ficha manda)
- 06: solo `run.status.kind === 'blocked'` (ola 0, D3) es terminal; `missing` sigue reintentando. Estado `blocked` en activity y change. `fab inbox` lista los blocked con razón completa. Se resuelve con `fab retry` o `fab reject`. TUI: color y `r` sobre `blocked` (y sobre `implemented` con validador agotado, hueco detectado en ola 0). Validador `blocked` bloquea el merge.
- 09: `addColumn('events','actor','TEXT')`, actor = `$FAB_ACTOR ?? os.userInfo().username`. `decline` exige comentario en CLI y TUI (la etiqueta del input en `tui.ts` hoy es fija "comentario:"). Auditar con actor `merge --force`, `reject`, `gate allow`.
- 02: `protected_paths` con lista por defecto (no vaciable sin `--protect-none`), `base_sha` guardado en el change al crear el worktree, comparación base/disco/HEAD, symlinks como enlace, tras implementación y tras cada validador. Bloqueo `GATE_TAMPERED: <rutas>`. `fab gate allow <changeId> <ruta…> --comment <motivo>` con evento y actor, re-basa esas rutas, reencola e invalida validaciones previas.
- Esquema: usa siempre el helper `addColumn` (D8) e INSERT con columnas nombradas (D1).
- Sin dependencias nuevas, sin abstracciones que nadie pidió.

## Tests obligatorios
Los de las fichas (06: fake `FABRICA_FAKE_STATUS='blocked - x'` → 1 sesión, no 3; 02: 6 manipulaciones detectadas, 10 limpios sin falsos positivos, `gate allow` auditado pasa; 09: evento con actor y decline sin comentario rechazado). Actualiza los tests de §5 marcados 06.

## Verificación
`bun test` y `bunx tsc --noEmit` en verde (línea base: 762 pass). Además un `fab` real con agente `fake` sobre una copia de `examples/toy-calc` en /tmp que muestre: un change blocked en `fab inbox`, y un change que edita un test bloqueado por `GATE_TAMPERED` y desbloqueado con `gate allow`. Pega los comandos y la salida en el reporte.

## Entrega
- Commits pequeños en español, uno por ficha como mínimo. **Sin `Co-Authored-By`.** No hagas merge, push ni toques otras ramas.
- Reporte en `/home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola1-codex.md`: cambios (archivo:línea), salida resumen de tests y tsc, la sesión fab real, decisiones y dudas, y qué toca de `store.ts`/`pool.ts` que pueda chocar con 07.
