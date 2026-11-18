# Brief: T13-a y T13-b, medir para decidir la fase 3 (Codex)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t13`
- **Rama:** `feat/t13-router`, sobre `origin/release/0.1.0-rc.12`

## Contexto
Un análisis previo concluyó que todavía no toca construir el router. Lo que sí toca es **medir**, y el humano aceptó ese veredicto.

El análisis está en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t13/analisis-fable.md`. Léelo entero. Tu encargo es su **§4**, con las tareas **T13-a** y **T13-b**: archivos, definiciones exactas, los tests que deben fallar antes del cambio, el criterio de hecho y la lista de lo que **no debes tocar**. Las secciones §1 a §3 te dan el porqué. **No implementes nada de §3.2**: router, `route.ts`, revocación, Subscriptions o `assess`.

Antes de cambiar nada, comprueba en el código las rutas y líneas que cita el análisis. Pueden haberse movido algo, porque desde entonces se fusionó T40 (PR #71). Si algo no cuadra, sigue la intención del análisis y anota la discrepancia.

## Orden
1. Ejecuta `bun test tests/admission-report.test.ts` antes de editar y guarda el resultado.
2. **T13-a.**
   - Escribe primero los cinco tests y comprueba que fallan.
   - Luego implementa en `src/admission/report.ts`.
   - Un commit.
3. **T13-b.** Igual: primero el test que falla, luego el cambio en `src/admission/cli.ts`. Otro commit.
4. Ejecuta `bun run typecheck` y `bun test tests` (la suite completa, una vez). `tests/agent.test.ts:103` es inestable y ajeno a esta tarea; si falla, repítelo a solas.

## Reglas
- Commits en español y **sin `Co-Authored-By`**: lo prohíbe `/home/orlando/Desktop/factory/CLAUDE.md` #2078.
- Sin push, sin merge y sin escribir en GitHub. No lances subagentes. No uses `git stash`; si necesitas revertir algo para probar, hazlo en una copia temporal.
- Nada de llamadas a modelos, tablas o columnas nuevas, ni flags de CLI nuevos.
- El informe muestra URLs, nunca el texto de los comentarios: es texto no confiable.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t13/impl-codex.md`:
- qué cambiaste y dónde (`ruta:línea`);
- cada test nuevo y si fallaba antes del cambio;
- las discrepancias con el análisis;
- los comandos y su salida resumida;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
