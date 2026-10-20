# Red de Execute: configuración y aprobación por llamada

Fecha: 2026-10-19. Base: RC.7, commit `b9e6a10c539a089b51528282a2004cf03e6dd01c`.
Rama de trabajo: `feat/execute-network-permissions`. Cambio local, sin publicación.

## Problema observado

La sonda de Jira se ejecutaba después de responder «sí», pero fallaba con
`fetch failed`. En RC.7, `executeOne` fijaba `allowNetwork: false`; la aprobación
de `ToolRuntime` solo habilitaba ejecutar el comando. `fab doctor` confirmaba que
bubblewrap funcionaba. Una sonda HTTP local funcionó en el host y falló dentro de
Execute. El problema era la política del runtime, no instalar bubblewrap.

## Decisión aceptada por el usuario

Con la política predeterminada `auto`, conceder red automáticamente **solo** en
autonomía `high`. En `off`, `low` y `medium`, pedir confirmación antes de iniciar
el proceso. El indicador `auto/off` de la TUI significa modo auto y autonomía off;
no concede red automática.

La petición del modelo y la concesión del runtime son datos diferentes:

```ts
// Input de Execute: petición, nunca autoridad.
{ command: "node .claude/skills/jira-hu/tools/jira-hu.mjs --sonda", network: true }

// Configuración del host.
type NetworkPolicy = 'auto' | 'ask' | 'deny';

// Contexto interno de una llamada autorizada, no aceptado del modelo.
{ networkAccess: true }
```

Sin `network: true`, el comando sigue aislado de la red, incluso en high. El schema
explica al modelo que debe solicitarla para Jira, curl y descargas. No se deducen
permisos de `riskLevel`, de URLs en un prompt ni del texto `fetch failed`.

## Tabla de decisión

Aplicable a Execute con `network: true`, en modo auto o mission:

| Política | off | low | medium | high |
| --- | --- | --- | --- | --- |
| auto (predeterminada) | Preguntar | Preguntar | Preguntar | Conceder por llamada |
| ask | Preguntar | Preguntar | Preguntar | Preguntar |
| deny | Denegar | Denegar | Denegar | Denegar |

En spec y `/btw`, denegar solicitudes de red: el runtime no puede certificar que
una conexión externa sea de solo lectura. Una denegación de política prevalece
sobre el callback de aprobación. Sin interfaz de permisos (exec batch), una
solicitud que requiere confirmación produce un error de herramienta y no espera
ni se ejecuta. Para intervención humana se utiliza la TUI o un cliente RPC;
high+auto permite la ejecución no interactiva.

## Configuración

```sh
fab tui --sandbox-network auto
fab tui --auto high --sandbox-network auto
fab exec --auto high --sandbox-network auto "Ejecuta la sonda de Jira"
fab exec --auto high --sandbox-network deny "Revisa el repositorio sin red"
```

En un archivo de settings explícito:

```json
{ "sandboxNetwork": "auto" }
```

En TUI: `/network auto`, `/network ask`, `/network deny`, o `/settings network ask`.
`/network` ofrece selección; `/status`, `/settings` y `/diagnostics` muestran la
política. El archivo de preferencias conserva la política, nunca una concesión
por llamada. Una preferencia de red con valor desconocido se interpreta como
deny; settings o flags inválidos se rechazan.

Precedencia de arranque: flag CLI → settings explícitos → preferencia TUI → auto.
Los comandos de configuración de la TUI pueden cambiar la política para los
turnos siguientes. Una operación activa conserva el valor con el que empezó.
La API TypeScript usa `AgentOptions.networkPolicy`; no obtiene permisos de
archivos AGENTS.md o skills. La política se valida en `runCodingAgent`.

## Flujo de aprobación

```text
Modelo pide Execute(command, network?)
  → validar y congelar copia del input
  → aplicar filtros de herramientas, spec y beforeTool
  → resolver política con la autonomía original
  → deny: devolver error sin lanzar proceso
  → ask: una confirmación conjunta de comando y red
  → comprobar cancelación
  → emitir decisión observable
  → emitir capacidad solo al contexto de esta llamada
  → ejecutar dentro de bubblewrap
  → devolver exitCode, sandbox y estado de red
```

