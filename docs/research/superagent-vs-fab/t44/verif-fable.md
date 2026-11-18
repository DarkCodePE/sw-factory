# T44 — informe del verificador (Fable 5.2)

Rama `fix/t44-statedir-raiz`, `HEAD` `8e1f3a9` (tres commits sobre `aa2142b`). El SHA no cambió entre el principio y el final. Solo lectura sobre el worktree: mutaciones y exploits en una copia temporal, sin `git stash`. Procedimiento: skill `/verificar-cambio`.

Marcas: **[V]** verificado ejecutando o leyendo la línea citada; **[I]** inferido.

Nota de independencia: quien verifica escribió también el brief. Los hallazgos se escribieron antes de leer el informe del implementador.

## Veredicto

> **Actualización:** este veredicto es el de `8e1f3a9`. El commit de arreglos `ad4330e` se verifica al final, en «Segunda verificación», y su veredicto es **listo para PR**.

**Listo con cambios** (sobre `8e1f3a9`).

- N1 y N2 quedan cerrados: un `stateDir` legítimo bajo un enlace funciona, y nada se crea a través de un symlink. **[V]**
- Pero dos de las cinco condiciones del brief no se cumplen del todo: la 1 tiene un caso que se escapa (V1) y la 3 se perdió (V2). Los dos se arreglan con pocas líneas y un test cada uno.
- Suite completa en el worktree real: 1419 pasan, 2 se saltan, 0 fallan. `typecheck` limpio. **[V]**

## Hallazgos

| id | severidad | `ruta:línea` | problema | escenario que falla | arreglo |
|---|---|---|---|---|---|
| V1 | media, condicionada a mala configuración | `src/sandbox/confine.ts:60-63` | La «ruta escrita» de la raíz se compara como texto con los montajes, que son rutas reales. Si la ruta escrita pasa por un enlace por encima del repo, el texto no coincide y la comprobación no salta. | Raíz escrita como `<enlace>/repo/.git/estado`, con `estado` cambiado por un symlink a una víctima: el turno **funciona**, confinado o no, y el host crea `live/…` dentro de la víctima. **[V]** (caso g) El token se escribe ahí durante el turno. **[I]** Reabre H1 de T41 en esa configuración. | Recorrer los prefijos de la ruta escrita de la raíz y rechazarla si la ruta real de alguno es un montaje o cae dentro de uno. El directorio del montaje siempre está en el camino y el agente no puede cambiarlo. Test con el repo alcanzado por un enlace. |
| V2 | media | `src/sandbox/confine.ts:63,69-72` | Solo se comprueba que la **raíz** no esté en un montaje escribible. El directorio final ya no se comprueba. Los worktrees viven bajo `stateDir`, así que un directorio puede estar bajo la raíz y dentro de un montaje. | `hostDir(<stateDir>/worktrees/<id>/x/mcp, …)`: se acepta y se crea dentro del worktree del agente. **[V]** (caso h) En `57d4b6b` fallaba. El pool no pasa rutas así (`src/pool.ts:299-301`) **[V]**, pero es la garantía de T41 y la condición 3 del brief. | Volver a comprobar el directorio final contra los montajes antes de crear (`join(realRoot, rel)`), y un test con un directorio dentro del worktree. |
| V3 | baja (tests) | `src/sandbox/confine.ts:56,60` | Dos mutaciones sobreviven por falta de test. | Quitar el rechazo de un componente que no es directorio (K12) y quitar la igualdad exacta raíz = montaje (K13) no matan ningún test. **[V]** | Un test para cada una. |

## Lo que sí se comprobó que funciona

Con un `claude` falso, confinado y sin confinar **[V]**:

| caso | resultado |
|---|---|
| Estado normal | funciona; config visible en solo lectura; `mcp/` vacío al terminar |
| Raíz que es un enlace legítimo, o que cuelga de uno | funciona (N1 cerrado) |
| Raíz dentro del git dir | falla; no se crea nada |
| Raíz escrita en el git dir y cambiada por symlink a la víctima | falla; la víctima no recibe eventos |
| Raíz fuera, symlink hacia dentro del git dir | falla; el destino queda vacío |
| Symlink en `mcp`, en `live/<id>` o en `live` hacia la víctima | falla; la víctima no recibe eventos (N2 cerrado) |
| Symlink colgante en `mcp` | falla; no se crea el destino |
| `claude-projects` como symlink (confinado) | falla; víctima intacta |
| Directorio fuera de la raíz, con `..`, o raíz vacía | falla |
| Un componente que es un fichero | falla |
| `confineAgent` con `claudeProjects` o `mcpConfig` y sin raíz | falla |

## Mutaciones

