# Brief: T44, `hostDir` no debe rechazar un `stateDir` legítimo bajo un enlace simbólico (Sonnet 5.5)

- **Worktree:** `/home/orlando/Desktop/factory/sw-factory-t44`
- **Rama:** `fix/t44-statedir-raiz`, sobre `origin/release/0.1.0-rc.12` (`aa2142b`, ya incluye T41).
- **Reglas del repo:** lee primero `/home/orlando/Desktop/factory/sw-factory-docs-t41/AGENTS.md`, sobre todo «Implementar», «Invariantes de seguridad», «Informes» y «Agente real cuando tocas `src/live/` o `src/sandbox/`».
- **Contexto:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t41/verif-fable.md`, sección «Segunda verificación», hallazgos N1 y N2.

Eres un implementador sin contexto previo. Todo lo que necesitas está aquí y en esos dos ficheros.

## El problema
- `hostDir(dir, cwd)` en `src/sandbox/confine.ts` crea un directorio del host y falla cerrado si la ruta contiene un symlink o cae en un montaje escribible del sandbox (el worktree y sus git dirs). La usan la config MCP del turno vivo (`src/live/claude.ts`) y `claudeProjects`.
- **N1:** rechaza cualquier symlink en toda la ruta. Si el directorio de estado (`stateDir`, por defecto `~/.fabrica`, o `FABRICA_HOME`) se alcanza por un enlace legítimo, todos los turnos vivos fallan con «la ruta contiene un symlink». El pool pasa `resolve(opts.stateDir)`, no la ruta real (`src/pool.ts`, líneas de `claudeProjects` y `mcpConfigDir`).
- **N2:** hace `mkdir` recursivo antes de comprobar. Con un ancestro cambiado por symlink, el turno falla pero deja un directorio vacío (`mcp` o `claude-projects`) en el destino del enlace.

## Qué tiene que cumplir el arreglo
`stateDir` es la **raíz de confianza**: la elige el dueño de la máquina. Por debajo de ella no se confía en nada.

1. **La raíz se rechaza** si su ruta tal como está escrita (`resolve`) **o** su ruta real (`realpath`) es un montaje escribible o cae dentro de uno. Las dos comprobaciones hacen falta: una raíz escrita dentro del git dir y cambiada por un symlink hacia fuera tiene ruta real «limpia».
2. **Una raíz legítima bajo un enlace se acepta**: los enlaces por encima de la raíz no importan.
3. **De la raíz hacia abajo no puede haber ningún symlink**, y el directorio final no puede caer en un montaje escribible.
4. **Nada se crea a través de un symlink.** Si hay un enlace en la hoja o en un ancestro por debajo de la raíz, el turno falla y en el destino del enlace no aparece nada, ni siquiera un directorio vacío.
5. Sigue fallando cerrado antes de escribir la config y antes de lanzar al agente, confinado o no.

Cómo pasar la raíz hasta `hostDir` lo decides tú (por ejemplo un parámetro más y un campo en `LiveTurn`). Dilo en el informe. Si alguna de estas cinco condiciones no se puede cumplir, **para y dilo**; no la ajustes.

## Tests (escríbelos primero y comprueba que fallan)
- `stateDir` alcanzado por un symlink que vive fuera del repo: el turno vivo funciona, confinado y sin confinar. **Hoy falla.**
- `stateDir` dentro del git dir, sin symlinks: falla cerrado.
- `stateDir` escrito dentro del git dir y cambiado por un symlink hacia fuera: falla cerrado.
- `stateDir` fuera, que es un symlink hacia dentro del git dir: falla cerrado.
- Symlink en la hoja (`mcp`) y en un ancestro (`live/<id>`) por debajo de la raíz, hacia una víctima: falla, y la víctima queda **vacía** (comprueba con `readdirSync`). El caso del ancestro **hoy deja un directorio**.
- Lo mismo para `claudeProjects`.
- Los tests de T41 siguen pasando sin relajarlos.
- Mutaciones en una copia temporal, **sin `git stash`**: quita cada condición y di qué test muere.

## No tocar
- El camino de un disparo, los adaptadores codex, fake y simulated.
- El montaje en solo lectura en `/opt/fab-mcp/mcp.json` y la sustitución en argv.
- N3, N4, N5, H5, H6 y T34: no son de este encargo.
- Sin flags de CLI, tablas ni dependencias nuevas.

## Prueba real
Corta, con `claude` real y confinado: copia `/tmp/claude-1000/-home-orlando-Desktop-ia-master/a82ff1be-88c1-4b9c-944e-03eeba3f3ea6/scratchpad/b2/b2-t41.ts`, apunta `SRC` a tu worktree y ejecútala una vez. Si el script ya no existe, dilo en el informe y no improvises otro.

## Reglas
- Commits en español, `tipo(ámbito): descripción`, sin `Co-Authored-By`. Un commit por subtarea.
- Sin push, sin merge, sin escribir en GitHub. No lances subagentes.
- `bun run typecheck` y los tests del área mientras trabajas; `bun test tests` completo una vez al final.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/t44/impl-sonnet.md`:
- qué cambiaste y dónde, y cómo viaja la raíz;
- cada test nuevo y si fallaba antes;
- las mutaciones;
- la prueba real;
- los comandos con su salida resumida;
- lo que no hiciste.

Última línea, exactamente: `<!-- FIN -->`.
