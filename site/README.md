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

Publicación: `.github/workflows/pages.yml` prepara solo los 14 archivos públicos
necesarios, sube el artefacto y despliega mediante las acciones oficiales fijadas
por SHA. Se ejecuta al modificar `site/**` en `main` o al lanzarlo manualmente sobre
`main`; usa el entorno `github-pages`. Excluye capturas, README, cachés y recibos
JSON. El propietario debe elegir GitHub Actions como origen de Pages en Settings;
el workflow tiene `enablement: false` y no activa esa configuración. La URL prevista
es <https://darkcodepe.github.io/sw-factory/>. Véase la
[guía de workflows de Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

Para añadir un dominio propio más adelante, puedes guardar solo el hostname en
`site/CNAME` (el empaquetado lo copiará), registrar ese dominio en Settings → Pages →
Custom domain y después configurar el DNS. En despliegues por Actions, GitHub no
usa `CNAME` para configurar el dominio: el ajuste en Settings es necesario. Para un
subdominio, el registro DNS CNAME apunta a `darkcodepe.github.io`, sin `/sw-factory/`.
Sigue la [guía oficial de dominios](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).
No se ha creado ningún CNAME ni cambiado la configuración remota.

Para comprobar la ruta de proyecto en local, desde la raíz:

```sh
python3 docs/landing/serve.py --prefix /sw-factory/ --port 8770
```

Abre <http://127.0.0.1:8770/sw-factory/>. `--directory` permite servir el artefacto
preparado en vez del árbol de trabajo. CSS, scripts, SVG, favicon, transcripción y
diagramas usan rutas relativas y sirven tanto bajo este prefijo como en `/`.
