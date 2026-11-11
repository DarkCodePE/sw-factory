# Fase 0 — endurecimiento del pool

Fecha: 2026-11-10. Worktree de implementación: `/home/orlando/Desktop/factory/sw-factory-fase0`, rama `feat/fase0-endurecer`, HEAD/base `ce84fc412bee732a8106711a135c1f762c562c97`.

Los cinco defectos existen en la base. Quedan cambios y tests sin commit, push ni merge. No se modificaron los worktrees `sw-factory-live-*`; se leyó `sw-factory-live-claude/src/live/claude.ts` para verificar el wrapper. En el repo principal solo se escribió este informe. Sin columnas, migraciones o dependencias nuevas.

## Verificación previa y recorrido

Se leyeron el brief, la síntesis R2, los informes de origen y `copilot-superagent/vscode/src/worktree.ts:94-228`. Se consultaron `graft ask --source`, `graft skeleton`, `graft callers` y, ante las ambigüedades entre el código real y las fixtures de bench, `graft grep` y el grafo MCP del worktree exacto. Se recorrieron los llamadores antes de editar: `runPool → requeueOrphans`; `processActivity → failActivity`, `ensureWorktree`, `runAgent`; `connectorsMain → importIssue`; y los tests/benches correspondientes. Se verificó cobertura de los archivos implicados y se leyeron los tramos relevantes con `sed -n`. Las lagunas iniciales del índice rápido en tests se resolvieron mediante lectura directa; la cobertura final no registra lagunas en los archivos modificados. Esto no equivale a una garantía de completitud del grafo.

La suite base inicial se ejecutó sobre el árbol sin cambios y se guardó antes de la primera edición:

```text
$ bun test tests
1 tests failed:
(fail) corrupt final record ignored and repaired; corruption before final record fails closed; 10000 records [30000.37ms]
  ^ this test timed out after 30000ms.

 1060 pass
 1 fail
 6633 expect() calls
Ran 1061 tests across 101 files. [313.51s]
```

Tras la petición de repetir la base sin perder los cambios, se creó un worktree temporal detached en `ce84fc4`. Una primera ubicación bajo `/tmp/sw-factory-fase0-base-ce84fc4` produjo 999 pass / 62 fail por incompatibilidad de las pruebas de sandbox con la ubicación del propio código bajo `/tmp`; esa corrida se conserva como diagnóstico y no se usa para comparar regresiones. Tras mover el mismo checkout a `/home/orlando/Desktop/factory/sw-factory-fase0-base-ce84fc4`, la prueba representativa `protocol > returns the program value and forwards tool calls to the host` pasó (1 pass / 0 fail), y se repitió la suite completa:

```text
$ cd /home/orlando/Desktop/factory/sw-factory-fase0-base-ce84fc4
$ bun test tests
1 tests failed:
(fail) corrupt final record ignored and repaired; corruption before final record fails closed; 10000 records [30000.28ms]
  ^ this test timed out after 30000ms.

 1060 pass
 1 fail
 6633 expect() calls
Ran 1061 tests across 101 files. [339.33s]
```

## 1. Huérfanos sin tope

**Existía:** `src/store.ts:1096@ce84fc4` volvía a `pending` sin modificar `retry_count`; `failActivity`, en `src/store.ts:909@ce84fc4`, sí incrementaba y comparaba con `MAX_ACTIVITY_RETRIES` (`src/enums.ts:78`, valor 3).

**Cambio:** se comparte la política en `recordActivityFailure` (`src/store.ts:918`). Tanto `failActivity` como `requeueOrphans` la llaman dentro de su transacción IMMEDIATE. Cada lease vencido incrementa el contador; el tercer fallo deja la activity en `failed`, fija `completed_at` y termina el change como hacía `failActivity`. Los validadores conservan su política original: agotan su activity, pero el change continúa `implemented`. El evento incluye `lease expired (orphaned activity)` y tiene severidad `error` al agotar intentos. Se vuelve a leer el estado del change dentro del bucle para respetar una transición terminal realizada durante esa misma recuperación. El retorno sigue contando solo las activities efectivamente reencoladas.

