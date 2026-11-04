# Tarea ola 2 — complejidad media: F1 SQLITE_BUSY → 03 threatmon → 08 sonda

Repo: /home/orlando/Desktop/factory/sw-factory-ola2-agy (rama `fab/research-ola2-agy`, base `main@0db0893`).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2, §3 "Ola 2" (F1) y §4 fichas **03** y **08**. Léelas enteras. Contexto: /home/orlando/Desktop/factory/sw-factory/docs/research/runs/2026-10-30-ola1/resultado.md. ESF (MIT) /home/orlando/Desktop/factory/ext/esf @d901657; para 03 cita `internal/threatmon/rules.go@d901657` y reimplementa en TS, sin copiar.

Orden: **F1 → 03 → 08**. Commit por tarea.

## Propiedad
Tuyos: transacciones y reintentos del store (`src/store.ts`, conexión y `claimActivity`/`heartbeat`/`completeActivity`/`failActivity`/`requeueOrphans`), el bucle del pool para F1, un módulo nuevo de threatmon y el estado `quarantined`, y `src/sandbox/`/motor `native` para 08.
En paralelo: codex hace 04 (manifest en transiciones terminales, `fab merge`, `publish.ts`) y opencode agents-verify, F2 (`ensureWorktree`/`base_sha`) y F3. No toques `src/cli.ts` salvo para mostrar `quarantined` en `inbox`, ni `publish.ts` salvo para que `quarantined` impida el merge, ni `ensureWorktree`.

## Puntos clave
- **F1:** un `database is locked` no debe fallar la activity ni consumir reintentos. Revisa `busy_timeout`, WAL y que las escrituras usen transacciones `IMMEDIATE` cortas; reintenta con backoff acotado la operación de store, no la activity. Nada de timing incidental en los tests: fuerza el lock con una segunda conexión que lo mantiene.
- **03:** entrada = stdout y stderr completos antes de truncar, más el diff de la rama incluido lo no rastreado (`git status --porcelain -uall`). Hallazgo ≥ `high` → change `quarantined` antes de validar, terminal, impide el merge, aparece en `inbox` y se resuelve con `retry` o `reject` como `blocked`. Declara en el código que es post-hoc.
- **08:** solo motor `native`: antes de la primera herramienta de red, sonda dentro del mismo `wrapCommand` con control positivo; deja `{reachable, decided}` disponible (codex lo meterá en el manifest de 04; expón un campo o evento).

## Tests obligatorios
F1: lock mantenido por otra conexión durante una completeActivity → la activity termina sin consumir reintento; `bash scripts/e2e/ola0-races.sh 10` (está en la rama `fab/research-ola0-e2e`, worktree /home/orlando/Desktop/factory/sw-factory-ola0-e2e; ejecútalo con `E2E_CLI_DIR=<tu worktree>`) → 0 `database is locked` y 0 reclamaciones repetidas. 03: 10 transcripciones adversas detectadas y 0 falsos positivos sobre las salidas limpias de la suite. 08: sonda con red cortada → `reachable:false`, con control positivo que demuestra que la sonda funciona.

## Verificación y entrega
`bun test` y `bunx tsc --noEmit` en verde (base 805). Commits en español **sin `Co-Authored-By`**, sin merge ni push. Reporte a medida que avanzas en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola2-agy.md (cambios archivo:línea, tests, medición de carreras, decisiones).
