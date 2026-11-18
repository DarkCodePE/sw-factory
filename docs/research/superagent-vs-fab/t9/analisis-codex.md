# T9 — análisis de identidad de worktrees, ramas y estado vivo

## Veredicto

[I] **Sí toca corregir T9, con alcance acotado y compatibilidad hacia delante.** La frecuencia esperada es baja en instalaciones pequeñas, pero el efecto no se limita al bloqueo descrito en la cola: en el mismo repositorio dos changes con el mismo prefijo reutilizan silenciosamente el mismo worktree y la misma rama. La limpieza de uno puede destruir el trabajo sin commit y los transcripts del otro. Recomiendo id completo para nuevas asignaciones y conservar las asignaciones antiguas inequívocas. No recomiendo renombrar recursos existentes.

[V] Lo anterior se reprodujo con una copia exacta de `src/worktrees.ts` y repositorios Git desechables, fuera del checkout. Resultado: **dos tests rojos que demuestran reutilización y borrado ajenos; un control verde para otro repositorio**. Los scripts reproducibles están en §8. Evidencia causal: `src/worktrees.ts:25`, `src/worktrees.ts:53`, `src/worktrees.ts:56`, `src/worktrees.ts:78`, `src/worktrees.ts:191`, `src/worktrees.ts:193`, `src/worktrees.ts:201`.

## 0. Base y calidad de la evidencia

[V] Checkout inspeccionado: `/home/orlando/Desktop/factory/sw-factory-lectura`, HEAD `aa2142bf594cf285b3f82d9f307f1c190c704fc4`. `git status --porcelain=v1` estaba vacío antes de las pruebas y tras ellas; `git diff --exit-code` devolvió 0. Todas las referencias relativas `ruta:línea` de este informe corresponden a ese SHA. No se cambió de rama ni se ejecutó stash, commit, push o escritura en servicios externos.

[V] Se leyeron el brief completo y `/home/orlando/Desktop/factory/sw-factory-docs-t41/AGENTS.md`. Se consultó `task.json` mediante `git show origin/release/0.1.0-rc.12:docs/research/superagent-vs-fab/task.json`: T9 figura pendiente; su descripción del fallo cerrado está en `docs/research/superagent-vs-fab/task.json:130`. La versión remota local consultada no contiene T44; su exclusión se toma del brief, que sí la describe. No se hizo fetch.

[V] Se aplicó el método Verify de codebase-memory: `list_projects`, `index_status`, `search_graph`, `trace_path` en ambos sentidos, snippet y `check_index_coverage` para los archivos citados y los scopes `src/` y `tests/`. No existe un proyecto de grafo para este checkout de lectura. El más cercano es `home-orlando-Desktop-factory-sw-factory`, raíz del checkout principal. Su snippet todavía describía una versión de `ensureWorktree` sin las comprobaciones actuales; cobertura devuelve `coverage_unavailable`, generación vacía y `generation_matches:false`. **El grafo solo orientó: no acredita actualidad ni exhaustividad.** Se contrastaron los símbolos y llamadas relevantes leyendo directamente el checkout de lectura y buscando sus usos literales. No se reindexó ni escribió en él.

[V] La búsqueda inicial solicitada fue `git grep -n 'slice(0, 8)' -- src`. Se amplió a `worktrees`, `fab/`, `branchFor`, consumidores de creación/limpieza y `short()` en CLI. Esa segunda búsqueda encontró una ruta funcional no visible en el inventario inicial: `src/cli.ts:342`.

[I] Convención: **[V]** significa lectura o ejecución comprobada; **[I]** identifica inferencias, recomendaciones y contratos propuestos. Los contratos de §3–§5 son diseño, no comportamiento implementado.

## 1. Riesgo real y comportamiento actual

### 1.1 Generación y probabilidad

[V] `Store.createChange` genera el id con `randomUUID()` de `node:crypto` y lo guarda completo; no se elige el prefijo a partir del título, issue o workstream: `src/store.ts:6`, `src/store.ts:486`, `src/store.ts:488`, `src/store.ts:504`. El límite de tareas cuenta solo estados no terminales por workstream: `src/store.ts:490`. No limita las ramas o directorios retenidos entre varios workstreams.

[I] Bajo el modelo habitual de UUID v4 independientes y uniformes, los primeros ocho caracteres hexadecimales ofrecen **32 bits**, con M = 2^32 destinos. La colisión del UUID completo sigue siendo extraordinariamente improbable; el truncamiento es el que introduce este riesgo. No he auditado la implementación interna del generador de Bun.

[I] Para n ids en un mismo dominio de nombres, la aproximación de cumpleaños es `p ≈ 1 − exp(−n(n−1)/(2·2^32))`. La probabilidad de que el próximo id choque con k prefijos distintos ocupados es `k/2^32`. No se deben confundir las dos preguntas.

[V] Cálculo ejecutado con Python (`math.expm1`/`math.log1p`); los porcentajes son resultados de esa aproximación, no una observación de producción:

