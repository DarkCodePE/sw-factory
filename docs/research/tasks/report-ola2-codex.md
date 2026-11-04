# Ola 2 codex — reporte incremental

Contrato leído: task-ola2-codex.md, reglas §2, Ola 2 y ficha 04 del plan, resultado ola 1.
Propiedad: manifest nuevo, merge CLI/publish, llamadas puntuales en cierres del store/pool. Sin modificar agents.ts, sandbox ni funciones de leases/worktrees ajenas. Sin merge ni push; commits en español.

## En curso
- Inspección del flujo real de terminación, exclusión y truncado antes de editar.
- MCP list_projects: este worktree no figura; graft encuentra store/pool/worktrees. Evidencia por fuente directa al no existir cobertura MCP local.
- No hay cambios previos salvo node_modules sin seguimiento.

## Decisiones
- Sin dependencias nuevas; escritura local atómica bajo state dir.
- Preservar compatibilidad con quarantined aunque lo añada otra rama.

## Pendiente
Implementación, pruebas obligatorias, bun test, tsc, sesiones reales y commits.

## Primer avance de implementación
- `src/manifest.ts`: artefactos atómicos privados, redacción de ocho familias, esquema por change, snapshots de activities, SHA, postura de aislamiento y cleanup.
- `src/manifest-capture.ts` + pool: envoltorio del comando del adaptador conserva ambos streams completos antes de que runAgent los trunque; sin tocar agents.ts ni alterar su grupo de procesos. Necesita una entrada CLI oculta para binarios compilados.
- Store: llamadas puntuales en estado terminal/evento y fin de activity. quarantined reconocido anticipadamente por el escritor.
- `src/validators/publish.ts`: reserva in_progress bajo transacción immediate, intención durable merge_started, SHA y destino fijados, recuperación por ancestro de HEAD, limpieza idempotente.
- Decisión de exclusión: reserva de merge sin vencimiento de lease de agente, recuperable comprobando PID local muerto; así requeueOrphans no puede entregar un merge interrumpido a un LLM. Un PID reutilizado bloquea conservadoramente. Los workers ven el mismo in_progress de 07. Sin tocar claimActivity/heartbeat/requeueOrphans.

## Prueba focalizada inicial
- `bunx tsc --noEmit`: exit 0.
- `bun test tests/pool.test.ts tests/worktrees.test.ts tests/validators-pool.test.ts`: 20 pass, 0 fail.
- `bun test tests/manifest.test.ts`: 10 pass, 0 fail; ocho familias eliminadas de manifest/log, stdout de 26 000 caracteres y stderr completos, cinco estados terminales, razón/reintentos, recuperación tras merge y limpieza, barreras de worker y validadores.
- Los primeros fallos del test nuevo fueron de fixture: requireChangeApproval tiene default true; corregido explícitamente a false. Sin cambios a tests existentes.
- Ajuste: recorder ignora SIGTERM/SIGINT propios mientras espera el cierre de pipes del agente, para guardar lo emitido antes del aborto; el hijo sigue recibiendo la señal del grupo.

## Revisión de concurrencia y cleanup
- La migración de ola 1 rellena **todos** los leases NULL al abrir. Por ello la reserva de merge usa fecha no vencible `9999-12-31T23:59:59.999Z`, no NULL. Reclamación exclusiva y recuperación por PID, sin tocar las tres funciones excluidas del contrato.
- `closeChange` comprueba la reserva y realiza cierre bajo transacción immediate: reject no puede cancelar a la vez que empieza un merge. Al cerrar Store se refrescan los snapshots terminales tocados, de modo que reject conserva cleanup actualizado sin editar su caso CLI.
- Sesión real ampliada: segundo merge y reject rechazados mientras el primer merge está detenido; abrir otro Store y ejecutar requeueOrphans con reloj en 2100 no reencola la reserva.
- `bun test tests/manifest.test.ts`: 11 pass, 0 fail. Añadida cancelación de agente activo que ya escribió ambos streams.

## Límites declarados
- Redacción por patrones conocidos; no promete reconocer secretos arbitrarios sin forma identificable.
- Reserva de merge local al host, como los process groups de 07. Un PID reutilizado se considera vivo y bloquea conservadoramente; no se fuerza la exclusión por mero timeout.
- Una muerte SIGKILL del recorder antes de cerrar sus pipes puede perder la salida aún en memoria (también ocurría con runAgent); cancelación normal SIGTERM conserva la salida ya emitida. Logs completos de sesiones terminadas, stderr incluido, sin truncado y con append entre reintentos.
- In-memory Store sin directorio no escribe artefactos; Store sobre archivo usa el directorio de la BD, que en CLI es FABRICA_HOME.
- 03/08 de agy no existen todavía en esta rama: quarantined previsto en el escritor y posturas por adaptador; la medición/salida de la sonda native se integrará con su trabajo. No se implementa esa sonda aquí.

