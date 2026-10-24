# Registro de Cambios (`CHANGELOG.md`)

Historial detallado de versiones de `sw-factory` desde la etiqueta base `c3eff63` hasta la versión actual (v0.1.0-rc.10).

---

## [v0.1.0-rc.10] — 2026-10-24

### Novedades
- **Router `auto` de modelos:** `-m auto` (o `modelId: "auto"`) elige modelo por sesión entre los candidatos de `autoRouter` en settings, según la puntuación de un clasificador; la decisión queda fija y solo cambia por rotación ante error (429/5xx tras `retriesPerModel` intentos, 400/404 al instante), imágenes con un modelo sin visión o la tool `UpgradeSessionModel`. Un corte tras emitir texto es error del turno, sin reintento ni rotación. Los subagentes clasifican por su cuenta. Eventos `model_routed` y `model_transition` en `stream-json`, notificaciones RPC `fab_model_routed`/`fab_model_transition` y línea en `fab chat` (`src/agent/providers/auto.ts`).
- **Aliases y routing de modelos:** `modelAliases` (cadenas sin ciclos, máx. 8 saltos) en `-m`, flags de rol y `/model`; `modelRouting` con cadena `fallback` ante `rate_limit`, `server_error`, `timeout` o `context_length`, sin cambiar de modelo si ya se entregó texto del stream; evento `model_fallback` (`src/agent/providers/router.ts`).
- **Estado MCP visible:** `fab exec --list-tools --with-mcp-status` devuelve `{ tools, mcpServers }` con `connected | connecting | needs authentication | failed` y `authorizeUrl`; cada servidor se carga por separado para que uno que falla no oculte a los demás. `/mcp` en `fab chat`.
- **Hooks en `fab chat` y RPC:** `--hooks` o `hooks.enabled` activan los mismos hooks que exec; `/hooks` lista los cargados. En `stream-jsonrpc`, `initialize_session.hooks` o el valor por defecto de la invocación.
- **RPC MCP:** `droid.list_mcp_servers`, `droid.list_mcp_tools`, `droid.authenticate_mcp_server` y `mcpServers` por sesión.
- **SDK de fab (`fabrica/sdk`):** `tool()`, `createSdkMcpServer()` (servidor MCP loopback con bearer aleatorio, validación JSON Schema, 60 s por llamada), `createSession()`/`resumeSession()` sobre `fab exec` RPC con `send`, `stream`, estado y autenticación MCP (`src/sdk/`).
- **`--input-format stream-json`:** modo multi-turno por stdin (líneas `user`, `interrupt`, `end`), misma sesión persistida entre turnos y evento `turn_end`; exige `-o stream-json`, avisa de deprecación y rechaza prompt, `-f` y `--mission` (`src/agent/stream-input.ts`).
- **Journal y reconciliación tras caída:** registro JSONL con fsync por herramienta y turno; el lock guarda `{pid, startedAt}` y solo se reclama cuando el pid ya no existe; las escrituras y ejecuciones interrumpidas reciben un resultado sintético de efecto incierto y se emite `reconciled`. Una misión con worker caído queda `paused` con `Interrupted by crash` y se reanuda con `resumeWorkerSessionId` (`src/agent/journal.ts`, `session.ts`, `mission.ts`).
- **Hooks opt-in:** `fab exec --hooks` o `hooks.enabled` en settings leen `$FABRICA_HOME/hooks.json` y `.fab/hooks.json`; eventos SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd; `allow|deny|ask`, `updatedInput`, contexto adicional. Los hooks corren con la misma política de ejecución (sandbox, sin red), timeout ≤ 60 s, 8 por evento, y `allow` nunca anula red, spec, rutas protegidas ni techos de settings (`src/agent/hooks.ts`).
- **Proveedores `anthropic` y `openai`:** Messages API en streaming con `x-api-key` o `authMode: bearer`, mapeo de tools y `thinking` por esfuerzo; Responses API con el codec compartido de ChatGPT; `apiKeyHelper`, `extraArgs`, `extraHeaders`. Gemini se configura con `generic-chat-completion-api` y su endpoint OpenAI-compatible (`src/agent/providers/`).
- **MCP completo:** transporte `sse` legado, OAuth con descubrimiento RFC 9728/8414, DCR, PKCE y callback local, tokens en `$FABRICA_HOME/mcp-auth.json` (0600), estado por servidor y `authenticateMcpServer`; recursos y prompts como tools `ListMcpResources`, `ReadMcpResource`, `ListMcpPrompts`, `GetMcpPrompt` cuando el servidor declara la capacidad (`src/agent/mcp-oauth.ts`, `mcp-sse.ts`, `mcp-tools.ts`).
- **Script durable y `WaitForScript`:** un Script que supera 30 s devuelve `running` con su `toolCallId` y sigue ejecutándose en segundo plano (`await: true` observa hasta 10 min); `WaitForScript { toolCallId, timeoutMs?, kill? }` lee la salida acumulada, espera o mata el run y drena sus llamadas anidadas antes de responder. Hasta 4 runs vivos, búfer de 5 MiB por run, 20 notificaciones; los runs terminados y los `notify()` sin espera llegan al modelo en el siguiente límite de turno; al cerrar o abortar se cancelan y drenan; `backgroundScripts` persiste la salida en la sesión. Eventos `script_started`, `script_notified`, `script_completed` (`src/agent/script-runs.ts`, `src/script-runtime/run.ts`).
- **Flags de `fab exec`:** `--add-tools` (ids y selectores `MCP:<servidor>[/<tool>]`, orden only → add → remove), `--spec-model` y `--spec-reasoning-effort` (proveedor propio mientras dura el modo spec), `--worker-reasoning-effort` y `--validator-reasoning-effort`, `-w/--worktree [nombre]` con raíz `worktreeDirectory` (worktree bajo `<raíz>/<8 hex>/<repo>/`, rama `<actual>-wt` por defecto, nunca borra worktrees ajenos), `--worktree-dir` (deprecado, con aviso), `--session-title`, `--disable-builtin-skills` (sin efecto: fab no trae skills integradas). `fab chat` acepta `--worktree` y `--add-tools` (`src/agent/exec-flags.ts`, `src/agent/exec-worktree.ts`).
- **Mission Control:** el motor de misiones emite `mission_feature_updated`, `mission_milestone_validated`, `mission_paused` y `mission_progress` con un `MissionProgressSnapshot` (features por milestone, validadores, workers con tokens y duración); el host puede pausar un run con `mission.pauseSignal` sin abortar el turno del orquestador (`src/agent/mission.ts`, `src/agent/mission-pause.ts`, `src/agent/mission-progress.ts`).
- **TUI `/mission`:** panel de orquestación (`status`), `pause [mensaje]` a mitad de run desde la terminal, `resume [mensaje]`, `workers [id]`, `log [n]`, `list` para reanudar misiones pasadas; Ctrl+T alterna el panel y la barra de estado muestra `misión: <estado> <hechas>/<total>` (`src/chat/mission-view.ts`, `src/chat/mission-commands.ts`).
- Catálogo de herramientas completado tras la captura REA con login (30 ids): ExitSpecMode, StageSettingsChanges, ApplyPatch, Execute en segundo plano, Loop, FetchUrl, WebSearch.
- **Clasificador Jev para el router `auto`:** `autoRouter.classifier: { kind: "jev" }` puntúa cada candidato con una pregunta sí/no al servicio remoto de TypeSafe (clave en `JEV_API_KEY` o `TYPESAFE_API_KEY`); sin clave o ante error el router usa el primer candidato y avisa una vez. Opcional: el clasificador local sigue siendo el predeterminado (`src/agent/router/jev.ts`).
- **`retry-after`:** los proveedores `openai`, `anthropic` y compatibles exponen la cabecera en el error, y el router `auto` espera al menos ese tiempo antes de reintentar.

