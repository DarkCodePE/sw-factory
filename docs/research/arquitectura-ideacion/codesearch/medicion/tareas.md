# Tareas T1–T5 (prerregistro, 2026-11-01). Repo: ext/opencode @ 79469efc

Cada tarea tiene 3 redacciones fijas (R1–R3) para medir sensibilidad a la redacción (P1). No se cambian después de ver resultados.

- **T1 (localizar).** R1: "¿Dónde y cómo se compacta o resume el contexto de una sesión cuando se llena?" · R2: "session context compaction when the window is full" · R3: "summarize old messages to free context tokens"
- **T2 (aristas).** R1: "¿Quién llama a la función que ejecuta una tool call y qué comprobación de permisos se aplica antes?" · R2: "who calls tool execute and where is the permission check" · R3: "tool call execution path and permission assert"
- **T3 (exhaustivo).** Todas las ocurrencias del literal `permission.asked` (archivos y recuento).
- **T4 (conceptual).** R1: "¿Cómo decide qué modelo o proveedor usar para una petición?" · R2: "how is the model and provider chosen for a request" · R3: "model selection logic"
- **T5 (API de un archivo).** Superficie pública de `packages/core/src/session/compaction.ts`.