## Sesión real reproducible (comandos y salida íntegros)

Comando: `python3 scripts/e2e/ola2-manifest.py` (exit 0).

```text
$ git -C /tmp/fab-ola2-real-z5irm79e/toy-calc init -q -b main
$ git -C /tmp/fab-ola2-real-z5irm79e/toy-calc config user.name demo
$ git -C /tmp/fab-ola2-real-z5irm79e/toy-calc config user.email demo@localhost
$ git -C /tmp/fab-ola2-real-z5irm79e/toy-calc add .
$ git -C /tmp/fab-ola2-real-z5irm79e/toy-calc commit -qm base toy-calc
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts ws create demo --repo /tmp/fab-ola2-real-z5irm79e/toy-calc --goal manifest demo --agent fake --no-change-approval --no-spec-approval
workstream demo (a81bef24) creado en draft; actívalo con: fab ws state demo active
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts ws state demo active
demo -> active
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo completado con fake
signal 098b59eb añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage 098b59eb
signal 098b59eb -> change ceb3ab4a (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-134038] investigation "completado con fake" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/ceb3ab4a
[w1-134038] investigation done in 0s
[w1-134038] implementation "completado con fake" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/ceb3ab4a
[w1-134038] implementation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d
merge recuperado: rama ya fusionada
change ceb3ab4a completado
$ cat /tmp/fab-ola2-real-z5irm79e/state/runs/ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d/run.json
{
  "schemaVersion": 1,
  "changeId": "ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d",
  "status": "completed",
  "baseSha": "92765f74b52bc0204f6aee486e540b6b5bdf320a",
  "branch": "fab/ceb3ab4a",
  "head": "92765f74b52bc0204f6aee486e540b6b5bdf320a",
  "createdAt": "2026-10-31T03:37:12.507Z",
  "updatedAt": "2026-10-31T03:37:12.827Z",
  "durationMs": 320,
  "activities": [
    {
      "id": "fa752c64-c4fc-4e1f-9c0e-b4cff2d26358",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134038",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:12.507Z",
      "startedAt": "2026-10-31T03:37:12.593Z",
      "completedAt": "2026-10-31T03:37:12.661Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "fa752c64-c4fc-4e1f-9c0e-b4cff2d26358.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 30,
      "exitCode": 0
    },
    {
      "id": "f2a14fa0-3fd0-4612-843f-04cef1fdc77a",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d",
      "parentActivityId": "fa752c64-c4fc-4e1f-9c0e-b4cff2d26358",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134038",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:12.661Z",
      "startedAt": "2026-10-31T03:37:12.672Z",
      "completedAt": "2026-10-31T03:37:12.715Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "f2a14fa0-3fd0-4612-843f-04cef1fdc77a.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 28,
      "exitCode": 0
    },
    {
      "id": "dd7285b5-d9ef-4728-bb98-82bb8c1c4029",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "ceb3ab4a-bfb3-4a38-abe1-716deaf45d7d",
      "parentActivityId": null,
      "kind": "steward",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:134124",
      "result": null,
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:12.797Z",
      "startedAt": "2026-10-31T03:37:12.797Z",
      "completedAt": "2026-10-31T03:37:12.844Z",
      "leaseExpiresAt": "9999-12-31T23:59:59.999Z",
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "dd7285b5-d9ef-4728-bb98-82bb8c1c4029.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 47
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo cancelado con fake
signal 277100b8 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage 277100b8
signal 277100b8 -> change a368f4cd (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-134265] investigation "cancelado con fake" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/a368f4cd
[w1-134265] investigation done in 0s
[w1-134265] implementation "cancelado con fake" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/a368f4cd
[w1-134265] implementation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts reject a368f4cd-46cf-4425-b455-fd19e9037f6e
change a368f4cd cancelado
$ cat /tmp/fab-ola2-real-z5irm79e/state/runs/a368f4cd-46cf-4425-b455-fd19e9037f6e/run.json
{
  "schemaVersion": 1,
  "changeId": "a368f4cd-46cf-4425-b455-fd19e9037f6e",
  "status": "canceled",
  "baseSha": "92765f74b52bc0204f6aee486e540b6b5bdf320a",
  "branch": "fab/a368f4cd",
  "head": "92765f74b52bc0204f6aee486e540b6b5bdf320a",
  "createdAt": "2026-10-31T03:37:12.995Z",
  "updatedAt": "2026-10-31T03:37:13.306Z",
  "durationMs": 311,
  "activities": [
    {
      "id": "e20e0852-cd4e-40e0-965c-0360ffa820d5",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "a368f4cd-46cf-4425-b455-fd19e9037f6e",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134265",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:12.995Z",
      "startedAt": "2026-10-31T03:37:13.085Z",
      "completedAt": "2026-10-31T03:37:13.150Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "e20e0852-cd4e-40e0-965c-0360ffa820d5.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 30,
      "exitCode": 0
    },
    {
      "id": "47dfec89-0d65-4ca8-82fe-d44e25fff89b",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "a368f4cd-46cf-4425-b455-fd19e9037f6e",
      "parentActivityId": "e20e0852-cd4e-40e0-965c-0360ffa820d5",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134265",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:13.150Z",
      "startedAt": "2026-10-31T03:37:13.161Z",
      "completedAt": "2026-10-31T03:37:13.210Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "47dfec89-0d65-4ca8-82fe-d44e25fff89b.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 31,
      "exitCode": 0
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo merge interrumpido
signal a14e0890 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage a14e0890
signal a14e0890 -> change 24e87c78 (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-134649] investigation "merge interrumpido" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/24e87c78
[w1-134649] investigation done in 0s
[w1-134649] implementation "merge interrumpido" -> fake in /tmp/fab-ola2-real-z5irm79e/state/worktrees/24e87c78
[w1-134649] implementation done in 0s
$ git -C /tmp/fab-ola2-real-z5irm79e/state/worktrees/24e87c78 add .
$ git -C /tmp/fab-ola2-real-z5irm79e/state/worktrees/24e87c78 commit -qm commit recuperable
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 24e87c78-d426-4b42-bb82-75fdfac3b76d (git wrapper stops after actual merge)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts events demo
2026-10-31T03:37:12.284Z info    [orlando] workstream demo created (draft)
2026-10-31T03:37:12.359Z info    [orlando] workstream draft -> active
2026-10-31T03:37:12.507Z info    [orlando] change created: completado con fake
2026-10-31T03:37:12.593Z info    [orlando] investigation claimed by w1-134038
2026-10-31T03:37:12.672Z info    [orlando] implementation claimed by w1-134038
2026-10-31T03:37:12.715Z info    [orlando] implementation done; change implemented
2026-10-31T03:37:12.809Z info    [orlando] merge_started {"head":"92765f74b52bc0204f6aee486e540b6b5bdf320a","branch":"fab/ceb3ab4a","target":"refs/heads/main"}
2026-10-31T03:37:12.830Z info    [orlando] change completed
2026-10-31T03:37:12.836Z info    [orlando] merge_completed
2026-10-31T03:37:12.995Z info    [orlando] change created: cancelado con fake
2026-10-31T03:37:13.085Z info    [orlando] investigation claimed by w1-134265
2026-10-31T03:37:13.161Z info    [orlando] implementation claimed by w1-134265
2026-10-31T03:37:13.210Z info    [orlando] implementation done; change implemented
2026-10-31T03:37:13.296Z warning [orlando] reject solicitado
2026-10-31T03:37:13.311Z info    [orlando] change canceled
2026-10-31T03:37:13.487Z info    [orlando] change created: merge interrumpido
2026-10-31T03:37:13.581Z info    [orlando] investigation claimed by w1-134649
2026-10-31T03:37:13.659Z info    [orlando] implementation claimed by w1-134649
2026-10-31T03:37:13.713Z info    [orlando] implementation done; change implemented
2026-10-31T03:37:13.872Z info    [orlando] merge_started {"head":"fbd834d0209023257ab54a4cf846cfa05c34a47c","branch":"fab/24e87c78","target":"refs/heads/main"}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 24e87c78-d426-4b42-bb82-75fdfac3b76d
error (conflict): change tiene una operación en curso
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts reject 24e87c78-d426-4b42-bb82-75fdfac3b76d
error (conflict): change tiene un merge en curso; reanuda fab merge primero
$ bun -e import {Store} from "/home/orlando/Desktop/factory/sw-factory-ola2-codex/src/store.ts"; const s = new Store(process.argv[1], {clock:()=>new Date("2100-01-01T00:00:00Z")}); if (s.requeueOrphans("demo") !== 0 || !s.listActivities({status:"in_progress"}).some(a=>a.workerId?.startsWith("merge:"))) throw Error("merge requeued"); s.close(); console.log("PASS: lease de merge resiste migración y requeueOrphans en 2100"); /tmp/fab-ola2-real-z5irm79e/state/fabrica.db
PASS: lease de merge resiste migración y requeueOrphans en 2100
$ kill -9 134901
fab interrumpido: -9
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 24e87c78-d426-4b42-bb82-75fdfac3b76d
merge recuperado: rama ya fusionada
change 24e87c78 completado
$ cat /tmp/fab-ola2-real-z5irm79e/state/runs/24e87c78-d426-4b42-bb82-75fdfac3b76d/run.json
{
  "schemaVersion": 1,
  "changeId": "24e87c78-d426-4b42-bb82-75fdfac3b76d",
  "status": "completed",
  "baseSha": "92765f74b52bc0204f6aee486e540b6b5bdf320a",
  "branch": "fab/24e87c78",
  "head": "fbd834d0209023257ab54a4cf846cfa05c34a47c",
  "createdAt": "2026-10-31T03:37:13.487Z",
  "updatedAt": "2026-10-31T03:37:14.288Z",
  "durationMs": 801,
  "activities": [
    {
      "id": "5d8c38ee-db40-4677-bc4f-91e204fb2d2f",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "24e87c78-d426-4b42-bb82-75fdfac3b76d",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134649",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:13.487Z",
      "startedAt": "2026-10-31T03:37:13.581Z",
      "completedAt": "2026-10-31T03:37:13.648Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "5d8c38ee-db40-4677-bc4f-91e204fb2d2f.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 31,
      "exitCode": 0
    },
    {
      "id": "9d163839-4d88-4852-abbc-c33cc7849c9a",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "24e87c78-d426-4b42-bb82-75fdfac3b76d",
      "parentActivityId": "5d8c38ee-db40-4677-bc4f-91e204fb2d2f",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-134649",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:13.648Z",
      "startedAt": "2026-10-31T03:37:13.659Z",
      "completedAt": "2026-10-31T03:37:13.713Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "9d163839-4d88-4852-abbc-c33cc7849c9a.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 39,
      "exitCode": 0
    },
    {
      "id": "d2cf8827-f721-4740-ad92-89fa4296f43b",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "24e87c78-d426-4b42-bb82-75fdfac3b76d",
      "parentActivityId": null,
      "kind": "steward",
      "status": "canceled",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:134901",
      "result": null,
      "error": "interrupted merge owner exited",
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:13.811Z",
      "startedAt": "2026-10-31T03:37:13.811Z",
      "completedAt": "2026-10-31T03:37:14.263Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": "interrupted merge owner exited",
      "log": "d2cf8827-f721-4740-ad92-89fa4296f43b.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 452
    },
    {
      "id": "45f915bd-f926-4b5d-834a-6aa8cef746b6",
      "workstreamId": "a81bef24-cd21-48b0-bc5a-c6ff4591e395",
      "changeId": "24e87c78-d426-4b42-bb82-75fdfac3b76d",
      "parentActivityId": null,
      "kind": "steward",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:135176",
      "result": null,
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:37:14.263Z",
      "startedAt": "2026-10-31T03:37:14.263Z",
      "completedAt": "2026-10-31T03:37:14.307Z",
      "leaseExpiresAt": "9999-12-31T23:59:59.999Z",
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "45f915bd-f926-4b5d-834a-6aa8cef746b6.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 44
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
PASS: completed, canceled, kill -9 recovery; evidence: /tmp/fab-ola2-real-z5irm79e
```

