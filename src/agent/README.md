# Motor propio de `fab exec`

Agente de código propio, escrito con Bun. El adaptador `native` es el predeterminado
para workstreams nuevos y conserva los gates de la fábrica. El alcance todavía es
**parcial**; ver la sección final.

```bash
bun src/cli.ts exec --cwd /ruta/proyecto --auto medium \
  -m qwen3.5-32k:latest --base-url http://127.0.0.1:11434/v1 \
  'Investiga, corrige el fallo y ejecuta los tests'
```

Formatos: `text`, `json`, `stream-json` y JSON-RPC NDJSON con
`--input-format stream-jsonrpc --output-format stream-jsonrpc`.
Los frames RPC están limitados a 10 MiB. El sobre JSON-RPC 2.0 incluye
`factoryApiVersion: 1.0.0` y `factoryProtocolVersion: 1.269.0`; no se declara
compatibilidad con otras versiones del protocolo.

El bucle transmite texto, reúne las llamadas completas antes de ejecutarlas,
correlaciona resultados, conserva errores para el turno siguiente y limita
recuperación, reintentos y contexto. La compactación cubre todos los fragmentos
descartados, recomprime resúmenes anteriores y conserva las instrucciones de
usuario. Falla explícitamente si no puede reducir el contexto.

## Modelos y configuración

Variables: `FABRICA_LLM_MODEL`, `FABRICA_LLM_BASE_URL`, `FABRICA_LLM_API_KEY`.
`--settings archivo.json` admite este subconjunto explícito:

```json
{
  "modelId": "custom:local",
  "customModels": [{
    "id": "custom:local",
    "model": "qwen3.5-32k:latest",
    "provider": "generic-chat-completion-api",
    "baseUrl": "http://127.0.0.1:11434/v1",
    "maxOutputTokens": 4096
  }]
}
```

También admite `provider: "openai"`. Una clave puede usar `${NOMBRE_VARIABLE}`;
se resuelve únicamente esa variable. No se leen settings globales del usuario. Los campos
de política desconocidos se rechazan. Anthropic/Google nativos no están implementados.

Para workers de la fábrica: `FABRICA_AGENT_SETTINGS`,
`FABRICA_AGENT_AUTONOMY` (medium por defecto), `FABRICA_AGENT_TIMEOUT_MS` y
`FABRICA_AGENT_MAX_TURNS`. Los workers de investigación usan spec.
El adaptador exige un STATUS válido y permite repararlo dentro del presupuesto
de recuperación. El parser de la fábrica consume esa misma primera línea; los
informes largos conservan el estado cuando se limita el cuerpo a 20.000 caracteres.

## Tools, permisos y sesiones

`--list-tools -o json` devuelve el catálogo instalado con IDs wire y nombres LLM.
Incluye Read, LS, Create, Edit, Glob, Grep, Execute, Script, TodoWrite, AskUser,
Skill, ToolSearch y herramientas de subagentes. `--only-tools`/`--remove-tools`
se aplican también a llamadas anidadas. `conditional` indica que la admisión
depende de los argumentos. No se usa `riskLevel` del modelo como autorización.

Autonomías: off/low/medium/high. Spec bloquea mutaciones y ejecuta los comandos
admitidos con el workspace en lectura. Git de lectura también exige sandbox RO.
Medium admite comandos de desarrollo simples, secuencias `&&` y el prefijo `cd <workspace> &&`;
composición arbitraria requiere high. El sandbox de ejecución bloquea red.

Read exige ruta absoluta. Read/Edit abren descriptores sin seguir symlinks;
los reemplazos son atómicos y no modifican aliases hardlink externos. Create
reemplaza contenido y añade salto de línea final.
Se serializan escrituras directas y anidadas de Script; lecturas pueden solaparse.

La API `runCodingAgent` permite tools propias, hooks antes/después, permisos y
respuestas de usuario. En RPC, las solicitudes `droid.request_permission` y
`droid.ask_user` son bidireccionales. Se admite `proceed_once`/`cancel`;
la aprobación no evita las restricciones de spec o del sandbox. AskUser usa
el cuestionario `[question]`, `[topic]`, `[option]`.

`--session-id` reanuda, `--fork` crea otra sesión y `--session-dir` elige su
almacenamiento. Los snapshots se escriben atómicamente bajo lock exclusivo.
Se rechaza reanudar herramientas pendientes para no repetir efectos inciertos.
Callbacks de host personalizados deben observar `context.signal`: no es posible
matar JavaScript arbitrario del padre; se conserva ownership hasta su finalización.

## Subagentes

Task/SpawnAgent crean clones aislados fuera del workspace del padre. Copian bytes
actuales, incluidos cambios sin commit, archivos nuevos y eliminaciones. No copian
archivos ignorados ni configuración/hooks Git. El snapshot admite 10.000 archivos,
1 MiB por archivo y 32 MiB totales; submódulos/symlinks no están soportados.

Presupuestos compartidos: profundidad 2, 8 agentes, concurrencia 2 y 256 llamadas
al proveedor por defecto. Un hijo no aumenta estos límites. TaskOutput, TaskStop,
ListAgents, InterruptAgent y SendMessage operan sobre hijos propios; mensajes se
entregan al comenzar el siguiente turno. Los diffs se recolectan dentro del sandbox.
Los clones quedan disponibles para revisión e integración explícita.
Los hijos background se cancelan y drenan al terminar la invocación; no son tareas
duraderas entre sesiones. El resultado terminal se emite después de ese drenaje.

