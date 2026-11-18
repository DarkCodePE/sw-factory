# T40: verificación de `claude --resume` confinado (Fable 5.2)

Rama `fix/t40-resume-confinado`, commit `2304ca2`, contra `origin/release/0.1.0-rc.12`.

## Veredicto: no listo

El arreglo hace lo que promete: el transcript persiste entre turnos y el test nuevo falla sin él. Pero el directorio persistido queda en un sitio donde el propio agente confinado puede escribir, y eso abre dos agujeros que antes no existían:

- **H1 (bloquea):** un agente confinado puede salir del sandbox en el turno siguiente y obtener lectura y escritura sobre cualquier directorio del host.
- **H2 (bloquea):** un agente confinado puede leer y alterar los transcripts de otros changes del mismo repo.

Los dos se arreglan igual: guardar `claude-projects` fuera de todo lo que el sandbox monta.

## Hallazgos

| id | severidad | ruta:línea | problema | escenario que falla | arreglo propuesto |
|---|---|---|---|---|---|
| H1 | crítica | `src/sandbox/confine.ts:64` | El origen del `--bind` está dentro del git dir, que el sandbox ya monta en escritura (`confine.ts:27` y `:30-34`). `mkdirSync` y bwrap siguen symlinks en el host. | **Verificado.** Turno 1: el agente hace `mv claude-projects old; ln -s <ruta del host> claude-projects`. Turno 2: el host monta esa ruta en `/home/agent/.claude/projects`; el agente leyó un fichero del host que no veía y escribió otro. Reproducido en repo normal y en worktree enlazado. Con `~/.claude` o `~/.ssh` como destino es ejecución de código en el host. Afecta sobre todo a los changes de canal, que fuerzan `confine` (`src/admission/channel.ts:22`). | Guardar el directorio fuera de los montajes del sandbox, por ejemplo en `<stateDir>/live/<shortId>/claude-projects`, pasado desde el pool por `LiveTurn`. Como defensa extra, en `confine.ts` exigir que `realpathSync(claudeProjects)` sea la ruta esperada y fallar cerrado si no. Añadir este escenario como test de regresión. |
| H2 | alta | `src/sandbox/confine.ts:30-34`, `src/live/claude.ts:67` | El git dir común (`<repo>/.git`) se monta entero en escritura, e incluye `worktrees/<otro>/fab-live/claude-projects`. | **Verificado.** Con dos worktrees `a` y `b` del mismo repo, el sandbox de `a` leyó el transcript de `b` y le añadió una línea. Un change puede leer las respuestas humanas de otro y falsificarle el historial que reanudará. | El mismo de H1. La comprobación con `realpath` sola no basta: otro agente en ejecución puede cambiar el symlink entre la comprobación y el montaje. |
| H3 | media | `src/live/claude.ts:67`, `src/agents.ts:186` | Ningún test cubre el cableado. Los tests nuevos llaman a `confineAgent` directamente. | **Verificado.** Con `agents.ts` y `claude.ts` revertidos y `confine.ts` arreglado, los 11 ficheros de test que tocan live, `runAgent` o `confineAgent` dan el mismo resultado que sin mutar. El fallo original volvería sin que nada se ponga rojo. | Un test en `tests/live-claude.test.ts` con un `claude` falso en el `PATH`: dos `claudeLive.run` confinados seguidos, el segundo lee lo que escribió el primero en `~/.claude/projects`. |
| H4 | baja | `src/live/turn.ts:24-26`, `src/pool.ts:304` | Validadores y gates corren en un disparo sobre el mismo worktree y ven el git dir. | **Inferido.** Un validador confinado puede leer el razonamiento completo del trabajador en `<git-dir>/fab-live/claude-projects`, lo que debilita su independencia. | Desaparece con el arreglo de H1. |
| H5 | baja | `src/sandbox/confine.ts:64` | Todo lo que claude guarde bajo `~/.claude/projects` persiste, no solo el transcript (por ejemplo, su memoria por proyecto). | **Inferido, no probado con claude real.** Una sesión de investigación puede dejar contenido que la de implementación, o una generación nueva, cargue como contexto. Queda dentro del mismo change, que ya comparte worktree. | Aceptarlo y dejarlo anotado, o comprobar con claude real qué lee de ahí. |
| H6 | baja | `src/worktrees.ts:170`, `:191` | El directorio crece sin límite mientras viva el worktree. | **Leído, no ejecutado.** `mergeAndCleanup` y `removeWorktree` hacen `git worktree remove --force`, que borra `.git/worktrees/<n>` con su `fab-live`. Un change que nunca se cierra conserva sus transcripts. | Hoy no hace falta limpieza aparte. **Si se aplica H1 sí:** el directorio nuevo hay que borrarlo en esas dos funciones. |
| H7 | info | `src/live/claude.ts:29`, `src/sandbox/confine.ts:32` | Fuera de git, `dir` es `/tmp/fab-live`, común a todo. | **Verificado leyendo.** No se llega a montar: confinado, `confineAgent` lanza antes («no se pudo resolver .git»); sin confinar, la opción se ignora (`agents.ts:186`). Sería compartido y predecible si algún día se confinara fuera de git. | Ninguno ahora. Con H1 la rama deja de importar. |
| H8 | info | `src/live/claude.ts:58-61` | Ya estaba en la base: el agente puede cambiar `fab-live` por un symlink y el host escribe ahí `mcp-<uuid>.json` con el token del turno. | **Inferido.** Crea un fichero de nombre aleatorio en un directorio del host elegido por el agente. | Fuera del alcance de T40; conviene una tarea aparte. |

