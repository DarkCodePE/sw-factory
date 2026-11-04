# Dictamen del crítico goldfish: 2026-11-03-C4b-busqueda-acotada-01

## 1. Veredicto propuesto: **INCONCLUSIVE**

- **Qué dice la medición.** El candidato cuesta más que el baseline: 0,0242 frente a 0,0223 USD, es decir +8,5 %. La predicción era −20 %. Por la regla de decisión de la receta («Refuta: costUsd sin cambio o mayor»), el dato apunta a refutar.
- **Por qué no puedo aceptar ni rechazar.** El tier es `T0`, y el diseño medido no es el que la receta exige.
  - La receta pide al menos 5 tareas, con `add-subtract` más 4 de mayor tamaño, y n ≥ 5 por tarea y brazo. Eso son al menos 25 ejecuciones por brazo.
  - La medición tiene una sola fila por brazo: `split=development`, n=5. No hay desglose por tarea y no consta qué tareas se corrieron.
  - Tampoco hay dispersión del coste: `medicion.json` no trae varianza de costUsd, solo `var(éxito)` y `var(diff)`. La regla exige que el efecto supere la dispersión entre repeticiones, y eso no se puede comprobar.
  - Hay una sola semilla y un solo lote (`mw10ijei:1442242062`), y ningún split de validación.
- **Consecuencia.** La medición no respalda ninguna conclusión de soporte ni de refutación a `T0`. Sirve como señal exploratoria: no hay indicio de ahorro y sí uno débil de sobrecoste, coherente con el riesgo que declaran la receta y la spec («en tareas pequeñas el coste puede subir»).

## 2. Defectos encontrados

### D1 (candidato principal al defecto plantado): el campo de éxito de `medicion.json` es incoherente

- **Evidencia.** En `medicion.json`, `informe`, la fila baseline es: `development baseline 5 0.750 0.000 70.3 29.6 57.0 0.0223`.
  - `éxito = 0.750` con `n = 5`, y `var(éxito) = 0.000`.
  - Si el éxito de cada ejecución es binario, una media de 0,75 con n=5 es imposible. Con n=5 solo salen múltiplos de 0,2.
  - Una varianza de 0,000 con media 0,75 también es imposible en ese caso. Una media de 0,75 exige valores mixtos, y eso da varianza > 0.
  - La única lectura compatible es que cada ejecución tenga éxito fraccionario idéntico (0,75 en las cinco). Eso no está documentado, y la guardiana `exito_verify` («tolerancia 0 fallos extra») supone fallos discretos.
- **Efecto.** La guardiana no es interpretable.
  - El candidato muestra éxito 1,000, aparentemente mejor, pero con `var(éxito)=0.000` no hay evidencia de que la diferencia 0,75→1,00 sea real.
  - No puedo distinguir un campo corrupto de uno mal definido. Marco D1 como el defecto plantado más probable, con confianza media.

### D2: el diseño medido incumple el diseño de la receta

- **Evidencia.** `receta.md` («Diseño») pide la `add-subtract` más al menos 4 tareas grandes, con n ≥ 5 por tarea y brazo. `medicion.json` trae `filas[2]` con n=5 en total por brazo y una sola fila `development`.
- **Efecto.** Las 5 ejecuciones no pueden cubrir 5 tareas con n=5 cada una. Es probable que sean 5 repeticiones de una sola tarea, o que el diseño no se haya cumplido. Si es lo primero, será la tarea pequeña, justo donde la receta ya avisa de que el párrafo extra puede costar más de lo que ahorra.

### D3: sin dispersión de coste, la regla de decisión no se puede aplicar

- **Evidencia.** Las columnas de `medicion.json` son `var(éxito)` y `var(diff)`, y no hay varianza de `costUsd`. `receta.md` («Regla de decisión») exige que «el efecto supere la dispersión entre repeticiones».
- **Efecto.** La diferencia de 0,0019 USD, con baseline de referencia 0,0224 (n=2: 0,0218 y 0,0229), está dentro del rango que ya se veía entre dos ejecuciones iguales. No se puede afirmar que sea real.

### D4: el digest del baseline difiere del declarado y no queda trazabilidad completa

- **Evidencia.**
  - `canonical.md`, `limitacion_actual`, da el perfil por defecto como `2dff534e`.
  - `medicion.json` informa `baseline 5b2122cd8fa2` y `candidate 41d3dc19bea4`.