| n | Probabilidad de algún prefijo repetido |
|---:|---:|
| 20 | 0,000004424 % |
| 100 | 0,000115251 % |
| 1 000 | 0,011629214 % |
| 5 000 | 0,290557160 % |
| 10 000 | 1,157288106 % |
| 50 000 | 25,250860374 % |
| 77 164 | aproximadamente 50 % |
| 100 000 | 68,780946134 % |

[V] El mismo cálculo alcanza aproximadamente 0,1 % a los 2 933 ids y 1 % a los 9 292. Con 10 000 ids, 48 bits darían p≈1,7762·10^-7 y 64 bits p≈2,7102·10^-12. Son probabilidades, no porcentajes.

[I] El n relevante para daño en disco es el conjunto de identidades cuyos recursos pueden solaparse durante su vida útil. La tabla sobre todos los changes históricos es un techo conservador si se borran completamente sus recursos. La ruta y `live/` compiten en **todo el stateDir**, incluso entre repositorios; la rama compite en **el repositorio Git**, incluso desde stateDirs distintos. Esto se deduce de `src/worktrees.ts:25`, `src/worktrees.ts:74` y `src/pool.ts:299`. Las ramas retenidas sin directorio también importan (`src/worktrees.ts:83`).

[I] **No hay medición del volumen operativo local en este informe.** No se abrió la base real del dueño ni se inventó cuántos recursos retiene. Para decidir una espera basada en frecuencia, mediría en solo lectura: número de prefijos ocupados por stateDir, ramas `fab/*` por repositorio y tasa de nuevas asignaciones; umbral propuesto: corregir antes de 0,1 % de riesgo acumulado modelado o inmediatamente ante cualquier reutilización/borrado ajeno reproducible. El segundo umbral ya se ha superado en laboratorio. Esto justifica reparar el defecto sin presentarlo como incidente de producción ni como emergencia estadística.

### 1.2 Qué ocurre exactamente

| Escenario | Resultado y evidencia |
|---|---|
| [V] A y B distintos, mismo prefijo, mismo repo y stateDir | `branchFor(A) === branchFor(B)` y misma ruta. `verifyWorktree` valida `.git`, repo común, rama e índice, pero no el id completo. La segunda llamada devuelve el worktree de A: `src/worktrees.ts:25`, `src/worktrees.ts:46`, `src/worktrees.ts:74`, `src/worktrees.ts:78`. Reproducción: B leyó `A private work` sin commit. |
| [V] Mismo prefijo y stateDir, repos distintos | La comparación del directorio Git común falla y lanza `WorktreeNeedsRepair`: `src/worktrees.ts:53`, `src/worktrees.ts:65`. Reproducido. |
| [V] Marca corta `.preparing` presente | Se bloquea antes de verificar el repo o la rama: `src/worktrees.ts:76`, `src/worktrees.ts:77`. |
| [I] Mismo repo, stateDirs diferentes, rama corta ya en uso | Las rutas pueden ser distintas, pero `git worktree add` intenta adjuntar la misma rama; Git puede rechazarla por estar ya en otro worktree. Si la rama quedó libre, podría reutilizar commits de otro change. Derivado de `src/worktrees.ts:83` y `src/worktrees.ts:86`; no ejecuté este escenario. |
| [V] Limpiar B cuando solo existe A colisionado | `removeWorktree(B)` borra primero `live/<prefijo>`, después fuerza la eliminación del worktree y finalmente de la rama. No verifica propietario: `src/worktrees.ts:188`, `src/worktrees.ts:191`, `src/worktrees.ts:193`, `src/worktrees.ts:197`. En la prueba desaparecieron los tres recursos de A. No fue necesario crear B primero. |
| [I] Limpieza desde otro repo | El borrado de `live/` sucede antes del eventual rechazo de Git; fallar en Git no recupera los transcripts: `src/worktrees.ts:191`. No lo probé dinámicamente. |

[V] El bloqueo del caso de repos distintos ocurre antes de lanzar el agente, porque `ensureWorktree` se llama en `src/pool.ts:183`. El catch dirige `WorktreeNeedsRepair` a `store.blockActivity`: `src/pool.ts:444`. Ese método bloquea la activity y el change, cancela las pendientes del change y registra el motivo: `src/store.ts:881`, `src/store.ts:885`, `src/store.ts:890`, `src/store.ts:893`. No lo arregla un reintento automático.

[I] En el caso de mismo repo no aparece esa excepción: dos identidades pueden mezclar investigación, implementación, diff y sesiones. Es un defecto de aislamiento entre changes, además de disponibilidad. El brief y `task.json:130` deben corregirse cuando el dueño integre T9; este análisis no cambia la cola.

## 2. Alcance mínimo: identidad funcional frente a texto

