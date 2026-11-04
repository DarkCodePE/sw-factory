# ADR-0004: Evaluación no es promoción; tiers con poder de decisión distinto

Estado: propuesto (v0.2) · Fecha: 2026-10-31 · Capa principal: C6 · Afectadas: C3, C4b

## Contexto
ESF (`internal/harnessprofile/qualification.go`): ≥100 tareas, ×3, ≥10 clusters, coste conocido por corrida (`:97`), topes ×1.2/×5 (`:160-164`), bootstrap 10 000 con semilla fija, ganancia ≥ 5 pp y percentil 2.5 > 0 (cota inferior de un IC bilateral del 95 %, `:217-219`). En fab, `improve.ts` no captura coste (`ArmResult`, `:107`), no llama a `integrity.ts`, `SuiteTask` no tiene `group` (`:14`), no tiene `repeated-baseline` y solo compara **perfiles**, no builds de fab. `bench/ola3` tiene 20 casos en 2 clusters y mide validadores. Exigir T2 para todo paraliza el sistema (agy); portar ESF sin coste falla siempre (Fable).

## Decisión
- **T0** humo: solo `REJECT` por guardiana determinista.
- **T1** filtro con la receta §3 del diseño (n_runs ≥ 10 pareadas, IQR): `INCONCLUSIVE(filtrado)` o `ACCEPT-candidato`. **T1 no emite `REJECT`** salvo guardiana.
- **T2** cualificación con la regla de ESF portada a TS (adaptar citando origen): `ACCEPT-cualificado` o `REJECT`.
- `ACCEPT-candidato` se integra con flag **apagado por defecto** y registro `candidato` con gates pendientes. Solo `ACCEPT-cualificado` puede activar por defecto.
- Prerrequisitos, en orden: (1) coste en tokens/USD por corrida en `runArm` y en el store; (2) `integrity.ts` en `runArm`; (3) `group` en `SuiteTask`; (4) `repeated-baseline`; (5) runner de dos builds de fab. Hasta (5), solo ideas de perfil/prompt/skill.
- Medir el coste medio por corrida antes de fijar el tamaño de T2 (≈ 600 corridas por cualificación).

## Consecuencias
+ El sistema puede integrar ideas pronto sin afirmar mejoras no probadas.
− T2 sigue siendo la pieza más cara; sin ella nada se activa por defecto.