## MCP

`mcpServers` configura stdio (`command`, `args`, `env`) o Streamable HTTP (`url`,
`headers`). El cliente negocia versión, pagina `tools/list`, procesa JSON/SSE y
conserva contenido estructurado. Los nombres son `servidor___tool`.
Solo `readOnlyTools`, declarado por el caller, otorga clasificación de lectura;
las annotations del servidor no la otorgan.

Los procesos stdio usan sandbox required, entorno explícito y montajes limitados
a runtimes del sistema, workspace, ejecutable/argumentos absolutos existentes y
`readPaths` explícitos para dependencias adicionales. No se monta todo el home.
Metadata se descubre siempre en RO. Una operación stdio con escritura inicia un
proceso propio después de su admisión y lo recolecta al retornar; su estado en
memoria no persiste entre operaciones de escritura. HTTP y tools stdio de lectura
conservan sesión durante la invocación. `allowNetwork: true` es opt-in para stdio.

Límites: 8 servidores, 256 tools, 16 páginas y 512 KiB agregados por catálogo;
discovery total 30 s, solicitudes de metadata 15 s y calls 180 s configurables con
`timeoutMs`. Cancelación HTTP usa un envío independiente acotado. Al cerrar se
recolectan procesos y se solicita DELETE de sesiones HTTP.
No se implementan todavía OAuth, SSE legado, reanudación GET ni actualización
automática de catálogos. Base pública:
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[transportes](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) y
[tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Misiones

`--mission --auto high` habilita ProposeMission, StartMissionRun y
DismissHandoffItems. El rol worker recibe EndFeatureRun. `--worker-model` y
`--validator-model` seleccionan proveedores ya configurados en settings.
La metadata queda fuera del workspace y de sus directorios Git escribibles.
Los archivos de planificación/skills pueden editarse; estado y handoffs son del runner.

Cada feature de `features.json` declara, además de su descripción:

- `verificationCommands`: comandos que el **runner** ejecuta antes de completar la
  milestone. Corren en sandbox obligatorio, sin red, con entorno restringido y sobre
  una copia desechable del código congelado (las dependencias ignoradas, como
  `node_modules`, se montan en solo lectura). Admiten comillas, sin shell: operadores,
  expansiones y globs sin comillas se rechazan.
- `protectedPaths`: archivos que los workers no pueden cambiar (por ejemplo, los tests
  que juzgan su trabajo). Se registran antes del primer worker.

Reglas de completitud:

1. Workers en serie; un worker sin handoff, con resultado parcial, issues o
   `returnToOrchestrator` devuelve el turno al orquestador.
2. Un handoff que afirma comandos que el runtime no observó (incluidos los
   ejecutados dentro de Script) se rechaza. `validatorsPassed` no decide nada.
3. Si cambió un `protectedPath`, el run se pausa antes de validar.
4. Dos validadores por milestone, en solo lectura. Cada uno debe haber ejecutado
   al menos un comando con éxito; si devuelve el turno o reporta issues, no se completa.
5. Sin `verificationCommands`, o con alguno fallando, la milestone queda en pausa.
6. Verificadores y rutas protegidas se sellan en la primera planificación: replanificar
   solo puede añadirlos, nunca quitarlos.
7. Antes del primer efecto se reservan las llamadas al modelo que necesitan workers y
   validadores; si no alcanzan, el run no empieza.
8. Cada descarte (DismissHandoffItems) cubre el item de un intento concreto; el mismo
   texto en un intento posterior es un item nuevo.

`result.ok` representa el turno; consultar por separado `result.mission.state`.
Contraejemplo y caso positivo reproducibles, sin modelo real:

```bash
bun scripts/native-mission-probe.ts truthful   # completed y test independiente en verde
bun scripts/native-mission-probe.ts forged     # handoffs falsos: la misión no se completa
```

Ambos terminan con exit 0 cuando el runner se comporta según el contrato.
Faltan journal/recuperación tras crash y la aceptación de misión con un modelo real.

## Validación y alcance pendiente

```bash
bun test
bunx tsc --noEmit -p .
```

Las suites incluyen errores/cancelación, protocolo SSE/RPC, confinamiento de
escrituras, clones con estado sin commit, MCP y la fábrica completa con modelo
determinista. `scripts/native-factory-smoke.ts /directorio/nuevo` es una prueba
opt-in con Ollama local: crea únicamente un repositorio fixture, ejecuta
investigación/implementación y verifica tests y rama. Hace commits solo dentro
de esa fixture. `--resume` requiere su marcador y no repite investigación.

Faltan cerrar los gates y la aceptación de missions, ACP, entrada stream-json
multiturno, rewind, ApplyPatch, tareas/Script duraderos, hooks de configuración,
gestión completa MCP y conectores externos. Una prueba real con Qwen local completó
investigación e implementación: tests verificados y commit únicamente en su
repositorio fixture, sin cambiar main. Una corrida aislada no certifica estabilidad;
la aceptación con modelo real (varias corridas seguidas) sigue pendiente.
