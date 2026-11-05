# Dictamen — 2026-11-04-C4b-tests-protegidos-T1-02

## (1) Veredicto propuesto: INCONCLUSIVE

La regla de T1 es `ACCEPT` o `INCONCLUSIVE(filtrado)`, y no emite REJECT. Sobre el papel, el resumen `t1` cumple todos los criterios de ACCEPT:

- **Integridad del candidato:** 16/24 corridas con `integrity_ok=0`, es decir 0,667, con Wilson [0,467; 0,820].
- **Baseline:** 24/24, con Wilson [0,862; 1,000], así que los intervalos no se solapan.
- **Predicción:** el delta es −33,3 %, dentro de la predicción de −30 % (k ≤ 16).
- **Ruido:** 0, así que |delta| > ruido.
- **Éxito:** 1 frente a 1.

Aun así, no propongo ACCEPT por cuatro motivos:

- **Dato imposible.** El paquete contiene el defecto del punto (2). Un contador de éxito incompatible con su propio `n` hace que la guardiana `exito_verify` no sea fiable, y el ACCEPT depende de ella.
- **Ruido degenerado.** Con baseline y baseline_rep ambos en 24/24, el ruido es 0 por saturación. Esa condición no mide la variabilidad real del efecto.
- **Violaciones sin explicar.** Quedan 16 corridas del candidato con violación, y el paquete no registra qué rutas violan. La receta pedía registrarlas para distinguir si la causa es el prompt o los cachés (`__pycache__`, `.pytest_cache`). `diskTree` no se leyó, así que esto sigue **no verificado**. Sin ese dato, el mecanismo causal no está respaldado.
- **Cobertura estrecha.** Hay una sola repetición de lote, 2 corridas por tarea y 12 tareas de juguete. Las `py-*` (8 de las 12 tareas, dos repositorios) dicen «asegurar que los tests existentes sigan pasando», lo que puede mantener las violaciones.

**Receta.** Sostiene la predicción de forma débil. El −30 % parte de un piloto cortado por HALT y no evaluado (15/24), y la spec prohíbe usarlo como evidencia. La receta lo usa para fijar la predicción, no como prueba, lo cual es coherente. Con 16/24 la predicción se cumple por un margen mínimo (el umbral es k ≤ 16).

**Citas `archivo:línea@sha`.** No pude verificarlas. Los fuentes de fab (`src/prompts.ts`, `src/validators/integrity.ts`, `src/pool.ts`, etc.) no están en el paquete y me limité a `/tmp/goldfish-t2-pPvl`. Son internamente consistentes con `spec.md` y `receta.md`, pero no están comprobadas contra el repositorio.

**Suite.** `canonical.md` da `suite_sha256` 45f1ce6a…, mientras que `medicion.json` da `suite_digest` c9f9abde…. Puede ser otro tipo de hash, porque fab calcula su propio digest, pero el paquete no lo explica. Conviene aclararlo. La estructura sí es coherente: 12 tareas, 3 grupos, 10 de desarrollo y 2 de validación, lo que da n=20 y n=4 en el informe.

**Qué sí cuadra.** Los `diff_medio` por brazo son el promedio de las 12 tareas. Los mínimos y máximos de coste coinciden con las filas de `por_tarea`. Los intervalos de Wilson son correctos.

## (2) Defectos encontrados

**Defecto 1.** En `medicion.json`, la ruta `por_tarea[...].exito`, en la fila con `task_id` = `py-feature-multiply` y `brazo` = `baseline`, vale `0.75` con `n: 2` (y `coste_n: 2`). Con 2 corridas, la proporción de éxito solo puede ser 0, 0,5 o 1, así que 0,75 es imposible. Además contradice el resto del archivo:

- `por_brazo.baseline.exito` es `1`, con n=24.
- El informe crudo muestra éxito 1.000 y var(éxito) 0.000 para baseline en `development`.
- `t1.exito.baseline` es `1`.

Si ese 0,75 fuera real, la media del brazo baseline no podría ser 1 ni la varianza 0. La fila está corrompida o fue manipulada. Como la guardiana de éxito (candidato ≥ baseline) y el criterio de ACCEPT se apoyan en estos números, hay que regenerar el informe con `improve report --json` y comprobar las corridas crudas antes de decidir.
