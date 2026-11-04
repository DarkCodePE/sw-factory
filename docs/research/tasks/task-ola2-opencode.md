# Tarea ola 2 — complejidad baja: agents-verify → F2 base_sha → F3 pre-commit

Repo: /home/orlando/Desktop/factory/sw-factory-ola2-opencode (rama `fab/research-ola2-opencode`, base `main@0db0893`).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §3 "Ola 2" (F2, F3) y §4 ficha **agents-verify**. Léelas.

Orden: **agents-verify → F2 → F3**. Un commit por tarea.

## Propiedad
Tuyos: un módulo nuevo (p. ej. `src/agents-verify.ts`), el subcomando `fab agents verify` en `src/cli.ts`, la comprobación al arrancar `runPool` (solo una llamada al principio), `ensureWorktree` en `src/worktrees.ts` para F2, y `scripts/e2e/` para F3. En paralelo codex (04: manifest, `fab merge`) y agy (store, threatmon, sandbox) tocan `store.ts`, `pool.ts` y `cli.ts`: no cambies nada más de esos archivos.

## Tareas
1. **agents-verify:** sha256 de los binarios `claude`, `codex`, `agy`, `droid` (resueltos en PATH) contra un pin en settings. `fab agents verify` muestra cada uno: ok, distinto, no instalado, sin pin; `fab agents verify --pin` escribe los pines actuales. Al arrancar el pool, si el adaptador del workstream tiene pin y no coincide, no arranca salvo `--accept-agent-binaries`. Sin pin → aviso, no bloqueo. Lee cómo se cargan los settings en el repo antes de inventar un formato.
2. **F2:** en `ensureWorktree`, si la rama `fab/<id>` ya existía, el `baseSha` devuelto es `git merge-base <HEAD del repo> fab/<id>`, no el HEAD del worktree. Test: rama con un commit del agente → baseSha es el commit anterior.
3. **F3:** script e2e (copia lo necesario de /home/orlando/Desktop/factory/sw-factory-ola0-e2e/scripts/e2e/) en el que una implementación deja un archivo y el pool hace commit de fábrica, con `core.hooksPath` malicioso con `pre-commit` → 0 marcadores. Contraste con `29d4dd3` → el marcador aparece.

## Verificación y entrega
`bun test` y `bunx tsc --noEmit` en verde (base 805). Commits en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola2-opencode.md con cambios, salida de tests y de F3. Escríbelo aunque algo quede incompleto.
