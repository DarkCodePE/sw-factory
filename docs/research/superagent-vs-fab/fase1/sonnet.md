# Fase 1: costura en modo observe (informe de Sonnet 5.5)

Worktree `/home/orlando/Desktop/factory/sw-factory-fase1`, rama `feat/fase1-observe`, base `ce84fc4`. Sin commit, sin push, sin subagentes. No toqué `src/pool.ts`, `src/store.ts` ni las zonas de la fase 0.

## Qué construí

Todo el código nuevo vive en `src/admission/` (358 líneas) más 8 líneas en `src/cli.ts` (import `:33`, ayuda `:91`, despacho `:147`, `COMMANDS` `:378`).

| Archivo | Contenido |
|---|---|
| `src/admission/db.ts:8-30` | `AdmissionDb`: crea las tablas `adm_*` sobre la `fabrica.db` del `Store` (patrón `ChangeLinkStore`) y expone `tx()` = `Store.withRetry` (IMMEDIATE + reintento, `store.ts:281-301`) |
| `src/admission/effects.ts` | Cola `adm_effects`: `enqueue` `:22`, `recover` `:29`, `dispatch` `:44`, `claim` `:55`, `execute` `:67` |
| `src/admission/lock.ts` | Lock exclusivo: `acquire` `:18`, `assertOwned` `:33`, `release` `:38` |
| `src/admission/github.ts` | `pollIssues` vía `gh api`, con `CommandRunner` inyectable |
| `src/admission/gate.ts` | `gate()` puro, `would_admit` |
| `src/admission/resident.ts` | `Resident`: `register` `:35` (Trigger+Thread+efecto+cursor en una tx), `admit` `:54`, `cycle` `:66`, `run` `:79` |
| `src/admission/cli.ts` | `fab resident` |

No escribe ni lee `signals`, `changes`, `activities` ni ninguna tabla de la fab. Solo reutiliza `Store.db`, `withRetry` y `clock`.

### Esquema (`db.ts`)

```
adm_effects(id, kind, key UNIQUE, payload, status pending|running|done|dead|unknown,
            attempts, due_at, attempt_id, last_error)
adm_lock(id=1, owner, pid, host, heartbeat_at)
adm_cursors(source PK, value)                 -- updated_at ISO del último issue procesado
adm_threads(id PK 'github:o/r#N', source, first_seen)
adm_triggers(key PK 'github:o/r#N@updated_at', thread_id → adm_threads, event JSON, observed_at)
adm_decisions(trigger_key PK → adm_triggers, would_admit, strength, scope_max, reasons, policy, decided_at)
```

### Flujo

```
fab resident --repo o/r [--once] [--mode observe]
  acquire lock → recover() efectos 'running' huérfanos
  cycle():
    assertOwned → leer cursor → gh api repos/o/r/issues?since=cursor (solo lectura)
    [crash: after-read]
    TX: thread (OR IGNORE) + trigger (OR IGNORE) + enqueue 'admit' (key admit:<trigger>) + cursor   ← resident.ts:35
    [crash: after-register]
    dispatch(): claim (TX, fence + running + attempt_id) [crash: effect-claimed]
                → handler admit: gate(metadatos) → INSERT OR IGNORE adm_decisions
                [crash: effect-ran] → TX done WHERE attempt_id=…
```

El texto del issue (título/cuerpo) no se guarda ni se pasa al gate: `GateInput` no tiene campos de texto, así que no puede ampliar el `scope`.

### Gate (`gate.ts`)

Entrada: repo, labels, author, `authorAssociation` (campo `author_association` de la API REST), state; política: repos, etiqueta disparadora (`fab`), asociaciones de confianza (`OWNER,MEMBER,COLLABORATOR`), allowlist de autores.

| Caso | would_admit | strength | scope_max |
|---|---|---|---|
| etiqueta + autor de confianza | sí | explicit | change |
| etiqueta + autor externo | sí | explicit | propose |
| autor de confianza sin etiqueta | sí | inferred | propose |
| externo sin etiqueta / repo ajeno / issue cerrado | no | inferred | none |

