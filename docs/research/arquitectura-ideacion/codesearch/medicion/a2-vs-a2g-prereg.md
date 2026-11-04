# A2 frente a A2 + graft: prerregistro (2026-11-03)

Escrito antes de ver ningún resultado. No se cambia después.

## Pregunta
¿Añadir el grafo de graft (tree-sitter) al bucle de búsqueda agéntica (`rg` + leer tramos + repetir) cambia el acierto, los bytes servidos o el número de comandos?

## Diseño
- **Brazos.** A2: `rg`, `sed`, `ls`, `find`, `head`, `wc`. A2g: lo mismo más `lector` (`skeleton`, `callers`, `ask`, `grep`; salida acotada a 8 KB con spill) y `map` (graft map cortado a 16 KB = 4k tokens, tope del ADR-0008). En A2g el grafo es opcional: el sujeto lo usa si le ahorra lectura.
- **Sujetos.** Sonnet 5.5 (Claude Code), agy (Gemini 3.8 Flash) y Codex (GPT-6.1-Sol). Cada uno hace los dos brazos en sesiones nuevas, sin memoria entre ellas. Orden: Sonnet A2→A2g, agy A2g→A2, Codex A2→A2g.
- **Tareas.** T1–T5 de `tareas.md` (opencode @ `79469efc`) y `tareas-deerflow.md` (deer-flow @ `35656d6`), redacción R1.
- **Medida.** Toda herramienta pasa por la envoltura `m.sh`, que registra bytes de salida, ms y código de salida por comando, con marcas de tarea. `rg` excluye siempre `graft/` y los argumentos que apunten a `graft/` se rechazan, de modo que en A2 no se filtra el grafo. Tokens = bytes/4 (solo salida de herramientas; los tokens propios del modelo no se miden de forma uniforme entre los tres).
- **Aislamiento.** Sonnet sin hooks, sin MCP y sin skills. Codex con sus MCP desactivados por sesión. agy conserva su MCP global de graft (no se tocó la configuración global): solo la regla del encargo lo impide, y se audita a posteriori.

## Corrección (por tarea: acierto / parcial / fallo)
Tolerancia de línea ±3. La verdad de referencia está en `verdad.md` y `verdad-deerflow.md`, salvo T3, recontado con `graft/` excluido.

**opencode**
- T1: `session/compaction.ts`, `compact` (:284). Parcial: el archivo sin la función.
- T2: tres piezas, que son (a) el ejecutor: `tool/runtime.ts:30` `execute`, `tool.ts:115` `executeTool` o `session/runner/step.ts` `executeTool`; (b) quién lo llama; y (c) la comprobación de permisos en `permission.ts` (`ask` :214 o `assert` :228), o su invocación desde un plugin de tool. Parcial: dos de las tres.
- T3: 55 ocurrencias en 40 archivos (`rg -o -F permission.asked --glob '!/graft/'`). Sin tolerancia. Parcial: una de las dos cifras.
- T4: `model-resolver.ts` (`resolveModel` o `ModelResolver.resolve`) y `session/model-request.ts` o `session/runner/model.ts`. Parcial: uno de los dos.
- T5: los 13 exports (`SessionCompaction`, `Settings`, `Editor`, `Trigger`, `Outcome`, `Interface`, `Service`, `buildPrompt`, `layer`, `node`, `recentUserMessages`, `estimateContext`, `estimatePrompt`). Parcial: 10–12.

**deer-flow**
- T1: `summarization_middleware.py`, `DeerFlowSummarizationMiddleware` (:122) y `before_model`/`abefore_model` o `compact_state`/`acompact_state`. Parcial: solo la clase o el archivo.
- T2: `guardrails/middleware.py` `GuardrailMiddleware.wrap_tool_call`/`awrap_tool_call` llamando a `provider.evaluate`/`aevaluate`, **y** dónde se instala (`tool_error_handling_middleware.py:456`/`:487`). Parcial: sin la instalación.
- T3: 74 ocurrencias en 11 archivos bajo `backend/`. Parcial: una de las dos cifras.
- T4: `models/factory.py:536` `create_chat_model` y `models/selection.py:52` `resolve_model_control`. Parcial: uno de los dos.
- T5: las 4 clases públicas (`GuardrailRequest`, `GuardrailReason`, `GuardrailDecision`, `GuardrailProvider`). Parcial: 3.

## Regla de decisión
- Si A2g no supera a A2 en acierto **y** no reduce los bytes o los comandos en al menos un 20 % en la mayoría de los sujetos, el grafo sale del bucle principal y queda solo para orientación.
- Si reduce un 20 % o más sin perder acierto, se mantiene como complemento recomendado.
- Si pierde acierto en cualquier sujeto, se anota la causa (arista ausente, mapa engañoso, etc.).
- Con 3 sujetos y una ejecución por celda, el resultado es indicativo, no estadístico.
