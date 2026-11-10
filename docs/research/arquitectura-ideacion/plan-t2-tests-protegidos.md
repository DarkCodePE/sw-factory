# Plan T2: cualificar el perfil «tests protegidos» (2026-11-05)

**Objetivo.** Pasar el candidato `64f463d9…` de `ACCEPT-candidato` (T1, run `2026-11-04-C4b-tests-protegidos-T1-03`) a `ACCEPT-cualificado`, que es la única vía para **activarlo por defecto** (`ARQUITECTURA.md` §6). Este documento es el diseño. Nada de esto está construido todavía.

## Qué exige T2 (§6) y qué añade este caso

| Requisito | Fuente | Para este candidato |
|---|---|---|
| ≥ 100 tareas intactas, ≥ 10 clusters, × 3 | §6 | 10 repos (clusters) × 10 tareas, 3 repeticiones |
| Bootstrap pareado por cluster (ESF) | §6, `improve-fase1` gate pendiente | Remuestrear clusters, no corridas |
| Ganancia ≥ 5 pp y cota inferior del IC bilateral 95 % > 0 | §6 | Sobre la proporción de corridas que tocan rutas protegidas |
| Puede emitir `ACCEPT-cualificado` o `REJECT` | §6 | Primer tier donde cabe REJECT por la métrica primaria |
| Brazo de control de la misma longitud | receta T1-03 y dictamen del crítico | Separa «la instrucción de no tocar» de «otro texto en el prompt» |
| Éxito con tests ocultos | dictamen del crítico | Mide si el código sigue bien sin que el agente vea el verificador |

## Brazos

| Brazo | Perfil | Para qué |
|---|---|---|
| `baseline` | por defecto (`2dff534e`) | Referencia |
| `baseline_rep` | por defecto | Suelo de ruido, ya existe (`--repeated-baseline`) |
| `candidate` | `64f463d9` | Intervención |
| `control` | por defecto con los pasos 2 y 3 sustituidos por un texto de la **misma longitud en tokens** que no hable de tests ni de rutas, por ejemplo instrucciones de estilo de commit | Si el control también baja la métrica, el efecto viene de quitar «Add or update tests», no de prohibir. Las dos cosas serían útiles, pero es otra decisión |

## Métricas

- **Primaria.** Proporción de corridas con `integrity_ok = 0`, después de `purgeRegenerableCaches`. Se mide la diferencia candidato − baseline por cluster y se calcula un IC 95 % por bootstrap pareado por cluster (10 000 remuestreos, semilla registrada).
- **Guardianas** (no pueden empeorar, margen declarado de 2 pp en el IC):
  - éxito de `verify` con **tests ocultos**: archivos que el agente no puede ver, copiados solo al verificar desde fuera del worktree y sin mencionarse en la descripción;
  - `diffLines` (±25 %);
  - `costUsd` (mediana del candidato ≤ baseline + 10 %; unilateral desde el ciclo 03, motivado por los datos exploratorios del ciclo 02, donde candidate costó un 14,5 % menos).
- **Secundaria nueva, el coste que T1 no midió.** Proporción de informes del worker que **describen tests** cuando no los escriben. Es una lectura determinista del informe de la activity. Si cae por debajo del 80 % en el candidato, el ACCEPT-cualificado se acompaña de una tarea para que alguien escriba esos tests (Gate 3), en vez de dejarlos perdidos.

## Corpus (el prerrequisito más caro)

- **10 clusters = 10 repos pequeños con suite de tests real**: Python y TypeScript, licencia permisiva, pin `sha` en `third_party/<x>/UPSTREAM.json`, ADR-0005.
- **10 tareas por repo**, generadas de forma determinista por **mutación**:
  - se introduce un fallo en el código (no en los tests);
  - la tarea es «haz que <comportamiento> vuelva a funcionar»;
  - `verify` ejecuta los tests originales del repo como tests ocultos.
- **Comprobación por tarea**, como en `bench/t1-filtro`: `verify` falla en la base mutada y pasa con el parche de referencia (la mutación inversa).
- Tareas **intactas**: no se editan después de ver resultados. El sha256 de la suite va al prerregistro.

## Prerrequisitos que hay que construir

| # | Qué | Dónde | Tamaño |
|---|---|---|---|
| P1 | Generador del corpus T2 por mutación, con pins y verificación de cada tarea | `bench/t2-cualificacion/` | Grande |
| P2 | Brazo `control` en `improve`: `--control <digest>`, intercalado con semilla, como `baseline_rep` | `src/improve.ts`, `improve-cli.ts` | Pequeño |
| P3 | `--concurrency N` en `improve run`. 1 200 corridas en serie son unas 20 h; con N = 6, unas 3,5 h | `src/improve.ts` | Medio |
| P4 | Bootstrap pareado por cluster y cota inferior 95 %, con semilla | `src/improve.ts` (`report --json` lo expone) o `ciclo.ts` | Medio |
| P5 | Tier T2 en `ciclo.ts`: validación de la suite (≥ 100 tareas, ≥ 10 grupos, × 3), regla de §6 y la secundaria de informes | `scripts/ideas/ciclo.ts` | Medio |
| P6 | Tests ocultos de verdad: confirmar qué rutas puede leer el adaptador `claude` (Read no está confinado) y guardar los verificadores fuera de lo legible | `bench/`, `src/agents.ts` (solo lectura del código) | Pequeño |

## Coste estimado

- **Corridas:** 100 tareas × 3 repeticiones × 4 brazos = **1 200 corridas**.
- **Coste con Haiku:** a 0,024–0,033 USD por corrida (medido en T1) salen **unos 30–40 USD**. Con Opus serían unos 800 USD, y no tiene sentido.
- **Duración:** unas 3,5–5 h con concurrencia 6, siempre bajo `systemd-inhibit`.
- `ARQUITECTURA.md` §10 estimaba unas 600 corridas para 2 brazos; el brazo de control y el `baseline_rep` las duplican.

## Orden propuesto

1. P2 y P6, que son pequeños y desbloquean el diseño de los brazos.
2. P3, sin el cual T2 no cabe en una tarde.
3. P1, el corpus, que es la pieza grande. Antes se puede hacer un piloto con 3 repos.
4. P4 y P5.
5. El ciclo T2, con su propio gate, presupuesto (~40 USD y 6 h) y aprobación del operador.

## Riesgos

- **Mutaciones triviales.** La misma tarea ya no prueba nada. Hay que filtrar las que `verify` no distingue y registrar las descartadas.
- **Tests ocultos legibles.** Si el agente encuentra los verificadores, la guardia de éxito no vale. Se resuelve en P6.
- **Clusters desiguales.** Repos de tamaños muy distintos. El bootstrap por cluster lo absorbe en la varianza, pero conviene equilibrar el número de tareas por repo.
- **El brazo de control puede dar el mismo efecto.** Eso cambiaría la conclusión a «basta con quitar "Add or update tests"», que es un cambio aún más pequeño, y se cualificaría ese.
