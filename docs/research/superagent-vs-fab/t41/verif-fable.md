# T41 — informe del verificador (Fable 5.2)

Rama `fix/t41-fab-live-symlink`, commit `11011ab`, sobre `origin/release/0.1.0-rc.12` (`2cd3594`). Solo lectura sobre el worktree: las mutaciones y los exploits se hicieron en una copia temporal, sin `git stash`.

Marcas: **[V]** verificado ejecutando o leyendo la línea citada; **[I]** inferido.

## Veredicto

> **Actualización:** este veredicto es el de `11011ab`. El commit de correcciones `57d4b6b` se verifica al final, en «Segunda verificación», y su veredicto es **listo para PR**.

**Listo con cambios** (sobre `11011ab`).

- El ataque original queda cerrado en la configuración normal (`stateDir` fuera del repo, por defecto `~/.fabrica`). **[V]**
- La config se ve en solo lectura dentro del sandbox y ninguna de las 13 variantes de escritura probadas la modificó. **[V]**
- El cambio pedido es H1: el «falla cerrado» no salta justo cuando hay un symlink plantado. Solo se alcanza con `FABRICA_HOME` dentro de un git dir, pero es la misma clase de fallo que T41 dice cerrar.
- H2 (aserciones muertas en un test) conviene arreglarlo en el mismo PR. El resto no bloquea.

## Hallazgos

| id | severidad | `ruta:línea` | problema | escenario que falla | arreglo |
|---|---|---|---|---|---|
| H1 | media, condicionada a mala configuración | `src/sandbox/confine.ts:76-77`, `src/live/claude.ts:64-66` | La comprobación `writable` se hace sobre la ruta ya resuelta del fichero, y después de que el host lo haya escrito. Si `mcp/` es un symlink hacia fuera, la ruta resuelta queda fuera de los montajes escribibles y la comprobación pasa. | `stateDir` dentro del git dir y `mcp` cambiado por un symlink a una víctima: el turno confinado **no falla**, y el host crea y borra `mcp-<uuid>.json` con el token en la víctima. **[V]** (E5) | Comprobar la ruta configurada antes de escribir: ningún prefijo de `mcpConfigDir`, resuelto, puede caer en un montaje escribible. Más simple: que el pool rechace al arrancar un `stateDir` cuya ruta real caiga en el git dir del repo. |
| H2 | baja (test) | `tests/sandbox-confine.test.ts:156-164` | El test de `confineAgent` solo mira `stdout`. No comprueba el código de salida, así que `! (echo x >> …)` y `test "$0" = …` no afirman nada. | Cambiar `--ro-bind` por `--bind` no mata este test; lo mata solo el de `tests/live-claude.test.ts:132`. **[V]** (M8) | Añadir `expect(ok.exitCode).toBe(0)`. |
| H3 | baja (robustez) | `src/sandbox/confine.ts:75,79` | `indexOf` sustituye solo la primera aparición. Si la ruta no está en argv, no monta nada y no avisa. La forma `--mcp-config=<ruta>` no se reconoce. | Ruta dos veces: queda `--mcp-config <ruta del host>` en el argv del sandbox. Ruta ausente: sin montaje y sin error. **[V]** (E3) Hoy no se alcanza: el prompt va por stdin (`src/agents.ts:46-50`) y el nombre lleva un UUID. **[V]** | Sustituir todas las apariciones y lanzar error si `mcpConfig` viene y no está en argv. |
| H4 | baja | `src/live/claude.ts:35-36` | El camino sin confinar sigue escribiendo en `<git-dir>/fab-live`, que cualquier agente confinado del mismo repo puede cambiar por un symlink (el git dir común se monta en escritura). | Un agente confinado del change A planta `worktrees/<B>/fab-live`; un turno sin confinar de B, llamado sin `mcpConfigDir`, deja su token en el worktree de A mientras dura. **[V]** (E4) El pool no llega ahí: siempre pasa `mcpConfigDir` (`src/pool.ts:300`). **[V]** | Quitar el respaldo `fab-live` y exigir `mcpConfigDir` siempre, o dejarlo anotado como camino solo de tests. |
| H5 | informativa | `src/sandbox/confine.ts:78` | El directorio `/opt/fab-mcp` no es de solo lectura: se puede renombrar y crear otro con un `mcp.json` propio. | `mv /opt/fab-mcp /opt/fab-mcp2` devuelve 0. **[V]** (E1) Solo cambia la vista del propio sandbox; el fichero del host no se toca. **[V]** No da privilegios: el agente ya puede leer su token. **[I]** | Ninguno obligatorio. Si se quiere, montar el directorio en vez del fichero. |
| H6 | informativa | `src/sandbox/confine.ts:78` | La ruta del host (con `stateDir` y el UUID) se lee dentro del sandbox en `/proc/1/cmdline` y `/proc/self/mountinfo`. | **[V]** (E1) Es una ruta, no el token, y ya pasaba con el worktree y `claude-projects`. | Ninguno en T41. |
| H7 | media, preexistente (T40), fuera de alcance | `src/sandbox/confine.ts:69-72` | Mismo hueco que H1 en `claudeProjects`, con peor efecto: se monta en escritura. | `claude-projects` dentro del git dir y cambiado por symlink: el sandbox escribe `PWNED` en la víctima. Sin symlink sí falla cerrado. **[V]** (E6) | Tarea aparte; el arreglo de H1 a nivel de `stateDir` cubre los dos. |

