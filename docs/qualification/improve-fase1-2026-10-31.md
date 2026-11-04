# improve-fase1: experimentos de mejora de perfiles

Estado: candidato
Fecha: 2026-10-31 · base_sha: `2bed96f` · Pin: `third_party/esf/UPSTREAM.json` (mitkox/esf@d901657, MIT, solo la idea, reimplementado)
Código: `src/improve.ts`, `src/profile.ts` · Evidencia: `evidence/improve-fase1-2026-10-31/`

## Qué es
Fase 1 de la cualificación de ESF (`internal/harnessprofile/qualification.go`): suite congelada con splits development/validation/qualification, corridas pareadas con semilla registrada e informe. No promueve ni revierte perfiles.

## Medido
- `bun test tests/improve.test.ts tests/profile.test.ts`: 11 pass y 0 fail (`run.json`). Cubre los ids no reutilizables, las corridas pareadas con agente fake y semilla, la varianza muestral, la suma de coste por brazo (`armCost`) y la migración de `cost_usd`.

## No medido
- Ningún experimento real con agentes. Este registro no afirma que improve.ts mejore nada; solo que la herramienta se comporta como dicen sus tests.

## Gates pendientes
Son prerrequisitos de los tiers T1/T2 (ADR-0004):
- [x] Coste por corrida en `runArm` (2026-10-31). `ArmResult.costUsd` y `experiment_runs.cost_usd` suman el `usage.costUsd` que el pool registra por activity. Solo `claude` lo reporta (`--output-format json`, `total_cost_usd`; comprobado con el CLI 2.1.316). Con `codex`, `agy`, `droid`, `native` y `fake` queda **NULL, nunca 0**, y también es NULL si una activity se reintentó. Mientras un brazo tenga coste NULL, el gate ×1.2 da INCONCLUSIVE para ese agente.
- [x] Integrar `integrity.ts` en `runArm` (2026-11-03, política corregida el mismo día). `experiment_runs.integrity_ok` es solo un dato informativo: las rutas protegidas que el agente toca se restauran al commit base antes de `verify`, y `success` es el resultado de `verify`. Probado con el agente `fake` y con `restoreProtected` sobre un test debilitado; no con un agente real.
- [x] Campo `group` en `SuiteTask` (2026-11-03): opcional, se guarda en `experiment_runs.task_group` y sale en `--json`; el bootstrap por cluster sigue pendiente (fase 2).
- [x] Brazo repeated-baseline (2026-11-03): `fab improve create … --repeated-baseline`, brazo `baseline_rep` intercalado con la semilla.
- [ ] Runner que compare dos builds de fab, no solo dos perfiles.
- [ ] Fase 2: bootstrap pareado por cluster, Lower95 > 0, ≥ 100 tareas × 3 en ≥ 10 clusters.
