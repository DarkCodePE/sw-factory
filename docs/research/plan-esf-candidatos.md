# Plan de implementación — candidatos ESF → fab

Versión v0.3 (2026-10-30). fab base `29d4dd3` (`main`), ESF `d901657`.
Historia: v0.1 desde el análisis; v0.2 tras leer a fondo `tui.ts`,
`agents.ts`, router, omni, `mission*.ts`, `store.ts`; v0.3 consolida la
revisión goldfish de codex (concurrencia), agy (seguridad) y opencode
(medición y experiencia). v0.2 queda en `runs/2026-10-30-plan-esf/plan-v0.2.md`;
la trazabilidad de cada cambio en `runs/2026-10-30-plan-esf/meta.md`.

**Ola 0: hecha** en `integ/ola0` (`5d57ae0`), 762 tests en verde; ver `runs/2026-10-30-ola0/resultado.md`. Fusionada en `main` local (`7783845`, sin push), 762 tests en verde. **Ola 1: hecha** y fusionada en `main` local (`0db0893`, sin push), 805 tests en verde; ver `runs/2026-10-30-ola1/resultado.md`. **Ola 2: hecha** en PR #29 (`80b7085`, 841 tests) y cierre en PR #30 (threatmon 0/40 falsos positivos, sonda 08 en `run.json`, 861 tests); ver `runs/2026-10-30-ola2/resultado.md`. **Ola 3:** PR #31 (gates `--verify`, fase de dependencias, coste −37 %; banco difícil en curso). **Ola 4:** PR #33 (perfiles por digest, experimentos pareados; 892 tests). Banco difícil de la ola 3 en PR #32.

Estado de cada candidato: `propuesto` hasta que Orlando lo pase a
`experimento_autorizado`. Medir antes de integrar.

## 1. Lo que cambió respecto a v0.1 y por qué

**Hechos del código (todos verificados con línea por al menos dos revisores):**

| # | Hecho | Efecto |
| --- | --- | --- |
| H1 | Los workers del pool no corren en el bwrap de fab: `runAgent` hace `Bun.spawn` del CLI (`agents.ts:130-154`). codex usa su sandbox, claude una allowlist, agy `--dangerously-skip-permissions`, droid `--auto medium`. | 08 solo aplica a `native`. Sube 03. Entra `agents-verify`. |
| H2 | `readOnly` solo lo respetan codex y native (`agents.ts:51-53,107`). | Integridad y `porcelain` tras **cada** validador. |
| H3 | Sin `STATUS` el reporte cuenta como bloqueado y se reintenta: 3 sesiones en total (`prompts.ts:82-86`, `store.ts:563-582`). | 06 distingue bloqueo declarado de reporte malformado. |
| H4 | Decisión y evento ya son atómicos (`store.ts:592-619`). TUI `d` rechaza sin motivo (`tui.ts:190-195`). | 09 queda como corrección de producto. |
| H5 | `runAgent` no acepta señal de aborto (`agents.ts:130-145`). | 07 necesita aborto y grupo de procesos. |
| H6 | Las misiones protegen **rutas literales** por digest; un archivo protegido ausente se registra `deleted` y su aparición posterior **sí** cambia el digest (`mission-files.ts:81-89`, `mission.ts:293-325`). | v0.2 lo leyó mal ("archivos nuevos no cuentan"). 02 trata altas y bajas bajo rutas protegidas como manipulación. |
| H7 | fab no ve tokens de los CLIs (`agents.ts:6-11`). | 10 diferido. |
| H8 | `runVerifier` usa copia desechable, dependencias read-only, entorno filtrado, red denegada (`mission-evidence.ts:117-160`). | 01 conserva **todas** esas garantías. |
| H9 | `events` sin actor (`store.ts:113-115`). | Columna `actor`. |

**Defectos actuales de fab que la revisión destapó (independientes del plan):**

