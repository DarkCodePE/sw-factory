# Brief: fase 1, costura en modo observe

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase1`, rama `feat/fase1-observe`, base `ce84fc4`. Trabaja **solo** ahí. `node_modules` es un enlace simbólico ya creado; no lo toques.

## Contexto
La fab va a recibir trabajo de forma autónoma desde fuentes externas: issues de GitHub y, más adelante, otros canales. Antes de que eso cree changes o lance agentes, la fase 1 construye la costura **en modo observe**: detecta eventos, decide de forma determinista si los admitiría (`would_admit`) y lo registra, **sin crear changes ni ejecutar agentes**.

Lee primero:
- **Diseño:** `/home/orlando/Desktop/factory/sw-factory/techdocs/docs/investigacion/inspiracion/06-integracion-superagent-fab.md`, sobre todo §4, §5 con su diagrama, §6 y §7.
- **Síntesis de revisión:** `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/review2/SINTESIS-R2.md`, hallazgos R3, R6, R12, R13 y R15.
- **Referencia de la cola de efectos:** `/home/orlando/Desktop/factory/dsh-superagent-prototype/src/app/effects.ts` y quien la use. Tómala como inspiración; si adaptas código, cita el origen en un comentario.

La fase 0, el endurecimiento del pool, va en paralelo en otra rama. **No dependes de ella ni debes tocar sus zonas**: `requeueOrphans`, `failActivity`, `claimActivity`, `ensureWorktree`, `runAgent` e `importIssue`.

## Qué construir

1. **Módulo de admisión fuera de `Store`**, en `src/admission/`.
   - Usa la misma `fabrica.db`, con tablas de **prefijo propio** (`adm_`) creadas por el propio módulo, como hace `ChangeLinkStore` en `src/connectors/links.ts`.
   - **Nunca escribe en tablas de la fab** (`signals`, `changes`, `activities`, …). En esta fase tampoco necesita leerlas.

2. **Cola de efectos durable**, `adm_effects`, con: `kind`, `key` idempotente única, `payload`, `attempts`, `due_at`, estado y último error.
   - **Atomicidad:** encolar un efecto ocurre **en la misma transacción** que el cambio de estado que lo origina.
   - **Despachador:** toma los efectos vencidos, llama a un handler por `kind`, reintenta con espera creciente y, al llegar a un tope, marca el efecto como muerto con su error.
   - **Duplicados:** una misma `key` nunca produce dos efectos.
   - **Caídas:** un efecto a medio despachar debe reanudarse tras reiniciar sin perderse. Sigue la regla de R6: identidad de intento; no supongas que reejecutar es seguro sin más.
   - **Contención:** usa `withRetry` y `.immediate()` como el resto de escrituras en esta base. Mira `src/store.ts:276-301`.

3. **Comando residente**, con el nombre que encaje en `src/cli.ts`, por ejemplo `fab resident`.
   - **Lock exclusivo:** una segunda instancia sobre la misma base se niega con un error claro. Un lock que deja un proceso muerto debe poder recuperarse.
   - **Bucle:** hace poll de las fuentes y despacha la cola de efectos.
   - **Opciones:** `--once` para tests y uso manual; modo `off|observe`. **En esta fase `auto` se rechaza.**

4. **Poller de GitHub**: issues de un repo configurado.
   - Reutiliza el patrón `CommandRunner` + `gh` de `src/connectors/github.ts` para poder inyectar un runner falso en los tests.
   - Comprueba los flags reales con `gh issue list --help` o `gh api --help`; no los supongas.
   - Lleva un cursor durable para no releer todo cada vez.

5. **Trigger y Thread idempotentes.**
   - Cada evento externo produce como mucho un Trigger, aunque el poll se repita o el proceso se caiga entre leer y registrar.
   - El Thread agrupa los Triggers del mismo issue.

6. **Gate determinista** con `would_admit`. Es una función pura y sin modelo.
   - **Entrada:** solo metadatos verificados, como repo, labels, autor y su relación con el repo (`authorAssociation` u otro dato real de la API), y una allowlist configurable.
   - **Salida:** `{ would_admit, strength: 'explicit'|'inferred', scope_max, reasons[] }`.
   - **El texto del issue es un dato no confiable** (ADR-0007, R13): no amplía el `scope` ni cambia la decisión.
   - **Registro:** en modo observe solo se escribe la decisión. El poll → Trigger → gate → registro va en una transacción, o encadenado por efectos.

## Condición de salida (fase 1, §7)
**Registros de `would_admit` reproducibles.** Con las mismas fixtures de entrada:
- se obtienen los mismos registros;
- repetir el poll no duplica nada;
- matar el proceso en cada frontera (tras leer, tras registrar el Trigger y a mitad de efecto) y reiniciarlo deja el mismo resultado final.

## Tests, en `tests/admission-*.test.ts`
Sin red ni modelo, con un runner de `gh` falso:
- **Gate:** tabla de casos, incluido un issue cuyo texto intenta ampliar permisos.
- **Idempotencia:** del Trigger y del Thread.
- **Cola:** atomicidad estado + efecto, reintentos con tope y efecto muerto, deduplicación por `key`, reanudación tras caída.
- **Lock:** segunda instancia rechazada y lock de un proceso muerto recuperado.
- **Residente:** `--once` de extremo a extremo con fixtures, y la comprobación de que no aparece ninguna fila en `signals` ni en `changes`.
- **Caídas inyectadas:** en cada frontera.

**Prueba live** contra GitHub real, **solo con `FAB_LIVE_TEST=1`** y solo de lectura, sobre un repo público pequeño.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- **Cambio mínimo.**
  - Sin dependencias nuevas ni migraciones de tablas existentes.
  - Sin router, Mandate, Subscriptions ni Outbox: eso es fase 2 y 3.
  - Sin crear signals ni changes y sin ejecutar agentes.
- Sin tocar `src/pool.ts` ni las zonas de la fase 0 de `src/store.ts`. Para registrar el comando puedes tocar `src/cli.ts`.
- **Prohibido:** tocar otros worktrees o el repo principal (salvo tu informe), hacer commit, push o merge, o lanzar subagentes.
- **Comprobaciones:**
  - **antes de editar nada:** `bun test tests` en la base; guarda la salida;
  - **al terminar:** `bun run typecheck`, tus tests y otra vez `bun test tests`. La suite completa no debe empeorar. En la base hay un fallo conocido: un timeout en el test de journal de 10000 registros.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/fase1/sonnet.md` e incluye:
- qué construiste, con un esquema de tablas y el flujo, citando `ruta:línea`;
- comandos ejecutados y su salida pegada;
- decisiones que tomaste y por qué, sobre todo en el lock, la identidad de intento y el cursor;
- lo que no hiciste o no probaste;
- qué necesitará la fase 2 de esto: `awaiting`, Outbox y efectos `launch`/`deliver`/`stop`.

Última línea, exactamente: `<!-- FIN -->`.
