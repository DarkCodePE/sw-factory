# Modo YOLO de FAB

Fecha: 2026-10-20. Estado: implementado para el candidato 0.1.0-rc.9.
Base: RC.8 (`fc6fc84b8a14fd647d4c6a8c412356dcf8566a3b`).
La publicación se acredita por los recibos del pipeline, no por este documento.

## Alcance acordado

El usuario eligió «YOLO completo: sin aprobaciones y sin sandbox».
`--yolo` autoriza al agente a ejecutar comandos directamente en el equipo,
con su red y los permisos del usuario que inicia FAB. FAB no solicita permisos
por herramienta. La activación dura una invocación; no cambia el valor por
defecto de FAB ni las preferencias guardadas.

Este documento define el contrato de implementación de `--yolo`. La política
estándar de red conserva su diseño en `design-execute-network-permissions.md`.

| Comportamiento | Normal, off/low/medium | Normal, high | YOLO |
| --- | --- | --- | --- |
| Aprobaciones de herramientas | Según operación y autonomía | Según política explícita | Se omiten |
| Execute | Sandbox requerido | Sandbox requerido | Proceso del host |
| Red de Execute | Solicitud y aprobación | Automática si solicita red y política auto | Red del host disponible por defecto |
| Archivos mediante comandos | Montajes del sandbox | Montajes del sandbox | Alcance del usuario del sistema |
| Límites de turnos, salida y tiempo | Se conservan | Se conservan | Se conservan |
| Preguntas AskUser | Según interfaz | Según interfaz | Se conservan: no son permisos |

YOLO no otorga privilegios del sistema, credenciales ni acceso a cuentas. No
responde contraseñas ni cambia sudo/AppArmor. El comando puede acceder a los
archivos y servicios accesibles al usuario, incluidos sus archivos de
configuración. El proyecto deja de ser una frontera de seguridad para Execute.

## Activación y precedencia

```sh
fab --yolo
fab tui --yolo --cwd /ruta/proyecto
fab exec --yolo "Ejecuta la sonda de Jira y corrige el problema"
fab exec --yolo --timeout-ms 120000 --max-turns 20 "Ejecuta las pruebas"
```

Un único flag booleano, `--yolo`, en todas las entradas. Sin alias implícitos ni
variable de entorno que lo active. El flag ya expresa la autorización; no se
añade una segunda pregunta al iniciar. En ejecución batch tampoco se necesita
una terminal para usarlo.

El alcance es el agente nativo. `fab tui <slug>` como dashboard de la fábrica,
`fab run` y adaptadores de agentes externos no reciben ni propagan este permiso
por coincidencia de nombre. Su integración necesita un contrato explícito propio.

AGENTS.md, prompts, skills, custom commands, preferencias, sesiones y respuestas
del proveedor no pueden activarlo. Un SDK embebido puede seleccionarlo mediante
una opción explícita del host. No debe deserializar esa opción de datos del
modelo o de archivos del proyecto.

Reglas de resolución, antes de llamar al proveedor o ejecutar procesos:

1. Sin flag ni opción del host, `permissionMode = standard`.
2. Con YOLO, autonomía efectiva high; la preferencia habitual no se modifica.
   `--auto high` es redundante y válido. `--auto off|low|medium` se rechaza.
3. `--yolo --use-spec` se rechaza. La misión puede arrancar en YOLO con la
   autonomía efectiva high; sus validadores se degradan según el contrato inferior.
4. `--yolo --sandbox required|best-effort` se rechaza cuando el flag sandbox es
   explícito. El valor por defecto de la ruta normal no cuenta como conflicto.
5. Una política efectiva de red ask o deny impide iniciar YOLO. Para sobreescribir
   una preferencia o settings, el operador debe añadir `--sandbox-network auto`
   explícitamente. Una prohibición de una integración mediante beforeTool sigue
   denegando la llamada. No hay una promesa de bloqueo de red dentro de YOLO.
6. Valores inválidos se rechazan, incluidos valores de API desconocidos. No se
   interpreta una cadena truthy, `riskLevel`, `networkAccess` o `sandboxed:false`
   de una llamada del modelo como autorización.