| # | Defecto | Prueba |
| --- | --- | --- |
| D1 | `INSERT INTO workstreams VALUES (...)` es posicional (`store.ts:226`): la primera columna nueva rompe `createWorkstream`. | codex lo reprodujo en SQLite; confirmado leyendo la línea. |
| D2 | Un validador que agota reintentos queda `failed` sin veredicto; `mergeBlocker` solo mira `pending` y `fail` (`validators/publish.ts:29-33`, `store.ts:481-498`): **el merge queda abierto**. | codex lo reprodujo con Store en memoria; confirmado leyendo `validationSummary`. |
| D3 | `boundedAgentOutput` antepone `STATUS: blocked - report has no STATUS line` a salidas largas (`agents.ts:121-128`): un reporte malformado se vuelve bloqueo "declarado". | Reproducido por codex, opencode y por mí (`parseReportStatus` devuelve `blocked - report has no STATUS line`). |
| D4 | `retryChange` copia el `kind` de la última activity pero no su `validator` (`store.ts:634-644`): reintentar un QA crea un `change_review` ordinario. | codex lo reprodujo. |
| D5 | `worktrees.ts` ejecuta `git` sin `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, a diferencia de `mission-files.ts:17` y `tasks.ts:131`: un worker sin confinar puede instalar un hook que fab ejecutará. | agy; patrón ya existente en el repo. |
| D6 | Los validadores de un mismo change se reclaman a la vez sobre el **mismo** worktree (`store.ts:444-465`, `worktrees.ts:19-24`), y con claude/agy/droid todos pueden escribir. | codex. |
| D7 | `fab reject` borra el worktree antes de cancelar y no detiene activities en curso; claim y requeue ignoran el estado del change (`cli.ts:260-263`, `store.ts:418,653`). | codex. |
| D8 | La migración `PRAGMA table_info` + `ALTER` (`store.ts:207-209`) no es segura con dos procesos abriendo a la vez. | codex. |

## 2. Reglas de ejecución

- Cada tarea la implementa codex o agy en su worktree `fab/research-<id>` con
  contrato `task-<id>.md`. Claude coordina, valida (`bun test`, `tsc --noEmit`,
  fab real sobre `examples/toy-calc`) e integra. Un escritor por worktree.
- Sin servicios ni dependencias nuevas.
- Esquema: helper único `addColumn(table, col, ddl)` que tolera
  "duplicate column" (D8); `INSERT` con columnas nombradas (D1) **antes** de
  añadir ninguna.
- Licencia: ESF MIT; citar `ext/esf/<archivo>@d901657` en el commit.
- Medición: `fake` para lo determinista. Para carreras y aborto, un fake
  lento (adaptador de test con script que duerme, patrón ya usado en los
  tests) y reloj inyectado; nunca timing incidental. LLM real solo en 01 y 05,
  con autorización y presupuesto explícitos.
- Cada tarea lista los tests existentes que cambia (tabla §5).

## 3. Olas

| Ola | Contenido | Esfuerzo | LLM |
| --- | --- | --- | --- |
| 0 | Correcciones previas D1, D2, D3, D4, D5, porcelain tras todo validador, `addColumn` | S×6 | no |
| 1 | 06 BLOCKED · 02 integridad · 09 actor y motivo · 07 exclusión por change + leases | S, M, S, M | no |
| 2 | 04 manifest · 03 threatmon · agents-verify · 08 sonda (`native`) · F1 SQLITE_BUSY · F2 base_sha · F3 pre-commit | M, M, S, S, M, S, S | no |
| 3 | 01 verificación determinista | M | sí |
| 4 | 05 perfiles inmutables | L | sí |
| — | 10 reserva de presupuesto | diferido (H7) | — |

```
ola 0 ──► 06 ──► 02 ──┐
          09 ─────────┼──► 04 ──► 03 ──► 01 ──► 05
          07 ─────────┘     ├──► agents-verify
                            └──► 08 (native)
