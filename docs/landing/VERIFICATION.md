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
