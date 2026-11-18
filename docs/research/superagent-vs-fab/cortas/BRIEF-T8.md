# Brief T8 y T37: dos tests inestables

Worktree: `/home/orlando/Desktop/factory/sw-factory-fase1`, rama `fix/t8-tests-inestables`, base `origin/release/0.1.0-rc.12` (`5c4a9ac`). Trabaja **solo** ahí. `node_modules` ya está enlazado; no lo toques.

## Tests
1. **T8: el journal de 10 000 registros** (`tests/agent-journal.test.ts`, en torno a la línea 58), con un timeout de 30 s. Falla por timeout cuando la máquina está cargada, por ejemplo con dos suites en paralelo. Aislado pasa.
2. **T37: `notify without a waiter and a completed run wake the model once, even during its final response`.** Está en `tests/agent-script-durable.test.ts`. Falló en el CI de GitHub con `expect(…).toBeGreaterThanOrEqual(4)` y pasó al relanzarlo.

## Qué hacer
1. **Reprodúcelo antes de tocar nada.** Ejecuta cada test muchas veces y bajo carga, por ejemplo con `stress`, varios `bun test` en paralelo o `taskset -c 0`. Pega cuántas veces falla de N.
2. **Encuentra la causa**, no subas timeouts a ciegas.
   - ¿Qué mide el test?
   - ¿Depende de tiempos de reloj, de `setTimeout` o del orden de eventos asíncronos?
   - En T37, ¿qué cuenta el `>= 4` y por qué a veces es menor?
3. **Arregla el test**, o el código si la inestabilidad delata un defecto real, como una carrera en el journal o en el `notify`. Si es un defecto del código, dilo claramente: es más importante que el test.
   - Prefiere sincronizar con eventos o condiciones a esperar tiempo.
   - Si el volumen de 10 000 registros es lo que da sentido al test, mantenlo y mide qué parte es lenta.
4. **Demuestra el arreglo** con el mismo bucle bajo carga: 0 fallos de N.

## Reglas
- Lee el código con graft (`graft ask`, `graft skeleton`, `graft callers`) y por tramos con `sed -n`; nada de grep masivos.
- **Prohibido:**
  - tocar otros worktrees o el repo principal (salvo tu informe);
  - hacer commit, push o merge;
  - lanzar subagentes.
- **No ejecutes tu bucle de estrés a la vez que otra suite completa.** Hay otro agente trabajando en `sw-factory-fase0`: limita tu carga a lo necesario.
- **Al terminar:** `bun run typecheck` y `bun test tests`. La suite no debe empeorar.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/superagent-vs-fab/cortas/t8.md` e incluye:
- para cada test, la reproducción con N y los fallos antes y después;
- la causa;
- qué cambiaste;
- si es un defecto del código o del test;
- los comandos que ejecutaste, con su salida pegada.

Última línea, exactamente: `<!-- FIN -->`.
