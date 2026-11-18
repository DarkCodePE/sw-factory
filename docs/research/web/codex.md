# Revisión de la web de fab — Codex

Fecha: 2026-11-12. Código revisado: `/home/orlando/Desktop/factory/sw-factory-web`, rama `fix/landing-rota`, base `8cda6d035b8b1be34bea0793bdd9badb23d07091`. Revisión individual, sin subagentes, push, PR, comentarios ni relanzamientos de Actions.

## Veredicto

**La web publicada usa un artefacto antiguo que omite `pages.css`, Fábrica y Agente; el arreglo de inventario ya está en `main`, pero nunca se publicó porque el workflow solo se dispara al cambiar `site/**`.**

## Tabla de hallazgos

Las rutas de código siguientes son relativas a `sw-factory-web`; las líneas corresponden a la base salvo indicación. Evidencias nuevas en `/tmp/fab-web-codex/`.

| ID | Severidad | Página | Evidencia | Causa raíz | Arreglo propuesto / estado |
|---|---|---|---|---|---|
| WEB-01 | Alta | Portada | `matrix.json`: GET `/sw-factory/pages.css` → 404 en los 8 escenarios. `live-index-light-reduced-1440.png`: rectángulos SVG negros, enlaces legacy visibles y castor gigante en el pie. Comparar `local-index-light-reduced-1440.png`. | `site/index.html:15` referencia la hoja. El inventario de `.github/workflows/pages.yml:51` **en `dfd1288`** no la copia. Reglas perdidas: `site/pages.css:25` (SVG), `:62` (legacy), `:77` (castor). | Publicar el inventario corregido en #37. Ya existe en `main`; no duplicar cambios de CSS/HTML. |
| WEB-02 | Alta | `/fabrica/`, `/agente/` | `matrix.json` y `navigation-verified.json`: HTTP 404 y título `Page not found · GitHub Pages`. Capturas `live-fabrica-light-normal-390.png`, `live-agente-dark-reduced-1440.png`. | El mismo inventario de `dfd1288` omite `fabrica/index.html` y `agente/index.html`. No es un error de `../` ni de mayúsculas. | Publicar el inventario corregido, que ya incluye ambas páginas. |
| WEB-03 | Alta | Publicación | [Run 41363118440](https://github.com/DarkCodePE/sw-factory/actions/runs/41363118440) exitoso para `dfd1288`; no hay run posterior de Pages. `git diff --name-only dfd1288 8cda6d0` devuelve únicamente `.github/workflows/pages.yml`. | `.github/workflows/pages.yml:4-7`: filtro de push limitado a `site/**`. #37 solo cambia el workflow y, por tanto, no provoca publicación. `success` solo garantiza la copia y despliegue del inventario declarado, no la integridad de sus referencias. | **Arreglado localmente** en `e90656d`: añadir el propio workflow al filtro. Al integrarse en `main`, ese cambio podrá disparar Pages con el inventario de 20 archivos. No se ha publicado. |
| WEB-04 | Baja | Diagramas abiertos directamente | `diagrams.json`: 404 a `https://darkcodepe.github.io/favicon.ico`; también a `http://127.0.0.1:8775/favicon.ico` en la réplica con prefijo. El diagrama sí carga y funciona. | `site/diagrams/sdlc-workflow.html:3` y `site/diagrams/architecture.html:3`: sus cabeceras no declaran favicon. El navegador busca el icono implícito en la raíz del host, fuera de `/sw-factory/`. | En una pasada posterior, declarar `../assets/brand/favicon.svg` en ambos HTML/generador. No modificado: no causa la rotura de las páginas. |

Los desbordamientos y dos ratios bajos de contraste de las páginas 404 de GitHub a 390 px son efectos de WEB-02, no defectos del HTML local de fab. No los cuento como fallos adicionales del producto.

## Despliegue

- **Publicado:** `dfd12882904e31224beb9f04b53fe7a20a59336c`, merge #36. Run `41363118440`, evento `push`, creado el **2026-11-01 23:38:48 UTC**; deployment `7480877886`, estado `success` a las **23:39:04 UTC**. El log descargado tras repetir una consulta que falló por timeout TLS confirma `Prepared 17 public files` (`deploy.log:161`).
- **`main` remoto:** `8cda6d035b8b1be34bea0793bdd9badb23d07091`, merge #37, **2026-11-02 05:12:13 UTC**, verificado con API de commits y `git ls-remote`.
- #37 integra `4aa030e`, que añade exactamente los tres archivos omitidos al inventario. No cambia `site/`; por eso no pasa el filtro. No hay un despliegue fallido posterior que arreglar: **no hubo disparo**.
- Pages está configurado con `build_type: workflow`, URL `https://darkcodepe.github.io/sw-factory/`. El entorno y los permisos sí permitieron el despliegue anterior.
- La preparación local del workflow actual produce **20 archivos**, idénticos byte a byte a `site/`. Las **136 referencias locales** detectadas en HTML/CSS del artefacto resuelven. `screenshots/`, README y recibos se excluyen deliberadamente; las páginas no requieren screenshots para funcionar. `site/assets/fab-mascot.svg` tampoco aparece como dependencia de las páginas servidas.
- Comprobación HTTP adicional de los 20 archivos del inventario actual: **17 responden 200 y sus hashes coinciden con los locales**; los otros tres son exactamente las páginas hijas y `pages.css`, que responden 404 (`assets.json`). Dos consultas de marca tuvieron timeout TLS y se resolvieron al repetirlas.
- Las rutas relativas funcionan tanto en `/` como en `/sw-factory/`, incluidas páginas hijas, marca y diagramas. La excepción menor es el favicon implícito de los diagramas (WEB-04).

**La producción sigue rota al terminar esta tarea:** el commit de arreglo está solo en la rama local. Integrarlo y verificar el nuevo despliegue corresponde a una acción posterior; no he cambiado `main` ni ejecutado `workflow_dispatch`.

## Pruebas de navegador y restricciones

Motor: Google Chrome **152.0.7977.82**, headless. Se usó **agent-browser 0.27.0** disponible en la caché local y Chrome del sistema; no se presentan las comprobaciones históricas como pruebas de hoy.

| Prueba nueva | Resultado |
|---|---|
| Tres páginas × producción/local × 1440×900 / 390×844 × claro/oscuro × movimiento normal/reducido | **48 capturas**; datos en `matrix.json`. Los 24 escenarios locales no muestran errores HTTP, excepciones JS, peticiones externas, desbordamiento horizontal ni fallos del comprobador de contraste de texto. |
| Portada publicada | HTML, controladores y marca cargan; falta `pages.css`. No aparecen excepciones JS en el colector; los 404 quedan demostrados por la red. |
| Páginas de producto publicadas | 404 en los 16 escenarios; no se puede evaluar allí el runtime de módulos de fab porque esos documentos no están desplegados. |
| Diagramas SDLC y arquitectura | **16 capturas** adicionales: producción y artefacto local, ambos temas y tamaños, movimiento reducido. Documento 200, SVG presentes, tema aplicado, cero animaciones CSS/WAAPI en ejecución y cero excepciones JS. Sin solicitudes externas; favicon implícito 404 en las muestras indicadas. |
| Navegación real con clic, escritorio y menú móvil | 8 recorridos: las URL son correctas; producción termina en 404, local en `Fábrica \| fab` / `Agente de código \| fab`. `navigation-verified.json`. |
| `verify-v2.mjs` / `verify-shared.mjs` contra el artefacto bajo `/sw-factory/` | **304 controles, código 0**. Incluye verificaciones generales y las interacciones extra; no fue necesario repetirlas con `verify.mjs`, que invoca el mismo verificador sin extras. |

Los 304 controles comprueban temas, contraste calculado, navegación y anclas, lectura sin JS, escalado de texto al 200 % en 320 px, controles de copia con recuperación, teclado del instalador y módulos, escenarios merge/macOS, recorrido automático de módulos, pausa explícita, suspensión de módulos fuera de pantalla y parada al ocultar la pestaña. Con movimiento reducido no hay animaciones CSS/WAAPI en marcha; los módulos conservan explicaciones y estado final. Los ocho paneles SVG se revisan, no solo Jira.

La pausa pertenece ya a los controladores: `site/modules.js:1` cancela su temporizador según IntersectionObserver, `document.hidden` y media query; `site/app.js:1` gobierna terminal, canvas y escenas. Para leer la lógica de app sin minificación: `docs/landing/app.source.js:129`, `:152`, `:197`, `:216` y `:240`. El fondo fijo sigue visible durante el scroll por diseño; no debe confundirse con una escena fuera del viewport.

Se leyó `docs/landing/pages-browser-checks.json`: es evidencia histórica de **50 controles** para una versión anterior. El verificador actual tiene 304 controles y tres páginas; aquel recibo no demuestra que el inventario publicado tras #36 fuese completo.

Impeccable se aplicó como apoyo de revisión técnica, sin rediseño. Su detector estático terminó con código 2 y 108 avisos (`impeccable.json`): 95 de contraste, 1 de texto pequeño, 5 de padding, 1 de jerarquía, 3 de marquee y 3 de cuadrícula. Son señales heurísticas: por ejemplo, infiere texto negro sobre fondos oscuros sin reproducir correctamente las variables/estados del render. No se convierten en 108 defectos confirmados ni en una puntuación WCAG. Las comprobaciones renderizadas de ambos temas pasan; el marquee sí se detiene con hover/foco y movimiento reducido. No se cambiaron colores ni diseño por estas advertencias.

## HyperFrames

### ¿Está causando el fallo?

**No hay referencias a HyperFrames en `site/`, ni coincidencias en las 67 referencias remotas locales examinadas mediante `git grep -i hyperframe`.** La salida completa (vacía) está en `/tmp/fab-web-hyperframes-refs.txt`. El alcance es el contenido de esas referencias existentes, no todos los commits históricos ni ramas remotas no descargadas. La red de las páginas tampoco solicita un runtime HyperFrames. La rotura demostrada es el inventario/desencadenador de Pages.

Leí la tarea y las notas anteriores en `/home/orlando/Desktop/factory/doc/droid-re/`. Contrasté sus conclusiones con el clon local de HyperFrames, HEAD **`a04b45a6db0d1f724be9cf1985c3b13657195f0d`**. Las medidas antiguas de 124.340 bytes/5 s y tiempos de render son de aquella investigación: **no las volví a medir**, ni extrapolo un peso garantizado para otro clip.

### ¿Lo arreglaría o mejoraría las animaciones?

**No arreglaría este incidente.** Primero hay que publicar los archivos que ya funcionan. Los controles actuales y la suspensión de módulos pasan la prueba; sustituirlos introduciría una migración sin necesidad demostrada.

HyperFrames puede mejorar la autoría de un clip narrativo, usando HTML/CSS y render determinista a MP4: `ext/hyperframes/README.md:40`, `:134` y `:246` describen Node 22+, Chrome headless y FFmpeg. Apache 2.0 (`LICENSE`, `README.md:282`); la licencia de cada recurso incorporado sigue siendo responsabilidad del autor.

Matices respecto a las notas anteriores:

- **Sí existe un player en vivo**, componente web con composición en iframe y API `play/pause/seek`: `packages/player/README.md:3`, `:29`, `:137`. Se puede autoalojar; una dependencia npm no implica por sí sola peticiones externas. Tampoco un iframe implica por sí solo inaccesibilidad.
- La ruta habitual de reproducción puede inyectar runtime de CDN: `packages/player/README.md:293` y `packages/player/src/runtime-url.ts:13`. Para cumplir cero solicitudes externas habría que autoalojar explícitamente composición, runtime y recursos y verificar la red; copiar solo el player no basta como garantía.
- `packages/player/src/styles.ts:295` reduce la transición del icono del botón; eso **no demuestra que detenga la composición**. La integración necesita un propietario explícito del ciclo de reproducción para media query, visibilidad y viewport.
- **`display:none` no garantiza pausar un `<video>`**, y `document.getAnimations()` no mide reproducción de video ni bucles Canvas/GSAP. La propuesta CSS de las notas anteriores no prueba la restricción de movimiento reducido.

### Prueba mínima propuesta — no ejecutada ni integrada

1. Fuera del sitio, en `/tmp`, crear una composición local de **5 s**: `spec → change → merge`, sin fuentes/CDN/medios remotos. Usar el CLI del clon/versionado disponible, comprobar con `hyperframes lint` y `hyperframes check`, y renderizar con `hyperframes render -o flujo.mp4`. Medir duración, bytes y tiempo real; no reutilizar las cifras antiguas como resultado nuevo.
2. En una fixture temporal con el prefijo `/sw-factory/`, servir solo MP4 y poster local mediante `<video muted playsinline preload="none">`, **sin autoplay**. Mantener el texto/diagrama accesible que explica el flujo; controles nativos o equivalentes por teclado.
3. Un único controlador autoriza `play()` solo si hay intención de reproducción, elemento visible, pestaña visible y `!matchMedia('(prefers-reduced-motion: reduce)').matches`. Cualquier transición contraria llama a `pause()`; reduced-motion muestra el poster. Gestionar el rechazo de `play()`.
4. Repetir ambos temas/tamaños y red; comprobar explícitamente `video.paused` y que `currentTime` no avanza al reducir movimiento, salir de pantalla u ocultar la pestaña. Revisar contraste/legibilidad de cada estado del clip; un video no hereda automáticamente el tema de la web.
5. Solo si esa fixture aporta una mejora visual concreta, valorar incorporar MP4/poster al inventario de Pages. No reemplazar las ocho escenas interactivas ni sus controles para esta prueba.

**Recomendación:** conservar SVG/CSS/JS actuales; considerar HyperFrames únicamente como herramienta de autoría para una prueba aislada de video. No se instaló ni integró HyperFrames en fab.

## Arreglo

Commit local **`e90656d41cb3557e89aaa91101d7d1c44b908610`**:

> `fix(pages): publicar también al cambiar el workflow`

Único cambio: una entrada `.github/workflows/pages.yml` en `on.push.paths`, además de `site/**`. Conserva rama `main`, ejecución manual, permisos, inventario validado contra symlinks, acciones fijadas por SHA y entorno. Sin `Co-Authored-By`. No hay cambios en `site/`, dependencias, código CLI ni tests del producto.

Prueba mínima del arreglo:

- YAML parseado con PyYAML: disparadores para cambios de sitio y workflow, exclusión de un documento de investigación, rama `main`, `workflow_dispatch` y guard de job conservados. Seis aserciones pasan (`workflow-proof.json`).
- Bloque Python real de preparación ejecutado sin modificar su lógica: 20 archivos, todos idénticos a los originales. `inventory-proof.json`: 136 referencias, ninguna ausente.
- Verificador actual contra ese artefacto: 304 controles pasan. La única edición posterior afecta al disparador, no a los bytes del sitio comprobado.
- `git diff --check` pasa. Diff frente a `origin/main`: una línea añadida al workflow. El symlink `node_modules` ya estaba sin seguimiento al empezar y se dejó intacto.

## Comandos y evidencias

Los comandos de inspección se ejecutaron en el worktree del brief. Las herramientas y salidas temporales quedaron fuera del sitio/repositorio.

| Comando / grupo ejecutado | Salida resumida / evidencia |
|---|---|
| `pwd`; `git status --short --branch`; `git log -5 --oneline`; lectura de brief, AGENTS, skills y verificadores | Rama correcta, base `8cda6d0`; symlink `node_modules` preexistente. Se respetó el alcance individual. |
| MCP `list_projects`, `index_status`, `search_graph`, `check_index_coverage` | Este worktree no está indexado; el proyecto vecino `sw-factory` tiene otra rama y `coverage_unavailable`, generación desconocida. No se reindexó ni se confiaron inferencias negativas al grafo; se leyó el fuente exacto de este worktree. |
| `gh run list --workflow pages.yml --limit 12 --json ...` | Último run `41363118440`, verde, `dfd1288`; ninguno para #37. |
| `gh run view 41363118440 --json headSha,conclusion,jobs,url`; `gh run view 41363118440 --log` | La consulta JSON confirma pasos de preparación/upload/deploy exitosos. La descarga de logs tuvo timeout TLS inicial y pasó al repetirla; `deploy.log:161` confirma 17 archivos preparados. |
| `gh api repos/DarkCodePE/sw-factory/commits/main`; `gh api .../pages`; `gh api .../deployments`; `gh api .../deployments/7480877886/statuses` | Main `8cda6d0`, Pages por workflow, deployment `dfd1288` exitoso. Una consulta de statuses falló por TLS timeout; la repetición de lectura respondió. `deployment-status.json`. |
| `git ls-remote origin refs/heads/main`; `git show dfd1288:.github/workflows/pages.yml`; `git diff dfd1288 origin/main -- .github/workflows/pages.yml site` | Coincide SHA remoto; el único cambio de #37 es el inventario. Copia de workflow publicado en `pages-published.yml`. |
| `curl -I --max-time 20 https://darkcodepe.github.io/sw-factory/pages.css` | HTTP/2 404. |
| `npm install -g agent-browser && agent-browser install` | Instalación global se atascó descargando el tarball; se terminó el proceso propio. No se usó como evidencia de instalación exitosa. |
| `git clone --depth 1 https://github.com/vercel-labs/agent-browser /home/orlando/Desktop/factory/ext/agent-browser`; lectura de README | Clon completado. Compilar esa versión requiere Node 24+/pnpm 11+/Rust; se reutilizó la versión 0.27.0 de caché con Chrome instalado, sin reconstruir el toolchain. |
| `.../agent-browser --version`; `skills get core`; `agent-browser install` desde caché | 0.27.0; guía de uso leída. La descarga opcional de Chrome 157 falló tras tres intentos; `browser-install.log`. Las pruebas sí usaron Chrome 152 del sistema. |
| `python3 -m http.server -d site 8080 --bind 127.0.0.1` | Puerto ocupado por Evolution API. No se detuvo ese servicio; se sirvió en **8081**. |
| `python3 -m http.server -d site 8081 --bind 127.0.0.1` | Copia local de las tres páginas disponible. |
| Extracción y ejecución del bloque `Prepare public files`; `python3 docs/landing/serve.py --prefix /sw-factory/ --port 8775 --directory /tmp/fab-web-codex/artifact` | `Prepared 20 public files`; artefacto bajo el prefijo real. |
| `python3 /tmp/fab-web-codex/matrix.py` | Orquesta agent-browser: `set viewport`, `set media`, `open`, `wait --load networkidle`, `eval`, `screenshot --full`, `network requests`, `console`, `errors`. 48 escenarios completos; `matrix.json`, `matrix-progress.log`. |
| `python3 /tmp/fab-web-codex/extras.py`; `python3 /tmp/fab-web-codex/navigation.py` | 16 capturas de diagramas. El primer script de clics tenía un selector de escritorio erróneo; no se tomó su resultado como defecto. Se repitieron los 8 clics con `.nav-dropdown-panel` y se guardaron en `navigation-verified.json`. |
| `LANDING_URL=http://127.0.0.1:8775/sw-factory/ HALLMARK_PUPPETEER=/home/orlando/.npm/_npx/f84840e95bd045a9 CHROME_PATH=/usr/bin/google-chrome node /tmp/fab-web-codex/verify-v2.mjs` | 304 controles; código 0; `verify-v2.log`. Copia temporal del verificador existente: solo se redirigieron las salidas de screenshots a `/tmp`; no se cambiaron aserciones. |
| `impeccable context --target site/index.html`; `impeccable detect --json site/index.html site/fabrica/index.html site/agente/index.html` | Contexto de diseño existente; detector con 108 avisos heurísticos, revisados como se explica arriba. `impeccable.json`. |
| `git grep -in hyperframe $(git for-each-ref --format='%(refname)' refs/remotes)`; lectura de notas y fuente del clon | Sin coincidencias en referencias examinadas. No hay integración HyperFrames observada. |
| `python3 /tmp/fab-web-codex/assets.py` y repetición de dos lecturas TLS | Consulta remota de los 20 archivos: 17 idénticos, 3 ausentes; `assets.json`. |
| Parseo YAML, comparación de bytes del artefacto y parseo de referencias HTML/CSS | Seis aserciones de workflow, 20 archivos iguales y 136 referencias resueltas. |
| `git diff --check`; `git add .github/workflows/pages.yml`; `git commit -m 'fix(pages): publicar también al cambiar el workflow'`; `git show --format=full --no-patch HEAD` | Commit local `e90656d`; una inserción; sin trailer de coautoría. |

Rutas de capturas y datos:

- Lista completa de PNG: **`/tmp/fab-web-codex/screenshots.txt`**.
- Matriz: `/tmp/fab-web-codex/{live,local}-{index,fabrica,agente}-{light,dark}-{normal,reduced}-{1440,390}.png`.
- Diagramas: `/tmp/fab-web-codex/{live,artifact}-{sdlc-workflow,architecture}-{light,dark}-reduced-{1440,390}.png`.
- Capturas del verificador: `/tmp/fab-web-codex/verification-screenshots/`.
- Todas las invocaciones y respuestas JSON de agent-browser: `/tmp/fab-web-codex/commands.jsonl`; conclusiones agregadas en `summary.json`. El selector equivocado del ensayo de navegación queda en el registro para trazabilidad; usar `navigation-verified.json` como resultado final.
- Las evidencias en `/tmp` son temporales; no se copiaron a `site/screenshots/` ni se alteraron los recibos históricos.

## Lo que no pude revisar

- No se verificó una nueva publicación remota: se prohibieron push y relanzamientos. El arreglo está probado estáticamente/localmente, pendiente de integrarse y observar su run real.
- No se pudo evaluar la interacción de Fábrica/Agente **en producción**, porque sus rutas dan 404; sí se verificaron sus archivos locales y el artefacto con prefijo.
- Chromium y viewports emulados; sin dispositivos físicos, Firefox/WebKit, lector de pantalla ni evaluación WCAG completa. El contraste calculado por el verificador no cubre todos los píxeles de gradientes, frames de canvas, video o estados posibles de los diagramas. Tampoco se hizo benchmark de rendimiento.
- No se navegó a enlaces externos ni se ejecutaron los comandos de instalación de fab. No se probó el portapapeles físico; el verificador simula sus resultados.
- No se compiló el agent-browser más reciente ni terminó la descarga de su navegador; se empleó una versión disponible y el Chrome del sistema. Los resultados no dependen de una instalación supuestamente exitosa.
- No se renderizó una nueva composición HyperFrames ni se verificaron los archivos de `/tmp/hf-scene` de la investigación pasada (no estaban presentes). La prueba mínima anterior es una propuesta, no una implementación.
- El grafo no ofreció cobertura fiable de este worktree; se usó inspección directa. No se descargaron todas las ramas remotas ni se examinó todo su historial.
- No se ejecutó la suite CLI completa: el único cambio es el filtro del workflow y no afecta al producto CLI. Se ejecutó la prueba enfocada de configuración y el verificador web completo.

<!-- FIN -->