**Tests:** huérfanos repetidos hasta el tope, mezcla de fallo de worker y lease vencido con un único presupuesto, y conservación del estado del change al fallar un validador. Salida de la corrida focalizada:

```text
(pass) expired leases consume the retry budget and permanently fail the activity and change [3.78ms]
(pass) worker failures and expired leases share one retry budget [2.24ms]
(pass) orphaned validators exhaust retries without failing the implemented change [6.06ms]
```

**No se hizo:** no se cambió `MAX_ACTIVITY_RETRIES`, la política especial de validadores ni el comportamiento existente que mata el grupo del agente antes de recuperar su lease. No se añadió otra política de reintentos.

## 2. Token por claim

**Existía:** `src/pool.ts:414@ce84fc4` generaba `w<slot>-<pid>`; al reutilizar un slot del mismo proceso se repetía la identidad usada por las escrituras protegidas del Store.

**Cambio:** `src/pool.ts:414` añade `randomUUID()` a cada intento de claim, usando `node:crypto`. No se almacenan campos nuevos ni se cambia el contrato público de `claimActivity`.

**Test:** un pool con un solo slot reclama reiteradamente la misma activity tras un fallo previo al lanzamiento. Verifica tokens distintos y rechaza tanto `heartbeat` como `completeActivity` de todos los tokens anteriores mientras está vigente el nuevo claim.

```text
(pass) successive claims in one pool slot have distinct tokens and fence late writes [154.37ms]
```

**No se hizo:** no se añadieron columnas ni se reinterpretó el PID como autoridad; se conservan los controles existentes del Store basados en la identidad completa del claim.

## 3. Worktree reutilizado sin verificar

**Existía:** `src/worktrees.ts:42@ce84fc4` devolvía cualquier ruta existente antes de comprobar su identidad.

**Cambio:** `verifyWorktree` (`src/worktrees.ts:39`) exige un linked worktree en su raíz, compara los `--git-common-dir` canónicos del destino y el repositorio, exige `branchFor(changeId)`, comprueba HEAD y rechaza índice ausente, `index.lock` o worktree bloqueado. La creación nueva escribe primero `.<short-id>.preparing` con creación exclusiva; solo retira esa marca después de que Git haya terminado, se haya validado el worktree y se haya calculado la base. Una marca persistente impide reutilizar o recrear automáticamente tras una preparación fallida. Se mantienen worktrees anteriores válidos, incluidos sus archivos sin commit, sin exigirles un marcador nuevo. El comentario de origen cita `copilot-superagent/vscode/src/worktree.ts` (MIT).

Los errores de validación indican la causa y piden inspección manual. No se borran directorios, ramas ni archivos ajenos al rechazar una ruta; una marca de preparación fallida permanece para revisión.

**Tests:** otro repositorio, rama cambiada y HEAD separado, directorio común y repositorio independiente, reutilización válida anterior con archivos sucios, checkout incompleto y marca de preparación interrumpida. También sigue pasando el test existente de reutilización/baseSha tras commits del agente.

```text
(pass) ensureWorktree rejects a worktree from another repository without deleting it [162.53ms]
(pass) ensureWorktree rejects a changed or detached branch without deleting files [167.36ms]
(pass) ensureWorktree rejects a plain directory and an independent repository [112.76ms]
(pass) ensureWorktree reuses a valid legacy worktree with its dirty files intact [156.08ms]
(pass) ensureWorktree rejects incomplete checkout and a persisted preparation marker [155.76ms]
```

**No se hizo:** no se cambió el truncado a ocho caracteres. Persiste el riesgo de colisión entre ids con el mismo prefijo: ruta y rama siguen compartiendo ese prefijo. No se incorporaron el resto de políticas de copilot ni un borrado/reparación automático. Una marca persistente o un worktree bloqueado requiere inspección manual.

