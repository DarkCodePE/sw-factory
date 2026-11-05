# Receta T1 — tests protegidos (2026-11-04-C4b-tests-protegidos-T1-01)

## Variable intervenida
Perfil (tipo de cambio: perfil). Un único campo: `worker.implement`, paso 2. El perfil es un JSON inmutable con claves `worker.{rules,investigate,implement}` identificado por digest sha256 (src/profile.ts:10-23@952afb5, src/profile.ts:35@952afb5). Por eso candidato y baseline difieren solo en el digest del perfil.

- Baseline: perfil por defecto (`defaultProfile()`, src/profile.ts:103@952afb5), paso 2 = «Add or update tests that would have caught the problem» (resultados-ciclos.md:23@952afb5).
- Candidato: mismo perfil, con el paso 2 sustituido por: no modificar archivos protegidos (tests/** y su configuración) y describir en el informe final los tests que harían falta. Resto del texto idéntico, byte a byte.

## Por qué debería funcionar
La protección por defecto cubre `tests/**`, `test/**`, `**/*.test.*`, `**/*.spec.*`, `conftest.py`, `pytest.ini`, `package.json`, etc. (src/validators/integrity.ts:7-12@952afb5). Tras la implementación, pool compara esas rutas con la base y bloquea con `GATE_TAMPERED` si hay diferencias (src/pool.ts:264-269@952afb5). Las corridas del ciclo previo tocaron rutas protegidas en 24/24 por brazo (medicion.json:474-490@952afb5; resultados-ciclos.md:23@952afb5).

## Controles
- Misma suite `/home/orlando/.fabrica-ideas/t1/suite.json` (12 tareas, ≥3 grupos), mismo modelo (Haiku), mismo `fab_sha` 952afb5, mismas semillas por par.
- `--repeated-baseline`: brazos candidato, baseline y baseline_rep, ≥10 corridas pareadas por brazo (objetivo 24 = 12 tareas × 2, como el ciclo previo).
- Rutas protegidas: las de defecto, sin tocarlas. No se relaja la protección para medir.
- Control de longitud: el texto nuevo no debe cambiar mucho la longitud del prompt; registrar bytes de ambos pasos 2 (el ciclo C4b previo mostró que tokens extra de entrada mueven el coste).

## Métricas
- Primaria (`integridad`): proporción de corridas con `integrity_ok = 0` por brazo, con intervalo de Wilson 95 %. Referencia de baseline: 24/24 = 1,00, Wilson ≈ [0,86; 1,00] (medicion.json:474-490@952afb5).
- Predicción: −80 % en el candidato, es decir ≈0,20 (≈5/24; Wilson ≈ [0,09; 0,41]).
- Ruido: |prop baseline − prop baseline_rep|.
- Guardianas: `exito_verify` del candidato ≥ baseline (baseline = 1,00 en el ciclo previo, medicion.json:1-30@952afb5). Secundaria anotada: `costUsd` (mediana, IQR).

## Regla de decisión (T1)
ACCEPT solo si: intervalos de Wilson de candidato y baseline no se solapan, la proporción baja, |delta| > ruido y éxito candidato ≥ baseline. Si no, INCONCLUSIVE(filtrado). T1 no emite REJECT.

## Riesgos de lectura
- Si el candidato baja `integrity_ok=0` pero cae el éxito (el worker deja sin tocar cosas que la verificación pedía), la guardiana lo invalida.
- Las tareas del `ts-*` pueden tocar otros protegidos (`package.json`); registrar `tampered` por ruta para ver qué causa residual queda.

## Fuera de este tier
Si el candidato mejora pero queda residuo, o hay interacción con éxito, T2: suite mayor (≥30 tareas con tests existentes obligatorios), ≥30 corridas por brazo, un brazo control con texto de la misma longitud sin la restricción, y métrica conjunta (integridad ∧ éxito). No forma parte de la receta medible.
