# Reporte — opencode: verificación real de la ola 0 (D5, H2) y carreras multiproceso

Fecha: 2026-10-30 · Rama: `fab/research-ola0-e2e` (base `main@7783845`) · CLI: `bun src/cli.ts`, agente `fake`.
Scripts entregados en `scripts/e2e/` (sin tocar `src/`); todas las corridas y volcados en `/tmp/opencode-e2e/`.

## Instrumentos

| Script | Papel |
| --- | --- |
| `ola0-lib.sh` | Biblioteca compartida: entorno efímero (`FABRICA_HOME`), copia de `examples/toy-calc` en /tmp, helpers de dump y de espera. |
| `ola0-fake-shim.sh` | Shim `sh` instalado primero en el PATH del factory: controla la salida del fake (impone `STATUS`/`VERDICT`, o modo `RAW` sin veredicto), decide si deja archivos sin commitear en el cwd del agent y cuántos (`FAB_SHIM_DIRTY`, `FAB_SHIM_KEEP`, `FAB_SHIM_TAIL`) y loggea en TSV cada ejecución (`ts, note, pid, cwd, detalle`): `START`, `END`, `VREPORT`, `TOUCH_OK`, `TOUCH_FAIL`. |
| `ola0-dump-store.ts` | Volcado readonly del store (activities, events, changes, signals) en TSV con tiempos en ms de época. |
| `ola0-d5-hooks.sh` | Prueba D5 (hooks maliciosos + fsmonitor). |
| `ola0-h2-dirty-validator.sh` | Prueba H2 (validador ≠ qa que deja el worktree sucio). |
| `ola0-races.sh` | Carreras multiproceso n veces (D6/D7 + kill -9). |

La medición se hace desde afuera (shim + volcados del store y del shim log), nunca parcheando `src/`.

## 1 · D5 — git ejecuta hooks y fsmonitor del repo (corrección f9ab813)

**Preparación** (en el repo de la copia del change): `core.hooksPath` → dir con `post-checkout` y `pre-commit` que escriben un marcador con pid y marca de tiempo en `/tmp/.../d5-*/markers/`; `core.fsmonitor` → script que escribe otro marcador. Luego un ciclo `fab` completo con el fake (señal → triage → gates → investigación → implementación → validadores → merge).

**Comandos:** `bash scripts/e2e/ola0-d5-hooks.sh both` (dos variantes por objetivo: `a` validadores con VERDICT pass — merge directo —; `b` validadores `RAW` sin VERDICT que agotan 3 reintentos y el merge termina con `--force`, replicando el flujo de `runs/2026-10-30-ola0/resultado.md`). El objetivo `base` corre exactamente lo mismo contra `git worktree add --detach /tmp/opencode-e2e/fab-base-29d4dd3 29d4dd3` (main previo a la ola 0) con `node_modules` enlazado al worktree principal.

**Resultados** (`/tmp/opencode-e2e/ola0-e2e-resultados.tsv`, primera parte):

| Objetivo | Variante | Marcadores creados por git | Estado del change |
| --- | --- | --- | --- |
| ola0 (7783845) | a | **0** | completed |
| ola0 | b | **0** | completed |
| base (29d4dd3) | a | **4** | completed |
| base | b | **3** | completed |

Marcadores de la base (`d5-base-a/markers/`): `post-checkout` (1, con pid y hash de checkout) y `fsmonitor` (3, disparados por `git status --porcelain` del chequeo del pool). En la variante `b` de base el post-checkout coincide con el mismo checkout (3 en total). Con el agente fake no se produce ningún commit de fábrica, así que **el marcador de `pre-commit` nunca aparece: no es verificable con fake** (ver «Limitaciones»).

Resultado de los criterios de ambos objetivos: **PASA.** En ola0 ningún `git` del ciclo ejecutó hooks ni fsmonitor (`d5-ola0-*/markers/` vacíos) aunque los hooks maliciosos estaban efectivamente configurados; en 29d4dd3 los mismos comandos los ejecutaron (defecto reproducible).

## 2 · H2 — porcelain tras **todo** validador (corrección d43b031)

**Preparación:** ciclo `fab` hasta `implemented` y encolar un único validador (≠ qa): `code_review` y segunda pasada con `security_audit`. El shim escribe 6 archivos en el worktree del validador, responde un `VERDICT: pass` válido y queda a la vista del chequeo `git status --porcelain` del pool.

