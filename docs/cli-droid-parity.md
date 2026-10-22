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

Escribir `/` abre sugerencias en vivo con descripción y origen; el texto escrito filtra nombres y descripciones. ↑/↓ seleccionan una sugerencia y Tab o Enter sobre esa selección completa el nombre sin ejecutarlo. Otro Enter envía el comando; escribir directamente un comando completo y Enter conserva su ejecución normal. Tab completa argumentos y, fuera de comandos slash, cambia el razonamiento sin modificar el borrador. `/` seguido de Enter conserva el catálogo agrupado; `/model`, `/auto` y `/mode` abren selección por número o flechas. Shift+Tab cambia auto/spec y añade mission solo si la autonomía ya es high. Ctrl+N cambia entre modelos configurados, Ctrl+L cambia autonomía, Ctrl+O alterna detalle y vuelve a mostrar el último diff ampliado, y Ctrl+T alterna la vista Mission Control cuando hay una misión en curso. Ctrl+C cancela una operación/pregunta activa; Ctrl+D o `/exit` sale. Una barra invertida al final continúa el prompt en otra línea. ↑/↓ recuperan prompts de esta carpeta cuando no hay una paleta abierta. El pegado delimitado se inserta como un bloque visible con ↵ y solo se envía al pulsar Enter.

Sin preferencia guardada, autonomía off. El orden del modelo es flag `-m`, env, modelId del perfil, modelo guardado y detección de auth de Codex/fallback Ollama. Un perfil explícito no queda invalidado por un custom model guardado de otro perfil. La detección de un archivo auth no garantiza que el login esté vigente. No se refrescan credenciales desde esta UI.

## Cobertura implementada

| Área | Comandos y comportamiento propio |
| --- | --- |
| Configuración | `/model [id]`, `/auto [off|low|medium|high]`, `/mode [auto|spec|mission]`, `/settings [model|auto|mode|theme valor]`, `/themes [color|plain]`. No imprime claves del perfil. |
| Estado | `/status`, `/context` (estimación sin schemas), `/limits` (límites locales), `/diagnostics` (sandbox/configuración). Sin consulta de facturación o salud remota. |
| Sesiones | `/sessions`/`/resume [id|--last]`, `/search`/`/find texto`, `/fork [id]`, `/rename título`, `/pin`/`/favorite`, `/archive`, `/tree`, `/mission [status|pause|resume|workers|log|list]` (Mission Control: panel con progreso por feature y milestone, validadores, workers, logs de progreso, pausa/redirección cooperativa y reanudación). Selección solo de la carpeta actual; archived se encuentra con search. |
| Contexto | `/clear` conserva ajustes; `/new` restaura los de arranque. `/compress`/`/compact` resume todos los fragmentos y conserva instrucciones de usuario. `/handoff` crea un fork resumido sin modificar el original. Requieren llamadas al proveedor al invocarse. |
| Consulta lateral | `/btw pregunta` usa spec/off y no guarda ni cambia la sesión principal. |
| MCP | `/mcp [list|enable nombre|disable nombre]`: conecta los configurados al siguiente turno; enable/disable dura esta invocación. Listar no inicia servidores ni afirma conectividad. `/tools` sí puede negociarlos para descubrir schemas y los cierra al terminar. |
| Herramientas | `/tools [list|only nombres|remove nombres|reset]` aplica filtros al motor y a llamadas anidadas. Permisos una vez/cancel y AskUser responden con señales cancelables. `Execute` acepta `background: true` para lanzar subprocesos en segundo plano con retorno inmediato `{ taskId, pid, status: 'running' }`, inspección mediante `TaskOutput` (`block: false` para muestreo parcial o `block: true` para esperar) y detención con `TaskStop` (SIGTERM/SIGKILL), con salida acotada en disco bajo el home privado de la sesión y drenado obligatorio al terminar. `WebSearch` implementa búsqueda web mediante SearXNG o Brave Search sujeta a `networkPolicy`, límites de 64 KiB / 15 s y marcado `external: true`; se desactiva limpiamente en catálogo y falla si no hay proveedor configurado. |
| Trabajo visible | Spinner con tiempo del turno y nombre de herramienta; se oculta al recibir texto o pedir una respuesta al usuario. Dos filas reservadas para trabajo y estado (modelo, modo/autonomía, tokens de usage acumulados durante esta invocación, contexto estimado del último request, incluidos schemas). Se adapta a resize. |
| Respuestas y cambios | Markdown incremental por líneas: títulos, negritas, listas, inline code, bloques cercados con fondo/borde y tablas delimitadas por pipes. Edit/Create/ApplyPatch muestran +/- con números de línea, 12 líneas compactas o hasta 400 ampliadas. ApplyPatch usa un diff propio de un único archivo. |
| Rewind local | `/rewind`, `/rewind list`, `/rewind <id>` restauran únicamente archivos Edit/Create/ApplyPatch del último checkpoint con archivos o del ID elegido. Incluye llamadas anidadas de Script. No rebobina el historial conversacional. |
| Recursos de proyecto | `/skills [nombre]` lista/lee `.agents/skills`; `/skill nombre argumentos` invoca una skill. Skills y prompts de `.agents/commands/*.md` aparecen en la paleta y se invocan por `/nombre argumentos`; `/commands` enumera los invocables. Sustituye `$ARGUMENTS` como texto y elimina el frontmatter antes de enviar el cuerpo al motor. Los comandos integrados y sus aliases tienen prioridad. No sigue catálogos enlazados fuera del proyecto. |
| Proyecto | `/cwd`/`/cd [ruta]` cambia carpeta y abre conversación nueva; `/init [instrucciones]` pide preparar AGENTS.md bajo los permisos y herramientas del agente. |
| Subagentes y procesos | `/droids` informa de Task/SpawnAgent y límites disponibles. `TaskManager` unifica la gestión y ciclo de vida de subagentes aislados y procesos en segundo plano (`Execute` background), gobernados por cuotas estrictas de concurrencia y bytes, y drenado automático al terminar la invocación. Vista Mission Control (atajo Ctrl+T y comando `/mission`) para inspección y control en vivo del progreso por feature y milestone, workers y validación. |
| Ayuda | `/help`, `/terminal-setup` y `/exit`/`/quit`; setup solo informa, no modifica el terminal. |
| Entradas CLI | `fab resume [id]`, `fab --resume [id] --last`, `fab --fork id`, `fab search|find texto`, `fab mcp list --settings archivo`, y flags de chat para cwd/settings/modelo/autonomía/spec/mission/límites/filtros. `fab exec` conserva su API anterior. |

