# Resultado ola 0 — 2026-10-30

Rama de integración: `integ/ola0` (worktree `../sw-factory-integ-ola0`), base `main@29d4dd3`, HEAD `5d57ae0`. Sin merge a `main` ni push.

| Defecto | Commit | Autor | Test que falla en main |
| --- | --- | --- | --- |
| D1 INSERT posicional | f92e5d4 | codex | `store.test.ts` columna extra en 5 tablas |
| D8 migración concurrente | 4adf6f5 | codex | `store-migrations.test.ts` |
| D2 merge abierto sin veredicto | ace31f6 | codex | `validators-core.test.ts:325` |
| D4 retry pierde validador | 11349ae | codex | `validators-core.test.ts:353` |
| D3 STATUS antes de truncar | 40346f0 | agy | `agents-output.test.ts` |
| D5 git sin hooks | f9ab813 | agy | `worktrees.test.ts` hook marcador |
| H2 porcelain tras todo validador | d43b031 | agy | `validators-pool.test.ts:89` |
| Razón de STATUS inválido | 9b7c6ba | Claude (integración) | `pool.test.ts` |
| Etiqueta "sin veredicto (falló)" | 5d57ae0 | Claude (integración) | `validators-core.test.ts` |

## Gate
- `bun test`: 762 pass, 0 fail (main: 751).
- `bunx tsc --noEmit`: limpio.
- Flujo real `fab` con agente `fake` sobre copia de `examples/toy-calc`: change → investigación → implementación → QA con `STATUS: working` agota 3 intentos → `fab merge` responde `validadores sin veredicto: qa` → `fab retry` crea un QA nuevo (`validator = qa`, presupuesto 0).

## Pendiente para ola 1
- Un change con validador agotado queda `implemented`: `fab retry` lo reintenta, pero la TUI solo ofrece `r` sobre `failed` (contrato de BLOCKED en la TUI, candidato 06).
- D6-D8 restantes del plan: D6 y D7 van en 07; D8 resuelto aquí.

## Incidentes
- Un commit de integración llevó por error el trailer `Co-Authored-By`, prohibido por el CLAUDE.md del proyecto; se corrigió con amend antes de seguir.