```

### Ola 2 — hallazgos de las olas 0 y 1 añadidos y reparto por complejidad

Hallazgos nuevos (`runs/2026-10-30-ola1/resultado.md`):
- **F1 · SQLITE_BUSY bajo contención (C7) — M.** Con dos pools, ~0,3 por
  corrida: la activity falla con `database is locked` y consume un
  reintento. Un error de infraestructura no debe gastar el presupuesto del
  agente ni dejar un estado a medias. Medición: `scripts/e2e/ola0-races.sh 10`
  → 0 `database is locked` y 0 reclamaciones repetidas.
- **F2 · `base_sha` de changes anteriores a la migración (C6) — S.** Hoy toman
  el HEAD actual del worktree, que ya puede incluir commits del agente.
  Usar `git merge-base <rama base> fab/<id>` cuando `base_sha` es NULL y la
  rama ya existe.
- **F3 · `pre-commit` de D5 sin verificar (C8) — S.** El fake no genera commit
  de fábrica; falta una prueba e2e con un commit real del pool.

| Complejidad | Tareas | Agente |
| --- | --- | --- |
| Alta | 04 manifest + merge recuperable | codex (relevo: Claude Code Sonnet) |
| Media | F1 SQLITE_BUSY · 03 threatmon · 08 sonda `native` | agy |
| Baja | agents-verify · F2 · F3 | opencode |

03 se implementa ahora; su medición de falsos positivos sobre ≥30 logs se
hace cuando 04 esté integrado (necesita los logs completos que guarda 04).

## 4. Fichas

### Ola 0 — correcciones previas (sin experimento; cada una con su test)
- **D1** `createWorkstream` con columnas nombradas. Test: base nueva y base
  del esquema anterior con una columna extra.
- **D2** `mergeBlocker` bloquea si algún validador terminó sin veredicto
  (`failed`, y en el futuro `blocked`/`quarantined`). Test: QA agotado →
  merge bloqueado; hoy pasa.
- **D3** clasificar `STATUS` sobre la salida completa **antes** de truncar;
  `AgentRun` lleva `status: 'done' | 'blocked' | 'missing'` y la razón.
  Test: 24 000 caracteres sin STATUS → `missing`, no `blocked`.
- **D4** `retryChange` copia `validator` y reintenta la activity que falló,
  no "la última". Test: reintentar QA crea QA.
- **D5** todas las llamadas de `worktrees.ts` usan `git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c diff.external=` como `mission-files.ts:17`.
- `porcelain` tras cada validador (quitar la condición `a.validator === 'qa'`, `pool.ts:65`).

### 06 · BLOCKED terminal (C2/C4b) — S
- Solo `status: 'blocked'` declarado por el agente (D3) es terminal; `missing`
  sigue reintentándose.
- Estado `blocked` en activity y change. **Contrato humano único:** aparece en
  `fab inbox` con la razón completa (hoy `inbox` solo lista
  `review_status = 'awaiting'`, `store.ts:407-408`); se resuelve con
  `fab retry <changeId>` (ya existe, `cli.ts:254-256`) o `fab reject
  <changeId>`. La TUI añade color y permite `r` sobre `blocked`.
- El bloqueo se evalúa **después** de integridad (02) y threatmon (03): un
  agente no puede usarlo para esconder una manipulación. Mientras 03 no
  exista, solo después de 02.
- Un validador `blocked` cuenta como impedimento de merge (D2).
- Tests a actualizar: `pool.test.ts:43-57`, `worktrees.test.ts:130-158`,
  `tui.test.ts:72-74`. Medición con fake (`FABRICA_FAKE_STATUS='blocked - x'`):
  1 sesión en vez de 3.

### 02 · Integridad de rutas protegidas (C6) — M (era S)
- Columna `protected_paths` (globs) en workstreams, con **lista por defecto**
  que el operador puede ampliar pero no vaciar sin `--protect-none`:
  `tests/**`, `test/**`, `**/*.test.*`, `**/*.spec.*`, `package.json`,
  `bun.lock`, `bunfig.toml`, `tsconfig*.json`, `*vitest*`, `*jest*`,
  `pyproject.toml`, `pytest.ini`, `setup.cfg`, `conftest.py`, `Makefile`,
  `.github/**`, `.gitattributes`, `.gitmodules`.
- Línea base: el **SHA base se guarda en el change** al crear el worktree, no
  se recalcula en reintentos (`base_sha`).
- Comprobación: para cada archivo que case en la base **o** en el disco **o**
  en `HEAD` de la rama: comparar blob base con disco y con `HEAD`. Alta,
  baja, modificación o cambio solo en commit = manipulación. Symlinks se
  comparan como enlace, sin seguirlos.
- Cuándo: tras implementación y tras cada validador (H2).
- Resultado: change `blocked` con razón `GATE_TAMPERED: <rutas>`.
  **Salida explícita:** `fab gate allow <changeId> <ruta…> --comment <motivo>`
  registra evento con actor (09), re-basa esas rutas y reencola; `fab retry`
  sin `allow` vuelve a bloquear. Las validaciones anteriores del change se
  invalidan.
- Tests: 6 manipulaciones (editar test, borrar assert, añadir `conftest.py`,
  cambiar `bunfig.toml`, test modificado solo en commit con disco
  restaurado, symlink) → 6 detectadas; 10 changes limpios → 0; `gate allow`
  auditado → pasa.

### 09 · Actor y motivo en decisiones (C3) — S, sin experimento
- `addColumn('events','actor','TEXT')`; actor = `$FAB_ACTOR ?? os.userInfo().username`.
- `decline` exige comentario en CLI y TUI; la TUI necesita un flag de modo
  para la etiqueta "motivo" (`tui.ts:146` es fija).
- También auditan con actor `fab merge --force`, `fab reject` y
  `fab gate allow`, que son las salidas que saltan los controles.

### 07 · Exclusión por change y leases (C2) — M
- **Exclusión por change (D6):** `claimActivity` no reclama una activity si
  su change tiene otra `in_progress`. Un escritor por worktree. Coste: los
  validadores de un change pasan a ser secuenciales.
- **Barrera de estado (D7):** claim, heartbeat y `completeActivity` rechazan
  si el change está en estado terminal; `fab reject` cancela primero y espera
  a que el worker suelte la activity antes de borrar el worktree.
- **Lease:** `lease_expires_at` (TTL 90 s, heartbeat 30 s); `requeueOrphans`
  solo reencola vencidos y corre en cada vuelta del bucle.
- **Aborto real:** `runAgent(..., { signal })` lanza el CLI como líder de
  grupo de procesos (`detached`) y al abortar mata el grupo entero; el lease
  no se considera libre hasta confirmar la salida del proceso.
- **Migración (D8 y leases NULL):** al añadir la columna, las activities
  `in_progress` reciben `now + TTL`; nota de actualización: parar pools
  antiguos antes de actualizar.
- Tests: fake lento + reloj inyectado. Dos pools, uno muere → 0 duplicados y
  recuperación ≤ 180 s; `reject` durante implementación → change cancelado
  y sin escrituras posteriores; `--once` no sale antes de que venza un lease.
  Actualizar `store.test.ts:151-157`.

### 04 · Manifest por change (C6) — M
- `runs/<changeId>/run.json` escrito en **cada** transición terminal:
  completed, failed, blocked, quarantined, canceled.
- Contenido: base sha, rama y HEAD, activities con validador, veredicto,
  reintentos y razón; `isolation` por adaptador (H1); duración; **salida
  completa** de cada activity en `runs/<changeId>/<activityId>.log` (hoy
  `result` se corta a 20 000 caracteres); `cleanup`.
- Merge en fases recuperables: evento `merge_started` antes de `git merge`;
  si el proceso cae, el siguiente `fab merge` detecta la rama ya fusionada y
  completa cleanup y manifest. Exclusión con el mismo mecanismo de 07.
- Redacción de secretos al escribir (8 patrones). Tests: un manifest por cada
  transición terminal; crash simulado entre merge y cierre; 0 secretos.

### 03 · Monitor de comportamiento (C5) — M
- Entrada: stdout **y** stderr completos antes de truncar (D3), más el diff
  de la rama incluido lo no rastreado (`git status --porcelain -uall`).
- Reglas reimplementadas en TS citando `internal/threatmon/rules.go@d901657`.
  Hallazgo ≥ `high` → change `quarantined` antes de validar; es impedimento
  de merge (D2).
- Límite declarado: es post-hoc; no evita efectos ya ocurridos en el host con
  agy. La mitigación real de H1 es envolver los CLIs, fuera de este plan.
- Medición: falsos positivos sobre ≥ 30 logs completos guardados por 04 (por
  eso va después); detección sobre 10 transcripciones adversas.

### agents-verify (C8) — S (nuevo)
- `fab agents verify` y comprobación al arrancar el pool: sha256 de los
  binarios `claude`, `codex`, `agy`, `droid` contra un pin en settings
  (idea de `cmd/factory/release.go:171,226-265@d901657`). Si no coincide,
  el pool no arranca salvo `--accept-agent-binaries`.
- Es la mitigación más barata para H1 mientras los CLIs no estén envueltos.

### 08 · Sonda de egress (C5) — S, solo `native`
- Antes de la primera herramienta de red del motor `native`, sonda dentro del
  mismo `wrapCommand` con control positivo; `{reachable, decided}` al
  manifest. Los demás adaptadores solo registran su postura (04).

### 01 · Verificación determinista (C6) — M
- Solo si el workstream declara `--verify` (los tests de 3 validadores no
  cambian).
- `runVerifierAt(cwd, argv, signal)` conserva **todo** lo de
  `mission-evidence.ts:117-160`: copia desechable, dependencias read-only,
  entorno filtrado, red denegada. Instalar dependencias es una fase previa
  separada con política propia, nunca dentro de los gates.
- `gates` no es un validador LLM: tiene rama propia en `processActivity`
  (hoy `buildValidatorPrompt` lanza con tipos desconocidos,
  `validators/prompts.ts:68-69`). Los validadores LLM se encolan **cuando
  `gates` termina en pass** sobre el mismo HEAD, no por orden FIFO.
- Veredicto: todos los pasos obligatorios con exit 0 sin timeout; paso no
  ejecutable = fail; se corren todos; salida al manifest.
- Medición: 10 bugs plantados en toy-calc + 5 en tarea real; baseline QA LLM;
  ratio de sensibilidad ≥ 1.2, coste ≤ 1.0. ~30 USD con autorización.

### 05 · Perfiles inmutables (C4b) — L
- Sin cambios respecto a v0.2: perfil por digest, `fab profile import/inspect`,
  `fab improve --experiment-id` sin cualificación ni rollout. Se mantiene en
  la ola 4; las recetas de 01-03 se identifican por sha de fab, que basta
  mientras no cambie el prompt.

### 10 · Reserva de presupuesto — diferido
- No aplica al pool (H7). Reabrir cuando `native` sea el adaptador habitual,
  extendiendo `reserveCalls` (`tasks.ts:36`) de llamadas a coste.

## 5. Tests existentes que cambian

| Test | Por qué | Tarea |
| --- | --- | --- |
| `tests/pool.test.ts:43-57` | espera `failed` y 3 intentos ante blocked | 06 |
| `tests/worktrees.test.ts:130-158` | mismo escenario y retry de failed | 06 |
| `tests/tui.test.ts:72-74` | mensaje de retry solo para failed | 06 |
| `tests/store.test.ts:151-157` | espera reencolar todo `in_progress` | 07 |
| `tests/validators-pool.test.ts` | validadores pasan a secuenciales por change | 07 |

## 6. Fuera de alcance

- Envolver los CLIs en bwrap con allowlist de red hacia su API (la
  mitigación de fondo de H1): requiere un proxy de egress; candidato propio
  en una ronda futura.
- Cualificación, rollout y rollback de perfiles (fase 2 de 05).
- Consola web, turnos remotos, notificaciones.
