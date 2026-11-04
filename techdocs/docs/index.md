# fab — documentación técnica

Documentación para **quien mantiene fab**, no para el usuario final: cómo está construido, por qué, y dónde vive cada pieza (`archivo:línea`). Va de lo general a lo particular: blueprint → capas → módulos → flujos.

| Sección | Qué cubre |
|---|---|
| [Factory](factory/index.md) | Orquestación: workstream → signal → change → activity, Store, pool, worktrees, gates, validadores, seguridad, evidencia, perfiles e `improve`. |
| [fab exec](exec/index.md) | El agente de codificación nativo: motor, proveedores y router, herramientas, políticas, MCP, misiones, sesiones, RPC. |
| [fab investigación](investigacion/index.md) | Propuesta (v0.2): harness de ideación que convierte papers, repos y artículos en mejoras medidas de fab. |

Construir: `cd techdocs && uvx --with mkdocs-material mkdocs build --strict` (salida en `dist/techdocs/`, ignorado por git). Servir: `... mkdocs serve`.