La compresión es una operación local con lock y guardado atómico. Rechaza estados de misión y resúmenes incompletos o que no reducen el contexto. Nunca ejecuta las herramientas que pudiera devolver un proveedor de resumen. No es rewind del filesystem.

Un aborto con llamadas pendientes conserva el snapshot bloqueado y muestra su ID; los siguientes prompts comienzan una sesión nueva. `/resume` y `/fork` rechazan ese snapshot hasta disponer de reconciliación. No se eliminan pending, locks ajenos ni resultados para fingir continuidad. Listado/búsqueda tienen límites de entradas y bytes y anuncian resultados parciales.

## Lo que sigue sin equivalencia

La paleta distingue explícitamente las entradas sin backend. Login/logout/account/share y las instalaciones de automatizaciones de Factory; plugins/marketplaces, hooks de shell, fast mode, idiomas adicionales, statusline ejecutable, rewind completo de la conversación y los flujos migrate/simplify originales no están implementados. No se envían esos comandos al modelo como si hubieran funcionado. Los comandos top-level `daemon`, `plugin` y `computer` fallan explícitamente sin backend (`src/cli.ts:86`). *(Nota de evolución histórica: en la fase inicial de esta comparativa el comando `update` también carecía de backend; a partir de RC.7 `b9e6a10` se implementó el comando oficial `fab update` con soporte de canales, SemVer y detección de método de instalación en `src/update/index.ts`).*

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

## Corrección del stream detenido durante 455 segundos

El timeout de inactividad se aplica a **ambos proveedores**, desde la petición HTTP hasta el último byte del cuerpo: cabeceras pendientes, SSE, JSON y respuestas de error. El valor predeterminado es 120000 ms. Se configura con `FABRICA_STREAM_IDLE_MS`, con `streamIdleMs` en el perfil de settings o por custom model; la precedencia es modelo → perfil → env → predeterminado. También se admite la opción programática `streamIdleMs`; `0` desactiva únicamente este límite y conserva el timeout total. Los valores deben ser enteros entre 0 y 2147483647. Ejemplo: `FABRICA_STREAM_IDLE_MS=60000 ./dist/fab tui` o `{"streamIdleMs":60000,"modelId":"chatgpt:gpt-6-luna"}` en el perfil.

