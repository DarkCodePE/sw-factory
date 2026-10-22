# sw-factory

Fábrica de software local y entorno de ejecución para agentes de código. Convierte señales técnicas (bugs, requerimientos) en cambios implementados en ramas y worktrees Git aislados, con aprobación humana entre etapas. Incluye un agente nativo autónomo (`fab exec`), una interfaz interactiva de terminal (`fab tui`), ejecución confinada en sandbox y control granular de permisos.

```
signal ──triage──▶ change ──▶ [Gate 1: Revisión del change] ──▶ investigation (spec en solo lectura)
                                                                            │
                                [Gate 2: Revisión del spec] ◀───────────────┘
                                       │
                                       ▼
                                implementation ──▶ verificación de commits en fab/<id> ──▶ [Gate 3: fab merge]
```

- **Estado y persistencia:** Base de datos SQLite local (`$FABRICA_HOME/fabrica.db`, por defecto `~/.fabrica/fabrica.db`).
- **Aislamiento por change:** Un `git worktree` dedicado por cada unidad de cambio en la rama `fab/<id>`.
- **Agentes soportados:** Agente autónomo propio `native`; adaptadores externos (`claude`, `codex`, `agy`, `droid`) y adaptador determinista `fake` para suites de prueba (`src/agents.ts:110`).
- **Resiliencia:** Reintentos automáticos configurables (hasta 3 por actividad) y recuperación de actividades huérfanas al reiniciar el servicio.

---

## Instalación y Actualización

### Vía script instalador (recomendado)

El instalador detecta Linux con glibc o macOS (x64 y ARM64), verifica el hash SHA-256 publicado y coloca el binario compilado autónomo en `~/.local/bin/fab`. No requiere Bun, Node ni privilegios de administrador (`sudo`).

Para instalar la versión del canal de prelanzamiento (versiones RC):

```bash
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh |
  sh -s -- --channel prerelease
```

Para la versión estable:

```bash
curl -fsSL https://raw.githubusercontent.com/DarkCodePE/sw-factory/main/scripts/install.sh | sh
```

*(Si el canal estable no cuenta todavía con una versión publicada, el script lo advertirá y permitirá seleccionar el canal prerelease).*

Añade `~/.local/bin` a tu variable de entorno `PATH` si aún no está incluido. En sistemas Windows, se requiere utilizar WSL (Windows Subsystem for Linux); Windows nativo y distribuciones con musl (ej. Alpine) no están soportados actualmente.

### Vía npm

Se distribuye el paquete npm `@okuanb/fab`:

```bash
# Canal de prelanzamiento (RC actual)
npm install -g @okuanb/fab@next

# Canal estable
npm install -g @okuanb/fab@latest
```

### Autoactualización (`fab update`)

El comando `fab update` detecta automáticamente el método de instalación original (script binario en `~/.local/bin` o paquete global de npm) y su canal asociado:

```bash
fab update --check         # Comprueba si existen nuevas versiones sin modificar el sistema
fab update                 # Descarga e instala la última versión de su canal actual
fab update --channel next  # Cambia explícitamente de canal o actualiza a versión fija (--version X.Y.Z)
```

Consulte [docs/install-update.md](docs/install-update.md) para detalles sobre resolución de precedencias, verificación de checksums y reversión de versiones.

---

## Modos de Operación

### 1. Interfaz Interactiva de Terminal (`fab tui`)

Lanza un entorno conversacional directo con el agente para explorar código, ejecutar tareas interactivas, revisar diferencias e inspeccionar sesiones:

```bash
fab tui                    # Inicia en el directorio de trabajo actual
fab tui --cwd /ruta/repo   # Inicia apuntando a un repositorio específico
fab tui mi-workstream      # Abre el panel de control del pipeline de fábrica para un workstream
```