| Uso | Qué comparte y qué debe hacerse |
|---|---|
| [V] `src/worktrees.ts:25`, `src/worktrees.ts:74`, `src/worktrees.ts:76` | Rama, checkout y marca de preparación. [I] Cambiar juntos: ampliar solo la ruta deja la rama colisionada; ampliar solo la rama deja la ruta y la marca colisionadas. |
| [V] `src/worktrees.ts:103`, `src/worktrees.ts:108` | Reparación reconstruye ruta, marca y rama. [I] Debe usar la misma asignación persistida que creación y limpieza. |
| [V] `src/pool.ts:299`, `src/pool.ts:300` | Persistencia de proyectos Claude y config MCP bajo `live/<prefijo>`. [I] Deben compartir la clave de la asignación del worktree; conservar la clave antigua en changes antiguos. |
| [V] `src/worktrees.ts:165`, `src/worktrees.ts:167`, `src/worktrees.ts:188` | Merge y limpieza reconstruyen destinos. [I] Resolver antes de hacer merge o borrar; nunca borrar los dos candidatos corto/largo «por si acaso». |
| [V] `src/validators/publish.ts:99`, `src/validators/publish.ts:120` | El merge usado por CLI ya prefiere `c.branch`, pero la limpieza recibe solo el id y vuelve al prefijo. [I] Pasar la misma asignación validada a ambas operaciones. |
| [V] `src/manifest.ts:75`, `src/manifest.ts:86` | Rama del manifiesto y estado de conservación del worktree. [I] No dejar el diagnóstico atado a la ruta vieja. |
| [V] `src/improve.ts:227` | El brazo del experimento abre el checkout para restaurar rutas protegidas y verificar (`src/improve.ts:233`, `src/improve.ts:240`). [I] Es funcional, no texto: debe consultar la asignación del change. |
| [V] `src/cli.ts:119`, `src/cli.ts:342` | `gate allow` usa `short(c.id)` como ruta y luego restaura/aprueba rutas protegidas. [I] Sustituir esa construcción; mantener el helper para impresiones. |

[V] Usos meramente legibles del id corto en el inventario: mensajes de `src/connectors/cli.ts:105`, `src/connectors/intake.ts:59`, `src/connectors/intake.ts:64`, salida de `src/tui.ts:95`, `src/tui.ts:119`, mensajes de `src/validators/cli.ts:77`, `src/validators/cli.ts:91`, `src/validators/cli.ts:114`, título Markdown de `src/validators/publish.ts:7` y mensaje de commit de `src/pool.ts:421`.

[I] Esos textos pueden seguir mostrando ocho caracteres; la CLI acepta un prefijo solo si identifica exactamente un registro (`src/cli.ts:121`). La eventual ambigüedad visual no justifica cambiar ahora todos los formatos.

[V] Otros truncamientos no identifican este change: hash de repositorio en `src/agent/exec-worktree.ts:86`, token de presentación del terminal en `src/chat/terminal.ts:95` y sufijo aleatorio del lote de improve en `src/improve.ts:269`. `runs/` ya usa el id completo validado (`src/manifest.ts:32`, `src/manifest.ts:36`).

[I] Ninguno de esos tres algoritmos ni el layout de `runs/` entra en T9. El primero merece su propio análisis si se sospecha una colisión: su dominio y su propietario son otros.

## 3. Diseño recomendado e invariantes

### 3.1 Una asignación estable, sin columna nueva

[V] Ya existe `Change.branch: string | null` (`src/store.ts:95`, `src/store.ts:101`). Ahora nace NULL (`src/store.ts:504`) y se escribe **después** de crear el worktree (`src/pool.ts:183`, `src/pool.ts:184`); `setChangeBranch` sobrescribe sin comprobar la asignación anterior (`src/store.ts:530`). Esa ventana importa para recuperar una actualización interrumpida.

[I] Usar la rama existente como discriminante durable del layout:

| Asignación | branch | key | checkout / marca / live |
|---|---|---|---|
| [I] Antigua | `fab/<id.slice(0,8)>` | los ocho caracteres | rutas actuales, sin moverlas |
| [I] Nueva | `fab/<id completo>` | id completo, con guiones | `worktrees/<key>`, `worktrees/.<key>.preparing`, `live/<key>/` |

[I] Persistir la rama completa **en la inserción de los changes creados por la versión nueva**. Para filas anteriores con branch NULL, resolver y reservar la asignación antes de crear directorios o llamar a Git. Una vez asignada, no cambiarla en reintentos, reparación, merge o rechazo. `baseSha` conserva su contrato independiente (`src/store.ts:536`). No añadir tablas, columnas, flags o dependencias.

[I] No basta `existsSync(legacyPath) ? legacy : full`. Un change nuevo puede encontrar el legacy de otro con el mismo prefijo. Tampoco basta confiar en `verifyWorktree`: Git prueba repo/rama, no propiedad por UUID.

### 3.2 Inspección y adopción de filas antiguas

[I] El resolvedor considera todos los changes del Store/stateDir, sin limitarse al workstream ni excluir a ciegas los terminales: un terminal puede retener recursos. Para un prefijo antiguo, cuenta como posible reclamante cada fila cuya rama es la corta o cuya rama sigue NULL y cuyo id tiene ese prefijo; las filas ya asignadas a rama completa no reclaman el legacy.

