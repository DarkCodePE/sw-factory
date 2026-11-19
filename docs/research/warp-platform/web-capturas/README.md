# Recorrido de fab web

[V] Datos sintéticos, con actor `demo`, repos inexistentes `/repo/demo` y `/repo/docs`, y base temporal propia. No se usaron bases personales ni capturas de Warp.

[V] Veinte capturas: `{bandeja,workstreams,changes,change,activity}-{1440,390}-{light,dark}.png`. Escritorio: 1440 × 1000; móvil: 390 × 844. Las capturas son de página completa; los bloques de evidencia tienen su propio desplazamiento vertical.

[V] `recorrido.json` registra cada ruta, anchura de documento, tema, consola y errores del recorrido final. Consola y errores vacíos en los veinte casos. La tabla de changes se desplaza dentro de su contenedor en móvil.

[V] `contraste.json` contiene los cocientes WCAG de texto, enlaces y estados sobre las tres superficies de ambos temas. Mínimo medido: 5,53:1. Los estados también llevan texto.

[V] Se comprobaron además la búsqueda mediante el formulario GET y el sondeo: un change añadido a la base temporal apareció sin recargar la página. La sesión de agent-browser fue `fabweb`; necesitó `--args "--no-sandbox"`. Navegador y servidor se cerraron al terminar.

[I] Estas pruebas visuales y el cálculo de contraste no equivalen a una auditoría completa de accesibilidad con lector de pantalla.
