# Plan de implementación del ADR-0008 (2026-11-02)

Fuente: `../adr/ADR-0008-probe-por-tipo-de-fuente.md` (revisado con la medición).

## Lo que ya existe (no se rehace)
- Prototipo `scripts/ideas/graft-lector.ts` con M1–M4 y `tests/graft-lector.test.ts` (4 tests, `tsc` limpio).
- La configuración MCP de fab ya acepta `readPaths` (`src/agent/mcp.ts:38`, `:87-88`; validación en `src/agent/rpc.ts:118`). **El prerrequisito del sandbox para graft es configuración, no código de fab.**

## Lo que falta y bloquea más allá de este ADR
El harness del ciclo (`scripts/ideas/`: prerregistro, ledger append y veredicto; ADR-0003) **todavía no existe**. Este plan implementa solo la parte del Probe que pertenece al ADR-0008. Deja un tipo `ProbeBudget` con su validador, que el prerregistro incorporará cuando se construya. No se construye el prerregistro completo aquí.

## Fase A: código (Sonnet 5.5)
| # | Cambio | Decisión del ADR |
|---|---|---|
| A1 | Retirar M1 (semillas) de `graft-lector.ts` y de su test | Decisión 3 (M1 retirada) |
| A2 | Subcomando `rg` (localizador principal) con el mismo tope y spill de M3; `ask`/`skeleton`/`callers`/`grep` siguen como complemento, siempre con `--no-refresh` | Decisión 2 revisada; M3 |
| A3 | Vista previa de M3 que prioriza la cabecera de conteo (grep/rg) y los símbolos exportados (skeleton) antes de cortar | M3, ajuste |
| A4 | Subcomando `measure <ruta> [--budget N]`: `tokens_medidos` = bytes/4 sobre `git ls-files` de la ruta → `leer_entero` o `bajar_nivel` | Decisión 1 (umbral medido) |
| A5 | Tipo `ProbeBudget {tipo_fuente, tokens_medidos, presupuesto_lectura, tope_consultas}` con validador, y una sesión (`--session <json>`) que cuenta consultas y bytes servidos y corta (código distinto) al superar el tope | Decisiones 1 y 4 |
| A6 | `graft-lector mcp-config`: imprime la entrada MCP de graft para fab con `readPaths` resueltos (`realpath` de `node` y raíz del paquete graft) y `args: ["mcp"]`; test de integración que ejecuta `graft --version` a través de `wrapMcpCommand` (se omite si no hay bwrap o graft) | Prerrequisito del sandbox |
| A7 | Tests por cada cambio, `bunx tsc --noEmit` y la suite completa (`bun test`) en verde | — |

## Fase B: segundo repo (agy)
Repetir A0 (graft tal cual, R1–R3) y A2 (búsqueda libre, a ciegas, R1) en `ext/deer-flow` @ `35656d6` (Python, ~871 k líneas):

- prerregistro `medicion/tareas-deerflow.md` (sha256 `2fe5fd0a…`);
- verdad `medicion/verdad-deerflow.md` (`6352c69d…`).

Responde a la pregunta pendiente: ¿el fallo de graft en opencode es general o propio de Effect?

## Fase C: orquestador
- Auditar A y B: hashes, tests y cifras contra el fuente.
- Decidir el estado del ADR (aceptado o no) y actualizarlo.
- Pasar a `docs-agy` la actualización de MkDocs.

## Fuera de este plan
- El harness del ciclo (ADR-0003).
- Medir "A2 + envoltura" frente a A2 solo: necesita A2 a A6 terminados; es la siguiente medición.