[I] Reglas exactas:

1. Rama persistida completa: usar exclusivamente su layout completo. No adoptar ni limpiar legacy por coincidencia de prefijo.
2. Rama persistida corta: mantenerla; si hay varios reclamantes posibles y quedan recursos legacy, declarar ambigüedad. No escoger al más nuevo ni al no terminal sin evidencia adicional.
3. Rama NULL sin recursos cortos ni largos: reservar layout completo. Si existe evidencia durable de una sesión lanzada o merge previo incompatible con esa elección, fallar para inspección; no reiniciar una sesión tácitamente.
4. Rama NULL con recursos cortos: adoptar corto solo si es el único reclamante posible y los datos Git disponibles no contradicen repo/rama/ruta esperados. Considerar directorio, registro de `git worktree list --porcelain`, rama sin checkout, `.preparing` y `live/`; no solo el directorio.
5. Rama NULL con recursos largos atribuibles al UUID: comprobarlos y reservar largo. Si también hay recursos cortos potencialmente suyos, declarar ambigüedad.
6. Recursos legacy sin atribución inequívoca, dos reclamantes, rama inesperada o evidencia contradictoria: `WorktreeNeedsRepair`, con ids completos y rutas candidatas. No renombrar, borrar ni lanzar agente. Un directorio corriente o un symlink no demuestra propiedad.

[I] La adopción presupone que el Store es el inventario autorizado de ese stateDir. Artefactos de otra base o creados a mano no adquieren propiedad por tener un nombre corto. Si los metadatos no permiten probarla, quedan para inspección del dueño. La información perdida al truncar no se puede reconstruir con certeza mediante un fallback.

[I] Antes de merge, repair/discard y limpieza: confirmar asignación, ausencia de ambigüedad y que cualquier registro Git pertenece al repo y ruta seleccionados. Mantener rechazo de symlinks y rutas fuera del directorio esperado. Si el checkout ya fue retirado, permitir limpieza idempotente de los recursos restantes **solo con asignación durable y propiedad inequívoca**; una rama adjunta a otra ruta no se borra ni se fusiona automáticamente. No introducir `--force` adicional.

[I] En toda lectura, el resolvedor no crea directorios, esquema, marcas ni reservas. El manifiesto debe representar una inspección ambigua como `cleanup.worktree: 'unknown'` con un diagnóstico opcional `workspaceError`; mantener `retained/absent` en casos resueltos. Es una ampliación deliberada del formato de evidencia que debe documentarse y comprobarse con sus consumidores al implementar. No capturar cualquier error y escribir `absent`, ni dejar que el manifiesto del `finally` oculte el fallo original del pool.

### 3.3 Actualización, caída y reanudación

[I] Actualizar con **todos los escritores de la versión anterior detenidos**, incluidos pool, comandos de merge/reject/repair y residentes que creen changes. No ejecutar a la vez binarios con algoritmos de nombres distintos sobre el mismo estado. Hacer copia de seguridad del estado y conservar los repos/worktrees antes de intervenir; esta tarea de análisis no ejecuta ese procedimiento.

| Punto de corte | Comportamiento requerido tras actualizar |
|---|---|
| [I] Change antiguo con rama, commits y archivos sucios | Mismos branch, path, base y liveRoot; conservar bytes y commits. |
| [I] Change antiguo esperando respuesta | Mantener también `cwd`, sessionId, generación y transcripts. `SessionStore.begin` compara cwd y otros metadatos (`src/admission/sessions.ts:52`); no provocar pérdida de sesión por un cambio de nombre. |
| [I] Caída antigua después de checkout y antes de guardar branch | Aplicar adopción legacy inequívoca; si no se puede atribuir, bloqueo explícito. |
| [I] `.preparing` antigua o nueva | Seleccionar su layout y conservar la marca; seguir el flujo T10 de reparación explícita. No saltarse la marca creando otro checkout. |
| [I] Rama retenida pero directorio perdido | Volver a adjuntar esa rama en su ruta asignada, conservando commits y merge-base; comprobar registros Git que aún apunten al checkout perdido. |
| [I] Cambio recién creado con rama completa pero sin worktree | Reintentar en la misma ruta completa. La reserva anterior a Git cierra la ventana de pérdida de elección. |
| [I] Caída tras merge o durante limpieza | Reanudar desde `merge_started` y la misma asignación; no reconstruir una rama corta. El flujo actual guarda head/branch/target (`src/validators/publish.ts:100`, `src/validators/publish.ts:108`). |
| [I] Rollback del binario | La versión antigua no entiende las nuevas asignaciones al crear/limpiar. No prometer downgrade en caliente: detener escritores y usar una versión que conozca ambos layouts, o restaurar coordinadamente un backup previo sin descartar trabajo nuevo. |

