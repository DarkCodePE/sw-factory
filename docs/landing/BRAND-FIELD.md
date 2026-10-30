# Marca y campo del hero

Base: origin/main 61be04e. La cabeza de castor es un SVG geométrico original,
con ojos, hocico y dos incisivos; conserva el wordmark propio. El circuito
anterior permanece como motivo de fondo. Header y footer usan el lockup;
el tercer castor es el nodo decorativo de la sesión, receptor del campo del hero.
No hay ranura de mascota independiente. El favicon conserva los incisivos a 16 px.
La imagen social es una composición propia, no un recurso externo.

El canvas precalcula ocho cables de puntos al cambiar el tamaño. Los paquetes
llegan con desfase y el receptor ilumina su borde al final de cada recorrido.
No representa datos de actividad. Dibuja como máximo 30 veces por segundo;
DPR máximo 2. IntersectionObserver y visibilitychange cancelan requestAnimationFrame.
Movimiento reducido repinta el estado estático al iniciar, redimensionar o cambiar
el tema; no mantiene un bucle. La transparencia acotada protege el texto incluso
sobre el paquete más brillante y el gradiente radial simultáneamente.

Se reparó el nombre de clase del panel Productos, se eliminó una llave CSS
sobrante y se usa un único breakpoint de navegación: 56 rem. Menú móvil y barra
de escritorio son mutuamente excluyentes; Productos abre con hover o foco.

## Fuentes y construcción

Sin dependencias nuevas. Las dos fuentes legibles quedan fuera del árbol servido:

```sh
bun build docs/landing/app.source.js --target browser --minify --outfile site/app.js
bun build docs/landing/modules.source.js --target browser --minify --outfile site/modules.js
```

`modules.source.js` conserva el controlador preexistente. Minificar su copia
servida permite sumar el fondo manteniendo el límite conjunto de 10.000 bytes:
7.130 + 2.868 = **9.998 bytes**. La lista explícita de Pages incorpora el OG;
`pages-artifact-marca.json` registra los 17 archivos y sus hashes, preparados
localmente con el bloque exacto del workflow, sin publicar.

## Verificación

Chrome 152, servidor con prefijo `/sw-factory/` en 8774:

- `verify-v2.mjs`: **118 checks**, exit 0.
- `verify.mjs`: **51 checks**, exit 0; ambos temas, 320–1920 px, teclado,
  texto al 200 %, sin JavaScript, recursos locales y contraste.
- `git diff --check`: exit 0.
- Capturas examinadas a 390/1440 en claro/oscuro y favicon a 16/64 px.
- Observación de 7 segundos: receptor varía entre 0 y 0,95; DPR solicitado 3
  queda en 2; percentil 95 de intervalos RAF: 16,7 ms en esta máquina.
  Es una medición local, no una garantía de rendimiento.
- El gate comprueba contador estable en reduced motion, fuera de pantalla y
  al enviar visibilitychange con document.hidden simulado. No equivale a probar
  la suspensión de una pestaña por cada sistema operativo.
- Detector impeccable ejecutado: exit 2, 80 avisos. Incluye resolución estática
  incorrecta de tokens entre temas, jerarquía de títulos, padding y la grilla
  preexistente de la terminal. No se presenta como gate aprobado: el contraste
  renderizado se comprueba en navegador y el fondo añade un límite conservador
  de composición sobre el texto del hero. Los avisos de estructura previos no
  se corrigen dentro de este cambio de marca.

La revisión de construcción Ronda 2 y sus fallos de comandos/transferencias
permanecen en el informe externo; esta rama no afirma resolverlos. No se modifican
runtime, tests, manifiesto de dependencias ni changelog. Sin promesas nuevas de
precio o autonomía, ni datos decorativos inventados.
