# Tarea — fase de dependencias para `--verify` (ola 3)

Repo: /home/orlando/Desktop/factory/sw-factory-ola3b-deps (rama `fab/research-ola3b-deps`, base `integ/ola3@1943fac`, gates de la ficha 01 ya integrados).
Contexto: /home/orlando/Desktop/factory/sw-factory/docs/research/runs/2026-10-31-ola3/resultado.md (sección Hallazgos) y la ficha 01 del plan: "Instalar dependencias es una fase previa separada con política propia, nunca dentro de los gates".

## Problema
`--verify 'pytest -q'` falla siempre: el sandbox del gate (`runVerifierAt` en `src/agent/mission-evidence.ts`) filtra el entorno y no ve `~/.local`. Un `.venv` del repo se monta de solo lectura (ver el comentario de la línea ~124), pero su `python` es un symlink y la copia falla con ELOOP. Hoy solo funciona `pip install --target _deps` más un `python3 -c` con `sys.path`.

## Qué hacer
1. `fab ws create … --verify-setup '<argv>'` (repetible; columna con `addColumn`). Corre **fuera** del gate, en una fase propia: con red, sin escribir en el worktree del change, con `FAB_DEPS=<stateDir>/deps/<workstream>` en el entorno y cwd = el worktree. Se ejecuta antes del primer gate y otra vez solo si cambia el argv de setup (guarda un hash). Su salida va al manifest como paso `setup`; si falla, el gate falla con razón `setup` y no corre.
2. En el gate: monta `FAB_DEPS` de solo lectura y añade al entorno `PYTHONPATH=$FAB_DEPS`, `PATH=$FAB_DEPS/bin:…` y `NODE_PATH=$FAB_DEPS/node_modules` (solo si existe el directorio). Red, copia desechable y entorno filtrado quedan igual.
3. Arregla también el `.venv` del repo (resolver el symlink del intérprete o montarlo sin seguirlo) si es una corrección pequeña; si no, déjalo anotado.
4. Documenta en el `--help` el ejemplo: `--verify-setup 'python3 -m pip install --target $FAB_DEPS pytest' --verify 'pytest -q'`.

## Tests
Setup con red escribe en FAB_DEPS y no en el worktree (porcelain limpio, integridad 02 sin cambios); el gate ve `pytest` desde FAB_DEPS; el gate sigue sin red; setup fallido → gate fail con razón `setup` y sin LLM; setup no se repite si el argv no cambia; sin `--verify-setup` todo igual.

## Verificación
`bun test` y `bunx tsc --noEmit` en verde (base 878). `fab` real con agente `fake` sobre una copia de /home/orlando/Desktop/factory/examples/toy-calc **bajo ~/.cache** (no /tmp) con `--verify-setup 'python3 -m pip install --target $FAB_DEPS pytest' --verify 'pytest -q'`: gate pass en un change sano y fail en uno con test roto. Pega comandos y salida.

## Entrega
Commits pequeños en español **sin `Co-Authored-By`**, sin merge ni push. Reporte en /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola3b-deps.md. No hagas grep sobre /home/orlando/Desktop/factory entero.
