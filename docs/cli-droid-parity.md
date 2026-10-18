# CLI/TUI propia de fab: comparación con Droid 0.244.0

Implementación independiente basada en comportamiento de terminal observado con REA y en el motor propio existente. No se copió código, prompts, descripciones de herramientas ni bundles propietarios. **No hay paridad completa con Droid.**

## Por qué faltaban las funciones

`src/chat.ts` exponía seis comandos y fijaba el modo en auto. No conectaba MCP ni AskUser, no enumeraba sesiones y no ofrecía selección de modelos. `src/tui.ts` era el dashboard del pipeline de fábrica, con revisiones de cambios, no una interfaz del agente. El motor ya tenía varias de esas capacidades; otras requieren un backend adicional.

Se desarrolla en `/home/orlando/Desktop/factory/sw-factory-tui`, rama `feat/droid-tui`, sobre `c2be50bd4190118e15b6048e3e384662d02f26e3`. Se creó el worktree al detectar otro escritor en `sw-factory-agent`. Antes de editar se conservaron sus correcciones existentes de R-01/R-02/R-09 en `agent/chatgpt.ts`, `agent/engine.ts`, `agent/provider.ts` y su prueba; no se presentan como trabajo nuevo de esta interfaz. No se hicieron commits, push, merge ni instalación global.

## Evidencia del original

Binario: `/home/orlando/.local/bin/droid`; SHA-256 `f4740a4821288415a5089c04a3cc3e6bfbd7866137863422d1d9a220b31640e2`, versión mostrada 0.244.0. Capturas REA en PTY mediante bwrap: root RO, workspace/home temporales propios, entorno explícito, airgap y namespace sin red. Se usó un modelo BYOK sintético en un endpoint sin servicio; no se enviaron tareas a modelos.

- Ayuda general: `ev_204b753b444ef8db3e2a053729093cca195c298a59a985411fa9ffed96c17a72`.
- Ayuda de resume: `ev_ee92bdb0f43618d77dffb2183697d89fa5a1da18153a6ac8b7d272138859c30b`.
- Ayuda MCP: `ev_c0177a450aa868ae673511c01c82580d26f1688d3c561ead47ba7b3cd99828b4`.
- Paleta `/` y navegación: `ev_aa71d912c220cc406a0d80918a389e89330207fd288cafb4420f603dec891731`; 44 nombres observados, sin truncamiento declarado. Esto prueba inventario visible, no la ejecución de todas esas funciones.

La primera exploración sin BYOK quedó bloqueada por configuración y la captura inicial corta se agotó durante el arranque. Se conservan como límites, no como pruebas de comandos inexistentes. REA captura un launcher bwrap; el hash de Droid se comprobó por separado. Sus muestreos no son una traza exhaustiva de syscalls o procesos. El resumen portable está en [evidence/droid-cli-0244.json](evidence/droid-cli-0244.json).

## Uso

```bash
cd /home/orlando/Desktop/factory/sw-factory-tui
bun src/cli.ts tui --cwd /ruta/proyecto --settings /ruta/modelos.json
# También: bun src/cli.ts --cwd /ruta/proyecto 'una tarea inicial'
# Binario local compilado:
./dist/fab tui --cwd /ruta/proyecto --settings /ruta/modelos.json
```

`fab tui <workstream>` conserva el dashboard. Desde él, `g` abre el agente en el repositorio del workstream; `/exit` vuelve al dashboard. No ejecuta automáticamente el pool ni concede permisos. `fab tui` sin workstream abre directamente el agente.

Tab completa nombres y argumentos de modelo/autonomía/modo. `/` seguido de Enter muestra el catálogo agrupado; `/model`, `/auto` y `/mode` abren selección por número o flechas. Shift+Tab cambia auto/spec y añade mission solo si la autonomía ya es high. Ctrl+N cambia entre modelos configurados, Ctrl+L cambia autonomía y Ctrl+O alterna detalle y vuelve a mostrar el último diff ampliado, incluso durante el trabajo. Ctrl+C cancela una operación/pregunta activa; Ctrl+D o `/exit` sale. Una barra invertida al final continúa el prompt en otra línea. ↑/↓ recuperan prompts de esta carpeta entre invocaciones. El pegado delimitado se inserta como un bloque visible con ↵ y solo se envía al pulsar Enter.