El error de conflicto identifica el valor y su origen (flag, settings o
preferencia), e indica el override concreto. Ejemplo: «--yolo entra en conflicto
con la política de red guardada ask; usa --sandbox-network auto para reemplazarla».

No guardar YOLO al salir, hacer fork, compactar o reanudar. Los metadatos pueden
registrar que una ejecución anterior fue YOLO; reanudarla requiere de nuevo el
flag. Una sesión histórica nunca reconstruye una capacidad activa.

## Contrato interno

```ts
type PermissionMode = 'standard' | 'yolo';

// Opción confiable del llamador, no parte del schema de herramientas.
interface AgentOptions { permissionMode?: PermissionMode }

// Estado resuelto y de solo lectura para la invocación.
interface ExecutionPolicy {
  permissionMode: PermissionMode;
  effectiveAutonomy: 'off' | 'low' | 'medium' | 'high';
  execution: 'sandbox' | 'host';
  network: 'per-call' | 'host';
}
```

Crear `execution-policy.ts` para validar entradas y resolver esta política una
vez al inicio. Los tipos son orientativos; no basta con un objeto `readonly`:
el dispatcher y Execute deben recibir la política del runtime, nunca fusionar
campos de autoridad desde input. Los ámbitos de hijo se derivan de la política
del padre y solo pueden conservar o reducir capacidades.

Orden del dispatcher:

```text
validar input y cancelación
  → comprobar herramienta registrada, filtros, modo y beforeTool
  → aplicar restricciones de ciclo de vida de la misión
  → resolver autorización con la política confiable
      standard: matriz existente y permissionHandler
      yolo: no llamar permissionHandler; registrar bypass explícito
  → aplicar límites, scheduler y barrera del journal
  → ejecutar con contexto de la llamada
  → registrar resultado real y afterTool
```

Se omiten las confirmaciones de Edit/Create, Execute, Task y herramientas MCP
que pasen por el dispatcher. Se conservan validación de input, herramientas
deshabilitadas, beforeTool, cierre tras EndFeatureRun, límites y cancelación.
Los filtros impiden invocar herramientas por su nombre; con Execute en el host
no constituyen una barrera contra operaciones equivalentes hechas por shell.
beforeTool puede denegar pero no convertir YOLO en un nuevo prompt de permisos.
AskUser sigue preguntando datos necesarios; en batch conserva su cancelación
documentada. No se inventan respuestas para poder continuar.

## Execute en el host

Separar `executeHost` de la ruta actual. YOLO selecciona esa ruta deliberadamente;
la ausencia de bubblewrap nunca convierte una ejecución normal en YOLO.
La selección ocurre al entrar en Execute, antes de commandSequence,
executeAllowed y commandPolicy; saltar solo el wrapper al final sería insuficiente.

Para Linux/macOS, ejecutar el comando completo mediante `/bin/sh -c`, con cwd
explícito. No dividir `&&` ni reutilizar las clasificaciones de comandos simples
de medium: tuberías, redirecciones, variables y secuencias conservan su semántica
de shell. No aplicar el bloqueo por palabras de commandPolicy en esta ruta:
YOLO admite comandos arbitrarios con los permisos del usuario. No hay escalada
de privilegios realizada por FAB. Validar tipo, longitud y NUL antes de spawn.
En una plataforma sin runner soportado, devolver error explícito antes de ejecutar.

Conservar la captura acotada de stdout/stderr, timeout total, señal de aborto y
registro de exitCode. Usar un entorno explícito: PATH y HOME del usuario, TMPDIR
si existe; no copiar process.env completo ni claves del proveedor. Las skills
pueden cargar sus credenciales por su contrato habitual. Ese filtrado de env
evita herencia accidental, pero no oculta archivos del host a un comando YOLO.
No iniciar un shell login ni cargar archivos rc deliberadamente.

El campo `network` continúa validándose si está presente, pero en YOLO ni su
ausencia ni `false` aíslan la red. El resultado debe explicarlo sin ambigüedad:

```json
{
  "exitCode": 0,
  "sandboxed": false,
  "sandboxReason": "YOLO: ejecución en el host",
  "permissionMode": "yolo",
  "network": { "requested": false, "enabled": true, "access": "host" }
}
```