## Cambios finales (archivo:línea)
| Ubicación | Cambio |
| --- | --- |
| `src/manifest.ts:9` | Redacción de API keys, bearer, PEM, AWS, GitHub, Slack, JWT y URLs con credenciales; asignaciones sensibles adicionales. |
| `src/manifest.ts:23` | tmp exclusivo 0600 + rename; directorios 0700. |
| `src/manifest.ts:60` | run.json con baseSha/branch/head, activities/veredictos/razones/reintentos/duración/aislamiento y cleanup. |
| `src/manifest-capture.ts:4` | Recorder completo de ambos streams, append entre intentos y drenaje ante SIGTERM. |
| `src/pool.ts:78` | Envoltura de comando desde pool, antes del boundedAgentOutput ajeno; metadatos por ejecución y manifest al terminar. |
| `src/store.ts:235` | stateDir derivado del archivo de BD. |
| `src/store.ts:280` | Refresco de cleanup al cerrar Store para los terminales tocados. |
| `src/store.ts:463` | Writer en transición terminal; reconoce quarantined sin implementar 03. |
| `src/store.ts:718` | Writer al completar activity. |
| `src/store.ts:809` | Cierre serializado con reserva de merge, rechaza cancelación concurrente. |
| `src/store.ts:945` y `src/store.ts:999` | Writer en release y eventos terminales (razón/veredicto ya completos). |
| `src/validators/publish.ts:68` | Merge por SHA con intención durable, reserva in_progress, recuperación, limpieza y cierre. |
| `src/cli.ts:254` | Merge llama al flujo recuperable. |
| `src/cli.ts:328` | Dispatch oculto del recorder, necesario para selfCommand en binario compilado. |
| `tests/manifest.test.ts:1` | 11 pruebas nuevas. Ningún test existente modificado. |
| `scripts/e2e/ola2-manifest.py:1` | Sesión real determinista y barrera de Git tras merge; sin failpoints en producto. |

