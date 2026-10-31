# Motor propio de `fab exec`

Agente de código autónomo e independiente, implementado sobre Bun y TypeScript. El adaptador `native` es el motor predeterminado para los nuevos workstreams de la fábrica y opera tanto desatendido como mediante la interfaz CLI interactiva.

```bash
bun src/cli.ts exec --cwd /ruta/proyecto --auto medium \
  -m qwen3.5-32k:latest --base-url http://127.0.0.1:11434/v1 \
  'Investiga, corrige el fallo y ejecuta los tests'
```

Formatos soportados: `text`, `json`, `stream-json` (eventos de progreso estructurados) y protocolo `stream-jsonrpc` bidireccional sobre NDJSON (`--input-format stream-jsonrpc --output-format stream-jsonrpc`).

Los frames de transporte RPC están acotados a un máximo de 10 MiB. El sobre JSON-RPC 2.0 incluye las cabeceras protocolarias `factoryApiVersion: 1.0.0` y `factoryProtocolVersion: 1.269.0`.

El bucle central procesa texto por streaming, reúne las llamadas a herramientas emitidas antes de despacharlas, correlaciona sus resultados mediante identificadores únicos de invocación, maneja errores para el turno subsiguiente y controla estrictamente presupuestos de llamadas, recuperación y contexto. La compactación contextual cubre todos los fragmentos descartados, recomprime resúmenes previos y preserva intactas las instrucciones de usuario, fallando explícitamente si no logra reducir la ventana de contexto.

---

## Tabla de Opciones de `fab exec`

Generada directamente a partir de la especificación de argumentos en `src/agent/exec.ts:32-45`:

| Opción / Flag | Tipo / Valores | Descripción y Comportamiento en Código |
| :--- | :--- | :--- |
| `[prompt]` | Posicional | Texto de instrucción para el agente (si se omite y stdin no es TTY, se lee de stdin). |
| `-f, --file <path>` | String | Lee el prompt del agente directamente desde un archivo (`src/agent/exec.ts:95`). |
| `--cwd <path>` | String | Directorio de trabajo base para la ejecución del agente (por defecto `process.cwd()`). |
| `-m, --model <id>` | String | Identificador del modelo a utilizar; sobrescribe la configuración por defecto (`-m`). |
| `--base-url <url>` | String | URL base del endpoint HTTP del modelo (sobrescribe `FABRICA_LLM_BASE_URL`). |
| `--settings <file>` | String | Ruta al archivo JSON con perfiles de configuración, modelos custom y servidores MCP. |
| `--yolo` | Booleano | Ejecuta en el host sin sandbox y con red abierta, omitiendo prompts interactivos. Ámbito exclusivo de la invocación actual (`src/agent/execution-policy.ts`). |
| `--auto <nivel>` | `off`, `low`, `medium`, `high` | Nivel de autonomía del agente; determina las herramientas y comandos admitidos sin aprobación. |
| `--use-spec` | Booleano | Activa el modo de solo lectura (spec); bloquea mutaciones. Excluyente con `--mission`. |
| `-r, --reasoning-effort <effort>` | String | Esfuerzo de razonamiento del modelo (`default`, `low`, `medium`, `high`). |
| `--mission` | Booleano | Inicia una misión jerárquica con orquestador, workers y validadores (`src/agent/mission.ts`). |
| `--worker-model <id>` | String | Modelo asignado al rol worker en misiones (requiere `--mission`). |
| `--validator-model <id>` | String | Modelo asignado al rol validator en misiones (requiere `--mission`). |
| `-o, --output-format <formato>` | `text`, `json`, `stream-json`, `stream-jsonrpc` | Formato de salida del resultado y eventos del agente (`short: 'o'`). |
| `--input-format <formato>` | `stream-jsonrpc` | Formato de entrada de comandos y mensajes por stdin (requiere `-o stream-jsonrpc`). |
| `-s, --session-id <id>` | String | Reanuda una conversación previa por su ID de sesión (excluyente con `--fork`). |
| `--fork <id>` | String | Bifurca el historial de una sesión existente creando un nuevo ID de sesión. |
| `--session-dir <path>` | String | Directorio de persistencia de sesiones (por defecto `~/.fabrica/agent-sessions`). |
| `--only-tools <csv>` | CSV de nombres | Restringe las herramientas activas a las listadas en formato delimitado por comas. |
| `--remove-tools <csv>` | CSV de nombres | Deshabilita explícitamente las herramientas indicadas. |
| `--tag <name>` | String (múltiple) | Asigna etiquetas descriptivas a la sesión para categorización y filtrado. |
| `--append-system-prompt <text>` | String | Concatena texto adicional al prompt del sistema base del agente. |
| `--append-system-prompt-file <path>`| String | Concatena el contenido de un archivo al prompt del sistema. |
| `--timeout-ms <N>` | Entero (ms) | Tiempo límite total de la invocación en milisegundos. |
| `--max-turns <N>` | Entero | Límite máximo de turnos conversacionales antes de detener la invocación. |
| `--max-context-tokens <N>` | Entero | Límite máximo del presupuesto de tokens en el historial conversacional. |
| `--sandbox <modo>` | `required`, `best-effort` | Exige aislamiento en Linux con `bwrap` (`required`) o permite degradación (`best-effort`). |
| `--sandbox-network <política>` | `auto`, `ask`, `deny` | Política de red para `Execute`: `auto` (solo automático en high), `ask` (consulta), `deny` (bloqueo). |
| `--list-tools` | Booleano | Muestra el catálogo de herramientas configuradas y finaliza con código 0. |
| `--require-status` | Booleano | Valida que la respuesta final incluya un bloque `STATUS:` reconocible por la fábrica. |
| `-h, --help` | Booleano | Imprime el resumen de ayuda CLI y termina. |

---

## Políticas de Ejecución, Red Opt-in y Modo YOLO

### 1. Resolución de Autoridad (`src/agent/execution-policy.ts`)
La política de ejecución se resuelve al inicializar el agente y devuelve un objeto inmutable congelado (`Object.freeze`):
- **Modo Standard (por defecto):** Confinamiento estricto en sandbox `bwrap` (Linux) y política de red predeterminada offline para comandos.
- **Modo YOLO (`--yolo`):** Habilita ejecución en host (`/bin/sh -c`), acceso libre a red host y omisión de prompts interactivos (`permission_bypass`).
  - **Efímero por diseño:** El modo YOLO aplica únicamente a la invocación actual. **Nunca se persiste en la sesión ni en el snapshot**, por lo que reanudar con `--session-id` o bifurcar con `--fork` vuelve al modo standard (`tests/yolo-interfaces.test.ts:51`).
  - **El modelo no puede auto-otorgarse YOLO:** La autoridad proviene de las opciones CLI del anfitrión (`src/agent/exec.ts:58`). Los requests JSON-RPC rechazan explícitamente campos como `yolo`, `permissionMode` o `executionPolicy` con código `-32602` (`src/agent/rpc.ts:64`).

