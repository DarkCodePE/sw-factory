# Tarea ola 3 — codex: 01 verificación determinista (gates)

Repo: /home/orlando/Desktop/factory/sw-factory-ola3-codex (rama `fab/research-ola3-codex`, base `main@5aa8cee`, olas 0–2 integradas).
Plan: /home/orlando/Desktop/factory/sw-factory/docs/research/plan-esf-candidatos.md §2, §3 y §4 ficha **01**. Léela entera: es el contrato. ESF (MIT) en /home/orlando/Desktop/factory/ext/esf @d901657 (verificación por argv, veredicto = exit 0 sin timeout); no copies código.

## Propiedad
Tuyo: el runner de gates (módulo nuevo), la rama `gates` en `processActivity` (`src/pool.ts`), el encolado de validadores LLM tras `gates` en pass (`src/store.ts`/`src/validators/`), la opción `--verify` del workstream en `src/cli.ts` y su columna (con `addColumn`), y la salida de cada paso al manifest de 04 (`src/manifest.ts`).
En paralelo agy construye el banco de medición en `bench/ola3/` y `scripts/e2e/ola3-*`: no toques esas rutas.

## Puntos clave (la ficha manda)
- Solo si el workstream declara `--verify` (argv, repetible; p. ej. `--verify 'python -m pytest -q'`). Sin `--verify` nada cambia y los tests de los 3 validadores siguen igual.
- `runVerifierAt(cwd, argv, signal)` reutiliza lo de `src/agent/mission-evidence.ts` (copia desechable, dependencias de solo lectura, entorno filtrado, **red denegada** con el sandbox existente). Nada de instalar dependencias dentro del gate.
- `gates` no es un validador LLM: rama propia; hoy `buildValidatorPrompt` lanza con tipos desconocidos. Los validadores LLM se encolan **cuando gates termina en pass sobre el mismo HEAD**.
- Veredicto: todos los pasos obligatorios con exit 0 y sin timeout; paso no ejecutable = fail; se ejecutan todos aunque falle uno; salida completa al manifest (`runs/<change>/`).
- Gate fail = el change no pasa a validadores LLM; aparece en `inbox` con la salida, `retry` vuelve a implementación.

## Tests obligatorios
Pass/fail por exit code; timeout = fail; argv no ejecutable = fail; se corren todos los pasos; red denegada dentro del gate (un paso que intenta conectar falla); validadores LLM solo tras gates pass y sobre el mismo HEAD; sin `--verify` comportamiento intacto.

## Verificación
`bun test` y `bunx tsc --noEmit` en verde (base 861). `fab` real con agente `fake` sobre una copia de /home/orlando/Desktop/factory/examples/toy-calc con `--verify 'python3 -m pytest -q'`: un change con test roto → gate fail sin LLM; uno sano → gate pass y luego validadores. Pega comandos y salida.

## Entrega
Commits pequeños en español **sin `Co-Authored-By`**, sin merge ni push. **Escribe el reporte mientras avanzas** (por la cuota): /home/orlando/Desktop/factory/sw-factory/docs/research/tasks/report-ola3-codex.md con cambios (archivo:línea), tests, sesión real y qué falta.