## Commits
- `1cde38a` — feat(evidencia): guarda manifests y recupera merges interrumpidos. Cita ESF MIT en cuerpo. Sin Co-Authored-By.

## Estado de entrega provisional
Producción implementada y commit realizado. TypeScript final exit 0; sesión real exit 0. Falta que termine la suite completa sobre el estado final y registrar/commitear pruebas. Sin merge ni push. node_modules preexistente queda intacto.

## Hallazgo en suite completa y corrección
La primera suite completa terminó con 814 pass, 2 fail (816 tests, 232.58 s):
- Regresión propia: tests/sdlc-integration.test.ts usa /fixture/repo ausente; Bun.spawnSync lanza ENOENT por cwd inexistente. gitEvidence ahora devuelve null para ENOENT y conserva errores distintos. La lectura de evidencia no exige que el repo esté montado, mientras el merge sigue bloqueado si no puede determinar su destino/SHA. Añadida regresión específica, sin modificar el test existente.
- Timeout de 30 s del test de journal de 10 000 registros; había ejecuciones de suites solapadas. Se detuvo la suite repetida pendiente y se repetirá sin solapar ejecuciones propias.

## Corrección verificada
- `bun test tests/manifest.test.ts tests/sdlc-integration.test.ts`: 15 pass, 0 fail, 82 assertions (3.17 s). Doce tests nuevos de manifest; tres de integración existentes.
- `bun test tests/agent-journal.test.ts`: 8 pass, 0 fail, 51 assertions (22.75 s), sin cambios al journal ni a su timeout. El fallo anterior no se reproduce al ejecutar sin solapamiento propio.
- `bunx tsc --noEmit`: exit 0 tras la corrección.
- Suite completa final iniciada de nuevo con `bun test`, sin otras suites propias simultáneas.

