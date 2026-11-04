# Reporte ola 4 — 05 perfiles inmutables por digest (fase 1)

Rama `fab/research-ola4` (worktree `sw-factory-ola4`), base `main@c553143`. Alcance: fase 1; sin cualificación estadística, rollout ni rollback.

## Decisiones (ambigüedades resueltas con lo mínimo correcto)

- **Perfil**: `{schemaVersion:1, harness, model?, repo?, worker:{rules,investigate,implement}, validators:{rules,code_review,security_audit,qa}}`. `rules` son las reglas compartidas (`SHARED_RULES`/`VALIDATOR_RULES`). La variante "factory commits" del prompt de implementación se deriva en runtime sustituyendo la línea de commit de `implement`; por eso el import exige que `implement` conserve esa línea.
- **Validación al importar**: claves desconocidas rechazadas, plantillas no vacías ≤32 KB, `harness` ∈ adaptadores conocidos, `worker.rules` con `STATUS:` y `validators.rules` con `STATUS:`+`VERDICT:` (sin ellas el pool no puede leer el resultado).
- **`harness`/`model`/`repo` son identidad, no se imponen** al workstream (el perfil por defecto debe servir con cualquier `--agent`). Fase 2 podría imponerlos.
- **Digest** = sha256 del JSON canónico (claves ordenadas, sin espacios, `undefined` omitido). Archivo `<stateDir>/profiles/<digest>.json` (0444, `wx`+rename); cada carga re-verifica que el contenido produce el digest.
- El perfil por defecto se guarda como `null` en la columna `workstreams.profile`; su digest es `DEFAULT_DIGEST`.
- **Sha de fab**: `FAB_SHA` si está, si no `git rev-parse HEAD` del checkout del código; `null` en binarios sin git.
- Trazabilidad: columnas `activities.profile_digest`, `activities.fab_sha` (se fijan al arrancar la activity); `run.json` lleva `profile` y `fabSha` a nivel raíz y por activity.

## Progreso
- [x] Perfil, digest, store por contenido, precondición byte a byte (fixture generado con el código de `main@c553143`), `--profile`, trazabilidad: commits `feat(profile)` y `feat(cli)`. `bun test`: 889 pass (883 + 6), `tsc` limpio.
- [x] Experimentos: `src/improve.ts` + `src/improve-cli.ts` (commit `feat(improve)`). Tablas `experiments`, `experiment_ids` (id quemado, nunca se borra), `experiment_runs` en la base de fab. Suite congelada (JSON canónico + digest) con splits; `run` clona el repo en el commit base dentro de `<stateDir>/improve/<id>/...` con store y workstream propios (desechable), orden pareado aleatorio con semilla (mulberry32) registrada por corrida. Éxito = comando de verificación (argv, sin shell, 300 s) ejecutado en el worktree tras el agente; diff = líneas añadidas+borradas vs el commit base; duración = pared del agente (investigación + implementación).
- [x] E2E con `fab` real y agente `fake`: export → import (idempotente: "ya existía") → `ws create --profile` (digest desconocido rechazado) → signal/triage → run → `run.json` con `profile`, `fabSha` y `profileDigest` por activity.
- Decisión: `improve run` usa `--agent native` por defecto (el de `ws create`); `improve delete` existe solo para que "ID no reutilizable aunque se borre" sea comprobable.
- Límite conocido: el agente podría tocar el comando de verificación si estuviera dentro del repo; en la medición las comprobaciones viven fuera del repo (`~/.cache/fab-ola4/checks`). No se mide coste en USD (suscripción): la guardiana de coste se aproxima con la duración.
- [x] `bun test`: **892 pass, 0 fail** (base 883 + 9 nuevos); `bunx tsc --noEmit` limpio.

## Medición con LLM real (CLI de suscripción `claude`, sin coste de API)

- Repo: copia de `examples/toy-calc` en `~/.cache/fab-ola4/toy-calc` (base `30c71e9`). Experimento `ola4-toycalc-b` (el primero, `ola4-toycalc`, se borró para fijar `harness: native` en el candidato; su id queda quemado, comprobando la regla). Estado en `~/.cache/fab-ola4/home`.
- Suite (3 tareas, todas en split `development`): `average-bug` (bug plantado), `add-median`, `add-clamp`. El comando de verificación es un script oculto en `~/.cache/fab-ola4/checks/` fuera del repo.
- Brazos: baseline = perfil por defecto (`2dff534e…`); candidato = `24f6c173…`, que **solo** cambia el paso 3 de `worker.implement`: "Run the test suite BEFORE you finish. If anything fails, fix it and run it again until it passes; do not report STATUS: done while a test fails…".
- Duración medida con 1 repetición (6 corridas, 5 min, ≈50 s/corrida) → se hicieron **10 pareadas por tarea** (1 rep semilla 4 + 9 reps semilla 5; 60 corridas en total, orden aleatorio por pareja).

`fab improve report ola4-toycalc-b`:

| split | brazo | n | éxito | var(éxito) | var(diff) | diff medio | duración media s |
|---|---|---|---|---|---|---|---|
| development | baseline | 30 | 1.000 | 0.000 | 156.3 | 28.0 | 56.2 |
| development | candidate | 30 | 1.000 | 0.000 | 173.9 | 28.9 | 56.6 |

Varianza del tamaño de diff por tarea (baseline / candidato): average-bug 1.6 / 0.0; add-median 28.3 / 8.3; add-clamp 4.4 / 15.6. (La varianza agregada de la tabla mezcla la diferencia entre tareas; la comparación válida es por tarea.)

**Lectura (honesta):** guardianas cumplidas (éxito 100 % en ambos brazos; duración 56.6 vs 56.2 s, sin diferencia). La métrica primaria (ratio de varianza ≤ 0.8) **no se demuestra**: el ratio agregado es 1.11 y por tarea es mixto (0.0, 0.29, 3.5). Con éxito 30/30 en ambos brazos no hay señal en la varianza del éxito (techo: las tareas son fáciles para `claude`), y 10 pareadas por tarea son pocas para varianzas. Conclusión: la infraestructura mide y reproduce; este candidato no mejora ni empeora de forma detectable en esta suite. No es evidencia de cualificación (todo en `development`, sin validation/qualification, sin pruebas estadísticas: fase 2). Coste en USD no medido (suscripción): duración como proxy.

## Fuera de alcance / pendiente
- Cualificación estadística, rollout, rollback, aprobación con revisor ≠ autor: fase 2.
- `harness`/`model`/`repo` del perfil no se imponen al workstream.
- Sin merge ni push; commits: `feat(profile)`, `feat(cli)`, `feat(improve)` (sin `Co-Authored-By`).
