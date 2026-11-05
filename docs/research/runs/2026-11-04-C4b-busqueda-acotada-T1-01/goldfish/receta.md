# Receta de medición — 2026-11-04-C4b-busqueda-acotada-T1-01

Tier **T1** (filtro). Suite `/home/orlando/.fabrica-ideas/t1/suite.json` (12 tareas, sha256 `45f1ce6a…`). Fab @ 952afb5.

## Hipótesis
Añadir al prompt de implementación del worker una instrucción de «localizar con búsqueda acotada (Grep y Read por rangos) antes de editar» reduce el `costUsd` por tarea ≥20 % (predicción del encargo) sin bajar el éxito de `verify`.

## Variable intervenida (única)
El texto de `worker.implement` del perfil. Un perfil es inmutable y se identifica por el sha256 de su JSON canónico (`src/profile.ts:1@952afb5`); `worker` lleva las plantillas `rules`, `investigate`, `implement` (`src/profile.ts:22@952afb5`) y `Profile.worker` es `WorkerTemplates` (`src/profile.ts:16@952afb5`).
- **Baseline:** perfil `5b2122cd` (el actual, sin la instrucción).
- **Candidato:** copia exacta del baseline con `worker.implement` ampliado con el bloque de la spec (`spec.md`). Cualquier otro campo (`rules`, `investigate`, `validators`, `harness`, `model`) idéntico byte a byte. Se importa con `saveProfile`, que es idempotente y direccionado por contenido (`src/profile.ts:74@952afb5`).
- Tipo de cambio: perfil. Fuera de alcance: código de fab, herramientas nuevas, otros adaptadores.

## Controles (iguales en todos los brazos)
- Agente `claude`, con las herramientas permitidas actuales, que ya incluyen `Read`, `Grep` y `Glob` (`src/agents.ts:49@952afb5`); no se añade ninguna herramienta.
- `ANTHROPIC_MODEL=claude-haiku-5-5`, mismo `fab_sha` 952afb5, misma suite y mismo sha de suite.
- Mismo orden de tareas y emparejamiento: cada corrida pareada ejecuta la misma tarea en los tres brazos (candidato, baseline, baseline_rep).
- Los brazos se intercalan en el tiempo, no por bloques, para que la deriva del proveedor no se confunda con el brazo.

## Métricas
- **Primaria:** `costUsd` por tarea. Lo reporta el CLI de claude (`AgentUsage.costUsd`, `src/agents.ts:12-16@952afb5`; lo extrae `parseClaudeJson`, `src/agents.ts:60@952afb5`). Se resume con **mediana e IQR** por brazo.
- **Guardianas:** `exito_verify` (el candidato ≥ baseline) y `diffLines` (informativa: no debe crecer de forma notable; una instrucción que hace editar a ciegas se vería aquí).
- **Dato informativo:** `integrity_ok` en cada corrida (no decide).
- **Ruido:** |mediana(baseline) − mediana(baseline_rep)|.

## Diseño de la medición
- `improve` con `--repeated-baseline`: ≥10 corridas pareadas por brazo (candidato, baseline, baseline_rep). Con 12 tareas y 3 grupos (python-feature, python-fix, ts-locate) una pasada por tarea ya da 12 corridas por brazo; se recomienda 2 pasadas (24) para estrechar el IQR.
- Todas las tareas con `group`, ≥3 grupos (condición del tier).
- Presupuesto del ciclo: ≤ 4 h y ≤ 10 USD. Referencia de coste: 0,02235 USD por tarea en baseline T0 (n=5, sd 0,0015) y 0,0350 en `ts-locate-rule`; 3 brazos × 24 corridas × ~0,03 ≈ 2,2 USD.

## Regla de decisión (T1)
- `ACCEPT` solo si se cumple todo: IQR de candidato y baseline **no solapados**; mejora en la dirección de la predicción (coste menor) y **mayor que el ruido**; éxito del candidato ≥ baseline. Se escribe `T1 candidato: …`.
- Si el IQR solapa o la mejora no supera el ruido: `INCONCLUSIVE(filtrado)`.
- Si el coste sube o el éxito cae por debajo del baseline: `REJECT`.
- La predicción de −20 % es la expectativa; la regla T1 no exige alcanzarla, exige separación y superar el ruido. Se informa también el % real.

## Qué dice y qué no dice la evidencia previa
- ADR-0008 revisó la decisión 2: para localizar y seguir llamadas, la herramienta principal es la búsqueda agéntica con `rg` y lectura de tramos (`docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:31@952afb5`). En opencode, A2 acertó 5/5 con ~42 k tokens frente a ~9,5 M del repo (`docs/research/arquitectura-ideacion/adr/ADR-0008-probe-por-tipo-de-fuente.md:72@952afb5`).
- Pero ese ahorro se midió en **repos enormes** y en bytes de salida de herramientas, no en coste del modelo: «No medido: tokens propios de cada modelo» (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:77@952afb5`).
- En Sonnet, que ya buscaba con precisión, el ahorro de bytes fue solo −11 % (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:44@952afb5`), y la varianza entre sesiones era mayor que el efecto (`docs/research/arquitectura-ideacion/codesearch/medicion/a2-vs-a2g.md:53@952afb5`).
- Riesgo propio de esta suite: las tareas apuntan a un único archivo ya nombrado (`calc.py`, `src/adf.ts`). Leerlo entero cuesta poco, así que el ahorro de entrada puede ser pequeño, y una instrucción extra añade tokens de prompt y turnos. El efecto puede ser nulo o positivo en coste; por eso la regla exige superar el ruido.

## Fuera de este tier
(No forma parte de la receta medible.) Si T1 da `INCONCLUSIVE(filtrado)` por solapamiento de IQR o por n pequeño, el diseño siguiente sería un tier de confirmación con:
- ≥30 corridas pareadas por brazo y estadístico pareado (diferencia por tarea, intervalo de confianza por bootstrap) en lugar de solo IQR;
- tareas donde localizar importe de verdad: archivos grandes o varios candidatos homónimos, no archivos de ~100 líneas;
- medición de tokens de entrada, de salida y número de turnos por separado para atribuir el efecto al mecanismo (menos lectura de archivo entero) y no a un cambio de longitud de respuesta;
- un brazo de control con instrucción de longitud equivalente pero sin contenido de búsqueda, para separar el efecto del texto adicional del efecto de la técnica.
