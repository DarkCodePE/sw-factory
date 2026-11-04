# Reporte ola 0 — codex (store y merge gate)

Fecha: 2026-10-30. Worktree: `/home/orlando/Desktop/factory/sw-factory-ola0-codex`.
Rama: `fab/research-ola0-codex`. Base: `29d4dd3`. HEAD verificado: `11349ae`.

## Cambios y commits

- **D1 — `f92e5d4`** `fix(store): nombrar columnas en las inserciones (D1)`.
  `src/store.ts:234`, `src/store.ts:285`, `src/store.ts:339`: columnas explícitas en las inserciones de workstreams, signals y changes. Activities y events ya las tenían. `tests/store.test.ts:161`: añade una columna nullable a las cinco tablas y comprueba creación de workstream, signal, change, activity y events.
- **D8 — `4adf6f5`** `fix(store): tolerar migraciones concurrentes de columnas (D8)`.
  `src/store.ts:206` y `src/store.ts:210`: migración existente delegada al helper privado `addColumn`; comprueba el esquema, tolera únicamente `duplicate column name` y propaga los demás errores. Sin columnas nuevas. `tests/store-migrations.test.ts:10`: simula una lectura de esquema anterior a la incorporación de validator y provoca el error real de SQLite por columna duplicada; ejecuta de nuevo la migración. `tests/store-migrations.test.ts:27`: comprueba propagación de errores ajenos a duplicados. La prueba existente de base legacy sigue pasando (`tests/validators-core.test.ts:107`).
- **D2 — `ace31f6`** `fix(validadores): bloquear merge sin veredicto terminal (D2)`.
  `src/validators/publish.ts:29`: después de pendientes y fail, bloquea resultados sin veredicto con `validadores sin veredicto: qa`. `tests/validators-core.test.ts:326`: pipeline implementado y QA con tres fallos, además del caso completed sin veredicto. `tests/validators-core.test.ts:345`: mantiene el comportamiento de ausencia de validadores y needs_human.
- **D4 — `11349ae`** `fix(store): reintentar la actividad fallida con su validador (D4)`.
  `src/store.ts:648`: selecciona la última activity failed por created_at y rowid; conserva kind, validator y parent_activity_id, con presupuesto de reintentos nuevo. Admite validadores fallidos de changes implemented y conserva ese estado. Evita reintentar de nuevo un fallo que ya tenga una activity posterior del mismo validador. `tests/validators-core.test.ts:353`: QA agotado, padre no nulo y otro validador creado después; comprueba identidad, tipo, padre, presupuesto, rechazo de duplicados pendientes/en curso y posterior pass. El retry ordinario existente sigue pasando (`tests/store.test.ts:135`).

## Evidencia de regresión

Antes de aplicar cada corrección ejecuté su prueba nueva contra la implementación todavía defectuosa:

- D1: falló con `table workstreams has 12 columns but 11 values were supplied`.
- D8: falló con `duplicate column name: validator`.
- D2: ambos casos terminales recibían `undefined` en lugar del bloqueo esperado.
- D4: falló con `change ... is implemented, not failed`, antes de poder crear el QA nuevo.

Después de cada corrección pasaron sus pruebas focalizadas. Los cambios anteriores a cada prueba roja no modificaban el comportamiento del defecto probado.

## Verificación final

`bun test` — código de salida 0, Bun v1.3.14:

```text
 758 pass
 0 fail
 4204 expect() calls
Ran 758 tests across 78 files. [209.96s]
```

`bunx tsc --noEmit` — código de salida 0, sin diagnósticos.

`git diff --check` — código de salida 0.

## Decisiones, alcance y dudas

- No hizo falta cambiar `validationSummary`: su campo pending ya permite distinguir el caso terminal antes de buscar veredictos ausentes en mergeBlocker. Se conserva la prioridad del mensaje de fail y el comportamiento de needs_human.
- `failActivity` mantiene implemented para validadores. Por eso D4 requiere permitir ese estado en retryChange; no basta con copiar el campo validator. Los reintentos ordinarios siguen llevando el change a pending.
- La carrera de migración se prueba de manera determinista con un snapshot desactualizado; no se ejecutó una carrera multiproceso dependiente del reloj. Se conserva además la prueba de reapertura idempotente de una base legacy.
- SQL dinámico del helper privado limitado a identificadores y DDL constantes internos; no se expone a entradas del usuario.
- Sin dependencias nuevas, cambios en esquemas futuros, código copiado de ESF ni archivos de otros agentes. Solo se modificaron los cinco archivos permitidos listados arriba, además de este reporte expresamente solicitado fuera del worktree.
- Sin merge ni push, sin cambios en otras ramas. Cuatro commits en español, sin Co-Authored-By. Se conservó intacto el `node_modules` no rastreado que ya existía al empezar.
- El grafo MCP no tenía este worktree indexado; se usaron referencias de graft y lectura directa del código para verificar el comportamiento.
- No quedan dudas bloqueantes.