[I] No hace falta migrar sesiones ni mover transcripts. Precisamente conservar la asignación evita activar la pérdida de sesión que hoy consume generaciones (`src/live/turn.ts:86`, `src/admission/sessions.ts:81`). Un par legacy que ya compartía worktree no se «desmezcla» automáticamente: separar ese trabajo requiere inspección humana.

## 4. Definiciones y orden de implementación propuesto

[I] Firmas propuestas, internas al sistema; revalidar todos sus callers contra la rama de implementación antes de editar. Mantener en `src/worktrees.ts` la propiedad de las rutas:

```ts
type ChangeWorkspace = {
  changeId: string;
  key: string;
  branch: string;
  path: string;
  preparing: string;
  liveRoot: string;
};
type WorkspaceInspection =
  | { kind: 'resolved'; workspace: ChangeWorkspace }
  | { kind: 'unassigned' }
  | { kind: 'ambiguous'; reason: string; candidates: string[] };

branchFor(changeId: string): string; // nueva rama: fab/<id completo>
workspaceFor(stateDir: string, changeId: string, branch: string): ChangeWorkspace;
inspectChangeWorkspace(store: Store, stateDir: string, changeId: string): WorkspaceInspection;
reserveChangeWorkspace(store: Store, stateDir: string, changeId: string): ChangeWorkspace;

// Store: asignación inicial atómica, idempotente; conflicto si ya tiene otra.
claimChangeBranch(changeId: string, branch: string): string;

ensureWorktree(repo: string, workspace: ChangeWorkspace): Promise<{
  path: string; branch: string; baseSha: string;
}>;
repairWorktree(repo: string, workspace: ChangeWorkspace, discard?: boolean):
  Promise<{ ok: boolean; message: string }>;
removeWorktree(repo: string, workspace: ChangeWorkspace): Promise<void>;
mergeAndCleanup(repo: string, workspace: ChangeWorkspace): Promise<string>;
```

[I] `workspaceFor` es puro: valida un id no vacío con `[A-Za-z0-9_-]+` y una rama exactamente igual a la corta o la completa del mismo id; calcula todas las rutas desde una única key. Así acepta fixtures actuales sin imponer UUID a todos los tests, pero rechaza separadores, puntos y ramas arbitrarias antes de usarlos como rutas. Una rama con nombre inesperado se inspecciona, no se borra. `branchFor` deja de servir para adivinar una asignación antigua.

[I] `inspectChangeWorkspace` hace consultas/lecturas sin mutaciones. `reserveChangeWorkspace` usa ese resultado y `Store.claimChangeBranch`; la transacción inmediata revalida la fila y los reclamantes del legacy antes de reservar. La reserva es inmutable e idempotente: dos llamadas para el mismo change no eligen claves distintas; un valor ya distinto es conflicto. No sostener una transacción SQLite durante un `git worktree add` ni el turno del agente. No introducir importación runtime de Store en worktrees: basta el tipo, evitando aumentar el ciclo Store → manifest → worktrees.

[I] `createChange` inserta la rama completa junto al id; `setChangeBranch` deja de sobrescribir una elección incompatible (puede delegar a `claimChangeBranch` manteniendo su firma pública actual). Pool reserva primero, pasa el descriptor a ensure y usa su `liveRoot`; no recalcula prefijos. Los consumidores read-only usan inspección, sin llamar a reserva. La inspección debe distinguir un layout elegido de un checkout válido: la validación Git y `.preparing` siguen siendo obligatorias antes de reutilizar o reparar.

[I] Orden de commits propuesto; los tests rojos se ejecutan primero en cada subtarea, pero cada commit entregable queda verde:

1. **`fix(t9): asignar identidad completa a recursos nuevos y conservar legacy`**. Tests de colisión y compatibilidad; descriptor, inspección, reserva y CAS en Store; inserción con branch completo; creación, repair, ambas limpiezas; todos los callers funcionales en pool, CLI, improve, manifest y publish. Esta unidad debe ser coherente: no entregar un commit que cree rutas largas mientras merge/reject sigue limpiando cortas. Incluir los tests existentes que fijan rutas cortas como fixtures explícitamente legacy, y nuevos casos completos.
2. **`test(t9): cubrir actualización interrumpida y aislamiento de limpieza`**. Pruebas de caída en fronteras deterministas, ramas huérfanas, registros Git, varias reclamaciones y dos turnos de sesión. Cualquier arreglo que revelen va en este commit con su prueba. Añadir la prueba corta con Claude real confinado prescrita por el repo; no gastar turnos en la fase de análisis.
3. **`docs(t9): documentar convivencia y procedimiento de actualización`**. Documentar formatos, estado ambiguo del manifiesto, parada de escritores y límite del rollback. Informe de implementación y evidencia; el dueño integra después `task.json` y sus decisiones en su PR de cierre, sin que este análisis cambie el estado de T9.

