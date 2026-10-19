# Segunda pasada de paridad TUI: entrega y continuidad

Se completó la interfaz solicitada en `sw-factory-tui`, rama `feat/droid-tui`, partiendo de `e5548de`. FAB continúa usando su motor independiente. La comparación detallada y los estados hecho/parcial/falta están en [cli-droid-parity.md](cli-droid-parity.md#segunda-pasada-bienvenida-sugerencias-y-skills). **No hay paridad total con Droid.**

## Cambios entregados

- Bienvenida con logo FAB, versión real `0.1.0`, tip que cambia entre arranques y atajos visibles. No se hace pasar FAB por Droid 0.244.0.
- Paleta en vivo de `/`, filtrada por nombre y descripción, columnas de descripción/origen y selección resaltada. ↑/↓ seleccionan; Tab o Enter sobre una selección completa sin ejecutar. Un segundo Enter envía. Enter sobre un comando escrito normalmente conserva su ejecución. Escape cierra la paleta; permisos, AskUser y pegado conservan su manejo independiente.
- Skills y comandos locales comparten el catálogo: `/nombre argumentos` o `/skill nombre argumentos`. Se conserva el nombre real del archivo, se compara sin distinguir mayúsculas, se retira frontmatter y se sustituye `$ARGUMENTS` como texto. Comandos integrados y aliases tienen prioridad; duplicados/recursos ilegibles se omiten y se anuncian. Lectura anclada al workspace, sin symlinks de catálogo/archivo.
- Recursos visibles: Skills locales, MCP configurados sin afirmar conexión, AGENTS.md legible y Connectors no disponible. Deshabilitar MCP actualiza el conteo. Mostrar la barra no arranca servidores.
- Autonomía/modo a la izquierda; nombre de modelo y razonamiento a la derecha. Spec anuncia su restricción de escritura. Tab fuera de slash cicla low/medium/high, persiste y llega al proveedor; `/reasoning default` omite el esfuerzo explícito. Los custom models admiten `displayName` sin cambiar su ID real.
- `/plugins`, `/install-triage` y `/detect-overlapping-workstreams` son descubribles y explican que falta su backend. No se convierten en tareas al modelo.
- Se corrigió una regresión encontrada en la primera captura propia: al abrir seis sugerencias se sobrescribían los tips/atajos. La reserva dinámica de filas ahora desplaza el log y preserva la bienvenida. Se mantiene resize y el modo plain.

Archivos principales: `src/chat/chrome.ts`, `palette.ts`, `project.ts`, `terminal.ts`, `presentation.ts`, `controller.ts`, `config.ts`, `commands.ts`, `src/chat.ts`, `src/agent/settings.ts` y ayuda en `src/cli.ts`. Pruebas nuevas: `tests/chat-parity-2.test.ts`; fixture reproducible: `scripts/probe-tui-parity2.ts`.

## Evidencia de Droid y FAB

Se abrió la captura del usuario antes de modificar código. SHA-256: `3f3dd86aa0ce79b0fdc417491245a0ab4cc40bd52c755b18d027ef924b2a0bbb`. Droid observado: `/home/orlando/.local/bin/droid`, versión 0.244.0, SHA-256 `f4740a4821288415a5089c04a3cc3e6bfbd7866137863422d1d9a220b31640e2`.

REA ejecutó ambos terminales dentro de bwrap: raíz RO, solo fixture propio RW, home/entorno explícitos, namespaces de procesos y red, sin credenciales reales. Los perfiles de Droid apuntaban a loopback sin servicio. FAB utilizó únicamente un proveedor sintético local en el mismo namespace. Las capturas y el recibo completo están en [evidence/paridad-2-validation.json](evidence/paridad-2-validation.json).

| Captura | Qué demuestra | Límite |
| --- | --- | --- |
| D1 `ev_e54395e3786fc89f6fae3bbe4952b8e287147ff772cb6a62db200ef77c842193` | Arranque animado del original | Interrumpida antes de la interfaz completa. |
| D2 `ev_79c6163cbccb37cf71d5a2188b8202ab9416014239fe4310880d881a96ccdfb9` | Bienvenida y confirmación de confianza | Timeout; no se aprobó el repositorio real. Se aisló después el fixture con su propio Git. |
| D3 `ev_3697dd2b4883c1008460016d1dd8df148a887da32aac19dfcf8e9ca1ed35aa6b` | Bienvenida, `/`, `/skill`, descripciones/origen, Spec y autonomía Low; sin recursos locales | El original sigue mostrando 22 skills empaquetadas. Un modelo genérico no demuestra el atajo de razonamiento. |
| D4 `ev_ed18bcf368bc9656d133fe7e3e64744712b98a9bb88dd728c6c05302f62582e0` | Skill y comando propios visibles con su origen; AGENTS y MCP configurado presentes | La secuencia terminó invocando el prompt sintético con `/mcp` como argumento y falló contra loopback. No demuestra el modal MCP ni conexión. |
| D5 `ev_b74a7e310e35f06c3e401b6ea631a345e1772316ab1db437c2b9527363ca5a61` | Ctrl+N abre selector con los dos modelos de fixture | Las teclas siguientes permanecieron en el selector. |
| D6 `ev_b9d99cd1b35ab16488989a6819eafc79b67e108e69ab4681636b64cd83bd4365` | Cambio al segundo modelo, Shift+Tab y Ctrl+L | Tab no produjo cambio visible con modelos genéricos; High y el texto del atajo vienen de la imagen del usuario. |
| F1 `ev_dfd9bed5d11740a788693f66b29c8b53ed2a7cffbc6a0b44bb64f002fafaf464` | Primera versión Bun-source de paleta, shortcuts y errores honestos | Intermedia: descubre la superposición corregida después. |
| F2 `ev_be907745ddd2e6b8812cf3c1c30ea8181086f87ccdf3a7b1e6045db2f436067d` | Binario final: logo/tips preservados con paleta, recursos, selección, cuatro atajos, plugins indisponible, MCP disable, invocación real de skill y comando, resize | Requests a proveedor sintético, sin servicio comercial ni herramientas remotas. |
| F3 `ev_cd0604638bcd72deb2a024535850fe84e0ad02fa50fe31ce373c4a1f39c04432` | Fuente final con `bun src/cli.ts tui`: recursos vacíos, filtro `/pl`, cambio a plain y estado | No se envió tarea al modelo. |

D3–D6 y F1–F3 salen con exit 0; ninguna captura declara truncamiento. D2 conserva timeout/SIGTERM. Se conservan también intentos insuficientes, sin presentarlos como validación completa.

F2 produjo exactamente dos requests: la skill recibió `argumentos visibles` con esfuerzo `low`; el comando recibió `otro` con esfuerzo `high`. Sus mensajes sintéticos se conservan en el recibo, junto con hashes de fuente y artefacto. No se recuperaron prompts de Factory: no hicieron falta para esta entrega. La autorización posterior del usuario sustituye la antigua restricción de la tarea respecto a prompts.

## Referencias locales mediante Graft

Se ejecutó `graft build --no-gitignore --no-ignore .` en los tres clones, luego `graft ask`, `graft skeleton` y lectura de las líneas obtenidas. `graft check .` terminó con exit 0 en los tres: el grafo estructural está actualizado. No se ejecutó `--deep`; la capa de conceptos/resúmenes semánticos no está construida. No se usó grep para descubrir código. Los grafos Graft son distintos del servicio MCP codebase-memory: este último no tiene estos proyectos y devolvió `project not found or not indexed`; los hallazgos se validaron en fuente local.

| Referencia y commit | Evidencia leída | Aplicación y límite |
| --- | --- | --- |
| TrueForge `0a42995ea8bfb379ec7be4ed73c211708e58e40b` | `../trueforge/packages/trueforge/src/schemas/skill.ts:53` y `:129`: descripción y proyección de descubrimiento de skills | Corrobora separar metadatos del cuerpo invocado. Sus skills Git/registro remoto no equivalen a nuestro loader local. |
| Whip `1c5da05987d2869687dfc95fc9128ad2ad68e0f0` | `../whip/internal/tui/registry.go:8`, `:68`, `:93`: registro común para ayuda/completado; `../whip/packages/app/src/skill-completion.ts:4`, `:32`: detección y reemplazo de token | FAB deriva su paleta de su registro y recursos; completar conserva una acción separada de ejecutar. No se trasladó su runtime ni su sintaxis `$skill`. |
| PI `482c1381a00d8d00bc81697e4a980c593db6803e` | `../pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts:725`, `:787`, `:806`: integra builtins, templates, extensiones y skills; `../pi/packages/coding-agent/src/core/skills.ts:277`: metadata/diagnósticos | Corrobora descripción/origen y prioridad de builtins. PI usa `/skill:nombre` y una carga más amplia; FAB conserva `/nombre` y `/skill nombre`. |

Índices: TrueForge 2696 archivos/11759 nodos/29469 aristas; Whip 1792/15079/43946; PI 1677/16739/44313. El indexador de PI produjo 1676 cards para 1677 archivos; no se afirma cobertura semántica total ni equivalencia global entre estos agentes.

## Rúbrica reproducible

| Escenario | Cómo probar lo desarrollado | Criterio |
| --- | --- | --- |
| Bienvenida y barras | `bun test tests/chat-parity-2.test.ts`; abrir `./dist/fab tui --cwd <proyecto> --settings <perfil>` | Logo FAB y versión real, atajos, ancho sin overflow; Auto/Spec y modelo coherentes; MCP dice configurado, no conectado. |
| Paleta | Escribir `/`, `/pl` y `/probe`; flechas, Tab, Enter seleccionado, Escape | Descripciones/origen visibles; completar no ejecuta; Enter posterior sí; permisos y pegado no disparan comandos. |
| Skill/comando | Crear `.agents/skills/demo/SKILL.md` con frontmatter y cuerpo `Revisa $ARGUMENTS`; `.agents/commands/otra.md` equivalente; invocar `/demo src`, `/skill demo tests`, `/otra debug` | Proveedor recibe cuerpo y argumentos; metadata fuera; no cambia permisos; nombres integrados y aliases no se sobrescriben. |
| Recursos ausentes/ilegibles | Quitar AGENTS/skills; añadir skill sin SKILL.md o symlink | Conteo y advertencias coherentes; no se sigue enlace ni se inicia MCP por mostrar la UI. |
| Atajos y esfuerzo | Tab fuera de slash, Shift+Tab, Ctrl+N, Ctrl+L; `/reasoning high`, `/reasoning default` | Borrador preservado; esfuerzo llega al request; selección de modelo real; modo mission exige high explícito. |
| Terminal | `bun test tests/chat-input.test.ts tests/chat-render.test.ts`; resize y `/themes plain` | Borrador conservado; sin captura de respuestas de permiso; tips siguen visibles al abrir menú; plain sin barra animada. |
| Backend faltante | `/plugins`, `/install-triage`, `/detect-overlapping-workstreams` | Mensaje explícito de indisponibilidad y cero request al modelo para fingir ejecución. |
| Artefacto | Build y probe indicados abajo; para PTY usar `bun scripts/probe-tui-parity2.ts ./dist/fab <carpeta-temporal-propia>` | Script callback aislado funciona; timeout termina; dos requests de recursos conservan argumentos/esfuerzo. El driver escribe únicamente su fixture. |

Comandos ejecutados al cierre:

```bash
bun test
bunx --no-install tsc --noEmit -p .
git diff --check
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli.ts --outfile dist/fab
bun scripts/probe-compiled-cli.ts ./dist/fab
```

Resultado: **183 pass, 0 fail, 866 aserciones en 20 archivos**; TypeScript y diff-check exit 0. Probe del compilado: callback sandbox requerido, una herramienta y resultado correcto con exit 0; bucle infinito termina con error timeout y exit 1 esperado. `dist/fab` SHA-256: `867f5bceef0dc41992874836998400075d971cd1765ca3a50f273f16f639bcc8`. El recibo vincula el hash del binario al snapshot de fuentes; `dist/` es un artefacto local ignorado por Git.

## Pendientes para continuar

1. Plugins/marketplaces, connectors, skills remotas de Factory y Slack triage necesitan backend real. No basta añadir nombres a la paleta.
2. Ctrl+N conserva ciclo directo propio; el selector Droid y su catálogo completo siguen sin equivalencia. Razonamiento admite low/medium/high; falta negociar capacidades/valores por modelo y verificar proveedores reales. High visible en Droid no se reprodujo con los modelos genéricos aislados.
3. El loader local admite nombres ASCII con guion/underscore, 100 entradas por tipo, 64 KiB por recurso y frontmatter simple; no es un parser YAML completo ni un gestor de dependencias de skills.
4. Hooks opt-in y su contrato de capacidades/efectos, daemon compatible 37643, OAuth/servicios remotos y paridad completa de missions siguen como pendientes ya documentados. Esta pasada no los implementa.
5. Mantener separados los casos deterministas del proveedor sintético y una futura prueba de aceptación contra un proveedor real. No se ejecutó el servicio comercial del usuario ni se certificó el FAB instalado globalmente.

No se hizo push, merge, release ni instalación global. Los fixtures temporales propios se eliminan tras preservar la evidencia. `.claude-flow/` preexistente queda fuera de los cambios de la entrega.
