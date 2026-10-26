# Landing de fab

Sitio estático en español, sin framework ni dependencias de ejecución.

Desde la raíz del repositorio:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

Abre <http://127.0.0.1:8000>. También se puede abrir `index.html` directamente;
si el navegador restringe el portapapeles, el comando sigue siendo seleccionable.

Los dos comandos permanecen visibles sin JavaScript. Con JavaScript hay selector
de instalación, copia con recuperación de errores y tema claro/oscuro persistente.
El logo y favicon oficiales se sirven desde `assets/brand/`; cambian con el tema.
No hay formularios, analítica, fuentes remotas ni peticiones a terceros. Los enlaces
externos solo se visitan al activarlos.

La propuesta gestionada es un borrador sin captación. Las capacidades futuras se
marcan «Próximamente». OpenRouter y Gemini se describen como compatibles mediante
endpoint OpenAI, con integración no verificada.

Las capturas reales de Chrome están en `screenshots/`, en ambos temas y tamaños
de escritorio/móvil. Los documentos de producto, diseño y verificación están en
[`docs/landing/`](../docs/landing/), fuera del directorio servido.

Para repetir los controles del navegador, consulta
[`docs/landing/VERIFICATION.md`](../docs/landing/VERIFICATION.md).

La terminal reproduce salida capturada del CLI con fixtures de Jira y workers.
Se pausa al pasar el puntero, entrar con teclado, ocultar la pestaña o salir de
pantalla. Con movimiento reducido muestra el resultado final sin animar;
[`demo-session.txt`](demo-session.txt) conserva la transcripción abreviada.
El flujo y la arquitectura interactivos están en `diagrams/`, generados con Archify.