Read/Edit/Create conservan inicialmente sus rutas ancladas al workspace y el
journal. Execute permite acceder fuera; no anunciar que el proyecto sigue
aislado. Las escrituras externas no tienen rollback garantizado. Una ejecución
de shell continúa creando una barrera de rewind: FAB no afirma deshacer sus
efectos externos.

El runner debe cancelar el proceso y su grupo poseído, también ante exceso de
salida, y limpiar en salida normal los descendientes que todavía controle.
Sin namespace de procesos, un descendiente que use setsid/daemonización puede
escapar del grupo: no prometer terminación absoluta de procesos arbitrarios.
Una garantía superior requeriría un backend de cgroups/job objects validado por
plataforma. No reutilizar el resultado de pruebas de descendientes en bubblewrap
como prueba de esa garantía en el host.

## TUI, estado y protocolo

Mostrar al arrancar y de forma persistente en el estado:

```text
YOLO · sin aprobaciones · ejecución en host · red del equipo
fab [auto/YOLO] ›
```

Debe verse también sin color, al reanudar y en /status y /diagnostics. El catálogo
de herramientas describe la política efectiva; los prompts internos dejan de
decir que Execute está offline o restringido a comandos simples en YOLO.
Sanitizar los textos del terminal como en la ruta actual.

`/yolo` solo consulta el estado y explica cómo reiniciar con o sin el flag. No
activa ni desactiva autoridad en caliente. `/auto off|low|medium` y `/network
ask|deny` se rechazan mientras la invocación sea YOLO; el mensaje indica reiniciar
sin el flag. `/auto high` no persiste una elevación por estar en YOLO.
Los menús, atajos y `/settings` usan el mismo resolver; no pueden introducir una
combinación rechazada por CLI ni guardar la autonomía efectiva sobre la habitual.

Entrar en spec desde la TUI crea un ámbito standard sin permisos YOLO; al volver
a auto/mission se restaura solo la capacidad original del arranque. Mostrar
`spec · YOLO suspendido`, sin ocultar el cambio. `/btw` usa igualmente un ámbito
standard/spec. Cambiar de modelo no cambia autoridad ni restaura permisos
guardados. Esta suspensión interna no habilita YOLO desde una sesión standard.

En RPC, solo el servidor puede seleccionar YOLO al arrancar mediante CLI o
`RpcOptions.agent.permissionMode`. Las peticiones de cliente para activar o
cambiar permissionMode/sandbox/red del host se rechazan con invalid params.
El modo spec del cliente puede reducir autoridad para ese ámbito y auto restaura
únicamente la autorizada al arrancar el servidor. En YOLO no se emiten solicitudes
`droid.request_permission`; AskUser conserva su transporte independiente.

Añadir `execution_policy` al evento init y la extensión propia
`fab_execution_policy` a settings/notificaciones RPC. En stream-json/json, incluir
metadatos de política sin ensuciar stdout con avisos humanos. En text, el aviso
va a stderr. Registrar decisiones de bypass correlacionadas por toolUseId y
sesión, sin secretos ni duplicar comandos completos. No presentar estos campos
propios como comportamiento verificado de Droid.

## Script, subagentes y misiones

Script conserva su VM y proceso propio; YOLO no expone process/Bun/fetch dentro
de esa VM. Sus callbacks `tools.Execute` sí usan la política efectiva del caller.

Los hijos de escritura pueden heredar YOLO únicamente mediante derivación del
runtime del padre; ningún campo de Task/SpawnAgent elige ese modo. El evento de
creación y TaskOutput/ListAgents muestran la política efectiva del hijo. Los
hijos explore, los ámbitos spec y validadores de misión reciben standard,
sandbox requerido y política de red deny. Un padre standard nunca crea YOLO,
incluso después de aprobar Task o una llamada Execute.
Reemplazar explícitamente los campos heredados por spread: el `sandbox: required`
actual de Task/Mission no debe crear un conflicto en un hijo writer YOLO, y la
opción YOLO del padre no debe sobrevivir al construir un hijo spec.

Las operaciones internas de snapshots y colección de Git permanecen aisladas
y offline. No aplicar globalmente «YOLO = omitir todos los wrapCommand».
Los workers de misión de escritura pueden heredar YOLO; los validadores no.
Si un paso interno requiere un backend inexistente, falla explícitamente; el
hecho de que Execute host funcione sin bwrap no prueba soporte de Tasks/misiones
en esa plataforma.