## Última sesión real tras corrección de ENOENT

`python3 scripts/e2e/ola2-manifest.py`: exit 0. Salida íntegra:

```text
$ git -C /tmp/fab-ola2-real-qgjz21yk/toy-calc init -q -b main
$ git -C /tmp/fab-ola2-real-qgjz21yk/toy-calc config user.name demo
$ git -C /tmp/fab-ola2-real-qgjz21yk/toy-calc config user.email demo@localhost
$ git -C /tmp/fab-ola2-real-qgjz21yk/toy-calc add .
$ git -C /tmp/fab-ola2-real-qgjz21yk/toy-calc commit -qm base toy-calc
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts ws create demo --repo /tmp/fab-ola2-real-qgjz21yk/toy-calc --goal manifest demo --agent fake --no-change-approval --no-spec-approval
workstream demo (10cc5c25) creado en draft; actívalo con: fab ws state demo active
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts ws state demo active
demo -> active
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo completado con fake
signal b3d4ec08 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage b3d4ec08
signal b3d4ec08 -> change efd49a57 (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-166779] investigation "completado con fake" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/efd49a57
[w1-166779] investigation done in 0s
[w1-166779] implementation "completado con fake" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/efd49a57
[w1-166779] implementation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge efd49a57-9e22-4f30-a9d5-707f4f01aa86
merge recuperado: rama ya fusionada
change efd49a57 completado
$ cat /tmp/fab-ola2-real-qgjz21yk/state/runs/efd49a57-9e22-4f30-a9d5-707f4f01aa86/run.json
{
  "schemaVersion": 1,
  "changeId": "efd49a57-9e22-4f30-a9d5-707f4f01aa86",
  "status": "completed",
  "baseSha": "16b91bfbc7ad16b08500431d31e41985ce3b43b6",
  "branch": "fab/efd49a57",
  "head": "16b91bfbc7ad16b08500431d31e41985ce3b43b6",
  "createdAt": "2026-10-31T03:39:53.872Z",
  "updatedAt": "2026-10-31T03:39:54.205Z",
  "durationMs": 333,
  "activities": [
    {
      "id": "ce6fdbdc-66a0-4c55-9646-67b7bf817719",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "efd49a57-9e22-4f30-a9d5-707f4f01aa86",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-166779",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:53.872Z",
      "startedAt": "2026-10-31T03:39:53.961Z",
      "completedAt": "2026-10-31T03:39:54.028Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "ce6fdbdc-66a0-4c55-9646-67b7bf817719.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 33,
      "exitCode": 0
    },
    {
      "id": "a060ff72-a24a-4192-94b3-76e1a6c5cbf6",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "efd49a57-9e22-4f30-a9d5-707f4f01aa86",
      "parentActivityId": "ce6fdbdc-66a0-4c55-9646-67b7bf817719",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-166779",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.028Z",
      "startedAt": "2026-10-31T03:39:54.040Z",
      "completedAt": "2026-10-31T03:39:54.089Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "a060ff72-a24a-4192-94b3-76e1a6c5cbf6.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 33,
      "exitCode": 0
    },
    {
      "id": "6641f641-d44c-4f1d-ac88-d00093d39b65",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "efd49a57-9e22-4f30-a9d5-707f4f01aa86",
      "parentActivityId": null,
      "kind": "steward",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:166857",
      "result": null,
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.169Z",
      "startedAt": "2026-10-31T03:39:54.169Z",
      "completedAt": "2026-10-31T03:39:54.223Z",
      "leaseExpiresAt": "9999-12-31T23:59:59.999Z",
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "6641f641-d44c-4f1d-ac88-d00093d39b65.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 54
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo cancelado con fake
signal b6b213b9 añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage b6b213b9
signal b6b213b9 -> change 21b3579f (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-166984] investigation "cancelado con fake" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/21b3579f
[w1-166984] investigation done in 0s
[w1-166984] implementation "cancelado con fake" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/21b3579f
[w1-166984] implementation done in 0s
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts reject 21b3579f-800b-42c5-a003-e69b2c93246f
change 21b3579f cancelado
$ cat /tmp/fab-ola2-real-qgjz21yk/state/runs/21b3579f-800b-42c5-a003-e69b2c93246f/run.json
{
  "schemaVersion": 1,
  "changeId": "21b3579f-800b-42c5-a003-e69b2c93246f",
  "status": "canceled",
  "baseSha": "16b91bfbc7ad16b08500431d31e41985ce3b43b6",
  "branch": "fab/21b3579f",
  "head": "16b91bfbc7ad16b08500431d31e41985ce3b43b6",
  "createdAt": "2026-10-31T03:39:54.377Z",
  "updatedAt": "2026-10-31T03:39:54.674Z",
  "durationMs": 297,
  "activities": [
    {
      "id": "636cc886-facb-48f2-9359-f9c0d5fe7852",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "21b3579f-800b-42c5-a003-e69b2c93246f",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-166984",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.377Z",
      "startedAt": "2026-10-31T03:39:54.464Z",
      "completedAt": "2026-10-31T03:39:54.528Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "636cc886-facb-48f2-9359-f9c0d5fe7852.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 26,
      "exitCode": 0
    },
    {
      "id": "6d4d4bc6-f6fe-4ad4-892c-8f720f1ff35d",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "21b3579f-800b-42c5-a003-e69b2c93246f",
      "parentActivityId": "636cc886-facb-48f2-9359-f9c0d5fe7852",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-166984",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.528Z",
      "startedAt": "2026-10-31T03:39:54.540Z",
      "completedAt": "2026-10-31T03:39:54.584Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "6d4d4bc6-f6fe-4ad4-892c-8f720f1ff35d.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 27,
      "exitCode": 0
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts signal add demo merge interrumpido
signal 3996525c añadida
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts triage 3996525c
signal 3996525c -> change 0e7c7b6a (pending)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts run demo --once
[w1-167155] investigation "merge interrumpido" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/0e7c7b6a
[w1-167155] investigation done in 0s
[w1-167155] implementation "merge interrumpido" -> fake in /tmp/fab-ola2-real-qgjz21yk/state/worktrees/0e7c7b6a
[w1-167155] implementation done in 0s
$ git -C /tmp/fab-ola2-real-qgjz21yk/state/worktrees/0e7c7b6a add .
$ git -C /tmp/fab-ola2-real-qgjz21yk/state/worktrees/0e7c7b6a commit -qm commit recuperable
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2 (git wrapper stops after actual merge)
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts events demo
2026-10-31T03:39:53.644Z info    [orlando] workstream demo created (draft)
2026-10-31T03:39:53.729Z info    [orlando] workstream draft -> active
2026-10-31T03:39:53.872Z info    [orlando] change created: completado con fake
2026-10-31T03:39:53.962Z info    [orlando] investigation claimed by w1-166779
2026-10-31T03:39:54.040Z info    [orlando] implementation claimed by w1-166779
2026-10-31T03:39:54.089Z info    [orlando] implementation done; change implemented
2026-10-31T03:39:54.183Z info    [orlando] merge_started {"head":"16b91bfbc7ad16b08500431d31e41985ce3b43b6","branch":"fab/efd49a57","target":"refs/heads/main"}
2026-10-31T03:39:54.209Z info    [orlando] change completed
2026-10-31T03:39:54.215Z info    [orlando] merge_completed
2026-10-31T03:39:54.377Z info    [orlando] change created: cancelado con fake
2026-10-31T03:39:54.464Z info    [orlando] investigation claimed by w1-166984
2026-10-31T03:39:54.540Z info    [orlando] implementation claimed by w1-166984
2026-10-31T03:39:54.584Z info    [orlando] implementation done; change implemented
2026-10-31T03:39:54.666Z warning [orlando] reject solicitado
2026-10-31T03:39:54.679Z info    [orlando] change canceled
2026-10-31T03:39:54.829Z info    [orlando] change created: merge interrumpido
2026-10-31T03:39:54.915Z info    [orlando] investigation claimed by w1-167155
2026-10-31T03:39:54.992Z info    [orlando] implementation claimed by w1-167155
2026-10-31T03:39:55.032Z info    [orlando] implementation done; change implemented
2026-10-31T03:39:55.172Z info    [orlando] merge_started {"head":"ed9a76db4078690d938251e077686cef8d942cfa","branch":"fab/0e7c7b6a","target":"refs/heads/main"}
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2
error (conflict): change tiene una operación en curso
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts reject 0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2
error (conflict): change tiene un merge en curso; reanuda fab merge primero
$ bun -e import {Store} from "/home/orlando/Desktop/factory/sw-factory-ola2-codex/src/store.ts"; const s = new Store(process.argv[1], {clock:()=>new Date("2100-01-01T00:00:00Z")}); if (s.requeueOrphans("demo") !== 0 || !s.listActivities({status:"in_progress"}).some(a=>a.workerId?.startsWith("merge:"))) throw Error("merge requeued"); s.close(); console.log("PASS: lease de merge resiste migración y requeueOrphans en 2100"); /tmp/fab-ola2-real-qgjz21yk/state/fabrica.db
PASS: lease de merge resiste migración y requeueOrphans en 2100
$ kill -9 167561
fab interrumpido: -9
$ bun /home/orlando/Desktop/factory/sw-factory-ola2-codex/src/cli.ts merge 0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2
merge recuperado: rama ya fusionada
change 0e7c7b6a completado
$ cat /tmp/fab-ola2-real-qgjz21yk/state/runs/0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2/run.json
{
  "schemaVersion": 1,
  "changeId": "0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2",
  "status": "completed",
  "baseSha": "16b91bfbc7ad16b08500431d31e41985ce3b43b6",
  "branch": "fab/0e7c7b6a",
  "head": "ed9a76db4078690d938251e077686cef8d942cfa",
  "createdAt": "2026-10-31T03:39:54.828Z",
  "updatedAt": "2026-10-31T03:39:55.520Z",
  "durationMs": 692,
  "activities": [
    {
      "id": "6c1c7f44-f6d5-4aee-9d6b-927e576c0629",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2",
      "parentActivityId": null,
      "kind": "investigation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-167155",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.829Z",
      "startedAt": "2026-10-31T03:39:54.915Z",
      "completedAt": "2026-10-31T03:39:54.980Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "6c1c7f44-f6d5-4aee-9d6b-927e576c0629.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 32,
      "exitCode": 0
    },
    {
      "id": "6bdedd31-e017-467c-8d02-b787ed43bd61",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2",
      "parentActivityId": "6c1c7f44-f6d5-4aee-9d6b-927e576c0629",
      "kind": "implementation",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "w1-167155",
      "result": "STATUS: done\n\nfake agent handled: You are a worker in a software factory. You were assigned ONE activity on ONE ch",
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:54.981Z",
      "startedAt": "2026-10-31T03:39:54.991Z",
      "completedAt": "2026-10-31T03:39:55.032Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "6bdedd31-e017-467c-8d02-b787ed43bd61.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 26,
      "exitCode": 0
    },
    {
      "id": "1fcd6384-e4d9-4674-8666-edcaa3762a3f",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2",
      "parentActivityId": null,
      "kind": "steward",
      "status": "canceled",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:167561",
      "result": null,
      "error": "interrupted merge owner exited",
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:55.117Z",
      "startedAt": "2026-10-31T03:39:55.117Z",
      "completedAt": "2026-10-31T03:39:55.494Z",
      "leaseExpiresAt": null,
      "agentPgid": null,
      "verdict": null,
      "reason": "interrupted merge owner exited",
      "log": "1fcd6384-e4d9-4674-8666-edcaa3762a3f.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 377
    },
    {
      "id": "07c5bf8c-fe0d-4fa3-b213-c67c75e12253",
      "workstreamId": "10cc5c25-4b75-4bbe-a459-246ecc7136e2",
      "changeId": "0e7c7b6a-2da0-4d03-90ba-183ef3fdcef2",
      "parentActivityId": null,
      "kind": "steward",
      "status": "completed",
      "reviewStatus": null,
      "reviewComment": null,
      "validator": null,
      "workerId": "merge:167681",
      "result": null,
      "error": null,
      "retryCount": 0,
      "createdAt": "2026-10-31T03:39:55.495Z",
      "startedAt": "2026-10-31T03:39:55.495Z",
      "completedAt": "2026-10-31T03:39:55.538Z",
      "leaseExpiresAt": "9999-12-31T23:59:59.999Z",
      "agentPgid": null,
      "verdict": null,
      "reason": null,
      "log": "07c5bf8c-fe0d-4fa3-b213-c67c75e12253.log",
      "isolation": {
        "adapter": "fake",
        "posture": "test process; no sandbox"
      },
      "durationMs": 43
    }
  ],
  "cleanup": {
    "worktree": "absent",
    "branch": "absent"
  }
}
PASS: completed, canceled, kill -9 recovery; evidence: /tmp/fab-ola2-real-qgjz21yk
```