**Comandos:** `bash scripts/e2e/ola0-h2-dirty-validator.sh both` y `VALIDATOR=security_audit bash scripts/e2e/ola0-h2-dirty-validator.sh ola0`.

**Resultados** (`/tmp/opencode-e2e/ola0-e2e-resultados.tsv`, segunda parte):

| Objetivo | Validador | Última activity | Mensaje | Eventos "dejó cambios" | Archivos sucios en el worktree |
| --- | --- | --- | --- | --- | --- |
| ola0 | code_review | `failed` (3 reintentos) | «code_review dejó cambios en el worktree» | 3 | 6 |
| ola0 | security_audit | `failed` (3 reintentos) | «security_audit dejó cambios en el worktree» | 3 | 6 |
| base (29d4dd3) | code_review | `completed / approved` | — | 0 | 2 |

Criterio ola0: **PASA** — la activity del validador falla con exactamente `<validador> dejó cambios en el worktree` y el change no avanza; los 3 reintentos repiten el mismo mensaje. Criterio base (contraste): **PASA (repro)** — el mismo validador terminó `completed/approved` con el worktree sucio, tal como documenta el defecto: el chequeo estaba restringido a `a.validator === 'qa'`.

## 3 · Carreras multiproceso (línea base ola 1, ficha 07 — D6/D7)

**Comandos:** `bash scripts/e2e/ola0-races.sh 10` → 10 corridas en `/tmp/opencode-e2e/races/run-1..10`, cuyo detalle (`resumen.tsv`, los pares solapados en `run-*/pares.txt`, el shim log y el `.out` de cada pool) muestra:

1. **Fase A**: dos `fab run <ws> --once` simultáneos sobre el mismo store, 2 changes, fake lento (`FAB_SHIM_DELAY=2`).
2. **Fase B**: segunda ronda con los 2 validadores de un change en paralelo + otro pool a +0.6 s (requeue deliberado) + `fab reject` a +3.0 s (mientras los validadores siguen en curso).
3. **Fase C**: `fab triage` de una 3.ª señal, `fab run --once` y `kill -9` del pool mientras su investigación está `in_progress`; después un pool de recuperación y medición de latencias.

### Cifras (n=10, media min–máx)

| Métrica | Min | Media | Máx | Lectura |
| --- | --- | --- | --- | --- |
| activities reclamadas por ≥2 workers distintos (por corrida) | 3 | **3.8** | 5 | mismas activities pasan in_progress dos o más veces |
| errores «is not held by» (conflicto de custodia, por corrida) | 3 | **3.4** | 5 | workers pierden el claim y siguen avanzando la activity |
| pares de ejecuciones solapadas en el **mismo** worktree (por corrida) | 6 | **6.0** | 6 | **todos** fueron pares validator↔validator → D6 |
| completaciones de validador **después** del `fab reject` | 2 | **2.0** | 2 | la activity sigue viva tras cancelar el change → D7 |
| intentos de escritura del validador **detrás** del worktree borrado | 4 | **4.2** | 6 | todos `TOUCH_FAIL` (0 ok): el fake sigue escribiendo en un cwd ya inexistente |
| requeues deliberados de fase B (`requeued 2 orphaned`) | 2 | 2.0 | 2 | reproductible |
| requeues tras `kill -9` (`requeued 1 orphaned`) | 1 | 1.0 | 1 | un solo huérfano por corrida |
| latencia del primer claim de la activity huérfana | 567 ms | **574 ms** | 584 ms | el pool siguiente se la queda casi al instante |
| latencia hasta change `implemented` tras el kill | 4624 ms | **4638 ms** | 4652 ms | investigación + implementación completas |
| huérfano detectado (`in_progress` tras kill) | «sí» en **10/10** | — | — | la activity queda a medias en el store |
| activity 3 al final | `completed` en **10/10** | — | — | el requeueOrphans la recupera siempre |
| crash «SQLiteError: database is locked (SQLITE_BUSY)» | 1 | **1.0** | 1 | ver hallazgo aparte |

**Detalle clave D6:** en las 10 corridas los 6 pares solapados por corrida (60 en total, ver `races/run-*/pares.txt`) fueron de **dos validadores sobre el mismo worktree (`worktrees/<changeId>`)**, con pids y cwd distintos, ejecutándose de forma temporalmente solapada (más los 3-5 errores «is not held by» de custodia al completarse). Es exactamente el patrón de `store.ts:444-465` + `worktrees.ts:19-24`.