### 2. Red Opt-in para la Herramienta `Execute` (`src/agent/network-policy.ts`)
Por defecto, la ejecución en sandbox carece de interfaces de red externas (`--unshare-net`):
- El modelo puede emitir `Execute` con el parámetro `network: true`. Este parámetro es una **solicitud**, no una concesión automática.
- La red se concede por llamada a `Execute`: cada comando y cada reintento que necesite acceso remoto debe incluir `network: true`; una aprobación previa no se hereda.
- La política de red (`--sandbox-network` o comando `/network` en TUI) decide:
  - `deny`: Bloquea permanentemente todo intento de red para el comando.
  - `ask`: Solicita aprobación interactiva al usuario antes del spawn del subproceso.
  - `auto`: Concede acceso a red automáticamente **únicamente bajo autonomía `high`**. En niveles `off`, `low` o `medium`, solicita aprobación interactiva.
- **Alcance de `networkPolicy`:** La política de red aplica a los comandos ejecutados por `Execute` dentro del sandbox y a las solicitudes HTTP externas realizadas por la herramienta `WebSearch`. No rige el transporte HTTP del proveedor del modelo ni los servidores MCP (MCP stdio usa `allowNetwork: true` en su configuración; MCP HTTP utiliza su propio transporte HTTP).

### 3. Matriz de Ejecución de `Execute`

| Modo | Autonomía | `network: false` (o ausente) | `network: true` | Comportamiento en Sandbox |
| :--- | :--- | :--- | :--- | :--- |
| **Standard** | `off`, `low`, `medium` | Sin red (offline) | Pregunta al usuario (`ask`); error si no hay TTY | Sandbox requerido; no cambia la política general. |
| **Standard** | `high` (política `auto`) | Sin red (offline) | Permitido automáticamente con red | Sandbox requerido con namespace de red habilitado. |
| **Standard** | Cualquiera (`deny` o `spec`) | Sin red (offline) | Rechazado | El comando no se ejecuta. |
| **YOLO** | Forzado a `high` efectivo | Red host | Red host | Sin sandbox `bwrap`, shell anfitrión `/bin/sh -c`. |

### 4. Ámbitos que Suspenden o Reducen YOLO
Incluso si la sesión fue iniciada con `--yolo`, existen ámbitos protegidos que degradan automáticamente la autoridad a `standard / spec / required / deny` (`src/agent/execution-policy.ts:34`):
- **Modo Spec (`--use-spec` o `/mode spec`):** Bloquea escrituras y red.
- **Consulta lateral `/btw`:** Ejecuta en modo spec con autonomía `off` sin permisos interactivos.
- **Subagentes `explore` (`Task` con rol explore):** Confinados en modo spec de solo lectura y sandbox requerido.
- **Validadores de Misión (`--mission`):** Los validadores operan estrictamente en solo lectura con sandbox requerido y sin red. *(Advertencia de seguridad: Aunque los validadores operan aislados, un worker ejecutado en YOLO sobre el shell del host tiene acceso a los procesos del sistema; la separación de validadores en YOLO es lógica en el orquestador, no una barrera del kernel frente a un worker host malicioso).*

---

## Niveles de Autonomía y Permisos

El parámetro `--auto <nivel>` (y `/auto` en TUI) configura la compuerta de herramientas:
- **`off`:** Las operaciones mutadoras (`Create`, `Edit`) y la ejecución de comandos shell (`Execute`) requieren aprobación interactiva del usuario (`proceed_once` o `cancel`). **Aclaración importante:** Las herramientas puramente de lectura (`Read`, `LS`, `Glob`, `Grep`) y el diálogo interactivo de preguntas (`AskUser`) no pasan por `permissionHandler` y no requieren aprobación en `off`.
- **`low`:** Permite herramientas básicas de edición; comandos shell continúan requiriendo confirmación.
- **`medium`:** Permite comandos de desarrollo simples y encadenamientos seguros (`cd <dir> && npm test`).
- **`high`:** Permite ejecución autónoma de comandos shell y concesión automática de red (si la política es `auto`).

---

## Protocolo JSON-RPC y Métodos Soportados

El runtime expone un servidor bidireccional sobre NDJSON (`src/agent/rpc.ts`) con **11 métodos implementados**:

### Métodos de Solicitud Entrantes (Inbound Requests — 8 métodos)
1. `droid.initialize_session`: Inicializa la sesión con el ID de máquina del cliente, directorio de trabajo `cwd`, modelo y parámetros de interacción. Devuelve ID de sesión, modelos disponibles y configuración de ejecución.
2. `droid.list_models`: Enumera los modelos actualmente configurados y disponibles para la sesión.
3. `droid.list_tools`: Devuelve el catálogo completo de herramientas con su estado de habilitación, nivel de autonomía requerido y descripción.
4. `droid.update_session_settings`: Actualiza en caliente parámetros de la sesión activa (`modelId`, `autonomyLevel`, `interactionMode`, `restrictToolIds`, `disabledToolIds`).
5. `droid.add_user_message`: Agrega un mensaje de usuario a la conversación e inicia el turno de trabajo y streaming del asistente.
6. `droid.interrupt_session`: Solicita la interrupción controlada del turno activo en ejecución mediante su señal de cancelación.
7. `droid.load_session`: Carga una sesión persistida previamente desde el almacén de sesiones (`SessionStore`).
8. `droid.close_session`: Cierra ordenadamente la sesión activa y aborta cualquier trabajo pendiente.

### Métodos de Solicitud Salientes (Outbound Requests — 2 métodos)
9. `droid.request_permission`: Solicita confirmación interactiva al cliente para ejecutar una herramienta que requiere aprobación (`proceed_once` o `cancel`).
10. `droid.ask_user`: Envía un cuestionario estructurado al cliente (`questions`, `topics`, `options`) para resolver ambigüedades técnicas y espera la selección del usuario.

### Métodos de Notificación Salientes (Outbound Notifications — 1 método)
11. `droid.session_notification`: Notificación de eventos de progreso, cambios de estado (`droid_working_state_changed`), deltas de texto del asistente (`assistant_text_delta`), resolución de permisos (`permission_resolved`), y finalización de turnos (`agent_turn_completed`).