Cada intento tiene su propio AbortController. Los bytes reales, incluidos comentarios SSE/heartbeats, reinician el contador; los chunks vacíos no. El timeout aborta esa petición y devuelve `ProviderError` reintentable, sin abortar la señal del agente. La cancelación del usuario y el timeout total prevalecen y no se convierten en reintentos de inactividad. No se espera indefinidamente a `reader.cancel()` y se retiran los temporizadores/listeners al terminar. No hay un bucle nuevo de reintentos: el motor permite como máximo tres intentos, reducidos por `maxRecoveryAttempts` y por su presupuesto compartido de llamadas. Las herramientas solo se despachan tras un turno válido completo. La TUI delimita el texto parcial, anuncia el reintento y vuelve al indicador de modelo.

`tests/agent-stream-idle.test.ts` prueba sin red (fetch sustituido por streams de memoria) los dos proveedores, un chunk seguido de silencio, cancelación que nunca termina, ausencia de cabeceras, heartbeats, chunks vacíos, cuerpos JSON/error detenidos, cancelación del usuario, timeout total, agotamiento de reintentos, configuración y separación del texto parcial en TUI. La prueba previa de Claude en `tests/agent-chatgpt.test.ts` se conserva. Los hooks opcionales siguen pendientes por el contrato de capacidades y efectos descrito arriba. El recibo de esta corrección es [evidence/stream-idle-validation.json](evidence/stream-idle-validation.json); los recibos de TUI anteriores conservan sus hashes históricos y no certifican el binario nuevo.

Resultado: **177 pass, 0 fail**, 773 aserciones, 19 archivos; TypeScript y diff-check exit 0. SHA-256 del binario recompilado: `0347c2f8ef44a3baf72b6cdb6288ff5cbcadfdada723d8e2e3b27535fa138587`. Probe compilado Script/callback y timeout: correcto. Captura REA `ev_017339d5a53d5d2863fdaa8e5b6a2fd57a1ce0a8b108717af34cfb2879c93a08`: proveedor sintético con timeout de 350 ms, Create válido → stream parcial detenido → reintento → respuesta final; exit 0 sin truncamiento. Se comprobaron los bytes originales de `demo.ts`, la ausencia de `should-not-exist` y un único tool ejecutado. La captura incluye spinner, diff, Ctrl+O, Markdown, barra y resize. Se conserva íntegra en [evidence/stream-idle-pty-attempt-1.json](evidence/stream-idle-pty-attempt-1.json). No se probó de nuevo el servicio comercial que originó los 455 segundos; la reproducción de regresión es determinista. La instalación global no se cambia en esta tarea.

## Segunda pasada: bienvenida, sugerencias y skills

Esta pasada parte de `e5548de` y de la [captura del usuario](evidence/droid-0.244-slash-menu.png), abierta antes de editar. FAB muestra su logo propio, la versión real `0.1.0` de package.json, tips que cambian entre arranques y atajos. Los nombres y textos de interfaz son propios. El usuario retiró después la restricción sobre reutilizar prompts; esta implementación no necesitó extraerlos.

| Visto en Droid 0.244.0 | Estado en FAB | Evidencia y alcance |
| --- | --- | --- |
| Logo grande, versión, tip, dos líneas de atajos | **Hecho** con identidad FAB y versión de package.json | `src/chat/chrome.ts:16`; Droid D3; FAB F2/F3; test de welcome. Abrir la paleta ya no tapa tips/atajos. |
| `/` filtra sugerencias con descripción y origen | **Hecho**: nombre, descripción, origen; selección con flechas; completar separado de enviar | `src/chat/palette.ts:6`, `src/chat/terminal.ts:77`; Droid D3/D4; FAB F2; test de paleta/CRLF/pegado/permisos. El ranking propio no replica exactamente el del original. |
| Skills y comandos locales aparecen como slash commands | **Hecho** para `.agents/skills/<nombre>/SKILL.md` y `.agents/commands/<nombre>.md` | `src/chat/project.ts:23`, `src/chat/controller.ts:92`; Droid D4; FAB F2 y dos requests sintéticos conservados en el recibo. |
| `/skills`, `/skill`, `/plugins`, skills de Factory visibles | **Parcial**: skills locales e invocación implementadas; `/plugins`, `/install-triage` y `/detect-overlapping-workstreams` indican backend no disponible | `src/chat/commands.ts:15`; screenshot/D3/D4 y FAB F2. No se instalan las 22 skills empaquetadas observadas en Droid. |
| Skills/MCP/Connectors/AGENTS.md en barra | **Parcial**: recursos locales contados; AGENTS legible presente/ausente; MCP configurado **sin verificar**; Connectors no disponible | `src/chat/chrome.ts:7`, `src/chat/controller.ts:84`; Droid D3 sin recursos de proyecto y D4 con ellos; FAB F2/F3. Un ✓ original de MCP con `/bin/false` no demuestra conexión. |
| Autonomía a la izquierda; modelo y razonamiento a la derecha | **Hecho** en estado idle; trabajo/spinner reutiliza esa fila durante el turno | `src/chat/chrome.ts:11`, `src/chat/presentation.ts:39`; captura usuario y FAB F2. En Spec se anuncia sin escrituras aunque la autonomía sea low/high. |
| Shift+Tab y Ctrl+L | **Hecho** con gates existentes del motor; no se concede mission sin high | Droid D3/D6, FAB F2; regresión `tests/chat.test.ts`. |
| Ctrl+N cambia el modelo | **Parcial**: FAB cicla directamente los configurados; Droid abre un selector | Droid D5/D6; FAB F2. Cambiar el label no sustituye el ID enviado al proveedor. |
| Tab cambia esfuerzo de razonamiento | **Hecho** en FAB: low/medium/high, persistencia y envío real al proveedor; `/reasoning default` restaura el predeterminado | `src/chat/controller.ts:73`; FAB F2 requests low/high; test de razonamiento. En Droid los modelos genéricos del replay no mostraron cambio: el atajo y High proceden de la captura del usuario, no de una verificación completa del original. |