[I] Comprobación propuesta: tests focales de worktrees/repair, pool-live, manifest/merge, gate allow e improve; `bun run typecheck` antes de cada commit; una suite completa `bun test tests` antes de entregar implementación, conforme a AGENTS. La demostración roja de este análisis no sustituye esas comprobaciones.

## 5. Tests que deben fallar antes

[V] **Ejecutados ahora:** el apéndice usa ids UUID v4 sintácticamente válidos `deadbeef-0000-4000-8000-000000000001` y `deadbeef-1111-4111-8111-111111111112`. `bun test` devolvió exit 1, **2 fail / 1 pass**. El primer rojo afirma que las rutas deben diferir y falla en esa aserción; no llegó a su aserción posterior sobre ramas. El segundo rojo compara conjuntamente conservación de worktree, live y rama: los tres resultaron false. El control de otro repo pasó.

[I] Casos obligatorios para la implementación:

| Caso | Aserción sustantiva y situación antes del cambio |
|---|---|
| Dos ids con mismo prefijo en mismo repo/state | Paths, ramas, marcas y liveRoot distintos; archivos y commits de A no aparecen en B. [V] Path hoy rojo; [I] ampliar a commits y live. |
| B no preparado nunca, A sí preparado | Rechazar/limpiar B no borra A ni sus transcripts. [V] Rojo ejecutado. |
| A legacy + B nuevo de mismo prefijo | A mantiene su checkout sucio, rama, live y sesión; B usa todo completo. [I] Hoy B reutiliza A. |
| Dos repos en state compartido y dos stateDirs con repo compartido | Ambos changes nuevos avanzan sin compartir rama/ruta/live. [I] Hoy chocan en ruta o rama. |
| Selección nueva y legacy en repair/merge/reject | La operación alcanza solo el descriptor seleccionado; ante ambigüedad, no cambia ningún byte o ref. [I] Hoy se reconstruye siempre corto y no hay control de propietario por UUID. |
| `gate allow`, improve, manifest | Usan checkout completo cuando está asignado; legacy se conserva; el manifiesto no atribuye a B el path corto de A. [I] Hoy `src/cli.ts:342`, `src/improve.ts:227`, `src/manifest.ts:86` siguen el prefijo. |
| Actualización a medias | Fixtures anteriores con branch NULL, checkout válido sucio, rama sin path, `.preparing` sola, live solo y registros Git sin directorio. Una única atribución conserva el layout; atribución dudosa bloquea sin borrar. [I] Los tests actuales no expresan esta elección entre dos layouts. |
| Reserva y caída | Caída después de persistir branch, después de escribir marca y después de checkout; el siguiente intento elige la misma clave. Dos reservas para el mismo change son idempotentes; una distinta no sobrescribe. [I] Hoy branch se guarda después del checkout. |
| Sesión legacy en `waiting_reply` | Mismo cwd, sessionId, generación y transcript tras actualizar; el segundo turno reanuda. Nuevo change completo también reanuda. [I] Un reemplazo global de rutas fallaría por mismatch o sesión ausente. |
| Merge recuperado tras quitar checkout/rama | No repite merge ni borra el legacy de otro; usa `merge_started` original. [I] Extender el patrón existente de `tests/manifest.test.ts:99`. |
| Id/rama inválidos y symlinks | Fallo antes de escribir o borrar; conservar directorio víctima y ref ajena. [I] Mantener los invariantes de confinamiento y limpieza, sin ampliar T44. |

[V] Ya existen pruebas de legacy sucio (`tests/worktrees.test.ts:269`), repo ajeno (`tests/worktrees.test.ts:239`), marca/checkout incompleto (`tests/worktrees.test.ts:281`), conservación de ramas durante repair (`tests/worktrees-repair.test.ts:63`), y rutas de live (`tests/pool-live.test.ts:42`, `tests/pool-live.test.ts:48`). No basta cambiar sus expectativas cortas a largas: se perdería la prueba de compatibilidad antigua.

[I] Los casos de compatibilidad que ya pasan en el código anterior son regresiones, no evidencia roja de la nueva conducta. Evitar tests que solo comprueben el helper calculando el mismo string; afirmar contenido conservado, refs, parámetros entregados al backend, código de salida CLI y ausencia de cambios en recursos ajenos.

## 6. No tocar y coordinación con T44

[I] No modificar política de admisión, permisos, scope, generación de UUID, estados del workflow, límites, presupuestos/reintentos de sesión, prompt del canal, token MCP, layout de `runs/`, hash de exec-worktree, formatos visuales de ids ni API del residente. No mover trabajo sucio ni arreglar automáticamente colisiones legacy que ya mezclaron cambios.

[V] El `hostDir` vigente está en `src/sandbox/confine.ts:33`; las rutas del pool están en `src/pool.ts:299` y `src/pool.ts:300`. `hostDir` comprueba realpath y montajes escribibles; esta lectura no verifica que esas comprobaciones estén libres de otros defectos.