Sin preferencia guardada, autonomía off. El orden del modelo es flag `-m`, env, modelId del perfil, modelo guardado y detección de auth de Codex/fallback Ollama. Un perfil explícito no queda invalidado por un custom model guardado de otro perfil. La detección de un archivo auth no garantiza que el login esté vigente. No se refrescan credenciales desde esta UI.

## Cobertura implementada

| Área | Comandos y comportamiento propio |
| --- | --- |
| Configuración | `/model [id]`, `/auto [off|low|medium|high]`, `/mode [auto|spec|mission]`, `/settings [model|auto|mode|theme valor]`, `/themes [color|plain]`. No imprime claves del perfil. |
| Estado | `/status`, `/context` (estimación sin schemas), `/limits` (límites locales), `/diagnostics` (sandbox/configuración). Sin consulta de facturación o salud remota. |
| Sesiones | `/sessions`/`/resume [id|--last]`, `/search`/`/find texto`, `/fork [id]`, `/rename título`, `/pin`/`/favorite`, `/archive`, `/tree`. Selección solo de la carpeta actual; archived se encuentra con search. |
| Contexto | `/clear` conserva ajustes; `/new` restaura los de arranque. `/compress`/`/compact` resume todos los fragmentos y conserva instrucciones de usuario. `/handoff` crea un fork resumido sin modificar el original. Requieren llamadas al proveedor al invocarse. |
| Consulta lateral | `/btw pregunta` usa spec/off y no guarda ni cambia la sesión principal. |
| MCP | `/mcp [list|enable nombre|disable nombre]`: conecta los configurados al siguiente turno; enable/disable dura esta invocación. Listar no inicia servidores ni afirma conectividad. `/tools` sí puede negociarlos para descubrir schemas y los cierra al terminar. |
| Herramientas | `/tools [list|only nombres|remove nombres|reset]` aplica filtros al motor y a llamadas anidadas. Permisos una vez/cancel y AskUser responden con señales cancelables. |
| Trabajo visible | Spinner con tiempo del turno y nombre de herramienta; se oculta al recibir texto o pedir una respuesta al usuario. Dos filas reservadas para trabajo y estado (modelo, modo/autonomía, tokens de usage acumulados durante esta invocación, contexto estimado del último request, incluidos schemas). Se adapta a resize. |
| Respuestas y cambios | Markdown incremental por líneas: títulos, negritas, listas, inline code, bloques cercados con fondo/borde y tablas delimitadas por pipes. Edit/Create muestran +/- con números de línea, 12 líneas compactas o hasta 400 ampliadas. Sin ApplyPatch propio en el catálogo actual. |
| Rewind local | `/rewind`, `/rewind list`, `/rewind <id>` restauran únicamente archivos Edit/Create del último checkpoint con archivos o del ID elegido. Incluye llamadas anidadas de Script. No rebobina el historial conversacional. |
| Recursos de proyecto | `/skills [nombre]` lista/lee `.agents/skills`; `/commands` lista prompts de `.agents/commands/*.md`, invocables por `/nombre argumentos`. Sustituye `$ARGUMENTS` como texto, nunca como shell. No sigue catálogos enlazados fuera del proyecto. |
| Proyecto | `/cwd`/`/cd [ruta]` cambia carpeta y abre conversación nueva; `/init [instrucciones]` pide preparar AGENTS.md bajo los permisos y herramientas del agente. |
| Subagentes | `/droids` informa de Task/SpawnAgent y límites disponibles. No implementa un gestor de definiciones custom Droids. |
| Ayuda | `/help`, `/terminal-setup` y `/exit`/`/quit`; setup solo informa, no modifica el terminal. |
| Entradas CLI | `fab resume [id]`, `fab --resume [id] --last`, `fab --fork id`, `fab search|find texto`, `fab mcp list --settings archivo`, y flags de chat para cwd/settings/modelo/autonomía/spec/mission/límites/filtros. `fab exec` conserva su API anterior. |

