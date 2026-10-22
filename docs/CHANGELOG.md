# Registro de Cambios (`CHANGELOG.md`)

Historial detallado de versiones de `sw-factory` desde la etiqueta base `c3eff63` hasta la versión actual `main` `f023e47` (v0.1.0-rc.9).

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