La etiqueta cuenta como señal explícita porque solo quien tiene permisos de triage puede ponerla. Esto es una suposición mía sobre GitHub, no verificada contra la API.

## Comandos ejecutados y salida

Baseline antes de editar (`bun test tests`):

```
 1061 pass
 0 fail
 6636 expect() calls
Ran 1061 tests across 101 files. [279.68s]
```

(No apareció el timeout conocido del test de journal de 10000 registros.)

Tests de admisión:

```
$ bun test tests/admission
 31 pass
 1 skip        (live, sin FAB_LIVE_TEST)
 0 fail
 86 expect() calls
Ran 32 tests across 5 files. [4.57s]
```

Typecheck: `$ tsc --noEmit -p .` sin errores.

Live, solo lectura, repo público `octocat/git-consortium` (~49 issues):

```
$ FAB_LIVE_TEST=1 bun test tests/admission-live.test.ts
 1 pass
 0 fail
 5 expect() calls
Ran 1 test across 1 file. [2.20s]
```

Suite completa al terminar:

```
 1092 pass
 1 skip
 0 fail
 6722 expect() calls
Ran 1093 tests across 106 files. [276.88s]
```

Pasa de 1061 a 1092 (+31), sin regresiones.

Flags de `gh` comprobados con `gh api --help` (gh 2.94.0): `--paginate`, `--slurp`, `-X GET`, `-f`. `gh issue list --json` **no** ofrece `authorAssociation`, por eso uso `gh api repos/{repo}/issues`.

## Tests (`tests/admission-*.test.ts`, helper `tests/helpers/admission.ts`)

- `gate`: tabla de 8 casos, issue con texto hostil, determinismo.
- `effects`: atomicidad (rollback no deja efecto, encolar fuera de tx falla), dedupe por `key` incluso tras `done`, backoff 1s/2s y tope → `dead` con error, reanudación tras caída (rerunnable se reanuda con otro `attempt_id`; no rerunnable → `unknown` y no se reejecuta), fencing por `attempt_id`.
- `lock`: segunda instancia rechazada, lock de proceso muerto recuperado (incluye un pid real terminado), latido caducado, release solo del dueño, el residente desplazado deja de despachar.
- `resident`: `--once` e2e sin filas nuevas en `signals`/`changes`/`activities`; texto hostil sin efecto; repetir poll no duplica, usa `since=`; Thread agrupa dos Triggers del mismo issue; cursor no avanza si `gh` falla; **kill en las 4 fronteras** (`after-read`, `after-register`, `effect-claimed`, `effect-ran`) + reinicio da el snapshot idéntico al de una ejecución limpia, y otro reinicio no cambia nada; mismos fixtures → mismos registros en bases distintas; CLI `--mode auto` rechazado y segunda instancia rechazada; modo `off`.

## Decisiones

**Lock.** Una fila en `adm_lock` dentro de la misma base (misma atomicidad, sin archivos extra). Es recuperable si el pid murió (mismo host) o si el latido pasó de 30 s (otro host, proceso colgado). Cada `claim` de efecto llama a `assertOwned()` dentro de su transacción: si otra instancia tomó el lock, la desplazada falla y no sigue despachando (fencing). Riesgo: un pid reutilizado en el mismo host con latido fresco se ve como vivo; el latido caduca a los 30 s y se recupera.

**Identidad de intento (R6).** Cada `claim` pone `running` + `attempts+1` + `attempt_id` (UUID) en la misma tx. El cierre (`done`/`pending`/`dead`) solo aplica `WHERE attempt_id = <el mío>`, así que un intento antiguo no pisa uno nuevo. Con el lock tomado, al arrancar todo `running` es de un intento muerto: `recover()` lo devuelve a `pending` si el handler declara `rerunnable: true` (el `admit` lo es: `INSERT OR IGNORE` sobre una decisión determinista), y si no lo es lo marca `unknown` ("resultado desconocido") sin reejecutar. El tope de intentos también cuenta las caídas.