## 4. importIssue con withRetry

**Existía:** `src/connectors/intake.ts:40@ce84fc4` ejecutaba directamente una transacción diferida sin `store.withRetry`.

**Cambio:** `src/connectors/intake.ts:40` envuelve la transacción completa en `store.withRetry` y la ejecuta con `.immediate()`, siguiendo el patrón del Store. La llamada remota a Jira queda fuera del bloque reintentable; signal, mapeo y triage permanecen atómicos.

**Tests:** se reutilizó el patrón de contención real de `tests/store.test.ts` (F1): otro proceso mantiene un write lock SQLite; con `busy_timeout = 5`, la importación espera mediante reintentos acotados y termina una sola vez. Una segunda importación reutiliza los mismos ids y sigue habiendo un único signal y change. Se conservaron los tests existentes de importaciones concurrentes, idempotencia y rollback.

```text
(pass) triage import is atomic and idempotent, including concurrent imports [3.89ms]
(pass) failed triage rolls back signal and intake mapping [2.50ms]
(pass) importIssue retries a contended transaction and remains idempotent [343.89ms]
```

**No se hizo:** no se reintentó la petición HTTP ni se alteraron las claves externas o el esquema de importación.

## 5. Prompt por stdin

**Existía:** `src/agents.ts:174@ce84fc4` construía argv con `agent.command(prompt, options)`, y `src/agents.ts:181@ce84fc4` cerraba stdin. Además, `src/manifest-capture.ts:12@ce84fc4` cerraba stdin de su hijo: cambiar únicamente `runAgent` habría dejado roto el recorrido real del pool.

**Verificación de CLI instalados:** se ejecutaron `claude --help`, `codex exec --help`, `agy --help`, `droid exec --help` y `bun src/agent/exec.ts --help`. Extractos de la salida real:

```text
claude --help:
  --input-format <format>  Input format (only works with --print):
                          "text" (default), or "stream-json"

codex exec --help:
  [PROMPT]
    Initial instructions for the agent. If not provided as an argument (or if `-` is used),
    instructions are read from stdin.

droid exec --help:
  -f, --file <path>  Read prompt from file

agy --help:
  --input-format  Input format for print mode (text, stream-json). stream-json reads
                  one NDJSON message per line from stdin and runs a turn for each;
                  it requires --output-format stream-json
```

La ayuda nativa muestra prompt opcional; además se verificó en `src/agent/exec.ts:238-240` la lectura existente de `Bun.stdin.text()` cuando no hay posicional y la entrada no es TTY.

| Adaptador | Transporte usado por runAgent | Evidencia |
|---|---|---|
| Claude | stdin de texto; `-p` sin prompt posicional | `--input-format text` documentado en su ayuda |
| Codex | stdin; posicional `-` | Documentado explícitamente por `codex exec --help` |
| Droid | stdin mediante `--file /dev/stdin` | Opción `--file` documentada y descriptor estándar de Linux |
| Native | stdin sin posicional | Ayuda + lectura directa del código del CLI |
| AGY | argv en su modo actual de texto | Rechaza prompt vacío aunque reciba texto por stdin; su stdin documentado es NDJSON con salida stream-json |
| Fake | argv, con su truncado existente a 80 caracteres | Adaptador determinista de tests |

Para AGY se comprobó también el modo texto con entrada vacía y con `fab stdin probe` por tubería, usando `--print '' --input-format text --agent __fab_stdin_probe_missing__ --print-timeout 100ms`. Ambas variantes terminaron antes de ejecutar un agente con:

```text
error: Error: empty prompt. Usage: agy --print "your prompt here"
```

**Cambio:** `AgentAdapter` declara la capacidad opcional `promptStdin`. `runAgent` activa esa opción al construir argv y entrega los bytes UTF-8 mediante la entrada nativa de `Bun.spawn`, que gestiona el envío y EOF. `command(prompt, options)` conserva el prompt en argv por defecto, también con `readOnly`; solo lo retira con la nueva opción explícita. Los wrappers que propagan `options` y añaden flags al final siguen funcionando. El recorder hereda stdin hacia su hijo. Se mantienen el timeout y la terminación del grupo de procesos.