### Correcciones
- `UpgradeSessionModel` se ofrece antes de la primera decisión del router y desaparece cuando el modelo elegido ya no tiene escalón superior.
- El clasificador recibe el número de turno de usuario correcto (antes contaba mensajes).
- Los subagentes copian archivos del workspace de hasta 16 MiB (antes 1 MiB, lo que hacía fallar `Task` en repos con archivos grandes); solo sus eventos de enrutado llegan al padre, marcados con `agentId`, y en `fab chat` se muestran como `↳ subagente: …`.
- El clasificador Jev ya no deja listeners de cancelación ni rechazos no manejados al abortar la sesión.


---

## [v0.1.0-rc.9] — 2026-10-21 (`f023e47`)

### Novedades
- **Modo YOLO por invocación (`--yolo`, `/yolo`):**
  - Implementación del flag `--yolo` en `fab exec` y comando informativo `/yolo` en la TUI (`src/agent/execution-policy.ts:1-28`, `src/agent/exec.ts:58-62`).
  - Permite la ejecución de herramientas directamente en el anfitrión y acceso libre a red sin restricciones de sandbox (`bubblewrap`) ni solicitudes interactivas de confirmación.
  - **Alcance estrictamente efímero:** Aplica exclusivamente a la invocación actual; nunca se almacena en el estado persistente de la sesión ni se propaga al reanudar (`--session-id`) o bifurcar (`--fork`).
  - **Invariantes preservados:** El modo de solo lectura (`spec`), el subcomando de consulta lateral `/btw` y la fase de validación de misiones (`--mission`) mantienen intactas sus restricciones de seguridad aunque `--yolo` esté activo (`src/agent/execution-policy.ts:25-34`).
  - Manejo en RPC: Se emite advertencia de YOLO únicamente por `stderr` manteniendo `stdout` en formato NDJSON estricto (`tests/yolo-cli.test.ts`).

