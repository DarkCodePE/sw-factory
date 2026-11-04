**Dictamen propuesto: REJECT.** El paquete presenta una contradicción en la definición del baseline y la medición no cumple el diseño prescrito. No permite aceptar la predicción de ahorro del 20 %.

1. **Baseline definido de dos formas incompatibles.**
   - `goldfish/receta.md:16`, campo **Perfil baseline**, valor **«el por defecto, digest 2dff534e»**.
   - `goldfish/spec.md:15` exige modificar `harness` y `model` en ambos perfiles y reconoce que el baseline puede cambiar de digest.
   - `goldfish/medicion.json:4`, campo `informe`, registra **`baseline 5b2122cd8fa2`**.
   
   La receta fija un baseline que la spec sustituye y la medición no utiliza. Este es un defecto concreto y verificable del paquete. Debe unificarse la definición y documentarse la correspondencia entre los perfiles utilizados.

2. **La muestra reportada no satisface la receta.**
   - `goldfish/receta.md:20–21` exige al menos **5 tareas × 5 ejecuciones por tarea y brazo**: mínimo **25 ejecuciones por brazo**.
   - `goldfish/medicion.json:9` y `:16`, campo `n`, valor **5** en ambos brazos; `coste_n` también es **5** (`:11`, `:18`).
   
   Si esos cinco elementos fueran agregados, faltaría el desglose que demostrase las repeticiones exigidas. Con lo entregado no puede acreditarse el diseño.

3. **La regla de decisión está incompleta.**
   - `goldfish/receta.md:30–32` no clasifica inequívocamente un ahorro inferior al 20 % que supere la dispersión.
   - «El efecto supera la dispersión» carece de procedimiento definido; el umbral de `diffLines` es solo **«sugerido ±25 %»** (`:26`).
   
   La receta permite plantear la prueba, pero necesita cerrar esas reglas antes de ejecutarla.

**Citas `archivo:línea@sha`.** No verificables con este paquete: los cuatro archivos autorizados no incluyen las fuentes citadas ni sus contenidos en `2bed96f`. Las referencias son trazables en su forma, pero no puedo certificar que sostengan las afirmaciones. Esto es una limitación de evidencia, no prueba de citas falsas.

**Conclusión admisible a T0.** Los costes reportados son **0,0223 USD** para baseline y **0,0242 USD** para candidato: el candidato cuesta aproximadamente **8,5 % más**. El coste total declarado, **0,2325 USD**, cuadra con esas medias y cinco observaciones por brazo.

Ese resultado descriptivo va en dirección contraria a la predicción. Sin dispersión de costes, observaciones individuales y cumplimiento acreditado del diseño, el efecto general queda **INCONCLUSIVE**. La receta propone contrastar la hipótesis; la medición entregada no la sostiene.