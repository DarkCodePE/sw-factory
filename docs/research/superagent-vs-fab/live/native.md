# Backend vivo native — fase 2

Base: `ce84fc4`, rama `feat/live-native`, worktree `/home/orlando/Desktop/factory/sw-factory-live-native`.

## Implementación y decisiones

- `src/live/native.ts:32`: `createNativeBackend({settingsPath?, sessionDir?})` y export `native` implementan el contrato fijo. Un proceso `exec` por llamada; sesión persistente y reanudación exacta por ID. Se reutiliza `runAgent` sin cambios para timeout, abort, captura y onSpawn.
- `src/agent/exec-flags.ts:156`, `src/agent/exec.ts:263`: se expone `--new-session-id`, conectado a `AgentOptions.newSessionId`, que ya existía. El motor toma el lock y guarda con createOnly (`src/agent/engine.ts:103`, `src/agent/session.ts:126`); un ID existente no se sobrescribe. No se admite junto a resume, fork o streaming. Los flags anteriores conservan comportamiento.
- `src/live/native.ts:42`: inspección previa del ID y cwd; ENOENT produce `SessionNotFoundError`, rutas inválidas y sesiones corruptas no crean otra sesión. El motor conserva su lock y la reconciliación al reanudar; el backend no simula la persistencia.
- `src/live/native.ts:13`: tool `report`, validación del esquema fijo y requisito adicional de human_action no vacío para awaiting. Cada report aceptado se copia en orden al resultado del intento; el acuse incluye attemptId. `src/sdk/mcp-server.ts:23` sirve HTTP loopback y bearer aleatorio por turno, traduce entradas inválidas a isError.
- `src/live/native.ts:54`: único MCP `fab_live` (nombre visible `fab_live___report`). Sustituye la lista MCP de settings por el servidor de la fab. `readOnlyTools: [report]` autoriza esta comunicación con el host sin conceder escritura de workspace ni permisos de ejecución. Así funciona con autonomía medium sin aprobación interactiva.
- Settings y prompt se pasan por archivos privados temporales (directorio 0700 y archivos 0600), no por argv; cierre del MCP y borrado en finally. Los ajustes de modelos se conservan; se vuelve a crear URL/token en cada turno.
- `confinable: false`; `confine: true` falla antes de iniciar. El sandbox de herramientas del motor no equivale al confinamiento de todo el proceso. No se activó una nueva modalidad de sandbox.
- `src/sdk/tools.ts:24`: se corrige la validación de propiedades propias del esquema (`Object.hasOwn`), para que constructor y __proto__ no eludan additionalProperties:false. Afecta también al MCP del backend claude: solo rechaza entradas que ya eran inválidas según el esquema.
- No se modificaron contrato, pool, store, runAgent ni backend claude. No hubo commit, push, merge, instalaciones ni subagentes.

## Pruebas y comandos

Los unitarios no llaman modelos ni abren sockets: interceptan Bun.serve y prueban su handler HTTP con Request/Response en memoria. Abort/timeout usan procesos shell reales; colisión de ID usa el CLI real antes de cualquier llamada de proveedor. Se restaura cada spy al terminar.

### Unitarios

`bun test tests/live-native.test.ts`

```text
bun test v1.3.14 (0d9b296a)

tests/live-native.test.ts:
(pass) new/resumed argv, private prompt/settings, authenticated reports and cleanup (no sockets/model) [14.41ms]
(pass) unknown ID, invalid ID, workspace mismatch and unsupported confinement fail before launch [8.35ms]
(pass) report rejects malformed payloads without appending, accepts all contract states in order [0.44ms]
(pass) abort and timeout reuse runAgent process termination and close the MCP server [17.83ms]
(pass) new-session-id rejects resume/fork/stream combinations and invalid IDs [0.28ms]
(pass) exec new-session-id never overwrites an existing session (real CLI, no network/model) [93.88ms]
(skip) live: ChatGPT subscription remembers ÁMBAR-7 across two processes

 6 pass
 1 skip
 0 fail
 60 expect() calls
Ran 7 tests across 1 file. [171.00ms]
```

### Tipos

`bun run typecheck`, exit 0 (repetido tras el cambio final de SDK).

```text
$ tsc --noEmit -p .
```

### Live: suscripción ChatGPT

Primer intento con `gpt-5.1-codex-mini`: rechazado por el proveedor (HTTP 400, model_not_found, no soportado con esta cuenta). Se leyó el catálogo local de modelos, sin imprimir credenciales, y se cambió el default a `gpt-6-luna`, la opción económica disponible indicada por el entorno. No se midió precio ni se usó una API de pago; el proveedor es `src/agent/chatgpt.ts` con el login Codex existente. `FAB_LIVE_MODEL` permite seleccionar otro modelo en una cuenta diferente.

`FAB_LIVE_TEST=1 bun test tests/live-native.test.ts`

Salida del intento exitoso (antes de añadir el test offline de colisión):

