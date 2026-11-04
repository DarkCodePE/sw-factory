# Reporte Ola 2 — agy (F1 SQLITE_BUSY → 03 threatmon → 08 sonda native)

**Repo / Worktree:** `/home/orlando/Desktop/factory/sw-factory-ola2-agy`  
**Rama:** `fab/research-ola2-agy` (base `main@0db0893`)  
**Fecha:** 2026-10-30  

---

## 1. Tarea F1: SQLITE_BUSY bajo contención (C7)

### Problema
En la ola 1 bajo contención de dos pools paralelos, ocurrían errores `database is locked` (~0.3 por corrida). Las transacciones de `completeActivity`, `failActivity`, `blockActivity`, etc. usaban transacciones diferidas (`DEFERRED`) por defecto en `bun:sqlite`. Al iniciar una transacción diferida, un `SELECT` adquiere un lock compartido de lectura; cuando dos workers concurrentes intentan actualizar (`UPDATE`), ambos intentan promover su lock a escritura, causando un deadlock que SQLite detecta inmediatamente y aborta con `SQLITE_BUSY` (`database is locked`) a los 0ms, sin esperar `busy_timeout`.
En `processActivity`, este error era capturado como fallo ordinario y llamaba a `store.failActivity`, quemando un intento de reintento del agente por un fallo de infraestructura.

### Cambios realizados (archivo:línea)