La compresión es una operación local con lock y guardado atómico. Rechaza estados de misión y resúmenes incompletos o que no reducen el contexto. Nunca ejecuta las herramientas que pudiera devolver un proveedor de resumen. No es rewind del filesystem.

Un aborto con llamadas pendientes conserva el snapshot bloqueado y muestra su ID; los siguientes prompts comienzan una sesión nueva. `/resume` y `/fork` rechazan ese snapshot hasta disponer de reconciliación. No se eliminan pending, locks ajenos ni resultados para fingir continuidad. Listado/búsqueda tienen límites de entradas y bytes y anuncian resultados parciales.

## Lo que sigue sin equivalencia

La paleta distingue explícitamente las entradas sin backend. Login/logout/account/share y las instalaciones de automatizaciones de Factory; plugins/marketplaces, hooks de shell, fast mode, idiomas adicionales, statusline ejecutable, rewind completo de efectos/conversación y los flujos migrate/simplify originales no están implementados. No se envían esos comandos al modelo como si hubieran funcionado. Los top-level daemon/update/plugin/computer también fallan explícitamente.

MCP OAuth, add/remove/auth/permissions persistentes, árbol de sesión original completo, worktrees por `-w`, ACP, daemon compatible 37643, servicios remotos y catálogo de modelos de Factory siguen fuera de esta entrega. La UI de missions llama al motor propio y sus gates existentes; no demuestra paridad total de missions con Droid. Skills y custom commands son recursos locales, no una réplica del marketplace.

## Cómo verificar

```bash
bun test tests/chat.test.ts tests/chat-cli.test.ts
bun test
bunx --no-install tsc --noEmit -p .
git diff --check
bun build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig src/cli.ts --outfile dist/fab
bun scripts/probe-compiled-cli.ts ./dist/fab
```

Las pruebas de interfaz usan proveedores deterministas, snapshots y repositorios temporales. Cubren continuación sin replay, separación por cwd, spec, permiso por llamada/negativa, AskUser, MCP sin exponer claves, aborto y sesión nueva, compresión/handoff, consulta lateral, prompts propios, entrada por pipe, menús/atajos y rutas CLI. La suite previa cubre el motor, misiones, aislamiento y fábrica. No se ejecutaron proveedores comerciales.

Resultado de la entrega anterior: **145 pass, 0 fail**, 579 aserciones, 15 archivos; TypeScript y diff-check exit 0. Fueron 17 escenarios nuevos de chat/CLI y la regresión previa, incluidas las correcciones R-01/R-02/R-09 conservadas de la otra sesión. El resultado de la ampliación actual se registra en el recibo de gaps enlazado más abajo.

Se probó también el binario Linux con un servidor sintético local: `exec` → Script en sandbox requerido → callback Read del padre → resultado 42 → siguiente turno; y bucle infinito → timeout con exit 1. REA verificó menús/atajos (`ev_61b924034750d3489dcea8402ed2eb72024469ee106a125e2bf511c8bc8a0280`) y dashboard → agente → dashboard → salida (`ev_473748e822c5a72fc092ca8a612d1ecf2047a2e0d346392d958afe02e06c52dd`), ambos exit 0 sin truncamiento. Esas capturas detectaron antes dos regresiones que se corrigieron: Shift+Tab añadía `/`, y stdin quedaba pausado al abrir el agente desde el dashboard; el recibo conserva los intentos fallidos.

Artefacto de la entrega anterior: `dist/fab`, SHA-256 `fa2f0bd5bd9532cb5121c546b5a7749bc18d14747a8bf8478593823bbdbaaa4d`. El [recibo anterior](evidence/fab-tui-validation.json) conserva su fuente y resultado. La ampliación actual recompila el binario y publica su nueva identidad en [el recibo de gaps](evidence/tui-gaps-validation.json). No se certifican otros sistemas/arquitecturas, instalación global ni release.

