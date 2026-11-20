# Evidencia de F3

[V] Capturas sintéticas de `/metricas?range=all`, 1440 × 1000 y 390 × 844, en ambos temas. Se inspeccionaron las cuatro imágenes finales. `recorrido.json` conserva dimensiones, temas, ausencia de scripts, consola/errores y la URL final del formulario con workstream motor y rango 7.

[V] Todas las tablas conservan sus valores en texto. En móvil las tablas anchas tienen desplazamiento interno; la página completa no desborda. Las barras conservan etiquetas de 14 px a 390 px. El detector de Impeccable dio `[]`.

[V] `rendimiento.json`: cinco muestras finales con 1000 changes, 1000 activities, 2750 eventos y 1000 ficheros de evidencia (59 663 bytes). Mediana del cálculo: 226,91 ms. Mediana de petición HTTP completa: 231,76 ms. Base cerrada; apertura readonly incluida en las peticiones HTTP. Es una medición local con caché de disco caliente, no un SLA.

[V] `mutaciones.json`: cuatro mutaciones muertas; copia restaurada, nueve tests pasan. El directorio temporal listado se eliminó.

Reproducción desde la raíz del worktree (solo datos desechables):

```sh
bun docs/research/warp-platform/web-capturas-f3/fixture.ts --bench
python3 docs/research/warp-platform/web-capturas-f3/mutaciones.py
# Para recorrido manual: iniciar fixture.ts sin --bench en una terminal propia.
# Publica el puerto temporal en /tmp/webf3-manual.json.
# Con la fixture viva:
python3 docs/research/warp-platform/web-capturas-f3/capturas.py
agent-browser --session fabf3 close
# Terminar la fixture con SIGTERM o Ctrl+C para retirar sus datos.
```

[V] No se usaron bases personales. No se lanzaron subagentes; el recorrido visual es comprobación propia del implementador, pendiente de verificación independiente.

<!-- FIN -->
