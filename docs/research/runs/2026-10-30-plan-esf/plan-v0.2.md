# Plan de implementación — candidatos ESF → fab

Versión v0.2 (lectura a fondo de `tui.ts`, `agents.ts`, router, omni,
`mission-contract.ts`, `mission.ts`, `store.ts`). Ver §0 para lo que cambió.

Fuente: `analisis/esf.md` (run `2026-10-30-B-esf-01`). fab base: `29d4dd3`
(`main`). Estado de cada candidato: `propuesto` hasta que Orlando lo pase a
`experimento_autorizado`; medir **antes** de integrar; `integracion_autorizada`
solo con receipt en `runs/<id>/bench.jsonl`.

## 0. Lo que cambió tras leer el código a fondo

| # | Hecho verificado | Efecto en el plan |
| --- | --- | --- |
| H1 | Los workers del pool **no corren en el bwrap de fab**. `runAgent` lanza el CLI tal cual (`agents.ts:130-154`). El aislamiento depende de cada CLI: codex usa su propio sandbox (`agents.ts:51-53`), claude una allowlist con `acceptEdits` (`:21-41`), agy `--dangerously-skip-permissions` (`:59`) y droid `--auto medium` (`:67-79`). Solo el adaptador `native` usa el bwrap de fab en sus herramientas. | **08 sonda de egress** solo tiene sentido para `native`; para los CLIs se registra la postura por adaptador en el manifest. **03 threatmon** sube de prioridad: con agy no hay ninguna otra barrera. |
| H2 | `readOnly` solo lo respetan codex y native (`agents.ts:51-53,107`); claude, agy y droid ignoran la opción. Un validador `code_review` con claude puede editar el worktree, y `porcelain` solo se comprueba tras `qa` (`pool.ts:65-77`). | **02** se aplica tras implementación **y tras cada validador**. Se añade el comprobante `porcelain` a todos los validadores (una línea: quitar la condición `a.validator === 'qa'`). |
| H3 | Sin línea `STATUS` el reporte cuenta como bloqueado (`prompts.ts:82-86`) y `failActivity` reintenta hasta 3 veces (`store.ts:563-582`). | **06** debe distinguir `STATUS: blocked - <razón>` explícito (terminal) de reporte malformado (reintentable). |
| H4 | `resolveReview` ya escribe el evento **en la misma transacción** que la decisión (`store.ts:591-617`). La TUI rechaza con `d` sin pedir motivo (`tui.ts:190-195`) y solo reintenta changes `failed` (`:202-207`). | **09** se reduce a actor + motivo obligatorio al rechazar; ya es atómico, no hay experimento que medir. Toca la TUI: `d` entra en modo comentario. **06** también toca la TUI (`STATUS_COLOR`, `r`) y `retryChange`. |
| H5 | `runAgent` no acepta señal de aborto (`agents.ts:130-136`): solo un `setTimeout` de 20 min con SIGTERM. | **07**: si el lease caduca y otro pool reclama la activity, el agente original sigue escribiendo en el **mismo worktree** (la ruta depende solo del changeId, `worktrees.ts`). Hay que añadir `AbortSignal` a `runAgent` y matar el proceso al perder el lease. Sube de S a M. |
| H6 | Las misiones ya tienen el patrón de **integridad de rutas protegidas**: digest por archivo al empezar, sellado "solo se puede añadir", pausa `protected_paths_changed` (`mission.ts:111-120,293-325`, `mission-contract.ts:56-59`). Archivos nuevos se añaden a la línea base, no cuentan como manipulación (`mission.ts:296`). | **02** reusa esa semántica: modificar o borrar un archivo protegido que existía en la base = manipulación; **añadir** tests nuevos es legítimo. Desaparece la necesidad general de `--allow-gate-change`. La manipulación no falla: deja el change en `blocked` (reusa 06) para decisión humana, como la pausa de misiones. |
| H7 | Los workers del pool son CLIs externos: fab **no ve tokens ni coste** (`AgentRun` = ok, output, exitCode, durationMs). El router y omni solo actúan dentro del motor `native`. Omni ya tiene leases en memoria por grupo de cuota (`omni/scheduler.ts:93-162`) y las misiones ya reservan **llamadas** antes del primer efecto (`tasks.ts:36`, `mission.ts:291`). | **10** no aplica al pool. Se re-acota a: extender la reserva por llamadas existente a coste en `native` y misiones. Pasa a prioridad 4, diferido hasta que `native` sea el adaptador habitual del pool. |
| H8 | `runVerifier` necesita un `ToolContext` (`mission-evidence.ts:148`) que el pool no tiene; usa `wrapCommand` con `allowNetwork:false`. | **01** extrae un `runVerifierAt(cwd, argv, signal)` sin `ToolContext` que reutilizan misiones y pool; no se duplica la lógica. |
| H9 | La tabla `events` no tiene actor ni tipo (`store.ts:113-115`). | **09** añade columna `actor` nullable con `ALTER TABLE` en vez de meterlo en el texto, para poder consultarlo. |

