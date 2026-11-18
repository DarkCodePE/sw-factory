# Brief: por qué está rota la web de fab (Codex)

Eres un revisor sin contexto previo.
- **Web publicada:** https://darkcodepe.github.io/sw-factory/
- **Código:** `site/` en el worktree `/home/orlando/Desktop/factory/sw-factory-web`, rama `fix/landing-rota`, creada desde `origin/main`.
- **Publicación:** `.github/workflows/pages.yml`. Solo publica en push a `main` que toque `site/**`.

## 1. Revisar la web con agent-browser
1. Instala la herramienta (https://github.com/vercel-labs/agent-browser): `npm install -g agent-browser && agent-browser install`. Si falla, clónala en `/home/orlando/Desktop/factory/ext/agent-browser` y sigue su README.
2. Recorre las tres páginas publicadas: `/`, `/fabrica/` y `/agente/`.
   - Haz capturas en escritorio (1440 px) y en móvil (390 px), en tema claro y oscuro, y con `prefers-reduced-motion`.
   - Recoge los errores de la consola y las peticiones 404 o fallidas.
   - Comprueba que los enlaces de navegación, los diagramas (`diagrams/*.html`), las animaciones SVG (`modules.js`) y los recursos de marca cargan.
3. Compara la web publicada con `site/` servido en local (`python3 -m http.server -d site 8080`). Así sabrás si el fallo está en el código o en el despliegue.

## 2. Diagnosticar
Di **qué** está roto y **por qué**, con su causa raíz: archivo y línea, o el run de Actions. Pistas que debes comprobar, no dar por buenas:
- **Despliegue.** El último despliegue en verde de Pages es del commit `dfd1288` (2026-11-01), pero `origin/main` está en `8cda6d0`, el merge del #37 (`fix/pages-inventario`). ¿Se publicó ese merge? Míralo con `gh run list --workflow pages.yml`.
- **Inventario.** `pages.yml` copia una lista explícita de archivos. ¿Falta alguno que el HTML referencia: CSS, JS, imágenes, `fabrica/`, `agente/` o `screenshots/`?
- **Rutas.** Revisa las rutas absolutas o relativas que se rompen bajo el prefijo `/sw-factory/`.
- **Restricciones de la landing.** Las comprueban `docs/landing/pages-browser-checks.json` y los scripts `verify*.mjs`, si existen:
  - cero peticiones externas;
  - `prefers-reduced-motion` deja la página estática;
  - la animación se pausa fuera de pantalla;
  - contraste WCAG AA.

## 3. HyperFrames
Ya hubo una investigación sobre si HyperFrames (heygen-com/hyperframes) sirve para las animaciones de la landing:
- `/home/orlando/Desktop/factory/doc/droid-re/task-investigar-hyperframes.md`
- `/home/orlando/Desktop/factory/doc/droid-re/notas-hyperframes.md`
- el clon está en `/home/orlando/Desktop/factory/ext/hyperframes`.

Contesta:
- ¿Hay algo de HyperFrames en `site/` o en otra rama (`git grep -i hyperframe $(git branch -r)`) que cause la rotura?
- Si la web está rota en sus animaciones, ¿HyperFrames lo arreglaría o lo mejoraría respetando las restricciones de arriba? ¿Cuál sería el mínimo para probarlo?

No integres HyperFrames: solo evalúalo.

## Reglas
- **Solo lectura**, salvo dos cosas:
  - tu informe;
  - un arreglo **mínimo** en `fix/landing-rota`, solo si la causa es clara y está en `site/` o en `pages.yml`. Hazlo en commits en español, **sin `Co-Authored-By`**, **sin push** y sin tocar `main`.
- No escribas en GitHub (issues, PRs, comentarios) ni relances workflows.
- No lances subagentes.

## Informe
Escríbelo en `/home/orlando/Desktop/factory/sw-factory/docs/research/web/codex.md` con estas partes:
- **Veredicto:** qué está roto, en una frase.
- **Tabla de hallazgos:** id, severidad, página, evidencia (captura, consola o red), causa raíz (`ruta:línea` o el run) y arreglo propuesto.
- **Despliegue:** qué commit está publicado frente a `main`, y por qué.
- **HyperFrames:** tu respuesta a las preguntas de la sección 3.
- **Arreglo:** si lo hiciste, los commits y cómo lo verificaste.
- **Comandos:** los que ejecutaste, con su salida resumida y las rutas de las capturas.
- **Lo que no pudiste revisar.**

Última línea, exactamente: `<!-- FIN -->`.
