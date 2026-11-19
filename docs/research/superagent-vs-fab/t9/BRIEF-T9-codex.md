# Brief: T9, análisis de la ruta del worktree truncada a 8 caracteres (Codex)

- **Worktree de lectura:** `/home/orlando/Desktop/factory/sw-factory-lectura` (`origin/release/0.1.0-rc.12`, `aa2142b`). **Solo lectura:** no edites, no hagas commit, no cambies de rama. Otro agente lee ahí a la vez.
- **Reglas del repo:** lee primero `/home/orlando/Desktop/factory/sw-factory-docs-t41/AGENTS.md`, sobre todo «Loop de trabajo» (fase 1, análisis) e «Informes».

Eres un analista sin contexto previo. **No implementas nada.** Tu salida es un análisis.

## La tarea
T9 en `docs/research/superagent-vs-fab/task.json`: el worktree de un change vive en `<stateDir>/worktrees/<8 primeros caracteres del id>`. Dos changes con el mismo prefijo colisionan. Hoy `verifyWorktree` falla en vez de reutilizar el worktree equivocado, pero el change queda bloqueado. La idea anotada es usar el id completo, o más caracteres, solo para worktrees nuevos y sin romper los existentes.

El mismo prefijo de 8 se usa en más sitios: la rama `fab/<id>` (`branchFor`), `<stateDir>/live/<id>` (`src/pool.ts`), `src/improve.ts`, `src/manifest.ts`, `src/validators/publish.ts` y la limpieza en `src/worktrees.ts`. Empieza con `git grep -n "slice(0, 8)" -- src`.

## Qué responder
1. **¿Toca ahora?** Mide el riesgo real: cómo se generan los ids, cuántos changes hacen falta para una colisión probable, y qué pasa exactamente cuando ocurre (cita `ruta:línea`). «No toca» es una respuesta válida si lo justificas.
2. **Alcance mínimo.** Qué usos del prefijo comparten destino y tienen que cambiar juntos, y cuáles son solo texto para personas y no importan.
3. **Diseño.** Cómo conviven los worktrees, ramas y directorios `live/` que ya existen con los nuevos. Qué pasa con un change a medias durante la actualización.
4. **Plan** con definiciones exactas: funciones, firmas y orden de los commits.
5. **Tests que deben fallar antes.**
6. **Lista de «no tocar».** Ojo: otra tarea en curso (T44) cambia `hostDir` en `src/sandbox/confine.ts` y las dos líneas de `src/pool.ts` que construyen `live/<id>/claude-projects` y `live/<id>/mcp`. Di cómo evitar el choque.
7. **Decisiones para el dueño:** cada una marcada `[DECIDIR]`, con **tres opciones**, y para cada opción qué se hace, sus riesgos y sus puntos a favor y en contra, más cuál recomiendas.

## Reglas
- Solo lectura. Para probar algo, usa una copia temporal fuera del repo, nunca `git stash`.
- Sin push, sin escribir en GitHub, sin subagentes.
- Cita como `ruta:línea`. Marca cada afirmación **[V]** (verificada ejecutando o leyendo la línea) o **[I]** (inferida).

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t9/analisis-codex.md`. Incluye al final «Lo que no revisé». Última línea, exactamente: `<!-- FIN -->`.