**Características principales de la TUI:**
- **Paleta en vivo:** Escribir `/` despliega un menú interactivo con filtrado en tiempo real de 36 comandos locales y 15 comandos con estado explícito.
- **Navegación y atajos:**
  - `Tab`: Cicla el nivel de esfuerzo de razonamiento del modelo (`low`, `medium`, `high`, `default`).
  - `Shift+Tab`: Alterna entre modo interactivo (`auto`) y modo solo lectura (`spec`). Añade `mission` únicamente si la autonomía es `high`.
  - `Ctrl+N`: Cicla entre los modelos configurados.
  - `Ctrl+L`: Alterna el nivel de autonomía (`off`, `low`, `medium`, `high`).
  - `Ctrl+O`: Alterna la vista detallada de diffs expandidos (hasta 400 líneas).
  - `Ctrl+C`: Cancela la operación en curso, la pregunta activa o el turno del agente.
  - `Ctrl+D` o `/exit`: Cierra la interfaz de terminal.
- **Renderizado e historial:** Markdown en streaming por líneas, resaltado sintáctico de diferencias (`+`/`-`), historial aislado por repositorio en `~/.fabrica/prompt-history/`, y soporte de pegado seguro delimitado por corchetes (bracketed paste).
- **Rewind local:** El comando `/rewind` restaura de forma atómica los archivos modificados o creados por `Edit` y `Create` al estado de un checkpoint previo (no altera el historial de conversación ni revierte comandos arbitrarios ejecutados con `Execute`).

### 2. Agente Autónomo CLI (`fab exec`)

Ejecuta el agente de código sin interfaz gráfica para scripting, integración continua o tareas puntuales:

```bash
# Tarea puntual con autonomía media
fab exec -m qwen3.5-32k:latest --auto medium "Corrige el test fallido en tests/auth.test.ts"

# Tarea desde archivo de prompt con confirmación de estado
fab exec -f prompt.txt --cwd /ruta/repo --auto high --require-status

# Formato JSON-RPC bidireccional sobre stdin/stdout
fab exec --input-format stream-jsonrpc --output-format stream-jsonrpc
```

Consulte [src/agent/README.md](src/agent/README.md) para la tabla exhaustiva de opciones de `fab exec` y la especificación del protocolo JSON-RPC (11 métodos soportados).

### 3. Pipeline de Fábrica Desatendida (`fab ws` / `fab run`)

Para la gestión de flujos de trabajo organizados mediante señales y cambios:

```bash
# 1. Configurar variables de proveedor del modelo
export FABRICA_LLM_BASE_URL=http://127.0.0.1:11434/v1
export FABRICA_LLM_MODEL=qwen3.5-32k:latest

# 2. Registrar el workstream y activarlo
fab ws create mi-app --repo /ruta/al/repo --goal "Estabilizar suite de autenticación"
fab ws state mi-app active

# 3. Ingresar una señal técnica y procesar triage a Change
fab signal add mi-app "Fallo en parseo de token expirado" --body "Retorna 500 en vez de 401"
fab triage --all mi-app

# 4. Gate 1: Revisar y aprobar el Change en el inbox
fab inbox mi-app
fab review <changeId> approve

# 5. Actividad 1: El worker investiga en solo lectura y produce spec.md
fab run mi-app --once

# 6. Gate 2: Revisar y aprobar el plan propuesto (spec)
fab inbox mi-app
fab review <changeId> approve

# 7. Actividad 2: El worker implementa cambios y hace commit en fab/<changeId>
fab run mi-app --once

# 8. Comprobar estado y Gate 3: Fusión explícita a la rama principal
fab status mi-app
fab merge <changeId>
```

---

## Seguridad, Sandbox y Aislamiento

### Sandbox de procesos (`bwrap`)