## Reglas de ejecución

- Cada tarea la implementa codex o agy en su worktree (`fab/research-<id>`),
  con contrato `task-<id>.md` derivado de la ficha de abajo. Claude coordina,
  valida (`bun test`, `tsc --noEmit`, fab real sobre `examples/toy-calc`) e
  integra. Un escritor por worktree; un candidato por rama.
- Sin servicios nuevos, sin dependencias nuevas: todo en Bun/TS sobre el
  `Store` SQLite, el pool y el sandbox existentes.
- Esquema: añadir columnas con `ALTER TABLE ... ADD COLUMN` idempotente en
  `store.ts` (el esquema usa `CREATE TABLE IF NOT EXISTS`); nunca borrar.
- Licencia: ESF es MIT; lo que se adapte cita `ext/esf/<archivo>@d901657` en
  el commit. Nada se copia literal.
- Medición: `fake` agent para todo lo determinista (coste 0); LLM real solo
  donde la métrica lo exige (01 y 05). Baseline primero, en `main`, con el
  mismo comando; 10 corridas pareadas; resultado a `bench.jsonl`.

## Olas

| Ola | Candidatos | Por qué juntos | LLM para medir |
| --- | --- | --- | --- |
| 1 | 06 BLOCKED terminal · 02 gate-integrity (usa 06) · 09 actor y motivo · 07 lease TTL con aborto | Sin prompt, medibles con `fake`; 02 depende de 06 | no |
| 2 | 04 manifest por change (con postura de aislamiento por adaptador) · 03 threatmon · 08 sonda solo `native` | 04 define dónde va la evidencia; 03 sube por H1 | no (03 usa historial) |
| 3 | 01 verificación determinista | Depende de 02 (rutas de gate) y 04 (dónde guardar resultados) | sí, baseline qa LLM |
| 4 | 05 perfiles inmutables · (10 diferido, ver H7) | L | sí (05) |

Cada ola termina con: tests nuevos en verde, `fab` real sobre toy-calc,
medición contra baseline, decisión humana.

---

## Ola 1

### 07 · Leases con TTL y aborto (C2) — M (era S, ver H5)
- Hoy: `claimActivity` marca `in_progress` sin caducidad (`store.ts:412-440`);
  `requeueOrphans` reencola todo `in_progress` del workstream al arrancar
  (`store.ts:649-658`, llamado en `pool.ts:106`).
- Cambio mínimo:
  - columna `lease_expires_at TEXT` en `activities`; `claimActivity` la fija a
    `now + 90 s`; `completeActivity`/`failActivity` la limpian.
  - `heartbeat(activityId, workerId)` que renueva el lease; el pool lo llama
    cada 30 s mientras `processActivity` corre (reusar el `Promise.race` con
    `Bun.sleep` de `pool.ts:123`).
  - `requeueOrphans` solo reencola `in_progress AND lease_expires_at < now`;
    además se llama en cada vuelta del bucle, no solo al arrancar.
  - `runAgent(..., { signal })`: el pool crea un `AbortController` por
    activity; si `heartbeat` devuelve 0 filas (lease perdido) aborta y mata el
    proceso del CLI antes de que otro worker use el mismo worktree.