Identificadores completos y salidas en [evidence/paridad-2-validation.json](evidence/paridad-2-validation.json): D1–D6 son `paridad-2-droid-1..6.json`; F1 es `paridad-2-fab-source-1.json` (intermedio); F2 es `paridad-2-fab-compiled-final.json`; F3 es `paridad-2-fab-source-empty-final.json`. Los intentos D1/D2 no prueban navegación completa; D4 contiene una secuencia de entrada que acabó invocando un prompt sintético en lugar del modal MCP. D5 permaneció en el selector; D6 completa el cambio de modelo. Todos se conservan con sus límites.

**Resultado final histórico de la fase 2:** 183 pass, 0 fail, 866 aserciones en 20 archivos; TypeScript y diff-check exit 0. Se recompiló `dist/fab`, SHA-256 `867f5bceef0dc41992874836998400075d971cd1765ca3a50f273f16f639bcc8`; su probe confirma callback Script aislado y timeout. F2/F3 terminan con exit 0 sin truncamiento. No se actualizó el FAB global ni se usaron modelos comerciales. El [informe de esta pasada](report-codex-tui-paridad-2.md) incluye pruebas reproducibles, referencias locales consultadas con Graft y pendientes. Los recibos anteriores conservan sus identidades históricas.

---

## Estado consolidado en `main` `f023e47` (v0.1.0-rc.9)

A la versión `f023e47`, el motor, la TUI y la distribución incorporan las siguientes capacidades:
- **RC.7 (`b9e6a10`):** Instaladores por canales (`install.sh`, `latest.sh`, `prerelease.sh`) y autoactualización `fab update` con preservación del prefix y método original.
- **RC.8 (`fc6fc84`):** Permisos de red por llamada para la herramienta `Execute` (`--sandbox-network auto|ask|deny`, `network: true`, comando `/network` en TUI).
- **RC.9 (`f023e47`):** Modo YOLO por invocación (`--yolo`, `/yolo`) para ejecución directa en el host y red sin prompts interactivos, confinado estrictamente a la invocación activa y sin persistirse en la sesión.
- **Protocolo RPC (11 métodos en `src/agent/rpc.ts`):** 8 métodos de solicitud entrantes (`droid.initialize_session`, `droid.list_models`, `droid.list_tools`, `droid.update_session_settings`, `droid.add_user_message`, `droid.interrupt_session`, `droid.load_session`, `droid.close_session`), 2 de solicitud saliente (`droid.request_permission`, `droid.ask_user`) y 1 notificación (`droid.session_notification`).

### Tabla de flags de `fab exec` (desde código en `src/agent/exec.ts`)