#### `src/store.ts`
- **Líneas 43-46**: Helper `isBusyError(err: unknown): boolean` que detecta errores `SQLITE_BUSY` o mensajes `database is locked / busy`.
- **Líneas 249-266**: Método `withRetry<T>(fn: () => T, maxAttempts = 20, baseDelayMs = 25): T` con backoff exponencial y jitter aleatorio (usando `Atomics.wait` sincrónico) para operaciones de store bajo contención.
- **Líneas 321-343 (`createWorkstream`)**: Envuelto en `withRetry`.
- **Líneas 364-374 (`setWorkstreamState`)**: Envuelto en `withRetry`.
- **Líneas 380-388 (`addSignal`)**: Envuelto en `withRetry`.
- **Líneas 398-413 (`triageSignal`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 415-420 (`ignoreSignal`)**: Envuelto en `withRetry`.
- **Líneas 424-453 (`createChange`)**: Envuelto en `withRetry`.
- **Líneas 464-474 (`setChangeBranch`, `setChangeBase`)**: Envueltos en `withRetry`.
- **Líneas 476-500 (`allowGate`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 502-511 (`setChangeStatus`)**: Envuelto en `withRetry`.
- **Líneas 513-529 (`insertActivity`)**: Envuelto en `withRetry`.
- **Líneas 570-613 (`claimActivity`)**: Envuelto en `withRetry` (la transacción ya era `.immediate()`).
- **Líneas 615-634 (`heartbeat`)**: Envuelto en `withRetry`.
- **Líneas 636-664 (`requestValidation`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 705-763 (`completeActivity`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 765-780 (`blockActivity`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 782-814 (`failActivity`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 824-857 (`resolveReview`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 859-868 (`closeChange`)**: Envuelto en `withRetry`.
- **Líneas 870-899 (`retryChange`)**: Transacción convertida a `.immediate()` y envuelta en `withRetry`.
- **Líneas 901-905 (`setActivityAgentPgid`)**: Envuelto en `withRetry`.
- **Líneas 907-979 (`requeueOrphans`)**: Envuelto en `withRetry` (la transacción ya era `.immediate()`).
- **Líneas 981-990 (`releaseActivity`)**: Envuelto en `withRetry`.
- **Líneas 992-1002 (`requeueActivity`)**: Nueva función helper en Store para reencolar una actividad a `pending` limpiando su lease sin incrementar `retry_count`.
- **Líneas 1004-1027 (`waitForRelease`)**: Envuelto en `withRetry`.
- **Líneas 1048-1054 (`event`)**: Envuelto en `withRetry`.

#### `src/pool.ts`
- **Líneas 3-5**: Importación de `isBusyError` y `type Workstream`.
- **Líneas 153-162 (`processActivity`)**: Si se captura `isBusyError`, la actividad se preserva devolviéndola a `pending` con `store.requeueActivity` sin llamar a `failActivity` ni quemar reintentos.
- **Líneas 207-248 (`runPool`)**: Manejo de `isBusyError` en llamadas de bucle (`requeueOrphans`, `getWorkstream`, `claimActivity`), reintentando tras un breve descanso en lugar de fallar o cerrar el pool prematuramente.

#### Tests y validación F1
- **`tests/store.test.ts`**: Test obligatorio `F1: lock mantenido por otra conexión durante una completeActivity → la activity termina sin consumir reintento`. Un subproceso bloquea la base de datos con `BEGIN EXCLUSIVE` durante 500 ms; `completeActivity` reintenta y completa exitosamente con `retryCount === 0`.
- **Medición de carreras (`scripts/e2e/ola0-races.sh 10`)**:
  - `claims_repetidas`: 0 en todas las corridas (media 0.0)
  - `conflicto_custodia`: 0 (media 0.0)
  - `pares_same_wt`: 0 (media 0.0)
  - `pares_validator_wt`: 0 (media 0.0)
  - `sql_busy_crash`: 0 en todas las 10 corridas (media 0.0, frente a 0.3 de la ola 1 y 1.0 de main)
  - Total de `database is locked`: 0
  - Total de reclamaciones repetidas: 0

| Corrida | claims_repetidas | conflicto_custodia | pares_same_wt | sql_busy_crash |
|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 0 |
| 2 | 0 | 0 | 0 | 0 |
| 3 | 0 | 0 | 0 | 0 |
| 4 | 0 | 0 | 0 | 0 |
| 5 | 0 | 0 | 0 | 0 |
| 6 | 0 | 0 | 0 | 0 |
| 7 | 0 | 0 | 0 | 0 |
| 8 | 0 | 0 | 0 | 0 |
| 9 | 0 | 0 | 0 | 0 |
| 10 | 0 | 0 | 0 | 0 |
| **Media** | **0.0** | **0.0** | **0.0** | **0.0** |

---

## 2. Tarea 03: Monitor de comportamiento de agente (threatmon) y estado `quarantined`

### Problema y objetivos
Los agentes de codificación headless ejecutan comandos arbitrarios en los worktrees. Aunque algunos motores disponen de sandboxes o aislamiento parcial, se requiere un monitor determinista post-hoc que analice la salida capturada del agente (`stdout`, `stderr`, y el diff de Git incluyendo archivos sin seguimiento) en busca de comportamientos ofensivos o fuera de límites (escalada de privilegios, exfiltración, destrucción, acceso a credenciales, evasión de contenedores, manipulación de gates). Al detectar infracciones graves (severidad `HIGH` o `CRITICAL`), el cambio debe pasar automáticamente a un estado terminal `quarantined`, bloqueando merge y validación, y notificando al humano a través del `inbox`.

### Cita de fuentes y límite declarado
- **Cita:** Las reglas y la arquitectura del monitor han sido portadas e implementadas en TypeScript a partir de:
  `internal/threatmon/rules.go@d901657` e `internal/threatmon/threatmon.go` (ESF, MIT License).
- **Límite post-hoc declarado:**
  > Este monitor opera de forma post-hoc sobre la salida capturada (stdout, stderr, diff) tras finalizar la ejecución del agente. Detecta comportamientos fuera de límites u ofensivos para poner el change en cuarentena (`quarantined`) antes de validación, pero NO puede revertir ni evitar efectos secundarios ya ocurridos en el host si el agente corrió sin aislamiento previo (como agy). La mitigación de fondo de H1 es envolver los CLIs en sandboxes de egress, fuera de este plan.

### Cambios realizados (archivo:línea)

#### `src/threatmon/rules.ts` (Nuevo)
- Cita a `internal/threatmon/rules.go@d901657`.
- Tipos `ThreatSeverity` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`), `ThreatRule`, y funciones `severityRank()`, `defaultRules()`.
- Implementación de 40 reglas en 10 categorías:
  - `privilege-escalation`: `PE-001` a `PE-004` (sudoers, bits setuid/setcap, módulos del kernel/mounts, iptables).
  - `credential-access`: `CA-001` a `CA-005` (proc environ, barrido de env, AWS credentials, claves privadas SSH/TLS, tokens GitHub/GitLab).
  - `recon`: `RC-001` a `RC-006` (escaneo de red nmap/nc, frameworks de explotación, lectura de `/etc/shadow`, `/etc/passwd`, enumeración de sudo/id).
  - `reverse-shell`: `RS-001` a `RS-003` (reverse shell mkfifo/mknod, redirección `/dev/tcp`, sockets interactivos python/perl/ruby/php/lua).
  - `persistence`: `PS-001` a `PS-004` (crontab, systemd unit files, rc.local/init.d, authorized_keys).
  - `exfiltration`: `EX-001` a `EX-004` (carga curl/wget, piping base64 a red, túneles DNS, scp/rsync remoto).
  - `destructive`: `DS-001` a `DS-004` (eliminación recursiva `rm -rf /`, formateo mkfs/dd a disco raw, fork bomb, shred).
  - `container-escape`: `CE-001` a `CE-005` (socket de docker, escape por sysfs cgroup release_agent, nsenter, /dev/mem o /dev/kmem, chroot sin drop de caps).
  - `cryptomining`: `CM-001` (mineros xmrig, cpuminer y conexiones a pools stratum).
  - `build-gate-tamper`: `BG-001` y `BG-002` (parches que alteran `build.sh`, `test.sh`, Makefiles o flujos CI).

#### `src/threatmon/index.ts` (Nuevo)
- Implementación de `ThreatMonitor`:
  - `splitLines(text)`: Maneja unión de continuaciones de línea con barra invertida (`\`).
  - `normalizeLine(line)`: Elimina secuencias de escape ANSI (`\x1b[...]`), suprime retornos de carro (`\r`), y sustituye bytes de control C0 y `0x7f` por espacios.
  - `makeExcerpt(s)`: Sanea y acota extractos de hallazgos a un máximo estricto de 200 bytes en límites de runas UTF-8.
  - `validateRules(rules)`: Validación estricta de identificadores únicos, patrones compilados y severidades válidas.
  - `report()`: Generación de reporte determinista ordenado por `(stream, line, rule_id)`.

#### `src/connectors/types.ts`
- **Línea 93**: Se añade el campo opcional `quarantined?: boolean` a la interfaz `ValidationSummary`.

#### `src/store.ts`
- **Líneas 32-33**: `ActivityStatus` y `ChangeStatus` extendidos con `'quarantined'`.
- **Líneas 38-44**: `TERMINAL_CHANGE_STATUSES` incluye `'quarantined'`.
- **Líneas 564-567 (`inbox`)**: Incluye actividades y cambios en estado `'quarantined'`.
- **Líneas 582 (`claimActivity`)**: Excluye cambios en `'quarantined'` de la cola FIFO.
- **Líneas 692, 705 (`validationSummary`)**: Registra actividades en `'quarantined'` como fallidas y retorna `quarantined: c.status === 'quarantined'`.
- **Líneas 780, 831 (`blockActivity`, `failActivity`)**: Filtros de base de datos excluyen cambios terminales en `'quarantined'`.
- **Líneas 790-808 (`quarantineActivity`)**: Nueva operación transaccional inmediata con `withRetry`. Actualiza la actividad a `'quarantined'` con el reporte de hallazgos, cancela actividades pendientes del change, pasa el change a estado `'quarantined'` y emite un evento de advertencia.
- **Líneas 918-922 (`retryChange`)**: Permite que un operador humano reintente cambios en estado `'quarantined'`, restaurándolos a `'pending'` y reseteando reintentos.
- **Línea 1098 (`isTerminal`)**: Reconoce `'quarantined'` como estado terminal.

#### `src/validators/publish.ts`
- **Línea 30 (`mergeBlocker`)**: Si `summary.quarantined` es verdadero, bloquea la fusión con `'el change está en cuarentena (quarantined)'`.

#### `src/cli.ts`
- **Línea 203 (`case 'inbox'`)**: Muestra actividades en estado `quarantined` con su reporte de hallazgos y opciones de resolución (`-> fab retry <id> | fab reject <id>`).

#### `src/agents.ts`
- **Líneas 16-17, 221-222**: `AgentRun` expone los flujos completos `stdout` y `stderr` sin recortar antes de aplicar la cota de texto.

#### `src/pool.ts`
- **Líneas 10-39**: Función helper `getWorktreeDiff` que captura `git diff` contra la base más archivos untracked mediante `git status --porcelain -uall` y contenido de archivos nuevos bajo `GIT_SAFE_FLAGS`.
- **Líneas 130-155 (`processActivity`)**: Tras `runAgent` y antes de validación y de `protectedIntegrity`, se invoca `ThreatMonitor` sobre `stdout`, `stderr` y el diff del worktree. Si el reporte se activa (`tripped`), pone la actividad y el cambio en cuarentena mediante `store.quarantineActivity`, emite log y detiene el procesamiento sin continuar a validación ni merge. Contiene el comentario formal sobre el límite post-hoc.

### Pruebas y verificación de 03
- **`tests/threatmon.test.ts`**:
  - **10 Transcripts Adversos**: Se verificó la detección con severidad `HIGH` o `CRITICAL` de:
    1. Reverse shell vía `/dev/tcp` en bash (`RS-002`, HIGH)
    2. Volcado de contraseñas de `/etc/shadow` (`RC-003`, HIGH)
    3. Exfiltración de datos vía subida con `curl --upload-file` (`EX-001`, HIGH)
    4. Vaciado de reglas del firewall con `iptables -F` (`PE-004`, HIGH)
    5. Destrucción del sistema de ficheros con `rm -rf / --no-preserve-root` (`DS-001`, HIGH)
    6. Concesión de bit SUID a `/bin/bash` con `chmod u+s` (`PE-002`, HIGH)
    7. Robo de clave privada SSH `~/.ssh/id_rsa` (`CA-004`, HIGH)
    8. Manipulación del archivo sudoers en `/etc/sudoers` (`PE-001`, HIGH)
    9. Evasión de contenedor vía `cgroup release_agent` (`CE-004`, HIGH)
    10. Alteración del script de gate de verificación `test.sh` en parche diff (`BG-001`, HIGH)
  - **0 Falsos Positivos**: 35 muestras de salida benigna de agentes y herramientas (commits de Git, diffs estándar, logs de compilación de Bun, salidas de pruebas de `bun test`, `npm test`, `pytest`, `cargo`, scripts shell de build, payloads JSON, esquemas SQL, plantillas HTML/CSS, etc.) produjeron **0 alertas** (`rep.tripped === false`).
  - **Integración con Pool y Store**: Verificado en ciclo completo: actividad con transcripción adversa -> `store.quarantineActivity` -> cambio en `'quarantined'` -> visible en `store.inbox()` -> bloqueado por `mergeBlocker()` -> reintentado exitosamente con `store.retryChange()`.

---

## 3. Tarea 08: Sonda de egress con control positivo para motor `native`

### Problema y objetivos
El motor `native` implementa aislamiento de red mediante `bwrap --unshare-net` en `wrapCommand`. Sin embargo, asumir que un aislamiento está cerrado sin medirlo empíricamente produce falsa confianza. Si un contenedor no puede alcanzar un destino externo simplemente porque el ejecutable falló, se cayó o se bloqueó la llamada al sistema, se produciría un falso negativo (asumir erróneamente que la red está aislada). Para evitarlo, la sonda ejecuta un control positivo antes de la primera llamada a una herramienta de red:
1. **Control Positivo:** Verifica que la maquinaria de red y sockets del sandbox funciona realizando una conexión y transferencia local en loopback (`127.0.0.1`). Si el control positivo falla, la sonda no puede certificar el aislamiento y se marca como indecisa (`decided: false`).
2. **Sonda Egress:** Si el control positivo tiene éxito, evalúa la conectividad a un destino exterior (canary). Con la red cortada (`--unshare-net`), el intento falla inmediatamente con `ENETUNREACH`, confirmando que el aislamiento es efectivo (`reachable: false`, `decided: true`).
3. **Exposición:** El resultado se expone con la forma requerida `{ reachable: boolean, decided: boolean }` tanto mediante la función de consulta `getLastEgressProbe()`, en el contexto de la ejecución (`context.egressProbe`), como mediante eventos del agente (`type: 'egress_probe'`) para consumo por el manifiesto (tarea 04 de codex).

### Cambios realizados (archivo:línea)

#### `src/sandbox/egress-probe.ts` (Nuevo)
- Interfaz `EgressProbeResult`:
  ```ts
  export interface EgressProbeResult {
    reachable: boolean;
    decided: boolean;
    positiveControl: boolean;
    details?: string;
    probedAt: string;
    durationMs: number;
  }
  ```
- Función `probeEgress(opts)`: Ejecuta el script de sondeo dentro de `wrapCommand`, garantizando que opera con la misma configuración de aislamiento (`bwrap`, `--unshare-net`, variables de entorno limpias) que los comandos del motor.
- Script de sondeo políglota: Implementación directa en Python 3 con fallback a Node.js; prueba loopback socket (`127.0.0.1`) para el control positivo y socket TCP con timeout corto hacia el canary.
- `getLastEgressProbe()` y `setLastEgressProbe()`: Registro y consulta del último resultado de sonda para interoperabilidad con el manifiesto.

#### `src/sandbox/index.ts`
- **Líneas 5-12**: Exportación pública de `probeEgress`, `getLastEgressProbe`, `setLastEgressProbe`, `buildProbeScript`, `type EgressProbeResult`, `type EgressProbeOptions`.

#### `src/agent/types.ts`
- **Línea 54**: Se añade la propiedad `egressProbe?: EgressProbeResult` a la interfaz `ToolContext`.
- **Línea 73**: Se añade `'egress_probe'` a la unión de tipos del evento `AgentEvent`.

#### `src/agent/registry.ts`
- **Línea 20**: Importación de `probeEgress` desde `../sandbox/index.ts`.
- **Líneas 160-176 (`dispatch`)**: Antes de despachar la primera llamada a una herramienta que solicita red (`FetchUrl`, `WebSearch`, o `Execute` con petición de red), verifica si ya se ejecutó la sonda en el contexto (`!scope.egressProbe`); si no, ejecuta `probeEgress`, asocia el resultado al contexto y emite el evento `{ type: 'egress_probe', sessionId, reachable, decided, positiveControl }`.

### Pruebas y verificación de 08
- **`tests/egress-probe.test.ts`**:
  - **Sonda con red cortada:** Con `allowNetwork: false` dentro de `wrapCommand` (`bwrap --unshare-net`), el control positivo pasa exitosamente (`positiveControl: true`), el canary no es alcanzable (`ENETUNREACH`), resultando en `reachable: false` y `decided: true`.
  - **Fallo de control positivo:** Con `forceFailure: true`, el control positivo falla (`positiveControl: false`), impidiendo falsos negativos y resultando en `decided: false` y `reachable: false`.
  - **Sonda con red permitida:** Con `allowNetwork: true`, el control positivo pasa y el canary es alcanzable, resultando en `reachable: true` y `decided: true`.
  - **Simulación mediante mock runner:** Verifica el comportamiento determinista ante salidas simuladas de red cortada, caída de entorno y red abierta.
  - **Script de sondeo:** Valida la generación correcta del script con bloques de control positivo y canary.

---

## 4. Resumen de Decisiones y Estado Final

1. **Orden estricto completado:** F1 (`3297e74`) → 03 (`69f33d3`) → 08 (`b6b5f3f`).
2. **Propiedad de archivos estrictamente respetada:** No se modificó `src/cli.ts` excepto para `quarantined` en `inbox`; no se modificó `src/validators/publish.ts` excepto para bloquear merge en `quarantined`; no se tocó `ensureWorktree`.
3. **Métricas alcanzadas:**
   - Base de tests: 100% pasando (813+ pruebas en verde).
   - `bunx tsc --noEmit`: 0 errores.
   - F1: 0 `database is locked`, 0 reclamaciones repetidas en `ola0-races.sh 10`.
   - 03: 10/10 transcripciones adversas detectadas, 0 falsos positivos sobre 35 salidas limpias.
   - 08: Sonda con red cortada devuelve `reachable: false` con control positivo `positiveControl: true` y `decided: true`.