Segundo commit: `68d09f0` — test(evidencia): prueba secretos, cancelación y recuperación real. También contiene el manejo acotado de ENOENT. Sin Co-Authored-By.

## Comprobación adicional del dispatch compilado
El intento de build ordinario `bun build --compile ./src/cli.ts --outfile /tmp/fab-ola2-check` falló porque falta el artefacto nativo preexistente `src/agent/native/posix.node`. No se modificó ese módulo ajeno.
Para comprobar específicamente el nuevo dispatch, se externalizaron los addons (sin afirmar que sea un paquete distribuible):

```text
$ bun build --compile --external '*.node' ./src/cli.ts --outfile /tmp/fab-ola2-check
  [19ms]  bundle 134 modules
 [338ms] compile /tmp/fab-ola2-check
$ /tmp/fab-ola2-check __capture /tmp/ola2-compiled-capture.log sh -c 'printf "STATUS: done\ncompiled-stdout\n"; printf "compiled-stderr\n" >&2'
$ cat /tmp/ola2-compiled-capture.log
STATUS: done
compiled-stdout

[stderr]
compiled-stderr
```
Exit 0. Se prueba relanzamiento/dispatch/recorder en binario; no se declara un build de distribución ni se cambian dependencias nativas.

## Entrega final — completa