Sobre los cinco ficheros de test relacionados (67 pasan, 1 se salta). De 13 mueren 9:

- **Mueren:** comprobación previa de symlinks, raíz escrita, raíz real, «bajo la raíz», que el symlink lance, exigir `stateRoot` en `confineAgent` y en el turno, la línea del pool y el cableado en `turn.ts`.
- **Sobreviven por equivalencia (K4, K6):** la comprobación final de `realpath` y el `mkdir` componente a componente. Solo protegen de un cambio entre comprobar y crear, que no puede ocurrir si la raíz no es escribible.
- **Sobreviven por hueco de test (K12, K13):** ver V3.

## Contraste con el informe del implementador

- **Coincide:** el diseño, cómo viaja la raíz, los tests nuevos, las mutaciones que mueren y las dos equivalentes, y los números de la suite. **[V]**
- **No se sostiene:** su tabla dice que la condición 3 se cumple («ni dir final en montaje») con `lstat` más `realpath` final. No es así (V2). Él mismo cuenta que quitó la comprobación de montaje sobre el directorio final por redundante, con el argumento de que todo directorio bajo la raíz está en un montaje si la raíz lo está. Lo que hace falta es lo contrario, y es falso: el worktree está bajo la raíz y es un montaje.
- **No se sostiene del todo:** la condición 1. Se cumple cuando la ruta escrita es canónica; con un enlace por encima del repo, no (V1). No lo probó.
- **No mencionado:** K12 y K13.
- **Prueba real:** dice que terminó con `exit 0` y que solo vio la cola de la salida. No la repetí.

## Lo que no revisé

- No ejecuté `claude` real ni `b2`.
- No probé V1 de punta a punta con el pool; lo reproduje llamando al backend con la raíz escrita a través de un enlace.
- No comprobé el token dentro de la víctima en V1: vi el directorio creado y que el turno terminó bien.
- No ejecuté `mergeAndCleanup` ni `removeWorktree` con la raíz nueva.
- No probé en otro kernel, otra versión de bubblewrap ni macOS.

Evidencia: `exploit-t44.ts`, junto a este informe. Se corre con `bun exploit-t44.ts <ruta de una copia del repo>`.

## Segunda verificación: `ad4330e`

Un commit sobre `8e1f3a9` que toca solo `src/sandbox/confine.ts` y dos ficheros de test. El SHA no cambió durante la verificación. Copia temporal nueva y el mismo script de exploits, sin cambios.

### Veredicto

**Listo para PR.** Sin hallazgos nuevos.

### Estado de los hallazgos

| id | estado | evidencia |
|---|---|---|
| V1 | cerrado | `hostDir` recorre cada prefijo de la ruta escrita de la raíz y rechaza si su ruta real es un montaje o cae dentro. El caso g falla ahora, confinado y sin confinar, y la víctima no recibe eventos. **[V]** |
| V2 | cerrado | El directorio final se comprueba contra los montajes antes de crear nada. El caso h falla y no se crea el directorio. **[V]** |
| V3 | cerrado | Hay un test para el componente que no es directorio y otro para la raíz que es exactamente un montaje; las dos mutaciones mueren ahora. **[V]** |

El resto de casos del script da el mismo resultado que en la primera pasada: los tres de estado legítimo (normal, raíz que es un enlace, raíz colgando de un enlace) siguen funcionando. **[V]**

### Mutaciones sobre `ad4330e`

Seis sobre las condiciones nuevas y las que sobrevivían, con los cinco ficheros de test (70 pasan, 1 se salta). Mueren las seis: bucle reducido a la raíz sola, sin bucle, sin comprobación del directorio final, sin rechazo de no-directorio, sin igualdad exacta y sin comprobación previa de symlinks. **[V]**

### Suite

En el worktree real: 1422 pasan, 2 se saltan, 0 fallan. `typecheck` limpio. **[V]**

### Contraste con las «Correcciones tras verificación» del implementador

Coincide en todo lo que comprobé: qué cambió, los cuatro tests, las cuatro mutaciones, la salida del script y los números de la suite. Dice con claridad que los dos tests de V3 no fallaban antes porque cubren un hueco, no un defecto.

### Lo que no revisé en esta pasada

- No se repitió la prueba con `claude` real tras `ad4330e`, ni por el implementador ni por mí. La del primer commit sí se hizo, por el implementador.
- No ejecuté `mergeAndCleanup` ni `removeWorktree`.
- No probé el pool de punta a punta con una raíz bajo un enlace; sí el backend, confinado y sin confinar.
- Sigue valiendo la nota de independencia del principio: quien verifica escribió los dos briefs.

<!-- FIN -->
