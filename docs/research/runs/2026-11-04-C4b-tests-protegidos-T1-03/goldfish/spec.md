# Spec — candidato «tests protegidos» (autocontenida)

## Objetivo
Crear un perfil de fab candidato cuyo `worker.implement` no ordene añadir o actualizar tests, y medirlo frente al perfil por defecto con un experimento T1.

## Contexto (hechos verificados)
- fab guarda perfiles inmutables identificados por el sha256 del JSON canónico (src/profile.ts:1-2@952afb5, src/profile.ts:35@952afb5). Forma: `{schemaVersion:1, harness, worker:{rules,investigate,implement}, validators:{rules,code_review,security_audit,qa}}`; claves desconocidas y plantillas vacías o >32 KiB se rechazan (src/profile.ts:20-23@952afb5, src/profile.ts:44-48@952afb5).
- El `worker.implement` por defecto es (src/prompts.ts:34-40@952afb5):
  ```
  Your task is an IMPLEMENTATION of the approved spec above.
  1. Make the smallest change that satisfies the spec; follow the existing code style.
  2. Add or update tests that would have caught the problem.
  3. Run the test suite and include the command and its result in your report.
  4. Commit your work on the current branch with a clear message (git add + git commit).
  If the spec turns out to be wrong, stop and explain instead of improvising a different change.
  ```
- Rutas protegidas por defecto: `tests/**, test/**, **/*.test.*, **/*.spec.*, package.json, bun.lock, bunfig.toml, tsconfig*.json, *vitest*, *jest*, pyproject.toml, pytest.ini, setup.cfg, conftest.py, Makefile, .github/**, .gitattributes, .gitmodules` (src/validators/integrity.ts:7-12@952afb5). Prosa `.md/.txt/.rst` solo cuenta si el patrón no termina en `.*` (src/validators/integrity.ts:13@952afb5, src/validators/integrity.ts:82-84@952afb5).
- Una actividad de implementación se bloquea con `GATE_TAMPERED: <rutas>` si `protectedIntegrity` encuentra diferencias en disco o en HEAD respecto a la base (src/pool.ts:265-271@952afb5; src/validators/integrity.ts:73-102@952afb5). Antes se purgan cachés regenerables de Python (src/validators/integrity.ts:56-69@952afb5).
- Medición previa: 24/24 corridas con `integrity_ok = 0` en los tres brazos del T1 sin esta intervención (docs/research/runs/2026-11-04-C4b-busqueda-acotada-T1-01/medicion.json:474-488@952afb5). T1-02 fue INCONCLUSIVE por contaminación con `tests/__pycache__` (docs/research/runs/2026-11-04-C4b-tests-protegidos-T1-02/veredicto.json:7@952afb5), ya corregida con `purgeRegenerableCaches`.

## Cambio (único)
Partir del perfil por defecto y reemplazar solo `worker.implement` por:
```
Your task is an IMPLEMENTATION of the approved spec above.
1. Make the smallest change that satisfies the spec; follow the existing code style.
2. Do NOT create, modify, rename or delete protected files: tests and test configuration (tests/**, test/**, *.test.*, *.spec.*, conftest.py, pytest.ini, pyproject.toml, setup.cfg, package.json, lockfiles, tsconfig*.json, Makefile, .github/**). Instead, describe in your report the tests that would be needed (name, what each checks, expected result).
3. Run the existing test suite WITHOUT editing it and include the command and its result in your report.
4. Commit your work on the current branch with a clear message (git add + git commit).
If the spec turns out to be wrong, stop and explain instead of improvising a different change.
```
No tocar `rules`, `investigate` ni `validators`. No añadir otras instrucciones (p. ej. de búsqueda): cualquier otra diferencia confunde la variable.

## Procedimiento
1. Guardar el perfil candidato como JSON con `schemaVersion:1`, `harness:"native"` y el resto copiado del perfil por defecto; importarlo con el comando de perfiles de fab y anotar su digest.
2. Crear el experimento T1 con `fab improve create --experiment-id <id> --baseline <digest-defecto> --candidate <digest-candidato> --repeated-baseline`, suite `~/.fabrica-ideas/t1/suite.json` (12 tareas con `group`, ≥3 grupos), 2 corridas por tarea y brazo (24 por brazo), con el `fab_sha` fijado al commit de la medición, sin `--protect-none`.
3. Verificar antes de lanzar que el candidato difiere del baseline solo en `worker.implement` (comparar los JSON).
4. Informe: `FABRICA_HOME=~/.fabrica-ideas bun src/cli.ts improve report <id> --json`; extraer por brazo `integrity_ok`, éxito de `verify` y coste.

## Aceptación
- Calcular por brazo la proporción con `integrity_ok = 0` y su intervalo de Wilson 95 %; ruido = |prop baseline − prop baseline_rep|.
- `ACCEPT` solo si: intervalos candidato/baseline sin solape; el candidato tiene menos corridas con `integrity_ok = 0`; |delta| > ruido; éxito del candidato ≥ baseline. Si no, `INCONCLUSIVE(filtrado)`. Nunca REJECT en T1.
- Registrar aparte, sin que decida: coste (mediana, IQR) y commits que tocan tests por brazo.
- Si hay marcas de `integrity_ok = 0` en el candidato, listar las rutas: si son cachés no Python, anotarlo como contaminación y dictaminar INCONCLUSIVE.

## Fuera de alcance
Cambios en `src/` (integrity, pool, prompts por defecto), en la suite o en los validadores.