**Quién planta el symlink en H1 y H7.** Con esa mala configuración, el primer turno vivo confinado falla cerrado antes de lanzar al agente **[V]** (E6, «sin symlink»). El symlink tiene que venir de un agente confinado de un disparo (validadores, gates o un pool sin `--live`), que recibe el git dir común en escritura sin pasar por estas comprobaciones **[I]** (leído en `src/sandbox/confine.ts:33-38`, no ejecutado de punta a punta).

## Respuestas al brief

1. **Exploit.** Con `fab-live` como symlink en el git dir del worktree y en el común, la víctima queda vacía y `mcp/` vacío al terminar **[V]** (E1). Desde dentro no se ve `<stateDir>/live/<id>/mcp` ni la config de otro change **[V]**. `ls <stateDir>` sí responde, pero solo muestra el directorio intermedio que bwrap crea para montar el worktree **[I]**.
2. **Solo lectura de verdad.** Fallaron: añadir, truncar, borrar, renombrar, sustituir con `mv`, `ln -sfn`, `chmod`, `touch` en el directorio, `umount`, `mount -o remount,rw`, y lo mismo dentro de `unshare -Urm` **[V]** (E1). Con un fichero estático, el contenido y el inodo del host no cambian **[V]** (E2). Única excepción: H5.
3. **Sustitución en argv.** Ver H3. En el camino real el argv del agente lleva solo `/opt/fab-mcp/mcp.json` **[V]** (E1). La ruta del host queda en el argv de `bwrap`, visible como en H6.
4. **Sin confinar.** Aceptable tal como llama el pool. Confinado y sin `mcpConfigDir` lanza error antes de ejecutar nada (`src/live/claude.ts:33`) **[V]**. `runLiveTurn` fuerza `confine: true` en changes de canal (`src/admission/channel.ts:19-22`) y el turno ya trae `mcpConfigDir` **[V]**. Residuo: H4.
5. **Limpieza.** El `finally` borra la config tanto si `runAgent` devuelve como si lanza (`src/live/claude.ts:83`) **[V]**; un aborto mata el grupo y `runAgent` lanza por código de salida, así que pasa por el mismo `finally` **[I]**. `mergeAndCleanup` y `removeWorktree` borran `<stateDir>/live/<id>` entero, `mcp/` incluido (`src/worktrees.ts:169,191`) **[V]** (leído, no ejecutado). Si el host muere con `SIGKILL`, el fichero queda hasta esa limpieza, con un token de un servidor ya cerrado **[I]**.
6. **Alcance.** `confineAgent` tiene un único llamador (`src/agents.ts:186`) y `runAgent` dos (`src/live/claude.ts:73`, `src/pool.ts:306`) **[V]**. El de un disparo no pasa `mcpConfig`, así que el bloque nuevo no entra. El bloque está dentro de `name === 'claude'`: codex, fake y simulated no cambian **[V]** (E3).
7. **Tests.** Las siete mutaciones del implementador mueren, y coinciden con las mías (M1–M9, M12). Mutaciones que sobreviven:

| mutación | resultado | qué es |
|---|---|---|
| M11: quitar `realpathSync(mcpConfig)` | sobrevive | hueco de test: no hay caso con symlink hacia un montaje escribible (sí lo hay para `claudeProjects`). El código actual sí lo rechaza **[V]** (E3). |
| M13, M14: quitar los modos `0o600` y `0o700` | sobreviven | hueco de test, anterior a T41. |
| M15: montar aunque la ruta no esté en argv | sobrevive | hueco de test; ver H3. |
| M16: `lastIndexOf` en vez de `indexOf` | sobrevive | equivalente mientras la ruta aparezca una vez. |
| M8: `--bind` en vez de `--ro-bind` | muere, pero solo por un test | ver H2. |

## Contraste con el informe del implementador