---

## [v0.1.0-rc.8] — 2026-10-21 (`fc6fc84`)

### Novedades
- **Aprobaciones de red por llamada para `Execute`:**
  - Introducción del flag `--sandbox-network <auto|ask|deny>` en `fab exec` y comando `/network` en la TUI (`src/agent/network-policy.ts:1-32`).
  - Control granular de red por invocación de herramienta (`network: true`):
    - `deny`: Bloqueo permanente de tráfico de red en sandbox.
    - `ask`: Solicita confirmación interactiva en terminal cuando un comando requiere red.
    - `auto`: Concede red automáticamente únicamente bajo autonomía `high`; en niveles inferiores solicita confirmación.
  - Protocolo RPC: La solicitud de confirmación de red se transmite al cliente RPC respetando rechazos sin alterar la política del anfitrión (`tests/agent-rpc.test.ts:38-42`).

---

## [v0.1.0-rc.7] — 2026-10-21 (`b9e6a10`)

### Novedades
- **Instaladores por canales y autoactualización (`fab update`):**
  - Scripts de distribución: `scripts/install.sh` (instalador anclado a la versión), `scripts/latest.sh` (última versión estable) y `scripts/prerelease.sh` (última versión prerelease/RC).
  - Comando `fab update` con detección automática del método y prefijo de instalación:
    - Actualización de binario autónomo en `~/.local/bin/fab`.
    - Actualización de paquete global npm `@okuanb/fab`.
    - Flags soportados: `--check` (consulta de versiones sin modificar el sistema), `--channel <prerelease|latest>` y `--version <X.Y.Z>`.

---

## [v0.1.0-rc.6] — 2026-10-21 (`6539564`)

### Correcciones y Mejoras
- **Soporte de enlaces a catálogos internos de proyecto:**
  - Soporte de alias y enlaces simbólicos internos en `.agents/skills` y `.agents/commands` dentro de los límites del repositorio (`src/chat/project.ts:23-45`).
  - Validación de contención de rutas para rechazar symlinks que apunten fuera de la raíz del proyecto, evitando fugas de contexto o inclusión de archivos no autorizados (`tests/chat-parity-2.test.ts:15-28`).
- **Integración y contratos documentales:**
  - Incorporación de documentación técnica y contratos de integración para Startería Lab (`docs/starteria-lab/`).