En entornos Linux, los comandos de herramientas (`Execute`, `Script`) se ejecutan confinados mediante `bubblewrap`:
- **Sistema raíz en solo lectura:** El sistema anfitrión se monta con `--ro-bind / /`.
- **Workdir escribible:** Únicamente el directorio de trabajo del worktree asignado cuenta con permisos de escritura.
- **Espacios de nombres aislados:** Se desasocian namespaces de PID (`--unshare-pid`), IPC (`--unshare-ipc`), UTS (`--unshare-uts`) y red (`--unshare-net`).
- **Entorno saneado:** Se limpia el entorno del proceso padre (`--clearenv`) y se inyectan únicamente variables necesarias.
- **Detección real:** Si el kernel restringe user namespaces no privilegiados (ej. Ubuntu 24.04 con AppArmor restrictivo), el sandbox detecta la falla real mediante probe. En modo `best-effort` advierte la degradación; en modo `required` detiene la ejecución inmediatamente. Consulte [src/sandbox/README.md](src/sandbox/README.md) para detalles de remediación.

### Permisos de red por llamada

Por defecto, la ejecución de comandos en sandbox bloquea todo tráfico de red. La política `--sandbox-network` permite granularidad por invocación para la herramienta `Execute`:
- `deny`: Bloquea permanentemente el acceso a red.
- `ask`: Solicita confirmación explícita del usuario cuando una herramienta requiere red.
- `auto`: Concede red automáticamente únicamente bajo autonomía `high`; en niveles inferiores requiere confirmación humana.
- *Alcance:* Aplica a comandos confinados en sandbox. No rige las llamadas HTTP del proveedor del modelo ni el transporte de servidores MCP.

### Modo YOLO (`--yolo`)

El flag `--yolo` (y el comando informativo `/yolo` en TUI) habilita la ejecución directa sobre el anfitrión y acceso libre a red, omitiendo solicitudes interactivas de aprobación:
- **Ámbito estrictamente efímero:** Aplica únicamente a la invocación actual; **nunca se persiste** en la sesión guardada ni al reanudar mediante `--session-id` o `--fork`.
- **Restricciones preservadas:** El modo de solo lectura (`spec`), el subcomando de consulta lateral `/btw`, y las fases de validación de misiones continúan aplicando sus restricciones de seguridad aunque `--yolo` esté activo. Consulte [docs/design-yolo-mode.md](docs/design-yolo-mode.md).
- **Advertencia de contención:** La separación de validadores en misiones bajo YOLO es lógica en el orquestador; un worker ejecutado en YOLO sobre el shell del host tiene acceso al entorno del sistema anfitrión.

---

## Proveedores y Adaptadores

### Proveedores integrados en el motor nativo
1. **Modelos compatibles con OpenAI:** Endpoints HTTP compatibles con Server-Sent Events (SSE). Configurable vía `--base-url` y `FABRICA_LLM_BASE_URL`.
2. **Suscripción de ChatGPT:** Autenticación automática leyendo la sesión activa existente de Codex sin exponer credenciales en archivos de configuración ni registrarlas en texto plano.
3. **Modelos locales (Ollama):** Probado y validado con `qwen3.5-32k` sobre endpoints locales (`http://127.0.0.1:11434/v1`).

### Adaptadores externos para el pool de fábrica
- `native`: Utiliza el motor de agente interno con catálogo completo de herramientas, subagentes y misiones.
- `claude`: Invoca Claude Code en modo print (`claude -p`).
- `codex`: Invoca Codex CLI utilizando el sandbox seguro de escritura `--sandbox workspace-write` (integrado desde la versión RC.1).
- `agy`: Invoca Antigravity CLI de Google AI en modo headless (`agy -p`).
- `droid`: Invoca una CLI compatible externa en modo print (`droid exec`).
- `fake`: Adaptador determinista en memoria para pruebas de integración sin consumo de API.

---

## Misiones Autónomas (`--mission`)