[I] **T44 conserva la propiedad de `src/sandbox/confine.ts`, incluido `hostDir`, y de su lógica de creación/validación de directorios. T9 no debe editar ese archivo.** La frontera entre tareas debe ser un valor: T9 decide `workspace.liveRoot`; T44 decide cómo se valida y materializa el directorio recibido.

[I] Evitar el choque concreto así: implementar T9 después de integrar la parte de T44 que toque las dos líneas del pool, o acordar una entrega secuencial de ese único hunk. En T9 reemplazar únicamente la base corta por el `liveRoot` resuelto, conservando las llamadas/validaciones que haya dejado T44 y los sufijos `claude-projects` y `mcp`. No resolver el conflicto restaurando las líneas de aa2142b. Los tests de T44 deben correr contra el resultado integrado.

[I] No es correcto declarar las dos líneas intocables para siempre y dejar el prefijo en ellas: eso dejaría T9 incompleto. Si T44 aún escribe ese hunk, se puede avanzar con el análisis y los tests en otro worktree; el commit funcional de T9 espera esa integración. No se requiere incorporar la implementación de hostDir dentro de T9.

## 7. Decisiones para el dueño

### [DECIDIR] A — Prioridad de T9

| Opción | Qué se hace | A favor | En contra / riesgo |
|---|---|---|---|
| [I] A1 — Corregir ahora, después del hunk compartido con T44 (**recomendada**) | Implementar el alcance funcional de §2–§5, sin migración masiva. | Cierra el caso demostrado de mezcla y pérdida; conserva lo existente. | Requiere comprobar compatibilidad y sesión real; un parche parcial dañaría limpieza/reanudación. |
| [I] A2 — Posponer con umbral medido | Inventariar recursos y tasa, registrar el modelo; retomar al 0,1 % modelado o primer incidente. | Evita trabajo inmediato si el volumen es diminuto. | El fallo destructivo sigue presente; el inventario no detecta toda mezcla pasada y no garantiza que la próxima colisión tarde. |
| [I] A3 — Solo detectar y bloquear | Añadir atribución por id completo y guardas a creación, merge y limpieza, conservando claves cortas nuevas. | Menor cambio de nombres y evita uso/borrado ajeno si la atribución es completa. | Conserva la posibilidad de bloqueo; necesita casi toda la maquinaria de propiedad y otra migración futura. |

[I] Recomiendo A1 por la severidad observada, sin afirmar que haya ocurrido en la instalación real. A2 solo sería defendible aceptando explícitamente ese riesgo residual.

### [DECIDIR] B — Longitud para nuevas asignaciones

| Opción | Qué se hace | A favor | En contra / riesgo |
|---|---|---|---|
| [I] B1 — Id completo con sus guiones (**recomendada**) | `fab/<uuid>` y key igual al uuid. | Correspondencia directa, sin política de expansión; no introduce colisiones adicionales a las del id. | Nombres más largos; revisar scripts externos que supongan ocho caracteres. |
| [I] B2 — Doce caracteres hexadecimales reales | Quitar guiones y tomar 12 hex; misma key en todos los destinos. | Menor longitud; 48 bits en UUID v4. | Todavía colisiona; exige reglas de bloqueo y añade otra representación. **No** usar `slice(0,12)` sobre UUID con guiones creyendo que son 48 bits. |
| [I] B3 — Dieciséis caracteres hexadecimales reales | Quitar guiones y tomar 16 hex de UUID v4. | Mucho más espacio que ocho caracteres y rutas algo menores que completas. | El campo de versión fijo consume entropía: esos 16 hex son 60 bits aleatorios en UUID v4, no 64; persisten colisiones y otra representación. |

[I] B1 tiene el menor coste conceptual y conserva la identidad ya generada. Los valores de 48/64 bits de §1 son comparaciones ideales; no atribuir 64 bits a un truncamiento que incluya bits fijos o guiones.

### [DECIDIR] C — Compatibilidad y autoridad de la asignación

| Opción | Qué se hace | A favor | En contra / riesgo |
|---|---|---|---|
| [I] C1 — Rama durable existente + adopción controlada (**recomendada**) | Aplicar §3: nuevo branch completo al insertar; conservar corto antiguo, reservar filas NULL y bloquear ambigüedades. | Sin esquema nuevo; no mueve cwd, commits ni transcripts; cierra la ventana de reserva nueva. | Necesita inspección cuidadosa de NULL y reclamantes legacy; la rama se convierte en autoridad del layout. |
| [I] C2 — Persistir una clave propia en una columna | `workspace_key` inmutable, backfill con revisión de ownership. | Separa explícitamente rama y almacenamiento; permite ramas distintas en el futuro. | Migración y fuente adicional que puede divergir; contradice la restricción actual de no añadir columnas salvo autorización expresa. No implementable con el brief actual sin modificar ese alcance. |
| [I] C3 — Archivo de asignación por id completo | Sidecar fuera de montajes escribibles con clave/owner, creado de forma exclusiva. | No migra la DB y hace explícito el propietario. | Nueva fuente durable, orden de escritura y recuperación DB/archivo; permisos, symlinks y limpieza adicionales. Más complejidad que aprovechar `branch`. |

