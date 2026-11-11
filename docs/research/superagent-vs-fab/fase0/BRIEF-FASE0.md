# Brief: fase 0, endurecer el pool antes del comando residente

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase0`, rama `feat/fase0-endurecer`, base `ce84fc4`. Trabaja **solo** ahí.

## Contexto
La fab va a tener un comando residente que ejecutará el pool sin que nadie lo mire. Dos rondas de revisión encontraron defectos que hoy se notan porque hay una persona delante y que, sin supervisión, pasarían inadvertidos. La síntesis está en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review2/SINTESIS-R2.md` (R4, R5, R6, R10, R14). Los informes de origen están en `review2/fable.md` (F-01, F-02, F-05, F-06, F-11) y `review2/codex.md` (CD-01, CD-02). **Verifica cada defecto en el código antes de arreglarlo.** Si alguno no existe, dilo en tu informe y no lo toques.

## Tareas (una por commit lógico; no hagas commit, solo deja el árbol listo)

1. **Huérfanos sin tope** (`src/store.ts`, `requeueOrphans`, en torno a la línea 1096). El reencolado no incrementa `retry_count`. `failActivity` sí lo hace y corta en `MAX_ACTIVITY_RETRIES` (`src/enums.ts:78`). Haz que reencolar un huérfano cuente como un intento y que, al llegar al tope, la activity y el change terminen igual que en `failActivity`, con un evento que diga que fue por lease vencido.
   *Test:* una activity que queda huérfana repetidamente acaba en fallo tras `MAX_ACTIVITY_RETRIES` y no vuelve a `pending`.

2. **Token por claim** (`src/pool.ts:414`; escrituras protegidas con `worker_id = ?` en `src/store.ts`). Hoy `workerId` es `w<slot>-<pid>` y se repite al rotar el slot, así que una corrutina antigua podría escribir sobre un claim nuevo con el mismo id. Añade un identificador único por claim al `workerId`, por ejemplo un sufijo aleatorio. No añadas columnas.
   *Test:* dos claims sucesivos del mismo slot tienen `workerId` distinto, y un `heartbeat` o `completeActivity` con el `workerId` antiguo se rechaza.

3. **Worktree reutilizado sin verificar** (`src/worktrees.ts:42`). `ensureWorktree` devuelve cualquier ruta existente. Antes de reutilizarla, comprueba que:
   - es un worktree de **ese** repositorio (`git rev-parse --git-common-dir` resuelve al del repo);
   - su rama actual es `branchFor(changeId)`;
   - la creación terminó.

   Si algo falla, lanza un error claro; **no borres nada automáticamente**. Toma como referencia `/home/orlando/Desktop/factory/ext/copilot-superagent/vscode/src/worktree.ts:94-228` (`prepare`/`ticketAt`, licencia MIT; cita el origen en un comentario si adaptas código). No cambies el truncado a 8 caracteres de las rutas existentes, porque rompería worktrees en uso. Solo anótalo como riesgo en el informe.
   *Tests:* ruta de otro repo, rama cambiada, directorio que no es worktree y reutilización válida.

4. **`importIssue` sin `withRetry`** (`src/connectors/intake.ts:40-52`). Envuelve la transacción en `store.withRetry`, igual que el resto del `Store`.
   *Test:* si existe un patrón de test de contención en `tests/`, reutilízalo; si no, basta un test de que la importación sigue siendo idempotente.

5. **Prompt por argv** (`src/agents.ts`). El prompt, que incluye texto no confiable de la HU, va como argumento: tiene un límite de unos 128 KiB y queda visible en la lista de procesos. Haz que los adaptadores cuyo CLI acepta el prompt por stdin lo reciban por stdin en `runAgent`. Compruébalo con `--help` de cada CLI instalado (`claude`, `codex`, …); no lo supongas.
   - **Restricción:** la firma `command(prompt, options)` y su comportamiento por defecto deben seguir funcionando. Las ramas `feat/live-claude` y `feat/live-native` envuelven `getAgent('claude').command(...)` y añaden flags al final. Lee `src/live/claude.ts` en el worktree `/home/orlando/Desktop/factory/sw-factory-live-claude` para no romperlo.
   - Si un CLI no admite stdin, déjalo por argv y anótalo.
   *Test:* para un adaptador con stdin, el argv no contiene el prompt y el proceso lo recibe; y con un prompt de más de 200 KiB el lanzamiento no falla por longitud.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos. Para un bug, busca **todos** los llamadores de la función que tocas antes de editarla.
- Cambio mínimo y en la capa dueña. Sin columnas ni migraciones nuevas, sin dependencias nuevas, sin refactors no pedidos.
- No toques los worktrees `sw-factory-live-*` ni el repo principal, salvo tu informe.
- No hagas commit, push ni merge. No lances subagentes.
- Antes de terminar ejecuta:
  - **antes de editar nada**, `bun test tests` en la base, y guarda el resultado;
  - después, `bun run typecheck`, los tests nuevos y otra vez `bun test tests`.

  La suite completa no debe empeorar.
- Informe en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase0/codex.md`. Para cada tarea incluye:
  - si el defecto existía, con la cita `ruta:línea`;
  - qué cambiaste;
  - los tests y su salida pegada;
  - lo que no hiciste y por qué.

  Última línea, exactamente: `<!-- FIN -->`.