---

## Catálogo de Comandos de la TUI

La interfaz interactiva (`src/chat/commands.ts:3-52`) registra **36 comandos locales activos** organizados por grupos funcionales y **15 comandos con advertencia explícita de servicio no disponible**:

| Grupo | Comando | Parámetros / Alias | Descripción |
| :--- | :--- | :--- | :--- |
| **Ayuda** | `/help` | `/?` | Despliega el catálogo de comandos y atajos de teclado. |
| **Ayuda** | `/terminal-setup` | — | Muestra información de atajos de teclado sin alterar la configuración del terminal. |
| **Ayuda** | `/exit` | `/quit` | Cierra la sesión interactiva y libera la consola. |
| **Configuración** | `/model` | `[id]` | Abre selector de modelos configurados o asigna un identificador directamente. |
| **Configuración** | `/reasoning` | `[default\|low\|medium\|high]` | Modifica el nivel de esfuerzo de razonamiento del modelo (también con `Tab`). |
| **Configuración** | `/auto` | `[off\|low\|medium\|high]` | Cambia el nivel de autonomía del agente. |
| **Configuración** | `/yolo` | — | Informa el estado del modo YOLO (solo activable vía `--yolo` al arrancar). |
| **Configuración** | `/network` | `[auto\|ask\|deny]` | Configura la política de red para la herramienta `Execute`. |
| **Configuración** | `/mode` | `[auto\|spec\|mission]` | Cambia entre modo interactivo (`auto`), solo lectura (`spec`) o misión (requiere high). |
| **Configuración** | `/settings` | `[clave valor]` | Visualiza o actualiza ajustes de modelo, autonomía, temas o red. |
| **Configuración** | `/themes` | `[color\|plain]` | Alterna entre interfaz con formato y color ANSI o salida limpia en texto plano. |
| **Configuración** | `/cwd` | `[ruta]`, `/cd` | Muestra o cambia el directorio de trabajo; abre una nueva conversación. |
| **Capacidades** | `/mcp` | `[list\|enable\|disable]` | Gestiona servidores MCP configurados y exclusiones locales por sesión. |
| **Capacidades** | `/tools` | `[list\|only\|remove\|reset]`| Muestra el catálogo de herramientas y aplica filtros temporales. |
| **Capacidades** | `/skills` | `[nombre]` | Lista las skills del proyecto (`.agents/skills`) o muestra el contenido de una. |
| **Capacidades** | `/skill` | `<nombre> [args]` | Invoca una skill local pasando argumentos específicos. |
| **Capacidades** | `/commands` | — | Lista prompts personalizados descubiertos en `.agents/commands/*.md`. |
| **Capacidades** | `/droids` | — | Informa las capacidades y límites de los subagentes internos (`Task`, `SpawnAgent`). |
| **Sesión** | `/context` | — | Calcula y muestra la estimación de tokens consumidos en el historial. |
| **Sesión** | `/limits` | — | Presenta los límites vigentes de turnos, contexto y timeouts. |
| **Sesión** | `/status` | — | Resumen del modelo activo, modo, nivel de autonomía, ruta y sesión. |
| **Sesión** | `/diagnostics` | — | Diagnóstico de salud local: disponibilidad de bubblewrap, permisos y settings. |
| **Sesión** | `/clear` | — | Inicia una nueva conversación conservando los ajustes de configuración actuales. |
| **Sesión** | `/new` | — | Inicia una nueva conversación restaurando los ajustes originales de arranque. |
| **Sesión** | `/sessions` | `[id]`, `/resume` | Abre el selector de sesiones locales o reanuda una sesión por su ID. |
| **Sesión** | `/search` | `<texto>`, `/find` | Busca texto en el historial de sesiones guardadas del repositorio actual. |
| **Sesión** | `/fork` | `[id]` | Crea una bifurcación de la conversación actual o de la indicada. |
| **Sesión** | `/tree` | — | Visualiza el árbol de parentesco de las bifurcaciones y sesiones locales. |
| **Sesión** | `/rename` | `<título>` | Asigna un título personalizado a la sesión actual. |
| **Sesión** | `/favorite` | `/pin` | Marca o desmarca la sesión como favorita. |
| **Sesión** | `/archive` | — | Archiva la sesión activa y abre una conversación limpia. |
| **Sesión** | `/compress` | `/compact` | Reduce el historial resumiendo turnos anteriores sin ejecutar herramientas. |
| **Sesión** | `/handoff` | — | Genera una bifurcación con el historial comprimido manteniendo intacta la sesión original. |
| **Sesión** | `/btw` | `<pregunta>` | Ejecuta una consulta secundaria en solo lectura sin alterar el historial principal. |
| **Sesión** | `/rewind` | `[list\|<id>]` | Restaura archivos mutados por `Edit`/`Create` al estado de un checkpoint previo. |
| **Proyecto** | `/init` | `[instrucciones]` | Solicita al agente la creación estructurada del archivo `AGENTS.md`. |
| **Sin backend** | `/account`, `/login`, `/logout`, `/share`, `/install-code-review`, `/install-triage`, `/detect-overlapping-workstreams`, `/plugins`, `/hooks`, `/fast`, `/language`, `/statusline`, `/rewind-conversation`, `/migrate`, `/simplify` | — | Comandos sin backend local; la TUI muestra un mensaje explícito explicando la ausencia de servicio remoto en vez de enviar el comando al modelo. |

---

## Rebobinado de Archivos (`/rewind` en `src/chat/checkpoints.ts`)

- **Estado: IMPLEMENTADO (Archivos):** El comando `/rewind`, `/rewind list` o `/rewind <id>` restaura de manera determinista los archivos alterados o creados por las herramientas `Edit`, `Create` y `ApplyPatch`. Utiliza un journal privado ubicado fuera del workspace (`~/.fabrica/file-checkpoints/`) con registros de intención y verificación de hashes SHA-256 antes y después de cada escritura.
- **Límites conocidos:**
  - **No revierte `Execute`:** La ejecución de comandos shell mediante `Execute` coloca una barrera permanente en el journal que invalida la restauración a checkpoints anteriores al comando.
  - **No revierte la conversación:** No es un rewind de los turnos de diálogo ni de los mensajes enviados al modelo (el comando sin backend `/rewind-conversation` lo advierte explícitamente).

---

## Ejecución de Comandos en Segundo Plano (`Execute` con `background: true`)

El adaptador nativo soporta el lanzamiento y control de procesos en segundo plano:

