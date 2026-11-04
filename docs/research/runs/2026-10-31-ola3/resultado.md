# Ola 3 — resultado (2026-10-31)

`integ/ola3` (`1943fac`): codex 01 gates (`b5905a4`, `ece3ca0`, `845bba8`) + agy banco y línea base (`5181837`) + script de medición de gates (Claude). 878 tests, 0 fail; `tsc` limpio. Sin PR todavía: espera decisión.

## Medición (banco de agy: 10 bugs toy-calc + 5 en `src/connectors/adf.ts`, 5 sanos)
| Métrica | Línea base (QA LLM, codex gpt-6.1-sol) | Pipeline gates → QA |
| --- | --- | --- |
| Sensibilidad | 14/15 | 14/15 (ratio 1.00; objetivo ≥1.2 inalcanzable: techo 15/14 = 1.07) |
| Atrapables por test detectados por el gate | — | 8/8 |
| Falsos fallos del gate en sanos | — | 0/5 |
| Falsos rechazos | 2/5 | 2/5 (el QA LLM corre igual tras gate pass) |
| Ejecuciones LLM | 20 | 12 |
| Segundos LLM + gate | 826.5 | 513 + 8.5 (ratio de coste 0.63; objetivo ≤1.0 cumplido) |
| USD | 0 (suscripción) | 0 |

Método: gate real (`runGates`, sandbox sin red) por caso; veredicto de QA tomado de la línea base para la misma entrada (pipeline secuencial). No es una corrida extremo a extremo con LLM; codex probó el ciclo completo con agente fake.

## Hallazgos
- Dependencias: el sandbox filtra el entorno (no ve `~/.local`); un venv falla con ELOOP al copiar el symlink de `python`. Funciona `pip install --target _deps` en fase previa.
- Repos bajo `/tmp`: el sandbox oculta metadatos de git (codex); el banco usa `~/.cache`.
- El QA LLM rechaza 2/5 cambios sanos inventando requisitos: los gates no lo corrigen.

## Decisión pendiente
Criterio de la receta: sensibilidad ≥1.2 **no cumplido** (mal planteado ante una línea base de 93 %); coste ≤1.0 **cumplido** (−37 %). `--verify` es opcional por workstream.

## Decisión y PR (2026-10-31)
Orlando eligió la opción 2: fase de dependencias antes de la PR, y un banco más difícil con agy.
- Fase de dependencias (`--verify-setup`, `FAB_DEPS`) por Claude Code Sonnet (`a2c4f86`, `5735e6c`); integrada en `integ/ola3` (`756491f`). 883 tests, 0 fail.
- PR #31 (`feat/esf-ola-3`).
- Banco difícil (agy, `fab/research-ola3b-agy`): en curso, con cortes de red del servidor de agy; irá en otra PR.

## Banco difícil (agy, revisión 1) — PR #32
- Línea base QA `claude`: 13/15 (86,7 %); pipeline gates → QA: 13/15 (ratio 1,00); gate 8/8 atrapables, 0/5 falsos fallos; LLM 20 → 12; segundos 934 → 615 (−34 %).
- Conclusión: con QA agéntico que ejecuta los tests, los gates no pueden aumentar la sensibilidad (los bugs que atrapan los tests ya los atrapa el LLM). El criterio ≥1,2 solo aplica frente a un QA que no ejecuta tests. Valor medido: coste −34 % a −40 %, 0 falsos fallos, en dos bancos.
- Revisión 0 descartada: los bugs semánticos estaban en funciones nuevas añadidas por el parche.
- `bunfig.toml` (`root = "tests"`): el fixture del primer banco ya se colaba en la suite de main (2 tests).
- Caveat: `hard-bug-11` lleva un comentario delator.