**Tests:** cuatro adaptadores con prompt de 230000 caracteres más texto UTF-8, sin prompt en argv y con comprobación de tamaño/hash en el proceso receptor; compatibilidad por defecto y wrapper que añade flags de sesión; recorder real con stdin; adaptador de argv sin capacidad; salida prematura y timeout con entrada de 500000 caracteres.

```text
(pass) claude: command defaults stay compatible and runAgent sends >200 KiB via stdin [31.24ms]
(pass) codex: command defaults stay compatible and runAgent sends >200 KiB via stdin [38.61ms]
(pass) droid: command defaults stay compatible and runAgent sends >200 KiB via stdin [38.92ms]
(pass) native: command defaults stay compatible and runAgent sends >200 KiB via stdin [39.98ms]
(pass) the pool capture wrapper forwards stdin to the CLI and retains its output [88.35ms]
(pass) argv-only adapters retain their command contract [1.59ms]
(pass) large stdin does not stall timeout or early process exit [58.43ms]
```

**No se hizo y límites:** AGY conserva el límite de longitud y la visibilidad de argv en modo texto. No se inventó un protocolo ni se añadió un parser de su salida NDJSON: habilitar ese modo exige otro contrato de entrada/salida y no equivale a pasar el prompt de texto por stdin. No se ejecutaron modelos remotos para validar los adaptadores; los tests usan un proceso receptor local, sin facturación, y la evidencia de las ayudas. `/dev/stdin` es la vía Unix de Droid, comprobada en este host Linux; no se certificó Windows. No se editaron los wrappers de las otras ramas.

## Validación conjunta

```text
$ bun run typecheck
$ tsc --noEmit -p .
exit 0

$ bun test tests/store.test.ts tests/pool-leases.test.ts tests/worktrees.test.ts tests/connectors-intake.test.ts tests/agents-stdin.test.ts tests/manifest.test.ts tests/validators-core.test.ts tests/sandbox-confine.test.ts

 87 pass
 0 fail
 460 expect() calls
Ran 87 tests across 8 files. [12.40s]

$ bun test tests
1 tests failed:
(fail) corrupt final record ignored and repaired; corruption before final record fails closed; 10000 records [30001.27ms]
  ^ this test timed out after 30000ms.

 1077 pass
 1 fail
 6728 expect() calls
Ran 1078 tests across 102 files. [344.38s]

$ git diff --check
exit 0
```

Resultado: 17 pruebas nuevas pasan; la base tiene 1060 pass / 1 fail y el árbol final 1077 pass / 1 fail. No hay fallos nuevos. La comparación de las dos suites sobre la base y el árbol modificado se limita a las corridas bajo `/home`; el timeout preexistente del test de journal de 10000 registros no se modifica en esta fase. Los fallos intermedios de desarrollo (una aserción que usaba `level` en lugar de `severity` y el typecheck de `message: unknown`) quedaron corregidos antes de la corrida focalizada y la suite final.

Logs completos conservados: `/tmp/fase0-base-tests.log`, `/tmp/fase0-base-ce84fc4-tests.log` (diagnóstico bajo /tmp), `/tmp/fase0-base-home-ce84fc4-tests.log`, `/tmp/fase0-base-home-sandbox-probe.log`, `/tmp/fase0-focused-tests.log`, `/tmp/fase0-typecheck.log`, `/tmp/fase0-final-tests.log`. Las ayudas están en `/tmp/fase0-{claude,codex,agy,droid,native}-help.txt`. El enlace `node_modules` no rastreado que ya existía en el worktree de implementación se conserva.

Los cambios se pueden separar en cinco commits lógicos por las tareas anteriores; no se ha creado ninguno. No se implementó el residente ni las fases siguientes.

<!-- FIN -->