- **Matiz.** `spec.md`, paso 1, permite este cambio: fijar `harness` y `model` en ambos perfiles altera el digest. Pero la spec manda registrar ambos digests, y en el paquete no hay ningún registro que enlace `5b2122cd8fa2` con `2dff534e`. Tampoco hay `fab_sha` en `medicion.json`. No es un fallo de por sí, pero la procedencia queda sin verificar.
- **Comparación con la línea base.** El baseline remedido (0,0223) coincide con la referencia (0,0224), lo que es coherente. La referencia es la media de n=2 (0,0218 y 0,0229 dan 0,02235), así que 0,0224 es un redondeo válido.

### D5: posible incoherencia entre el harness por defecto y la línea base (no concluyente)

- **Evidencia.** `spec.md` dice que el perfil por defecto tiene `harness: 'native'`. `canonical.md` presenta el baseline como «agente claude… perfil por defecto 2dff534e».
- **Efecto.** Podría ser la misma incoherencia que explica D4, o una descripción imprecisa de la línea base. Lo señalo como duda y no como defecto probado.

## 3. ¿La receta sostiene la predicción de −20 %?

**No.** La propia receta lo reconoce: «el mecanismo es plausible, pero no está probado para costUsd del worker. El −20 % es una hipótesis».

- Las citas a `a2-vs-a2g.md:29` y `:77` dicen que lo medido son bytes de herramientas y que no se midieron los tokens del modelo.
- Según `a2-vs-a2g.md:3` y `:53`, había una ejecución por celda y la varianza entre sesiones superaba al efecto.
- Según `a2-vs-a2g.md:68`, el brazo con grafo perdió acierto en 2 de 3 sujetos.
- La evidencia viene de agentes que exploran repos de millones de tokens (opencode, deer-flow), no de un worker que edita tareas pequeñas.
- El −20 % no se deriva de ningún número del paquete. Es una cifra de partida, no una predicción calculada.

## 4. ¿Las citas `archivo:línea@sha` sostienen lo que dicen?

Con la restricción de leer solo `/tmp/goldfish-lAJy`, **no puedo abrir ninguna de las fuentes citadas**: ADR-0008, `a2-vs-a2g.md`, `src/profile.ts` y `src/agents.ts` a `2bed96f`. Sobre las citas solo puedo afirmar lo siguiente:

- **Coherencia interna.**
  - Lo que se atribuye a cada cita es plausible y encaja con las limitaciones que la propia receta declara.
  - Las citas son consistentes entre `receta.md` y `spec.md`. Por ejemplo, `src/profile.ts:37` define el perfil por defecto y `:60` valida el límite de 32 KiB.
- **Nada verificado.** No he comprobado ninguna línea contra su contenido real.
- **Una cita con tensión.** Esta es la tensión que veo en las citas:
  - `src/agents.ts:49` se usa tanto para «permite Read, Grep y Glob» (receta) como para «Read, Edit, Write, Glob, Grep» (spec).
  - Es consistente solo si la línea lista las cinco herramientas.
- **Advertencia ya declarada.** `receta.md` avisa de que el árbol de trabajo tiene cambios sin commitear en `src/agents.ts`, y las citas son a `2bed96f`. Las líneas citadas de ese archivo podrían no coincidir con lo ejecutado.

## 5. ¿La medición respalda alguna conclusión a `T0`?

**Ninguna.**

- n=5 en un solo split y una sola semilla.
- No hay desglose por tarea.
- No hay dispersión de costUsd.
- La guardiana de éxito es incoherente (D1).
- El gasto total fue de 0,2325 USD, que es 5×0,0223 + 5×0,0242 exactamente. Está dentro del presupuesto de 5 USD, así que no hay problema de presupuesto, pero tampoco hay base para promover nada.

## 6. Resumen

| Defecto | Dónde | Valor |
|---|---|---|
| D1 (principal) | `medicion.json`, `informe`, fila baseline | éxito 0.750 con n=5 y `var(éxito)` 0.000: imposible con éxito binario |
| D2 | `medicion.json` frente a `receta.md` | n=5 total y una sola fila, frente a ≥5 tareas con n ≥ 5 cada una |
| D3 | `medicion.json` | sin varianza de `costUsd` |
| D4 | `canonical.md` frente a `medicion.json` | digests `2dff534e` y `5b2122cd8fa2` sin enlace registrado, y sin `fab_sha` |
| D5 | `spec.md` frente a `canonical.md` | harness `native` frente a «agente claude» (dudoso) |

**Recomendación:** repetir la serie con el diseño completo de la receta. Eso implica 5 o más tareas, n ≥ 5 por tarea y brazo, dispersión de costUsd y una guardiana de éxito bien definida. Hasta entonces, no se promueve el perfil.