La confirmación conserva el mecanismo de respuesta fresca de la TUI:

```text
Permiso para esta llamada (sin autorización permanente):
Execute
{ "command": "node ... --sonda", "network": true }
Acceso de red del equipo para este comando y sus descendientes,
solo durante esta llamada.
Carpeta: /ruta/al/proyecto
El aislamiento de archivos se conserva.
No se limita la conexión a un dominio concreto.
¿Permitir una vez? [s/N]
```

El grant cubre la llamada y sus descendientes mientras se ejecutan, también una
secuencia completa `&&`. No concede permiso a otra llamada, a toda la sesión,
a un fork ni a un hijo. Se combinan los permisos existentes de ejecución y la
petición de red para evitar preguntar dos veces por el mismo comando.

En high+auto, la TUI informa «Red autorizada automáticamente para esta llamada».
Rechazo, respuesta ausente, Ctrl+C y timeout impiden iniciar el proceso pendiente.
Después de un error offline no hay relanzamiento automático: el modelo puede
emitir una nueva llamada que solicite red; debe considerar posibles efectos de
la primera ejecución. Las aprobaciones no autorizan replay de sesiones pendientes.

## Aislamiento y alcance real

El único cambio del wrapper al conceder red es omitir `--unshare-net`. Se
mantienen los montajes, el directorio de trabajo, los namespaces de procesos,
la limpieza de descendientes y el entorno explícito existente. No se heredan
tokens o variables del host por conceder red. Las credenciales que una skill
cargue por su propio contrato se revisan por separado.

Esto concede **la red del host**, no una allowlist de Jira. No se presenta un
hostname extraído del texto como restricción de dominio. Restringir hosts y
redirecciones de procesos arbitrarios requeriría un proxy o control de egress
adicional; queda fuera de esta corrección. La red autorizada tampoco garantiza
credenciales válidas ni permisos para modificar tickets.

Execute exige un sandbox funcional también si se solicitó best-effort: un
fallback sin wrapper no puede garantizar ni bloqueo de red ni conservación del
aislamiento. Se falla antes de iniciar el comando. En macOS, esta implementación
no añade un backend equivalente a bubblewrap; no se afirma soporte de Execute
aislado allí. No se modifica AppArmor ni la configuración global del equipo.

## Script, subagentes, misiones y RPC

Script continúa sin red directa. `tools.Execute` pasa por el mismo dispatcher y
las mismas confirmaciones. No obtiene autoridad del contexto de la VM.

TaskManager hereda la política del host y la autonomía base del padre, no la
autonomía elevada temporalmente por una aprobación. El hijo crea su runtime y
sus grants por llamada; explore/spec rechaza red. Las llamadas internas de Git
para preparar/recoger snapshots siguen sin red. Los workers de misión conservan
la política del caller; se respeta deny aunque la misión necesite high.

RPC mantiene `droid.request_permission` y `proceed_once`/`cancel`. Añade a
`details` el cwd y `network: { requested, access:'host', scope:'this_call', policy }`.
El cliente debe mostrar esos detalles antes de aprobar. La política viene del
host (`RpcOptions.agent.networkPolicy`), no de `update_session_settings`.
Settings la exponen; la notificación propia `fab_network_permission` identifica
la decisión. No se anuncia esta extensión como un contrato observado de Droid.

Las decisiones (`allowed_once`, `allowed_automatically`, `denied`) también son
eventos locales `network_permission` con sessionId/toolUseId y scope. No incluyen
tokens ni el comando completo. El resultado Execute expone `network.requested`
y `network.enabled`. El permiso no prueba éxito HTTP: manda el exitCode real.
No cambia la política independiente de proveedores LLM ni de MCP HTTP/stdio.

## Cambios de código

| Área | Responsabilidad |
| --- | --- |
| agent/network-policy.ts, types.ts | Tipos, validación y matriz de decisión |
| agent/engine.ts, registry.ts | Política de host y autorización por llamada |
| agent/tools.ts | Schema, aplicación del grant, secuencias y resultado |
| agent/interaction.ts, rpc.ts | Detalles de aprobación y transporte |
| agent/settings.ts, exec.ts | Configuración y CLI batch/RPC |
| chat.ts, chat/config.ts | Precedencia y preferencias |
| chat/commands.ts, controller.ts | /network, confirmación y observabilidad |