El runner conserva su máquina de estados y comprobaciones de handoff. Un worker
YOLO puede acceder por shell a datos y procesos del host, incluido el plano de
control: esas comprobaciones no son aislamiento frente a un worker malicioso.
La validación de misión no se anuncia como evidencia independiente frente a
manipulación del host. Aislar ese plano requeriría un diseño adicional.

## Plan de implementación

| Paso | Archivos orientativos | Entregable |
| --- | --- | --- |
| 1 | agent/execution-policy.ts, types.ts, engine.ts | Resolver confiable, validación y ámbitos derivados |
| 2 | agent/registry.ts, tools.ts, process.ts | Bypass de permisos explícito y runner host acotado |
| 3 | agent/exec.ts, chat.ts, chat/config.ts | Flag, conflictos y exclusión de persistencia |
| 4 | chat/controller.ts, commands.ts, terminal.ts, presentation.ts, agent/catalog.ts | Estado persistente, help, spec y presentación efectiva |
| 5 | agent/rpc.ts, tasks.ts, mission.ts y prompts internos | Autoridad de host, herencia y degradación visibles |
| 6 | tests y sonda compilada con PTY | Matriz inferior, regresiones y revisión independiente |

Un solo escritor por worktree. No cambiar empaquetado, instalación o versión
para introducir el comportamiento. Revisar los nombres/rangos vigentes antes
de editar. Commit y publicación requieren una petición aparte.

## Rúbrica de aceptación

Todas las pruebas usan directorios temporales, proveedor sintético y HTTP local;
ninguna necesita credenciales Jira, cuentas externas ni comandos destructivos.

| Escenario | Cómo probar | Resultado requerido |
| --- | --- | --- |
| Predeterminado | Ejecutar sin flag en CLI/TUI/RPC | Standard; conserva pruebas de red/sandbox |
| Activación | CLI batch y PTY con --yolo, bwrap ausente | Host, sin aprobación; indicador/metadatos visibles |
| Conflictos | Combinaciones descritas y settings/preferencia deny | Error antes de proveedor/spawn; override explícito probado |
| Shell real | Pipeline, redirección y && sobre fixtures | Semántica completa y exitCode real; sin clasificador medium |
| Alcance host | Escribir en un temporal hermano del workspace | Permitido solo en YOLO; sandboxed=false |
| Red | Petición al HTTP local sin network y con false | Conecta en YOLO; resultado enabled=true |
| No permisos | Handler espía que falla si se invoca; Edit/Execute/Task/MCP | Cero llamadas al handler; hooks y límites activos |
| Preguntas | AskUser en PTY, RPC y batch | Pregunta real o cancelación documentada; nunca respuesta fabricada |
| Denegación de caller | onlyTools/removeTools/beforeTool | Llamada denegada; no spawn ni pregunta alternativa |
| Datos no confiables | Prompt, skill, settings, sesión y input falsifican YOLO | Ninguna elevación desde standard |
| Persistencia | Ejecutar, salir, reanudar/fork sin flag; inspeccionar preferencias | Standard; solo historial declarativo, sin capacidad restaurada |
| TUI | PTY: estado, spec/auto, /btw, /network, /auto y cambio de modelo | Política siempre visible y sin cambios implícitos de autoridad |
| RPC | Intentar elevar por update_session_settings y comprobar streams | Rechazo; JSON válido; ninguna solicitud de permiso en YOLO |
| Script | tools.Execute frente a acceso directo a process/fetch | Callback host autorizado; VM sigue con su contrato actual |
| Delegación | Padre standard/Yolo × writer/explore/validator | Solo writer descendiente de YOLO hereda; resto degrada |
| Misiones | Worker, handoff, validator y posterior al cierre | Política por rol; cierre lógico y límites preservados |
| Entorno | Variable sintética secreta en host; inspeccionar env del comando | No heredada; HOME/PATH definidos; no afirmar ocultación de archivos |
| Cancelación/salida | Abort, timeout, salida enorme e hijo del mismo grupo | Limpieza del grupo poseído y resultado acotado; sin promesas sobre setsid |
| Rewind | Ejecutar modificación vía shell y luego intentar rewind | Barrera informada; no promete revertir efectos externos |
| Plataformas | Runner y binario compilado por plataforma soportada | Evidencia local por plataforma; unsupported falla explícito |

