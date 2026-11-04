# Tarea ola 0 — codex (store y merge gate)

Repo: /home/orlando/Desktop/factory/sw-factory-ola0-codex (rama `fab/research-ola0-codex`, base `main@29d4dd3`).
Plan de referencia: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §1 (D1, D2, D4, D8) y §4 "Ola 0".

## Archivos que puedes tocar (solo estos)
- `src/store.ts`
- `src/validators/publish.ts`
- `tests/store.test.ts`, `tests/validators-core.test.ts`, `tests/validators-cli.test.ts` y un test nuevo `tests/store-migrations.test.ts` si lo necesitas.
NO toques `src/pool.ts`, `src/agents.ts`, `src/prompts.ts`, `src/worktrees.ts` ni `src/tui.ts`: los modifica otro agente en paralelo.

## Cambios (mínimos, sin abstracciones nuevas)
1. **D1** `createWorkstream` (`src/store.ts:226`): el `INSERT INTO workstreams VALUES (...)` es posicional. Cámbialo a lista de columnas nombradas. Revisa si hay otros `INSERT ... VALUES` posicionales en `store.ts` y nómbralos también.
2. **D8** Helper privado en `Store`, p. ej. `addColumn(table, column, ddl)`: comprueba `PRAGMA table_info` y ejecuta `ALTER TABLE ... ADD COLUMN`; si otro proceso la añadió entre medias, tolera el error `duplicate column name` y relanza cualquier otro. Reescribe la migración existente de `activities.validator` (`store.ts:207-209`) con él. No añadas columnas nuevas todavía.
3. **D2** Un validador que agotó reintentos queda `status = 'failed'` sin veredicto (`validationSummary`, `store.ts:471-505`) y `mergeBlocker` (`src/validators/publish.ts:29-33`) no lo bloquea: el merge queda abierto. Haz que `mergeBlocker` bloquee también cuando un validador terminó sin veredicto (activity terminal y `verdict === undefined`), con un mensaje claro, p. ej. `validadores sin veredicto: qa`. `needs_human` mantiene su comportamiento actual (no cambiar).
4. **D4** `retryChange` (`store.ts:634-644`) reintenta copiando `last.kind` pero no `last.validator`: reintentar un QA crea un `change_review` ordinario. Reintenta la activity que falló (la última con `status = 'failed'`, no "la última creada") preservando `kind`, `validator` y `parent_activity_id`. Revisa la firma de `insertActivity` y cómo `requestValidation` inserta validadores para hacerlo igual.

## Tests obligatorios (deben fallar en main y pasar con tu cambio)
- D1: abrir un store, añadir manualmente una columna extra nullable a `workstreams` con `ALTER TABLE`, y `createWorkstream` sigue funcionando.
- D8: llamar dos veces a la migración (o simular la carrera) no lanza.
- D2: change implementado, QA agota sus 3 intentos (`failActivity` x3) → `mergeBlocker(validationSummary(...))` devuelve un bloqueo. Hoy devuelve `undefined`.
- D4: QA fallido permanentemente → `retryChange` crea una activity con `validator = 'qa'` y el mismo `kind`.

## Verificación antes de terminar
```
bun test
bunx tsc --noEmit
```
Ambos en verde. Línea base de `main`: 751 tests, 0 fallos.

## Entrega
- Commits pequeños en tu rama, mensaje en español, uno por defecto (D1, D8, D2, D4). Sin `Co-Authored-By`.
- No hagas merge, push ni toques otras ramas.
- Al terminar, escribe un resumen en `/home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola0-codex.md`: qué cambiaste (archivo:línea), salida final de `bun test` (líneas de resumen) y `tsc`, y cualquier decisión o duda.