## Ampliación: gaps de interfaz y pruebas

Los puntos obligatorios 1–7 de `task-codex-tui-gaps.md` tienen implementación propia y pruebas sin proveedor comercial. REA se usa solo para comportamiento de terminal; no se leyó ni copió código propietario. El fallback de descubrimiento fue Graft porque el proyecto no figura entre los 16 índices MCP disponibles y coverage devolvió «project not indexed».

| Punto | Prueba reproducible y alcance |
| --- | --- |
| 1. Trabajo | `tests/chat-render.test.ts`: spinner transcurre, se detiene con texto y cierra timers. `tests/chat.test.ts`: Ctrl+C durante permiso cancela el waiter y el agente. |
| 2. Barra | `tests/chat-render.test.ts`, `tests/chat-input.test.ts`: ancho fijo, celdas Unicode, resize, input conservado, readline no borra la barra. `tests/chat-rewind.test.ts`: usage real acumulado entre prompts. |
| 3. Markdown | `tests/chat-render.test.ts`: snapshot exacto, streaming partido carácter a carácter, tablas alineadas, color y saneamiento de escapes. No es un parser CommonMark completo; las líneas incompletas se retienen hasta newline/final y las tablas hasta cerrar el bloque. |
| 4. Diff | `tests/chat-render.test.ts`: snapshot +/-, números, color, truncamiento y ampliación. REA comprueba Ctrl+O durante trabajo y con un prompt parcialmente escrito. |
| 5. Historial | `tests/chat-input.test.ts`: recarga, aislamiento por carpeta, límites y modo 0600; flechas no recuperan la respuesta de permiso. `tests/chat-rewind.test.ts`: solo se persisten los prompts enviados al modelo. |
| 6. Pegado | `tests/chat-input.test.ts`: cada byte separado, UTF-8, CRLF, Ctrl+C dentro del texto, overflow, pegado incompleto y una sola entrega tras Enter. |
| 7. Rewind | `tests/chat-rewind.test.ts`: repositorio Git temporal, bytes binarios/modos originales, creación/sobrescritura/varias ediciones, paths externos, symlinks de archivo/ancestro, cambios posteriores, intención incierta, locks, Script anidado, Execute directo/anidado y metadatos de misión fuera de raíz. |
| R-04/R-05 | `tests/chat.test.ts`: abortar permiso conserva snapshot pendiente bloqueado y el siguiente prompt recibe ID nuevo; nunca borra pending para simular que puede reanudarlo. |
| R-07/R-12 | `tests/chat.test.ts`: MCP y filtros llegan al motor sin imprimir claves; AskUser devuelve la opción elegida al modelo. Las pruebas RPC/MCP existentes siguen siendo parte de la regresión. |

Para esta ampliación: `bun test tests/chat-render.test.ts tests/chat-input.test.ts tests/chat-rewind.test.ts tests/chat.test.ts tests/chat-cli.test.ts`; después los comandos completos de arriba. `scripts/probe-tui.ts` levanta un proveedor sintético de loopback y hereda el PTY del binario; debe ejecutarse con carpeta temporal propia. Las capturas REA se ejecutan dentro de bwrap con root RO, solo esa carpeta RW, entorno explícito y namespace sin red externa. Se conservan todos los intentos en `docs/evidence/tui-gaps-attempt-*.json`, incluso el primero con truncamiento del render y superposición de barra al resize. La corrección refresca el tamaño real de Bun y evita que readline borre las filas reservadas.

Resultado de esta ampliación: **162 pass, 0 fail**, 679 aserciones, 18 archivos; TypeScript y diff-check exit 0. El binario final `dist/fab` tiene SHA-256 `7f6f3ba6a5656209dfbfc523a4009c3be956aa87da26678e60318e73df4319aa`. El probe compilado confirma callback Script en sandbox requerido con resultado 42 (exit 0) y timeout (exit 1 esperado). REA final: interfaz completa `ev_8067b542dfe25eb03060568db05277fa6aa4d2bce26df6ef152fa3b66b957cbf`; permiso con texto adelantado, Ctrl+C y sesión nueva `ev_0ee19c0ab4882858ec82a1f0fc45d2350bc6a43148b97657fc6f21f934d04af9`. Ambas capturas salen con exit 0, sin truncamiento. La segunda confirma también ausencia de `demo.ts`: el texto adelantado no autorizó Create y la negativa posterior no ejecutó Edit. Los mensajes del proveedor sintético son datos de fixture y no sirven de evidencia de escritura; se verifican los efectos observados.