### Lo que está bien (verificado)

- **Persistencia.** `tests/sandbox-confine.test.ts:120` pasa con el arreglo y falla sin él (`exitCode` 2 en la línea 126), comprobado con `src/` de la base en una copia temporal.
- **Orden de los `--bind`.** HOME (`confine.ts:23`), luego credenciales (`:62`), luego `projects` (`:64`): padre antes que hijos, y los dos hijos no se pisan. bwrap crea el punto de montaje dentro del HOME efímero.
- **Host.** Del `~/.claude` del host solo se monta `.credentials.json`, en solo lectura, igual que antes.
- **Permisos.** `fab-live` y `claude-projects` se crean con `0700`.
- **Alcance.** `confineAgent` tiene un único llamador (`agents.ts:186`) y `runAgent` dos: el vivo (`claude.ts:66`) y el de un disparo (`pool.ts:304`), que no pasa la opción. En `confine.ts` el montaje está dentro de `name === 'claude'`, así que codex, fake y simulated no cambian.
- **Segundo test** (`sandbox-confine.test.ts:132`): pasa con y sin el arreglo, como dice el implementador. Sirve de guarda, no de prueba.
- `bun run typecheck`: limpio.
- Suite completa, una vez (`bun test tests`): 1389 pass, 2 skip, 0 fail en 138 ficheros. Ver el aviso de abajo sobre su último minuto.

### Aviso: el worktree cambió mientras verificaba

Hacia las 00:52, otra sesión empezó a editar el worktree sin commit (9 ficheros, entre ellos `src/sandbox/confine.ts`, `src/live/claude.ts`, `src/pool.ts` y `src/worktrees.ts`). Yo no hice esos cambios y **no los he revisado**.

- Todo este informe se refiere al commit `2304ca2`. Los experimentos de H1, H2 y H3 terminaron antes de la primera edición.
- La suite corrió de 00:48 a 00:53, así que su último minuto se solapó con esas ediciones. El resultado es fiable para casi todos los ficheros, no para todos.
- Lo que hay ahora sin commit parece un arreglo de H1 (directorio pasado por `LiveTurn` y fallo cerrado si cae en un montaje escribible). Necesita su propia verificación.

## Contraste con el informe del implementador