- **Coincide:** ficheros tocados, cableado, las siete mutaciones, los tres ficheros de test (40 pasan, 1 se salta) y `typecheck` limpio **[V]**.
- **No se sostiene del todo:** «falla cerrado si cae en un montaje escribible». Es cierto sin symlink y falso con él (H1). Su test solo cubre el caso sin symlink.
- **Impreciso:** atribuye la mutación 6 al test del symlink, y es correcto; pero el test de `confineAgent` que parece cubrirla no afirma nada (H2).
- **Suite completa, no reproducida:** la corrí una vez en la copia temporal y dio 1334 pasan, 2 se saltan y **75 fallan**, en 20 ficheros `agent-*`, `script-runtime`, `chat-*` y otros que el commit no toca. Cuatro de esos ficheros (44 de los 75 fallos) pasan en el worktree real **[V]**; para el resto supongo que es efecto de la copia (no copié `docs/`, `site/` ni `techdocs/`) **[I]**. No confirmo el «0 fail» del implementador.
- **No mencionado por él:** H3, H4, H5, H6 y H7.
- **Su «no hice»** (no comprobar `stateDir` dentro de lo escribible) es justo donde está H1.

## Lo que no revisé

- No ejecuté `claude` real ni `b2.ts`: todo fue con un `claude` falso en el `PATH`. No sé si `claude` relee `--mcp-config` durante el turno (afecta solo a H5).
- No repetí la suite completa en el worktree real, por el límite de una vez.
- No ejecuté `mergeAndCleanup` ni `removeWorktree`; solo leí las líneas.
- No probé el aborto ni el timeout de un turno de punta a punta.
- No busqué a fondo si algo valida la ubicación de `stateDir` al arrancar; solo vi que sale de `FABRICA_HOME` (`src/cli.ts:58`).
- No revisé T34 (token y servidor MCP en `127.0.0.1`, alcanzable desde el sandbox porque la red no se aísla).
- No probé en otro kernel ni otra versión de bubblewrap.

Evidencia (temporal, se pierde al limpiar): `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/exploit.ts`, `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/e6.ts`, `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/mut.sh` y `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/full.txt`.

## Segunda verificación: `57d4b6b`

Commit de correcciones sobre `11011ab`. Mismo método: mutaciones y exploits en una copia temporal nueva, solo lectura sobre el worktree.

### Veredicto

**Listo para PR.**

- H1, H2, H3, H4 y H7 quedan cerrados. **[V]**
- Queda una regresión de disponibilidad, N1: si `stateDir` se alcanza a través de un symlink, todos los turnos vivos fallan. Falla cerrado y con mensaje claro, y el implementador ya lo declara; no lo considero bloqueante, pero el dueño debería decidirlo antes de publicar.
- La suite completa pasa en el worktree real sobre `57d4b6b`: 1411 pasan, 2 se saltan, 0 fallan. `typecheck` limpio. **[V]**

### Estado de los hallazgos anteriores

| id | estado | evidencia |
|---|---|---|
| H1 | cerrado | `hostDir` (`src/sandbox/confine.ts:33-39`) se llama antes de escribir (`src/live/claude.ts:53`). Con `stateDir` en el git dir y `mcp` como symlink, el turno falla, confinado o no, y la víctima no recibe ningún evento. **[V]** (E5) |
| H2 | cerrado | El test afirma `exitCode === 0`; `--bind` en vez de `--ro-bind` mata ahora dos tests. **[V]** (N9) |
| H3 | cerrado | Ruta dos veces: se sustituyen las dos. Ruta ausente o en la forma `--mcp-config=<ruta>`: error antes de lanzar. **[V]** (E3) |
| H4 | cerrado | Sin `mcpConfigDir` el turno falla, confinado o no, y no se crea `fab-live`. El symlink plantado por A en el git dir de B ya no recibe nada. **[V]** (E4) |
| H5 | abierto, a propósito | `/opt/fab-mcp` sigue siendo escribible y renombrable dentro del sandbox. **[V]** Corrección a mi primera pasada: `touch /opt/fab-mcp/x` sí funciona; antes falló solo porque el directorio ya estaba renombrado. La conclusión no cambia: no afecta al host. |
| H6 | abierto, a propósito | La ruta del host sigue visible en `/proc/1/cmdline`. **[V]** |
| H7 | cerrado | `claudeProjects` pasa por `hostDir` (`src/sandbox/confine.ts:84`). Con symlink a la víctima falla y no se escribe `PWNED`. **[V]** (E6) |

El ataque original y las variantes de escritura dentro del sandbox dan el mismo resultado que antes: nada modifica la config y la víctima queda vacía. **[V]** (E1, E2)

### Hallazgos nuevos

