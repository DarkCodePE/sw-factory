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

## Ronda landing v2 — Contrato A (2026-10-26)

La rama se sincronizó con `origin/main` (`f741712`) antes de validar. Para repetir
la verificación propia del explorador, con Chrome y Puppeteer preparados como arriba:

```sh
python3 docs/landing/serve.py --prefix /sw-factory/ --port 8772
node docs/landing/verify-v2.mjs
```

La ejecución local terminó con código 0: 76 controles, 9.076 bytes de JavaScript
combinado, sin errores JS, respuestas fallidas ni solicitudes externas. El recibo
actual está en `modules-browser-checks.json`; las capturas cubren claro/oscuro a
390 y 1440 px. El inventario v2 de Pages contiene 16 archivos públicos.
`bunx tsc --noEmit -p .` y `git diff --check` terminaron con código 0, sin salida.

La primera suite `bun test --max-concurrency=4` terminó con código 1: 750 pass,
1 fail, 4.160 expect, 751 pruebas en 77 archivos (225,98 s). El único fallo fue
el timeout de 30 s en el caso de 10.000 registros de `tests/agent-journal.test.ts`.
Había otra suite Bun ejecutándose en la máquina. El archivo pasó aislado con
código 0: 8 pass, 0 fail, 51 expect (31,11 s). No se modificaron ni omitieron tests.

Una segunda suite completa, sin la otra suite Bun, terminó con código 1:
750 pass, 1 fail, 1 error, 4.160 expect, 751 pruebas en 77 archivos (221,93 s).
Se repitió el mismo timeout y apareció un ENOENT posterior del journal temporal
del caso vencido. No se modificaron `src/**` ni `tests/**` para resolverlo.

El 2026-10-27 el orquestador repitió las pruebas en este worktree con los demás
agentes quietos y comunicó estos resultados: `bun test tests/agent-journal.test.ts`
dio 8 pass, 0 fail en 22,78 s; `bun test --max-concurrency=4` dio 751 pass, 0 fail,
4.163 expect, código 0 en 202,95 s. Esta evidencia cumple el gate pendiente.
El caso aislado conserva unos 7 s de margen contra su límite de 30 s: se registra
como limitación conocida del gate local bajo carga. El orquestador también
comprobó que los cuatro commits originales no modifican `src/**` ni `tests/**`.

Esta ronda verifica Chromium local y viewports emulados. No verifica despliegue
alojado en Pages, otros motores, dispositivos físicos ni lectores de pantalla.
Los informes anteriores de diseño y del verificador general se conservan como
evidencia histórica; no se presentan como ejecuciones nuevas de esta ronda.