No se cambia la semántica de autorización de Edit/Create ni se concede red a
herramientas ajenas a Execute por este ajuste.

## Rúbrica de pruebas y aceptación

| Escenario | Cómo probar | Resultado requerido |
| --- | --- | --- |
| Matriz de políticas | Las 4 autonomías × auto/ask/deny y spec | Solo high+auto concede automáticamente |
| Sin petición | Servidor HTTP local; Execute sin network, high | Cero peticiones, proceso offline |
| Aprobación interactiva | Contar peticiones antes de responder en off/low/medium | Cero efectos antes de permitir; una pregunta |
| High auto | Misma sonda con network:true y sin handler | HTTP correcto, sandboxed=true, evento automático |
| Ask en high | Handler permite una vez y rechaza la siguiente | La segunda no conecta; no hay grant persistente |
| Deny y datos falsificados | Input incluye networkPolicy/networkAccess falsos | Prevalece política del host; no se ejecuta |
| Cancelación | Abort mientras se responde a la pregunta | No empieza el comando |
| Snapshot de input | Intentar mutar el input mostrado | Input congelado; se ejecuta el comando aprobado |
| Archivos y entorno | Comando online intenta escribir fuera y leer env sintética | Archivo intacto; variable no heredada |
| Sin backend | Simular bwrap ausente, best-effort, network true/false | No fallback sin aislamiento ni archivo creado |
| Descendientes | Ejecutar/abortar un proceso que lanza un hijo con conexión diferida | No aparecen conexiones después de terminar la llamada |
| Script y secuencias | tools.Execute con dos curl en && | Una aprobación, dos peticiones, mismo scope |
| TUI | /network, /settings y modelo sintético | Persistencia solo de política; texto de alcance y high automático |
| RPC | Permitir/rechazar requests correlacionadas | Detalles completos; rechazo efectivo; settings no elevan host |
| CLI batch | Proveedor local y auto/ask/deny/inválido | Flag aplicado; ask falla sin esperar; error de schema explícito |
| Sesión/subagente | Delegar desde high+deny y desde off con permiso solo para Task | Hijo conserva deny o pregunta; aprobar Task no lo vuelve high |

Comandos de verificación:

```sh
bun test tests/execute-network.test.ts tests/execute-network-cli.test.ts tests/chat.test.ts tests/agent-rpc.test.ts
bun test
bunx --no-install tsc --noEmit -p .
sh scripts/build.sh
bun scripts/probe-execute-network.ts dist/fab-linux-x64 dist/network-permissions-compiled.json
```

## Resultados locales y revisión independiente

- Suite final: **238 pruebas, 0 fallos**, en 26 archivos; 1287 aserciones.
- `bunx --no-install tsc --noEmit -p .`: código de salida 0.
- Build Linux x64: correcto. Smoke existente Read/Edit/TUI/rewind/Script/MCP: correcto.
- TUI compilada con PTY real: pasan low-approve, medium-reject, high-automatic,
  high-policy-deny y high-no-request; coincidencia de prompts y peticiones HTTP.
- SHA-256 del binario local: `c6fbb8ea2a7f5c2f58700f24de10f2a845790b8648e1a68a173789042290e48a`.
- Antigravity (`agy-ollama`) revisó el diff, la propagación de capacidades y los
  recibos; ejecutó de forma independiente la suite completa (238 pass, 0 fail) y
  TypeScript. Confirmó también el último delta de validación previa del comando.
  No señaló bloqueos; mantuvo la distinción entre red del host y allowlist.

Evidencia local bajo `dist/`: `network-permissions-qa.xml`,
`network-permissions-tests.log`, `network-permissions-compiled.json`,
`network-permissions-native-smoke.json`, `network-permissions-source.json` y
`network-permissions-antigravity.txt`. El recibo de origen incluye hashes del
working tree: HEAD por sí solo no identifica este cambio todavía sin commit.

Las pruebas con servidor/proveedor local no equivalen a autenticar una cuenta
Jira real ni a validar llamadas que modifiquen tickets. La revisión independiente
no equivale a cualificación de una release en las cuatro plataformas. El cambio
sigue local y no está instalado globalmente ni publicado.