| id | severidad | `ruta:línea` | problema | escenario que falla | arreglo |
|---|---|---|---|---|---|
| N1 | media (disponibilidad, no seguridad) | `src/sandbox/confine.ts:36`, `src/pool.ts:299-300` | `hostDir` rechaza cualquier symlink en toda la ruta, y el pool pasa `resolve(stateDir)`, no la ruta real. | `stateDir` legítimo alcanzado por un symlink (`HOME` enlazado, `FABRICA_HOME` vía enlace): el turno vivo falla con «la ruta contiene un symlink», confinado o no. **[V]** (E7) Antes de este commit funcionaba. | Separar la raíz de confianza: resolver `stateDir` una vez, rechazarlo si su ruta escrita o su ruta real caen en un montaje escribible, y exigir «sin symlinks» solo de ahí hacia abajo. |
| N2 | baja | `src/sandbox/confine.ts:34-36` | `hostDir` hace `mkdir` recursivo antes de comprobar. | Con `stateDir` en el git dir y un ancestro (`live/<id>`) cambiado por symlink, el turno falla pero queda un directorio vacío `mcp` o `claude-projects` en la víctima. **[V]** (E5, E6) Con el symlink en la hoja no queda nada. | Comprobar el ancestro existente más cercano antes de crear, o crear componente a componente. |
| N3 | baja | `src/sandbox/confine.ts:22`, `src/live/claude.ts:53` | Un turno sin confinar exige ahora que `cwd` sea un repo git, y el error dice `--confine`. | `cwd` que no es repo: «--confine: no se pudo resolver .git» en un turno sin confinar. **[V]** (E4) El pool siempre pasa un worktree. **[I]** | Ajustar el mensaje, o no resolver montajes cuando no hay repo. |
| N4 | informativa | `src/sandbox/confine.ts:89-90` | Se comprueba el directorio de la config, no el fichero: si el fichero fuese un symlink, se montaría su destino. | Fichero symlink a uno del git dir, en un directorio limpio: se monta (en solo lectura). **[V]** (E3) No se alcanza: el host crea el fichero con un UUID en un directorio que el agente no escribe. **[I]** | Ninguno obligatorio. |
| N5 | informativa | `src/sandbox/confine.ts:87` | Con un adaptador que no es `claude`, `mcpConfig` se ignora sin aviso y la ruta del host queda en argv. | **[V]** (E3) Hoy no hay backend vivo fuera de `claude`. | Ninguno ahora. |

### Mutaciones sobre `57d4b6b`

Sobre los cinco ficheros de test relacionados (59 pasan, 1 se salta). De 17 mutaciones mueren 15:

- comprobación de symlink, comprobación `writable` (entera y solo la parte `startsWith`), exigencia de `mcpConfigDir`, `hostDir` antes de escribir, `hostDir` en `confineAgent` para `mcpConfig` y para `claudeProjects`, error por ruta ausente, sustituir solo la primera aparición, no sustituir, `--bind`, quitar `--git-common-dir`, no borrar la config al terminar, línea del pool y cableado en `turn.ts`. **[V]**
- **Sobreviven dos:** quitar el modo `0o700` del directorio y el `0o600` del fichero. Hueco de test, anterior a T41.

### Contraste con las «Correcciones tras verificación» del implementador

- **Coincide:** qué cambió, los tests nuevos, las mutaciones, `typecheck` y el resultado de la suite completa (1411, 2, 0). **[V]**
- **Sus dos límites declarados son N1 y N2**, y los confirmo. Un matiz en N2: no hace falta un symlink colgante; basta un ancestro enlazado a un directorio que existe.
- **No mencionados por él:** N3 lo cita solo como consecuencia («el `cwd` tiene que ser un repo git»), sin el mensaje engañoso; N4 y N5 no aparecen.

### Lo que no revisé en esta pasada

- Sigo sin ejecutar `claude` real ni `b2.ts`; el implementador tampoco los repitió tras este commit.
- No ejecuté `mergeAndCleanup` ni `removeWorktree`, ni el timeout de un turno. El aborto sí lo cubre un test que pasa.
- No probé N1 de punta a punta con el pool; lo reproduje llamando al backend con una ruta bajo un symlink y leyendo `src/pool.ts:299-300`.
- No probé en otro kernel, otra versión de bubblewrap ni macOS.

Evidencia (temporal): `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/exploit2.ts`, `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/e2.txt`, `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/mutN.txt` y `/tmp/claude-1000/-home-orlando-Desktop-factory-sw-factory-t41/465c7eda-0b98-48d4-8e98-4ff5eba3c768/scratchpad/full-wt.txt`.

<!-- FIN -->