| Flag / Argumento | Tipo | Descripción |
| :--- | :--- | :--- |
| `[prompt]` | Posicional | Prompt inicial (o leído de stdin si no es TTY). |
| `-f, --file <path>` | String | Lee el prompt desde un archivo especificado. |
| `--cwd <path>` | String | Directorio de trabajo base. |
| `-m, --model <id>` | String | Sobrescribe el modelo configurado. |
| `--base-url <url>` | String | Endpoint HTTP base del modelo. |
| `--settings <file>` | String | Archivo JSON de configuración de perfiles y MCP. |
| `--yolo` | Booleano | Ejecuta en host y red sin sandbox ni confirmaciones (ámbito exclusivo de esta invocación). |
| `--auto <nivel>` | String (`off\|low\|medium\|high`) | Nivel de autonomía del agente. |
| `--use-spec` | Booleano | Modo solo lectura / investigación (excluyente con `--mission`). |
| `--spec-model <id>` | String | Modelo propio para modo spec (requiere `--use-spec`). |
| `--spec-reasoning-effort <effort>` | String | Esfuerzo de razonamiento para modo spec (requiere `--use-spec`). |
| `-r, --reasoning-effort <effort>` | String | Nivel de razonamiento (`default\|low\|medium\|high`). |
| `--mission` | Booleano | Inicia modo misión jerárquico (excluyente con `--use-spec`). |
| `--worker-model <id>` | String | Modelo para workers en modo misión (requiere `--mission`). |
| `--worker-reasoning-effort <effort>` | String | Esfuerzo de razonamiento para workers en modo misión (requiere `--mission`). |
| `--validator-model <id>` | String | Modelo para validadores en modo misión (requiere `--mission`). |
| `--validator-reasoning-effort <effort>` | String | Esfuerzo de razonamiento para validadores en modo misión (requiere `--mission`). |
| `-w, --worktree [name]` | String (opcional) | Ejecuta en un worktree git (rama `<actual>-wt` por defecto o nombre indicado). |
| `--worktree-dir <path>` | String | Deprecado (preferencia: `worktreeDirectory` en settings). |
| `-o, --output-format <formato>` | String (`text\|json\|stream-json\|stream-jsonrpc`) | Formato de salida. |
| `--input-format <formato>` | String (`stream-jsonrpc`) | Formato de entrada por stdin. |
| `-s, --session-id <id>` | String | Reanuda una sesión por ID (excluyente con `--fork`). |
| `--fork <id>` | String | Bifurca una sesión existente (excluyente con `--session-id`). |
| `--session-dir <path>` | String | Directorio de persistencia de sesiones. |
| `--session-title <title>` | String | Fija el título de la sesión (máximo 200 caracteres, sin saltos de línea). |
| `--only-tools <csv>` | String | Lista delimitada por comas de herramientas permitidas o selectores `MCP:<server>[/<tool>]`. |
| `--add-tools <csv>` | String | Añade herramientas o selectores `MCP:<server>[/<tool>]` a la selección. |
| `--remove-tools <csv>` | String | Lista delimitada por comas de herramientas prohibidas. |
| `--disable-builtin-skills` | Booleano | Registra desactivación de skills de plataforma (fab no incluye skills integradas de proveedor). |
| `--tag <name>` | String (múltiple) | Etiquetas asociadas a la sesión. |
| `--append-system-prompt <text>` | String | Concatena texto al prompt del sistema. |
| `--append-system-prompt-file <path>`| String | Concatena archivo al prompt del sistema. |
| `--timeout-ms <N>` | String | Timeout total en milisegundos. |
| `--max-turns <N>` | String | Límite máximo de turnos conversacionales. |
| `--max-context-tokens <N>` | String | Límite de tokens en el historial. |
| `--sandbox <modo>` | String (`required\|best-effort`) | Nivel de exigencia del sandbox bwrap. |
| `--sandbox-network <política>` | String (`auto\|ask\|deny`) | Política de red para `Execute`. |
| `--list-tools` | Booleano | Lista catálogo de herramientas y sale. |
| `--require-status` | Booleano | Exige bloque `STATUS:` en la respuesta final. |
| `-h, --help` | Booleano | Muestra la ayuda y sale. |

*Nota sobre flags analizados:* La opción `-f, --file <path>` ya existía en fab. Las opciones `--rm` y `--force` referenciadas en análisis preliminares se confirmaron como falsos positivos tras cotejar la ayuda real de `droid exec` (`evidence-exec-help.json`), donde `--rm` era parte de comandos de ejemplo de `docker run --rm` y `--force` no figura en las opciones de ejecución. Ninguna de las dos se implementa.

### Tabla de comandos slash `/` en TUI (desde código en `src/chat/commands.ts`)

