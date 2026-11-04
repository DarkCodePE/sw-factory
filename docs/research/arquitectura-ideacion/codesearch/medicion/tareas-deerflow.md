# Tareas T1–T5, segundo repo (prerregistro, 2026-11-02). Repo: ext/deer-flow @ 35656d6 (Python, ~871 k líneas .py)

Mismo diseño que `tareas.md`: 3 redacciones fijas R1–R3 en T1, T2 y T4. No se cambian después de ver resultados.

- **T1 (localizar).** R1: "¿Dónde y cómo se compacta o resume el contexto del agente cuando la conversación se hace demasiado larga?" · R2: "conversation context summarization when too many tokens" · R3: "compact agent state to free context"
- **T2 (aristas).** R1: "¿Qué comprobación de seguridad o política se aplica antes de ejecutar una tool call y dónde se instala?" · R2: "guardrail check before tool execution" · R3: "who evaluates tool call policy and where is it wired"
- **T3 (exhaustivo).** Todas las ocurrencias del literal `GuardrailDecision` bajo `backend/` (archivos y recuento).
- **T4 (conceptual).** R1: "¿Cómo se crea y elige el modelo de chat para una petición?" · R2: "how is the chat model created and selected" · R3: "model instantiation logic"
- **T5 (API de un archivo).** Superficie pública de `backend/packages/harness/deerflow/guardrails/provider.py`.
