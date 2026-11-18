# Brief: T44, arreglos tras la verificación (Sonnet 5.5)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t44`, rama `fix/t44-statedir-raiz`, `HEAD` `8e1f3a9`. Comprueba el SHA y `git status` antes de empezar.
- **Reglas del repo:** `/home/orlando/Desktop/factory/sw-factory-docs-t41/AGENTS.md`, apartados «Implementar», «Invariantes de seguridad» e «Informes».
- **Lee primero**, en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t44/`: `BRIEF-T44-sonnet.md` (el encargo original, con sus cinco condiciones), `impl-sonnet.md` (lo que se hizo) y `verif-fable.md` (los hallazgos).

Eres un implementador sin contexto previo. Cierras los hallazgos V1, V2 y V3 de `verif-fable.md`, **en un solo commit, cada uno con su test**. Nada más.

## Qué arreglar en `hostDir` (`src/sandbox/confine.ts`)
1. **V1.** La raíz se rechaza si **cualquier prefijo** de su ruta escrita tiene una ruta real que es un montaje escribible o cae dentro de uno. Hoy solo se compara el texto de la ruta escrita, y falla cuando esa ruta pasa por un enlace por encima del repo. Test: repo alcanzado por un enlace, raíz escrita dentro de su git dir y cambiada por un symlink a una víctima; el turno falla, confinado y sin confinar, y la víctima queda vacía.
2. **V2.** El **directorio final** tampoco puede caer en un montaje escribible, aunque la raíz no lo esté: los worktrees viven bajo `stateDir`. Compruébalo antes de crear nada. Test: un directorio dentro del worktree, bajo la raíz; falla y no se crea.
3. **V3.** Un test para el componente que no es un directorio y otro para la raíz que es exactamente un montaje.

Las cinco condiciones del brief original siguen mandando. En particular: un `stateDir` legítimo bajo un enlace tiene que seguir funcionando, y nada se crea antes de comprobar.

## Comprobación
- Escribe cada test primero y comprueba que falla.
- Mutaciones en una copia temporal, **sin `git stash`**: quita cada condición nueva y di qué test muere.
- Corre `bun /home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t44/exploit-t44.ts <ruta de tu worktree>`: los casos `g` y `h` deben pasar a «FALLA», y los casos `a0`, `a` y `a2` deben seguir en «OK». No edites ese script.
- `bun run typecheck`, los tests del área y `bun test tests` completo una vez al final.
- No hace falta repetir la prueba con `claude` real.

## Reglas
- Commit en español, `tipo(ámbito): descripción`, sin `Co-Authored-By`.
- Sin push, sin merge, sin escribir en GitHub. No lances subagentes.
- No toques nada fuera de `src/sandbox/confine.ts` y sus tests, salvo que un hallazgo lo exija; si lo exige, dilo.

## Informe
Añade al final de `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t44/impl-sonnet.md` una sección «Correcciones tras verificación»: qué cambiaste, cada test y si fallaba antes, las mutaciones, la salida del script de exploits para `g`, `h`, `a0`, `a` y `a2`, los comandos y lo que no hiciste. El fichero termina hoy en `<!-- FIN -->`: quita esa línea al empezar y vuelve a ponerla, exactamente, como última línea cuando acabes.