- **Lanzamiento inmediato:** `Execute` con `background: true` valida la política de comandos, inicia el subproceso y devuelve de inmediato `{ taskId: string, pid: number, status: 'running' }` sin bloquear el turno del agente.
- **Gestión mediante la familia `Task`:**
  - `TaskOutput`: Acepta identificadores `task_id` tanto de subagentes como de subprocesos en background. Con `block: false` realiza un muestreo parcial sin bloquear; con `block: true` (predeterminado) espera la terminación y entrega `{ stdout, stderr, output, exitCode, sandboxed, network }`.
  - `TaskStop` / `InterruptAgent`: Detiene un proceso activo enviando `SIGTERM` y escalando a `SIGKILL` si no finaliza en 200 ms, marcando la tarea como `cancelled` de forma limpia.
  - `ListAgents`: Enumera tanto subagentes como subprocesos en ejecución o finalizados en la invocación.
- **Salida acotada y aislamiento de archivos:**
  - Los streams de `stdout` y `stderr` se canalizan a disco bajo el home privado de la sesión (`$SESSION_HOME/tasks/<taskId>.stdout` y `.stderr`). Si la sesión se configuró dentro del workspace, el runtime redirige la salida a un directorio temporal privado (`/tmp/fab-session-<id>/tasks/`), asegurando que **nunca se escriban archivos ni logs de tareas en el workspace**.
  - La salida está estrictamente acotada por `maxProcessOutputBytes` (por defecto 1 MiB, configurable). Al alcanzar el límite, se detiene la escritura a disco y se añade el marcador `\n[output truncated at limit]\n`.
  - Concurrencia de procesos acotada por `maxBackgroundProcesses` (por defecto 4, configurable hasta 32).
- **Drenado en el ciclo de vida (Lifecycle Drain):**
  - Al terminar la invocación del agente (fin normal de turnos, timeout o cancelación/aborto), `TaskManager.close()` mata y drena todos los procesos en segundo plano antes de retornar el resultado o emitir notificaciones terminales, evitando escrituras tardías.
- **Seguridad y Permisos:**
  - Confinamiento idéntico a `Execute` síncrono: corre dentro del sandbox `bwrap` (en Linux), con política de red offline por defecto (`--unshare-net`) y aislamiento de filesystem.
  - En modo YOLO (`--yolo`): Ejecuta en el shell del host (`/bin/sh -c`) con red del host sin requerir confirmación interactiva.
  - En modo spec (`--use-spec`): Bloquea explícitamente el lanzamiento de comandos en background (`Spec mode denies background command execution`).
- **Comportamiento en Sesiones:**
  - Un proceso en background no se reanuda tras `resume` o `fork`. El snapshot de la sesión registra su estado terminal (`completed`, `failed` o `cancelled`) y su código de salida para consultas retrospectivas sin revivir el subproceso.

---

## Búsqueda Web (`WebSearch`)

El runtime incorpora la herramienta `WebSearch` (`src/agent/web-search.ts`), clasificada como operación de lectura (`effect: 'read'`):

- **Parámetros de invocación:**
  - `query`: Cadena de búsqueda (obligatoria, acotada a un máximo de 512 caracteres).
  - `maxResults`: Número máximo de resultados a retornar (entero entre 1 y 20, por defecto 5).
- **Formato del resultado:** Devuelve una lista de resultados `[{ title: string, url: string, snippet: string, external: true }]` junto al identificador del proveedor utilizado (`provider: string`). El atributo `external: true` identifica explícitamente contenido originado fuera de los límites del host.
- **Proveedores configurables (sin clave ni endpoint remoto por defecto):**
  - `searxng`: Configurado mediante `FABRICA_SEARCH_PROVIDER=searxng` y URL del motor en `FABRICA_SEARCH_URL` (o mediante `searchConfig`). Consume la API JSON nativa (`format=json`).
  - `brave`: Configurado mediante `FABRICA_SEARCH_PROVIDER=brave` y clave en `FABRICA_SEARCH_API_KEY` (opcionalmente URL alternativa en `FABRICA_SEARCH_URL`). Autentica mediante cabecera `X-Subscription-Token`.
  - `none` / ausente: Si no se configuran variables de entorno ni opciones de búsqueda, la herramienta aparece en el catálogo (`describeTool`) con `defaultAllowed: false` y `currentlyAllowed: false` (marcada como no disponible), y cualquier intento de invocación falla de inmediato con error explícito sin simular resultados.
- **Integración con Política de Red (`networkPolicy`):**
  - Reutiliza la misma compuerta de seguridad que `Execute` con solicitud de red:
    - `deny`: Bloquea permanentemente la llamada con error explicativo.
    - `ask`: Solicita confirmación interactiva al operador antes de despachar la petición HTTP.
    - `auto`: Concede la conexión automáticamente únicamente bajo autonomía `high`; en niveles `off`, `low` o `medium` requiere confirmación interactiva.
  - **Modo Spec (`--use-spec`):** Dado que `WebSearch` es una herramienta de lectura pura (`effect: 'read'`), no es bloqueada por la barrera de mutaciones de spec mode, pero su acceso externo permanece estrictamente gobernado por la política de red (`auto` en `high` o aprobación interactiva en `ask`).
- **Límites de Seguridad y Red:**
  - **Timeout estricto:** Acotado mediante `AbortSignal.timeout(15_000)` (15 segundos).
  - **Respuesta acotada:** Streaming con interrupción forzada a los 64 KiB; si la respuesta del proveedor supera 64 KiB, se aborta y se rechaza la llamada.
  - **Validación de redirecciones:** Manejador manual de redirecciones HTTP (máximo 5 saltos) que restringe los esquemas admisibles exclusivamente a `http:` y `https:`, impidiendo accesos mediante `file:`, `data:` u otros protocolos no previstos, y detectando ciclos de redirección.
  - **Protección de Credenciales:** La clave de API y tokens de autenticación se enmascaran en el transporte y nunca se exponen en eventos de progreso, mensajes de error, logs de depuración ni snapshots de sesión persistidos en disco.

---

## Subagentes y Confinamiento