`fab exec --mission --auto high` activa el motor de misiones jerárquicas:
- Descompone requerimientos en especificaciones de hitos (`features.json`).
- Asigna roles diferenciados de planificación, trabajadores en serie (`--worker-model`) y dos validadores independientes en solo lectura (`--validator-model`).
- **Verificación objetiva obligatoria:** Una misión solo se declara completada si el runner ejecuta con éxito los `verificationCommands` en un sandbox aislado sobre una copia limpia del código y comprueba que ningún `protectedPaths` haya sido modificado.
- Ver detalles y reglas de completitud en [src/agent/README.md#misiones](src/agent/README.md#misiones).

---

## Límites Conocidos

De acuerdo con el análisis de brechas e inspección técnica del sistema a la versión `f023e47` (v0.1.0-rc.9):

1. **Dos modos de verificación, por diseño:** En el flujo de `signal/change` (`src/pool.ts:40-47`) el pool comprueba que la implementación haya dejado commits en `fab/<id>` y la validación recae en los gates humanos. La verificación ejecutada por el runtime (`verificationCommands`, `protectedPaths`) pertenece al modo de misiones de `fab exec --mission`. Quien necesite verificación objetiva formula el encargo como misión.
2. **Catálogo de herramientas pendientes:** No están implementadas herramientas de bucle autónomo en agente (`loop-cli`), salida programática de modo spec desde el modelo (`exit-spec-mode`), preparación de cambios de configuración (`stage_settings_changes`), herramienta de parches directos (ApplyPatch), ejecución de comandos desacoplados en segundo plano (background Execute), ni scripts con espera asíncrona persistente (durable Script / WaitForScript).
3. **Opciones CLI de `fab exec` ausentes:** No se dispone de flags para inyección dinámica de herramientas externas (`--add-tools`), selección de modelo específico para spec (`--spec-model`), ajuste de reasoning por rol específico en misiones (`--worker-reasoning-effort`), creación directa de worktrees en invocaciones aisladas de `exec` (`--worktree`), ni flags CLI para manipulación de sesiones (`--session-title`, `--rm`, `--force`).
4. **Protocolos de comunicación:** La entrada interactiva multiturno mediante `stream-json` y el protocolo ACP no están soportados (la entrada de streaming se realiza vía `stream-jsonrpc`). El soporte como demonio de red y SDKs externos permanece fuera del alcance del diseño.
5. **Persistencia tras fallos del proceso (Crash):** Se cuenta con snapshots y locks atómicos de sesión, pero no existe aún un subsistema de journal con reconciliación automática tras interrupción intempestiva (los bloqueos retenidos requieren verificación manual).
6. **Alcance del rebobinado (`/rewind`):** El mecanismo de rewind en la TUI restaura exclusivamente archivos mutados por `Edit` y `Create`. No revierte modificaciones de comandos arbitrarios ejecutados mediante `Execute` ni altera el historial conversacional.
7. **Protocolo MCP:** Implementa stdio y Streamable HTTP con paginación y cancelación. No soporta autenticación OAuth, transporte SSE de versión previa, recursos MCP declarativos, templates de prompts de servidor ni actualización en caliente de catálogos durante la sesión.
8. **Hooks de proyecto:** Los hooks locales definidos en configuración (`.fab/hooks.json`) no se ejecutan por diseño, al carecer de un marco estricto de atestación y confinamiento seguro de capacidades.
9. **Aislamiento en plataformas no-Linux:** El aislamiento fuerte del sandbox depende de las primitivas de namespaces de Linux (`bubblewrap`). En entornos macOS, los comandos se ejecutan sin confinamiento de namespaces.
10. **Rendimiento de modelos locales:** En inferencia local con hardware GPU se obtienen velocidades de ~70 tokens/s (adecuadas para el timeout de inactividad de 120s); sin embargo, la inferencia sobre CPU (~4.7 tokens/s) provoca el vencimiento recurrente de los límites de espera. Modelos de escala ultraligera (~2.6B parámetros) no son aptos para el bucle multi-turno al fallar sistemáticamente en la planificación de herramientas.

---

## Desarrollo y Verificación

Para ejecutar la suite de pruebas unitarias y verificación de tipos estáticos:

```bash
bun test
bunx tsc --noEmit
```

La suite contiene actualmente **252 pruebas unitarias pasando sin fallos (0 fail)** en **29 archivos de prueba** con 1.481 aserciones (`expect()`).
