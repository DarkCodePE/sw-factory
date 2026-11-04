# Tarea ola 0 — agy (agentes, pool y worktrees)

Repo: /home/orlando/Desktop/factory/sw-factory-ola0-agy (rama `fab/research-ola0-agy`, base `main@29d4dd3`).
Plan de referencia: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §1 (D3, D5, H2) y §4 "Ola 0".

## Archivos que puedes tocar (solo estos)
- `src/agents.ts`, `src/prompts.ts`, `src/pool.ts`, `src/worktrees.ts`
- `tests/pool.test.ts`, `tests/worktrees.test.ts`, `tests/validators-pool.test.ts`, y un test nuevo `tests/agents-output.test.ts` si lo necesitas.
NO toques `src/store.ts`, `src/validators/publish.ts` ni `src/tui.ts`: los modifica otro agente en paralelo.

## Cambios (mínimos, sin abstracciones nuevas)
1. **D3** `boundedAgentOutput` (`src/agents.ts:121-128`) antepone `STATUS: blocked - report has no STATUS line` cuando la salida supera 20 000 caracteres y no tiene STATUS. Entonces `parseReportStatus` (`src/prompts.ts:82-86`) lo ve como un bloqueo declarado por el agente. Clasifica el STATUS sobre la **salida completa antes de truncar** y devuélvelo en `AgentRun` (p. ej. `status: { kind: 'done' | 'blocked' | 'missing'; reason: string }`). `pool.ts` usa ese campo en vez de re-parsear el texto truncado. En esta ola el comportamiento del pool **no cambia** para `blocked` ni `missing` (ambos siguen siendo `failActivity` con reintento); solo la razón debe ser correcta: `missing` → `report has no STATUS line`, sin decir "blocked". El texto truncado ya no debe contener una línea `STATUS:` inventada; si conviene conservar la línea real, conserva la del agente si existe.
2. **D5** `git()` en `src/worktrees.ts:5-14` ejecuta `git` sin protección. Usa los mismos flags que `src/agent/mission-files.ts:17`: `-c core.fsmonitor=false -c core.hooksPath=/dev/null` (revisa esa línea y `src/agent/tasks.ts:131` y copia exactamente su conjunto, incluido `diff.external=` si lo usan). Revisa también las llamadas directas `Bun.spawn(['git', ...])` de `src/pool.ts` (diff --stat, status --porcelain) y aplícales los mismos flags.
3. **H2** `pool.ts:65` solo comprueba `git status --porcelain` tras el validador `qa`. Aplícalo tras **todos** los validadores (claude/agy/droid ignoran `readOnly`, así que cualquiera puede editar). Mensaje: `<validador> dejó cambios en el worktree`.

## Tests obligatorios (deben fallar en main y pasar con tu cambio)
- D3: `runAgent`/`boundedAgentOutput` con 24 000 caracteres sin STATUS → status `missing` y el texto no contiene `STATUS: blocked`. Con `STATUS: blocked - x` real → `blocked`. Con STATUS done al principio y salida larga → `done`.
- D5: en un repo temporal con un hook `post-checkout` o `pre-commit` que escribe un archivo marcador, las operaciones de `worktrees.ts` (crear worktree, commit) no lo ejecutan.
- H2: un validador distinto de qa (p. ej. `code_review` con un adaptador de test que escribe un archivo) → la activity falla con el mensaje anterior. Mira cómo los tests existentes sustituyen el adaptador (`fake` y monkey-patch).

## Verificación antes de terminar
```
bun test
bunx tsc --noEmit
```
Ambos en verde. Línea base de `main`: 751 tests, 0 fallos. Algunos tests existentes de pool pueden esperar el texto antiguo "blocked: report has no STATUS line"; actualízalos solo si el cambio de razón es el esperado y explícalo en el reporte.

## Entrega
- Commits pequeños en tu rama, mensaje en español, uno por defecto (D3, D5, H2). Sin `Co-Authored-By`.
- No hagas merge, push ni toques otras ramas.
- Al terminar, escribe un resumen en `/home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola0-agy.md`: qué cambiaste (archivo:línea), salida final de `bun test` (líneas de resumen) y `tsc`, y cualquier decisión o duda.