- **Catálogo de herramientas:** `Read`, `LS`, `Create`, `Edit`, `ApplyPatch`, `ExitSpecMode` (solo spec raíz), `StageSettingsChanges`, `Glob`, `Grep`, `Execute`, `Loop`, `FetchUrl`, `WebSearch`, `Script`, `TodoWrite`, `AskUser`, `Skill`, `ToolSearch` y herramientas de subagentes (`src/agent/catalog.ts`).
- **Subagentes (`Task`, `SpawnAgent`):** Generan clones aislados fuera del workspace del proceso padre. Copian el estado del árbol de trabajo (incluyendo modificaciones sin commit). Comparten presupuestos: profundidad máxima 2, hasta 8 subagentes por sesión, concurrencia máxima 2 y 256 llamadas acumuladas al proveedor. Los subagentes en background se drenan y cancelan al finalizar la invocación.
- **Advertencia sobre Skills y Enlaces Simbólicos:** La interfaz TUI (`/skill`) resuelve enlaces simbólicos internos en `.agents/skills`; sin embargo, la herramienta `Skill` del agente utiliza el acceso anclado por descriptor que rechaza enlaces simbólicos de directorio (`src/agent/files.ts:23`).

---

## Misiones Autónomas (`--mission`)

En modo misión (`--mission --auto high`), el runtime habilita `ProposeMission`, `StartMissionRun`, `DismissHandoffItems` y `EndFeatureRun`.

Cada característica definida en `features.json` establece un contrato estricto:
- `verificationCommands`: Comandos deterministas ejecutados por el **propio runner** en un sandbox aislado sin red y sobre una copia desechable del código.
- `protectedPaths`: Archivos que los workers tienen estrictamente prohibido alterar (ej. suites de test de referencia). Si un worker muta una ruta protegida, la misión se detiene inmediatamente antes de la validación.
- **Validación dual:** Dos validadores independientes inspeccionan cada hito en solo lectura; si alguno reporta anomalías o no ejecuta al menos una comprobación exitosa, el hito no se aprueba.

---

## Alcance Pendiente Honesto

Las siguientes capacidades permanecen sin implementar o fuera de alcance:
1. **Herramientas de agente:** Script conserva su salida entre invocaciones, sin resucitar procesos; no ofrece ejecución tras cerrar el turno. Loop ofrece un contrato propio acotado, sin afirmar la semántica original completa.
2. **Recuperación:** Locks antiguos inválidos o guardas de recuperación abandonadas requieren revisión manual. No se revierten efectos inciertos.
3. **Protocolos:** ACP y demonio en puerto 37643 permanecen fuera de alcance.
4. **MCP:** Transporte SSE de versión previa y actualización de catálogo en caliente.
5. **Aislamiento en plataformas no-Linux:** En macOS no existen namespaces de Linux (`bwrap`); las herramientas operan sin confinamiento de kernel equivalente.

---

## Verificación y Estado de la Suite

Para validar el motor y la consistencia de tipos:

```bash
bun test
bunx tsc --noEmit -p .
```

Los recibos de validación indican la base, los hashes del código probado y los resultados de cada tarea; el recibo de Mission Control está en `docs/evidence/mission-control/validation.json`.


## Herramientas de modo, propuestas y patches

Implementación propia; los nombres/ids se contrastan con el inventario REA de Droid 0.244.0. Los nuevos intentos de ejecución del original quedaron bloqueados antes de invocar herramientas por airgap/modelo proxy; no prueban equivalencia de comportamiento. Recibos completos en `docs/evidence/tools-spec-settings-patch/rea-captures.json`.

| Herramienta | ID de catálogo | Efecto / permiso |
| --- | --- | --- |
| ExitSpecMode | exit-spec-mode | read, no permitida por defecto; solo spec raíz habilitado |
| StageSettingsChanges | stage_settings_changes | read, permitida por defecto; nunca aplica cambios |
| ApplyPatch | apply-patch-cli | write interno / edit en catálogo; mismo permiso que Edit |
| Loop | loop-cli | execute; no permitida por defecto; cada iteración usa Execute |
| FetchUrl | fetch_url | read; permitida por defecto; red condicionada por política/confirmación |

**ExitSpecMode** acepta `{reason?: string}` (máximo 8 KiB). Con off/low/medium solicita confirmación por TUI/RPC; un exec desatendido la rechaza. High permite la transición. Todo el lote actual, incluidos callbacks Script, conserva spec: solo el siguiente turno del modelo usa auto, con la misma autonomía y política de ejecución/red. Se actualizan schemas, contexto y evento `mode_changed`. `allowExitSpecMode: false` confina un ámbito; se impone a subagentes, workers/validadores y /btw. No hay un nuevo permiso persistente en el snapshot.

Si la TUI/RPC suspendió YOLO/red al entrar en spec, la salida pedida por el modelo conserva standard y red deny entre prompts. Un cambio de modo explícito o el inicio/carga de otra conversación por el operador puede restaurar la política de arranque.

**StageSettingsChanges** acepta un objeto no vacío con `modelId`, `autonomy` y/o `networkPolicy` (8 KiB máximo, modelId de hasta 256 caracteres). Solo modelos configurados; enum off/low/medium/high y auto/ask/deny. El host puede fijar `settingsPolicy: {modelIds, maxAutonomy, networkPolicy}`; por defecto se usa el modelo y el techo efectivos. Deny no puede relajarse, ask no puede pasar a auto; no acepta campos YOLO/sandbox. Devuelve `{proposalId, changes, applied:false}` y emite `settings_staged`.

La TUI revisa hasta 64 propuestas después de un resultado correcto: cada una exige una respuesta nueva «aplicar / descartar». Valida el proveedor antes de mutar el estado; usa los cambios solo para futuras solicitudes. El techo se captura al comenzar el turno: aceptar una reducción no impide aceptar después otra propuesta dentro de ese mismo techo, con nueva confirmación. No guarda los campos staged ni al persistir un tema/razonamiento distinto. Una orden manual /model, /auto o /network sí puede guardar el campo elegido. /new, /sessions, /fork, /handoff, /archive y /cwd eliminan overrides staged; /clear conserva ajustes por su contrato explícito. /btw no aplica propuestas a la conversación principal. RPC solo informa mediante `fab_settings_staged`, dentro de `droid.session_notification`; no incorpora un método nuevo de aplicación automática. Su actualización existente permite al cliente elegir modelo/autonomía; red sigue siendo configuración del host. El cambio de modo se comunica como `fab_mode_changed`.

**ApplyPatch** acepta `{patch:string}` (1 MiB máximo), un solo archivo absoluto y como máximo 128 hunks. Formato propio:

```text
*** Update File: /ruta/absoluta/archivo
@@
 línea de contexto
-antes
+después
```