- Tests: `tests/pool.test.ts` y `tests/store.test.ts`: dos pools sobre el mismo
  store con `fake`; matar uno (abortar su promesa) → 0 duplicados, huérfano
  reencolado tras 180 s simulados (inyectar reloj o acortar TTL por opción).
- Medición (receta 07): baseline en `main` muestra duplicados > 0 con el mismo
  test; candidato = 0. Receipt: salida del test ×10.

### 02 · Integridad de gates (C6) — S
- Hoy: el agente de implementación puede editar tests; solo las misiones tienen
  `protectedPaths` (`agent/mission-contract.ts:50-53`).
- Cambio mínimo:
  - columna `protected_paths TEXT` (JSON de globs) en `workstreams`, con
    `fab ws create --protect "tests/**" --protect package.json`.
  - `checkGateIntegrity(worktree, baseRef, globs)` en `worktrees.ts`: lista
    los archivos que casan en `baseRef` (`git ls-tree -r --name-only`) y
    compara `git hash-object <archivo>` con `git rev-parse <base>:<ruta>`;
    borrado = manipulación; **archivos nuevos no cuentan** (misma semántica que
    `mission.ts:296`, H6). Idea del árbol y no del patch:
    `ext/esf/internal/factory/activities.go:54-67@d901657`.
  - Se ejecuta tras la implementación (antes de `completeActivity`) y tras
    cada validador (H2). Manipulación → change `blocked` con razón
    `GATE_TAMPERED: <rutas>` (reusa 06), visible en inbox y TUI; el humano
    decide con `fab review <id> retry` o `decline`.
- Tests: `tests/worktrees.test.ts` con repo temporal: 5 manipulaciones
  (editar test, borrar assert, cambiar script, `--assume-unchanged`,
  reescribir commit) → 5 detectadas; 10 changes limpios → 0 falsos; 3 changes
  que **añaden** tests nuevos → pasan sin excepción. Además: validador `fake`
  que edita un archivo → detectado (H2).

### 09 · Actor y motivo en decisiones (C3) — S (corrección de producto, sin experimento)
- Hoy: `resolveReview` aplica la decisión (`store.ts:591-617`); `decline` no
  exige comentario (`cli.ts:202-205`); la tabla `events` ya existe
  (`store.ts:113-115`).
- Ya resuelto: decisión y evento son atómicos en la misma transacción (H4).
- Cambio mínimo: columna `actor TEXT` en `events` (H9); `resolveReview` recibe
  `actor` (`$FAB_ACTOR ?? os.userInfo().username`) y rechaza `decline` sin
  comentario. En la TUI, `d` abre el modo comentario con la etiqueta "motivo"
  y envía `decline` al pulsar enter (`tui.ts:160-171,190-195`).
- Tests: `tests/store.test.ts` (decline sin motivo falla; evento con actor) y
  test de `handleKey` (la función es pura respecto al store).

### 06 · BLOCKED terminal (C2/C4b) — S
- Hoy: `parseReportStatus` ya detecta bloqueo y lo convierte en
  `failActivity('blocked: …')` (`pool.ts:49-53`), que reintenta hasta 3 veces
  (`enums.ts:78`, `store.ts:563-582`) y gasta tres sesiones de agente.
- Cambio mínimo: estado `blocked` en activities y changes; solo
  `STATUS: blocked - <razón>` explícito es terminal; un reporte sin `STATUS`
  sigue siendo fallo reintentable (H3). `failActivity` recibe
  `{ terminal: true }`; `retryChange` acepta `failed` y `blocked`; la TUI añade
  color a `blocked` y permite `r` sobre él (`tui.ts:21-30,202-207`); `fab inbox`
  muestra la razón. Orden: el bloqueo se honra **después** de 02 y 03, para que
  un agente no lo use para esconder una manipulación (como ESF).
- Tests: `tests/validators-pool.test.ts`: `fake` que responde bloqueado → 1
  intento, change `blocked`, sin reintentos. Medición: ratio de llamadas
  candidato/baseline en 5 tareas imposibles con `fake` ≈ 1/3.

