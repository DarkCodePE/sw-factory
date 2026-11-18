# Brief: T41, sacar la config MCP del turno vivo de donde el sandbox puede escribir (Sonnet 5.5)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t41`
- **Rama:** `fix/t41-fab-live-symlink`, sobre `origin/release/0.1.0-rc.12`
- **Reglas del repo:** lee primero `/home/orlando/Desktop/factory/sw-factory-docsint/AGENTS.md`, sobre todo los apartados «Invariantes de seguridad», «Implementar» y «Agente real cuando tocas `src/live/` o `src/sandbox/`».

## El fallo
Lo encontró la verificación de T40 como hallazgo H8; está en `t40/verif-fable.md`, junto a este brief.

En cada turno vivo, `src/live/claude.ts` (`configDir` y la escritura de `mcp-<uuid>.json`) escribe la config MCP, con el token del turno, en `<git-dir>/fab-live/`. Ese directorio está dentro del git dir, que el sandbox monta **en escritura**.

Un agente confinado puede cambiar `fab-live` por un symlink. En el turno siguiente, el host hace `mkdirSync` y `writeFileSync` siguiendo ese symlink, así que crea un archivo con el token en un directorio del host que elige el agente. Es el mismo tipo de agujero que T40 cerró para `claude-projects`.

## Qué hacer
1. **Reproduce primero el fallo con un test que falle.**
   - Desde dentro del sandbox, o simulándolo, cambia `fab-live` por un symlink a un directorio víctima.
   - Lanza un turno.
   - Comprueba que no aparece nada en la víctima.
2. **Arreglo.**
   - La config MCP la escribe el host fuera de todo lo que el sandbox puede escribir. Por ejemplo, en `<stateDir>/live/<id-corto>/`, como `claudeProjects` en T40: el pool lo pasa por `LiveTurn`.
   - Monta ese archivo dentro del sandbox **en solo lectura**, en una ruta fija.
   - Comprueba la ruta real y falla cerrado si cae dentro de un montaje escribible. Reutiliza la comprobación que ya hace `confineAgent` para `claudeProjects`.
   - Sin confinar, el comportamiento puede quedarse igual, pero di en el informe qué decides y por qué.
   - Borra la config al terminar el turno, como hoy.
3. **Respeta el resto:**
   - `--strict-mcp-config` y `--mcp-config`;
   - el camino de un disparo;
   - los adaptadores codex, fake y simulated;
   - T34, que sigue abierta y no es de este encargo: el token ya no está en argv, pero la ruta sí.
4. **Tests:**
   - el de regresión del symlink;
   - uno de cableado del pool al turno y al backend: la ruta llega, y quitar una línea lo rompe;
   - comprueba que fallan sin el arreglo, con mutaciones en una copia temporal y **sin `git stash`**.
5. **Prueba real corta con `claude` confinado.** Usa el script `/tmp/claude-1000/-home-orlando-Desktop-ia-master/a82ff1be-88c1-4b9c-944e-03eeba3f3ea6/scratchpad/b2/b2.ts`, cambiando `SRC` a tu worktree y ejecutándolo con `bun b2.ts <dir-temporal>`. Tiene que seguir llamando a `report` y reanudar.

## Reglas
- Commits en español y sin `Co-Authored-By`.
- Sin push, sin merge y sin escribir en GitHub. No lances subagentes.
- `bun run typecheck` y `bun test tests`; la suite completa, una vez al final.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t41/impl-sonnet.md`:
- qué cambiaste y dónde;
- los tests y si fallan sin el arreglo;
- la prueba real;
- los comandos;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