Para crear: `*** Add File: /ruta/absoluta/nuevo` seguido solo de líneas `+`. Acepta envoltorio opcional `*** Begin Patch` / `*** End Patch`. Rechaza varios archivos, operaciones diferentes, hunks ambiguos/inaplicables o sin contexto, rutas fuera del workspace, symlinks y sobrescritura mediante Add. Solo texto UTF-8 sin NUL; Update requiere LF y conserva la presencia del salto final. No implementa rangos numéricos de unified diff, renames ni deletes como directiva. La búsqueda KMP evita coste cuadrático en archivos repetitivos. Archivo base y resultado limitados a 1 MiB; escritura atómica y journal/rewind compartidos con Edit/Create, también mediante Script.

La opción del host `requireReadBeforeEdit: true` exige para Edit y ApplyPatch una lectura previa válida del archivo y coincidencia de los bytes actuales con el hash leído. No persiste el historial de lecturas; Add sobre un archivo inexistente no lo necesita. Sin esta opción se conserva el comportamiento previo de Edit.

Validación final de este patch: **279 pass, 0 fail, 1.707 aserciones en 33 archivos**; `bunx tsc --noEmit` y `git diff --check` con salida 0. Incluye 27 casos nuevos. Recibo: `docs/evidence/tools-spec-settings-patch/validation.json`.


## Loop y FetchUrl (base main 79793e7)

Implementaciones propias basadas en el contrato de la tarea. REA confirma nombres/IDs/categorías en el inventario histórico; las nuevas capturas del original se bloquearon por airgap/modelo proxy antes de ejecutar herramientas. No se copiaron código, descripciones, esquemas ni prompts propietarios.

### Loop

Entrada:

```json
{"command":"bun test","until":"exit_zero","maxIterations":10,"intervalMs":1000,"network":false}
```

Para buscar una condición textual: `until:"output_matches"` y `pattern:"READY"`. El patrón RegExp no admite flags separados y tiene máximo 256 caracteres; el matching ocurre en un worker Script aislado sin herramientas, con deadline de 1 s, por lo que una regex costosa no bloquea el agente. Sigue la semántica RegExp de Bun y sus propios límites internos.

Acepta un comando simple de hasta 16 KiB, sin operadores de shell, expansiones ni secuencias &&; conserva argumentos entre comillas. No acepta background ni campos ajenos. maxIterations: 1..50 (10 por defecto); intervalMs: 0..60000 (1000 por defecto). Devuelve `{iterations,satisfied,lastExitCode,lastOutput}`; lastOutput concatena stdout y stderr del último Execute. Agotar iteraciones devuelve satisfied:false; un error del dispatcher, cancelación o error del matcher sí aborta el Loop.

Cada iteración se invoca por el mismo dispatcher que Execute: aplica filtros, permisos de comando y red por llamada, sandbox, journal y observación de misiones. En concreto, beforeTool se comprueba también en Execute interno; afterTool mantiene su alcance previo de llamadas del modelo, y la observación missionWorker.observe sí recibe cada Execute. No se transfiere a las iteraciones la autonomía high temporal que autorice el Loop: off/low pueden requerir permiso para Loop y después para cada Execute. Network true solicita red por cada ejecución, sin concesión duradera. Spec deniega Loop incluso con high o desde Script.

Loop es una herramienta compuesta sin lease propia del scheduler; los Execute internos sí se serializan. En misión/missionWorker consume una unidad del presupuesto compartido de llamadas al admitir cada invocación Loop, además de las llamadas del modelo existentes; no consume una unidad por iteración. Usa la reserva del run cuando existe. El observador de comandos conserva el límite previo de 200 registros por intento; cada ejecución sigue notificándose por el dispatcher.

La cancelación interrumpe la espera entre iteraciones y mata/drena el proceso foreground actual; no inicia el siguiente. Execute foreground ahora activa el mismo cierre de grupo/drenado acotado que YOLO al terminar el líder o exceder salida; los procesos duraderos requieren background explícito. La salida cruda mantiene el máximo de Execute de 256 KiB; el resultado JSON de Loop admite hasta 2 MiB para su escape y metadatos. Loop coloca una barrera de rewind como Execute, sin prometer deshacer efectos de shell.

### FetchUrl

Entrada:

```json
{"url":"https://example.com/documento","maxBytes":262144,"timeoutMs":10000}
```

Solo HTTP(S), sin userinfo con credenciales, URL de hasta 8192 caracteres, sin campos adicionales. maxBytes: 1..1048576 (256 KiB por defecto); timeoutMs: 1..30000 (10000 por defecto). Devuelve `{status,contentType,bytes,truncated,text,source:"external",warning}`. bytes cuenta bytes crudos retenidos, no caracteres ni tamaño total del recurso; truncated indica que se observó contenido adicional. Un HTTP 4xx/5xx es una respuesta con su status, no un error de transporte.

Red deny bloquea; ask exige aprobación por llamada; auto concede automáticamente solo en high. En off/low/medium sin handler interactivo se rechaza. FetchUrl puede usarse como lectura en spec si el host mantiene una política permisiva y la concede; los ámbitos TUI/RPC spec, explore, validadores y /btw que fuerzan deny permanecen sin red. El permiso identifica la URL y sus redirecciones validadas, sin conceder red a Execute ni almacenar autorizaciones.

Se resuelve y valida todo el conjunto de IPs por cada salto y se fija una de ellas al socket mediante lookup, sin una segunda resolución. Bloquea por defecto loopback, link-local, privadas, CGNAT, multicast y rangos reservados/documentación, incluidos IPv4 alternativos normalizados y IPv4 mapeadas en IPv6. IPv6 es conservador: unicast global sin rangos de transición/especiales. `FABRICA_FETCH_ALLOW_PRIVATE=1` es una excepción del entorno del host para pruebas, no un argumento del modelo.

Máximo cinco redirecciones, cada destino nuevamente validado; no admite otro esquema ni userinfo en los saltos. Requests sin reutilización de agente, proxies automáticos, cookies ni headers de autenticación; User-Agent fab, TLS/certificado/SNI del hostname original. El timeout total abarca DNS, redirecciones, headers y cuerpo. Al abortar/truncar se destruye la conexión; una resolución DNS pendiente puede continuar en el sistema, pero su resultado tardío no inicia HTTP.

Se solicita identity y se rechazan respuestas comprimidas para evitar expansión fuera del presupuesto. Se decodifica como UTF-8 con reemplazo de bytes inválidos; un corte en medio de un carácter puede producir U+FFFD. HTML/XHTML anunciado por Content-Type se convierte a texto con un extractor lineal simple: elimina tags, comentarios, scripts y estilos; decodifica entidades comunes/numéricas. No es un DOM, no ejecuta JavaScript ni carga subrecursos. La conversión de mayúsculas preserva offsets UTF-16 incluso ante Unicode.

