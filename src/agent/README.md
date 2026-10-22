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
- La política de red (`--sandbox-network` o comando `/network` en TUI) decide:
  - `deny`: Bloquea permanentemente todo intento de red para el comando.
  - `ask`: Solicita aprobación interactiva al usuario antes del spawn del subproceso.
  - `auto`: Concede acceso a red automáticamente **únicamente bajo autonomía `high`**. En niveles `off`, `low` o `medium`, solicita aprobación interactiva.
- **Alcance de `networkPolicy`:** La política de red aplica específicamente a los comandos ejecutados por `Execute` dentro del sandbox. No rige el transporte HTTP del proveedor del modelo ni los servidores MCP (MCP stdio usa `allowNetwork: true` en su configuración; MCP HTTP utiliza su propio transporte HTTP).

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

- **Estado: IMPLEMENTADO (Archivos):** El comando `/rewind`, `/rewind list` o `/rewind <id>` restaura de manera determinista los archivos alterados o creados por las herramientas `Edit` y `Create`. Utiliza un journal privado ubicado fuera del workspace (`~/.fabrica/prompt-history/`) con registros de intención y verificación de hashes SHA-256 antes y después de cada escritura.
- **Límites conocidos:**
  - **No revierte `Execute`:** La ejecución de comandos shell mediante `Execute` coloca una barrera permanente en el journal que invalida la restauración a checkpoints anteriores al comando.
  - **No revierte la conversación:** No es un rewind de los turnos de diálogo ni de los mensajes enviados al modelo (el comando sin backend `/rewind-conversation` lo advierte explícitamente).

---

## Subagentes y Confinamiento

- **Catálogo de herramientas:** `Read`, `LS`, `Create`, `Edit`, `Glob`, `Grep`, `Execute`, `Script`, `TodoWrite`, `AskUser`, `Skill`, `ToolSearch` y herramientas de subagentes (`src/agent/catalog.ts`).
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
1. **Herramientas de agente:** `loop-cli` (bucle autónomo en turno), `exit-spec-mode` como herramienta invocable por el modelo, `stage_settings_changes`, herramienta `ApplyPatch`, `Execute` desacoplado en background y Script durable con `WaitForScript`.
2. **Crash Recovery de misiones:** Reconciliación automática y journal duradero tras caída intempestiva del proceso del runner.
3. **Protocolos:** Entrada interactiva multiturno mediante `stream-json` y protocolo ACP. El demonio en puerto 37643 y SDKs remotos permanecen fuera de alcance.
4. **MCP:** Autenticación OAuth, transporte SSE de versión previa y actualización de catálogo en caliente.
5. **Aislamiento en plataformas no-Linux:** En macOS no existen namespaces de Linux (`bwrap`); las herramientas operan sin confinamiento de kernel equivalente.

---

## Verificación y Estado de la Suite

Para validar el motor y la consistencia de tipos:

```bash
bun test
bunx tsc --noEmit -p .
```

La suite registra actualmente **252 pruebas unitarias pasando (252 pass, 0 fail)** en **29 archivos de prueba** con **1.481 aserciones** verificadas (`expect()`).
