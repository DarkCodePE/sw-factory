# Reporte — fase de dependencias para `--verify` (ola 3b)

Rama `fab/research-ola3b-deps` (worktree `sw-factory-ola3b-deps`), base `integ/ola3@1943fac`. Sin merge ni push.

## Qué se hizo
- `fab ws create … --verify-setup '<argv>'` (repetible). Columnas `verify_setup` y `verify_setup_hash` con `addColumn`. Se exige `--verify` si hay setup.
- `$FAB_DEPS` es la única expansión permitida en el argv de setup: se tokeniza con `verifierArgv` y el runner la sustituye (nunca un shell).
- `runSetupAt` (`src/agent/mission-evidence.ts`): bwrap `required`, **con red**, cwd = worktree remontado solo lectura, `FAB_DEPS` (`<stateDir>/deps/<slug>`) como único path escribible, entorno filtrado + `FAB_DEPS`.
- `ensureSetup` (`src/pool.ts`): corre antes del primer gate; guarda sha256 del argv solo si todo salió bien, así que solo se repite si el argv cambia (o si falló). Un setup a la vez por workstream (mapa en proceso).
- Salida del setup al manifest como pasos con `phase: 'setup'` (+ log `<act>.setup.log`). Si falla: actividad `blocked` con `GATES_FAIL setup`, el gate no corre y no hay LLM.
- Gate: `runVerifierAt(..., deps)` monta `FAB_DEPS` ro y añade `PYTHONPATH`, `PATH=$FAB_DEPS/bin:…`, `NODE_PATH=$FAB_DEPS/node_modules` solo si el directorio existe. Red, copia desechable y entorno filtrado, igual.
- `.venv`: la causa del ELOOP era que, si el `.venv` **no** está en `.gitignore`, la copia desechable leía el symlink del intérprete. Ahora `verifierWorkspace` recrea los symlinks como symlinks. (Con `.venv` ignorado ya funcionaba.)
- `--help` documenta la opción y el ejemplo `--verify-setup 'python3 -m pip install --target $FAB_DEPS pytest' --verify 'pytest -q'`.

## Tests (`tests/gates.test.ts`)
Setup escribe en FAB_DEPS y no en el worktree (porcelain limpio); el gate ve la herramienta de FAB_DEPS y no puede escribir en él; setup con red; setup fallido → `GATES_FAIL setup`, sin gate ni validadores, paso `setup` en el manifest; setup no se repite si el argv no cambia; sin `--verify-setup` todo igual; symlink de `.venv`.

## Verificación
- `bunx tsc --noEmit`: sin errores.
- `bun test`: 883 pass / 0 fail (base 878; +5 tests nuevos incl. el del symlink).
- `fab` real, agente `fake`, copias bajo `~/.cache/fab-ola3b/` y `FABRICA_HOME=~/.cache/fab-ola3b/state`:
  ```
  fab ws create toy --repo ~/.cache/fab-ola3b/toy --goal g --agent fake --no-change-approval --no-spec-approval \
    --verify-setup 'python3 -m pip install --target $FAB_DEPS pytest' --verify 'pytest -q'
  fab signal add toy Cambio2 --body x; fab triage --all toy; fab run toy --once --agent fake
  ```
  - Sano: `--- gates … completed review=approved` · `VERDICT: pass` · `STEP 1: ["pytest","-q"] exit=0` · `7 passed`; porcelain del worktree vacío.
  - Roto (`add` devuelve `a+b+1`): `gates … blocked` · `GATES_FAIL` · `exit=1` · `FF....F` (`assert 6 == 5`).
  - pytest se instaló en `state/deps/<slug>` (setup con red) y el gate lo usó sin red.

## Decisiones y notas
- `examples/toy-calc` trae un bug real en `average` (`len(values) + 1`); el "sano" es una copia con ese bug corregido, y el "roto" una copia con `add` roto. No toqué el original.
- Con el agente `fake`, los validadores LLM posteriores rechazan ("missing valid VERDICT"); es ajeno a esta tarea.
- Límite: el hash de setup es por workstream, no por worktree; el directorio de deps se comparte entre changes. Un setup fallido se reintenta en el siguiente gate.
- `fingerprintWorkspace` (misiones) sigue leyendo symlinks con `readWorkspaceFile`; no lo toqué (fuera del alcance de gates).
- El setup tiene timeout de 600 s (fijo, no configurable).
