# Spec — perfil candidato «tests protegidos»

Autocontenida: no necesitas ver las fuentes.

## Objetivo
Crear un perfil candidato de fab cuyo `worker.implement` no pida modificar tests, para que el worker deje de tocar rutas protegidas sin perder éxito.

## Contexto verificado
- Un perfil es JSON con `schemaVersion: 1`, `harness`, `worker.{rules,investigate,implement}` y `validators`; se guarda direccionado por su digest sha256 (src/profile.ts:10-23@952afb5, src/profile.ts:70-72@952afb5). No se edita el código de fab.
- La protección por defecto bloquea cambios en tests/**, **/*.test.*, conftest.py, pytest.ini, package.json, etc., con `GATE_TAMPERED` (src/validators/integrity.ts:7-12@952afb5, src/pool.ts:264-269@952afb5).
- El baseline actual tocó rutas protegidas en 24/24 corridas (medicion.json:474-490@952afb5), porque el paso 2 por defecto ordena «Add or update tests» (resultados-ciclos.md:23@952afb5).

## Cambio
1. Partir de `defaultProfile()` exportado; copiar su JSON.
2. En `worker.implement`, sustituir solo el paso 2 por (texto exacto, ajustable en redacción pero conservando ambas ideas):
   «2. Do not modify protected files (tests/** and test configuration such as conftest.py, pytest.ini, package.json). Instead, describe in your final report the tests that would be needed.»
3. No cambiar nada más (rules, investigate, validators, `harness`, `model`).
4. Importar con `saveProfile` y fijar el digest resultante como candidato del experimento.

## Aceptación del implementador
- Diff entre perfil por defecto y candidato = solo el paso 2.
- `validateProfile` acepta el JSON; la plantilla no supera 32 KiB (src/profile.ts:20@952afb5).
- El digest difiere del de `DEFAULT_DIGEST`.

## Medición (no la ejecuta el implementador)
T1 `integridad`, 12 tareas × 2, brazos candidato/baseline/baseline_rep, `--repeated-baseline`. Éxito esperado: Wilson no solapado, éxito candidato ≥ baseline (1,00), nivel esperado ≈0,20 de corridas con integrity_ok=0. Coste solo secundario.