El resultado marca todo contenido como externo/no confiable. Es dato para el modelo: no se ejecuta ni se transforma en instrucciones del runtime. El límite de JSON del resultado FetchUrl es 8 MiB para permitir escape de hasta 1 MiB de bytes descargados; se mantiene el frame RPC de 10 MiB. Existe una regresión de 1 MiB de controles por RPC. Los límites existentes de contexto e historial siguen vigentes; Script puede consumir el resultado y devolver una síntesis bajo su límite de resultado habitual.

Pruebas dirigidas: `bun test tests/agent-loop.test.ts tests/agent-fetch-url.test.ts`. Recibos REA en `docs/evidence/loop-fetch-url/rea-captures.json`; validación completa en `docs/evidence/loop-fetch-url/validation.json`.

Validación final de Loop/FetchUrl: **313 pass, 0 fail, 1.947 aserciones en 36 archivos**; 26 casos nuevos. TypeScript y diff-check con salida 0.

## Mission Control: eventos, métricas y pausa del host

El host recibe `mission_state_changed`, `mission_worker_started`,
`mission_worker_completed`, `mission_feature_updated`,
`mission_milestone_validated`, `mission_paused` y `mission_progress` mediante
`onEvent`. Todos incluyen `sessionId` y `missionId`. Los eventos de worker
incluyen `milestone`; al terminar incluyen `usage`, `durationMs`, `exitCode`,
`hasHandoff` y, cuando existen, `successState` y `error`. Un handoff es una
pretensión del worker: su `successState` no sustituye la verificación del runner.

`mission_progress.snapshot`, `StartMissionRun.progressSnapshot` y
`AgentResult.mission.snapshot` comparten `MissionProgressSnapshot`, exportado
por el módulo público. Contiene misión/estado/fecha, features con milestone,
estado e intentos, hitos con ambos validadores y resultado de verificadores,
los 100 intentos más recientes y totales de features, tokens y duración.
Features e hitos están limitados a 100; no contiene prosa de handoffs. Los
identificadores se acotan a 100 caracteres y el título a 200. Los totales de
consumo abarcan todos los intentos conservados, incluidos fallidos y pausados;
la duración suma los tiempos de los hijos, no el tiempo de planificación del
orquestador. Datos antiguos sin métricas muestran cero. El límite previo de
100 intentos persistidos por misión sigue vigente, independientemente del
límite de visualización del snapshot.

Cada `MissionAttempt` guarda métricas del `AgentResult` del hijo en la sesión
autoritativa y en `handoffs/<workerSessionId>-<n>.json`. Si el hijo no llegó a
devolver resultado, se registra consumo cero y duración local transcurrida.

```ts
const pause = new AbortController();
const result = await runCodingAgent({
  ...options,
  mission: { ...options.mission, pauseSignal: pause.signal },
});
// Desde el control interactivo mientras StartMissionRun esté activo:
// pause.abort();
```

Abortar `pauseSignal` fuera de StartMissionRun no cambia la misión. Si ya está
abortada al entrar, devuelve pausado antes de leer planificación o reservar
presupuestos. Durante un run cancela y drena el hijo, incluidos sus procesos
foreground/background, antes de devolver `{started:true, paused:true,
progressSnapshot}`; emite `mission_paused` con `reason: 'host_request'`.
El intento termina al publicar `mission_worker_completed`; una pausa posterior
afecta al run y conserva ese intento ya completado. Una pausa durante su
persistencia se reconcilia antes del evento terminal.
El intento interrumpido guarda `error: 'Paused by host'` y `pausedByHost: true`;
no aumenta el contador de reintentos de feature o validador. Las reservas y los
límites globales de agentes/llamadas siguen aplicándose. Un aborto del turno del
orquestador prevalece sobre la pausa y devuelve error de aborto.

El host debe proporcionar una señal nueva para continuar. La redirección por
`receiveMessages` llega al siguiente turno del modelo del orquestador;
`resumeWorkerSessionId` retoma el hijo propio y `messageToWorker` le entrega
instrucciones nuevas, también a validadores. Si se pausó antes de guardar la
sesión del hijo, el runner crea esa misma ID reservada al reanudar. El marcador
`sessionCreated` distingue este caso; un error al cargar una sesión existente
no activa ninguna creación alternativa.

Solo una capacidad interna vinculada a esa invocación permite cerrar llamadas
interrumpidas después del drenado, añadiendo resultados explícitos de
interrupción sin reproducir herramientas. No habilita recuperación genérica
tras caída del proceso ni para abortos ordinarios. Un handoff parcial enviado
antes de pausar puede reanudarse, pero sus ítems pendientes siguen exigiendo
`DismissHandoffItems` antes de completar la misión.

Las razones de pausa son `host_request`, `worker_failed`, `validation_failed`,
`protected_paths_changed`, `verification_missing` y `error`. Un fallo de worker
o un error de preflight deja ahora la misión en `paused`. Los retornos
voluntarios con asuntos pendientes conservan `orchestrator_turn`. El contrato
sellado, los archivos protegidos, el observador de comandos y ambos validadores
siguen siendo obligatorios: sin verificadores del contrato ejecutados y
exitosos, repetir StartMissionRun nunca concede `completed`.


## Script durable y WaitForScript

`Script({code, await?: boolean})` observa hasta 30 s; `await:true` amplía esa
observación hasta 10 minutos. Si termina, entrega el RunScriptResult habitual.
Si sigue vivo, devuelve `{status:'running', runId, toolCallId, elapsedMs}`.
`WaitForScript({toolCallId, timeoutMs?, kill?})` controla la llamada original:
con timeout devuelve `running`, content y notifications parciales y vacía ese
búfer; al terminar devuelve estado, runId, duración y result. timeoutMs se
acota a 10 minutos (30 s por defecto). `kill:true` cancela y drena herramientas
anidadas antes de devolver `killed`; no deshace efectos ya aplicados.

Se permiten cuatro runs vivos por invocación. No consumen plazas de procesos
Execute background. La admisión de VM y herramientas comparte las plazas de
maxToolConcurrency: el Script cede su plaza a callbacks y la recupera al
continuar; Wait controla la plaza del propio run para no bloquear su finalización.
Se conserva el scheduler de lecturas/escrituras. No es una cuota de CPU o memoria
del sistema operativo. Script y WaitForScript no pueden ser las únicas
herramientas seleccionadas. Las herramientas anidadas conservan el contexto de
permisos/autonomía/red al lanzar el Script y pasan por el mismo dispatcher,
políticas del llamador y observador de misión. Wait no pide aprobación propia.

