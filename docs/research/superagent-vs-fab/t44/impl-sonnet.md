# T44 — informe del implementador (Sonnet 5.5)

Rama `fix/t44-statedir-raiz` sobre `aa2142b`. Sin push ni merge. Los tres commits:

1. `test(sandbox): stateDir como raíz de confianza y nada creado a través de symlinks (T44)`: tests en rojo.
2. `fix(sandbox): stateDir como raíz de confianza en hostDir; nada se crea a través de un symlink (T44)`.
3. `test(sandbox): hostDir fuera de la raíz y stateRoot obligatorio; quitar comprobaciones redundantes (T44)`.

## Qué cambié y dónde

- `src/sandbox/confine.ts`: `hostDir(dir, cwd, root)` tiene un parámetro más, la raíz. Orden:
  1. el dir debe estar bajo la raíz (o ser la raíz);
  2. recorre con `lstat` de la raíz hacia abajo y lanza si hay un symlink o un no-directorio;
  3. rechaza la raíz si su ruta escrita (`resolve`) o su ruta real (`realLoose`: `realpath` del prefijo existente más el resto) cae en un montaje escribible;
  4. solo entonces crea, componente a componente y sin `recursive` por debajo de la raíz (`mkdir` 0700);
  5. comprueba que `realpath(dir) === realpath(raíz)/rel`.
  Los enlaces por encima de la raíz no importan. Hasta el paso 3 no se crea nada (N2 cerrado). `confineAgent` recibe `stateRoot` como séptimo parámetro y lo pasa a `hostDir` para `claudeProjects` y `dirname(mcpConfig)`. Lanza si recibe cualquiera de los dos sin `stateRoot`.
- Cómo viaja la raíz: `pool.ts` (`stateRoot: resolve(opts.stateDir)`) → `LiveActivityCtx.stateRoot` (`src/live/turn.ts`) → `LiveTurn.stateRoot` (`src/live/contract.ts`) → `claudeLive.run` (`src/live/claude.ts`) → `runAgent` option `stateRoot` (`src/agents.ts`) → `confineAgent`. Es obligatorio con `mcpConfigDir`: sin él el turno falla antes de lanzar nada, confinado o no.
- `claude.ts` escribe la config por la ruta tal como viene (`join(turn.mcpConfigDir, …)`), no por la devuelta por `hostDir`. Esa ruta ya está validada y queda bajo la raíz tal como está escrita. `confineAgent` vuelve a validar su `dirname`.

## Condiciones del encargo

| # | Condición | Cómo se cumple |
|---|---|---|
| 1 | Raíz rechazada si la ruta escrita o la real es un montaje escribible | `inMount(rootPath) \|\| inMount(realRoot)` |
| 2 | Raíz bajo un enlace, aceptada | solo se mira bajo la raíz |
| 3 | Sin symlinks de la raíz hacia abajo, ni dir final en montaje | `lstat` + `realpath` final |
| 4 | Nada se crea a través de un symlink | todas las comprobaciones van antes del primer `mkdir` |
| 5 | Falla cerrado antes de escribir y de lanzar, confinado o no | `hostDir` va antes de `writeFileSync`; `confineAgent` lanza antes de `spawn` |

Las cinco se cumplen. No hubo que parar.

## Tests nuevos (`tests/live-claude.test.ts`, bloque T44, salvo indicación)

Todos fallaban antes (los 6 de la tanda inicial, confirmado en el commit 1). El de `stateRoot` obligatorio y el de `hostDir` fuera de la raíz se añadieron después, en el commit 3.