**Cursor.** `updated_at` del último issue procesado, en `adm_cursors`, avanzado **en la misma tx** que Trigger+efecto. `since` de la API es inclusivo, así que el último issue se relee siempre; la clave del Trigger `repo#N@updated_at` lo deduplica. Una caída tras leer y antes de registrar deja el cursor sin mover y se relee. La clave incluye `updated_at`: un issue editado o reetiquetado produce un Trigger nuevo en el mismo Thread (así se vuelve a evaluar el gate).

**Una sola fuente de verdad de la hora.** Uso `store.clock()`, inyectable, para `due_at`, latidos y backoff.

**Cola con `key` única permanente.** Las filas `done` no se borran: es lo que garantiza que una `key` nunca produzca dos efectos.

## Lo que no hice o no probé

- **No probé un kill real del proceso.** Las caídas son inyectadas con excepciones en 4 fronteras, y el lock de "proceso muerto" se simula reescribiendo el pid por el de un proceso terminado. No hay test con `kill -9` de un `fab resident` real.
- La primera lectura (sin cursor) pagina **todo** el historial del repo; sin tope ni `--since` inicial. Con repos grandes (p. ej. `octocat/Spoon-Knife`, 21k issues) sería caro. Pendiente: `--since` inicial o tope.
- Los PR no avanzan el cursor (se saltan), así que PRs más recientes que el último issue se releen en cada poll; es inocuo pero ineficiente.
- Sin rate limit, sin tratamiento de `Retry-After`, sin paginación incremental por cursor de GitHub.
- Un fallo del poll en modo continuo solo se registra en el log y se reintenta en el siguiente ciclo; no hay cola de reintento propia del poll ni salud expuesta.
- Un efecto `unknown` o `dead` no tiene comando para inspeccionarlo (se ve con SQL en `adm_effects`).
- La política (etiqueta, asociaciones, allowlist) viene solo por flags de `fab resident`; no hay fichero de configuración. Cada decisión guarda el snapshot de la política que la produjo.
- No se prueba la suposición de que la etiqueta solo la ponen colaboradores.
- Sin `aidefence` ni escáner de inyección: el gate es independiente del texto por construcción, no por detección.

## Qué necesitará la fase 2

- **Estado `awaiting`.** Hoy `adm_effects.status` cubre `pending|running|done|dead|unknown`. `awaiting` es de la activity de la fab (D1), con una transición nueva en `Store`; la admisión solo debería observarlo mediante comandos del Store, nunca escribir en `activities` (R12).
- **Outbox.** Un efecto `reply` por mensaje con recibo: tabla `adm_outbox(message_id, channel, receipt, state)` y reconciliación remota antes de reenviar. Por R6, `reply` **no** es `rerunnable`: tras una caída hay que consultar al canal (¿existe ya el comentario?) antes de reenviar. El estado `unknown` y `recover()` ya están para eso; falta un hook `reconcile(payload, ctx)` por kind que decida entre `done` y `pending`.
- **Efectos `launch` / `deliver` / `stop`.** Encajan en `Effects` registrando handlers nuevos. Necesitan: el `attempt_id` del efecto propagado como id de intento del contrato vivo (`run`, `steer` idempotente por `requestId`); un `due_at` en el futuro para `Later` (reprogramar sin gastar intento, como en `effects.ts` de la referencia); y límites de concurrencia por kind (la referencia tiene `limit()`/`ordered`; aquí se ejecuta un efecto cada vez, en orden de `id`).
- **Encolado atómico con el estado de la fab.** Hoy el efecto se encola con el estado de `adm_*`. Para que una activity `awaiting` y su efecto `reply` compartan transacción, `Effects.enqueue` debe poder llamarse dentro de la tx de un comando del Store (funciona, porque `withRetry` es reentrante y `enqueue` solo exige `db.inTransaction`); falta el comando del Store que lo haga.
- **Gate en modo `auto`.** Hoy `auto` se rechaza. Añadirlo exige revalidar la política antes y después de cada permiso (D4) y un Mandate inmutable (fase 3).
- **Estado de salud y comando de inspección** de la cola (`dead`/`unknown`), y un `--since`/tope inicial del poller.

<!-- FIN -->