| afirmación | resultado |
|---|---|
| El test de persistencia falla sin el arreglo | Confirmado. |
| El segundo test pasa con y sin arreglo, por diseño | Confirmado. |
| Un disparo, codex, fake y simulated no cambian | Confirmado. |
| «No se comparte entre changes ni con el `~/.claude` del host» | **Falso ante un agente hostil** (H1, H2). Cierto solo si el agente coopera. |
| «Nada más del HOME se monta» | Cierto en el código; H1 permite al agente elegir qué se monta. |
| Cita `confine.ts:17` | La firma está en `:15` y el montaje en `:64`. |
| No limpia el directorio; se va con el worktree | De acuerdo (H6). |
| No cubre la ruta fuera de git | No hace falta (H7). |
| Usó `git stash` una vez | La pila es común a todos los worktrees; ahora está vacía. Para la próxima, mejor una copia temporal. |
| 1 fallo no identificado en la primera pasada de la suite | No lo reproduje: mi única pasada dio 0 fail. Sigue sin explicar. |
| Prueba real con `b2.ts` | No la repetí. |

## Lo que no revisé

- No ejecuté `claude` real: ni la reanudación con `--resume` ni qué más lee de `~/.claude/projects` (H5).
- La mutación de H3 la corrí sobre los 11 ficheros de test relacionados, no sobre la suite completa. Ningún otro test menciona `claudeProjects`.
- H1 y H2 los probé con `sh` dentro del sandbox, no con un agente real que decida hacerlo.
- No probé que `git worktree remove` borre `fab-live` (H6) ni el symlink sobre `fab-live` (H8).
- No revisé el resto del sandbox ni otros caminos de escape ya existentes por el git dir compartido.
- No probé turnos concurrentes sobre un mismo worktree.

## Segunda verificación

Commit `8e613b3` sobre `2304ca2`. Solo revisé las correcciones.

### Veredicto: listo para PR

H1 y H2 están cerrados: repetí los dos exploits contra el código nuevo y ya no funcionan. Los tests nuevos fallan sin su arreglo. Quedan dos huecos de test que no bloquean (N1, N2) y un test inestable ajeno a T40 (N3).

### Hallazgos anteriores

| id | estado | cómo lo comprobé |
|---|---|---|
| H1 | cerrado, **verificado** | En un layout real (`<state>/worktrees/<id>` enlazado, `<state>/live/<id>/claude-projects`): desde el sandbox, `<state>/live` no existe, así que el `mv` y el `ln -s` fallan. Tras el turno 1 el directorio del host sigue siendo un directorio. En el turno 2 el fichero del host no se ve ni se puede escribir. Con la ruta antigua (git dir del worktree, git dir común o dentro del worktree) `confineAgent` lanza «cae dentro de un montaje escribible» (`src/sandbox/confine.ts:65-71`). |
| H2 | cerrado, **verificado** | El sandbox de `a` no puede leer el transcript de `b` por su ruta, y `find` y `grep` no lo encuentran en `/tmp` ni `/home`. El transcript de `b` quedó intacto en el host. |
| H3 | cerrado en parte | El reenvío en `src/live/claude.ts:67` ya tiene test. El tramo del pool sigue sin él (N1). |
| H4, H7 | cerrados | Desaparecen al salir del git dir. **Inferido** de H1 y H2. |
| H5 | aceptado | Anotado por el implementador; sigue sin probar con claude real. |
| H6 | cerrado en parte | `mergeAndCleanup` borra y tiene test; `removeWorktree` borra pero no tiene test (N2). |
| H8 | abierto, fuera de alcance | Sin cambios. |

### Lo demás que pediste

