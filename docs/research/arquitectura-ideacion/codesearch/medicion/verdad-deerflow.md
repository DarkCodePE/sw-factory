# Verdad de referencia, deer-flow (NO leer antes de ejecutar el brazo de búsqueda libre)
Fuente: lectura del orquestador con rg y awk (2026-11-02). Rutas relativas a la raíz del repo.
- T1: backend/packages/harness/deerflow/agents/middlewares/summarization_middleware.py, clase `DeerFlowSummarizationMiddleware` (:122); `before_model`/`abefore_model` (:721/:724), `compact_state`/`acompact_state` (:858/:911); notifica en `_record_compaction` (:799 → notify_context_compacted :815).
- T2: backend/packages/harness/deerflow/guardrails/middleware.py, `GuardrailMiddleware` (:25), `wrap_tool_call` (:182) y `awrap_tool_call` (:232), que llaman a `provider.evaluate` (:190) y a `provider.aevaluate` (:240). Se instala en backend/packages/harness/deerflow/agents/middlewares/tool_error_handling_middleware.py:456 y :487.
- T3: desde `backend/`: `rg -o -F GuardrailDecision` → 74 ocurrencias; `rg -c -F GuardrailDecision` → 11 archivos (contar de nuevo y registrar el comando exacto).
- T4: backend/packages/harness/deerflow/models/factory.py:536 `create_chat_model`; backend/packages/harness/deerflow/models/selection.py:52 `resolve_model_control`.
- T5: clases públicas de provider.py: `GuardrailRequest` (:10), `GuardrailReason` (:40), `GuardrailDecision` (:48), `GuardrailProvider` (:58); comparar contra el archivo real.