## Ola 2

### 04 · Manifest por change con cleanup verificado (C6) — M
- Hoy: `ValidationSummary` es "último por validador" (`store.ts:471-505`);
  `mergeAndCleanup` no deja evidencia (`worktrees.ts:50-80`).
- Cambio mínimo:
  - archivo `<stateDir>/runs/<changeId>/run.json` escrito por `writeManifest`
    en `store.ts` o módulo nuevo `src/manifest.ts` (≤ 120 líneas): change,
    workstream, base sha, branch sha, activities con validator/verdict/retries,
    `isolation: {adapter, sandbox: 'codex-workspace-write'|'claude-allowlist'|'none'|'fab-bwrap'}`
    derivado del adaptador (H1), duración, `cleanup: {verified, error}`, `written_at`.
    Sin coste: los CLIs no lo exponen (H7).
  - `fab merge` escribe el manifest **después** de `mergeAndCleanup`, con
    `cleanup.verified = !existsSync(worktree) && branch borrada`; si no se
    verifica, el change queda `completed_unverified` (idea de
    `ext/esf/internal/factory/workflow.go:232-235@d901657`).
  - Redacción al escribir: regex de `agent/` si ya existe un redactor (buscar
    `redact` en `src/agent/`); si no, 8 patrones en `manifest.ts`.
- Tests: `tests/worktrees.test.ts` + nuevo `tests/manifest.test.ts`: merge,
  cancel y fail producen manifest; 8 secretos plantados → 0 en el archivo.

### 08 · Sonda de egress (C5) — S, solo adaptador `native` (H1)
- Para claude/codex/agy/droid no aplica: necesitan red hacia su API y fab no
  los envuelve. Su postura queda en el manifest (04).
- Cambio mínimo: antes de `runAgent` en `processActivity`, si la política es
  `deny`, ejecutar dentro del mismo `wrapCommand` un `curl -sS --max-time 3`
  (o `/dev/tcp`) contra un canario fijo; registrar `{reachable, decided}` en el
  manifest (04) y en `events`. Apertura positiva en modo `deny` →
  `failActivity('EGRESS_UNVERIFIED')`. `unknown` solo se anota.
- Tests: `tests/execute-network-cli.test.ts`: con red permitida la sonda
  alcanza (control positivo); con `deny` reporta inalcanzable y `decided`.

### 03 · Monitor de comportamiento (C5) — M · prioridad sube por H1 (agy sin barrera)
- Cambio mínimo: `src/threatmon.ts` con las reglas reimplementadas en TS
  (citar `ext/esf/internal/threatmon/rules.go@d901657`), normalización ANSI/CR,
  entrada = `run.output` + `git diff` del change; hallazgo ≥ `high` →
  `failActivity('QUARANTINED: <regla>')` antes de encolar validadores y
  change en `quarantined`. Severidad umbral por workstream (columna
  `trip_severity`, default `high`).
- Tests: `tests/threatmon.test.ts`: 10 transcripciones adversas realistas
  detectadas ≥ 9; **medición principal**: correr el monitor sobre ≥ 30
  outputs reales guardados del historial (`fab events` + journal) → FP ≤ 0.05.
  Si no hay 30 outputs guardados aún, 04 debe integrarse antes y acumularlos.

## Ola 3

### 01 · Verificación determinista en el pool (C6) — M
- Hoy: `qa` es LLM (`validators/prompts.ts:36-44`); el verificador
  determinista existe en misiones: `runVerifier(context, command)` en
  `agent/mission-evidence.ts:148` corre en bwrap sin red.