El búfer conserva hasta 5 MiB por run y, además, 5 MiB entre todos los runs
retenidos (contenido más resultados), y hasta 20 notificaciones por run.
Descarta excesos con un aviso; el programa sigue ejecutándose. Un resultado
que no cabe se sustituye por un error output_limit. El registro limita a 64
runs sin leer; hay que consumir los terminados para admitir más. Las lecturas
parciales liberan espacio. Los límites del resultado y del frame NDJSON siguen
siendo 5 y 10 MiB respectivamente. Cada run durable tiene plazo total de 24 h,
subordinado al timeout/cierre del agente; observar 10 minutos no concede ese
tiempo adicional al turno del agente.

Mientras nadie espera, notify emite script_notified y se entrega como dato en
el siguiente límite del modelo. Un run terminado sin espera se entrega mediante
un mensaje sintético una sola vez, incluso si termina durante la respuesta final
del proveedor. Esa entrega consume el resultado, igual que la lectura final por
Wait: una consulta posterior falla como ID consumida. También se emiten
script_started (inicio y transición a background) y script_completed con estado,
duración y número de eventos de salida.

El snapshot backgroundScripts incluye identidad, estado, inicio y salida acotada.
Reanudar marca cancelled los registros running y conserva la salida para una
lectura explícita por WaitForScript; nunca restaura procesos ni permisos. Al
terminar o abortar el turno, o cerrar la sesión RPC, se matan y drenan todos los
runs y callbacks antes de resolver. Un fallo de persistencia no omite el cierre
de otros procesos. La persistencia de salida no es recuperación automática de
llamadas de herramientas interrumpidas.

En spec o sin context.tasks se conserva la ejecución bloqueante: al vencer el
plazo se mata el Script y se espera el drenado. Sin detach, la API programática
runScript conserva los límites acumulativos previos; detach ofrece handle con
done, kill y drained. El modo streaming del runtime es una opción explícita del
host; el manager implementa el descarte y retención acotados.


## stream-json de entrada

`fab exec --input-format stream-json -o stream-json` acepta líneas `{type:"user",content:"..."}`, `{type:"interrupt"}` y `{type:"end"}` (EOF termina los prompts ya aceptados). Mismo sessionId entre turnos, evento turn_end; interrupt cancela y drena solo el turno activo. Máximo 1 MiB por línea y 64 prompts en cola; líneas inválidas avisan y se descartan. Es deprecado: se recomienda stream-jsonrpc. No admite prompt posicional, --file ni --mission.

## Journal y reconciliación

Cada sesión escribe journal append-only con fsync antes de efectos. Un PID muerto comprobado permite recuperar el lock y reconciliar llamadas inciertas sin repetir herramientas; lecturas/no iniciadas se descartan. Un registro final roto se repara; corrupción intermedia falla. PID vivo, lock inválido y guarda de recuperación abandonada bloquean. El evento reconciled identifica efectos inciertos. Las misiones interrumpidas quedan paused y permiten retomar el worker propio; sesiones antiguas sin journal conservan el rechazo de pending. Un interrupt de stream reconcilia únicamente después del drenado probado. En Linux, la cancelación termina el árbol background propio, con PID y hora de inicio verificados, antes de su monitor bwrap.

## Hooks
Opt-in en exec con --hooks o settings hooks.enabled=true; archivos `$FABRICA_HOME/hooks.json` y `.fab/hooks.json`. Soporta PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart/End; otros eventos admitidos avisan sin ejecutarse. Máximo ocho comandos por evento, timeout 60 s, salida 64 KiB y matching regex aislado con 500 ms. allow solo sustituye aprobación puntual: no anula red deny, spec, filtros ni sellos de misión. updatedInput pasa por el dispatcher; Stop bloquea como máximo dos veces. Contexto/feedback llegan al modelo como datos. Misma política host/sandbox, workspace de solo lectura en spec, env mínimo y sin red en sandbox. Hooks excluidos de Script anidado e hijos; SessionStart/End una vez por proceso stream. SessionEnd tiene plazo de cierre de 1 s. Settings se activa con --settings <archivo>; exec no descubre una ruta por defecto. Chat queda pendiente por propiedad de archivos.
## RPC: hooks y MCP
`initialize_session` acepta `hooks` y `mcpServers`; RPC ejecuta el ciclo de hooks y ofrece `list_mcp_servers`, `list_mcp_tools` y `authenticate_mcp_server`.
## SDK
`fabrica/sdk` exporta sesiones y servidores MCP locales autenticados; `close()` termina el proceso y cierra los servidores creados por el SDK.

## Router `auto` de modelos

`-m auto` (o `modelId: "auto"` en settings) delega la elección de modelo en un router. Requiere la sección `autoRouter`:

```json
{ "autoRouter": { "classifierModel": "barato",
  "candidates": [
    { "modelId": "barato", "description": "ediciones pequeñas", "relativeCost": 1, "supportsImages": false },
    { "modelId": "potente", "description": "refactors y depuración difícil", "relativeCost": 4, "supportsImages": true, "upgradeTo": "potente" } ] } }
```

Para usar Jev como clasificador remoto, sustituye `classifierModel` por `"classifier": { "kind": "jev" }` y define `JEV_API_KEY` o `TYPESAFE_API_KEY` en el entorno.

- **Decisión fija:** se toma en el primer turno y se conserva. Solo cambia por rotación ante error, un turno con imágenes cuyo modelo no las soporta (`vision`) o `UpgradeSessionModel` (`self_upgrade`).
- **Errores:** 429/5xx/inactividad se reintentan `retriesPerModel` veces con espera exponencial y jitter, y luego pasan al siguiente respaldo (`retry_exhausted`); 400/404 rotan al instante (`model_specific`). Longitud de contexto, autenticación y abort se propagan. Un corte tras emitir texto es un error del turno. Agotados todos los modelos, el error no es reintentable.
- **Escalado:** `UpgradeSessionModel` solo existe en sesiones `auto` mientras haya un escalón superior.
- **Subagentes:** cada uno clasifica por su cuenta (`surface: 'subagent'`).
- **Eventos:** `model_routed` (decisión, razón, respaldos, puntuaciones) y `model_transition` (`from`, `to`, `source`); en RPC como `fab_model_routed` y `fab_model_transition`; en `fab chat`, como línea y en el estado (`auto → modelo`). `init` sigue mostrando `auto`.
