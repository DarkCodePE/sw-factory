# Brief: verificar T40, que `claude --resume` funcione confinado (Fable 5.2, goldfish)

Eres un verificador sin contexto previo. Vas a revisar la rama `fix/t40-resume-confinado` en `/home/orlando/Desktop/factory/sw-factory-t40`: es un commit sobre `origin/release/0.1.0-rc.12`. Para ver el cambio: `git diff origin/release/0.1.0-rc.12`.

**Solo lectura.** No edites nada, no hagas commit, no escribas en GitHub y no lances subagentes. Puedes ejecutar tests concretos y `bun run typecheck`. La suite completa, como mucho una vez.

## El problema que arregla
- `confineAgent` (`src/sandbox/confine.ts`) monta en `/home/agent` un HOME efímero, creado con `mkdtemp` y borrado en cada turno.
- Claude guarda ahí el transcript (`~/.claude/projects`). Por eso, en el turno siguiente de la rama viva, `claude --resume <id>` fallaba con «No conversation found».
- El arreglo persiste ese directorio por worktree en `<git-dir>/fab-live/claude-projects` y lo monta en lectura y escritura, solo en turnos vivos de claude.

## Qué verificar
1. **Corrección.** ¿El montaje sobrevive entre turnos y queda en el sitio correcto?
   - Mira cómo `src/live/claude.ts` calcula `dir`: git dir del worktree, o `tmpdir()/fab-live` fuera de git.
   - ¿Qué pasa en la rama de `tmpdir()`?
   - ¿El orden de los `--bind` respecto al HOME y a `.credentials.json` es correcto en bwrap?
2. **Aislamiento y seguridad.**
   - ¿Pueden dos changes o worktrees compartir transcripts?
   - ¿Se expone algo del `~/.claude` del host?
   - ¿Con qué permisos se crea el directorio?
   - Un agente confinado que escribe en ese directorio, ¿puede influir en otro turno o en el host? Por ejemplo, con symlinks dentro de `claude-projects` o con archivos que claude lea como configuración.
3. **Alcance.** ¿Cambia algo el camino de un disparo o el de otros adaptadores (codex, fake, simulated)? Revisa todos los llamadores de `confineAgent` y de `runAgent`.
4. **Tests** (`tests/sandbox-confine.test.ts`, al final):
   - ¿Prueban de verdad la persistencia? ¿Fallan sin el arreglo? Compruébalo revirtiendo `src/` en una copia temporal, sin tocar el worktree.
   - ¿Hay algún test que pasaría igual con el código roto?
5. **Lo que queda sin resolver.** El implementador dice que el directorio crece sin límite y solo desaparece con el worktree. ¿Hay que limpiarlo al cerrar el change?

**Por último**, lee el informe del implementador, `t40/impl-sonnet.md`, y contrasta.

## Salida
Escríbela en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t40/verif-fable.md`:
- **Veredicto:** listo para PR, listo con cambios o no listo.
- **Tabla de hallazgos:** id, severidad, `ruta:línea`, problema, escenario que falla y arreglo propuesto.
- **Contraste** con el informe del implementador.
- **Lo que no revisaste.**

Cita como `ruta:línea` y distingue lo **verificado** de lo **inferido**. Última línea, exactamente: `<!-- FIN -->`.