HEAD: `68d09f006b0d249d8c945e19f314dde69228a5b6`, rama `fab/research-ola2-codex`.
Commits locales: `1cde38a` y `68d09f0`, en español, con referencia MIT y sin Co-Authored-By. Sin merge ni push.

```text
$ bun test

 817 pass
 0 fail
 4451 expect() calls
Ran 817 tests across 84 files. [218.04s]
exit 0
$ bunx tsc --noEmit
(sin salida)
exit 0
$ git diff --check
(sin salida)
exit 0
$ git status --short
?? node_modules
```

`node_modules` es el enlace sin seguimiento que ya existía al empezar. Ningún cambio tracked pendiente.
La suite final incluye 805 tests de base + 12 nuevos; ninguno existente modificado. El test de 10 000 registros pasó en 22 853,69 ms.

Sesión real final: `/tmp/fab-ola2-real-qgjz21yk`; completado, cancelado, ocho familias de secretos probadas en fixtures, log de 26 000 caracteres conservado, streams de cancelación conservados y merge interrumpido con SIGKILL recuperado por el siguiente fab merge. Los comandos y manifests íntegros están arriba.

No queda trabajo obligatorio de esta tarea. Integración con F1/03/08 y agents-verify/F2/F3 corresponde al coordinador y sus respectivos propietarios. Los límites de redacción, PID local, SIGKILL del recorder y build nativo opcional quedan documentados arriba. El reporte vive en la ruta externa indicada por el contrato y no forma parte de los commits de este worktree.