[I] Recomiendo C1 para el sistema actual, donde los nombres de rama que crea la factory ya derivan del id. Ninguna opción puede atribuir automáticamente con certeza datos legacy que ya quedaron mezclados; esos casos se bloquean para el dueño.

## 8. Prueba ejecutada y reproducción

[V] Bun usado: `1.3.14`. Se copió únicamente `src/worktrees.ts` a `/tmp/fab-t9-codex-hvfo710_/worktrees.ts`. El probe creó Git repos nuevos, no worktrees del repositorio de lectura. Comandos ejecutados:

```sh
bun /tmp/fab-t9-codex-hvfo710_/probe.ts
bun test /tmp/fab-t9-codex-hvfo710_/collision.test.ts
```

[V] Salida resumida del probe (exit 0):

```json
{"sameRepo":{"samePath":true,"sameBranch":true,"contentBReads":"A private work"}}
{"cleanupB":{"aWorktreeExists":false,"aTranscriptExists":false,"aBranchExists":false}}
```

[V] Entre ambas líneas, el repo distinto devolvió `WORKTREE_NEEDS_REPAIR: ... worktree belongs to another repository; inspect it manually`. La prueba de bun test devolvió exit 1, `1 pass / 2 fail`. Ese resultado rojo es el esperado para demostrar el defecto, no una implementación fallida de T9.

[V] Código íntegro del test ejecutado, para reproducir sin depender de que sobreviva `/tmp`: copiar `src/worktrees.ts` al mismo directorio temporal que este archivo y ejecutar `bun test <ruta>/collision.test.ts`:

```ts
import {test, expect, afterEach} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {ensureWorktree,removeWorktree} from './worktrees.ts';
const dirs:string[]=[];
const a='deadbeef-0000-4000-8000-000000000001', b='deadbeef-1111-4111-8111-111111111112';
function git(cwd:string,...args:string[]){const p=Bun.spawnSync(['git','-c','core.hooksPath=/dev/null',...args],{cwd});if(p.exitCode)throw Error(p.stderr.toString());return p.stdout.toString().trim();}
function setup(){const root=mkdtempSync('/tmp/fab-t9-proof-');dirs.push(root);const repo=join(root,'repo'),state=join(root,'state');mkdirSync(repo);git(repo,'init','-q','-b','main');writeFileSync(join(repo,'base'),'x');git(repo,'add','.');git(repo,'-c','user.name=test','-c','user.email=t@localhost','commit','-qm','base');return {root,repo,state};}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
test('dos changes del mismo repo no comparten worktree',async()=>{const {repo,state}=setup();const first=await ensureWorktree(repo,state,a),second=await ensureWorktree(repo,state,b);expect(second.path).not.toBe(first.path);expect(second.branch).not.toBe(first.branch);});
test('limpiar B conserva worktree, live y rama de A',async()=>{const {repo,state}=setup();const first=await ensureWorktree(repo,state,a);mkdirSync(join(state,'live','deadbeef'),{recursive:true});writeFileSync(join(state,'live','deadbeef','sentinel'),'A');await removeWorktree(repo,state,b);expect({worktree:existsSync(first.path),live:existsSync(join(state,'live','deadbeef','sentinel')),branch:!!git(repo,'branch','--list',first.branch)}).toEqual({worktree:true,live:true,branch:true});});
test('otro repo falla cerrado y conserva A',async()=>{const {root,repo,state}=setup();const first=await ensureWorktree(repo,state,a);const other=join(root,'other');git(root,'clone','-q',repo,other);await expect(ensureWorktree(other,state,b)).rejects.toThrow('another repository');expect(existsSync(first.path)).toBe(true);});
```

## Lo que no revisé

[V] No se implementó T9, no se ejecutó typecheck ni la suite completa, no se hicieron mutaciones del código productivo y no se lanzaron agentes reales. La única prueba dinámica importó la copia temporal exacta de worktrees.ts; no pasó por el pool, la CLI, el Store o el sandbox. Las consecuencias del bloqueo en esos módulos se comprobaron leyendo sus líneas.

[V] No se leyó el informe de otro analista, no se usaron subagentes, no se consultó Internet y no se inspeccionaron credenciales ni la base operativa del dueño. Tampoco se examinó la implementación de T44 ni sus resultados; su frontera procede del brief. El grafo no ofrece cobertura ni generación verificables para este checkout, por lo que no se afirma exhaustividad estructural global.

[I] Queda para implementación/verificación: medir volumen real si el dueño desea priorizar por frecuencia; comprobar scripts externos que esperen ids cortos; ejecutar las fronteras de caída/merge entre dos layouts y la reanudación con Claude real confinado; verificar la ampliación del formato del manifiesto y la integración con el hunk de T44. La propuesta de adopción de legacy requiere esas pruebas antes de aceptarse como segura.

<!-- FIN -->
