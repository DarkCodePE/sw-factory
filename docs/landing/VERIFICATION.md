# Verificación de la landing

La página no necesita Node ni paquetes para ejecutarse. Estas herramientas son
opcionales y solo se usan para verificarla; no cambian el manifiesto raíz.

Se utilizó Chrome del sistema y `puppeteer-core` instalado en
`/tmp/fab-landing-tools`, fuera del proyecto. Para repetirlo:

```sh
npm install --prefix /tmp/fab-landing-tools --no-audit --no-fund puppeteer-core
python3 -m http.server 8769 --bind 127.0.0.1 --directory site
```

En otra terminal, desde la raíz del repositorio:

```sh
HALLMARK_PUPPETEER=/tmp/fab-landing-tools CHROME_PATH=/usr/bin/google-chrome \
  node docs/landing/verify.mjs
```

El script comprueba ambos temas en 320, 375, 390, 768, 1024, 1280, 1440 y 1920 px;
contraste de texto, controles y foco; anclas; capacidades futuras; selector por
teclado y toque sintetizado; portapapeles con ejecutor simulado; almacenamiento
denegado; movimiento reducido y lectura sin JavaScript. Bloquea y registra cualquier
petición a terceros. Genera capturas completas y del hero a 1440×900 y 390×844 en
`site/screenshots/` (escala 1).

`LANDING_URL` permite cambiar la URL local. `HALLMARK_PUPPETEER` señala el directorio
que contiene `node_modules/puppeteer-core`; `CHROME_PATH`, el navegador instalado.

Las capturas prueban el render de Chromium y viewports emulados; no equivalen a
pruebas con lectores de pantalla, dispositivos físicos ni otros motores. Los
casos de portapapeles simulan éxito, rechazo y fallback; no verifican el
portapapeles del escritorio del usuario. Los enlaces externos no se navegan.

El informe completo de la ronda vive fuera del worktree:
`/home/orlando/Desktop/factory/doc/droid-re/report-codex-landing.md`.

Segunda pasada: 49 controles, incluidos reproducción, pausa explícita y temporal
por hover/foco, reanudación, resultado final y tema del iframe. Las capturas se
toman con movimiento reducido para fijar el estado final, esperando el documento
y las fuentes del iframe; eso evita publicar un hueco de carga como captura.

## Pages bajo el prefijo real

El workflow tiene una lista de 14 archivos públicos (15 con CNAME opcional). Se
analizó su YAML con Bun y se ejecutó el bloque Prepare public files sin cambios:
el inventario y los hashes están en pages-artifact.json. Se verificaron exclusión
de capturas/README/cachés/recibos, copia opcional de CNAME en fixture aislado y fallo
si falta app.js. Ningún paso de upload/deploy se ejecutó localmente.

El artefacto resultante se sirvió con:

```sh
python3 docs/landing/serve.py --prefix /sw-factory/ --port 8770 --directory /tmp/fab-landing-pages-public
LANDING_URL=http://127.0.0.1:8770/sw-factory/ HALLMARK_PUPPETEER=/tmp/fab-landing-tools node docs/landing/verify.mjs
```

Los 50 controles de pages-browser-checks.json pasan: ninguna respuesta HTTP fallida,
ninguna petición externa ni error JS. Las ocho capturas de claro/oscuro reproducen
los mismos bytes que en la raíz; favicon, CSS, JS, SVG, transcripción y diagramas
funcionan bajo el prefijo. El servidor devuelve 404 fuera de /sw-factory/.

La revisión independiente de Pages no halló problemas funcionales dentro del
alcance local/configuración. No se habilitó Pages ni se hizo push o despliegue.
La ejecución alojada queda pendiente de la configuración y acción del propietario.

Validación final después de añadir Pages: `bun test --max-concurrency=4` terminó
con 602 pass, 0 fail (67 archivos, 199.61 s); TypeScript terminó con código 0 y
ambos diff checks quedaron limpios. Una ejecución intermedia obtuvo 601/1 en
`tests/agent-script-durable.test.ts:55` al recibir `completed` en vez de la
observación parcial esperada; el caso pasó aislado y después pasó la suite completa.
No se modificaron ni omitieron tests, ni se tocó el código del producto.