| Grupo | Comando | Alias | Descripción / Estado |
| :--- | :--- | :--- | :--- |
| **Ayuda** | `/help` | `/?` | Catálogo de comandos y atajos de teclado. |
| **Ayuda** | `/terminal-setup` | — | Mostrar atajos sin modificar el terminal. |
| **Ayuda** | `/exit` | `/quit` | Salir de la TUI. |
| **Configuración** | `/model` | — | Seleccionar modelo configurado o introducir su ID. |
| **Configuración** | `/reasoning` | — | Esfuerzo low, medium, high o default; Tab lo alterna. |
| **Configuración** | `/auto` | — | Autonomía off, low, medium o high. |
| **Configuración** | `/yolo` | — | Ver estado de YOLO (solo activable con `--yolo` al arrancar). |
| **Configuración** | `/network` | — | Red de Execute: auto (automática solo en high), ask o deny. |
| **Configuración** | `/mode` | — | Modo auto, spec o mission (requiere high). |
| **Configuración** | `/settings` | — | Ver ajustes o cambiar model/auto/mode/theme/reasoning/network. |
| **Configuración** | `/themes` | — | Elegir color o plain. |
| **Configuración** | `/cwd` | `/cd` | Ver o cambiar carpeta; abre conversación nueva. |
| **Capacidades** | `/mcp` | — | Servidores configurados y exclusión local por sesión. |
| **Capacidades** | `/tools` | — | Catálogo de herramientas y filtros only/remove/reset. |
| **Capacidades** | `/skills` | — | Listar skills del proyecto o leer una por nombre. |
| **Capacidades** | `/skill` | — | Invocar una skill local: `/skill nombre argumentos`. |
| **Capacidades** | `/commands` | — | Listar prompts propios de `.agents/commands/*.md`. |
| **Capacidades** | `/droids` | — | Ver capacidades y límites de subagentes propios. |
| **Sesión** | `/context` | — | Estimar tokens del historial, sin llamar al modelo. |
| **Sesión** | `/limits` | — | Ver límites locales de ejecución. |
| **Sesión** | `/status` | — | Modelo, modo, autonomía, carpeta y sesión. |
| **Sesión** | `/diagnostics` | — | Diagnóstico local de sandbox y configuración. |
| **Sesión** | `/clear` | — | Nueva conversación conservando ajustes actuales. |
| **Sesión** | `/new` | — | Nueva conversación con los ajustes de arranque. |
| **Sesión** | `/sessions` | `/resume` | Seleccionar sesión local o reanudar por ID. |
| **Sesión** | `/search` | `/find` | Buscar texto en las sesiones de esta carpeta. |
| **Sesión** | `/fork` | — | Crear una rama de la conversación actual o indicada. |
| **Sesión** | `/tree` | — | Ver parentesco de los forks locales. |
| **Sesión** | `/rename` | — | Cambiar título de la sesión actual. |
| **Sesión** | `/favorite` | `/pin` | Fijar o desfijar sesión. |
| **Sesión** | `/archive` | — | Archivar sesión y abrir una conversación nueva. |
| **Sesión** | `/compress` | `/compact` | Resumir el historial sin ejecutar herramientas. |
| **Sesión** | `/handoff` | — | Crear un fork con historial resumido; conserva el original. |
| **Sesión** | `/btw` | — | Consulta lateral readonly, sin cambiar el historial principal. |
| **Sesión** | `/rewind` | — | Restaurar archivos del último checkpoint, por ID, o listarlos con list; excluye Execute. |
| **Proyecto** | `/init` | — | Pedir al agente que prepare `AGENTS.md`, con los permisos actuales. |
| **Sin backend** | `/account`, `/login`, `/logout`, `/share`, `/install-code-review`, `/install-triage`, `/detect-overlapping-workstreams`, `/plugins`, `/hooks`, `/fast`, `/language`, `/statusline`, `/rewind-conversation`, `/migrate`, `/simplify` | — | Informa explícitamente que la funcionalidad no dispone de servicio local en vez de fingir soporte. |

### Resultado de la suite consolidada
A la versión `f023e47`, la suite completa registra:
```bash
bun test
```
**252 pass, 0 fail, 1.481 expect() calls en 29 archivos** (ejecución completa exit 0 en ~26 s; `bunx tsc --noEmit` exit 0).


## Patch propio: spec, propuestas y ApplyPatch (base c58467f)

