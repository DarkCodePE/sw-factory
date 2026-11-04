# Verdad de referencia (NO leer antes de ejecutar el brazo de búsqueda libre)
Fuente: grafos.md §0 (leída en el fuente) y verificación del orquestador con rg (2026-11-01).
- T1: packages/core/src/session/compaction.ts, función `compact` (:284).
- T2: packages/core/src/tool/runtime.ts:30 (`execute`) y packages/core/src/tool.ts:115 (`executeTool`, llamado en tool.ts:270/309/311); además session/runner/step.ts:91 (executeTool local). Permisos: packages/core/src/permission.ts:214 (`ask`) y :228 (`assert`), invocados desde los plugins de tool (p. ej. tool/plugin/shell.ts:138, edit.ts:275).
- T3: `rg -F permission.asked` → 60 coincidencias en 44 archivos (rg con .mdx, tests, e2e; contar de nuevo y registrar el comando exacto).
- T4: packages/core/src/model-resolver.ts (resolveModel) y packages/core/src/session/model-request.ts.
- T5: skeleton completo de compaction.ts (comparar contra la lista de exports reales del archivo).