| test | ¿fallaba antes? |
|---|---|
| `stateDir` alcanzado por un symlink (raíz = el enlace, o colgando de él), confinado y no | sí: «la ruta contiene un symlink» |
| `stateDir` dentro del git dir sin symlinks: falla `/escribible/`, no se crea ni `.git/state` | sí, pero solo por la aserción secundaria «no se crea `.git/state`»: ya fallaba cerrado con `/escribible/`, pero `hostDir` creaba antes de comprobar |
| raíz escrita en el git dir y cambiada por symlink hacia fuera: falla, víctima vacía | sí |
| raíz fuera, symlink hacia dentro del git dir: falla, el dir interno queda vacío | sí |
| symlink en la hoja `mcp` y en el ancestro `live/<id>`, hacia una víctima, confinado y no: falla `/symlink/`, víctima vacía (`readdirSync`) | sí (el ancestro dejaba un dir) |
| `tests/sandbox-confine.test.ts`: lo mismo para `claudeProjects` (hoja y ancestro) | sí |
| sin `stateRoot` el turno falla cerrado, sin lanzar nada | sí |
| `tests/sandbox-confine.test.ts`: `hostDir` rechaza un dir fuera de la raíz; `confineAgent` rechaza `claudeProjects` o `mcpConfig` sin raíz | sí |
| `tests/pool-live.test.ts`: el turno recibe `stateRoot = stateDir` | sí |

Tests existentes: solo les añadí el argumento `stateRoot` a las llamadas (`live-claude`, `live-report`, `live-sessions`, `sandbox-confine`). Ninguna aserción se relajó ni se quitó. Los tests de T41 siguen pasando; para el de `claude-projects` en el git dir la raíz es `.git/state`, y el error sigue siendo `/symlink/` porque el recorrido de symlinks va antes que la comprobación de montaje.

## Mutaciones (copia temporal en el scratchpad, sin `git stash`; 5 ficheros de test)

Script y salida: `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t44/792b9001-2362-468c-b1b2-04af3c0e3a22/scratchpad/mut/run.py` y `…/mut2.txt`.

| mutación | resultado | test que muere |
|---|---|---|
| M1 sin `lstat` antes de crear (N2) | muere | los de hoja/ancestro de `mcp` y `claudeProjects`, y los dos de T41 con symlink |
| M2 raíz escrita en montaje no se rechaza | muere | raíz escrita en git dir → symlink fuera |
| M3 raíz real en montaje no se rechaza | muere | raíz fuera → symlink hacia dentro |
| M4 dir fuera de la raíz se acepta | muere | `hostDir` fuera de la raíz |
| M5 sin comparar `realpath(dir)` con `realpath(raíz)/rel` | **sobrevive** | solo protege contra un cambio entre la comprobación y el uso; no es testeable sin carrera |
| M6 `mkdir` recursivo por debajo de la raíz | **sobrevive** | equivalente sin carrera: antes ya se rechazó todo symlink |
| M7 `claude.ts` no exige `stateRoot` | muere | «sin stateRoot…» |
| M8 `confineAgent` no exige `stateRoot` | muere | `hostDir` fuera de la raíz / sin raíz |
| M9 pool sin `stateRoot` | muere | `pool-live` |
| M10 `turn.ts` no propaga | muere | `pool-live` |
| M11 `runAgent` no propaga | muere | 3 tests de `live-claude` |
| M12 se permite symlink bajo la raíz | muere | 6 tests |
| M13 `confineAgent` no valida `claudeProjects` con `hostDir` | muere | 5 tests |
| M14 `confineAgent` no valida `mcpConfig` con `hostDir` | muere | test de `mcpConfig` de `sandbox-confine` |

En la primera pasada también sobrevivían la comprobación de montaje sobre `join(realRoot, rel)` y la final sobre `real`. Eran redundantes (todo dir bajo la raíz está en un montaje si la raíz lo está) y las quité, en vez de dejar código que ningún test distingue. Quité también el segundo `lstat` posterior a crear, que M5 hacía redundante.

## Prueba real

`b2-t41.ts` existía. Copia en `…/scratchpad/b2-t44.ts` con `SRC` apuntando a `sw-factory-t44/src` (el original no se tocó); lo ejecuté una vez con `bun run b2-t44.ts <dir desechable>` (necesita ese argumento). Terminó con `exit 0`: dos sesiones abiertas (investigación e implementación), el argv lleva `--mcp-config /opt/fab-mcp/mcp.json`, y el turno de implementación reportó `done` con `color.txt` = «rojo» commiteado. Solo vi la cola de la salida (últimas ~30 líneas), así que no revisé yo mismo el `awaiting` ni la reanudación intermedios; los dos turnos terminaron con sesión abierta. El script usa un `stateDir` sin symlink: **no probé con `claude` real un `stateDir` alcanzado por un enlace**, eso lo cubren solo los tests con `claude` falso.

## Comandos