| Herramienta / id observado | Categoría | Implementación en FAB | Límite de evidencia |
| --- | --- | --- | --- |
| ExitSpecMode / exit-spec-mode | read; defaultAllowed false | Solo spec raíz; confirmación salvo high; transición al próximo turno, contexto y schemas renovados; evento mode_changed / notificación fab_mode_changed | Catálogo original confirmado; semántica propia verificada con proveedores deterministas |
| StageSettingsChanges / stage_settings_changes | read; defaultAllowed true | Propuesta estructurada y settings_staged; TUI aplicar/descartar con respuesta nueva; RPC fab_settings_staged; techos del host y sin YOLO/sandbox | Catálogo original confirmado; aplicación propia solo por el operador |
| ApplyPatch / apply-patch-cli | edit; defaultAllowed false | Archivo absoluto único, @@ y prefijos espacio/-/+; escritura atómica, rutas ancladas, permisos y rewind de Edit/Create | Catálogo original confirmado; gramática propia, no equivalencia byte por byte |
| Loop / loop-cli | execute; defaultAllowed false | Contrato propio: comando simple repetido 1..50 veces, condición de salida/regex; cada Execute pasa por dispatcher; cancelación y presupuesto de misión | Catálogo original confirmado; semántica propia, original bloqueado en la nueva captura |
| FetchUrl / fetch_url | read; defaultAllowed true | HTTP(S), permiso de red por llamada, destinos privados bloqueados, DNS fijado, 5 redirects, 1 MiB y timeout total | Catálogo original confirmado; lectura propia, original bloqueado en la nueva captura |

El inventario autenticado histórico `ev_e92431f6094e3464761b91f54fea5b65592ecd987f84dca9f9d9644bf6c9f790` confirma esos tres ids/categorías/defaultAllowed dentro de 30 entradas. Se leyeron solo los campos del inventario, sin copiar descripciones o código propietario.

En esta tarea se repitieron tres escenarios REA con el Droid seleccionado (SHA-256 ya indicado), dentro de bwrap: raíz RO, workspace y HOME nuevos escribibles, /tmp efímero, entorno limpio y namespace sin red. Los tres terminaron con exit 1 antes de ejecutar herramientas: airgap rechaza el modelo proxy gpt-6-sol y pide configurar BYOK. Esto es un bloqueo de configuración, no prueba de ausencia de funciones ni de login fallido. No se copiaron credenciales ni se hicieron llamadas comerciales.

- Spec/ExitSpecMode: `ev_b9b14948cbeda3381a841880599412628dfdaa64eb606469675952ae05431952`.
- Propuesta de ajustes: `ev_972a2dbd34f124ec7060ccc96ba25c5b8a93428cc7457a0fcaf34732b1dfc63b`.
- Edición/ApplyPatch: `ev_f7786ab345742e0a6a484d83cdd3a730d3df0487c55272dd8971c9e8bdee9ee7`.

Los [recibos completos](evidence/tools-spec-settings-patch/rea-captures.json) conservan argumentos, salida y límites. Su hash de launcher corresponde a bwrap; la identidad de Droid se midió por separado. El muestreo de procesos no es exhaustivo y no se pidieron observaciones de archivos: no permite afirmar ausencia global de efectos.

