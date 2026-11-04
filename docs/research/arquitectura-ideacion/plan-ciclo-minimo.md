# Plan: ciclo mínimo de ideación, de punta a punta (2026-11-03)

Objetivo: que exista **un** ciclo real, aunque sea manual, que vaya de hipótesis a fila del ledger cumpliendo el contrato de `ARQUITECTURA.md` §5 y el ADR-0003. Hoy el ledger tiene 0 filas.

## Alcance

**Entra:** los pasos 3–8, con un runner y estado en disco.

**No entra (y por qué):**
- Vigilancia, intake y backlog (pasos 0–2): la hipótesis la da el operador.
- Reflejar en llm_wiki (paso 9): se deja para el siguiente ciclo.
- T1/T2: faltan `integrity.ts` en `runArm`, `group` y repeated-baseline.
- Comparar dos builds de fab: sin ese runner solo se pueden medir ideas de **perfil, prompt o skill**.

## Pieza nueva: `scripts/ideas/ciclo.ts`

CLI sin estado propio. Todo vive en `docs/research/runs/<run_id>/`, cada archivo se escribe una vez y no se edita (regla del árbol de experimentos). Un subcomando por paso:

| Subcomando | Paso | Escribe | Falla cerrado si… |
|---|---|---|---|
| `init <hipotesis.json>` | 3 | `canonical.md` (cabecera §2 de `design-loops-investigacion.md`) y `hyp.sha256` | falta `usd_max`/`horas_max`, receipt de la limitación (métrica, valor, `fab_sha`, comando), mecanismo, predicción numérica, métrica primaria, guardianas, capa C0–C9 o el `ProbeBudget` del ADR-0008 (se reutiliza `validateProbeBudget` de `graft-lector.ts`). Entonces escribe directamente la fila `INCONCLUSIVE(hipótesis incompleta)` y para |
| `gate <run_id> --aprobar` | 4 | `gate.json` {operador, fecha, `hyp_sha`, `usd_max`, `horas_max`} | el hash de la hipótesis no coincide con `hyp.sha256` (la aprobación va ligada al hash) |
| `brief probe <run_id>` | 5 | `brief-probe.md` para el **lector** (solo canonical y fuentes, envueltas como no confiables, y `session-init` del lector con el tope) | no hay gate |
| `check probe <run_id>` | 5 | — | faltan `receta.md` o `spec.md`, o alguna cita no es `archivo:línea@sha` |
| `brief medir <run_id>` | 6 | `brief-medir.md` para el **implementador**: sesión limpia, solo `spec.md`, sin fuentes | no hay probe válido |
| `medir <run_id>` | 6 | `medicion.json` (id del experimento de `fab improve`, informe y coste) | el perfil candidato no existe o el tier no está permitido |
| `brief critico <run_id>` | 7 | `goldfish/` con el paquete §8 (canonical, receta, resultado, evidencias y un **canary**, un defecto plantado) | — |
| `cerrar <run_id>` | 8 | `veredicto.json` y la fila del ledger vía `appendRow`; `verifyLedger` debe pasar | el crítico no encontró el canary (hay que repetir con otro agente), o el veredicto excede lo que permite el tier (§6) |
| `halt <run_id> <razón>` | cualquiera | fila `INCONCLUSIVE(HALT: …)` | — |

- **Presupuesto.** Cada subcomando comprueba `horas_max` contra la marca de tiempo de `init`. `usd_max` se comprueba con `costUsd` de improve, que solo `claude` reporta; con otro agente el coste queda NULL y se anota.
- **Ledger.** *Deep* = capa; *Effect* empieza con el tier; *Witness* = `hyp:<sha8> ev:<sha8>`, donde `ev` es el hash de `medicion.json` + `veredicto.json`; *Issue*/*PR* = `NONE` (este ciclo no abre change).
- **Agentes.** El lector, el implementador y el crítico corren en paneles de Herdr, cada uno en sesión nueva. El crítico usa un modelo distinto del implementador y modo solo lectura, no permisos saltados (§8). `ciclo.ts` no lanza agentes: genera briefs y comprueba entregables. Así no se acopla a ningún harness, igual que el lector.

## Pieza nueva: suite T0

`bench/t0-humo/suite.json` en el formato de `SuiteTask`: 5 tareas pequeñas sobre el fixture `toy-calc` de `bench/ola3`, con `verify` = `pytest -q`. T0 = 5 × 1, que según §6 solo puede emitir `REJECT` por una guardiana determinista. Si no, el veredicto sale `INCONCLUSIVE(T0 solo humo)`. **El primer ciclo no puede dar ACCEPT**, y es correcto que no pueda: valida el pipeline, no la idea.

## Primera hipótesis (propuesta)

**C-capa del worker (prompt):** añadir al prompt de implementación del worker la instrucción de localizar con búsqueda acotada (`rg` + lectura de tramos) antes de editar, en vez de leer archivos enteros.

| Campo | Valor |
|---|---|
| Limitación | por medir en el receipt: bytes leídos por tarea en T0 con el perfil por defecto |
| Mecanismo | lo medido en ADR-0008 y `a2-vs-a2g.md` (búsqueda localizada, 5/5) |
| Predicción | −20 % de coste o de bytes, sin perder éxito |
| Guardianas | éxito de `verify`, `diffLines` |

## Tests
`tests/ciclo.test.ts` cubre:
- un `init` incompleto produce la fila INCONCLUSIVE y para;
- un gate con un hash distinto falla;
- `check probe` rechaza citas sin `@sha`;
- `cerrar` sin canary falla;
- un veredicto por encima del tier falla;
- tras `cerrar` y `halt`, `verifyLedger` pasa.

Se usa el agente `fake` de improve donde se necesite.

## Reparto
- **Sonnet 5.5** (panel de Herdr): `ciclo.ts` + tests.
- **agy** (otro panel): `bench/t0-humo` (suite y verificación de que `pytest` pasa en la base).
- **Yo:** revisión, y después ejecuto el primer ciclo real, con los agentes del ciclo en paneles.
- Sin commit.