- `bun run typecheck`: limpio.
- `bun test tests/live-claude.test.ts tests/sandbox-confine.test.ts tests/pool-live.test.ts tests/live-report.test.ts tests/live-sessions.test.ts`: 67 pasan, 0 fallan (tras el commit 3). Antes del arreglo: 6 fallaban, 39 pasaban.
- `bun test tests` completo, una vez, al final: 1419 pasan, 2 se saltan, 0 fallan (1421 tests, 138 ficheros, 295 s).

## Lo que no hice

- Carrera real (cambiar el dir entre `lstat` y `mkdir`): solo lo cubre el chequeo final, no testeado (M5/M6).
- N3, N4, N5, H5, H6 y T34: no tocados. Tampoco el camino de un disparo ni los adaptadores codex, fake y simulated; el montaje en `/opt/fab-mcp/mcp.json` y la sustitución en argv, sin cambios.
- `stateRoot` es obligatorio también para llamadas directas a `confineAgent` con `claudeProjects` o `mcpConfig`. Cambia la firma, no el comportamiento de quien ya pasaba una raíz sana. No se ve en el CLI ni en tablas.
- No actualicé `task.json` ni techdocs.

## Correcciones tras verificación

Un solo commit sobre `8e1f3a9`: `fix(sandbox): hostDir comprueba cada prefijo de la raíz y el directorio final contra los montajes (T44)`.

**Qué cambié (`src/sandbox/confine.ts`, solo `hostDir`).**
- V1: en vez de comparar el texto de la raíz y su ruta real, recorre cada prefijo de la ruta escrita de la raíz y rechaza si `realLoose(prefijo)` es un montaje escribible o cae dentro de uno.
- V2: antes de crear nada comprueba también `join(realLoose(raíz), rel)`, el directorio final, contra los montajes. Como no hay symlinks bajo la raíz, esa es su ruta real.
- La comprobación de la raíz real queda subsumida por el bucle (el prefijo final es la propia raíz).

**Tests** (los tres primeros se escribieron antes del arreglo):
| test | ¿fallaba antes? |
|---|---|
| V1, `live-claude.test.ts`: repo alcanzado por un enlace, raíz escrita en su git dir y cambiada por symlink a una víctima; confinado y sin confinar, falla `/escribible/`, víctima vacía | sí |
| V2, `sandbox-confine.test.ts`: dir dentro de un worktree bajo la raíz; falla y no se crea `x` | sí |
| V3a, mismo fichero: componente que es un fichero, falla `/no es un directorio/` | no (hueco de test, ya se rechazaba) |
| V3b: `hostDir(repo, repo, repo)` y `hostDir(repo/live, repo, repo)`: raíz = montaje exacto, falla `/escribible/` | no (hueco de test) |

**Mutaciones** (copia temporal en el scratchpad, sin `git stash`; los dos ficheros de test):
| mutación | resultado |
|---|---|
| bucle de prefijos reducido a la raíz sola | mueren V1 y el de «raíz escrita en el git dir → symlink fuera» |
| sin comprobación del dir final | muere V2 |
| sin rechazo de no-directorio | muere V3a |
| sin igualdad exacta `p === w` | muere V3b |

**Script de exploits** (`bun exploit-t44.ts <worktree>`, salida idéntica en las dos pasadas, confinado y no):
```
a0 estado normal             : OK (no falla) | ro visto: true | RW: false | mcp tras turno: []
a  raiz bajo enlace legitimo : OK (no falla)
a2 enlace en ancestro de raiz: OK (no falla)
g  raiz escrita via prefijo enlazado, en git dir -> victima: FALLA: ... cae dentro de un montaje escribible ... | eventos=[] queda=[]
h  destino dentro del worktree (bajo la raiz): FALLA: ... cae dentro de un montaje escribible del sandbox | creado: false
```

**Comandos:** `bun run typecheck` limpio; `bun test` de los cinco ficheros del área: 70 pasan, 0 fallan; `bun test tests` completo una vez: 1422 pasan, 2 se saltan, 0 fallan.

**No hice:** prueba con `claude` real; `mergeAndCleanup`/`removeWorktree`; push, merge ni GitHub. No toqué nada fuera de `confine.ts` y sus tests.

<!-- FIN -->