**Detalle clave D7:** tras `fab reject` del change (worktree `worktrees/a3b20d0a` eliminado, verificado), cada validador en curso completó (2 por corrida) e intentó escribir 4-6 veces en su cwd ya borrado (en run 1: `TOUCH_FAIL … /home/worktrees/a3b20d0a/.e2e-shim-<pid>`). Es un doble escritor-escritor post-cancelación, no solo un evento aislado.

**Hallazgo adicional (no previsto en la ficha):** en cada una de las 10 corridas, uno de los dos pools paralelos de la fase A (3 en `a1.out`, 7 en `a2.out`) murió con:

```
SQLiteError: database is locked
      errno: 5, code: "SQLITE_BUSY"
      at #run (bun:sqlite) at <anonymous> (src/store.ts:442:10)
      at transaction … at runPool (src/pool.ts:112:29) at main (src/cli.ts:211:15)
```

pese a que el store abre con `busy_timeout=5000`. El pool crashea con las activities en `in_progress` y las retoma el siguiente pool vía `requeueOrphans`. Esto es un segundo defecto de concurrencia en el mismo punto (`claimActivity`, `store.ts:442`) y debería entrar en la ficha 07.

**Veredicto de esta prueba:** los objetivos de medición se cumplen (cifras arriba n=10); los defectos D6 y D7 son reproducibles en el 10/10 de las corridas. No se arregló nada de `src/`.

## Recopilación de corridas y reproducibilidad

```bash
# D5 (hooks maliciosos)
bash scripts/e2e/ola0-d5-hooks.sh both
# H2 (validador ≠ qa con worktree sucio)
bash scripts/e2e/ola0-h2-dirty-validator.sh both
# Carreras n=10
bash scripts/e2e/ola0-races.sh 10
# Volcados del store (readonly)
bun scripts/e2e/ola0-dump-store.ts <FABRICA_HOME> activities|events|changes|signals
```

Volcados y evidencias completas: `/tmp/opencode-e2e/{d5-*,h2-*,races,races-stdout.log}` y `/tmp/opencode-e2e/ola0-e2e-resultados.tsv` (resumen de D5/H2 que escriben los scripts).

## Limitaciones / lo que no se puede probar aquí

1. **`pre-commit` con fake:** el agente `fake` nunca hace commits de fábrica, así que ningún ciclo de este reporte llega al `git commit` dentro de un worktree de fab; el hook `pre-commit` quedó instalado y verificado fuera de fab (`git commit` en el repo copia lo ejecuta), pero el marcador correspondiente no aparece en el ciclo probado. El defecto D5 queda demostrado con `post-checkout` (durante el `worktree add`) y `fsmonitor` (durante `git status --porcelain` del pool).
2. **Gravedad del `TOUCH_FAIL`:** distinguir si el shim `TOUCH_FAIL` con write fallando en cwd borrado es benigno a la vez que severo queda fuera de alcance de este reporte; lo que se mide es que el agente continúa ejecutándose tras el `fab reject` (D7).
3. **`SQLITE_BUSY`:** se registró como hallazgo; su gravedad completa necesitaría fijar la frecuencia exacta bajo cargas más agresivas (número de workers, tamaño del store). Aquí basta la reproducibilidad 10/10.
4. **Carreras con adaptadores claude/agy/droid reales:** las cifras de escritores simultáneos sobre el mismo worktree son con el fake (que escribe archivos en el cwd). Con adaptadores reales hay riesgo de conflicto de contenido (no solo de Execution/CWD), fuera de alcance para esta prueba.

## Conclusión

- **D5 (ola 0): PASA** — 0 marcadores en 7783845 vs 4/3 marcadores en 29d4dd3.
- **H2 (ola 0): PASA** — los validadores ≠ qa quedan `failed` con «dejó cambios en el worktree» y 3 reintentos; en la base el mismo caso acababa `completed/approved` (defecto visible).
- **D6/D7: MEDIDOS, presentes (10/10):** 6 pares de dos validadores solapados en el mismo worktree por corrida, 3.4 conflictos de custodia de media, 2 completaciones post-reject y 4.2 intentos de escritura al worktree borrado; recuperación tras `kill -9` fiable (first-claim ~574 ms, change listo ~4.6 s) y un crash adicional de SQLITE_BUSY en `claimActivity` (1 por corrida) que la ficha 07 debería heredar.