---

## [v0.1.0-rc.5] — 2026-10-21 (`4f6ce6f`, `b31780e`)

### Correcciones
- **Robustecimiento de publicación CI/CD:**
  - Saneamiento y normalización de tokens npm pegados con saltos de línea (`\r\n`) antes de construir cabeceras HTTP de autorización (`packaging/npm/publish.js`).
  - Rechazo de caracteres de control internos sin registrar credenciales en logs de CI (`tests/release-distribution.test.js:3-12`).
  - Preservación del mecanismo de autenticación OIDC cuando el token está vacío.

---

## [v0.1.0-rc.4] — 2026-10-20 (`1b263c6`, `f8b26fa`)

### Novedades
- **Publicación npm bajo scope verificado `@okuanb`:**
  - Publicación del paquete npm bajo el scope `@okuanb/fab`.
  - Configuración de empaquetado para distribución en tags `next` (canales de prelanzamiento) y `latest` (canales estables).

---

## [v0.1.0-rc.3] — 2026-10-20 (`39774c5`)

### Correcciones
- **Aislamiento en `/tmp` privado para runtime de `Script`:**
  - Corrección de visibilidad del binario ejecutable compilado al lanzar el proceso worker de `Script` y agentes nativos dentro de sandboxes con `/tmp` montado en un `tmpfs` privado e independiente.

---

## [v0.1.0-rc.2] — 2026-10-20 (`fb8a146`)

### Correcciones
- **Recolección de artefactos nativos sellados sin colisión:**
  - Resolución de colisiones de metadatos al consolidar binarios multiplataforma sellados (Linux x64, Linux ARM64, macOS x64, macOS ARM64) en el flujo de publicación de releases en GitHub Actions.

---

## [v0.1.0-rc.1] — 2026-10-20 (`17bd944`, commits `d06f108`..`17bd944`)

### Novedades y Características Principales
- **Proveedor de suscripción ChatGPT:**
  - Conector `src/agent/chatgpt.ts` que permite utilizar suscripciones activas de OpenAI reutilizando la autenticación existente de Codex CLI sin filtrar credenciales en disco.
- **Adaptadores de agentes externos actualizados:**
  - Adaptador para Antigravity CLI de Google AI (`agy`).
  - Actualización del adaptador Codex CLI a `--sandbox workspace-write` y gestión de commits en la fábrica (`factoryCommits: true`).
- **Interfaz Interactiva de Terminal (`fab tui`):**
  - Implementación completa del panel conversacional en `src/chat/`:
    - Paleta en vivo de comandos activada por `/` con filtrado en tiempo real.
    - Soporte de sesiones locales: `/sessions`, `/search`, `/fork`, `/tree`, `/rename`, `/favorite`, `/archive`.
    - Compresión y bifurcación contextual: `/compress`, `/handoff`, consulta lateral `/btw`.
    - Rebobinado local de archivos: `/rewind` basado en checkpoints exclusivos para herramientas `Create` y `Edit`.
    - Renderizado incremental de Markdown y visualización comparativa de diffs con expansión (`Ctrl+O`).
- **Resiliencia ante streams detenidos (Watchdog de inactividad):**
  - Introducción del temporizador `FABRICA_STREAM_IDLE_MS` (120 s por defecto) en `src/agent/provider.ts` y `src/agent/chatgpt.ts`.
  - Aborta peticiones HTTP/SSE inactivas sin bloquear turnos del agente y reintenta limpiamente sin despachar herramientas parciales.
- **Binario autónomo y distribución:**
  - Compilación de binarios independientes sin dependencias con `bun build --compile` (`scripts/build.sh`).
  - Script instalador por curl con verificación criptográfica SHA-256 (`scripts/install.sh`).
  - Sellado de artefactos nativos y manifiestos de release (`docs/release.md`).
- **Soporte de compilación en macOS:**
  - Soporte para operaciones de archivos ancladas por descriptor en macOS mediante módulo nativo C y N-API (`include/node/node_api.h`).