- **`stateDir` no queda montado (verificado).** Dentro del sandbox, `<state>` solo contiene `worktrees/`, que son los directorios padre vacíos del montaje del worktree. `live/` no aparece.
- **Symlinks dentro del directorio persistido (verificado).** El agente puede crear uno hacia una ruta del host, pero se resuelve dentro del sandbox y no llega a nada. El `rmSync` de la limpieza (`src/worktrees.ts:169` y `:191`) borra el symlink sin seguirlo: el directorio víctima quedó intacto.
- **`Bun.which` con `PATH` (`src/sandbox/confine.ts:37`, verificado).** Sin el argumento, `Bun.which` ignora los cambios de `process.env.PATH` hechos en tiempo de ejecución; con él los respeta. `src/` no modifica `PATH` en ningún sitio, así que en producción resuelve el mismo binario que antes. El cambio solo afecta a los tests y lo decide el host, no el agente. `Bun.which('bun')` en `:44` sigue sin el argumento; es inofensivo.
- **Permisos (verificado).** `live/<id>/claude-projects` se crea con `0700`.
- **La comprobación y el montaje no son atómicos**, como dice el implementador. No importa: ningún sandbox puede escribir en esa ruta entre un paso y otro.

### Tests nuevos, con mutaciones en una copia temporal (sin `git stash`)

| mutación | test que debe fallar | resultado |
|---|---|---|
| `confine.ts` sin la comprobación de realpath | `tests/sandbox-confine.test.ts:132` | falla |
| `claude.ts` sin reenviar `claudeProjects` | `tests/live-claude.test.ts:114` | falla |
| `worktrees.ts` sin ningún borrado | `tests/worktrees.test.ts:51` (merge) | falla |
| solo `removeWorktree` sin borrado | ninguno | **pasa** (115 tests relacionados) |
| `pool.ts:299` sin pasar la ruta | ninguno | **pasa** (168 tests relacionados) |
| `turn.ts:78` sin reenviar | ninguno | **pasa** (168 tests relacionados) |

### Hallazgos nuevos

| id | severidad | ruta:línea | problema | escenario que falla | arreglo propuesto |
|---|---|---|---|---|---|
| N1 | media | `src/pool.ts:299`, `src/live/turn.ts:78` | Ningún test cubre el tramo pool → turno. El typecheck tampoco lo ve, porque el campo es opcional. | **Verificado.** Si se borra cualquiera de las dos líneas, vuelve el fallo original («No conversation found») y S3 lo tapa. También queda sin fijar que la ruta sea `<stateDir>/live/<id>`. | Un test del pool con backend vivo falso que compruebe el `claudeProjects` que recibe el turno. No bloquea. |
| N2 | baja | `src/worktrees.ts:191` | El borrado en `removeWorktree` no tiene test. | **Verificado.** Sin esa línea, los changes descartados o publicados dejan sus transcripts en `<stateDir>/live`. | Una aserción como la de `tests/worktrees.test.ts:51` en un test de `removeWorktree`. |
| N3 | info | `tests/agent.test.ts:103-108` | Test inestable, ajeno a T40: usa `timeoutMs: 40`. | **Verificado.** Falló una vez en la suite completa («Unexpected extra model call») y pasó 5 de 5 veces a solas. La rama no toca `src/agent`. Probablemente es el fallo que el implementador no identificó. | Tarea aparte. |
| N4 | info | `tests/live-claude.test.ts:118` | El test de cableado no borra su directorio temporal `live-state-*`. | Deja basura en `/tmp`. | Borrarlo en el `finally`. |

### Comandos

- `bun run typecheck`: limpio.
- `bun test tests`, una vez, sobre `8e613b3` con el worktree limpio antes y después: 1390 pass, 2 skip, 1 fail (N3) de 1393 tests en 138 ficheros.

### Lo que no revisé

- No ejecuté `claude` real ni repetí `b2.ts`.
- No muté el cambio de `Bun.which`: sin él, el test de cableado ejecutaría el `claude` real.
- Las mutaciones corrieron sobre los tests relacionados, no sobre la suite completa.
- Los exploits usan `sh` dentro del sandbox, no un agente real.
- No probé dos changes cuyo id comparta los 8 primeros caracteres (compartirían directorio, igual que ya comparten ruta de worktree).
- Dejé sin borrar mi directorio de prueba `/tmp/fab-v2-NrF87I`.

<!-- FIN -->
