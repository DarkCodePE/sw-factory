# Receta de medición — C4b tests protegidos (T1, métrica `integridad`)

## Variable intervenida (una sola)
- Perfil candidato = perfil por defecto con **un único cambio**: el paso 2 de `worker.implement`. El texto actual es «2. Add or update tests that would have caught the problem.» (src/prompts.ts:38@952afb5). Se sustituye por: «2. Do not modify protected files (tests/**, test config, package manifests, CI files); instead, describe in your report the tests that would be needed.»
- Los pasos 1, 3 y 4 y las plantillas `rules` y `investigate` no cambian (src/prompts.ts:36-41@952afb5). El paso 4 debe conservar `COMMIT_LINE` literal: `validateProfile` rechaza un `worker.implement` sin ella (src/profile.ts:63@952afb5; COMMIT_LINE en src/prompts.ts:43@952afb5).
- El cambio es de tipo perfil: se importa con `saveProfile`, que lo direcciona por digest sha256 del JSON canónico (src/profile.ts:35@952afb5, src/profile.ts:74-75@952afb5). No se toca código de fab ni la lista de rutas protegidas (fuera de alcance en hipotesis.json).

## Mecanismo y por qué se espera efecto
- Causa directa: el prompt manda tocar tests, y `tests/**` está en `DEFAULT_PROTECTED_PATHS` (src/validators/integrity.ts:7-12@952afb5). `protectedIntegrity` marca como tampered cualquier ruta protegida cuyo contenido en disco o en HEAD difiera de la base (src/validators/integrity.ts:57-59@952afb5); el pool lo convierte en `GATE_TAMPERED` y bloquea la actividad (src/pool.ts:264-270@952afb5).
- Estado actual: 24/24 corridas con `integrity_ok=0` en baseline, candidato y baseline_rep del run anterior (docs/research/runs/2026-11-04-C4b-busqueda-acotada-T1-01/medicion.json:474-490@952afb5) y hallazgo lateral idéntico (docs/research/arquitectura-ideacion/resultados-ciclos.md:23@952afb5).
- Piloto T1-01 cortado por HALT, no evaluado: candidato 15/24 frente a 24/24 (docs/research/runs/2026-11-04-C4b-tests-protegidos-T1-01/canonical.md:4@952afb5). De ahí la predicción −30 %, no de una evaluación; la predicción previa era −80 % (canonical.md:6@952afb5).

## Controles (iguales en los tres brazos)
- Suite: `/home/orlando/.fabrica-ideas/t1/suite.json`, 12 tareas, sha256 `45f1ce6a51722e8d88d38fff6e47789c5b1af616f1f806f75f9abab1a81e67e0`; todas con `group`, ≥3 grupos.
- Mismo modelo (Haiku, como en el T1 previo: resultados-ciclos.md:12@952afb5), mismo `fab_sha` (952afb5), mismas rutas protegidas por defecto, mismo presupuesto (≤4 h, ≤5 USD).
- Mismo orden/semilla de tareas por brazo; sin cambios de código entre brazos.

## Diseño
- `--repeated-baseline`; 12 tareas × 2 repeticiones = 24 corridas pareadas por brazo (candidato, baseline, baseline_rep), todas con `integrity_ok` (≥10 exigido por T1). Mismo diseño que el T1 previo (medicion.json:489-495@952afb5).
- Baseline = perfil por defecto (`defaultProfile()`, src/profile.ts:37@952afb5). baseline_rep = el mismo perfil repetido: mide ruido.

## Métricas
- **Primaria**: proporción de corridas con `integrity_ok=0` por brazo, con intervalo de Wilson al 95 %.
- **Ruido**: |prop baseline − prop baseline_rep|.
- **No solapamiento**: intervalos de Wilson de candidato y baseline.
- **Guardiana**: `exito_verify` del candidato ≥ baseline.
- **Secundaria (solo anotada)**: `costUsd` por corrida (mediana, IQR p25–p75).

## Umbrales precomputados (n=24 por brazo, Wilson 95 %)
- Baseline esperado 24/24 = 1,00 → [0,862; 1,000].
- Candidato k/24 con `integrity_ok=0`: k=17 → [0,508; 0,851] (no solapa); k=18 → [0,551; 0,880] (solapa); k=16 → [0,467; 0,820]; k=15 → [0,427; 0,788].
- Predicción −30 % se cumple con k ≤ 16 (≤ 0,70 × 24 = 16,8). ACCEPT exige además no solapamiento (k ≤ 17 si el baseline sale 24/24) y |delta| > ruido.

## Regla de decisión (ARQUITECTURA.md §6, según el brief)
- `ACCEPT` (se escribe `T1 candidato: …`) solo si: no solapamiento de Wilson, mejora en la dirección de la predicción (menos corridas con `integrity_ok=0`), |delta| > ruido, y éxito del candidato ≥ baseline.
- En cualquier otro caso: `INCONCLUSIVE(filtrado)`. T1 no emite REJECT.

## Riesgos de validez que el implementador debe anotar
- Si el baseline no sale 24/24, recalcular los umbrales con sus datos; el ruido manda.
- El paso 3 pide ejecutar la suite: si crear `__pycache__`/`.pytest_cache` bajo `tests/` cuenta como cambio protegido, el candidato seguiría con `integrity_ok=0` aun obedeciendo. `diskTree` compara el disco con los patrones (src/validators/integrity.ts:36@952afb5, src/validators/integrity.ts:66@952afb5) pero su cuerpo no se leyó: **no verificado**. Registrar qué rutas violan en cada corrida fallida para distinguirlo.
- Las tareas `py-*` dicen «asegurar que los tests existentes sigan pasando» (suite, brief) y las `ts-*` no mencionan tests; un worker puede seguir tocando tests por esa frase. Es parte del efecto medido.
- `package.json`, `bun.lock`, `pyproject.toml`, `conftest.py`, etc. también están protegidos (integrity.ts:8-11@952afb5): el texto del candidato debe nombrarlos, no solo `tests/**`.

## Fuera de este tier
(No forma parte de la receta medible.) T1 no emite REJECT y solo filtra. Para decidir con riesgo de fallo del efecto sobre éxito: T2 con ≥30 corridas pareadas por brazo y tareas fuera de la suite pequeña (archivos grandes, tareas que exijan tests nuevos), midiendo `exito_verify` con un verificador que ejecute los tests del benchmark en un árbol aparte, y un brazo de control con un texto de la misma longitud que no hable de tests, para separar el efecto de la instrucción del efecto de añadir tokens (patrón ya pedido en resultados-ciclos.md:19-21@952afb5).
