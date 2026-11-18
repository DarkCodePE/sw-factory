# Brief: verificar T41, la config MCP del turno vivo fuera de lo que el sandbox escribe (Fable 5.2, goldfish)

Eres un verificador sin contexto previo. Revisa la rama `fix/t41-fab-live-symlink` en `/home/orlando/Desktop/factory/sw-factory-t41`. Es un commit sobre `origin/release/0.1.0-rc.12`; míralo con `git show`.

Las reglas del repo están en `/home/orlando/Desktop/factory/sw-factory-docsint/AGENTS.md`. Lee sobre todo los apartados «Verificar», «Invariantes de seguridad» e «Informes».

**Solo lectura.**
- No edites nada, no hagas commit, no escribas en GitHub y no lances subagentes.
- Para mutar o hacer exploits, usa una copia temporal, nunca `git stash`.
- La suite completa, como mucho una vez.

## El problema que arregla
- Antes, en cada turno vivo confinado, el host escribía la config MCP con el token del turno en `<git-dir>/fab-live/mcp-<uuid>.json`.
- El sandbox monta el git dir en escritura. Un agente podía cambiar `fab-live` por un symlink y hacer que el host escribiera el token en un directorio del host que él eligiera.
- El arreglo:
  - escribe la config en `<stateDir>/live/<id-corto>/mcp`;
  - la monta en solo lectura en `/opt/fab-mcp/mcp.json`;
  - sustituye la ruta en argv;
  - falla cerrado si la ruta cae en un montaje escribible o si falta el directorio estando confinado.

## Qué verificar
1. **Exploit.** Repite el ataque del symlink contra el código nuevo y prueba otras variantes. Por ejemplo, ¿puede el agente afectar a `<stateDir>/live/<id>/mcp` desde dentro? ¿Puede leer la config de otro change?
2. **Solo lectura de verdad.** Dentro del sandbox, ¿se puede escribir, renombrar o sustituir `/opt/fab-mcp/mcp.json`?
3. **Sustitución en argv.** En `src/sandbox/confine.ts`, `command.includes(mcpConfig)` y `indexOf`:
   - ¿Qué pasa si la ruta aparece dos veces, o si no aparece?
   - ¿Puede quedar la ruta del host en argv?
4. **Sin confinar.** Sigue usando `<git-dir>/fab-live`. ¿Es aceptable? ¿Hay algún camino confinado que llegue ahí sin `mcpConfigDir`?
5. **Limpieza.**
   - ¿Se borra la config al terminar, también si falla o se aborta el turno?
   - ¿`mergeAndCleanup` y `removeWorktree` borran `<stateDir>/live/<id>`, que ya lo hacían desde T40, incluido `mcp/`?
6. **Alcance.** ¿Cambian el camino de un disparo, o los adaptadores codex, fake o simulated? Revisa los llamadores de `confineAgent` y de `runAgent`.
7. **Tests.** ¿Fallan sin el arreglo? Mutaciones en una copia temporal.

Por último, lee `t41/impl-sonnet.md` (junto a este brief) y contrasta.

## Salida
Escríbela en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t41/verif-fable.md`:
- **Veredicto:** listo para PR, listo con cambios o no listo.
- **Tabla de hallazgos:** id, severidad, `ruta:línea`, problema, escenario que falla y arreglo.
- **Contraste** con el informe del implementador.
- **Lo que no revisaste.**

Marca lo **verificado** y lo **inferido**. Última línea, exactamente: `<!-- FIN -->`.