`/themes plain` y stdout no-TTY producen el cuerpo de respuesta sin ANSI y desactivan animación/barra; al cambiar un terminal ya activo se emiten solo los controles necesarios para liberar sus filas y desactivar bracketed paste. El tema no habilita hooks ni evalúa secuencias que lleguen del modelo. El contexto es una estimación por bytes/4, no la medida exacta del tokenizer. Usage no se inventa cuando el proveedor no lo devuelve; estos acumulados no se restauran de una invocación anterior.

El historial guarda como máximo 100 prompts, 32 KiB por prompt y 256 KiB por carpeta, bajo `FABRICA_HOME/prompt-history/<hash-cwd>.json`; no guarda comandos slash ni respuestas a permisos/AskUser. El pegado admite 256 KiB y un número acotado de bloques por sesión. No se interpreta su contenido como teclas de terminal. Las líneas sin delimitadores de bracketed paste conservan el comportamiento normal de readline; el modo por pipe usa líneas explícitas.

Los permisos y AskUser exigen una respuesta nueva posterior al diálogo: descartan texto/cola adelantados y se cancelan cuando no hay TTY. Un error de stdin rechaza la pregunta, interrumpe el agente y libera el terminal. Las pruebas incluyen esos casos para evitar autorización accidental y preguntas colgadas.

Los checkpoints viven bajo un home privado **fuera** del workspace, con lock exclusivo por carpeta y JSON 0600: hasta 20 turnos, 100 archivos por turno, 1 MiB por archivo y 16 MiB de journal codificado. Se guarda intención antes de la escritura anclada y confirmación después. Un fallo entre ambas bloquea el checkpoint. No se toca `.git`, `.fab` ni `.fabrica` mediante el journal. Los subagentes conservan sus checkouts independientes; no heredan la autoridad del journal padre. Los metadatos externos de una misión continúan bajo su autoridad existente y quedan fuera de rewind.

Se comprueban las rutas **reales** del home y del directorio de journal para rechazar aliases hacia el workspace; el descriptor del directorio ancla lock, lectura y escritura durante toda la operación. El directorio debe pertenecer al usuario y no ser escribible por grupo/otros. No se confía únicamente en la forma lexical del path.

**Nunca se revierten los efectos de Execute.** Execute y otras herramientas mutadoras sin registro ponen una barrera persistente antes de ejecutarse; bloquean también los checkpoints anteriores, aunque el comando parezca de lectura o falle. Un Edit posterior sí puede revertirse a los bytes que dejó Execute. Se verifican hash y modo de todos los archivos antes de restaurar, y de nuevo junto a cada operación descriptor-anclada. Los cambios externos posteriores y symlinks se rechazan. No hay transacción de varios archivos frente a escritores externos que compitan durante la restauración; si falla después del primer cambio, se conserva el estado «restauración parcial» para inspección, sin reintento automático. No se borran directorios vacíos ni se restaura la conversación. Tras crash, un lock retenido requiere comprobar el proceso y revisar el journal manualmente; no se rompe por PID o edad.

El punto 8, hooks locales opt-in, queda **pendiente**: no se lee ni ejecuta `.fab/hooks.json`. Falta definir una política verificable de capacidades, entorno, timeout, cancelación y efectos de hooks pre/post en sandbox. Activar shell desde configuración del proyecto sin ese contrato introduciría efectos no registrados. `/hooks` lo indica explícitamente. Login/account/share, marketplaces y daemon 37643 siguen fuera de alcance; esta entrega no afirma paridad total con Droid.