- Cambio mínimo:
  - columna `verify_steps TEXT` (JSON `[{id, argv, mandatory}]`) en
    `workstreams`; `fab ws create --verify "bun test" --verify "tsc --noEmit"`.
  - extraer `runVerifierAt(cwd, argv, signal)` de `runVerifier` sin
    `ToolContext` (H8); misiones lo siguen usando a través del wrapper actual.
  - validador nuevo `gates` (determinista) encolado **antes** de
    `code_review/security_audit/qa`: por paso, `runVerifierAt`; veredicto = todos
    los obligatorios con exit 0 y sin timeout; un paso que no puede ejecutarse
    = fail; se ejecutan todos aunque uno falle; stdout/stderr al manifest (04).
  - `mergeBlocker` ya bloquea `fail`; `gates` entra sin cambios ahí.
  - Los pasos se ejecutan con red abierta para poder instalar dependencias
    (`bun install`) antes de los tests.
- Tests: `tests/validators-pool.test.ts`: pasos con exit 1, timeout y binario
  inexistente → fail atribuible; todos pasan → pass.
- Medición (receta 01, única con LLM): 10 bugs plantados en toy-calc con test
  que falla + 5 en una tarea real; baseline = sensibilidad de `qa` LLM
  (`claude -p`, 10 corridas); candidato = `gates` + `qa`; ratio ≥ 1.2 y coste
  ≤ 1.0. Presupuesto de medición: ~30 USD; pedir autorización explícita.

## Ola 4

### 05 · Perfiles instruccionales inmutables (C4b) — L
- Hoy: `buildWorkerPrompt` arma el prompt en runtime (`prompts.ts:47`).
- Cambio mínimo (solo fase 1 del análisis):
  - `src/profile.ts`: perfil = JSON `{schema:'fab-profile/v1', systemprompt,
    tool_guidance?, memory?}`, digest sha256 del JSON canónico, guardado en
    `<stateDir>/profiles/<digest>.json` con `O_EXCL` (inmutable).
  - `fab profile import <archivo>` / `inspect <digest>`; columna
    `profile_digest TEXT` en `workstreams`; `buildWorkerPrompt` usa el perfil
    si existe, si no el texto actual (que se exporta como perfil `default` en
    la primera ejecución, para que baseline y candidato compartan bytes).
  - `fab improve --experiment-id <id> --suite <json>`: solo registra la suite
    (fixtures con `split`) y rechaza IDs repetidos; corre las fixtures con el
    perfil dado y guarda resultados en `runs/<id>/`. Sin cualificación ni
    rollout (fase 2, no ahora).
- Tests: digest estable; import de perfil existente no sobrescribe; ID
  repetido rechazado.
- Medición: varianza de éxito y tamaño de diff en 10 corridas pareadas con y
  sin perfil (LLM real; ~40 USD; autorización explícita).

### 10 · Reserva previa de presupuesto (C4a) — DIFERIDO (H7)
- No aplica al pool: los CLIs no exponen tokens. Re-acotado a `native` y
  misiones, que ya reservan **llamadas** (`tasks.ts:36`). El cambio sería pasar
  de llamadas a coste estimado con el mismo mecanismo. Se reabre cuando
  `native` sea el adaptador habitual del pool.
- Diseño original, conservado como referencia:
- Cambio mínimo: tabla `budget_calls(id, workstream_id, request_id UNIQUE,
  reserved_micros, settled_micros, state)`; antes de cada llamada del router
  (`agent/providers/router.ts:17,47`) reservar el peor caso contra `usd_max`
  del workstream (columna nueva); `request_id` duplicado → rechazo; uso no
  verificable → `state='unknown'` y workstream en `paused` (idea de
  `ext/esf/internal/inferencebudget/ledger.go:181-218@d901657`).
- Tests: kill entre reserva y settle → no duplica; sobrepasar límite → denegado.
- Medición: receta 10 con `fake` que reporta tokens; sobrecoste ≤ 0.1 del
  baseline.

---

## Dependencias y orden sugerido de tareas

```
06 ──► 02 ─┐
09 ─────────┼─ ola 1 ──► 04 ──► 03 ──► 01 ──► 05
07 ─────────┘            └──► 08 (native)
10 diferido
```

## Lo que este plan no incluye
- Cualificación estadística, rollout y rollback de perfiles (fase 2 de 05).
- Consola web, `agents verify`, turnos remotos, notificaciones: ideas sin
  candidato en el análisis.
- Nada de Temporal ni microVM.
