# Brief: T42, estabilizar `tests/agent.test.ts` «interrupted tool snapshots are refused…» (Codex)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t42`
- **Rama:** `fix/t42-test-inestable`, sobre `origin/release/0.1.0-rc.12`
- **Reglas del repo:** lee primero `/home/orlando/Desktop/factory/sw-factory-docsint/AGENTS.md`, sobre todo el apartado «Tests sin depender del tiempo».

## El fallo
El test de `tests/agent.test.ts`, hacia la línea 103, usa `timeoutMs: 40` para interrumpir una tool que se cuelga. En la suite completa falló una vez con «Unexpected extra model call»; a solas pasa siempre.

Probablemente, con la máquina cargada, el orden entre el timeout y la llamada al modelo cambia.

## Qué hacer
1. **Reprodúcelo antes de arreglarlo.**
   - Cárgalo en un bucle (`for i in $(seq 50); do bun test tests/agent.test.ts -t 'interrupted tool'; done`) o en paralelo con carga de CPU.
   - Si no falla, baja `timeoutMs` en una copia temporal para provocarlo.
   - Explica la causa, con `ruta:línea` del código de `src/agent/` que la produce.
2. **Arreglo:** que el resultado no dependa del tiempo. Por ejemplo, abortar con una señal controlada por el test en vez de con un timeout corto.
   - **Si la causa es un fallo real del código** (una carrera entre el timeout y la siguiente llamada al modelo), no lo tapes en el test: arréglalo en `src/` con su test.
   - **Si cambiar `src/` amplía el alcance más de lo razonable**, para y dilo en el informe.
3. Busca en `tests/` otros `timeoutMs` o `setTimeout` de pocos milisegundos de los que dependa el resultado. Lístalos en el informe sin arreglarlos.

## Reglas
- Commits en español y sin `Co-Authored-By`.
- Sin push, sin merge y sin escribir en GitHub. No lances subagentes. **Sin `git stash`.**
- `bun run typecheck` y `bun test tests`; la suite completa, una vez al final.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t42/impl-codex.md`:
- la causa;
- cómo lo reprodujiste, con cuántas iteraciones y cuántos fallos antes y después;
- el cambio;
- la lista de otros tests sensibles al tiempo;
- los comandos;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