Después de las pruebas enfocadas: `bun test`,
`bunx --no-install tsc --noEmit -p .`, build y smoke de la TUI compilada con PTY
real. Registrar SHA de fuentes, hash del artefacto y resultados separados de las
pruebas anteriores de red. No contar esas pruebas como cobertura de YOLO.

## Evidencia de diseño y límites de revisión

Descubrimiento con Graft local; `graft ask` y `graft skeleton`, seguido de lectura
de las rutas relevantes. El MCP general no tiene indexado este worktree:
list_projects y check_index_coverage devuelven ausencia de proyecto, por lo que
no se atribuye cobertura a ese grafo. `graft check` indica wiring sin drift;
contexto profundo ausente y 924 elementos pendientes. Es descubrimiento
estructural local, no una prueba de cobertura exhaustiva. No se consultó código
propietario.

- `src/agent/types.ts:35` y `:68`: contexto y opciones, hoy sin permissionMode.
- `src/agent/registry.ts:56`: autorización central, permisos y callbacks de Script.
- `src/agent/tools.ts:71`, `:106`, `:121`: clasificador, secuencias y sandbox requerido.
- `src/agent/process.ts:4`: grupo poseído, aborto y captura acotada actuales.
- `src/agent/tasks.ts:146`: construcción del hijo con sandbox requerido.
- `src/agent/mission.ts:136`: diferenciación de workers y validadores.
- `src/agent/rpc.ts:18`: opciones confiables actuales del servidor.
- `src/chat/controller.ts:100`: cambios de modo actuales; `:194`, contexto por turno.
- `src/chat.ts:18` y `src/agent/exec.ts:28`: parsers de CLI actuales.

La revisión de este documento valida decisiones y puntos de integración; no
prueba ejecución YOLO. No se implementó, instaló ni publicó este modo.

Antigravity (`agy-ollama`) revisó el diseño en modo de solo lectura y no señaló
bloqueos arquitectónicos. Sus recomendaciones H-01 y H-02 quedan incorporadas:
elegir executeHost antes del parser y reemplazar explícitamente las opciones
heredadas de hijos writer/spec. También se especifica el diagnóstico de conflictos
con políticas guardadas. No ejecutó una implementación YOLO ni se atribuyen
pruebas de runtime a esta revisión. Comprobación documental local: rutas vigentes,
bloques Markdown, menos de 500 líneas y `git diff --check`, sin errores.

## Evidencia ejecutable de esta implementación

- `tests/agent-yolo.test.ts`: shell real, red HTTP local con campo ausente/false/true, archivo fuera del workspace, entorno depurado, límites, cancelación, descendientes, filtros, AskUser, journal, resume/fork y callback Script.
- `tests/yolo-interfaces.test.ts`: RPC init/update/load rechazan autoridad falsificada; spec→auto; AskUser bidireccional; TUI muestra estado y conserva preferencias, con reducción de spec/btw.
- `tests/yolo-cli.test.ts`: flags públicos, conflictos y transporte JSON/NDJSON.
- `tests/agent-tasks.test.ts` y `tests/agent-mission.test.ts`: herencia real al worker, reducción de explore y validadores; el host no depende de campos propuestos por el modelo.
- `scripts/release/smoke-yolo.mjs`: ejecutable compilado e instalado, shell/red/archivo fuera del workspace, TUI y rechazo temprano de conflictos; `seal.mjs` exige estos checks en los cuatro hosts.

Límites: el grupo de procesos elimina descendientes ordinarios; un proceso que
crea otra sesión/grupo puede escapar. Se cierran pipes retenidos tras la salida
del líder para impedir un bloqueo. Task/missions, Script y los modos reducidos
conservan sus requisitos de aislamiento; YOLO no implementa un sandbox Darwin.
Las restricciones de herramientas y los verificadores no son una frontera de
seguridad frente a un comando host malicioso que modifica archivos del usuario.