```text
bun test v1.3.14 (0d9b296a)

tests/live-native.test.ts:
(pass) new/resumed argv, private prompt/settings, authenticated reports and cleanup (no sockets/model) [15.52ms]
(pass) unknown ID, invalid ID, workspace mismatch and unsupported confinement fail before launch [10.53ms]
(pass) report rejects malformed payloads without appending, accepts all contract states in order [0.30ms]
(pass) abort and timeout reuse runAgent process termination and close the MCP server [16.54ms]
(pass) new-session-id rejects resume/fork/stream combinations and invalid IDs [0.23ms]
LIVE first {"ok":true,"output":"La llamada a `fab_live___report` se realizó con `state: awaiting` y solicitó un color en `human_action` y `summary`. No hay una tarea de código especificada en el workspace.","exitCode":0,"durationMs":21253,"status":{"kind":"missing","reason":"report has no STATUS line"},"stdout":"{\"ok\":true,\"executionPolicy\":{\"permissionMode\":\"standard\",\"effectiveAutonomy\":\"medium\",\"execution\":\"sandbox\",\"network\":\"per-call\"},\"sessionId\":\"6fd2a9f9-550d-4f94-b15c-f581befaaaa9\",\"text\":\"La llamada a `fab_live___report` se realizó con `state: awaiting` y solicitó un color en `human_action` y `summary`. No hay una tarea de código especificada en el workspace.\",\"turns\":7,\"toolCalls\":5,\"durationMs\":21188,\"usage\":{\"inputTokens\":13586,\"outputTokens\":547}}\n","stderr":"","sessionId":"6fd2a9f9-550d-4f94-b15c-f581befaaaa9","attemptId":"attempt-1","reports":[{"state":"awaiting","summary":"Se requiere una indicación antes de continuar.","human_action":"Indica un color."}]}
LIVE second {"ok":true,"output":"La palabra clave era **ÁMBAR-7**.","exitCode":0,"durationMs":3914,"status":{"kind":"missing","reason":"report has no STATUS line"},"stdout":"{\"ok\":true,\"executionPolicy\":{\"permissionMode\":\"standard\",\"effectiveAutonomy\":\"medium\",\"execution\":\"sandbox\",\"network\":\"per-call\"},\"sessionId\":\"6fd2a9f9-550d-4f94-b15c-f581befaaaa9\",\"text\":\"La palabra clave era **ÁMBAR-7**.\",\"turns\":2,\"toolCalls\":1,\"durationMs\":3862,\"usage\":{\"inputTokens\":6380,\"outputTokens\":45}}\n","stderr":"","sessionId":"6fd2a9f9-550d-4f94-b15c-f581befaaaa9","attemptId":"attempt-2","reports":[{"state":"done","summary":"ÁMBAR-7"}]}
(pass) live: ChatGPT subscription remembers ÁMBAR-7 across two processes [25173.96ms]

 6 pass
 0 fail
 61 expect() calls
Ran 6 tests across 1 file. [25.25s]
```

### Suite completa

Base, lanzada antes de editar código: `bun test tests > /tmp/fab-native-baseline.log 2>&1`, exit 0. Extracto final:

```text

 1061 pass
 0 fail
 6636 expect() calls
Ran 1061 tests across 101 files. [291.86s]
```

Primera corrida con cambios: `bun test tests > /tmp/fab-native-suite.log 2>&1`, exit 1. Se inició antes de la corrección de SDK y, mientras estaba activa, se añadieron casos que rechazan propiedades heredadas. El módulo SDK ya estaba cargado; ese proceso usó el validador anterior con el test nuevo. Extracto:

```text
1 tests failed:
(fail) report rejects malformed payloads without appending, accepts all contract states in order [0.31ms]

 1066 pass
 1 skip
 1 fail
 6692 expect() calls
Ran 1068 tests across 102 files. [288.72s]
```

Se repite la suite completa con los archivos finales, sin editar código durante la ejecución:

`bun test tests > /tmp/fab-native-suite-final.log 2>&1`, exit 0. Extracto final:

```text

 1067 pass
 1 skip
 0 fail
 6696 expect() calls
Ran 1068 tests across 102 files. [313.47s]
```

Resultado: los 1061 tests de base más seis unitarios nuevos pasan; el único skip es el live opt-in, probado por separado. No hay fallos previos ni regresiones observadas en la corrida final.

### Regresión SDK tras la corrección del validador

`bun test tests/sdk.test.ts`, exit 0:

```text
bun test v1.3.14 (0d9b296a)

tests/sdk.test.ts:
(pass) SDK MCP requires bearer token, validates input, and maps handler exceptions to isError [5.86ms]
(pass) SDK session calls an in-process MCP tool through fab exec and resumes with a newly supplied server [395.14ms]
(pass) SDK close cancels an active tool and shuts down its child and loopback server across three sessions [649.35ms]
(pass) SDK MCP tool call times out after 60 seconds [60002.44ms]

 4 pass
 0 fail
 15 expect() calls
Ran 4 tests across 1 file. [61.07s]
```

`git diff --check`, exit 0, sin salida.


## Límites y omisiones

- No se promete confinamiento native; no se probó un binario compilado ni otro proveedor live. La prueba live usó procesos desde fuente y gpt-6-luna.
- `report` registra datos; no mata al proceso dentro de la llamada MCP. El modelo termina su turno después del acuse, permitiendo persistir el resultado de la herramienta. Si no termina, aplican timeout/abort de runAgent. No hay steer ni proceso retenido entre llamadas.
- El contrato conserva `AgentRun.status` (done/blocked/missing), que no representa awaiting. Se mantiene el parseo heredado de STATUS y la señal viva autoritativa para esta espiga es `reports`; no se inventa un estado nuevo. La prueba live devuelve status missing y reports válidos.
- Los reports no son una cola durable: viven en el resultado del intento; integrar con efectos/store queda fuera de esta fase. Un ID reservado puede devolverse tras abortar antes de que el hijo llegue a persistirlo; intentar reanudarlo entonces falla explícitamente.
- Coste/uso normalizado sigue ausente, como en el adaptador native existente; stdout conserva los tokens que informa el motor, sin inventar coste cero.
- El grafo MCP disponible correspondía al repo principal y devolvió coverage_unavailable/generation desconocida. Se usó como orientación (Verify), con lectura directa de los tramos materiales de este worktree mediante sed y consultas graft ask/skeleton/callers. No se afirma completitud del índice.

<!-- FIN -->