Las decisiones de diseño y límites están en [el contrato del motor](../src/agent/README.md#herramientas-de-modo-propuestas-y-patches). `fab exec --list-tools` ahora aplica filtros only/remove al inventario mostrado: ExitSpecMode desaparece fuera de spec y ApplyPatch desaparece con `--remove-tools apply-patch-cli`. No se añadieron flags, servicios de Factory ni dependencia de Droid.

Pruebas reproducibles del patch:

```bash
bun test tests/agent-session-tools.test.ts tests/agent-patch.test.ts tests/chat-session-tools.test.ts tests/rpc-session-tools.test.ts tests/agent-tasks.test.ts
bun test
bunx tsc --noEmit
git diff --check
```

Resultado de este patch: **279 pass, 0 fail, 1.707 aserciones, 33 archivos** (27 casos nuevos). TypeScript y diff-check: exit 0. [Recibo de validación](evidence/tools-spec-settings-patch/validation.json). No es una publicación ni una validación de modelos comerciales.


## Loop y FetchUrl propios (base main 79793e7)

La entrega incorpora Loop y FetchUrl al catálogo, CLI/TUI/RPC y callbacks Script mediante el dispatcher existente. No añade comandos slash ni flags, ni depende de Droid para ejecutarse. Las entradas y límites propios están en [README del motor](../src/agent/README.md#loop-y-fetchurl-base-main-79793e7).

Inventario original: `ev_e92431f6094e3464761b91f54fea5b65592ecd987f84dca9f9d9644bf6c9f790` (30 entradas). Se consultaron solo campos id/llmId/category/defaultAllowed: Loop = loop-cli / execute / false; FetchUrl = fetch_url / read / true. No se copiaron esquemas ni descripciones.

Nuevos escenarios REA bajo bwrap, raíz RO, HOME/workspace propios, entorno explícito, airgap y namespace sin red:

| Solicitud | Evidencia | Resultado observado |
| --- | --- | --- |
| Loop con pwd y máximo dos intentos | ev_4c0c21e623da669a1b8af728fa6156b3573f98865e4486adfd100231152dd5c1 | Exit 1 antes de usar herramientas: airgap rechaza gpt-6-sol vía proxy y pide configurar BYOK |
| FetchUrl de example.com | ev_a963f7e0bc10d4a63f76208746b214a9179b9bd5df1e271273bf248697c2a884 | Mismo bloqueo de configuración; no se observó descarga |

El SHA-256 de Droid sigue siendo `f4740a4821288415a5089c04a3cc3e6bfbd7866137863422d1d9a220b31640e2`, coincidente con el histórico 0.244.0. No se habilitó red ni se copiaron credenciales para superar el bloqueo. [Capturas completas](evidence/loop-fetch-url/rea-captures.json): identifican el launcher bwrap; la identidad de Droid se midió aparte. Muestreo de procesos y sin snapshot de archivos: no hay prueba de ejecución exitosa de estas herramientas originales ni de ausencia global de efectos.

```bash
bun test tests/agent-loop.test.ts tests/agent-fetch-url.test.ts
bun test
bunx tsc --noEmit
git diff --check
```

Los escenarios de FetchUrl usan servidores HTTP locales con la excepción de direcciones privadas solo en pruebas; no consultan servicios remotos. Cubren SSRF, DNS mixto, redirecciones, timeout/cancelación, streaming/truncado, extracción HTML y resultado máximo por motor/RPC. Loop cubre permisos por iteración, misiones, budget, filtros/Script, límites, cancelación repetida tres veces y regex fuera del hilo del agente. La revisión corrigió un desajuste Unicode que podía dejar cuerpo de script en texto extraído. [Recibo final](evidence/loop-fetch-url/validation.json).

Validación final de Loop/FetchUrl: **313 pass, 0 fail, 1.947 aserciones en 36 archivos**; 26 casos nuevos. TypeScript y diff-check con salida 0.

## Proveedores de modelos BYOK y Google Gemini (base feat/providers-mcp)

La especificación BYOK observada por REA (`docs-md/pages/model-independence/byok.md`) reconoce tres familias de proveedores configurables mediante `customModels`:

1. `anthropic`: Messages API en streaming (`/v1/messages`) con versión de protocolo fija (`2023-06-01`), autenticación mediante cabecera `x-api-key` (por defecto) o `Authorization: Bearer` cuando se especifica `authMode: "bearer"`. Mapeo directo de bloques de mensajes de fab (system como campo de primer nivel, llamadas a herramientas como `tool_use`, y resultados como `tool_result` dentro del rol user), soporte de razonamiento mediante `thinking` con presupuesto por nivel (`low`, `medium`, `high`, `extra-high`), y control de caché efímero en system mediante `extraArgs.promptCache: true`.
2. `openai`: Responses API nativa en streaming (`/responses`), reutilizando el codec estructurado de eventos Responses con cabecera `Authorization: Bearer <apiKey>` y `baseUrl` configurable (`https://api.openai.com/v1` por defecto).
3. `generic-chat-completion-api`: Endpoint estándar compatible con OpenAI (`/chat/completions`).

### Google Gemini mediante endpoint OpenAI-compatible

Como observó REA en la arquitectura de modelos BYOK de Droid, **no existe un tipo de proveedor nativo independiente para Google** en la configuración. Google Gemini se utiliza oficialmente a través del proveedor `generic-chat-completion-api` aprovechando la interfaz OpenAI-compatible que ofrece Google en `generativelanguage.googleapis.com/v1beta/openai/`:

```json
{
  "customModels": [
    {
      "id": "gemini-2.5-pro",
      "model": "gemini-2.5-pro",
      "provider": "generic-chat-completion-api",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "apiKey": "${GEMINI_API_KEY}",
      "displayName": "Google Gemini 2.5 Pro"
    },
    {
      "id": "gemini-2.5-flash",
      "model": "gemini-2.5-flash",
      "provider": "generic-chat-completion-api",
      "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "apiKey": "${GEMINI_API_KEY}",
      "displayName": "Google Gemini 2.5 Flash"
    }
  ]
}
```

Las credenciales soportan tanto variables de entorno `${VAR}` como la directiva `apiKeyHelper` para ejecutar comandos locales sin shell con refresco automático ante códigos de respuesta HTTP 401.
